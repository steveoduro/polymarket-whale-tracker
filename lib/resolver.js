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

const NWS_API_BASE = 'https://api.weather.gov';
const NWS_HEADERS = {
  'User-Agent': '(weather-trading-bot-v2, weather-bot@example.com)',
  'Accept': 'application/geo+json',
};
const METAR_API_BASE = 'https://aviationweather.gov/api/data/metar';

class Resolver {
  constructor(forecastEngine, alerts) {
    this.forecast = forecastEngine;
    this.alerts = alerts;
    this.fetchModule = null;

    // Cache actual temps to avoid duplicate API calls within a cycle
    // key: 'city:date' → { highF, highC }
    this.actualCache = new Map();
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

    if (stats.tradesResolved > 0 || stats.opportunitiesBackfilled > 0) {
      this._log('info', 'Resolution complete', stats);
    }

    return stats;
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. RESOLVE TRADES
  // ══════════════════════════════════════════════════════════════════

  async _resolveTrades() {
    const today = new Date().toISOString().split('T')[0];

    // Get open trades where target_date < today (past resolution)
    const { data: trades, error } = await db
      .from('trades')
      .select('*')
      .eq('status', 'open')
      .lt('target_date', today);

    if (error) {
      this._log('error', 'Failed to fetch resolvable trades', { error: error.message });
      return 0;
    }

    if (!trades || trades.length === 0) return 0;

    this._log('info', `Resolving ${trades.length} past-due trades`);
    let resolved = 0;

    for (const trade of trades) {
      try {
        const actual = await this._getActualHigh(trade.city, trade.target_date);
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
          })
          .eq('id', trade.id);

        if (updateError) {
          this._log('error', `Failed to update trade ${trade.id}`, { error: updateError.message });
          continue;
        }

        resolved++;

        this._log('info', `RESOLVED: ${trade.side} ${trade.city} ${trade.range_name} [${trade.platform}]`, {
          actual: actualTemp,
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
    const today = new Date().toISOString().split('T')[0];

    // Get unresolved opportunities for past dates (batch of 200)
    const { data: opps, error } = await db
      .from('opportunities')
      .select('id, city, target_date, range_name, range_min, range_max, range_type, range_unit, side')
      .is('would_have_won', null)
      .lt('target_date', today)
      .limit(200);

    if (error) {
      this._log('error', 'Failed to fetch unresolved opportunities', { error: error.message });
      return 0;
    }

    if (!opps || opps.length === 0) return 0;

    this._log('info', `Backfilling ${opps.length} opportunities`);
    let filled = 0;

    // Group by city+date to minimize API calls
    const groups = new Map();
    for (const opp of opps) {
      const key = `${opp.city}:${opp.target_date}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(opp);
    }

    for (const [key, groupOpps] of groups) {
      const [city, dateStr] = key.split(':');
      const actual = await this._getActualHigh(city, dateStr);
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
      .select('city, target_date, range_unit, actual_temp, entry_ensemble, entry_forecast_confidence')
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
          });

        if (!insertErr) recorded++;
      }
    }

    if (recorded > 0) {
      this._log('info', `Recorded ${recorded} forecast accuracy entries`);
    }
    return recorded;
  }

  // ══════════════════════════════════════════════════════════════════
  // ACTUAL TEMPERATURE FETCHERS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Get actual high temperature for a city/date.
   * Uses NWS observations for US cities, METAR for international.
   * Caches results per city+date within a cycle.
   */
  async _getActualHigh(city, dateStr) {
    const cacheKey = `${city}:${dateStr}`;
    if (this.actualCache.has(cacheKey)) {
      return this.actualCache.get(cacheKey);
    }

    const cityConfig = config.cities[city.toLowerCase()];
    if (!cityConfig) return null;

    let result = null;

    if (cityConfig.nwsStation) {
      result = await this._getNWSObservationHigh(cityConfig.nwsStation, dateStr, cityConfig.tz);
    }

    if (!result && cityConfig.polymarketStation) {
      result = await this._getMETARHigh(cityConfig.polymarketStation, dateStr, cityConfig.tz);
    }

    if (!result) {
      // Fallback: Open-Meteo historical
      result = await this._getOpenMeteoHistorical(city, cityConfig, dateStr);
    }

    if (result) {
      this.actualCache.set(cacheKey, result);
    }
    return result;
  }

  /**
   * NWS observations API — for US cities.
   */
  async _getNWSObservationHigh(stationId, dateStr, timezone) {
    try {
      // Build UTC time window for local calendar date
      const utcDate = new Date(`${dateStr}T12:00:00Z`);
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: '2-digit', hour12: false,
      });
      const parts = formatter.formatToParts(utcDate);
      const localHour = parseInt(parts.find(p => p.type === 'hour').value);
      const utcHour = utcDate.getUTCHours();
      let offsetHours = localHour - utcHour;
      if (offsetHours > 12) offsetHours -= 24;
      if (offsetHours < -12) offsetHours += 24;

      const startUTC = new Date(`${dateStr}T00:00:00Z`);
      startUTC.setUTCHours(startUTC.getUTCHours() - offsetHours);
      const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);

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
      const url = `${METAR_API_BASE}?ids=${stationId}&format=json&hours=24`;
      const resp = await this._fetch(url);

      if (!resp.ok) return null;

      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) return null;

      // Build UTC time window for local calendar date
      const utcDate = new Date(`${dateStr}T12:00:00Z`);
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour: '2-digit', hour12: false,
      });
      const parts = formatter.formatToParts(utcDate);
      const localHour = parseInt(parts.find(p => p.type === 'hour').value);
      const utcHour = utcDate.getUTCHours();
      let offsetHours = localHour - utcHour;
      if (offsetHours > 12) offsetHours -= 24;
      if (offsetHours < -12) offsetHours += 24;

      const startUTC = new Date(`${dateStr}T00:00:00Z`);
      startUTC.setUTCHours(startUTC.getUTCHours() - offsetHours);
      const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);

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
