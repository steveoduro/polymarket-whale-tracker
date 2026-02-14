/**
 * resolver.js — Resolution, outcome backfill, accuracy tracking
 *
 * Each cycle:
 * 1. Resolve trades — get actual temp, determine winner, update trades
 * 2. Backfill opportunities — update actual_temp, winning_range, would_have_won
 * 3. Record forecast accuracy — one row per source to v2_forecast_accuracy
 */

const config = require('../config');
const { db } = require('./db');
const WUScraper = require('./wu-scraper');

const NWS_API_BASE = 'https://api.weather.gov';
const NWS_HEADERS = {
  'User-Agent': '(weather-trading-bot-v2, weather-bot@example.com)',
  'Accept': 'application/geo+json',
};
const METAR_API_BASE = 'https://aviationweather.gov/api/data/metar';
const IEM_CLI_BASE = 'https://mesonet.agron.iastate.edu/json/cli.py';
const IEM_HEADERS = {
  'User-Agent': 'weather-trading-bot-v2 (weather-bot@example.com)',
};

class Resolver {
  constructor(forecastEngine, alerts) {
    this.forecast = forecastEngine;
    this.alerts = alerts;
    this.wuScraper = new WUScraper();
    this.fetchModule = null;

    // Cache actual temps to avoid duplicate API calls within a cycle
    // key: 'city:date' → { highF, highC }
    this.actualCache = new Map();

    // CLI cache: key: stationId → { year, results[] }
    // One fetch per station per year — CLI data only updates once per day
    this.cliCache = new Map();
  }

