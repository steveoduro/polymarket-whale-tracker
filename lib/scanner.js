/**
 * scanner.js — Opportunity evaluation and logging
 *
 * For each city/date market with a fresh forecast:
 * 1. Get all ranges from platform adapter
 * 2. Calculate probability using normal distribution
 * 3. Calculate edge against the ask
 * 4. Apply filters (edge, spread, sanity)
 * 5. Log ALL opportunities to DB (entered + filtered)
 * 6. Return approved opportunities
 */

const config = require('../config');
const { db } = require('./db');
const peakHours = require('./peak-hours');

class Scanner {
  constructor(platformAdapter, forecastEngine) {
    this.adapter = platformAdapter;
    this.forecast = forecastEngine;

    // Tier 2 dedup: track last logged edge per combo to skip near-identical rows
    // Key: ${city}:${target_date}:${range_name}:${side}:${platform} → { edge_pct, date }
    this.lastLoggedEdge = new Map();
    this._lastLoggedDate = null; // clear map on date rollover

    // Tier 3 summaries: accumulate low-edge opportunities for daily summary rows
    // Key: same combo key → { count, min_edge, max_edge, sum_edge, min_ask, max_ask, last_opp }
    this.dailySummaries = new Map();
    this._lastSummaryDate = null;
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const label = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[SCANNER]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Scan all cities/dates for opportunities.
   * Returns { opportunities: [...approved], logged: count, filtered: count }
   */
  async scan() {
    const approved = [];
    let logged = 0;
    let skippedDedup = 0;
    let accumulated = 0;
    let filtered = 0;
    let marketsScanned = 0;

    // Load existing trades for position-awareness (O(1) lookup)
    try {
      const { data: existingTrades } = await db.from('trades')
        .select('city, target_date, range_name, side, platform, status')
        .in('status', ['open', 'exited', 'resolved']);

      this._positionKeys = new Set(
        (existingTrades || []).map(t => `${t.city}:${t.target_date}:${t.range_name}:${t.side}:${t.platform}`)
      );
      this._openYesKeys = new Set(
        (existingTrades || []).filter(t => t.side === 'YES' && t.status === 'open')
          .map(t => `${t.city}:${t.target_date}`)
      );
      this._openNoKeys = new Set(
        (existingTrades || []).filter(t => t.side === 'NO' && t.status === 'open')
          .map(t => `${t.city}:${t.target_date}`)
      );
    } catch (err) {
      this._log('warn', 'Failed to load positions for dedup — falling through', { error: err.message });
      this._positionKeys = null;
      this._openYesKeys = null;
      this._openNoKeys = null;
    }

    // Load market calibration data for historical win rate checks
    this._calibration = await this._loadCalibration();

    // Date rollover: clear dedup and flush stale summaries
    const todayUTC = new Date().toISOString().split('T')[0];
    if (this._lastLoggedDate && this._lastLoggedDate !== todayUTC) {
      this.lastLoggedEdge.clear();
    }
    this._lastLoggedDate = todayUTC;

    // Flush previous day's summaries on date rollover
    if (this._lastSummaryDate && this._lastSummaryDate !== todayUTC) {
      await this._flushSummaries();
    }
    this._lastSummaryDate = todayUTC;

    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
      // City eligibility gate (Layer 1): check once per city, before any date scanning
      const eligibility = await this.forecast.getCityEligibility(cityKey);

      // Cache observation + local hour for today (used by obs entry gate)
      const obsGate = config.observation_entry_gate || {};
      let todayObs = null;
      let localHour = null;
      let localToday = null;
      if (obsGate.ENABLED) {
        localToday = this._getLocalToday(cityConfig.tz);
        localHour = this._getLocalHour(cityConfig.tz);
        todayObs = await this._getLatestObservation(cityKey, localToday);
      }

      // Per-city dates based on local timezone (Seoul/Wellington get correct "today")
      const dates = this._getScanDates(cityConfig.tz);
      for (const dateStr of dates) {
        try {
          // Get forecast for this city/date
          const forecast = await this.forecast.getForecast(cityKey, dateStr);
          if (!forecast) continue;

          // Get all ranges from all enabled platforms
          const ranges = await this.adapter.getMarkets(cityKey, dateStr);
          if (!ranges || ranges.length === 0) continue;

          marketsScanned++;

          // ── YES: closest-to-forecast range selection ──
          // Pick the range whose boundary/midpoint is closest to forecast temp.
          // If it passes filters, enter it. If not, skip ALL YES for this city/date.
          const closestRange = this._findClosestRange(ranges, forecast);
          if (closestRange) {
            const isBounded = closestRange.rangeType === 'bounded';
            let cityGateReason = null;
            if (!eligibility.allowUnbounded) {
              cityGateReason = `city_mae_too_high (${eligibility.mae}°${eligibility.unit} > threshold, n=${eligibility.n})`;
            } else if (isBounded && !eligibility.allowBounded) {
              cityGateReason = `city_mae_too_high_for_bounded (${eligibility.mae}°${eligibility.unit} > bounded threshold, n=${eligibility.n})`;
            }

            const yesOpp = this._evaluateYes(cityKey, dateStr, closestRange, forecast);
            if (yesOpp) {
              if (cityGateReason) {
                yesOpp.action = 'filtered';
                yesOpp.filter_reason = cityGateReason;
              }
              // Observation entry gate: block bounded YES near ceiling when obs exceeds forecast
              if (yesOpp.action === 'entered' && obsGate.ENABLED && isBounded
                  && todayObs && dateStr === localToday) {
                const cityCooling = peakHours.get(cityKey);
                if (localHour != null && localHour < cityCooling) {
                  const high = cityConfig.unit === 'C' ? todayObs.running_high_c : todayObs.running_high_f;
                  const buffer = cityConfig.unit === 'C' ? (obsGate.BOUNDARY_BUFFER_C || 0.5) : (obsGate.BOUNDARY_BUFFER_F || 1.0);
                  if (high != null && high > forecast.temp && high >= closestRange.rangeMax - buffer) {
                    yesOpp.action = 'filtered';
                    yesOpp.filter_reason = `obs_entry_gate (high ${high}° > forecast ${forecast.temp}° and ${(closestRange.rangeMax - high).toFixed(1)}° from ceiling ${closestRange.rangeMax}°, ${localHour}:00 local < cooling ${cityCooling}:00)`;
                    this._log('info', `OBS ENTRY GATE: ${cityKey} ${closestRange.rangeName} YES blocked — high ${high}°${cityConfig.unit} > forecast ${forecast.temp}°, ${(closestRange.rangeMax - high).toFixed(1)}° from ceiling ${closestRange.rangeMax}°, ${localHour}:00 local`);
                  }
                }
              }
              if (yesOpp.action === 'entered' && this._positionKeys) {
                const posKey = `${cityKey}:${dateStr}:${closestRange.rangeName}:YES:${closestRange.platform}`;
                const yesKey = `${cityKey}:${dateStr}`;
                if (this._positionKeys.has(posKey)) {
                  yesOpp.action = 'filtered';
                  yesOpp.filter_reason = 'existing_position';
                } else if (this._openYesKeys.has(yesKey)) {
                  yesOpp.action = 'filtered';
                  yesOpp.filter_reason = 'existing_yes_position';
                }
              }
              const result = await this._tieredLog(yesOpp);
              if (result === 'logged') logged++;
              else if (result === 'skipped') skippedDedup++;
              else if (result === 'accumulated') accumulated++;
              if (yesOpp.action === 'entered') {
                approved.push(yesOpp);
              } else {
                filtered++;
              }
            }
          }

          // ── NO: evaluate all ranges, pick best per city/date ──
          const noOpps = [];
          for (const range of ranges) {
            const isBounded = range.rangeType === 'bounded';
            let cityGateReason = null;
            if (!eligibility.allowUnbounded) {
              cityGateReason = `city_mae_too_high (${eligibility.mae}°${eligibility.unit} > threshold, n=${eligibility.n})`;
            } else if (isBounded && !eligibility.allowBounded) {
              cityGateReason = `city_mae_too_high_for_bounded (${eligibility.mae}°${eligibility.unit} > bounded threshold, n=${eligibility.n})`;
            }

            const noOpp = this._evaluateNo(cityKey, dateStr, range, forecast);
            if (noOpp) {
              if (cityGateReason) {
                noOpp.action = 'filtered';
                noOpp.filter_reason = cityGateReason;
              }
              if (noOpp.action === 'entered' && this._positionKeys) {
                const posKey = `${cityKey}:${dateStr}:${range.rangeName}:NO:${range.platform}`;
                if (this._positionKeys.has(posKey)) {
                  noOpp.action = 'filtered';
                  noOpp.filter_reason = 'existing_position';
                } else if (this._openNoKeys?.has(`${cityKey}:${dateStr}`)) {
                  noOpp.action = 'filtered';
                  noOpp.filter_reason = 'existing_no_position';
                }
              }
              noOpps.push(noOpp);
            }
          }

          // Among entered NOs, pick the one with highest edge
          let bestNoIdx = -1;
          let bestEdge = -Infinity;
          for (let i = 0; i < noOpps.length; i++) {
            if (noOpps[i].action === 'entered' && noOpps[i].edge_pct > bestEdge) {
              bestEdge = noOpps[i].edge_pct;
              bestNoIdx = i;
            }
          }
          for (let i = 0; i < noOpps.length; i++) {
            if (noOpps[i].action === 'entered' && i !== bestNoIdx) {
              noOpps[i].action = 'filtered';
              noOpps[i].filter_reason = 'not_best_no_for_city_date';
            }
          }

          // Log and approve
          for (const noOpp of noOpps) {
            const result = await this._tieredLog(noOpp);
            if (result === 'logged') logged++;
            else if (result === 'skipped') skippedDedup++;
            else if (result === 'accumulated') accumulated++;
            if (noOpp.action === 'entered') {
              approved.push(noOpp);
            } else {
              filtered++;
            }
          }
        } catch (err) {
          this._log('error', `Scan failed for ${cityKey} ${dateStr}`, { error: err.message });
        }
      }
    }

    this._log('info', `Scan complete`, {
      marketsScanned,
      logged,
      skippedDedup,
      accumulated,
      approved: approved.length,
      filtered,
    });

    return { opportunities: approved, logged, filtered, marketsScanned, skippedDedup, accumulated };
  }

