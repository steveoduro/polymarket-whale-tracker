/**
 * resolver.js — Resolution, outcome backfill, accuracy tracking
 *
 * Each cycle:
 * 1. Resolve trades — get actual temp, determine winner, update trades
 * 2. Backfill opportunities — update actual_temp, winning_range, would_have_won
 * 3. Record forecast accuracy — one row per source to v2_forecast_accuracy
 */

const config = require('../config');
const { query, queryOne, execSQL } = require('./db');
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

    // Dedup WU-leads backfill per cycle: 'city:date'
    this._wuLeadsBackfilled = new Set();

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
    // Clear caches for fresh cycle
    this.actualCache.clear();
    this._wuLeadsBackfilled.clear();

    const stats = {
      tradesResolved: 0,
      exitedBackfilled: 0,
      opportunitiesBackfilled: 0,
      accuracyRecorded: 0,
    };

    try {
      stats.tradesResolved = await this._resolveTrades();
    } catch (err) {
      this._log('error', 'Trade resolution failed', { error: err.message });
    }

    try {
      stats.exitedBackfilled = await this._backfillExitedTrades();
    } catch (err) {
      this._log('error', 'Exited trade backfill failed', { error: err.message });
    }

    try {
      stats.opportunitiesBackfilled = await this._backfillOpportunities();
    } catch (err) {
      this._log('error', 'Opportunity backfill failed', { error: err.message });
    }

    try {
      await this._refreshCalibrationTable();
      await this._refreshModelCalibration();
      await this._refreshCityErrorDistribution();
    } catch (err) {
      this._log('error', 'Calibration refresh failed', { error: err.message });
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

    if (stats.tradesResolved > 0 || stats.exitedBackfilled > 0 || stats.opportunitiesBackfilled > 0) {
      this._log('info', 'Resolution complete', stats);
    }

    return stats;
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. RESOLVE TRADES
  // ══════════════════════════════════════════════════════════════════

  async _resolveTrades() {
    // Get all open trades (filter by city-local timezone in JS, not UTC)
    const { data: allTrades, error } = await query(
      `SELECT * FROM trades WHERE status = $1`,
      ['open']
    );

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
        const { data: existingResolved } = await query(
          `SELECT actual_temp, range_unit FROM trades
           WHERE city = $1 AND target_date = $2 AND platform = $3
             AND status = $4 AND actual_temp IS NOT NULL
           LIMIT 1`,
          [trade.city, trade.target_date, trade.platform, 'resolved']
        );

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

        // Fetch observation audit trail (METAR running_high + WU high)
        let obsHigh = null, wuHigh = null;
        try {
          const { data: obs } = await query(
            `SELECT running_high_c, running_high_f, wu_high_f, wu_high_c
             FROM metar_observations
             WHERE city = $1 AND target_date = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [trade.city.toLowerCase(), trade.target_date]
          );
          if (obs && obs.length > 0) {
            obsHigh = trade.range_unit === 'C' ? (obs[0].running_high_c ?? null) : (obs[0].running_high_f ?? null);
            wuHigh = trade.range_unit === 'C' ? (obs[0].wu_high_c ?? null) : (obs[0].wu_high_f ?? null);
          }
        } catch { /* non-critical */ }

        const resolvedAt = new Date().toISOString();
        const resolutionStation = actual.station || actual.source || null;
        const pnlRounded = Math.round(pnl * 100) / 100;
        const feesRounded = Math.round(fees * 100) / 100;

        const { error: updateError } = await query(
          `UPDATE trades
           SET status = $1, actual_temp = $2, won = $3, pnl = $4, fees = $5,
               resolved_at = $6, resolution_station = $7, observation_high = $8, wu_high = $9
           WHERE id = $10`,
          ['resolved', actualTemp, won, pnlRounded, feesRounded,
           resolvedAt, resolutionStation, obsHigh, wuHigh, trade.id]
        );

        if (updateError) {
          this._log('error', `Failed to update trade ${trade.id}`, { error: updateError.message });
          continue;
        }

        resolved++;

        // Backfill wu_leads_events with actual high (once per city/date per cycle)
        await this._backfillWULeads(trade.city, trade.target_date, actualTemp, trade.range_unit);

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
   * Backfill won, actual_temp, observation_high, wu_high on exited/resolved trades.
   * Catches trades the monitor closed (guaranteed_loss/win, edge_gone, take_profit)
   * before the resolver could process them.
   */
  async _backfillExitedTrades() {
    // Find trades missing won OR observation_high (audit trail)
    const { data: trades, error } = await query(
      `SELECT * FROM trades
       WHERE status IN ($1, $2)
         AND (won IS NULL OR observation_high IS NULL OR actual_temp IS NULL)`,
      ['exited', 'resolved']
    );

    if (error) {
      this._log('error', 'Failed to fetch exited trades for backfill', { error: error.message });
      return 0;
    }

    if (!trades || trades.length === 0) return 0;

    // Filter to trades whose target_date has passed in local time
    const pastTrades = trades.filter(trade => {
      const cityConfig = config.cities[trade.city.toLowerCase()];
      if (!cityConfig) return false;
      const localToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: cityConfig.tz,
      }).format(new Date());
      return trade.target_date < localToday;
    });

    if (pastTrades.length === 0) return 0;

    let backfilled = 0;
    for (const trade of pastTrades) {
      try {
        const updates = {};

        // ── Backfill won + actual_temp ──
        if (trade.won == null || trade.actual_temp == null) {
          let actual;

          const { data: existingResolved } = await query(
            `SELECT actual_temp, range_unit FROM trades
             WHERE city = $1 AND target_date = $2 AND platform = $3
               AND actual_temp IS NOT NULL
             LIMIT 1`,
            [trade.city, trade.target_date, trade.platform]
          );

          if (existingResolved && existingResolved.length > 0) {
            const prevTemp = existingResolved[0].actual_temp;
            const cityConfig = config.cities[trade.city.toLowerCase()];
            const prevUnit = existingResolved[0].range_unit || cityConfig?.unit || 'F';
            actual = {
              highF: prevUnit === 'F' ? prevTemp : Math.round(prevTemp * 9 / 5 + 32),
              highC: prevUnit === 'C' ? prevTemp : Math.round((prevTemp - 32) * 5 / 9 * 10) / 10,
            };
          } else {
            actual = await this._getActualHigh(trade.city, trade.target_date, trade.platform);
          }

          if (actual) {
            const correctWon = this._didTradeWin(trade, actual);
            if (trade.won !== correctWon) {
              updates.won = correctWon;
              const payout = correctWon ? 1.00 : 0.00;
              updates.pnl = Math.round((payout * trade.shares - trade.cost) * 100) / 100;
              this._log('warn', `CORRECTED won: ${trade.side} ${trade.city} ${trade.range_name}`, {
                tradeId: trade.id, oldWon: trade.won, newWon: correctWon,
                oldPnl: trade.pnl, newPnl: updates.pnl,
                actualTemp: trade.range_unit === 'C' ? actual.highC : actual.highF,
              });
            } else if (trade.won == null) {
              updates.won = correctWon;
            }
            if (trade.actual_temp == null) {
              updates.actual_temp = trade.range_unit === 'C' ? actual.highC : actual.highF;
            }
          }
        }

        // ── Backfill observation_high + wu_high from metar_observations ──
        if (trade.observation_high == null) {
          const { data: obs } = await query(
            `SELECT running_high_c, running_high_f, wu_high_f, wu_high_c
             FROM metar_observations
             WHERE city = $1 AND target_date = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [trade.city.toLowerCase(), trade.target_date]
          );

          if (obs && obs.length > 0) {
            const o = obs[0];
            updates.observation_high = trade.range_unit === 'C'
              ? (o.running_high_c ?? null)
              : (o.running_high_f ?? null);
            updates.wu_high = trade.range_unit === 'C'
              ? (o.wu_high_c ?? null)
              : (o.wu_high_f ?? null);
          }
        }

        if (Object.keys(updates).length === 0) continue;

        // Build dynamic SET clause from updates object
        const setClauses = [];
        const values = [];
        let paramIdx = 1;
        for (const [col, val] of Object.entries(updates)) {
          setClauses.push(`${col} = $${paramIdx}`);
          values.push(val);
          paramIdx++;
        }
        values.push(trade.id);

        const { error: updateError } = await query(
          `UPDATE trades SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
          values
        );

        if (updateError) {
          this._log('error', `Failed to backfill trade ${trade.id}`, { error: updateError.message });
          continue;
        }

        backfilled++;
      } catch (err) {
        this._log('error', `Backfill failed for trade ${trade.id}`, { error: err.message });
      }
    }

    if (backfilled > 0) {
      this._log('info', `Backfilled ${backfilled} exited trades (won/actual_temp/observation_high)`);
    }

    return backfilled;
  }

  /**
   * Log WU vs METAR comparison to wu_audit table.
   */
  async _logWUAudit(city, dateStr, stationId, wuResult, metarResult, match) {
    try {
      await query(
        `INSERT INTO wu_audit (city, target_date, station_id, wu_high_f, wu_high_c, metar_high_f, metar_high_c, match, diff_f)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (city, station_id, target_date) DO UPDATE SET
           wu_high_f = EXCLUDED.wu_high_f,
           wu_high_c = EXCLUDED.wu_high_c,
           metar_high_f = EXCLUDED.metar_high_f,
           metar_high_c = EXCLUDED.metar_high_c,
           match = EXCLUDED.match,
           diff_f = EXCLUDED.diff_f`,
        [city, dateStr, stationId, wuResult.highF, wuResult.highC,
         metarResult.highF, metarResult.highC, match,
         wuResult.highF - metarResult.highF]
      );
    } catch (err) {
      this._log('warn', 'Failed to log WU audit', { error: err.message });
    }
  }

  /**
   * Backfill wu_leads_events with actual high temp and wu_was_right outcome.
   * Called once per city/date per resolve cycle (deduped by _wuLeadsBackfilled Set).
   */
  async _backfillWULeads(city, dateStr, actualTemp, unit) {
    const dedupeKey = `${city}:${dateStr}`;
    if (this._wuLeadsBackfilled.has(dedupeKey)) return;
    this._wuLeadsBackfilled.add(dedupeKey);

    try {
      await query(
        `UPDATE wu_leads_events
         SET actual_high = $1,
             wu_was_right = CASE WHEN $4 = 'C' THEN $1 >= wu_high_c ELSE $1 >= wu_high_f END
         WHERE city = $2 AND target_date = $3 AND wu_was_right IS NULL`,
        [actualTemp, city, dateStr, unit]
      );
    } catch (err) {
      this._log('warn', 'Failed to backfill WU leads events', { city, date: dateStr, error: err.message });
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
    const { data: opps, error } = await query(
      `SELECT id, city, target_date, platform, range_name, range_min, range_max, range_type, range_unit, side
       FROM opportunities
       WHERE would_have_won IS NULL AND target_date < $1
       LIMIT 200`,
      [earliestLocalToday]
    );

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
      const { data: existingResolved } = await query(
        `SELECT actual_temp, range_unit FROM trades
         WHERE city = $1 AND target_date = $2 AND platform = $3
           AND status = $4 AND actual_temp IS NOT NULL
         LIMIT 1`,
        [city, dateStr, platform, 'resolved']
      );

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

        const { error: updateErr } = await query(
          `UPDATE opportunities
           SET actual_temp = $1, winning_range = $2, would_have_won = $3, resolved_at = $4
           WHERE id = $5`,
          [actualTemp, inRange ? opp.range_name : null, wouldHaveWon,
           new Date().toISOString(), opp.id]
        );

        if (!updateErr) filled++;
      }
    }

    this._log('info', `Backfilled ${filled} opportunities`);
    return filled;
  }

  /**
   * Refresh the market_calibration lookup table from resolved opportunities.
   * TRUNCATE + INSERT — table is ~50 rows, full rebuild is simplest.
   */
  async _refreshCalibrationTable() {
    try {
      await execSQL(`
        TRUNCATE market_calibration;

        WITH market_level AS (
          SELECT
            platform,
            range_type,
            city,
            CASE
              WHEN hours_to_resolution < 12 THEN '<12h'
              WHEN hours_to_resolution < 24 THEN '12-24h'
              WHEN hours_to_resolution < 36 THEN '24-36h'
              ELSE '36h+'
            END as lead_time_bucket,
            CASE
              WHEN ask < 0.10 THEN '0-10c'
              WHEN ask < 0.15 THEN '10-15c'
              WHEN ask < 0.20 THEN '15-20c'
              WHEN ask < 0.25 THEN '20-25c'
              WHEN ask < 0.30 THEN '25-30c'
              WHEN ask < 0.35 THEN '30-35c'
              WHEN ask < 0.40 THEN '35-40c'
              WHEN ask < 0.45 THEN '40-45c'
              WHEN ask < 0.50 THEN '45-50c'
              WHEN ask < 0.55 THEN '50-55c'
              ELSE '55c+'
            END as price_bucket,
            market_id,
            MAX(CASE WHEN would_have_won THEN 1 ELSE 0 END) as won,
            AVG(ask) as market_avg_ask,
            AVG(our_probability) as market_avg_model_prob,
            COUNT(*) as scan_count
          FROM opportunities
          WHERE side = 'YES'
            AND would_have_won IS NOT NULL
            AND ask > 0
            AND our_probability != 'NaN'
            AND hours_to_resolution IS NOT NULL
            AND (model_valid IS NULL OR model_valid = true)
            AND target_date >= CURRENT_DATE - INTERVAL '60 days'
          GROUP BY platform, range_type, city, lead_time_bucket, price_bucket, market_id
        )

        -- Global rows (city = NULL)
        INSERT INTO market_calibration (platform, range_type, lead_time_bucket, price_bucket, n, unique_markets, empirical_win_rate, avg_model_prob, calibration_gap, avg_ask, true_edge)
        SELECT
          platform,
          range_type,
          lead_time_bucket,
          price_bucket,
          COUNT(*) as n,
          COUNT(*) as unique_markets,
          AVG(won) as empirical_win_rate,
          AVG(market_avg_model_prob) as avg_model_prob,
          AVG(market_avg_model_prob) - AVG(won) as calibration_gap,
          AVG(market_avg_ask) as avg_ask,
          AVG(won) - AVG(market_avg_ask) as true_edge
        FROM market_level
        GROUP BY 1, 2, 3, 4;

        -- Per-city rows
        WITH market_level_city AS (
          SELECT
            platform,
            range_type,
            city,
            CASE
              WHEN hours_to_resolution < 12 THEN '<12h'
              WHEN hours_to_resolution < 24 THEN '12-24h'
              WHEN hours_to_resolution < 36 THEN '24-36h'
              ELSE '36h+'
            END as lead_time_bucket,
            CASE
              WHEN ask < 0.10 THEN '0-10c'
              WHEN ask < 0.15 THEN '10-15c'
              WHEN ask < 0.20 THEN '15-20c'
              WHEN ask < 0.25 THEN '20-25c'
              WHEN ask < 0.30 THEN '25-30c'
              WHEN ask < 0.35 THEN '30-35c'
              WHEN ask < 0.40 THEN '35-40c'
              WHEN ask < 0.45 THEN '40-45c'
              WHEN ask < 0.50 THEN '45-50c'
              WHEN ask < 0.55 THEN '50-55c'
              ELSE '55c+'
            END as price_bucket,
            market_id,
            MAX(CASE WHEN would_have_won THEN 1 ELSE 0 END) as won,
            AVG(ask) as market_avg_ask,
            AVG(our_probability) as market_avg_model_prob,
            COUNT(*) as scan_count
          FROM opportunities
          WHERE side = 'YES'
            AND would_have_won IS NOT NULL
            AND ask > 0
            AND our_probability != 'NaN'
            AND hours_to_resolution IS NOT NULL
            AND (model_valid IS NULL OR model_valid = true)
            AND target_date >= CURRENT_DATE - INTERVAL '60 days'
          GROUP BY platform, range_type, city, lead_time_bucket, price_bucket, market_id
        )
        INSERT INTO market_calibration (platform, range_type, lead_time_bucket, price_bucket, city, n, unique_markets, empirical_win_rate, avg_model_prob, calibration_gap, avg_ask, true_edge)
        SELECT
          platform,
          range_type,
          lead_time_bucket,
          price_bucket,
          city,
          COUNT(*) as n,
          COUNT(*) as unique_markets,
          AVG(won) as empirical_win_rate,
          AVG(market_avg_model_prob) as avg_model_prob,
          AVG(market_avg_model_prob) - AVG(won) as calibration_gap,
          AVG(market_avg_ask) as avg_ask,
          AVG(won) - AVG(market_avg_ask) as true_edge
        FROM market_level_city
        GROUP BY 1, 2, 3, 4, 5
        HAVING COUNT(*) >= 10;
      `);
      this._log('info', 'Market calibration table refreshed');
    } catch (err) {
      this._log('warn', 'Failed to refresh calibration table', { error: err.message });
    }
  }

  /**
   * Refresh model_calibration table — correction ratios by range_type × model probability bucket.
   */
  async _refreshModelCalibration() {
    try {
      await execSQL(`
        TRUNCATE model_calibration;
        INSERT INTO model_calibration (range_type, model_prob_bucket, n, avg_model_prob, actual_win_rate, correction_ratio)
        WITH market_level AS (
          SELECT
            range_type,
            CASE
              WHEN our_probability < 0.05 THEN '0-5%'
              WHEN our_probability < 0.10 THEN '5-10%'
              WHEN our_probability < 0.15 THEN '10-15%'
              WHEN our_probability < 0.20 THEN '15-20%'
              WHEN our_probability < 0.25 THEN '20-25%'
              WHEN our_probability < 0.30 THEN '25-30%'
              WHEN our_probability < 0.35 THEN '30-35%'
              WHEN our_probability < 0.40 THEN '35-40%'
              WHEN our_probability < 0.45 THEN '40-45%'
              WHEN our_probability < 0.50 THEN '45-50%'
              WHEN our_probability < 0.55 THEN '50-55%'
              WHEN our_probability < 0.60 THEN '55-60%'
              WHEN our_probability < 0.65 THEN '60-65%'
              WHEN our_probability < 0.70 THEN '65-70%'
              WHEN our_probability < 0.75 THEN '70-75%'
              ELSE '75%+'
            END as model_prob_bucket,
            market_id,
            MAX(CASE WHEN would_have_won THEN 1 ELSE 0 END) as won,
            AVG(our_probability) as market_avg_prob
          FROM opportunities
          WHERE side = 'YES'
            AND would_have_won IS NOT NULL
            AND our_probability > 0
            AND our_probability != 'NaN'
            AND hours_to_resolution BETWEEN 8 AND 60
            AND (model_valid IS NULL OR model_valid = true)
            AND target_date >= CURRENT_DATE - INTERVAL '60 days'
          GROUP BY 1, 2, market_id
        )
        SELECT
          range_type,
          model_prob_bucket,
          COUNT(*) as n,
          AVG(market_avg_prob) as avg_model_prob,
          AVG(won) as actual_win_rate,
          CASE WHEN AVG(market_avg_prob) > 0
            THEN AVG(won) / AVG(market_avg_prob)
            ELSE 0
          END as correction_ratio
        FROM market_level
        GROUP BY 1, 2;

        INSERT INTO model_calibration (city, range_type, model_prob_bucket, n, avg_model_prob, actual_win_rate, correction_ratio)
        WITH market_level AS (
          SELECT
            city,
            range_type,
            CASE
              WHEN our_probability < 0.05 THEN '0-5%'
              WHEN our_probability < 0.10 THEN '5-10%'
              WHEN our_probability < 0.15 THEN '10-15%'
              WHEN our_probability < 0.20 THEN '15-20%'
              WHEN our_probability < 0.25 THEN '20-25%'
              WHEN our_probability < 0.30 THEN '25-30%'
              WHEN our_probability < 0.35 THEN '30-35%'
              WHEN our_probability < 0.40 THEN '35-40%'
              WHEN our_probability < 0.45 THEN '40-45%'
              WHEN our_probability < 0.50 THEN '45-50%'
              WHEN our_probability < 0.55 THEN '50-55%'
              WHEN our_probability < 0.60 THEN '55-60%'
              WHEN our_probability < 0.65 THEN '60-65%'
              WHEN our_probability < 0.70 THEN '65-70%'
              WHEN our_probability < 0.75 THEN '70-75%'
              ELSE '75%+'
            END as model_prob_bucket,
            market_id,
            MAX(CASE WHEN would_have_won THEN 1 ELSE 0 END) as won,
            AVG(our_probability) as market_avg_prob
          FROM opportunities
          WHERE side = 'YES'
            AND would_have_won IS NOT NULL
            AND our_probability > 0
            AND our_probability != 'NaN'
            AND hours_to_resolution BETWEEN 8 AND 60
            AND (model_valid IS NULL OR model_valid = true)
            AND target_date >= CURRENT_DATE - INTERVAL '60 days'
          GROUP BY 1, 2, 3, market_id
        )
        SELECT
          city,
          range_type,
          model_prob_bucket,
          COUNT(*) as n,
          AVG(market_avg_prob) as avg_model_prob,
          AVG(won) as actual_win_rate,
          CASE WHEN AVG(market_avg_prob) > 0
            THEN AVG(won) / AVG(market_avg_prob)
            ELSE 0
          END as correction_ratio
        FROM market_level
        GROUP BY 1, 2, 3
        HAVING COUNT(*) >= 50
      `);
      this._log('info', 'Model calibration table refreshed');
    } catch (err) {
      this._log('warn', 'Failed to refresh model calibration table', { error: err.message });
    }
  }

  /**
   * Refresh city_error_distribution — per-city empirical error percentiles.
   * Runs every cycle (not just on backfill) since new accuracy data arrives from _recordAccuracy.
   */
  async _refreshCityErrorDistribution() {
    try {
      await execSQL(`
        TRUNCATE city_error_distribution;
        INSERT INTO city_error_distribution (
          city, unit, n, mean_error, stddev_error,
          p5, p10, p15, p20, p25, p30, p35, p40, p45, p50,
          p55, p60, p65, p70, p75, p80, p85, p90, p95,
          is_active
        )
        SELECT
          city, unit, COUNT(*),
          AVG(error), STDDEV(error),
          PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.10) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.15) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.20) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.30) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.35) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.40) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.45) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.55) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.60) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.65) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.70) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.85) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY error),
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY error),
          COUNT(*) >= 30
        FROM v2_forecast_accuracy
        WHERE actual_temp IS NOT NULL
          AND source = 'ensemble_corrected'
        GROUP BY city, unit
      `);
    } catch (err) {
      this._log('warn', 'Failed to refresh city error distribution', { error: err.message });
    }
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

    const { data: trades, error } = await query(
      `SELECT city, target_date, range_unit, actual_temp, entry_ensemble,
              entry_forecast_confidence, hours_to_resolution, platform
       FROM trades
       WHERE status = $1 AND resolved_at >= $2 AND actual_temp IS NOT NULL`,
      ['resolved', yesterdayStr]
    );

    if (error || !trades || trades.length === 0) return 0;

    // Deduplicate by city+date (many trades can share same city/date)
    const seen = new Set();
    let recorded = 0;

    for (const trade of trades) {
      const key = `${trade.city}:${trade.target_date}:${trade.platform || 'unknown'}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Derive resolution station from config
      const cityConfig = config.cities[trade.city];
      const resolutionStation = trade.platform === 'kalshi'
        ? (cityConfig?.nwsStation || cityConfig?.polymarketStation)
        : (cityConfig?.polymarketStation || cityConfig?.nwsStation);
      const tradePlatform = trade.platform || null;

      // Check if ensemble_corrected specifically exists for this platform
      const { data: existingEnsemble } = await query(
        `SELECT id FROM v2_forecast_accuracy
         WHERE city = $1 AND target_date = $2 AND source = $3
           AND COALESCE(platform, '') = COALESCE($4, '')
         LIMIT 1`,
        [trade.city, trade.target_date, 'ensemble_corrected', tradePlatform]
      );

      const skipEnsemble = existingEnsemble && existingEnsemble.length > 0;

      const sources = trade.entry_ensemble || {};
      const actualTemp = trade.actual_temp;
      const unit = trade.range_unit;

      // Record one row per source (check per-source to avoid skipping all if one exists)
      for (const [source, forecastTemp] of Object.entries(sources)) {
        if (forecastTemp == null) continue;

        const { data: existingSrc } = await query(
          `SELECT id FROM v2_forecast_accuracy
           WHERE city = $1 AND target_date = $2 AND source = $3
             AND COALESCE(platform, '') = COALESCE($4, '')
           LIMIT 1`,
          [trade.city, trade.target_date, source, tradePlatform]
        );
        if (existingSrc?.length > 0) continue;

        const error = forecastTemp - actualTemp;
        const absError = Math.abs(error);

        const { error: insertErr } = await query(
          `INSERT INTO v2_forecast_accuracy
           (city, target_date, source, confidence, forecast_temp, actual_temp, error, abs_error, unit, hours_before_resolution, platform, resolution_station)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [trade.city, trade.target_date, source, trade.entry_forecast_confidence,
           forecastTemp, actualTemp,
           Math.round(error * 100) / 100, Math.round(absError * 100) / 100,
           unit, trade.hours_to_resolution ?? null, tradePlatform, resolutionStation]
        );

        if (!insertErr) recorded++;
      }

      // Record ensemble_corrected accuracy (the corrected ensemble the scanner actually used)
      if (!skipEnsemble) try {
        const { data: oppData } = await query(
          `SELECT forecast_temp FROM opportunities
           WHERE city = $1 AND target_date = $2 AND platform = $3 AND forecast_temp IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          [trade.city, trade.target_date, tradePlatform]
        );

        if (oppData?.length && oppData[0].forecast_temp != null) {
          const ensembleForecast = Number(oppData[0].forecast_temp);
          const ensembleError = ensembleForecast - actualTemp;
          await query(
            `INSERT INTO v2_forecast_accuracy
             (city, target_date, source, confidence, forecast_temp, actual_temp, error, abs_error, unit, hours_before_resolution, platform, resolution_station)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [trade.city, trade.target_date, 'ensemble_corrected',
             trade.entry_forecast_confidence, ensembleForecast, actualTemp,
             Math.round(ensembleError * 100) / 100,
             Math.round(Math.abs(ensembleError) * 100) / 100,
             unit, trade.hours_to_resolution ?? null, tradePlatform, resolutionStation]
          );
          recorded++;
        }
      } catch (ensErr) {
        this._log('warn', `Failed to record ensemble_corrected for ${trade.city} ${trade.target_date}`, { error: ensErr.message });
      }
    }

    // Second pass: record accuracy from opportunities (covers non-traded cities)
    // Only look at recently-resolved opportunities (last 48h) to avoid full table scan
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString();

    const { data: opps, error: oppErr } = await query(
      `SELECT city, target_date, actual_temp, forecast_temp, forecast_sources,
              forecast_confidence, range_unit, ensemble_std_dev, hours_to_resolution, platform
       FROM opportunities
       WHERE actual_temp IS NOT NULL AND forecast_sources IS NOT NULL
         AND resolved_at >= $1
       ORDER BY created_at DESC
       LIMIT 500`,
      [twoDaysAgoStr]
    );

    if (!oppErr && opps && opps.length > 0) {
      // Keep only the latest row per city+date+platform
      const oppByCityDate = new Map();
      for (const opp of opps) {
        const key = `${opp.city}:${opp.target_date}:${opp.platform || 'unknown'}`;
        if (seen.has(key)) continue; // already recorded from trades pass
        if (oppByCityDate.has(key)) continue; // already have latest for this combo
        oppByCityDate.set(key, opp);
      }

      for (const [key, opp] of oppByCityDate) {
        const oppPlatform = opp.platform || null;
        const oppCityConfig = config.cities[opp.city];
        const oppStation = oppPlatform === 'kalshi'
          ? (oppCityConfig?.nwsStation || oppCityConfig?.polymarketStation)
          : (oppCityConfig?.polymarketStation || oppCityConfig?.nwsStation);

        // Check if ensemble_corrected specifically exists for this platform
        const { data: existingEnsemble } = await query(
          `SELECT id FROM v2_forecast_accuracy
           WHERE city = $1 AND target_date = $2 AND source = $3
             AND COALESCE(platform, '') = COALESCE($4, '')
           LIMIT 1`,
          [opp.city, opp.target_date, 'ensemble_corrected', oppPlatform]
        );

        const skipEnsemble = existingEnsemble && existingEnsemble.length > 0;

        const sources = typeof opp.forecast_sources === 'string'
          ? JSON.parse(opp.forecast_sources) : opp.forecast_sources || {};
        const actualTemp = opp.actual_temp;
        const unit = opp.range_unit;

        // Record one row per source (check per-source to avoid skipping all if one exists)
        for (const [source, forecastTemp] of Object.entries(sources)) {
          if (forecastTemp == null) continue;

          const { data: existingSrc } = await query(
            `SELECT id FROM v2_forecast_accuracy
             WHERE city = $1 AND target_date = $2 AND source = $3
               AND COALESCE(platform, '') = COALESCE($4, '')
             LIMIT 1`,
            [opp.city, opp.target_date, source, oppPlatform]
          );
          if (existingSrc?.length > 0) continue;

          const err = forecastTemp - actualTemp;
          const absErr = Math.abs(err);

          const { error: insertErr } = await query(
            `INSERT INTO v2_forecast_accuracy
             (city, target_date, source, confidence, forecast_temp, actual_temp, error, abs_error, unit, hours_before_resolution, platform, resolution_station)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [opp.city, opp.target_date, source, opp.forecast_confidence,
             forecastTemp, actualTemp,
             Math.round(err * 100) / 100, Math.round(absErr * 100) / 100,
             unit, opp.hours_to_resolution ?? null, oppPlatform, oppStation]
          );

          if (!insertErr) recorded++;
        }

        // Record ensemble_corrected accuracy from opportunity's forecast_temp
        if (!skipEnsemble && opp.forecast_temp != null) {
          try {
            const ensembleForecast = Number(opp.forecast_temp);
            const ensembleError = ensembleForecast - actualTemp;
            await query(
              `INSERT INTO v2_forecast_accuracy
               (city, target_date, source, confidence, forecast_temp, actual_temp, error, abs_error, unit, hours_before_resolution, platform, resolution_station)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [opp.city, opp.target_date, 'ensemble_corrected',
               opp.forecast_confidence, ensembleForecast, actualTemp,
               Math.round(ensembleError * 100) / 100,
               Math.round(Math.abs(ensembleError) * 100) / 100,
               unit, opp.hours_to_resolution ?? null, oppPlatform, oppStation]
            );
            recorded++;
          } catch (ensErr) {
            this._log('warn', `Failed to record ensemble_corrected for ${opp.city} ${opp.target_date}`, { error: ensErr.message });
          }
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
    const { data: accuracyRows, error: accErr } = await query(
      `SELECT source, unit, error FROM v2_forecast_accuracy
       WHERE target_date >= $1`,
      [cutoff]
    );

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
    const { data: oppRows, error: oppErr } = await query(
      `SELECT our_probability, would_have_won, side
       FROM opportunities
       WHERE would_have_won IS NOT NULL AND target_date >= $1 AND side = $2
         AND (model_valid IS NULL OR model_valid = true)
       LIMIT 2000`,
      [cutoff, 'YES']
    );

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
      await query(
        `INSERT INTO cli_audit (city, station, target_date, cli_high_f, nws_obs_high_f, diff_f, cli_raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (city, target_date) DO UPDATE SET
           station = EXCLUDED.station,
           cli_high_f = EXCLUDED.cli_high_f,
           nws_obs_high_f = EXCLUDED.nws_obs_high_f,
           diff_f = EXCLUDED.diff_f,
           cli_raw = EXCLUDED.cli_raw`,
        [city, stationId, dateStr,
         cliResult?.highF ?? null,
         nwsResult?.highF ?? null,
         (cliResult?.highF != null && nwsResult?.highF != null)
           ? cliResult.highF - nwsResult.highF : null,
         cliResult?.cliRaw ? JSON.stringify(cliResult.cliRaw) : null]
      );
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
