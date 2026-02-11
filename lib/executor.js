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
const { db } = require('./db');

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
      const { data: openTrades, error } = await db
        .from('trades')
        .select('side, cost, target_date')
        .eq('status', 'open');

      if (error) {
        this._log('warn', 'Failed to load open trades for bankroll init', { error: error.message });
        return;
      }

      let yesDeployed = 0;
      let noDeployed = 0;

      for (const t of openTrades || []) {
        if (t.side === 'YES') {
          yesDeployed += t.cost;
        } else {
          noDeployed += t.cost;
          const dateKey = t.target_date;
          this.noExposureByDate[dateKey] = (this.noExposureByDate[dateKey] || 0) + t.cost;
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

    // Check for duplicate: same city/date/range/side/platform already open
    const { data: existing } = await db
      .from('trades')
      .select('id')
      .eq('city', opp.city)
      .eq('target_date', opp.target_date)
      .eq('range_name', opp.range_name)
      .eq('side', side)
      .eq('platform', opp.platform)
      .eq('status', 'open')
      .limit(1);

    if (existing && existing.length > 0) {
      return null; // Already have this position open
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
      entry_probability: opp.our_probability,
      entry_kelly: opp.kelly_fraction,
      entry_forecast_temp: opp.forecast_temp,
      entry_forecast_confidence: opp.forecast_confidence,
      entry_ensemble: opp.forecast_sources,
      pct_of_volume: pctOfVolume,
      hours_to_resolution: opp.hours_to_resolution || null,
      status: 'open',
      current_probability: opp.our_probability,
      current_bid: opp.bid,
      current_ask: opp.ask,
      max_price_seen: opp.bid,
      min_probability_seen: opp.our_probability,
      evaluator_log: [],
    };

    const { data, error } = await db
      .from('trades')
      .insert(tradeRecord)
      .select('id')
      .single();

    if (error) {
      this._log('error', 'Failed to record trade', { error: error.message, city: opp.city });
      return null;
    }

    const tradeId = data.id;

    // Update the opportunity with the trade_id
    if (opp.opportunity_id) {
      await db
        .from('opportunities')
        .update({ trade_id: tradeId })
        .eq('id', opp.opportunity_id);
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
   * Calculate position size using Kelly criterion with caps.
   * Returns { shares, cost } or null if below MIN_BET.
   */
  _calculateSize(opp, bankroll) {
    const ask = opp.ask;
    const probability = opp.our_probability;
    const feeRate = this.adapter.getFeeRate(opp.platform);
    const payout = 1 - feeRate;

    // Kelly: f* = (p * payout - (1-p)) / payout
    let kellyFull = (probability * payout - (1 - probability)) / payout;
    if (kellyFull <= 0) return null;

    // Apply Kelly fraction (half-Kelly by default)
    let kellyFraction = kellyFull * config.sizing.KELLY_FRACTION;

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

    // Calculate shares (buying at ask price)
    const shares = Math.floor(dollars / ask);
    if (shares <= 0) return null;

    const cost = shares * ask;

    return { shares, cost: Math.round(cost * 100) / 100 };
  }
}

module.exports = Executor;