  /**
   * Evaluate YES side for a range.
   */
  _evaluateYes(city, dateStr, range, forecast) {
    const { ask, bid, spread } = range;

    // Sanity: need a valid ask price
    if (!ask || ask <= 0 || ask >= 1) return null;

    // Calculate probability that temp falls in this range
    const probability = this.forecast.calculateProbability(
      forecast.temp, forecast.stdDev,
      range.rangeMin, range.rangeMax,
      forecast.unit
    );

    // Edge = our probability - ask price
    const edgePct = (probability - ask) * 100;

    // Expected value after fees
    // Kalshi: per-contract fee 0.07*P*(1-P) at entry, no settlement fee
    // Polymarket: zero fees on weather markets
    const entryFee = this.adapter.getEntryFee(range.platform, ask);
    const effectiveCost = ask + entryFee;
    const payout = 1.0; // no settlement fee on either platform
    const ev = probability * payout - effectiveCost;

    // Kelly fraction: b = netProfit/effectiveCost (true net odds for prediction markets)
    const netProfit = payout - effectiveCost;
    const kellyFull = probability > 0 && netProfit > 0
      ? ((netProfit / effectiveCost) * probability - (1 - probability)) / (netProfit / effectiveCost)
      : 0;
    const kelly = Math.max(0, kellyFull * config.sizing.KELLY_FRACTION);

    // Determine action + filter reason
    const { action, filterReason } = this._applyFilters('YES', edgePct, spread, ask, bid, range, forecast.hoursToResolution);

    // Calibration lookup for logging
    const cal = (forecast.hoursToResolution != null)
      ? this._getCalibration(range.rangeType, forecast.hoursToResolution, ask)
      : null;
    let calBucket = null;
    if (cal && forecast.hoursToResolution != null) {
      const { leadBucket, priceBucket } = this._getCalibrationBuckets(range.rangeType, forecast.hoursToResolution, ask);
      calBucket = `${range.rangeType}|${leadBucket}|${priceBucket}`;
    }

    return {
      city,
      target_date: dateStr,
      platform: range.platform,
      market_id: range.marketId,
      token_id: range.tokenId,
      range_name: range.rangeName,
      range_min: range.rangeMin,
      range_max: range.rangeMax,
      range_type: range.rangeType,
      range_unit: range.rangeUnit || forecast.unit,
      side: 'YES',
      bid,
      ask,
      spread,
      volume: range.volume || 0,
      bid_depth: range.bid_depth || null,
      ask_depth: range.ask_depth || null,
      forecast_temp: forecast.temp,
      forecast_confidence: forecast.confidence,
      forecast_sources: forecast.sources,
      ensemble_temp: forecast.temp,
      ensemble_std_dev: forecast.stdDev,
      our_probability: Math.round(probability * 10000) / 10000,
      edge_pct: Math.round(edgePct * 100) / 100,
      expected_value: Math.round(ev * 10000) / 10000,
      kelly_fraction: Math.round(kelly * 10000) / 10000,
      action,
      filter_reason: filterReason,
      hours_to_resolution: forecast.hoursToResolution,
      range_width: (range.rangeMax != null && range.rangeMin != null)
        ? range.rangeMax - range.rangeMin : null,
      // Analysis flags
      would_pass_at_5pct: edgePct >= 5,
      would_pass_at_8pct: edgePct >= 8,
      would_pass_at_10pct: edgePct >= 10,
      would_pass_at_15pct: edgePct >= 15,
      // Calibration data
      cal_empirical_win_rate: cal ? Math.round(cal.empirical_win_rate * 10000) / 10000 : null,
      cal_n: cal ? cal.n : null,
      cal_true_edge: cal ? Math.round(cal.true_edge * 10000) / 10000 : null,
      cal_bucket: calBucket,
    };
  }

