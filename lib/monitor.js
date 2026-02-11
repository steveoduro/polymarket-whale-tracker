/**
 * monitor.js — Unified exit evaluator for all open positions
 *
 * For each open trade, every scan cycle:
 * 1. Get current market price from platform adapter
 * 2. Get current forecast from forecast engine
 * 3. Recalculate probability with latest forecast
 * 4. Compare current probability vs current market price
 * 5. Log every evaluation to evaluator_log JSONB
 *
 * EVALUATOR_MODE 'log_only': Log recommendations, don't execute exits.
 * EVALUATOR_MODE 'active': Execute exits when edge is gone.
 */

const config = require('../config');
const { db } = require('./db');

class Monitor {
  constructor(platformAdapter, forecastEngine, alerts) {
    this.adapter = platformAdapter;
    this.forecast = forecastEngine;
    this.alerts = alerts;
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const label = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[MONITOR]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Evaluate all open positions. Returns { evaluated, exits, holds }.
   */
  async evaluate() {
    let evaluated = 0;
    let exits = 0;
    let holds = 0;

    // Fetch all open trades
    const { data: openTrades, error } = await db
      .from('trades')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: true });

    if (error) {
      this._log('error', 'Failed to fetch open trades', { error: error.message });
      return { evaluated: 0, exits: 0, holds: 0 };
    }

    if (!openTrades || openTrades.length === 0) {
      return { evaluated: 0, exits: 0, holds: 0 };
    }

    this._log('info', `Evaluating ${openTrades.length} open positions`);

    for (const trade of openTrades) {
      try {
        const result = await this._evaluateSingle(trade);
        evaluated++;
        if (result === 'exit') exits++;
        else holds++;
      } catch (err) {
        this._log('error', `Evaluate failed for ${trade.city} ${trade.range_name}`, { error: err.message });
      }
    }