  async _fetch(url, opts = {}) {
    if (!this.fetchModule) {
      this.fetchModule = (await import('node-fetch')).default;
    }
    if (!opts.signal) {
      opts.signal = AbortSignal.timeout(15000);
    }
    return this.fetchModule(url, opts);
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const label = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[RESOLVER]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Run all resolution tasks. Returns stats.
   */
  async resolve() {
    // Clear actual cache for fresh cycle
    this.actualCache.clear();

    const stats = {
      tradesResolved: 0,
      opportunitiesBackfilled: 0,
      accuracyRecorded: 0,
    };

    try {
      stats.tradesResolved = await this._resolveTrades();
    } catch (err) {
      this._log('error', 'Trade resolution failed', { error: err.message });
    }

    try {
      stats.opportunitiesBackfilled = await this._backfillOpportunities();
    } catch (err) {
      this._log('error', 'Opportunity backfill failed', { error: err.message });
    }

    try {
      stats.accuracyRecorded = await this._recordAccuracy();
    } catch (err) {
      this._log('error', 'Accuracy recording failed', { error: err.message });
    }

    // Task 4: Log calibration metrics after resolution
    try {
      const calibrationStats = await this._computeCalibration();
      if (calibrationStats) {
        this._log('info', 'Model calibration update', calibrationStats);
      }
    } catch (err) {
      this._log('error', 'Calibration stats failed', { error: err.message });
    }

    if (stats.tradesResolved > 0 || stats.opportunitiesBackfilled > 0) {
      this._log('info', 'Resolution complete', stats);
    }

    return stats;
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. RESOLVE TRADES
  // ══════════════════════════════════════════════════════════════════

  async _resolveTrades() {
    // Get all open trades (filter by city-local timezone in JS, not UTC)
    const { data: allTrades, error } = await db
      .from('trades')
      .select('*')
      .eq('status', 'open');

    if (error) {
      this._log('error', 'Failed to fetch resolvable trades', { error: error.message });
      return 0;
    }

    if (!allTrades || allTrades.length === 0) return 0;

    // Filter to trades where target_date is in the past for that city's local timezone
    const trades = allTrades.filter(trade => {
      const cityConfig = config.cities[trade.city.toLowerCase()];
      if (!cityConfig) return false;
      const localToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: cityConfig.tz,
      }).format(new Date());
      return trade.target_date < localToday;
    });

    if (trades.length === 0) return 0;

    this._log('info', `Resolving ${trades.length} past-due trades (${allTrades.length} open total)`);
    let resolved = 0;

    for (const trade of trades) {
      try {
        // Check if another trade for this city/date/platform already resolved with an actual_temp
        // This prevents METAR drift from giving different temps on different runs
        // Platform filter ensures Kalshi actuals don't contaminate Polymarket and vice versa
        let actual;
        const { data: existingResolved } = await db
          .from('trades')
          .select('actual_temp, range_unit')
          .eq('city', trade.city)
          .eq('target_date', trade.target_date)
          .eq('platform', trade.platform)
          .eq('status', 'resolved')
          .not('actual_temp', 'is', null)
          .limit(1);

        if (existingResolved && existingResolved.length > 0) {
          const prevTemp = existingResolved[0].actual_temp;
          const cityConfig = config.cities[trade.city.toLowerCase()];
          const prevUnit = existingResolved[0].range_unit || cityConfig?.unit || 'F';
          actual = {
            highF: prevUnit === 'F' ? prevTemp : Math.round(prevTemp * 9 / 5 + 32),
            highC: prevUnit === 'C' ? prevTemp : Math.round((prevTemp - 32) * 5 / 9 * 10) / 10,
            source: 'reused_from_prior_resolution',
          };
        } else {
          actual = await this._getActualHigh(trade.city, trade.target_date, trade.platform);
        }

        if (!actual) {
          this._log('warn', `No actual temp for ${trade.city} ${trade.target_date} — skipping`);
          continue;
        }

        // Determine if this trade won
        const won = this._didTradeWin(trade, actual);

        // Calculate fees: Kalshi = 0.07 * P * (1-P) per contract at entry, no settlement fee
        // Polymarket weather = zero fees
        let entryFeePerContract = 0;
        if (trade.platform === 'kalshi') {
          const entryPrice = trade.entry_ask || (trade.cost / trade.shares);
          const multiplier = config.platforms.kalshi?.takerFeeMultiplier || 0.07;
          entryFeePerContract = multiplier * entryPrice * (1 - entryPrice);
        }
        const totalEntryFee = Math.round(trade.shares * entryFeePerContract * 100) / 100;

        // Calculate P&L
        let pnl, fees;
        if (won) {
          // Win: receive $1 per share, minus entry fee (already paid)
          const revenue = trade.shares * 1.0;
          fees = totalEntryFee;
          pnl = revenue - trade.cost - fees;
        } else {
          // Loss: shares expire worthless, entry fee already lost
          fees = totalEntryFee;
          pnl = -trade.cost - fees;
        }

        const actualTemp = trade.range_unit === 'C' ? actual.highC : actual.highF;

        const { error: updateError } = await db
          .from('trades')
          .update({
            status: 'resolved',
            actual_temp: actualTemp,
            won,
            pnl: Math.round(pnl * 100) / 100,
            fees: Math.round(fees * 100) / 100,
            resolved_at: new Date().toISOString(),
            resolution_station: actual.station || actual.source || null,
          })
          .eq('id', trade.id);

        if (updateError) {
          this._log('error', `Failed to update trade ${trade.id}`, { error: updateError.message });
          continue;
        }

        resolved++;

        this._log('info', `RESOLVED: ${trade.side} ${trade.city} ${trade.range_name} [${trade.platform}]`, {
          actual: actualTemp,
          station: actual.station || null,
          source: actual.source || null,
          won,
          pnl: (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2),
        });

        // Queue Telegram alert
        this.alerts.tradeResolved({
          ...trade,
          actual_temp: actualTemp,
          won,
          pnl,
          fees,
        });
      } catch (err) {
        this._log('error', `Resolution failed for trade ${trade.id}`, { error: err.message });
      }
    }

    return resolved;
  }

  /**
   * Log WU vs METAR comparison to wu_audit table.
   */
  async _logWUAudit(city, dateStr, stationId, wuResult, metarResult, match) {
    try {
      await db.from('wu_audit').upsert({
        city,
        target_date: dateStr,
        station_id: stationId,
        wu_high_f: wuResult.highF,
        wu_high_c: wuResult.highC,
        metar_high_f: metarResult.highF,
        metar_high_c: metarResult.highC,
        match,
        diff_f: wuResult.highF - metarResult.highF,
      }, { onConflict: 'city,station_id,target_date' });
    } catch (err) {
      this._log('warn', 'Failed to log WU audit', { error: err.message });
    }
  }