  /**
   * Evaluate NO side for a range.
   */
  _evaluateNo(city, dateStr, range, forecast) {
    const { ask, bid, spread } = range;

    // Need a valid bid to calculate NO price
    if (!bid || bid <= 0 || bid >= 1) return null;

    // NO probability = 1 - YES probability
    const yesProbability = this.forecast.calculateProbability(
      forecast.temp, forecast.stdDev,
      range.rangeMin, range.rangeMax,
      forecast.unit
    );
    const noProbability = Math.min(1, Math.max(0, 1 - yesProbability));

    // NO ask = 1 - YES bid
    const noAsk = 1 - bid;
    if (noAsk <= 0 || noAsk >= 1) return null;

    // Edge = our NO probability - NO ask
    const edgePct = (noProbability - noAsk) * 100;

    // Expected value after fees
    const entryFee = this.adapter.getEntryFee(range.platform, noAsk);
    const effectiveCost = noAsk + entryFee;
    const payout = 1.0;
    const ev = noProbability * payout - effectiveCost;

    // Kelly fraction: b = netProfit/effectiveCost (true net odds for prediction markets)
    const noNetProfit = payout - effectiveCost;
    const kellyFull = noProbability > 0 && noNetProfit > 0
      ? ((noNetProfit / effectiveCost) * noProbability - (1 - noProbability)) / (noNetProfit / effectiveCost)
      : 0;
    const kelly = Math.max(0, kellyFull * config.sizing.KELLY_FRACTION);

    // Determine action + filter reason
    const { action, filterReason } = this._applyFilters('NO', edgePct, spread, noAsk, 1 - ask, range, forecast.hoursToResolution);

    return {
      city,
      target_date: dateStr,
      platform: range.platform,
      market_id: range.marketId,
      token_id: range.tokenId,
      range_name: range.rangeName,
      range_min: range.rangeMin,
      range_max: range.rangeMax,
      range_type: range.rangeType,
      range_unit: range.rangeUnit || forecast.unit,
      side: 'NO',
      bid: 1 - ask,      // NO bid = 1 - YES ask
      ask: noAsk,         // NO ask = 1 - YES bid
      spread,
      volume: range.volume || 0,
      bid_depth: range.bid_depth || null,
      ask_depth: range.ask_depth || null,
      forecast_temp: forecast.temp,
      forecast_confidence: forecast.confidence,
      forecast_sources: forecast.sources,
      ensemble_temp: forecast.temp,
      ensemble_std_dev: forecast.stdDev,
      our_probability: Math.round(noProbability * 10000) / 10000,
      edge_pct: Math.round(edgePct * 100) / 100,
      expected_value: Math.round(ev * 10000) / 10000,
      kelly_fraction: Math.round(kelly * 10000) / 10000,
      action,
      filter_reason: filterReason,
      hours_to_resolution: forecast.hoursToResolution,
      range_width: (range.rangeMax != null && range.rangeMin != null)
        ? range.rangeMax - range.rangeMin : null,
      // Analysis flags
      would_pass_at_5pct: edgePct >= 5,
      would_pass_at_8pct: edgePct >= 8,
      would_pass_at_10pct: edgePct >= 10,
      would_pass_at_15pct: edgePct >= 15,
      // v1 filter comparison (NO trades only)
      old_filter_would_block: this._wouldV1Block(range, noProbability, noAsk),
      old_filter_reasons: this._getV1BlockReasons(range, noProbability, noAsk),
    };
  }

