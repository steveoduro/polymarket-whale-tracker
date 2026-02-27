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
const { query, queryOne } = require('./db');
const peakHours = require('./peak-hours');

class Scanner {
  constructor(platformAdapter, forecastEngine, alerts) {
    this.adapter = platformAdapter;
    this.forecast = forecastEngine;
    this.alerts = alerts;
    this._missedAlerted = new Set(); // debounce: city_date_platform_rangeName_side — reset daily
    this._stalePlatformCount = {};   // city:platform → consecutive cycles with 0 markets
    this._stalePlatformAlerted = new Set(); // debounce: don't re-alert same city:platform
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
    let filtered = 0;
    let marketsScanned = 0;

    // Load existing trades for position-awareness (O(1) lookup)
    try {
      const { data: existingTrades } = await query(
        `SELECT city, target_date, range_name, range_min, side, platform, status
         FROM trades
         WHERE status IN ($1, $2, $3)`,
        ['open', 'exited', 'resolved']
      );

      this._positionKeys = new Set(
        (existingTrades || []).map(t => `${t.city}:${t.target_date}:${t.range_name}:${t.side}:${t.platform}`)
      );
      this._openYesKeys = new Set(
        (existingTrades || []).filter(t => t.side === 'YES' && t.status === 'open')
          .map(t => `${t.city}:${t.target_date}:${t.platform}`)
      );
      this._openNoKeys = new Set(
        (existingTrades || []).filter(t => t.side === 'NO' && t.status === 'open')
          .map(t => `${t.city}:${t.target_date}:${t.platform}`)
      );
      // Range-level dedup: block opposite-side entry on same range (can't win both legs)
      this._openRangeKeys = new Set(
        (existingTrades || []).filter(t => t.status === 'open')
          .map(t => `${t.city}:${t.target_date}:${t.range_name}:${t.platform}`)
      );
      // Adjacent-NO protection: map open YES trades to their range_min threshold
      this._openYesThreshold = new Map();
      for (const t of (existingTrades || []).filter(t => t.side === 'YES' && t.status === 'open' && t.range_min != null)) {
        this._openYesThreshold.set(`${t.city}:${t.target_date}:${t.platform}`, t.range_min);
      }
    } catch (err) {
      this._log('warn', 'Failed to load positions for dedup — falling through', { error: err.message });
      this._positionKeys = null;
      this._openYesKeys = null;
      this._openNoKeys = null;
      this._openRangeKeys = null;
      this._openYesThreshold = null;
    }

    // Load calibration data for historical win rate checks
    this._calibration = await this._loadCalibration();
    this._modelCalibration = await this._loadModelCalibration();
    this._marketImplied = await this._loadMarketImplied();

    const cityPlatformsSeen = {}; // city → Set of platforms that returned markets

    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
      cityPlatformsSeen[cityKey] = new Set();
      // City eligibility gate (Layer 1): check per city+platform (platform-aware MAE)
      const eligibilityCache = {};
      const getEligibility = async (platform) => {
        const key = platform || '_blended';
        if (!eligibilityCache[key]) {
          eligibilityCache[key] = await this.forecast.getCityEligibility(cityKey, platform || undefined);
        }
        return eligibilityCache[key];
      };

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
          // Get all ranges from all enabled platforms (check markets first to skip forecast API calls for inactive cities)
          const ranges = await this.adapter.getMarkets(cityKey, dateStr);
          if (!ranges || ranges.length === 0) continue;

          // Track which platforms returned markets for stale-scan detection
          for (const r of ranges) if (r.platform) cityPlatformsSeen[cityKey].add(r.platform);

          // Get forecast for this city/date
          const forecast = await this.forecast.getForecast(cityKey, dateStr);
          if (!forecast) continue;

          marketsScanned++;

          // ── YES: zone-targeted multi-candidate selection ──
          // Evaluate top candidates by corrected edge, pick best that passes all filters.
          const candidates = this._findYesCandidates(ranges, forecast, cityKey);
          let bestApproved = null;

          for (const range of candidates) {
            const isBounded = range.rangeType === 'bounded';
            const eligibility = await getEligibility(range.platform);
            let cityGateReason = null;
            if (!eligibility.allowUnbounded) {
              cityGateReason = `city_mae_too_high (${eligibility.mae}°${eligibility.unit} > threshold, n=${eligibility.n})`;
            } else if (isBounded && !eligibility.allowBounded) {
              cityGateReason = `city_mae_too_high_for_bounded (${eligibility.mae}°${eligibility.unit} > bounded threshold, n=${eligibility.n})`;
            }

            const yesOpp = this._evaluateYes(cityKey, dateStr, range, forecast);
            if (!yesOpp) continue;

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
                if (high != null && high >= forecast.temp && range.rangeMax != null && high >= range.rangeMax - buffer) {
                  yesOpp.action = 'filtered';
                  yesOpp.filter_reason = `obs_entry_gate (high ${high}° > forecast ${forecast.temp}° and ${(range.rangeMax - high).toFixed(1)}° from ceiling ${range.rangeMax}°, ${localHour}:00 local < cooling ${cityCooling}:00)`;
                  this._log('info', `OBS ENTRY GATE: ${cityKey} ${range.rangeName} YES blocked — high ${high}°${cityConfig.unit} > forecast ${forecast.temp}°, ${(range.rangeMax - high).toFixed(1)}° from ceiling ${range.rangeMax}°, ${localHour}:00 local`);
                }
              }
            }
            if (yesOpp.action === 'entered' && this._positionKeys) {
              const posKey = `${cityKey}:${dateStr}:${range.rangeName}:YES:${range.platform}`;
              const yesKey = `${cityKey}:${dateStr}:${range.platform}`;
              const rangeKey = `${cityKey}:${dateStr}:${range.rangeName}:${range.platform}`;
              if (this._positionKeys.has(posKey)) {
                yesOpp.action = 'filtered';
                yesOpp.filter_reason = 'existing_position';
              } else if (this._openYesKeys.has(yesKey)) {
                yesOpp.action = 'filtered';
                yesOpp.filter_reason = 'existing_yes_position';
              } else if (this._openRangeKeys?.has(rangeKey)) {
                yesOpp.action = 'filtered';
                yesOpp.filter_reason = 'opposite_side_open';
              }
            }

            // Track best passing candidate (pre-sorted, first to pass wins)
            if (yesOpp.action === 'entered' && !bestApproved) {
              // Kelly override: when calConfirmsEdge, use empirical_win_rate for sizing
              const calForKelly = (forecast.hoursToResolution != null)
                ? this._getCalibration(range.rangeType, forecast.hoursToResolution, yesOpp.ask, range.platform, cityKey) : null;
              const calMinEdge = config.calibration.CAL_MIN_TRADE_EDGE || 0.03;
              if (calForKelly && calForKelly.n >= config.calibration.CAL_CONFIRMS_MIN_N
                  && Number(calForKelly.true_edge) > 0
                  && (Number(calForKelly.empirical_win_rate) - yesOpp.ask) >= calMinEdge
                  && yesOpp.kelly_fraction <= 0) {
                const empRate = Number(calForKelly.empirical_win_rate);
                const entryFee = this.adapter.getEntryFee(range.platform, yesOpp.ask);
                const effCost = yesOpp.ask + entryFee;
                const netProf = 1.0 - effCost;
                const b = netProf / effCost;
                const kFull = (b * empRate - (1 - empRate)) / b;
                yesOpp.kelly_fraction = Math.round(Math.max(0, kFull * config.sizing.KELLY_FRACTION) * 10000) / 10000;
              }
              bestApproved = yesOpp;
            } else if (yesOpp.action === 'entered' && bestApproved) {
              yesOpp.action = 'filtered';
              yesOpp.filter_reason = 'better_candidate_selected';
            }

