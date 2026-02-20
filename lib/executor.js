/**
 * executor.js — Entry decisions, position sizing, trade recording
 *
 * For each approved opportunity from scanner:
 * 1. Check bankroll (YES or NO based on side)
 * 2. Check per-date exposure cap (NO trades only)
 * 3. Calculate position size (Kelly → caps → MIN_BET floor)
 * 4. Simulate execution at ask price
 * 5. Write to trades table, link to opportunity_id
 * 6. Queue Telegram alert
 */

const config = require('../config');
const { query, queryOne } = require('./db');

class Executor {
  constructor(platformAdapter, alerts) {
    this.adapter = platformAdapter;
    this.alerts = alerts;

    // Track bankrolls in memory (start from config, adjust as trades are placed)
    this.yesBankroll = config.sizing.YES_BANKROLL;
    this.noBankroll = config.sizing.NO_BANKROLL;

    // Track per-date NO exposure: { 'YYYY-MM-DD': dollars }
    this.noExposureByDate = {};
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const label = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[EXECUTOR]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Initialize bankrolls from existing open trades in DB.
   * Call once at startup.
   */
  async initBankrolls() {
    try {
      const { data: openTrades, error } = await query(
        'SELECT side, cost, target_date FROM trades WHERE status = $1',
        ['open']
      );

      if (error) {
        this._log('warn', 'Failed to load open trades for bankroll init', { error: error.message });
        return;
      }

      let yesDeployed = 0;
      let noDeployed = 0;

      for (const t of openTrades || []) {
        const cost = Number(t.cost) || 0;
        if (t.side === 'YES') {
          yesDeployed += cost;
        } else {
          noDeployed += cost;
          const dateKey = t.target_date;
          this.noExposureByDate[dateKey] = (this.noExposureByDate[dateKey] || 0) + cost;
        }
      }

      this.yesBankroll = config.sizing.YES_BANKROLL - yesDeployed;
      this.noBankroll = config.sizing.NO_BANKROLL - noDeployed;

      this._log('info', 'Bankrolls initialized', {
        yesBankroll: this.yesBankroll.toFixed(2),
        noBankroll: this.noBankroll.toFixed(2),
        openTrades: (openTrades || []).length,
      });
    } catch (err) {
      this._log('error', 'Bankroll init failed', { error: err.message });
    }
  }

  /**
   * Process approved opportunities. Returns array of executed trades.
   */
  async execute(opportunities) {
    const trades = [];

    for (const opp of opportunities) {
      try {
        const trade = await this._executeSingle(opp);
        if (trade) trades.push(trade);
      } catch (err) {
        this._log('error', `Failed to execute ${opp.city} ${opp.range_name}`, { error: err.message });
      }
    }

    if (trades.length > 0) {
      this._log('info', `Executed ${trades.length} trades`);
    }

    return trades;
  }

  async _executeSingle(opp) {
    const side = opp.side;
    const bankroll = side === 'YES' ? this.yesBankroll : this.noBankroll;

    // Check bankroll
    if (bankroll <= config.sizing.MIN_BET) {
      this._log('warn', `Skipping ${opp.city} ${opp.range_name} ${side}: bankroll depleted ($${bankroll.toFixed(2)})`);
      return null;
    }

    // Hard block: zero volume markets
    const entryVolume = opp.volume || 0;
    if (!entryVolume || entryVolume === 0) {
      this._log('warn', `Skipping ${opp.city} ${opp.range_name} ${side}: zero volume`);
      return null;
    }

    // Check per-date NO cap
    if (side === 'NO') {
      const dateExposure = this.noExposureByDate[opp.target_date] || 0;
      if (dateExposure >= config.sizing.NO_MAX_PER_DATE) {
        this._log('warn', `Skipping NO ${opp.city} ${opp.target_date}: date cap reached ($${dateExposure.toFixed(2)})`);
        return null;
      }
    }

    // Check for duplicate: same city/date/range/side/platform already open or resolved
    // Including 'resolved' prevents re-entry of just-resolved trades during timezone gaps
    const { data: existing, error: dupError } = await query(
      `SELECT id FROM trades
       WHERE city = $1 AND target_date = $2 AND range_name = $3
         AND side = $4 AND platform = $5 AND status IN ($6, $7)
       LIMIT 1`,
      [opp.city, opp.target_date, opp.range_name, side, opp.platform, 'open', 'resolved']
    );

    if (dupError) {
      this._log('warn', `Duplicate check failed for ${opp.city} ${opp.range_name}, skipping to be safe`, { error: dupError.message });
      return null; // Skip rather than risk duplicate
    }

    if (existing && existing.length > 0) {
      return null; // Already have this position open
    }

    // For YES trades: max 1 YES per city/date (mutually exclusive ranges waste capital)
    if (side === 'YES') {
      const { data: existingYes, error: yesError } = await query(
        `SELECT id, range_name FROM trades
         WHERE city = $1 AND target_date = $2 AND side = $3 AND status = $4
         LIMIT 1`,
        [opp.city, opp.target_date, 'YES', 'open']
      );

      if (!yesError && existingYes && existingYes.length > 0) {
        this._log('info', `Skipping YES ${opp.city} ${opp.range_name}: already have YES on ${existingYes[0].range_name} for ${opp.target_date}`);
        return null;
      }
    }

    // For NO trades: max 1 NO per city/date (adjacent ranges are correlated bets)
    if (side === 'NO') {
      const { data: existingNo, error: noError } = await query(
        `SELECT id, range_name FROM trades
         WHERE city = $1 AND target_date = $2 AND side = $3 AND status = $4
         LIMIT 1`,
        [opp.city, opp.target_date, 'NO', 'open']
      );

      if (!noError && existingNo && existingNo.length > 0) {
        this._log('info', `Skipping NO ${opp.city} ${opp.range_name}: already have NO on ${existingNo[0].range_name} for ${opp.target_date}`);
        return null;
      }
    }

    // Calculate position size
    const size = this._calculateSize(opp, bankroll);
    if (!size) return null;

    let { shares, cost } = size;

    // Volume awareness: calculate pct_of_volume and apply limits
    let pctOfVolume = entryVolume > 0 ? (shares / entryVolume) * 100 : null;

    // Hard-reject if > HARD_REJECT_VOLUME_PCT of visible volume
    if (pctOfVolume !== null && pctOfVolume > config.sizing.HARD_REJECT_VOLUME_PCT) {
      this._log('warn', `REJECTED ${opp.city} ${opp.range_name} ${side}: ${pctOfVolume.toFixed(0)}% of volume (${shares} shares / ${entryVolume} vol)`);
      return null;
    }

    // Cap at MAX_VOLUME_PCT if configured (for live trading)
    if (config.sizing.MAX_VOLUME_PCT && entryVolume > 0) {
      const maxShares = Math.floor((config.sizing.MAX_VOLUME_PCT / 100) * entryVolume);
      if (shares > maxShares) {
        shares = maxShares;
        cost = Math.round(shares * opp.ask * 100) / 100;
        pctOfVolume = (shares / entryVolume) * 100;
        if (cost < config.sizing.MIN_BET) return null;
      }
    }

    // Round pct_of_volume for storage
    pctOfVolume = pctOfVolume !== null ? Math.round(pctOfVolume * 10) / 10 : null;

    // Simulate execution at ask
    const execution = await this.adapter.executeBuy(opp);

    // Write to trades table
    const tradeRecord = {
      opportunity_id: opp.opportunity_id || null,
      city: opp.city,
      target_date: opp.target_date,
      platform: opp.platform,
      market_id: opp.market_id,
      token_id: opp.token_id,
      range_name: opp.range_name,
      range_min: opp.range_min,
      range_max: opp.range_max,
      range_type: opp.range_type,
      range_unit: opp.range_unit,
      side,
      entry_ask: opp.ask,
      entry_bid: opp.bid,
      entry_spread: opp.spread,
      entry_volume: opp.volume,
      shares,
      cost,
      entry_edge_pct: opp.edge_pct,
      entry_probability: opp.corrected_probability ?? opp.our_probability,
      entry_kelly: opp.kelly_fraction,
      entry_forecast_temp: opp.forecast_temp,
      entry_forecast_confidence: opp.forecast_confidence,
      entry_ensemble: opp.forecast_sources,
      entry_reason: opp.entry_reason || 'edge',
      pct_of_volume: pctOfVolume,
      hours_to_resolution: opp.hours_to_resolution || null,
      entry_bid_depth: opp.bid_depth || null,
      entry_ask_depth: opp.ask_depth || null,
      status: 'open',
      current_probability: opp.corrected_probability ?? opp.our_probability,
      current_bid: opp.bid,
      current_ask: opp.ask,
      max_price_seen: opp.bid,
      min_probability_seen: opp.corrected_probability ?? opp.our_probability,
      evaluator_log: [],
    };

    const { data, error } = await queryOne(
      `INSERT INTO trades (
        opportunity_id, city, target_date, platform, market_id, token_id,
        range_name, range_min, range_max, range_type, range_unit,
        side, entry_ask, entry_bid, entry_spread, entry_volume,
        shares, cost, entry_edge_pct, entry_probability, entry_kelly,
        entry_forecast_temp, entry_forecast_confidence, entry_ensemble,
        entry_reason,
        pct_of_volume, hours_to_resolution, entry_bid_depth, entry_ask_depth,
        status, current_probability, current_bid, current_ask,
        max_price_seen, min_probability_seen, evaluator_log
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36
      ) RETURNING id`,
      [
        tradeRecord.opportunity_id, tradeRecord.city, tradeRecord.target_date,
        tradeRecord.platform, tradeRecord.market_id, tradeRecord.token_id,
        tradeRecord.range_name, tradeRecord.range_min, tradeRecord.range_max,
        tradeRecord.range_type, tradeRecord.range_unit,
        tradeRecord.side, tradeRecord.entry_ask, tradeRecord.entry_bid,
        tradeRecord.entry_spread, tradeRecord.entry_volume,
        tradeRecord.shares, tradeRecord.cost, tradeRecord.entry_edge_pct,
        tradeRecord.entry_probability, tradeRecord.entry_kelly,
        tradeRecord.entry_forecast_temp, tradeRecord.entry_forecast_confidence,
        tradeRecord.entry_ensemble ? JSON.stringify(tradeRecord.entry_ensemble) : null,
        tradeRecord.entry_reason,
        tradeRecord.pct_of_volume,
        tradeRecord.hours_to_resolution,
        tradeRecord.entry_bid_depth ? JSON.stringify(tradeRecord.entry_bid_depth) : null,
        tradeRecord.entry_ask_depth ? JSON.stringify(tradeRecord.entry_ask_depth) : null,
        tradeRecord.status,
        tradeRecord.current_probability, tradeRecord.current_bid,
        tradeRecord.current_ask, tradeRecord.max_price_seen,
        tradeRecord.min_probability_seen, JSON.stringify(tradeRecord.evaluator_log),
      ]
    );

    if (error) {
      this._log('error', 'Failed to record trade', { error: error.message, city: opp.city });
      return null;
    }

    const tradeId = data.id;

    // Update the opportunity with the trade_id
    if (opp.opportunity_id) {
      await query(
        'UPDATE opportunities SET trade_id = $1 WHERE id = $2',
        [tradeId, opp.opportunity_id]
      );
    }

    // Adjust bankroll
    if (side === 'YES') {
      this.yesBankroll -= cost;
    } else {
      this.noBankroll -= cost;
      this.noExposureByDate[opp.target_date] = (this.noExposureByDate[opp.target_date] || 0) + cost;
    }

    this._log('info', `TRADE: ${side} ${opp.city} ${opp.range_name} [${opp.platform}]`, {
      ask: opp.ask,
      shares,
      cost: cost.toFixed(2),
      edge: opp.edge_pct.toFixed(1) + '%',
      prob: (opp.our_probability * 100).toFixed(1) + '%',
    });

    // Queue Telegram alert
    const fullTrade = { ...tradeRecord, id: tradeId };
    this.alerts.tradeEntry(fullTrade);

    return fullTrade;
  }

  /**
   * Execute guaranteed-win entries with fixed sizing (no Kelly).
   * Returns array of executed trades.
   */
  async executeGuaranteedWins(entries) {
    const trades = [];

    for (const entry of entries) {
      try {
        const trade = await this._executeGuaranteedSingle(entry);
        if (trade) trades.push(trade);
      } catch (err) {
        this._log('error', `Failed to execute guaranteed-win ${entry.city} ${entry.range_name}`, { error: err.message });
      }
    }

    if (trades.length > 0) {
      this._log('info', `Executed ${trades.length} guaranteed-win trades`);
    }

    return trades;
  }

  async _executeGuaranteedSingle(entry) {
    const side = entry.side;
    const bankroll = side === 'YES' ? this.yesBankroll : this.noBankroll;

    // Check bankroll
    if (bankroll <= config.sizing.MIN_BET) {
      this._log('warn', `Skipping guaranteed ${entry.city} ${entry.range_name} ${side}: bankroll depleted ($${bankroll.toFixed(2)})`);
      return null;
    }

    // Volume check
    if (!entry.volume || entry.volume === 0) {
      this._log('warn', `Skipping guaranteed ${entry.city} ${entry.range_name} ${side}: zero volume`);
      return null;
    }

    // Duplicate check against DB
    const { data: existing, error: dupError } = await query(
      `SELECT id FROM trades
       WHERE city = $1 AND target_date = $2 AND range_name = $3
         AND side = $4 AND platform = $5 AND status IN ($6, $7)
       LIMIT 1`,
      [entry.city, entry.target_date, entry.range_name, side, entry.platform, 'open', 'resolved']
    );

    if (dupError) {
      this._log('warn', `Guaranteed-win duplicate check failed for ${entry.city} ${entry.range_name}, skipping`, { error: dupError.message });
      return null;
    }
    if (existing && existing.length > 0) return null;

    // Mutual exclusivity: max 1 per side per city/date
    if (side === 'YES') {
      const { data: existingYes, error: yesError } = await query(
        `SELECT id, range_name FROM trades
         WHERE city = $1 AND target_date = $2 AND side = $3 AND status = $4
         LIMIT 1`,
        [entry.city, entry.target_date, 'YES', 'open']
      );

      if (!yesError && existingYes && existingYes.length > 0) {
        this._log('info', `Skipping guaranteed YES ${entry.city} ${entry.range_name}: already have YES on ${existingYes[0].range_name}`);
        return null;
      }
    }
    if (side === 'NO') {
      const { data: existingNo, error: noError } = await query(
        `SELECT id, range_name FROM trades
         WHERE city = $1 AND target_date = $2 AND side = $3 AND status = $4
         LIMIT 1`,
        [entry.city, entry.target_date, 'NO', 'open']
      );

      if (!noError && existingNo && existingNo.length > 0) {
        this._log('info', `Skipping guaranteed NO ${entry.city} ${entry.range_name}: already have NO on ${existingNo[0].range_name}`);
        return null;
      }
    }

    // Fixed sizing: MAX_BANKROLL_PCT of matching-side bankroll
    const fee = this.adapter.getEntryFee(entry.platform, entry.ask);
    const effectiveCost = entry.ask + fee;
    if (effectiveCost >= 1.0) return null;

    const dollars = Math.min(bankroll * config.guaranteed_entry.MAX_BANKROLL_PCT, bankroll);
    const shares = Math.floor(dollars / effectiveCost);
    if (shares <= 0) return null;

    const cost = Math.round(shares * entry.ask * 100) / 100;
    if (cost < config.sizing.MIN_BET) return null;

    // Simulate execution
    await this.adapter.executeBuy(entry);

    // Write trade record
    const tradeRecord = {
      city: entry.city,
      target_date: entry.target_date,
      platform: entry.platform,
      market_id: entry.market_id,
      token_id: entry.token_id,
      range_name: entry.range_name,
      range_min: entry.range_min,
      range_max: entry.range_max,
      range_type: entry.range_type,
      range_unit: entry.range_unit,
      side,
      entry_ask: entry.ask,
      entry_bid: entry.bid,
      entry_spread: entry.spread,
      entry_volume: entry.volume,
      shares,
      cost,
      entry_edge_pct: Math.round(entry.margin * 10000) / 100, // margin as edge proxy
      entry_probability: 1.0, // guaranteed
      entry_kelly: null,
      entry_forecast_temp: null,
      entry_forecast_confidence: null,
      entry_ensemble: null,
      entry_reason: 'guaranteed_win',
      observation_high: entry.observation_high,
      wu_high: entry.wu_high,
      dual_confirmed: entry.dual_confirmed,
      pct_of_volume: entry.volume > 0 ? Math.round((shares / entry.volume) * 1000) / 10 : null,
      status: 'open',
      current_probability: 1.0,
      current_bid: entry.bid,
      current_ask: entry.ask,
      max_price_seen: entry.bid,
      min_probability_seen: 1.0,
      evaluator_log: [],
    };

    const { data, error } = await queryOne(
      `INSERT INTO trades (
        city, target_date, platform, market_id, token_id,
        range_name, range_min, range_max, range_type, range_unit,
        side, entry_ask, entry_bid, entry_spread, entry_volume,
        shares, cost, entry_edge_pct, entry_probability, entry_kelly,
        entry_forecast_temp, entry_forecast_confidence, entry_ensemble,
        entry_reason, observation_high, wu_high, dual_confirmed,
        pct_of_volume, status, current_probability, current_bid, current_ask,
        max_price_seen, min_probability_seen, evaluator_log
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
        $29,$30,$31,$32,$33,$34,$35
      ) RETURNING id`,
      [
        tradeRecord.city, tradeRecord.target_date, tradeRecord.platform,
        tradeRecord.market_id, tradeRecord.token_id,
        tradeRecord.range_name, tradeRecord.range_min, tradeRecord.range_max,
        tradeRecord.range_type, tradeRecord.range_unit,
        tradeRecord.side, tradeRecord.entry_ask, tradeRecord.entry_bid,
        tradeRecord.entry_spread, tradeRecord.entry_volume,
        tradeRecord.shares, tradeRecord.cost, tradeRecord.entry_edge_pct,
        tradeRecord.entry_probability, tradeRecord.entry_kelly,
        tradeRecord.entry_forecast_temp, tradeRecord.entry_forecast_confidence,
        tradeRecord.entry_ensemble ? JSON.stringify(tradeRecord.entry_ensemble) : null,
        tradeRecord.entry_reason,
        tradeRecord.observation_high, tradeRecord.wu_high, tradeRecord.dual_confirmed,
        tradeRecord.pct_of_volume, tradeRecord.status,
        tradeRecord.current_probability, tradeRecord.current_bid,
        tradeRecord.current_ask, tradeRecord.max_price_seen,
        tradeRecord.min_probability_seen, JSON.stringify(tradeRecord.evaluator_log),
      ]
    );

    if (error) {
      this._log('error', 'Failed to record guaranteed-win trade', { error: error.message, city: entry.city });
      return null;
    }

    const tradeId = data.id;

    // Adjust bankroll
    if (side === 'YES') {
      this.yesBankroll -= cost;
    } else {
      this.noBankroll -= cost;
      this.noExposureByDate[entry.target_date] = (this.noExposureByDate[entry.target_date] || 0) + cost;
    }

    this._log('info', `GUARANTEED TRADE: ${side} ${entry.city} ${entry.range_name} [${entry.platform}]`, {
      ask: entry.ask,
      shares,
      cost: cost.toFixed(2),
      margin: (entry.margin * 100).toFixed(1) + '%',
      obsHigh: entry.observation_high,
      wuHigh: entry.wu_high,
      dualConfirmed: entry.dual_confirmed,
    });

    // Queue Telegram alert
    const fullTrade = { ...tradeRecord, id: tradeId };
    this.alerts.tradeEntry(fullTrade);

    return fullTrade;
  }

  /**
   * Calculate position size using Kelly criterion with caps.
   * Returns { shares, cost } or null if below MIN_BET.
   */
  _calculateSize(opp, bankroll) {
    const ask = opp.ask;
    const entryFee = this.adapter.getEntryFee(opp.platform, ask);
    const effectiveCost = ask + entryFee;
    const payout = 1.0; // no settlement fee
    const netProfit = payout - effectiveCost;
    if (netProfit <= 0) return null; // can't profit at this price

    let kellyFraction;

    // Use scanner's pre-computed kelly_fraction when available (includes calibration corrections)
    if (opp.kelly_fraction > 0) {
      kellyFraction = opp.kelly_fraction;
    } else {
      // Fallback: recalculate from raw probability (NO trades, or uncalibrated YES)
      const probability = opp.our_probability;
      const b = netProfit / effectiveCost;
      let kellyFull = (b * probability - (1 - probability)) / b;
      if (kellyFull <= 0) return null;
      kellyFraction = kellyFull * config.sizing.KELLY_FRACTION;
    }

    // Cap at MAX_BANKROLL_PCT
    kellyFraction = Math.min(kellyFraction, config.sizing.MAX_BANKROLL_PCT);

    // Dollar amount
    let dollars = bankroll * kellyFraction;

    // Cap at remaining per-date allowance for NO trades
    if (opp.side === 'NO') {
      const dateExposure = this.noExposureByDate[opp.target_date] || 0;
      const remaining = config.sizing.NO_MAX_PER_DATE - dateExposure;
      dollars = Math.min(dollars, remaining);
    }

    // Cap at available bankroll
    dollars = Math.min(dollars, bankroll);

    // Floor at MIN_BET
    if (dollars < config.sizing.MIN_BET) return null;

    // Calculate shares — divide by effectiveCost (ask + fee) so we don't over-buy
    const shares = Math.floor(dollars / effectiveCost);
    if (shares <= 0) return null;

    // Record cost as contract cost only (shares * ask); fees tracked separately in resolver P&L
    const cost = shares * ask;

    return { shares, cost: Math.round(cost * 100) / 100 };
  }
}

module.exports = Executor;