  /**
   * Apply entry filters. Returns { action, filterReason }.
   */
  _applyFilters(side, edgePct, spread, ask, bid, range, hoursToResolution) {
    const reasons = [];

    // Edge threshold
    if (edgePct < config.entry.MIN_EDGE_PCT) {
      reasons.push(`edge ${edgePct.toFixed(1)}% < ${config.entry.MIN_EDGE_PCT}%`);
    }

    // Spread cap (absolute)
    if (spread > config.entry.MAX_SPREAD) {
      reasons.push(`spread ${spread.toFixed(3)} > ${config.entry.MAX_SPREAD}`);
    }

    // Spread cap (relative) — spread shouldn't consume more than half the entry price
    if (ask > 0 && spread / ask > config.entry.MAX_SPREAD_PCT) {
      reasons.push(`spread_pct ${((spread / ask) * 100).toFixed(0)}% > ${config.entry.MAX_SPREAD_PCT * 100}%`);
    }

    // Price sanity
    if (ask <= 0) {
      reasons.push('ask <= 0');
    }
    // Side-specific price floors
    if (side === 'YES' && ask < config.entry.MIN_ASK_PRICE) {
      reasons.push(`ask_below_minimum (${(ask * 100).toFixed(1)}¢ < ${(config.entry.MIN_ASK_PRICE * 100).toFixed(0)}¢)`);
    }
    if (side === 'NO' && ask < config.entry.MIN_NO_ASK_PRICE) {
      reasons.push(`no_ask_below_minimum (${(ask * 100).toFixed(1)}¢ < ${(config.entry.MIN_NO_ASK_PRICE * 100).toFixed(0)}¢)`);
    }
    if (ask >= 0.97) {
      reasons.push(`ask ${ask.toFixed(2)} too high (>= 0.97)`);
    }

    // Hours-to-resolution filter — don't bet on already-known outcomes
    if (hoursToResolution == null) {
      reasons.push('hours_to_resolution_unknown');
    } else if (hoursToResolution === 0) {
      reasons.push('hours_to_resolution_zero');
    } else if (hoursToResolution < config.entry.MIN_HOURS_TO_RESOLUTION) {
      reasons.push(`too_close_to_resolution (${hoursToResolution.toFixed(1)}h < ${config.entry.MIN_HOURS_TO_RESOLUTION}h)`);
    }

    // Model vs market disagreement — reject if model probability > 3x market price
    // Temporary guardrail while calibration data is thin; genuine edge rarely exceeds 3x
    const ourProb = ask + edgePct / 100; // reconstruct probability from edge
    if (config.entry.MAX_MODEL_MARKET_RATIO && ask > 0.02 &&
        ourProb > config.entry.MAX_MODEL_MARKET_RATIO * ask) {
      reasons.push(`model_vs_market_divergence (model ${(ourProb * 100).toFixed(0)}% vs market ${(ask * 100).toFixed(0)}%)`);
    }

    // Volume check: hard block zero volume markets
    if (!range.volume || range.volume === 0) {
      reasons.push('zero_volume');
    }

    // Market calibration gate (YES-side only)
    if (side === 'YES' && this._calibration && this._calibration.size > 0 && hoursToResolution != null) {
      const cal = this._getCalibration(range.rangeType, hoursToResolution, ask);
      if (cal && cal.n >= 50 && cal.empirical_win_rate < ask) {
        reasons.push(
          `calibration_block (emp_win_rate ${(cal.empirical_win_rate * 100).toFixed(1)}% < ask ${(ask * 100).toFixed(0)}¢, n=${cal.n})`
        );
      }
    }

    if (reasons.length > 0) {
      return { action: 'filtered', filterReason: reasons.join('; ') };
    }

    return { action: 'entered', filterReason: null };
  }

