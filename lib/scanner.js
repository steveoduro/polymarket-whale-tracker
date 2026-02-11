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

    // Determine which dates to scan (today + next 15 days)
    const dates = this._getScanDates();

    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
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
            // Evaluate YES side
            const yesOpp = this._evaluateYes(cityKey, dateStr, range, forecast);
            if (yesOpp) {
              const oppId = await this._logOpportunity(yesOpp);
              if (oppId) yesOpp.opportunity_id = oppId;
              logged++;
              if (yesOpp.action === 'entered') {
                approved.push(yesOpp);
              } else {
                filtered++;
              }
            }

            // Evaluate NO side
            const noOpp = this._evaluateNo(cityKey, dateStr, range, forecast);
            if (noOpp) {
              const oppId = await this._logOpportunity(noOpp);
              if (oppId) noOpp.opportunity_id = oppId;
              logged++;
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
      approved: approved.length,
      filtered,
    });

    return { opportunities: approved, logged, filtered, marketsScanned };
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
    const feeRate = this.adapter.getFeeRate(range.platform);
    const payout = 1 - feeRate;
    const ev = probability * payout - ask;

    // Kelly fraction
    const kellyFull = probability > 0 && payout > 0
      ? (probability * payout - (1 - probability)) / payout
      : 0;
    const kelly = Math.max(0, kellyFull * config.sizing.KELLY_FRACTION);

    // Determine action + filter reason
    const { action, filterReason } = this._applyFilters('YES', edgePct, spread, ask, bid, range);

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
    const feeRate = this.adapter.getFeeRate(range.platform);
    const payout = 1 - feeRate;
    const ev = noProbability * payout - noAsk;

    // Kelly fraction
    const kellyFull = noProbability > 0 && payout > 0
      ? (noProbability * payout - (1 - noProbability)) / payout
      : 0;
    const kelly = Math.max(0, kellyFull * config.sizing.KELLY_FRACTION);

    // Determine action + filter reason
    const { action, filterReason } = this._applyFilters('NO', edgePct, spread, noAsk, 1 - ask, range);

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
  _applyFilters(side, edgePct, spread, ask, bid, range) {
    const reasons = [];

    // Edge threshold
    if (edgePct < config.entry.MIN_EDGE_PCT) {
      reasons.push(`edge ${edgePct.toFixed(1)}% < ${config.entry.MIN_EDGE_PCT}%`);
    }

    // Spread cap
    if (spread > config.entry.MAX_SPREAD) {
      reasons.push(`spread ${spread.toFixed(3)} > ${config.entry.MAX_SPREAD}`);
    }

    // Price sanity
    if (ask <= 0) {
      reasons.push('ask <= 0');
    }
    if (ask < config.entry.MIN_ASK_PRICE) {
      reasons.push(`ask_below_minimum (${(ask * 100).toFixed(1)}¢ < ${(config.entry.MIN_ASK_PRICE * 100).toFixed(0)}¢)`);
    }
    if (ask >= 0.97) {
      reasons.push(`ask ${ask.toFixed(2)} too high (>= 0.97)`);
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
   * Get dates to scan: today through 15 days out.
   */
  _getScanDates() {
    const dates = [];
    const now = new Date();
    for (let i = 0; i <= 15; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
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
    const dates = this._getScanDates().slice(0, 7); // Snapshots for next 7 days only

    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
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

          const { error } = await db.from('snapshots').insert({
            city: cityKey,
            target_date: dateStr,
            platform: ranges[0].platform, // First platform in the set
            ranges: rangesData,
            forecast_temp: forecast?.temp || null,
            forecast_confidence: forecast?.confidence || null,
            forecast_sources: forecast?.sources || null,
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
