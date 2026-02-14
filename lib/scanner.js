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

          // Evaluate each range for both YES and NO
          for (const range of ranges) {
            // City eligibility gate: check if this range type is allowed
            const isBounded = range.rangeType === 'bounded';
            let cityGateReason = null;
            if (!eligibility.allowUnbounded) {
              cityGateReason = `city_mae_too_high (${eligibility.mae}°${eligibility.unit} > threshold, n=${eligibility.n})`;
            } else if (isBounded && !eligibility.allowBounded) {
              cityGateReason = `city_mae_too_high_for_bounded (${eligibility.mae}°${eligibility.unit} > bounded threshold, n=${eligibility.n})`;
            }

            // Evaluate YES side
            const yesOpp = this._evaluateYes(cityKey, dateStr, range, forecast);
            if (yesOpp) {
              // Override action if city gate blocks this range
              if (cityGateReason) {
                yesOpp.action = 'filtered';
                yesOpp.filter_reason = cityGateReason;
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

            // Evaluate NO side
            const noOpp = this._evaluateNo(cityKey, dateStr, range, forecast);
            if (noOpp) {
              // Override action if city gate blocks this range
              if (cityGateReason) {
                noOpp.action = 'filtered';
                noOpp.filter_reason = cityGateReason;
              }
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

          if (!error) captured++;
        } catch (err) {
          // Snapshot failures are non-critical
          this._log('warn', `Snapshot failed for ${cityKey} ${dateStr}`, { error: err.message });
        }
      }
    }

    this._log('info', `Snapshots captured: ${captured}`);
    return captured;
  }
}

module.exports = Scanner;