  /**
   * Log opportunity to the database.
   */
  async _logOpportunity(opp) {
    try {
      const { data, error } = await db.from('opportunities').insert({
        city: opp.city,
        target_date: opp.target_date,
        platform: opp.platform,
        market_id: opp.market_id,
        range_name: opp.range_name,
        range_min: opp.range_min,
        range_max: opp.range_max,
        range_type: opp.range_type,
        range_unit: opp.range_unit,
        side: opp.side,
        bid: opp.bid,
        ask: opp.ask,
        spread: opp.spread,
        volume: opp.volume,
        forecast_temp: opp.forecast_temp,
        forecast_confidence: opp.forecast_confidence,
        forecast_sources: opp.forecast_sources,
        ensemble_temp: opp.ensemble_temp,
        ensemble_std_dev: opp.ensemble_std_dev,
        our_probability: opp.our_probability,
        edge_pct: opp.edge_pct,
        expected_value: opp.expected_value,
        kelly_fraction: opp.kelly_fraction,
        action: opp.action,
        filter_reason: opp.filter_reason,
        would_pass_at_5pct: opp.would_pass_at_5pct,
        would_pass_at_8pct: opp.would_pass_at_8pct,
        would_pass_at_10pct: opp.would_pass_at_10pct,
        would_pass_at_15pct: opp.would_pass_at_15pct,
        old_filter_would_block: opp.old_filter_would_block || null,
        old_filter_reasons: opp.old_filter_reasons || null,
        hours_to_resolution: opp.hours_to_resolution,
        range_width: opp.range_width,
        bid_depth: opp.bid_depth || null,
        ask_depth: opp.ask_depth || null,
        cal_empirical_win_rate: opp.cal_empirical_win_rate || null,
        cal_n: opp.cal_n || null,
        cal_true_edge: opp.cal_true_edge || null,
        cal_bucket: opp.cal_bucket || null,
      }).select('id').single();

      if (error) {
        this._log('warn', `Failed to log opportunity`, { city: opp.city, error: error.message });
        return null;
      }
      return data?.id || null;
    } catch (err) {
      this._log('error', `DB error logging opportunity`, { error: err.message });
      return null;
    }
  }

  /**
   * Three-tier logging: decides whether to log full row, skip, or accumulate summary.
   * Returns 'logged' | 'skipped' | 'accumulated'
   */
  async _tieredLog(opp) {
    const key = this._comboKey(opp);

    // Tier 1: ALWAYS log 'entered' trades (full row)
    if (opp.action === 'entered') {
      const oppId = await this._logOpportunity(opp);
      if (oppId) opp.opportunity_id = oppId;
      // Update dedup tracker
      this.lastLoggedEdge.set(key, { edge_pct: opp.edge_pct, date: this._lastLoggedDate });
      return 'logged';
    }

    // Tier 3: edge <= 5% → accumulate for daily summary
    if (opp.edge_pct <= 5) {
      this._accumulateSummary(key, opp);
      return 'accumulated';
    }

    // Tier 2: edge > 5% → dedup check (skip if edge changed < 1pp since last log)
    const last = this.lastLoggedEdge.get(key);
    if (last && last.date === this._lastLoggedDate && Math.abs(opp.edge_pct - last.edge_pct) < 1.0) {
      return 'skipped';
    }

    // Edge changed significantly or first time today → log full row
    const oppId = await this._logOpportunity(opp);
    if (oppId) opp.opportunity_id = oppId;
    this.lastLoggedEdge.set(key, { edge_pct: opp.edge_pct, date: this._lastLoggedDate });
    return 'logged';
  }

  _comboKey(opp) {
    return `${opp.city}:${opp.target_date}:${opp.range_name}:${opp.side}:${opp.platform}`;
  }

  _accumulateSummary(key, opp) {
    const existing = this.dailySummaries.get(key);
    if (existing) {
      existing.count++;
      existing.min_edge = Math.min(existing.min_edge, opp.edge_pct);
      existing.max_edge = Math.max(existing.max_edge, opp.edge_pct);
      existing.sum_edge += opp.edge_pct;
      existing.min_ask = Math.min(existing.min_ask, opp.ask);
      existing.max_ask = Math.max(existing.max_ask, opp.ask);
      existing.last_opp = opp; // keep latest for field values
    } else {
      this.dailySummaries.set(key, {
        count: 1,
        min_edge: opp.edge_pct,
        max_edge: opp.edge_pct,
        sum_edge: opp.edge_pct,
        min_ask: opp.ask,
        max_ask: opp.ask,
        last_opp: opp,
      });
    }
  }