    this._log('info', `Evaluation complete`, { evaluated, exits, holds });
    return { evaluated, exits, holds };
  }

  /**
   * Evaluate a single open trade. Returns 'hold' or 'exit'.
   */
  async _evaluateSingle(trade) {
    // Get current market price
    const price = await this.adapter.getPrice(trade.platform, trade.market_id || trade.token_id);
    if (!price) {
      this._log('warn', `No price for ${trade.city} ${trade.range_name} [${trade.platform}]`);
      return 'hold';
    }

    // Get current forecast
    const forecast = await this.forecast.getForecast(trade.city, trade.target_date);

    // Recalculate probability
    let currentProbability = trade.current_probability || trade.entry_probability;
    if (forecast) {
      currentProbability = this.forecast.calculateProbability(
        forecast.temp, forecast.stdDev,
        trade.range_min, trade.range_max,
        forecast.unit
      );

      // For NO trades, invert
      if (trade.side === 'NO') {
        currentProbability = 1 - currentProbability;
      }
    }

    // Market price for our position
    const marketBid = trade.side === 'YES' ? price.bid : (1 - price.ask);
    const marketAsk = trade.side === 'YES' ? price.ask : (1 - price.bid);
    const spread = price.spread;

    // Decision: does edge still exist?
    const edgeRemaining = currentProbability - marketAsk;
    const shouldExit = edgeRemaining < -0.05; // Edge is gone by >5 percentage points

    // Build evaluator log entry
    const logEntry = {
      ts: new Date().toISOString(),
      action: shouldExit ? 'recommend_exit' : 'hold',
      prob: Math.round(currentProbability * 10000) / 10000,
      bid: Math.round(marketBid * 10000) / 10000,
      ask: Math.round(marketAsk * 10000) / 10000,
      spread: Math.round(spread * 10000) / 10000,
      edge: Math.round(edgeRemaining * 10000) / 10000,
      reason: shouldExit
        ? `Edge gone: prob ${(currentProbability * 100).toFixed(1)}% < ask ${(marketAsk * 100).toFixed(1)}% by ${(Math.abs(edgeRemaining) * 100).toFixed(1)}pp`
        : `Edge holds: prob ${(currentProbability * 100).toFixed(1)}% vs ask ${(marketAsk * 100).toFixed(1)}%`,
    };

    if (forecast) {
      logEntry.forecast_temp = forecast.temp;
      logEntry.forecast_confidence = forecast.confidence;
    }

    // Update trade record
    const updates = {
      current_probability: currentProbability,
      current_bid: marketBid,
      current_ask: marketAsk,
    };

    // Track max price and min probability
    if (!trade.max_price_seen || marketBid > trade.max_price_seen) {
      updates.max_price_seen = marketBid;
    }
    if (!trade.min_probability_seen || currentProbability < trade.min_probability_seen) {
      updates.min_probability_seen = currentProbability;
    }

    // Append to evaluator log (keep last 100 entries)
    const existingLog = trade.evaluator_log || [];
    const newLog = [...existingLog, logEntry].slice(-100);
    updates.evaluator_log = newLog;

    // Execute or log based on mode
    if (shouldExit && config.exit.EVALUATOR_MODE === 'active') {
      // Active mode: execute the exit
      const exitResult = await this._executeExit(trade, price, currentProbability, forecast);
      if (exitResult) {
        return 'exit';
      }
    } else if (shouldExit) {
      // Log-only mode: just record the recommendation
      this._log('info', `WOULD EXIT: ${trade.side} ${trade.city} ${trade.range_name}`, {
        prob: (currentProbability * 100).toFixed(1) + '%',
        bid: (marketBid * 100).toFixed(0) + '¢',
        edge: (edgeRemaining * 100).toFixed(1) + '%',
      });
    }

    // Update trade in DB
    const { error } = await db
      .from('trades')
      .update(updates)
      .eq('id', trade.id);

    if (error) {
      this._log('warn', `Failed to update trade ${trade.id}`, { error: error.message });
    }

    return shouldExit ? 'exit' : 'hold';
  }

  /**
   * Execute an exit. Update trade record with exit data + P&L.
   */
  async _executeExit(trade, price, currentProbability, forecast) {
    const exitBid = trade.side === 'YES' ? price.bid : (1 - price.ask);
    const exitAsk = trade.side === 'YES' ? price.ask : (1 - price.bid);

    // Check spread — don't force exit into bad spread
    if (price.spread > config.entry.MAX_SPREAD * 2) {
      this._log('warn', `Exit delayed — spread too wide: ${(price.spread * 100).toFixed(0)}¢`, {
        city: trade.city, range: trade.range_name,
      });
      return false;
    }

    // Check bid — need a minimum price to bother selling
    if (exitBid < 0.02) {
      this._log('warn', `Exit delayed — bid too low: ${(exitBid * 100).toFixed(0)}¢`, {
        city: trade.city, range: trade.range_name,
      });
      return false;
    }

    // Calculate P&L
    const feeRate = this.adapter.getFeeRate(trade.platform);
    const revenue = exitBid * trade.shares;
    const exitFees = revenue * feeRate;
    const entryFees = trade.cost * feeRate;
    const totalFees = entryFees + exitFees;
    const pnl = revenue - trade.cost - totalFees;

    const now = new Date().toISOString();

    const exitData = {
      status: 'exited',
      exit_reason: 'evaluator',
      exit_price: exitBid,
      exit_bid: exitBid,
      exit_ask: exitAsk,
      exit_spread: price.spread,
      exit_volume: price.volume,
      exit_probability: currentProbability,
      exit_forecast_temp: forecast?.temp || null,
      exited_at: now,
      pnl: Math.round(pnl * 100) / 100,
      fees: Math.round(totalFees * 100) / 100,
    };

    const { error } = await db
      .from('trades')
      .update(exitData)
      .eq('id', trade.id);

    if (error) {
      this._log('error', `Failed to record exit`, { error: error.message, tradeId: trade.id });
      return false;
    }

    this._log('info', `EXIT: ${trade.side} ${trade.city} ${trade.range_name} [${trade.platform}]`, {
      entry: (trade.entry_ask * 100).toFixed(0) + '¢',
      exit: (exitBid * 100).toFixed(0) + '¢',
      pnl: (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2),
    });

    // Queue Telegram alert
    this.alerts.tradeExit({
      ...trade,
      exit_reason: 'evaluator',
      exit_price: exitBid,
      pnl,
      fees: totalFees,
    });

    return true;
  }
}

module.exports = Monitor;