            // Log every candidate
            const result = await this._tieredLog(yesOpp);
            if (result === 'logged') logged++;
            if (yesOpp.action !== 'entered') filtered++;
          }

          if (bestApproved) approved.push(bestApproved);

          // ── NO: evaluate all ranges, pick best per city/date ──
          const noOpps = [];
          for (const range of ranges) {
            const isBounded = range.rangeType === 'bounded';
            const eligibility = await getEligibility(range.platform);
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
                const rangeKey = `${cityKey}:${dateStr}:${range.rangeName}:${range.platform}`;
                if (this._positionKeys.has(posKey)) {
                  noOpp.action = 'filtered';
                  noOpp.filter_reason = 'existing_position';
                } else if (this._openNoKeys?.has(`${cityKey}:${dateStr}:${range.platform}`)) {
                  noOpp.action = 'filtered';
                  noOpp.filter_reason = 'existing_no_position';
                } else if (this._openRangeKeys?.has(rangeKey)) {
                  noOpp.action = 'filtered';
                  noOpp.filter_reason = 'opposite_side_open';
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
      approved: approved.length,
      filtered,
    });

    // ── Stale platform detection ──
    // Check if any city has a configured series/slug but returned 0 markets
    const PA = require('./platform-adapter');
    const KALSHI_SERIES = PA._KALSHI_SERIES || {};
    const PM_CITY_SLUGS = PA._PM_CITY_SLUGS || {};
    const STALE_THRESHOLD = 12; // 12 consecutive cycles (≈1 hour at 5-min intervals)
    for (const cityKey of Object.keys(config.cities)) {
      const seen = cityPlatformsSeen[cityKey] || new Set();
      for (const [platform, hasConfig] of [['kalshi', !!KALSHI_SERIES[cityKey]], ['polymarket', !!PM_CITY_SLUGS[cityKey]]]) {
        if (!hasConfig) continue;
        const key = `${cityKey}:${platform}`;
        if (seen.has(platform)) {
          this._stalePlatformCount[key] = 0;
        } else {
          this._stalePlatformCount[key] = (this._stalePlatformCount[key] || 0) + 1;
          if (this._stalePlatformCount[key] >= STALE_THRESHOLD && !this._stalePlatformAlerted.has(key)) {
            this._stalePlatformAlerted.add(key);
            const msg = `⚠️ STALE PLATFORM: ${cityKey} has returned 0 ${platform} markets for ${this._stalePlatformCount[key]} consecutive cycles. Series ticker may be dead.`;
            this._log('warn', msg);
            if (this.alerts) this.alerts.sendNow(msg);
          }
        }
      }
    }

    return { opportunities: approved, logged, filtered, marketsScanned };
  }

  /**
   * Evaluate YES side for a range.
   */
  _evaluateYes(city, dateStr, range, forecast) {
    const { ask, bid, spread } = range;

    // Sanity: need a valid ask price
    if (!ask || ask <= 0 || ask >= 1) return null;

    // Platform-specific forecast adjustments for Kalshi
    const isKalshi = range.platform === 'kalshi';
    const fTemp = (isKalshi && forecast.kalshiTemp != null) ? forecast.kalshiTemp : forecast.temp;
    const kalshiMult = config.platforms?.kalshi?.STD_DEV_MULTIPLIER || 1.0;
    const fStdDev = isKalshi ? forecast.stdDev * kalshiMult : forecast.stdDev;

    // Calculate raw probability that temp falls in this range
    const rawProbability = this.forecast.calculateProbability(
      fTemp, fStdDev,
      range.rangeMin, range.rangeMax,
      forecast.unit, city
    );

    // Apply model calibration correction
    const modelCal = this._getModelCalibration(range.rangeType, rawProbability, city);
    const rawRatio = (modelCal && modelCal.n >= 30) ? Number(modelCal.correction_ratio) : 1.0;
    const correctionRatio = Number.isFinite(rawRatio) ? rawRatio : 1.0;
    const correctedProbability = Math.min(1, Math.max(0, rawProbability * correctionRatio));

    // Edge uses corrected probability
    const edgePct = (correctedProbability - ask) * 100;

    // Expected value after fees
    const entryFee = this.adapter.getEntryFee(range.platform, ask);
    const effectiveCost = ask + entryFee;
    const payout = 1.0;
    const ev = correctedProbability * payout - effectiveCost;

    // Kelly fraction using corrected probability
    const netProfit = payout - effectiveCost;
    const kellyFull = correctedProbability > 0 && netProfit > 0
      ? ((netProfit / effectiveCost) * correctedProbability - (1 - correctedProbability)) / (netProfit / effectiveCost)
      : 0;
    const kelly = Math.max(0, kellyFull * config.sizing.KELLY_FRACTION);

    // Determine action + filter reason
    const { action, filterReason } = this._applyFilters('YES', edgePct, spread, ask, bid, range, forecast.hoursToResolution, forecast, city, dateStr);

    // Derive entry_reason for trade logging
    const entryReason = action === 'entered'
      ? (edgePct < config.entry.MIN_EDGE_PCT ? 'cal_confirms' : 'edge')
      : null;

    // Calibration lookup for logging
    const cal = (forecast.hoursToResolution != null)
      ? this._getCalibration(range.rangeType, forecast.hoursToResolution, ask, range.platform, city)
      : null;
    let calBucket = null;
    if (cal && forecast.hoursToResolution != null) {
      const { leadBucket, priceBucket } = this._getCalibrationBuckets(range.rangeType, forecast.hoursToResolution, ask);
      calBucket = cal.city
        ? `${range.platform}|${range.rangeType}|${leadBucket}|${priceBucket}|${cal.city}`
        : `${range.platform}|${range.rangeType}|${leadBucket}|${priceBucket}`;
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
      forecast_temp: fTemp,
      forecast_confidence: forecast.confidence,
      forecast_sources: forecast.sources,
      ensemble_temp: forecast.temp,
      ensemble_std_dev: fStdDev,
      our_probability: Math.round(rawProbability * 10000) / 10000,
      corrected_probability: Math.round(correctedProbability * 10000) / 10000,
      correction_ratio: Math.round(correctionRatio * 1000) / 1000,
      edge_pct: Math.round(edgePct * 100) / 100,
      expected_value: Math.round(ev * 10000) / 10000,
      kelly_fraction: Math.round(kelly * 10000) / 10000,
      action,
      filter_reason: filterReason,
      entry_reason: entryReason,
      hours_to_resolution: forecast.hoursToResolution,
      range_width: (range.rangeMax != null && range.rangeMin != null)
        ? range.rangeMax - range.rangeMin : null,
      // ML features
      forecast_to_near_edge: this._forecastToNearEdge(forecast.temp, range.rangeMin, range.rangeMax),
      forecast_to_far_edge: this._forecastToFarEdge(forecast.temp, range.rangeMin, range.rangeMax),
      forecast_in_range: this._forecastInRange(forecast.temp, range.rangeMin, range.rangeMax),
      source_disagreement_deg: this._sourceDisagreement(forecast.sources),
      market_implied_divergence: this._marketImpliedDivergence(city, dateStr),
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

    // Platform-specific forecast adjustments for Kalshi
    const isKalshi = range.platform === 'kalshi';
    const fTemp = (isKalshi && forecast.kalshiTemp != null) ? forecast.kalshiTemp : forecast.temp;
    const kalshiMult = config.platforms?.kalshi?.STD_DEV_MULTIPLIER || 1.0;
    const fStdDev = isKalshi ? forecast.stdDev * kalshiMult : forecast.stdDev;

    // NO probability = 1 - YES probability
    const yesProbability = this.forecast.calculateProbability(
      fTemp, fStdDev,
      range.rangeMin, range.rangeMax,
      forecast.unit, city
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
    const { action, filterReason } = this._applyFilters('NO', edgePct, spread, noAsk, 1 - ask, range, forecast.hoursToResolution, forecast, city, dateStr);

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
      forecast_temp: fTemp,
      forecast_confidence: forecast.confidence,
      forecast_sources: forecast.sources,
      ensemble_temp: forecast.temp,
      ensemble_std_dev: fStdDev,
      our_probability: Math.round(noProbability * 10000) / 10000,
      edge_pct: Math.round(edgePct * 100) / 100,
      expected_value: Math.round(ev * 10000) / 10000,
      kelly_fraction: Math.round(kelly * 10000) / 10000,
      action,
      filter_reason: filterReason,
      entry_reason: action === 'entered' ? 'edge' : null,
      hours_to_resolution: forecast.hoursToResolution,
      range_width: (range.rangeMax != null && range.rangeMin != null)
        ? range.rangeMax - range.rangeMin : null,
      // ML features
      forecast_to_near_edge: this._forecastToNearEdge(forecast.temp, range.rangeMin, range.rangeMax),
      forecast_to_far_edge: this._forecastToFarEdge(forecast.temp, range.rangeMin, range.rangeMax),
      forecast_in_range: this._forecastInRange(forecast.temp, range.rangeMin, range.rangeMax),
      source_disagreement_deg: this._sourceDisagreement(forecast.sources),
      market_implied_divergence: this._marketImpliedDivergence(city, dateStr),
    };
  }

  // ── ML Feature Helpers ─────────────────────────────────────────────

  /**
   * Signed distance from ensemble_temp to the closer range boundary.
   * Positive = forecast outside range on that side, negative = inside.
   * For unbounded: distance to the single boundary.
   */
  _forecastToNearEdge(temp, rangeMin, rangeMax) {
    if (temp == null) return null;
    const r = v => Math.round(v * 10000) / 10000;
    if (rangeMin != null && rangeMax != null) {
      // Bounded: nearest boundary
      const dMin = temp - rangeMin;  // positive = above min
      const dMax = rangeMax - temp;  // positive = below max
      // If inside range, both are positive — near edge is the smaller (as negative to indicate "inside")
      // If outside range, one is negative — that's the near edge
      if (dMin < 0) return r(dMin);     // below range_min
      if (dMax < 0) return r(-dMax);    // above range_max (flip sign: positive = distance TO boundary)
      return r(-Math.min(dMin, dMax));  // inside range, negative = how far past the nearer edge
    }
    if (rangeMin != null && rangeMax == null) {
      // Unbounded upper ("X or higher"): distance to rangeMin
      return r(temp - rangeMin);
    }
    if (rangeMin == null && rangeMax != null) {
      // Unbounded lower ("X or below"): distance to rangeMax
      return r(rangeMax - temp);
    }
    return null;
  }

  /**
   * Signed distance from ensemble_temp to the farther range boundary.
   * Null for unbounded ranges (only one boundary).
   */
  _forecastToFarEdge(temp, rangeMin, rangeMax) {
    if (temp == null || rangeMin == null || rangeMax == null) return null;
    const r = v => Math.round(v * 10000) / 10000;
    const dMin = temp - rangeMin;
    const dMax = rangeMax - temp;
    if (dMin < 0) return r(rangeMax - temp);   // below range: far edge is rangeMax
    if (dMax < 0) return r(temp - rangeMin);   // above range: far edge is rangeMin (positive = far)
    return r(Math.max(dMin, dMax));            // inside: farther boundary distance
  }

  /**
   * True if ensemble_temp falls within the range bounds.
   */
  _forecastInRange(temp, rangeMin, rangeMax) {
    if (temp == null) return null;
    if (rangeMin != null && rangeMax != null) return temp >= rangeMin && temp <= rangeMax;
    if (rangeMin != null && rangeMax == null) return temp >= rangeMin;   // unbounded upper
    if (rangeMin == null && rangeMax != null) return temp <= rangeMax;   // unbounded lower
    return null;
  }

  /**
   * Standard deviation across individual forecast source temps.
   * Null if fewer than 2 non-null finite sources.
   */
  _sourceDisagreement(sources) {
    if (!sources || typeof sources !== 'object') return null;
    const vals = Object.values(sources).filter(v => Number.isFinite(v));
    if (vals.length < 2) return null;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    return Math.round(Math.sqrt(variance) * 1000) / 1000;
  }

  /**
   * market_implied mean_divergence for this city/date.
   * Uses the same key format as _applyFilters: `${city}|${dateStr}`.
   */
  _marketImpliedDivergence(city, dateStr) {
    if (!this._marketImplied) return null;
    const mi = this._marketImplied.get(`${city}|${dateStr}`);
    if (!mi || mi.mean_divergence == null) return null;
    return Math.round(mi.mean_divergence * 1000) / 1000;
  }

  /**
   * Compute max-min spread across forecast sources.
   * Returns null if insufficient source data.
   */
  _getEnsembleSpread(forecast) {
    if (!forecast.sources || typeof forecast.sources !== 'object') return null;
    const temps = Object.values(forecast.sources).filter(v => v != null && !isNaN(v));
    if (temps.length < 2) return null;
    return Math.max(...temps) - Math.min(...temps);
  }

  /**
   * Apply entry filters. Returns { action, filterReason }.
   */
  _applyFilters(side, edgePct, spread, ask, bid, range, hoursToResolution, forecast, city, targetDate) {
    const reasons = [];

    // Platform trading disabled — still log opportunity, but don't approve
    if (config.platforms[range.platform]?.tradingEnabled === false) {
      reasons.push('platform_trading_disabled');
    }

    // Kalshi city-level block — NWS forecast too unreliable for this city
    if (range.platform === 'kalshi' && config.cities[city]?.kalshiBlocked) {
      reasons.push('kalshi_city_blocked');
    }

    // Ensemble spread gate: block when sources disagree too much
    if (forecast) {
      const ensembleSpread = this._getEnsembleSpread(forecast);
      const maxSpread = forecast.unit === 'C'
        ? (config.entry.MAX_ENSEMBLE_SPREAD_C || 4.0)
        : (config.entry.MAX_ENSEMBLE_SPREAD_F || 7.0);
      if (ensembleSpread != null && ensembleSpread > maxSpread) {
        reasons.push(`ensemble_spread_too_high (${ensembleSpread.toFixed(1)}°${forecast.unit} > ${maxSpread}°${forecast.unit})`);
      }
    }

    // Market divergence gate (YES only): block when our forecast disagrees with market-implied temp
    if (side === 'YES' && config.entry.MAX_MARKET_DIVERGENCE_C && this._marketImplied && targetDate) {
      const miKey = `${city}|${targetDate}`;
      const mi = this._marketImplied.get(miKey);
      if (mi && mi.mean_divergence != null) {
        const cityUnit = config.cities[city]?.unit || 'F';
        const divC = cityUnit === 'C' ? Math.abs(mi.mean_divergence) : Math.abs(mi.mean_divergence) * (5 / 9);
        if (divC > config.entry.MAX_MARKET_DIVERGENCE_C) {
          reasons.push(`market_divergence (${divC.toFixed(1)}°C > ${config.entry.MAX_MARKET_DIVERGENCE_C}°C)`);
        }
      }
    }

    // Std dev vs range width gate: block bounded trades where forecast uncertainty dwarfs the target
    if (side === 'YES' && range.rangeType === 'bounded' &&
        range.rangeMax != null && range.rangeMin != null && forecast?.stdDev != null) {
      const rangeWidth = range.rangeMax - range.rangeMin;
      if (rangeWidth > 0) {
        const stdDevInUnit = forecast.unit === 'C'
          ? forecast.stdDev
          : forecast.stdDev * (9 / 5);
        const ratio = stdDevInUnit / rangeWidth;
        const maxRatio = config.entry.MAX_STD_RANGE_RATIO || 2.0;
        if (ratio > maxRatio) {
          reasons.push(`std_dev_vs_range (${stdDevInUnit.toFixed(1)}°${forecast.unit} std / ${rangeWidth.toFixed(1)}° range = ${ratio.toFixed(1)}x > ${maxRatio}x)`);
        }
      }
    }

    // Determine if market calibration confirms positive edge (YES-side only)
    const cal = (side === 'YES' && hoursToResolution != null)
      ? this._getCalibration(range.rangeType, hoursToResolution, ask, range.platform, city) : null;
    const CAL_MIN_TRADE_EDGE = config.calibration.CAL_MIN_TRADE_EDGE || 0.03;
    let calConfirmsEdge = cal && cal.n >= config.calibration.CAL_CONFIRMS_MIN_N
      && Number(cal.true_edge) > 0
      && (Number(cal.empirical_win_rate) - ask) >= CAL_MIN_TRADE_EDGE
      && edgePct >= 0;

    // Edge threshold — bypassed when market calibration confirms positive edge
    if (!calConfirmsEdge && edgePct < config.entry.MIN_EDGE_PCT) {
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
    if (side === 'NO' && config.entry.MAX_NO_ASK_PRICE && ask > config.entry.MAX_NO_ASK_PRICE) {
      reasons.push(`no_ask_above_maximum (${(ask * 100).toFixed(1)}¢ > ${(config.entry.MAX_NO_ASK_PRICE * 100).toFixed(0)}¢)`);
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

    // Model vs market disagreement — bypassed when market calibration confirms positive edge
    const ourProb = ask + edgePct / 100;
    if (!calConfirmsEdge && config.entry.MAX_MODEL_MARKET_RATIO && ask > 0.02 &&
        ourProb > config.entry.MAX_MODEL_MARKET_RATIO * ask) {
      reasons.push(`model_vs_market_divergence (model ${(ourProb * 100).toFixed(0)}% vs market ${(ask * 100).toFixed(0)}%)`);
    }

    // Volume check: hard block zero volume markets
    if (!range.volume || range.volume === 0) {
      reasons.push('zero_volume');
    }

    // Market calibration gate (YES-side only) — blocks negative-edge buckets
    if (cal && cal.n >= config.calibration.CAL_BLOCKS_MIN_N && Number(cal.empirical_win_rate) < ask) {
      reasons.push(
        `calibration_block (emp_win_rate ${(Number(cal.empirical_win_rate) * 100).toFixed(1)}% < ask ${(ask * 100).toFixed(0)}¢, n=${cal.n})`
      );
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
      const { data, error } = await queryOne(
        `INSERT INTO opportunities (
          city, target_date, platform, market_id, range_name, range_min, range_max,
          range_type, range_unit, side, bid, ask, spread, volume,
          forecast_temp, forecast_confidence, forecast_sources,
          ensemble_temp, ensemble_std_dev, our_probability, edge_pct,
          expected_value, kelly_fraction, action, filter_reason,
          hours_to_resolution, range_width,
          bid_depth, ask_depth,
          cal_empirical_win_rate, cal_n, cal_true_edge, cal_bucket,
          corrected_probability, correction_ratio,
          forecast_to_near_edge, forecast_to_far_edge, forecast_in_range,
          source_disagreement_deg, market_implied_divergence
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24, $25,
          $26, $27,
          $28, $29,
          $30, $31, $32, $33,
          $34, $35,
          $36, $37, $38,
          $39, $40
        ) RETURNING id`,
        [
          opp.city,                                    // $1
          opp.target_date,                             // $2
          opp.platform,                                // $3
          opp.market_id,                               // $4
          opp.range_name,                              // $5
          opp.range_min,                               // $6
          opp.range_max,                               // $7
          opp.range_type,                              // $8
          opp.range_unit,                              // $9
          opp.side,                                    // $10
          opp.bid,                                     // $11
          opp.ask,                                     // $12
          opp.spread,                                  // $13
          opp.volume,                                  // $14
          opp.forecast_temp,                           // $15
          opp.forecast_confidence,                     // $16
          JSON.stringify(opp.forecast_sources),         // $17 (jsonb)
          opp.ensemble_temp,                           // $18
          opp.ensemble_std_dev,                        // $19
          opp.our_probability,                         // $20
          opp.edge_pct,                                // $21
          opp.expected_value,                          // $22
          opp.kelly_fraction,                          // $23
          opp.action,                                  // $24
          opp.filter_reason,                           // $25
          opp.hours_to_resolution,                     // $26
          opp.range_width,                             // $27
          opp.bid_depth ? JSON.stringify(opp.bid_depth) : null,   // $28 (jsonb)
          opp.ask_depth ? JSON.stringify(opp.ask_depth) : null,   // $29 (jsonb)
          opp.cal_empirical_win_rate || null,          // $30
          opp.cal_n || null,                           // $31
          opp.cal_true_edge || null,                   // $32
          opp.cal_bucket || null,                      // $33
          opp.corrected_probability || null,           // $34
          opp.correction_ratio || null,                // $35
          opp.forecast_to_near_edge ?? null,           // $36
          opp.forecast_to_far_edge ?? null,            // $37
          opp.forecast_in_range ?? null,               // $38
          opp.source_disagreement_deg ?? null,         // $39
          opp.market_implied_divergence ?? null,       // $40
        ]
      );

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
   * Log opportunity to DB. Every evaluation gets a full row.
   * Calibration deduplication happens at query time in resolver.js.
   */
  async _tieredLog(opp) {
    const oppId = await this._logOpportunity(opp);
    if (oppId) opp.opportunity_id = oppId;
    return 'logged';
  }

  // ── Guaranteed-Win Entry Scanning ────────────────────────────────

  /**
   * Scan for risk-free entries where observations confirm threshold crossed.
   * Returns { entries: [...] } with approved guaranteed-win opportunities.
   */
  async scanGuaranteedWins() {
    if (!config.guaranteed_entry?.ENABLED) return { entries: [], missed: [] };

    const entries = [];
    const missed = [];

    // Batch load wu_triggered flags from metar_pending_events
    const wuTriggeredSet = new Set(); // "city|date|platform|rangeName|side"
    try {
      const { data: wuRows } = await query(
        `SELECT city, target_date, platform, range_name, side
         FROM metar_pending_events WHERE wu_triggered = true`
      );
      for (const row of (wuRows || [])) {
        wuTriggeredSet.add(`${row.city}|${row.target_date}|${row.platform}|${row.range_name}|${row.side}`);
      }
    } catch (err) {
      this._log('warn', 'GW scan: failed to load wu_triggered flags', { error: err.message });
    }

    // Gate: only enter ranges where METAR confirmed boundary crossing today
    // Prevents price-drift re-entries on stale crossings. Fails open if query errors.
    const activePendingSet = new Set(); // "city|date|platform|rangeName|side"
    try {
      const { data: pendingRows } = await query(
        `SELECT city, target_date, platform, range_name, side
         FROM metar_pending_events
         WHERE target_date >= CURRENT_DATE - INTERVAL '1 day'`
      );
      for (const row of (pendingRows || [])) {
        activePendingSet.add(`${row.city}|${row.target_date}|${row.platform}|${row.range_name}|${row.side}`);
      }
    } catch (err) {
      this._log('warn', 'GW scan: failed to load pending events — proceeding without gate', { error: err.message });
    }

    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
      const localToday = this._getLocalToday(cityConfig.tz);

      // Dual-station cities: load per-station observations to avoid cross-station contamination
      const isDualStation = cityConfig.nwsStation && cityConfig.polymarketStation
        && cityConfig.nwsStation !== cityConfig.polymarketStation;
      const obsMap = new Map(); // platform → obs
      if (isDualStation) {
        const pmObs = await this._getLatestObservation(cityKey, localToday, cityConfig.polymarketStation);
        const klObs = await this._getLatestObservation(cityKey, localToday, cityConfig.nwsStation);
        if (pmObs) obsMap.set('polymarket', pmObs);
        if (klObs) obsMap.set('kalshi', klObs);
        if (obsMap.size === 0) continue;
      } else {
        const obs = await this._getLatestObservation(cityKey, localToday);
        if (!obs) continue;
        obsMap.set('polymarket', obs);
        obsMap.set('kalshi', obs);
      }

      // Get all markets for this city/today
      const ranges = await this.adapter.getMarkets(cityKey, localToday);
      if (!ranges || ranges.length === 0) continue;

      for (const range of ranges) {
        // Skip platforms with trading disabled
        if (config.platforms[range.platform]?.guaranteedWinEnabled === false) continue;

        // Skip ranges already held — no alert, no missed entry
        if (this._positionKeys) {
          const hasYesPos = this._positionKeys.has(`${cityKey}:${localToday}:${range.rangeName}:YES:${range.platform}`);
          const hasNoPos  = this._positionKeys.has(`${cityKey}:${localToday}:${range.rangeName}:NO:${range.platform}`);
          if (hasYesPos || hasNoPos) continue;
        }

        // Gate: only enter if METAR confirmed a boundary crossing (prevents price-drift re-entries)
        if (activePendingSet.size > 0) {
          const hasYes = activePendingSet.has(`${cityKey}|${localToday}|${range.platform}|${range.rangeName}|YES`);
          const hasNo  = activePendingSet.has(`${cityKey}|${localToday}|${range.platform}|${range.rangeName}|NO`);
          if (!hasYes && !hasNo) continue;
        }

        // Use the correct station's observation for this platform
        const obs = obsMap.get(range.platform);
        if (!obs) continue;

        const runHigh = cityConfig.unit === 'C' ? obs.running_high_c : obs.running_high_f;
        const wuHigh = cityConfig.unit === 'C' ? obs.wu_high_c : obs.wu_high_f;
        const requireDual = config.guaranteed_entry.REQUIRE_DUAL_CONFIRMATION;

        // Platform-aware primary source
        const isPolymarket = range.platform === 'polymarket';
        let primaryHigh, confirmHigh, confirmAvailable;
        if (!requireDual) {
          // METAR-first mode: METAR triggers, WU is optional confirmation
          if (runHigh == null) continue;
          primaryHigh = runHigh;
          confirmHigh = wuHigh;
          confirmAvailable = wuHigh != null;
        } else if (isPolymarket) {
          // Original dual-confirm mode: WU-primary for Polymarket
          if (wuHigh == null) continue;
          primaryHigh = wuHigh;
          confirmHigh = runHigh;
          confirmAvailable = runHigh != null;
        } else {
          primaryHigh = runHigh;
          confirmHigh = wuHigh;
          confirmAvailable = wuHigh != null;
        }

        // Check if signal passes without dual confirmation to detect single-source candidates
        const signalNoDual = this._checkGuaranteedWin(range, primaryHigh, confirmHigh, false, confirmAvailable);
        const signal = this._checkGuaranteedWin(range, primaryHigh, confirmHigh, requireDual, confirmAvailable);

        // Track single-source detections that dual confirmation blocked
        if (!signal && signalNoDual && requireDual) {
          const singleAsk = signalNoDual.side === 'YES' ? range.ask : (1 - range.bid);
          missed.push({
            city: cityKey,
            target_date: localToday,
            platform: range.platform,
            range_name: range.rangeName,
            side: signalNoDual.side,
            ask: singleAsk,
            observation_high: runHigh,
            wu_high: wuHigh,
            unit: cityConfig.unit,
            reason: 'single_source_only',
          });
          continue;
        }

        if (!signal) continue;

        const ask = signal.side === 'YES' ? range.ask : (1 - range.bid);
        if (ask == null || ask <= 0) continue;  // ask >= 1 flows to MAX_ASK filter → missed[]

        // Market sanity: bid must be meaningful (prevents entering when market disagrees with signal)
        const bid = signal.side === 'YES' ? range.bid : (1 - range.ask);
        const gwMinBid = config.guaranteed_entry.GW_MIN_BID || 0.10;
        if (bid < gwMinBid) {
          missed.push({
            city: cityKey, target_date: localToday, platform: range.platform,
            range_name: range.rangeName, side: signal.side, ask,
            observation_high: runHigh, wu_high: wuHigh, unit: cityConfig.unit,
            reason: 'below_min_bid', bid: Math.round(bid * 100), minBid: Math.round(gwMinBid * 100),
          });
          continue;
        }

        const dualConfirmed = confirmAvailable && confirmHigh != null && this._bothCrossThreshold(signal, primaryHigh, confirmHigh, range);

        // Gap check: always required for Kalshi (WU reads same station as METAR,
        // doesn't reduce KLGA→KNYC divergence risk). For Polymarket: only when not dual confirmed.
        const isKalshi = range.platform === 'kalshi';
        if (!dualConfirmed || isKalshi) {
          const threshold = signal.type === 'guaranteed_win_yes' ? range.rangeMin : range.rangeMax;
          // Dual-station cities (e.g. NYC KLGA≠KNYC, Chicago KORD≠KMDW) need wider Kalshi gap
          const isDualStation = isKalshi && cityConfig.nwsStation && cityConfig.polymarketStation
            && cityConfig.nwsStation !== cityConfig.polymarketStation;
          const minGap = isDualStation
            ? (cityConfig.unit === 'C' ? 0.8 : 1.5)
            : (cityConfig.unit === 'C' ? config.guaranteed_entry.METAR_ONLY_MIN_GAP_C : config.guaranteed_entry.METAR_ONLY_MIN_GAP_F);
          const gap = primaryHigh - threshold;
          if (gap < minGap) {
            missed.push({
              city: cityKey, target_date: localToday, platform: range.platform,
              range_name: range.rangeName, side: signal.side, ask,
              observation_high: runHigh, wu_high: wuHigh, unit: cityConfig.unit,
              dual_confirmed: dualConfirmed,
              reason: 'below_metar_gap', gap: Math.round(gap * 10) / 10, minGap,
            });
            continue;
          }
        }

        // Config filters — track missed with reason
        // Only alert for near-misses (ask < 1.0) — fully repriced markets ($1) are noise
        if (ask > config.guaranteed_entry.MAX_ASK) {
          if (ask < 1.0) {
            missed.push({
              city: cityKey, target_date: localToday, platform: range.platform,
              range_name: range.rangeName, side: signal.side, ask,
              observation_high: runHigh, wu_high: wuHigh, unit: cityConfig.unit,
              dual_confirmed: dualConfirmed,
              reason: 'above_max_ask', maxAsk: config.guaranteed_entry.MAX_ASK,
            });
          }
          continue;
        }

        const minAsk = dualConfirmed
          ? (config.guaranteed_entry.MIN_ASK_DUAL_CONFIRMED || config.guaranteed_entry.MIN_ASK)
          : config.guaranteed_entry.MIN_ASK;
        if (ask < minAsk) {
          missed.push({
            city: cityKey, target_date: localToday, platform: range.platform,
            range_name: range.rangeName, side: signal.side, ask,
            observation_high: runHigh, wu_high: wuHigh, unit: cityConfig.unit,
            dual_confirmed: dualConfirmed,
            reason: 'below_min_ask', minAsk,
          });
          continue;
        }

        // Fee check
        const fee = this.adapter.getEntryFee(range.platform, ask);
        const margin = 1.00 - ask - fee;
        if (margin * 100 < config.guaranteed_entry.MIN_MARGIN_CENTS) continue;

        // Duplicate check (reuse Sets from scan())
        const posKey = `${cityKey}:${localToday}:${range.rangeName}:${signal.side}:${range.platform}`;
        if (this._positionKeys?.has(posKey)) continue;
        if (signal.side === 'YES' && this._openYesKeys?.has(`${cityKey}:${localToday}:${range.platform}`)) continue;
        // NO mutual exclusivity removed for GW — multiple NOs can all win when temp exceeds multiple boundaries
        const rangeKey = `${cityKey}:${localToday}:${range.rangeName}:${range.platform}`;
        if (this._openRangeKeys?.has(rangeKey)) continue;

        // Adjacent-NO protection: skip NO when range_max <= open YES's range_min (correlated risk)
        if (signal.side === 'NO' && range.rangeMax != null && this._openYesThreshold) {
          const yesThreshKey = `${cityKey}:${localToday}:${range.platform}`;
          const yesRangeMin = this._openYesThreshold.get(yesThreshKey);
          if (yesRangeMin != null && range.rangeMax <= yesRangeMin) {
            this._log('info', `GW skip adjacent NO ${cityKey} ${range.rangeName}: max ${range.rangeMax} <= YES min ${yesRangeMin}`);
            continue;
          }
        }

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
          entry_reason: dualConfirmed ? 'guaranteed_win' : 'guaranteed_win_metar_only',
          observation_high: runHigh,
          wu_high: wuHigh,
          dual_confirmed: dualConfirmed,
          wu_triggered: wuTriggeredSet.has(`${cityKey}|${localToday}|${range.platform}|${range.rangeName}|${signal.side}`),
          margin,
        });
      }
    }

    // Same-batch adjacent-NO protection: filter NOs correlated with a YES approved in this batch
    // (DB-based check only catches previously committed trades — misses YES+NO approved in same cycle)
    const batchYesThreshold = new Map();
    for (const e of entries) {
      if (e.side === 'YES' && e.range_min != null) {
        batchYesThreshold.set(`${e.city}:${e.target_date}:${e.platform}`, e.range_min);
      }
    }
    const batchFiltered = entries.filter(e => {
      if (e.side !== 'NO' || e.range_max == null) return true;
      const yesMin = batchYesThreshold.get(`${e.city}:${e.target_date}:${e.platform}`);
      if (yesMin != null && e.range_max <= yesMin) {
        this._log('info', `GW batch skip adjacent NO ${e.city} ${e.range_name}: max ${e.range_max} <= batch YES min ${yesMin}`);
        return false;
      }
      return true;
    });

    // Deduplicate: keep best candidate per city+date+platform+side
    // For NOs: keep each range (multiple NOs can all win), dedup per range
    const bestMap = new Map();
    for (const entry of batchFiltered) {
      const key = entry.side === 'NO'
        ? `${entry.city}:${entry.target_date}:${entry.platform}:${entry.side}:${entry.range_name}`
        : `${entry.city}:${entry.target_date}:${entry.platform}:${entry.side}`;
      const existing = bestMap.get(key);
      if (!existing || entry.margin > existing.margin) {
        bestMap.set(key, entry);
      }
    }
    const dedupedEntries = [...bestMap.values()];

    if (batchFiltered.length < entries.length) {
      this._log('info', `GW batch adjacent-NO filter: ${entries.length} → ${batchFiltered.length}`);
    }
    if (dedupedEntries.length < batchFiltered.length) {
      this._log('info', `GW dedup: ${batchFiltered.length} candidates → ${dedupedEntries.length} after best-pick`);
    }
    if (dedupedEntries.length > 0) {
      this._log('info', `Guaranteed-win scan: ${dedupedEntries.length} entries found`);
    }
    // Debounce missed alerts — only return new misses not yet alerted for this target_date
    // Don't reset on UTC date boundary — American cities are still on the previous local date
    // for 5-8 hours after midnight UTC. Prune entries older than 2 days instead.
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
    for (const key of this._missedAlerted) {
      const datePart = key.split('|')[1]; // city|YYYY-MM-DD|platform|range|side
      if (datePart && datePart < twoDaysAgo) this._missedAlerted.delete(key);
    }
    const newMissed = missed.filter(m => {
      const key = `${m.city}|${m.target_date}|${m.platform}|${m.range_name}|${m.side}`;
      if (this._missedAlerted.has(key)) return false;
      this._missedAlerted.add(key);
      return true;
    });

    if (missed.length > 0) {
      this._log('info', `Guaranteed-win scan: ${missed.length} missed entries (${newMissed.length} new)`, {
        reasons: [...new Set(missed.map(m => m.reason))],
      });
    }

    return { entries: dedupedEntries, missed: newMissed };
  }

  /**
   * Fast-path GW evaluation for detections from metarFastPoll().
   * Applies the same filter chain as scanGuaranteedWins() but skips market
   * and observation re-fetching — uses pre-computed data from the fast poll.
   * @param {Array} candidates - Enriched detection objects from _processRangesForCity
   * @returns {{ entries: Array, missed: Array }}
   */
  async evaluateGWFastPath(candidates) {
    if (!config.guaranteed_entry?.ENABLED || candidates.length === 0) {
      return { entries: [], missed: [] };
    }

    const gwConfig = config.guaranteed_entry;
    const entries = [];
    const missed = [];

    // 1. Load dedup keys — single DB query, only detected cities
    const cities = [...new Set(candidates.map(c => c.city))];
    const { data: openTrades } = await query(
      `SELECT city, target_date, range_name, range_min, side, platform
       FROM trades WHERE city = ANY($1) AND status = 'open'`,
      [cities]
    );
    const positionKeys = new Set();
    const openYesKeys = new Set();
    const openRangeKeys = new Set();
    const openYesThreshold = new Map(); // city:date:platform → range_min of open YES
    for (const t of (openTrades || [])) {
      positionKeys.add(`${t.city}:${t.target_date}:${t.range_name}:${t.side}:${t.platform}`);
      if (t.side === 'YES') {
        openYesKeys.add(`${t.city}:${t.target_date}:${t.platform}`);
        if (t.range_min != null) {
          openYesThreshold.set(`${t.city}:${t.target_date}:${t.platform}`, t.range_min);
        }
      }
      openRangeKeys.add(`${t.city}:${t.target_date}:${t.range_name}:${t.platform}`);
    }

    // 2. Load wu_triggered flags — single DB query for detected cities
    const wuTriggeredSet = new Set();
    try {
      const { data: wuRows } = await query(
        `SELECT city, target_date, platform, range_name, side
         FROM metar_pending_events WHERE wu_triggered = true AND city = ANY($1)`,
        [cities]
      );
      for (const row of (wuRows || [])) {
        wuTriggeredSet.add(`${row.city}|${row.target_date}|${row.platform}|${row.range_name}|${row.side}`);
      }
    } catch (err) {
      this._log('warn', 'GW fast-path: failed to load wu_triggered flags', { error: err.message });
    }

    // 3. Apply filter chain per candidate (same logic as scanGuaranteedWins)
    for (const c of candidates) {
      // Skip ranges already held — no alert, no missed entry
      const hasPos = positionKeys.has(`${c.city}:${c.target_date}:${c.range_name}:YES:${c.platform}`)
                  || positionKeys.has(`${c.city}:${c.target_date}:${c.range_name}:NO:${c.platform}`);
      if (hasPos) continue;

      // Gap check
      const cityConfig = config.cities[c.city] || {};
      const isKalshi = c.platform === 'kalshi';
      const isDualStation = isKalshi && cityConfig.nwsStation && cityConfig.polymarketStation
        && cityConfig.nwsStation !== cityConfig.polymarketStation;
      const minGap = isDualStation
        ? (c.range_unit === 'C' ? 0.8 : 1.5)
        : (c.range_unit === 'C' ? (gwConfig.METAR_ONLY_MIN_GAP_C || 0.5) : (gwConfig.METAR_ONLY_MIN_GAP_F || 0.5));
      if (c.gap < minGap) {
        missed.push({
          city: c.city, target_date: c.target_date, platform: c.platform,
          range_name: c.range_name, side: c.side, ask: c.ask,
          observation_high: c.effHigh, unit: c.range_unit,
          reason: 'below_metar_gap', gap: Math.round(c.gap * 10) / 10, minGap,
        });
        continue;
      }

      // ASK filters
      if (c.ask > gwConfig.MAX_ASK) {
        if (c.ask < 1.0) {
          missed.push({
            city: c.city, target_date: c.target_date, platform: c.platform,
            range_name: c.range_name, side: c.side, ask: c.ask,
            observation_high: c.effHigh, unit: c.range_unit,
            reason: 'above_max_ask', maxAsk: gwConfig.MAX_ASK,
          });
        }
        continue;
      }
      if (c.ask < gwConfig.MIN_ASK) {
        missed.push({
          city: c.city, target_date: c.target_date, platform: c.platform,
          range_name: c.range_name, side: c.side, ask: c.ask,
          observation_high: c.effHigh, unit: c.range_unit,
          reason: 'below_min_ask', minAsk: gwConfig.MIN_ASK,
        });
        continue;
      }

      // Market sanity: bid must be meaningful (prevents entering when market disagrees with signal)
      const gwMinBid = gwConfig.GW_MIN_BID || 0.10;
      if (c.bid != null && c.bid < gwMinBid) {
        missed.push({
          city: c.city, target_date: c.target_date, platform: c.platform,
          range_name: c.range_name, side: c.side, ask: c.ask,
          observation_high: c.effHigh, unit: c.range_unit,
          reason: 'below_min_bid', bid: Math.round(c.bid * 100), minBid: Math.round(gwMinBid * 100),
        });
        continue;
      }

      // Fee/margin check
      const fee = this.adapter.getEntryFee(c.platform, c.ask);
      const margin = 1.00 - c.ask - fee;
      if (margin * 100 < gwConfig.MIN_MARGIN_CENTS) continue;

      // Dedup
      const posKey = `${c.city}:${c.target_date}:${c.range_name}:${c.side}:${c.platform}`;
      if (positionKeys.has(posKey)) continue;
      if (c.side === 'YES' && openYesKeys.has(`${c.city}:${c.target_date}:${c.platform}`)) continue;
      const rangeKey = `${c.city}:${c.target_date}:${c.range_name}:${c.platform}`;
      if (openRangeKeys.has(rangeKey)) continue;

      // Adjacent-NO protection: skip NO when range_max <= open YES's range_min (correlated risk)
      if (c.side === 'NO' && c.range_max != null) {
        const yesThreshKey = `${c.city}:${c.target_date}:${c.platform}`;
        const yesRangeMin = openYesThreshold.get(yesThreshKey);
        if (yesRangeMin != null && c.range_max <= yesRangeMin) {
          this._log('info', `GW fast-path skip adjacent NO ${c.city} ${c.range_name}: max ${c.range_max} <= YES min ${yesRangeMin}`);
          continue;
        }
      }

      // Build entry (same shape as scanGuaranteedWins output)
      const wuKey = `${c.city}|${c.target_date}|${c.platform}|${c.range_name}|${c.side}`;
      const isWuTriggered = c.wuTriggered || wuTriggeredSet.has(wuKey);

      // Dual-confirmed: both METAR and WU independently cross the boundary
      let dualConfirmed = false;
      if (isWuTriggered && c.metar_high != null && c.wu_high != null) {
        const threshold = c.side === 'YES' ? c.range_min : c.range_max;
        if (threshold != null) {
          dualConfirmed = c.side === 'YES'
            ? (c.metar_high >= threshold && c.wu_high >= threshold)
            : (c.metar_high > threshold && c.wu_high > threshold);
        }
      }

      entries.push({
        city: c.city,
        target_date: c.target_date,
        platform: c.platform,
        market_id: c.market_id,
        token_id: c.token_id,
        range_name: c.range_name,
        range_min: c.range_min,
        range_max: c.range_max,
        range_type: c.range_type,
        range_unit: c.range_unit,
        side: c.side,
        ask: c.ask,
        bid: c.bid,
        spread: c.ask - (c.bid || 0),
        volume: c.volume,
        entry_reason: dualConfirmed ? 'guaranteed_win' : 'guaranteed_win_metar_only',
        observation_high: c.metar_high || c.effHigh,
        wu_high: c.wu_high,
        margin,
        dual_confirmed: dualConfirmed,
        wu_triggered: isWuTriggered,
        _freshBookAsk: c._freshBookAsk,
      });
    }

    // Same-batch adjacent-NO protection: filter NOs correlated with a YES approved in this batch
    const batchYesThreshold = new Map();
    for (const e of entries) {
      if (e.side === 'YES' && e.range_min != null) {
        batchYesThreshold.set(`${e.city}:${e.target_date}:${e.platform}`, e.range_min);
      }
    }
    const batchFiltered = entries.filter(e => {
      if (e.side !== 'NO' || e.range_max == null) return true;
      const yesMin = batchYesThreshold.get(`${e.city}:${e.target_date}:${e.platform}`);
      if (yesMin != null && e.range_max <= yesMin) {
        this._log('info', `GW fast-path batch skip adjacent NO ${e.city} ${e.range_name}: max ${e.range_max} <= batch YES min ${yesMin}`);
        return false;
      }
      return true;
    });

    // Deduplicate: best candidate per city+date+platform+side (YES only — NOs keep per-range)
    const bestMap = new Map();
    for (const entry of batchFiltered) {
      const key = entry.side === 'NO'
        ? `${entry.city}:${entry.target_date}:${entry.platform}:${entry.side}:${entry.range_name}`
        : `${entry.city}:${entry.target_date}:${entry.platform}:${entry.side}`;
      const existing = bestMap.get(key);
      if (!existing || entry.margin > existing.margin) {
        bestMap.set(key, entry);
      }
    }
    const dedupedEntries = [...bestMap.values()];

    // Debounce missed alerts
    const newMissed = missed.filter(m => {
      const key = `${m.city}|${m.target_date}|${m.platform}|${m.range_name}|${m.side}`;
      if (this._missedAlerted.has(key)) return false;
      this._missedAlerted.add(key);
      return true;
    });

    if (dedupedEntries.length > 0) {
      this._log('info', `GW fast-path: ${dedupedEntries.length} entries approved (from ${candidates.length} candidates)`);
    }
    if (newMissed.length > 0) {
      this._log('info', `GW fast-path: ${missed.length} missed (${newMissed.length} new)`, {
        reasons: [...new Set(missed.map(m => m.reason))],
      });
    }

    return { entries: dedupedEntries, missed: newMissed };
  }

  /**
   * Check if a range is a guaranteed win based on observation data.
   * Returns { side, type } or null if not guaranteed.
   */
  _checkGuaranteedWin(range, primaryHigh, confirmHigh, requireDual, confirmAvailable) {
    if (primaryHigh == null) return null;

    // Unbounded YES ("X or higher"): range_max is null, range_min exists
    // If primary source >= range_min, YES is guaranteed
    if (range.rangeMax == null && range.rangeMin != null) {
      if (primaryHigh >= range.rangeMin) {
        // Dual confirmation: secondary source must also agree
        if (requireDual && confirmAvailable && (confirmHigh == null || confirmHigh < range.rangeMin)) return null;
        return { side: 'YES', type: 'guaranteed_win_yes' };
      }
    }

    // Bounded range ("X-Y"): both range_min and range_max exist
    // If primary source > range_max, NO is guaranteed (temp already exceeded upper bound)
    if (range.rangeMin != null && range.rangeMax != null) {
      if (primaryHigh > range.rangeMax) {
        // Dual confirmation: secondary source must also agree
        if (requireDual && confirmAvailable && (confirmHigh == null || confirmHigh <= range.rangeMax)) return null;
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
  _bothCrossThreshold(signal, primaryHigh, confirmHigh, range) {
    if (signal.type === 'guaranteed_win_yes') {
      return confirmHigh != null && confirmHigh >= range.rangeMin;
    }
    if (signal.type === 'guaranteed_win_no') {
      return confirmHigh != null && confirmHigh > range.rangeMax;
    }
    return false;
  }

  /**
   * Get latest METAR observation for a city/date. Same pattern as monitor._getLatestObservation.
   */
  async _getLatestObservation(city, targetDate, stationId = null) {
    try {
      const { data, error } = await query(
        `SELECT running_high_c, running_high_f, wu_high_c, wu_high_f, temp_c, temp_f, observed_at, observation_count, station_id
         FROM metar_observations
         WHERE city = $1 AND target_date = $2
           ${stationId ? 'AND station_id = $3' : ''}
         ORDER BY created_at DESC
         LIMIT 1`,
        stationId ? [city.toLowerCase(), targetDate, stationId] : [city.toLowerCase(), targetDate]
      );

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
   * Find top YES candidate ranges sorted by corrected edge.
   * Returns up to YES_CANDIDATE_COUNT ranges within YES_MAX_FORECAST_DISTANCE stddevs of forecast.
   */
  _findYesCandidates(ranges, forecast, city) {
    const maxDist = (config.entry.YES_MAX_FORECAST_DISTANCE || 3.0) * forecast.stdDev;
    const maxCount = config.entry.YES_CANDIDATE_COUNT || 5;

    // Convert stddev distance threshold to the forecast's unit
    // forecast.stdDev is in °C; maxDist needs to be in market unit
    const maxDistInUnit = forecast.unit === 'F' ? maxDist * 9 / 5 : maxDist;

    const scored = [];
    for (const range of ranges) {
      // Must have valid ask
      if (!range.ask || range.ask <= 0 || range.ask >= 1) continue;

      // Compute reference point and distance
      let reference;
      if (range.rangeMin != null && range.rangeMax != null) {
        reference = (range.rangeMin + range.rangeMax) / 2;
      } else if (range.rangeMax == null && range.rangeMin != null) {
        reference = range.rangeMin;
      } else if (range.rangeMin == null && range.rangeMax != null) {
        reference = range.rangeMax;
      } else {
        continue;
      }

      const dist = Math.abs(forecast.temp - reference);
      if (dist > maxDistInUnit) continue;

      // Score: corrected probability - ask
      const rawProb = this.forecast.calculateProbability(
        forecast.temp, forecast.stdDev,
        range.rangeMin, range.rangeMax,
        forecast.unit, city
      );
      const modelCal = this._getModelCalibration(range.rangeType, rawProb, city);
      const rawRatio = (modelCal && modelCal.n >= 30) ? Number(modelCal.correction_ratio) : 1.0;
      const ratio = Number.isFinite(rawRatio) ? rawRatio : 1.0;
      const correctedProb = Math.min(1, Math.max(0, rawProb * ratio));
      const score = correctedProb - range.ask;

      scored.push({ range, score });
    }

    // Sort by score descending, return top N ranges
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxCount).map(s => s.range);
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
          const { error } = await query(
            `INSERT INTO snapshots (city, target_date, platform, ranges, forecast_temp, forecast_confidence, forecast_sources, depth_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              cityKey,
              dateStr,
              platforms.length === 1 ? platforms[0] : 'both',
              JSON.stringify(rangesData),
              forecast?.temp || null,
              forecast?.confidence || null,
              forecast?.sources ? JSON.stringify(forecast.sources) : null,
              depthData.length > 0 ? JSON.stringify(depthData) : null,
            ]
          );

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

      const rangeDataJson = JSON.stringify(entries.map(e => ({
        name: e.name, min: e.min, max: e.max,
        mid_price: Math.round(e.midPrice * 100) / 100,
        implied_prob: Math.round(e.impliedProb * 1000) / 1000,
      })));

      // Upsert to market_implied (fire-and-forget)
      query(
        `INSERT INTO market_implied (
          city, target_date, platform, implied_mean, implied_median, implied_std_dev,
          ensemble_temp, ensemble_std_dev, mean_divergence, sum_implied_probs,
          num_ranges, avg_spread, range_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (city, target_date, platform) DO UPDATE SET
          implied_mean = EXCLUDED.implied_mean,
          implied_median = EXCLUDED.implied_median,
          implied_std_dev = EXCLUDED.implied_std_dev,
          ensemble_temp = EXCLUDED.ensemble_temp,
          ensemble_std_dev = EXCLUDED.ensemble_std_dev,
          mean_divergence = EXCLUDED.mean_divergence,
          sum_implied_probs = EXCLUDED.sum_implied_probs,
          num_ranges = EXCLUDED.num_ranges,
          avg_spread = EXCLUDED.avg_spread,
          range_data = EXCLUDED.range_data`,
        [
          city,
          dateStr,
          platform,
          Math.round(impliedMean * 100) / 100,
          Math.round(impliedMedian * 100) / 100,
          Math.round(impliedStd * 100) / 100,
          forecast?.temp || null,
          forecast?.stdDev || null,
          meanDiv != null ? Math.round(meanDiv * 100) / 100 : null,
          Math.round(totalMid * 100) / 100,
          entries.length,
          Math.round(avgSpread * 1000) / 1000,
          rangeDataJson,
        ]
      ).catch(() => {});
    }
  }
  // ── Market Calibration ─────────────────────────────────────────

  async _loadCalibration() {
    try {
      const { data, error } = await query('SELECT * FROM market_calibration');
      if (error) throw error;

      const map = new Map();
      for (const row of (data || [])) {
        const key = row.city
          ? `${row.platform}|${row.range_type}|${row.lead_time_bucket}|${row.price_bucket}|${row.city}`
          : `${row.platform}|${row.range_type}|${row.lead_time_bucket}|${row.price_bucket}`;
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
      : askPrice < 0.30 ? '25-30c'
      : askPrice < 0.35 ? '30-35c'
      : askPrice < 0.40 ? '35-40c'
      : askPrice < 0.45 ? '40-45c'
      : askPrice < 0.50 ? '45-50c'
      : askPrice < 0.55 ? '50-55c'
      : '55c+';

    return { leadBucket, priceBucket };
  }

  _getCalibration(rangeType, hoursToResolution, askPrice, platform, city = null) {
    if (!this._calibration || this._calibration.size === 0) return null;

    const { leadBucket, priceBucket } = this._getCalibrationBuckets(rangeType, hoursToResolution, askPrice);
    if (city) {
      const cityKey = `${platform}|${rangeType}|${leadBucket}|${priceBucket}|${city}`;
      const cityRow = this._calibration.get(cityKey);
      if (cityRow && cityRow.n >= 15) return cityRow;
    }
    const globalKey = `${platform}|${rangeType}|${leadBucket}|${priceBucket}`;
    return this._calibration.get(globalKey) || null;
  }

  // ── Model Calibration (correction ratios) ──────────────────────

  async _loadModelCalibration() {
    try {
      const { data, error } = await query('SELECT * FROM model_calibration');
      if (error) throw error;

      const map = new Map();
      let pooledActive = 0, cityActive = 0, belowThreshold = 0;
      for (const row of (data || [])) {
        const cityPrefix = row.city || '';
        const key = `${cityPrefix}|${row.range_type}|${row.model_prob_bucket}`;
        map.set(key, row);
        if (row.city) {
          if (row.n >= 50) cityActive++;
          else belowThreshold++;
        } else {
          if (row.n >= 30) pooledActive++;
          else belowThreshold++;
        }
      }
      if (pooledActive > 0 || cityActive > 0) {
        this._log('info', `Model calibration: ${pooledActive} pooled active (n≥30), ${cityActive} city active (n≥50), ${belowThreshold} below threshold`);
      } else if (map.size > 0) {
        this._log('warn', `Model calibration: 0 buckets active (all ${map.size} below threshold) — all ratios defaulting to 1.0`);
      }
      return map;
    } catch (err) {
      this._log('warn', 'Failed to load model calibration — proceeding without', { error: err.message });
      return new Map();
    }
  }

  _getModelCalibration(rangeType, rawProbability, city) {
    if (!this._modelCalibration || this._modelCalibration.size === 0) return null;

    const bucket = rawProbability < 0.05 ? '0-5%'
      : rawProbability < 0.10 ? '5-10%'
      : rawProbability < 0.15 ? '10-15%'
      : rawProbability < 0.20 ? '15-20%'
      : rawProbability < 0.25 ? '20-25%'
      : rawProbability < 0.30 ? '25-30%'
      : rawProbability < 0.35 ? '30-35%'
      : rawProbability < 0.40 ? '35-40%'
      : rawProbability < 0.45 ? '40-45%'
      : rawProbability < 0.50 ? '45-50%'
      : rawProbability < 0.55 ? '50-55%'
      : rawProbability < 0.60 ? '55-60%'
      : rawProbability < 0.65 ? '60-65%'
      : rawProbability < 0.70 ? '65-70%'
      : rawProbability < 0.75 ? '70-75%'
      : '75%+';

    // City-specific first, fall back to pooled
    if (city) {
      const cityRow = this._modelCalibration.get(`${city}|${rangeType}|${bucket}`);
      if (cityRow && cityRow.n >= 50) return cityRow;
    }
    return this._modelCalibration.get(`|${rangeType}|${bucket}`) || null;
  }

  /**
   * Load most recent market-implied temperatures per city/date.
   * Keyed on "city|target_date" for O(1) lookup in filters.
   */
  async _loadMarketImplied() {
    try {
      const { data, error } = await query(
        `SELECT DISTINCT ON (city, target_date) city, target_date, mean_divergence
         FROM market_implied
         WHERE target_date >= CURRENT_DATE - INTERVAL '3 days'
         ORDER BY city, target_date, snapshot_time DESC`
      );
      if (error) throw error;

      const map = new Map();
      for (const row of (data || [])) {
        if (row.mean_divergence != null) {
          map.set(`${row.city}|${row.target_date}`, row);
        }
      }
      if (map.size > 0) {
        this._log('info', `Market implied: ${map.size} city/date pairs loaded`);
      }
      return map;
    } catch (err) {
      this._log('warn', 'Failed to load market implied — proceeding without', { error: err.message });
      return new Map();
    }
  }
}

module.exports = Scanner;