  /**
   * Flush accumulated Tier 3 summaries to DB as action='summary' rows.
   */
  async _flushSummaries() {
    if (this.dailySummaries.size === 0) return;

    let flushed = 0;
    for (const [key, summary] of this.dailySummaries) {
      try {
        const opp = summary.last_opp;
        const avgEdge = Math.round((summary.sum_edge / summary.count) * 100) / 100;

        await db.from('opportunities').insert({
          city: opp.city,
          target_date: opp.target_date,
          platform: opp.platform,
          market_id: opp.market_id,
          range_name: opp.range_name,
          range_min: opp.range_min,
          range_max: opp.range_max,
          range_type: opp.range_type,
          range_unit: opp.range_unit,
          side: opp.side,
          bid: opp.bid,
          ask: opp.ask,
          spread: opp.spread,
          volume: opp.volume,
          forecast_temp: opp.forecast_temp,
          forecast_confidence: opp.forecast_confidence,
          forecast_sources: opp.forecast_sources,
          ensemble_temp: opp.ensemble_temp,
          ensemble_std_dev: opp.ensemble_std_dev,
          our_probability: opp.our_probability,
          edge_pct: avgEdge,
          expected_value: opp.expected_value,
          kelly_fraction: opp.kelly_fraction,
          action: 'summary',
          filter_reason: opp.filter_reason,
          hours_to_resolution: opp.hours_to_resolution,
          range_width: opp.range_width,
          summary_count: summary.count,
          min_edge_pct: summary.min_edge,
          max_edge_pct: summary.max_edge,
          bid_depth: opp.bid_depth || null,
          ask_depth: opp.ask_depth || null,
        });
        flushed++;
      } catch (err) {
        this._log('warn', `Summary flush failed for ${key}`, { error: err.message });
      }
    }

    this._log('info', `Flushed ${flushed} daily summaries (${this.dailySummaries.size} combos)`);
    this.dailySummaries.clear();
  }

  // ── Guaranteed-Win Entry Scanning ────────────────────────────────

  /**
   * Scan for risk-free entries where observations confirm threshold crossed.
   * Returns { entries: [...] } with approved guaranteed-win opportunities.
   */
  async scanGuaranteedWins() {
    if (!config.guaranteed_entry?.ENABLED) return { entries: [] };

    const entries = [];

    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
      const localToday = this._getLocalToday(cityConfig.tz);

      // Get latest observation for this city/today
      const obs = await this._getLatestObservation(cityKey, localToday);
      if (!obs) continue;

      // Get all markets for this city/today
      const ranges = await this.adapter.getMarkets(cityKey, localToday);
      if (!ranges || ranges.length === 0) continue;

      for (const range of ranges) {
        const high = cityConfig.unit === 'C' ? obs.running_high_c : obs.running_high_f;
        const wuHigh = cityConfig.unit === 'C' ? obs.wu_high_c : obs.wu_high_f;
        const requireDual = config.guaranteed_entry.REQUIRE_DUAL_CONFIRMATION;
        const wuAvailable = wuHigh != null;

        const signal = this._checkGuaranteedWin(range, high, wuHigh, requireDual, wuAvailable);
        if (!signal) continue;

        const ask = signal.side === 'YES' ? range.ask : (1 - range.bid);
        if (ask == null || ask <= 0 || ask >= 1) continue;

        // Config filters
        if (ask > config.guaranteed_entry.MAX_ASK) continue;
        if (ask < config.guaranteed_entry.MIN_ASK) continue;

        // Fee check
        const fee = this.adapter.getEntryFee(range.platform, ask);
        const margin = 1.00 - ask - fee;
        if (margin * 100 < config.guaranteed_entry.MIN_MARGIN_CENTS) continue;

        // Duplicate check (reuse Sets from scan())
        const posKey = `${cityKey}:${localToday}:${range.rangeName}:${signal.side}:${range.platform}`;
        if (this._positionKeys?.has(posKey)) continue;
        if (signal.side === 'YES' && this._openYesKeys?.has(`${cityKey}:${localToday}`)) continue;
        if (signal.side === 'NO' && this._openNoKeys?.has(`${cityKey}:${localToday}`)) continue;

        entries.push({
          city: cityKey,
          target_date: localToday,
          platform: range.platform,
          market_id: range.marketId,
          token_id: range.tokenId,
          range_name: range.rangeName,
          range_min: range.rangeMin,
          range_max: range.rangeMax,
          range_type: range.rangeType,
          range_unit: range.rangeUnit || cityConfig.unit,
          side: signal.side,
          ask,
          bid: signal.side === 'YES' ? range.bid : (1 - range.ask),
          spread: range.spread,
          volume: range.volume || 0,
          entry_reason: 'guaranteed_win',
          observation_high: high,
          wu_high: wuHigh,
          dual_confirmed: wuAvailable && wuHigh != null && this._bothCrossThreshold(signal, high, wuHigh),
          margin,
        });
      }
    }

    if (entries.length > 0) {
      this._log('info', `Guaranteed-win scan: ${entries.length} entries found`);
    }