  /**
   * Determine if a trade won based on actual temperature.
   */
  _didTradeWin(trade, actual) {
    const actualTemp = trade.range_unit === 'C' ? actual.highC : actual.highF;

    // Check if actual falls in range
    let inRange;
    if (trade.range_min == null && trade.range_max != null) {
      // Unbounded below: "≤X" or "X or below"
      inRange = actualTemp <= trade.range_max;
    } else if (trade.range_min != null && trade.range_max == null) {
      // Unbounded above: "≥X" or "X or higher"
      inRange = actualTemp >= trade.range_min;
    } else if (trade.range_min != null && trade.range_max != null) {
      // Bounded range
      inRange = actualTemp >= trade.range_min && actualTemp <= trade.range_max;
    } else {
      inRange = false;
    }

    // YES wins if in range, NO wins if NOT in range
    return trade.side === 'YES' ? inRange : !inRange;
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. BACKFILL OPPORTUNITIES
  // ══════════════════════════════════════════════════════════════════

  async _backfillOpportunities() {
    // Compute the earliest local "today" across all timezones
    // (most ahead timezone = smallest UTC-equivalent date = safest cutoff)
    const localTodays = new Set();
    for (const cityConfig of Object.values(config.cities)) {
      localTodays.add(new Intl.DateTimeFormat('en-CA', { timeZone: cityConfig.tz }).format(new Date()));
    }
    const earliestLocalToday = [...localTodays].sort()[0]; // most-ahead timezone's "today"

    // Get unresolved opportunities for dates before the earliest local today (batch of 200)
    const { data: opps, error } = await db
      .from('opportunities')
      .select('id, city, target_date, platform, range_name, range_min, range_max, range_type, range_unit, side')
      .is('would_have_won', null)
      .lt('target_date', earliestLocalToday)
      .limit(200);

    if (error) {
      this._log('error', 'Failed to fetch unresolved opportunities', { error: error.message });
      return 0;
    }

    if (!opps || opps.length === 0) return 0;

    this._log('info', `Backfilling ${opps.length} opportunities`);
    let filled = 0;

    // Group by city+date+platform to minimize API calls and ensure correct station per platform
    const groups = new Map();
    for (const opp of opps) {
      const key = `${opp.city}:${opp.target_date}:${opp.platform}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(opp);
    }

    for (const [key, groupOpps] of groups) {
      const [city, dateStr, platform] = key.split(':');

      // Check if a trade for this city/date/platform already resolved with an actual_temp
      let actual;
      const { data: existingResolved } = await db
        .from('trades')
        .select('actual_temp, range_unit')
        .eq('city', city)
        .eq('target_date', dateStr)
        .eq('platform', platform)
        .eq('status', 'resolved')
        .not('actual_temp', 'is', null)
        .limit(1);

      if (existingResolved && existingResolved.length > 0) {
        const prevTemp = existingResolved[0].actual_temp;
        const cityConfig = config.cities[city.toLowerCase()];
        const prevUnit = existingResolved[0].range_unit || cityConfig?.unit || 'F';
        actual = {
          highF: prevUnit === 'F' ? prevTemp : Math.round(prevTemp * 9 / 5 + 32),
          highC: prevUnit === 'C' ? prevTemp : Math.round((prevTemp - 32) * 5 / 9 * 10) / 10,
          source: 'reused_from_prior_resolution',
        };
      } else {
        actual = await this._getActualHigh(city, dateStr, platform);
      }

      if (!actual) continue;

      for (const opp of groupOpps) {
        const actualTemp = opp.range_unit === 'C' ? actual.highC : actual.highF;

        // Determine winning range
        let inRange;
        if (opp.range_min == null && opp.range_max != null) {
          inRange = actualTemp <= opp.range_max;
        } else if (opp.range_min != null && opp.range_max == null) {
          inRange = actualTemp >= opp.range_min;
        } else if (opp.range_min != null && opp.range_max != null) {
          inRange = actualTemp >= opp.range_min && actualTemp <= opp.range_max;
        } else {
          inRange = false;
        }

        const wouldHaveWon = opp.side === 'YES' ? inRange : !inRange;

        const { error: updateErr } = await db
          .from('opportunities')
          .update({
            actual_temp: actualTemp,
            winning_range: inRange ? opp.range_name : null,
            would_have_won: wouldHaveWon,
            resolved_at: new Date().toISOString(),
          })
          .eq('id', opp.id);

        if (!updateErr) filled++;
      }
    }

    this._log('info', `Backfilled ${filled} opportunities`);
    return filled;
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. RECORD FORECAST ACCURACY
  // ══════════════════════════════════════════════════════════════════

  async _recordAccuracy() {
    const today = new Date().toISOString().split('T')[0];

    // Get recently resolved trades that haven't had accuracy recorded yet
    // Use trades resolved in the last 24h to catch new resolutions
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString();

    const { data: trades, error } = await db
      .from('trades')
      .select('city, target_date, range_unit, actual_temp, entry_ensemble, entry_forecast_confidence, hours_to_resolution')
      .eq('status', 'resolved')
      .gte('resolved_at', yesterdayStr)
      .not('actual_temp', 'is', null);

    if (error || !trades || trades.length === 0) return 0;

    // Deduplicate by city+date (many trades can share same city/date)
    const seen = new Set();
    let recorded = 0;

    for (const trade of trades) {
      const key = `${trade.city}:${trade.target_date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Check if accuracy already recorded for this city/date
      const { data: existing } = await db
        .from('v2_forecast_accuracy')
        .select('id')
        .eq('city', trade.city)
        .eq('target_date', trade.target_date)
        .limit(1);

      if (existing && existing.length > 0) continue;

      const sources = trade.entry_ensemble || {};
      const actualTemp = trade.actual_temp;
      const unit = trade.range_unit;

      // Record one row per source
      for (const [source, forecastTemp] of Object.entries(sources)) {
        if (forecastTemp == null) continue;

        const error = forecastTemp - actualTemp;
        const absError = Math.abs(error);

        const { error: insertErr } = await db
          .from('v2_forecast_accuracy')
          .insert({
            city: trade.city,
            target_date: trade.target_date,
            source,
            confidence: trade.entry_forecast_confidence,
            forecast_temp: forecastTemp,
            actual_temp: actualTemp,
            error: Math.round(error * 100) / 100,
            abs_error: Math.round(absError * 100) / 100,
            unit,
            hours_before_resolution: trade.hours_to_resolution ?? null,
          });

        if (!insertErr) recorded++;
      }
    }

    // Second pass: record accuracy from opportunities (covers non-traded cities)
    // Only look at recently-resolved opportunities (last 48h) to avoid full table scan
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString();

    const { data: opps, error: oppErr } = await db
      .from('opportunities')
      .select('city, target_date, actual_temp, forecast_sources, forecast_confidence, range_unit, ensemble_std_dev, hours_to_resolution')
      .not('actual_temp', 'is', null)
      .not('forecast_sources', 'is', null)
      .gte('resolved_at', twoDaysAgoStr)
      .order('created_at', { ascending: false })
      .limit(500);

    if (!oppErr && opps && opps.length > 0) {
      // Keep only the latest row per city+date
      const oppByCityDate = new Map();
      for (const opp of opps) {
        const key = `${opp.city}:${opp.target_date}`;
        if (seen.has(key)) continue; // already recorded from trades pass
        if (oppByCityDate.has(key)) continue; // already have latest for this combo
        oppByCityDate.set(key, opp);
      }

      for (const [key, opp] of oppByCityDate) {
        // Check if accuracy already recorded for this city/date
        const { data: existing } = await db
          .from('v2_forecast_accuracy')
          .select('id')
          .eq('city', opp.city)
          .eq('target_date', opp.target_date)
          .limit(1);

        if (existing && existing.length > 0) continue;

        const sources = typeof opp.forecast_sources === 'string'
          ? JSON.parse(opp.forecast_sources) : opp.forecast_sources || {};
        const actualTemp = opp.actual_temp;
        const unit = opp.range_unit;

        for (const [source, forecastTemp] of Object.entries(sources)) {
          if (forecastTemp == null) continue;
          const err = forecastTemp - actualTemp;
          const absErr = Math.abs(err);

          const { error: insertErr } = await db
            .from('v2_forecast_accuracy')
            .insert({
              city: opp.city,
              target_date: opp.target_date,
              source,
              confidence: opp.forecast_confidence,
              forecast_temp: forecastTemp,
              actual_temp: actualTemp,
              error: Math.round(err * 100) / 100,
              abs_error: Math.round(absErr * 100) / 100,
              unit,
              hours_before_resolution: opp.hours_to_resolution ?? null,
            });

          if (!insertErr) recorded++;
        }
      }
    }

    if (recorded > 0) {
      this._log('info', `Recorded ${recorded} forecast accuracy entries`);
    }
    return recorded;
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. CALIBRATION METRICS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Compute calibration stats from recent data. Returns null if no data.
   * Queries:
   *   - Per-source bias (from v2_forecast_accuracy, last 7 days)
   *   - Model probability vs actual win rate (from opportunities, last 7 days)
   *   - Residual std dev per unit
   */
  async _computeCalibration() {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoff = sevenDaysAgo.toISOString().split('T')[0];

    // ── Per-source bias from accuracy data ──
    const { data: accuracyRows, error: accErr } = await db
      .from('v2_forecast_accuracy')
      .select('source, unit, error')
      .gte('target_date', cutoff);

    if (accErr || !accuracyRows || accuracyRows.length === 0) return null;

    const bySourceUnit = {};
    for (const row of accuracyRows) {
      const key = `${row.source}:${row.unit}`;
      if (!bySourceUnit[key]) bySourceUnit[key] = [];
      bySourceUnit[key].push(row.error);
    }

    const biasPerSource = {};
    const allResiduals = { F: [], C: [] };

    for (const [key, errors] of Object.entries(bySourceUnit)) {
      const n = errors.length;
      const bias = errors.reduce((a, b) => a + b, 0) / n;
      const mae = errors.reduce((a, b) => a + Math.abs(b), 0) / n;
      biasPerSource[key] = {
        bias: Math.round(bias * 100) / 100,
        mae: Math.round(mae * 100) / 100,
        n,
      };

      // Collect residuals for pooled std dev
      const unit = key.split(':')[1];
      if (allResiduals[unit]) {
        for (const e of errors) {
          allResiduals[unit].push(e - bias);
        }
      }
    }

    // ── Residual std dev per unit ──
    const residualStdDev = {};
    for (const [unit, residuals] of Object.entries(allResiduals)) {
      if (residuals.length < 2) continue;
      const n = residuals.length;
      const std = Math.sqrt(residuals.reduce((a, b) => a + b * b, 0) / (n - 1));
      residualStdDev[unit] = { stdDev: Math.round(std * 100) / 100, n };
    }

    // ── Model probability vs actual win rate (from resolved opportunities) ──
    const { data: oppRows, error: oppErr } = await db
      .from('opportunities')
      .select('our_probability, would_have_won, side')
      .not('would_have_won', 'is', null)
      .gte('target_date', cutoff)
      .eq('side', 'YES')
      .limit(2000);

    let calibrationBuckets = null;
    if (!oppErr && oppRows && oppRows.length > 0) {
      // Bucket by model probability
      const buckets = [
        { label: '0-10%', min: 0, max: 0.10, wins: 0, total: 0 },
        { label: '10-25%', min: 0.10, max: 0.25, wins: 0, total: 0 },
        { label: '25-50%', min: 0.25, max: 0.50, wins: 0, total: 0 },
        { label: '50-75%', min: 0.50, max: 0.75, wins: 0, total: 0 },
        { label: '75-100%', min: 0.75, max: 1.01, wins: 0, total: 0 },
      ];

      for (const opp of oppRows) {
        const p = opp.our_probability;
        for (const bucket of buckets) {
          if (p >= bucket.min && p < bucket.max) {
            bucket.total++;
            if (opp.would_have_won) bucket.wins++;
            break;
          }
        }
      }

      calibrationBuckets = buckets
        .filter(b => b.total > 0)
        .map(b => ({
          range: b.label,
          winRate: Math.round((b.wins / b.total) * 1000) / 10 + '%',
          n: b.total,
        }));
    }

    return {
      period: `last 7 days (since ${cutoff})`,
      biasPerSource,
      residualStdDev,
      calibrationBuckets,
      totalAccuracyRows: accuracyRows.length,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTUAL TEMPERATURE FETCHERS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Get actual high temperature for a city/date/platform.
   * Routes to the correct weather station based on platform:
   *   - Kalshi → nwsStation (NWS observations API)
   *   - Polymarket → polymarketStation (METAR), fallback to nwsStation if same
   * Caches results per city+date+platform within a cycle.
   */
  async _getActualHigh(city, dateStr, platform) {
    const cacheKey = `${city}:${dateStr}:${platform || 'unknown'}`;
    if (this.actualCache.has(cacheKey)) {
      return this.actualCache.get(cacheKey);
    }

    const cityConfig = config.cities[city.toLowerCase()];
    if (!cityConfig) return null;

    let result = null;
    let stationUsed = null;

    if (platform === 'kalshi') {
      // Kalshi: CLI (authoritative) → NWS hourly obs → METAR fallback
      let cliResult = null;
      let nwsResult = null;

      if (cityConfig.nwsStation) {
        // 1. Try CLI (what Kalshi actually resolves against)
        cliResult = await this._getCLIHigh(cityConfig.nwsStation, dateStr);
        if (cliResult) {
          result = cliResult;
          stationUsed = cityConfig.nwsStation;
        }

        // 2. Fallback to NWS hourly obs (close proxy, available sooner)
        if (!result) {
          nwsResult = await this._getNWSObservationHigh(cityConfig.nwsStation, dateStr, cityConfig.tz);
          if (nwsResult) {
            result = nwsResult;
            stationUsed = cityConfig.nwsStation;
          }
        } else {
          // Still fetch NWS obs for cross-validation (non-blocking)
          nwsResult = await this._getNWSObservationHigh(cityConfig.nwsStation, dateStr, cityConfig.tz);
        }

        // Cross-validation: log CLI vs NWS obs comparison
        if (cliResult || nwsResult) {
          await this._logCLIAudit(city, cityConfig.nwsStation, dateStr, cliResult, nwsResult);
          if (cliResult && nwsResult && cliResult.highF !== nwsResult.highF) {
            this._log('warn', `CLI vs NWS obs mismatch: ${city} ${dateStr}`, {
              cli: cliResult.highF + '°F',
              nws: nwsResult.highF + '°F',
              diff: cliResult.highF - nwsResult.highF,
            });
          }
        }
      }

      // 3. Final fallback to METAR
      if (!result && cityConfig.polymarketStation) {
        result = await this._getMETARHigh(cityConfig.polymarketStation, dateStr, cityConfig.tz);
        if (result) stationUsed = cityConfig.polymarketStation;
      }
    } else {
      // Polymarket: try WU API first (authoritative source), then METAR fallback
      const wuResult = await this.wuScraper.getHighTempForCity(city, dateStr);
      let metarResult = null;

      if (cityConfig.polymarketStation) {
        metarResult = await this._getMETARHigh(cityConfig.polymarketStation, dateStr, cityConfig.tz);
      }

      // Log WU vs METAR comparison to wu_audit (when both available)
      if (wuResult && metarResult) {
        const match = wuResult.highF === metarResult.highF;
        await this._logWUAudit(city, dateStr, cityConfig.polymarketStation, wuResult, metarResult, match);
        if (!match) {
          this._log('warn', `WU vs METAR mismatch: ${city} ${dateStr}`, {
            wu: wuResult.highF + '°F',
            metar: metarResult.highF + '°F',
            diff: wuResult.highF - metarResult.highF,
          });
        }
      }

      // Use WU as primary, METAR as fallback
      if (wuResult) {
        result = wuResult;
        stationUsed = cityConfig.polymarketStation;
      } else if (metarResult) {
        result = { ...metarResult, source: 'metar_fallback' };
        stationUsed = cityConfig.polymarketStation;
      }

      // Final fallback: NWS (only if different station and nothing else worked)
      if (!result && cityConfig.nwsStation) {
        result = await this._getNWSObservationHigh(cityConfig.nwsStation, dateStr, cityConfig.tz);
        if (result) stationUsed = cityConfig.nwsStation;
      }
    }

    if (!result) {
      // Last resort: Open-Meteo historical (not station-specific)
      result = await this._getOpenMeteoHistorical(city, cityConfig, dateStr);
      if (result) stationUsed = 'open_meteo_archive';
    }

    if (result) {
      result.station = stationUsed;
      this.actualCache.set(cacheKey, result);
    }
    return result;
  }

  /**
   * Compute UTC start/end for a local calendar date in a given timezone.
   * Uses full date comparison (not just hour) to correctly handle UTC+13 etc.
   */
  _getUTCWindowForLocalDate(dateStr, timezone) {
    const utcDate = new Date(`${dateStr}T12:00:00Z`);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false, minute: '2-digit', second: '2-digit',
    });
    const parts = formatter.formatToParts(utcDate);
    const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0');
    const localAsUTC = new Date(Date.UTC(get('year'), get('month') - 1, get('day'),
      get('hour'), get('minute'), get('second')));
    const offsetMs = localAsUTC.getTime() - utcDate.getTime();
    const startUTC = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs);
    const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
    return { startUTC, endUTC };
  }

  /**
   * IEM CLI (NWS Climatological Report Daily) — authoritative for Kalshi resolution.
   * CLI products are issued ~6-7 AM local time the following morning.
   * Returns { highF, highC, highTime, source: 'nws_cli' } or null.
   */
  async _getCLIHigh(stationId, dateStr) {
    try {
      const year = dateStr.split('-')[0];
      const cacheKey = stationId;
      const cached = this.cliCache.get(cacheKey);

      let results;
      if (cached && cached.year === year) {
        results = cached.results;
      } else {
        const url = `${IEM_CLI_BASE}?station=${stationId}&year=${year}`;
        const resp = await this._fetch(url, { headers: IEM_HEADERS });
        if (!resp.ok) {
          this._log('warn', `IEM CLI fetch failed: HTTP ${resp.status}`, { stationId });
          return null;
        }
        const data = await resp.json();
        results = data.results || [];
        this.cliCache.set(cacheKey, { year, results });
      }

      const record = results.find(r => r.valid === dateStr);
      if (!record || record.high == null || record.high === 'M') return null;

      const highF = record.high;
      const highC = Math.round((highF - 32) * 5 / 9 * 10) / 10;

      return {
        highF,
        highC,
        highTime: record.high_time || null,
        source: 'nws_cli',
        cliRaw: record,
      };
    } catch (err) {
      this._log('warn', `IEM CLI fetch failed`, { stationId, date: dateStr, error: err.message });
      return null;
    }
  }

  /**
   * Log CLI vs NWS hourly obs comparison to cli_audit table.
   */
  async _logCLIAudit(city, stationId, dateStr, cliResult, nwsResult) {
    try {
      await db.from('cli_audit').upsert({
        city,
        station: stationId,
        target_date: dateStr,
        cli_high_f: cliResult?.highF ?? null,
        nws_obs_high_f: nwsResult?.highF ?? null,
        diff_f: (cliResult?.highF != null && nwsResult?.highF != null)
          ? cliResult.highF - nwsResult.highF : null,
        cli_raw: cliResult?.cliRaw || null,
      }, { onConflict: 'city,target_date' });
    } catch (err) {
      this._log('warn', 'Failed to log CLI audit', { city, error: err.message });
    }
  }

  /**
   * NWS observations API — for US cities.
   */
  async _getNWSObservationHigh(stationId, dateStr, timezone) {
    try {
      const { startUTC, endUTC } = this._getUTCWindowForLocalDate(dateStr, timezone);

      const url = `${NWS_API_BASE}/stations/${stationId}/observations?start=${startUTC.toISOString()}&end=${endUTC.toISOString()}`;
      const resp = await this._fetch(url, { headers: NWS_HEADERS });

      if (!resp.ok) return null;

      const data = await resp.json();
      const features = data.features || [];

      let maxC = -Infinity;
      let validCount = 0;

      for (const feature of features) {
        const props = feature.properties;
        if (!props || !props.temperature) continue;
        if (props.temperature.qualityControl === 'X') continue;
        const tempC = props.temperature.value;
        if (tempC == null) continue;
        validCount++;
        if (tempC > maxC) maxC = tempC;
      }

      if (validCount === 0 || maxC === -Infinity) return null;

      return {
        highF: Math.round(maxC * 9 / 5 + 32),
        highC: Math.round(maxC * 10) / 10,
        source: 'nws_observations',
        observationCount: validCount,
      };
    } catch (err) {
      this._log('warn', `NWS observation fetch failed`, { stationId, date: dateStr, error: err.message });
      return null;
    }
  }

  /**
   * METAR API — for international cities (aviationweather.gov).
   */
  async _getMETARHigh(stationId, dateStr, timezone) {
    try {
      const { startUTC, endUTC } = this._getUTCWindowForLocalDate(dateStr, timezone);

      // Use explicit date parameter to anchor the METAR query window
      // Format: yyyymmdd_hhmm (end of window), hours = how far back
      // This prevents the sliding window bug where hours=24 from "now" misses the target date
      const pad = (n) => String(n).padStart(2, '0');
      const endDateParam = `${endUTC.getUTCFullYear()}${pad(endUTC.getUTCMonth() + 1)}${pad(endUTC.getUTCDate())}_${pad(endUTC.getUTCHours())}${pad(endUTC.getUTCMinutes())}`;
      const url = `${METAR_API_BASE}?ids=${stationId}&format=json&date=${endDateParam}&hours=24`;

      const resp = await this._fetch(url);

      if (!resp.ok) return null;

      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) return null;

      let maxC = -Infinity;
      let validCount = 0;

      for (const obs of data) {
        if (obs.temp == null || obs.obsTime == null) continue;
        const obsDate = new Date(obs.obsTime * 1000);
        if (obsDate < startUTC || obsDate >= endUTC) continue;
        validCount++;
        if (obs.temp > maxC) maxC = obs.temp;
      }

      if (validCount === 0 || maxC === -Infinity) return null;

      return {
        highF: Math.round(maxC * 9 / 5 + 32),
        highC: Math.round(maxC * 10) / 10,
        source: 'metar',
        observationCount: validCount,
      };
    } catch (err) {
      this._log('warn', `METAR fetch failed`, { stationId, date: dateStr, error: err.message });
      return null;
    }
  }

  /**
   * Open-Meteo historical API — last resort fallback.
   */
  async _getOpenMeteoHistorical(city, cityConfig, dateStr) {
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${cityConfig.lat}&longitude=${cityConfig.lon}&start_date=${dateStr}&end_date=${dateStr}&daily=temperature_2m_max&timezone=${encodeURIComponent(cityConfig.tz)}`;
      const resp = await this._fetch(url);

      if (!resp.ok) return null;

      const data = await resp.json();
      const maxC = data.daily?.temperature_2m_max?.[0];
      if (maxC == null) return null;

      return {
        highF: Math.round(maxC * 9 / 5 + 32),
        highC: Math.round(maxC * 10) / 10,
        source: 'open_meteo_archive',
        observationCount: 1,
      };
    } catch (err) {
      this._log('warn', `Open-Meteo archive fetch failed`, { city, date: dateStr, error: err.message });
      return null;
    }
  }
}

module.exports = Resolver;