    return { entries };
  }

  /**
   * Check if a range is a guaranteed win based on observation data.
   * Returns { side, type } or null if not guaranteed.
   */
  _checkGuaranteedWin(range, high, wuHigh, requireDual, wuAvailable) {
    if (high == null) return null;

    // Unbounded YES ("X or higher"): range_max is null, range_min exists
    // If running_high >= range_min, YES is guaranteed
    if (range.rangeMax == null && range.rangeMin != null) {
      if (high >= range.rangeMin) {
        // Dual confirmation: WU must also agree
        if (requireDual && wuAvailable && (wuHigh == null || wuHigh < range.rangeMin)) return null;
        return { side: 'YES', type: 'guaranteed_win_yes' };
      }
    }

    // Bounded range ("X-Y"): both range_min and range_max exist
    // If running_high > range_max, NO is guaranteed (temp already exceeded upper bound)
    if (range.rangeMin != null && range.rangeMax != null) {
      if (high > range.rangeMax) {
        // Dual confirmation: WU must also agree
        if (requireDual && wuAvailable && (wuHigh == null || wuHigh <= range.rangeMax)) return null;
        return { side: 'NO', type: 'guaranteed_win_no' };
      }
    }

    // Bounded YES is NEVER guaranteed (temp could climb out of range)
    // Unbounded lower YES is NEVER guaranteed by high alone
    return null;
  }

  /**
   * Check if both METAR and WU cross the same threshold for a given signal.
   */
  _bothCrossThreshold(signal, high, wuHigh) {
    if (signal.type === 'guaranteed_win_yes') {
      // Unbounded YES: both must be >= range_min (encoded in signal check already)
      return true; // If we got here, both passed the check in _checkGuaranteedWin
    }
    if (signal.type === 'guaranteed_win_no') {
      return true; // Same — both passed
    }
    return false;
  }

  /**
   * Get latest METAR observation for a city/date. Same pattern as monitor._getLatestObservation.
   */
  async _getLatestObservation(city, targetDate) {
    try {
      const { data, error } = await db
        .from('metar_observations')
        .select('running_high_c, running_high_f, wu_high_c, wu_high_f, temp_c, temp_f, observed_at, observation_count')
        .eq('city', city.toLowerCase())
        .eq('target_date', targetDate)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error || !data || data.length === 0) return null;
      return data[0];
    } catch {
      return null;
    }
  }

  /**
   * Get today's date in a city's local timezone.
   */
  _getLocalToday(timezone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  }

  _getLocalHour(timezone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    return parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  }

  /**
   * Check if v1 filters would have blocked a NO opportunity.
   * Used for tracker item 5.2 comparison.
   */
  _wouldV1Block(range, noProbability, noAsk) {
    const reasons = this._getV1BlockReasons(range, noProbability, noAsk);
    return reasons && reasons.length > 0;
  }

  _getV1BlockReasons(range, noProbability, noAsk) {
    const reasons = [];
    // v1 had distance-based filter (2°C threshold)
    // v1 had NO price > 0.50 filter
    if (noAsk > 0.50) reasons.push('no_price_too_high');
    // v1 required bounded ranges for NO
    if (range.rangeType === 'unbounded') reasons.push('unbounded_range');
    return reasons.length > 0 ? reasons : null;
  }

  /**
   * Find the range closest to the bias-corrected forecast temperature.
   * For bounded ranges: distance from midpoint. For unbounded: distance from boundary.
   * Returns the single closest range, or null if no ranges available.
   */
  _findClosestRange(ranges, forecast) {
    let closest = null;
    let minDist = Infinity;

    for (const range of ranges) {
      let reference;
      if (range.rangeMin != null && range.rangeMax != null) {
        // Bounded: use midpoint
        reference = (range.rangeMin + range.rangeMax) / 2;
      } else if (range.rangeMax == null && range.rangeMin != null) {
        // Unbounded upper ("X or higher"): use threshold
        reference = range.rangeMin;
      } else if (range.rangeMin == null && range.rangeMax != null) {
        // Unbounded lower ("X or below"): use threshold
        reference = range.rangeMax;
      } else {
        continue;
      }

      const dist = Math.abs(forecast.temp - reference);
      if (dist < minDist) {
        minDist = dist;
        closest = range;
      }
    }

    return closest;
  }

  /**
   * Get dates to scan: today through 15 days out, based on city's local timezone.
   */
  _getScanDates(timezone) {
    const dates = [];
    // Get "today" in the city's local timezone
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const localToday = formatter.format(new Date()); // YYYY-MM-DD (en-CA locale)

    const base = new Date(localToday + 'T12:00:00Z'); // noon UTC on local date
    for (let i = 0; i <= 15; i++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + i);
      dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
  }

  /**
   * Capture market snapshots for all active markets.
   * Called on snapshot interval (every 15 min).
   */
  async captureSnapshots() {
    let captured = 0;

    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
      const dates = this._getScanDates(cityConfig.tz).slice(0, 7); // Snapshots for next 7 days only
      for (const dateStr of dates) {
        try {
          const ranges = await this.adapter.getMarkets(cityKey, dateStr);
          if (!ranges || ranges.length === 0) continue;

          const forecast = await this.forecast.getForecast(cityKey, dateStr);

          const rangesData = ranges.map(r => ({
            name: r.rangeName,
            min: r.rangeMin,
            max: r.rangeMax,
            type: r.rangeType,
            platform: r.platform,
            bid: r.bid,
            ask: r.ask,
            spread: r.spread,
            volume: r.volume,
            liquidity: r.liquidity,
          }));

          // Collect depth data per range for snapshot
          const depthData = ranges
            .filter(r => r.bid_depth || r.ask_depth)
            .map(r => ({
              name: r.rangeName,
              platform: r.platform,
              bid_depth: r.bid_depth,
              ask_depth: r.ask_depth,
            }));

          const platforms = [...new Set(ranges.map(r => r.platform))];
          const { error } = await db.from('snapshots').insert({
            city: cityKey,
            target_date: dateStr,
            platform: platforms.length === 1 ? platforms[0] : 'both',
            ranges: rangesData,
            forecast_temp: forecast?.temp || null,
            forecast_confidence: forecast?.confidence || null,
            forecast_sources: forecast?.sources || null,
            depth_data: depthData.length > 0 ? depthData : null,
          });

          if (!error) {
            captured++;
            this._computeMarketImplied(rangesData, forecast, cityKey, dateStr);
          }
        } catch (err) {
          // Snapshot failures are non-critical
          this._log('warn', `Snapshot failed for ${cityKey} ${dateStr}`, { error: err.message });
        }
      }
    }

    this._log('info', `Snapshots captured: ${captured}`);
    return captured;
  }

  /**
   * Compute market-implied temperature distribution from range prices.
   * Fire-and-forget upsert to market_implied table.
   */
  _computeMarketImplied(rangesData, forecast, city, dateStr) {
    // Group by platform
    const byPlatform = {};
    for (const r of rangesData) {
      if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
      byPlatform[r.platform].push(r);
    }

    for (const [platform, ranges] of Object.entries(byPlatform)) {
      // Filter ranges with valid bid+ask
      const valid = ranges.filter(r => r.bid != null && r.ask != null && r.bid > 0);
      if (valid.length < 3) continue;

      // Compute mid prices and range references
      const entries = valid.map(r => {
        const midPrice = (r.bid + r.ask) / 2;
        let reference;
        if (r.min != null && r.max != null) reference = (r.min + r.max) / 2;
        else if (r.max == null && r.min != null) reference = r.min + 2;
        else if (r.min == null && r.max != null) reference = r.max - 2;
        else return null;
        return { midPrice, reference, name: r.name, min: r.min, max: r.max };
      }).filter(Boolean);

      if (entries.length < 3) continue;

      // Normalize to sum to 1.0
      const totalMid = entries.reduce((a, e) => a + e.midPrice, 0);
      if (totalMid <= 0) continue;

      entries.forEach(e => e.impliedProb = e.midPrice / totalMid);

      // Implied mean and std dev
      const impliedMean = entries.reduce((a, e) => a + e.impliedProb * e.reference, 0);
      const impliedVar = entries.reduce((a, e) => a + e.impliedProb * (e.reference - impliedMean) ** 2, 0);
      const impliedStd = Math.sqrt(impliedVar);

      // Implied median: find range where cumulative prob crosses 0.50
      const sorted = [...entries].sort((a, b) => a.reference - b.reference);
      let cumProb = 0;
      let impliedMedian = impliedMean;
      for (const e of sorted) {
        cumProb += e.impliedProb;
        if (cumProb >= 0.5) { impliedMedian = e.reference; break; }
      }

      const avgSpread = valid.reduce((a, r) => a + (r.ask - r.bid), 0) / valid.length;
      const meanDiv = forecast ? impliedMean - forecast.temp : null;

      // Upsert to market_implied (fire-and-forget)
      db.from('market_implied').upsert({
        city, target_date: dateStr, platform,
        implied_mean: Math.round(impliedMean * 100) / 100,
        implied_median: Math.round(impliedMedian * 100) / 100,
        implied_std_dev: Math.round(impliedStd * 100) / 100,
        ensemble_temp: forecast?.temp || null,
        ensemble_std_dev: forecast?.stdDev || null,
        mean_divergence: meanDiv != null ? Math.round(meanDiv * 100) / 100 : null,
        sum_implied_probs: Math.round(totalMid * 100) / 100,
        num_ranges: entries.length,
        avg_spread: Math.round(avgSpread * 1000) / 1000,
        range_data: entries.map(e => ({
          name: e.name, min: e.min, max: e.max,
          mid_price: Math.round(e.midPrice * 100) / 100,
          implied_prob: Math.round(e.impliedProb * 1000) / 1000,
        })),
      }, { onConflict: 'city,target_date,platform' }).then(() => {}).catch(() => {});
    }
  }
  // ── Market Calibration ─────────────────────────────────────────

  async _loadCalibration() {
    try {
      const { data, error } = await db.from('market_calibration').select('*');
      if (error) throw error;

      const map = new Map();
      for (const row of (data || [])) {
        const key = `${row.range_type}|${row.lead_time_bucket}|${row.price_bucket}`;
        map.set(key, row);
      }
      if (map.size > 0) {
        this._log('info', `Loaded ${map.size} calibration buckets`);
      }
      return map;
    } catch (err) {
      this._log('warn', 'Failed to load calibration table — proceeding without', { error: err.message });
      return new Map();
    }
  }

  _getCalibrationBuckets(rangeType, hoursToResolution, askPrice) {
    const leadBucket = hoursToResolution < 12 ? '<12h'
      : hoursToResolution < 24 ? '12-24h'
      : hoursToResolution < 36 ? '24-36h'
      : '36h+';

    const priceBucket = askPrice < 0.10 ? '0-10c'
      : askPrice < 0.15 ? '10-15c'
      : askPrice < 0.20 ? '15-20c'
      : askPrice < 0.25 ? '20-25c'
      : askPrice < 0.35 ? '25-35c'
      : '35c+';

    return { leadBucket, priceBucket };
  }

  _getCalibration(rangeType, hoursToResolution, askPrice) {
    if (!this._calibration || this._calibration.size === 0) return null;

    const { leadBucket, priceBucket } = this._getCalibrationBuckets(rangeType, hoursToResolution, askPrice);
    const key = `${rangeType}|${leadBucket}|${priceBucket}`;
    return this._calibration.get(key) || null;
  }
}

module.exports = Scanner;
