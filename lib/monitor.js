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
      exit_type: shouldExit ? 'edge_gone' : null,
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

    // ── Observation signals (from METAR observer) ────────────────
    const obs = await this._getLatestObservation(trade.city, trade.target_date);
    if (obs) {
      logEntry.running_high_f = obs.running_high_f;
      logEntry.running_high_c = obs.running_high_c;
      logEntry.hours_remaining = forecast?.hoursToResolution || null;

      const decision = this._checkAlreadyDecided(trade, obs.running_high_f, obs.running_high_c);
      logEntry.observation_signal = decision;

      if (decision === 'guaranteed_loss') {
        const high = trade.range_unit === 'F' ? obs.running_high_f : obs.running_high_c;
        logEntry.action = 'recommend_exit';
        logEntry.exit_type = 'guaranteed_loss';
        logEntry.reason = `Running high ${high}° already excludes ${trade.range_name}`;
        this._log('warn', `GUARANTEED LOSS: ${trade.side} ${trade.city} ${trade.range_name}`, {
          runningHigh: high + '°' + (trade.range_unit || 'F'),
          range: `${trade.range_min || '...'}-${trade.range_max || '...'}`,
        });
      } else if (decision === 'guaranteed_win') {
        const highW = trade.range_unit === 'F' ? obs.running_high_f : obs.running_high_c;
        logEntry.action = 'recommend_exit';
        logEntry.exit_type = 'guaranteed_win';
        logEntry.reason = `Running high ${highW}° confirms ${trade.range_name} — guaranteed win`;
        this._log('info', `GUARANTEED WIN: ${trade.side} ${trade.city} ${trade.range_name}`, {
          runningHigh: highW + '°' + (trade.range_unit || 'F'),
        });
      }
    }

    // ── Take-Profit signal detection ─────────────────────────────
    // Only fires if not already guaranteed_loss or guaranteed_win
    if (logEntry.action !== 'recommend_exit' || logEntry.exit_type === 'edge_gone') {
      if (logEntry.observation_signal !== 'guaranteed_win') {
        const tpResult = this._checkTakeProfit(trade, marketBid, obs, forecast);
        if (tpResult) {
          logEntry.tp_signal = tpResult.signal;
          logEntry.tp_bid = Math.round(marketBid * 10000) / 10000;
          logEntry.tp_entry_ask = trade.entry_ask;
          logEntry.tp_return_pct = ((marketBid - trade.entry_ask) / trade.entry_ask * 100).toFixed(1);
          logEntry.tp_unrealized_pnl = ((marketBid * trade.shares) - trade.cost).toFixed(2);

          // TP overrides edge_gone but not guaranteed_loss
          if (logEntry.exit_type !== 'guaranteed_loss') {
            logEntry.action = 'recommend_tp';
            logEntry.exit_type = 'take_profit';
            logEntry.reason = tpResult.reason;
          }

          // Console logging
          const returnPct = ((marketBid - trade.entry_ask) / trade.entry_ask * 100).toFixed(0);
          const unrealized = ((marketBid * trade.shares) - trade.cost).toFixed(2);
          this._log('info', `TP SIGNAL: ${tpResult.signal} — ${trade.side} ${trade.city} ${trade.range_name} [${trade.platform}]`);
          this._log('info', `  Entry: ${(trade.entry_ask * 100).toFixed(0)}¢ → Bid: ${(marketBid * 100).toFixed(0)}¢ (${returnPct}% return), Unrealized: ${unrealized >= 0 ? '+' : ''}$${unrealized}`);
          if (obs && tpResult.obsDetail) {
            this._log('info', `  ${tpResult.obsDetail}`);
          }
        }
      }
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

    // Append to evaluator log (keep last 500 entries — covers ~58 hours at 7-min intervals)
    const existingLog = trade.evaluator_log || [];
    const newLog = [...existingLog, logEntry].slice(-500);
    updates.evaluator_log = newLog;

    // Execute or log based on per-signal config
    const shouldAct = logEntry.action === 'recommend_exit' || logEntry.action === 'recommend_tp';
    const activeSignals = config.exit.ACTIVE_SIGNALS || [];
    const signalIsActive = activeSignals.includes(logEntry.exit_type);
    const globalActive = config.exit.EVALUATOR_MODE === 'active';

    let exitExecuted = false;
    if (shouldAct && (signalIsActive || globalActive)) {
      if (logEntry.exit_type === 'guaranteed_win') {
        // Guaranteed win: resolve at $1 payout, no reason to sell early
        exitExecuted = await this._resolveGuaranteed(trade, logEntry.exit_type, currentProbability, forecast);
      } else if (logEntry.exit_type === 'guaranteed_loss') {
        // Guaranteed loss: sell at bid to recover whatever we can
        exitExecuted = await this._executeExit(trade, price, currentProbability, forecast, 'guaranteed_loss');
      } else {
        // Other exits (edge_gone, take_profit): sell at bid
        exitExecuted = await this._executeExit(trade, price, currentProbability, forecast);
      }
      if (exitExecuted) {
        return 'exit'; // Skip DB update — resolution method already wrote status
      }
    } else if (logEntry.action === 'recommend_exit' && logEntry.exit_type === 'edge_gone') {
      // Log-only mode: edge-gone recommendation
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

    return 'hold'; // Only return 'exit' when actually executed above
  }

  /**
   * Get latest METAR observation for a city/date from metar_observations table.
   */
  async _getLatestObservation(city, targetDate) {
    try {
      const { data, error } = await db
        .from('metar_observations')
        .select('running_high_c, running_high_f, temp_c, temp_f, observed_at, observation_count')
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
   * Check if a trade is already decided based on running high temperature.
   * Returns 'guaranteed_win' | 'guaranteed_loss' | 'undecided'
   */
  _checkAlreadyDecided(trade, runningHighF, runningHighC) {
    const high = trade.range_unit === 'C' ? runningHighC : runningHighF;

    if (trade.side === 'YES') {
      // YES on unbounded upper ("X or higher"): high >= threshold = guaranteed win
      if (trade.range_max == null && trade.range_min != null && high >= trade.range_min) {
        return 'guaranteed_win';
      }
      // YES on unbounded lower ("X or below"): high > max = guaranteed loss
      if (trade.range_min == null && trade.range_max != null && high > trade.range_max) {
        return 'guaranteed_loss';
      }
      // YES on bounded ("X-Y"): high > range_max = guaranteed loss
      if (trade.range_max != null && trade.range_min != null && high > trade.range_max) {
        return 'guaranteed_loss';
      }
    }

    if (trade.side === 'NO') {
      // NO on bounded: high > range_max = guaranteed win (YES loses)
      if (trade.range_max != null && trade.range_min != null && high > trade.range_max) {
        return 'guaranteed_win';
      }
      // NO on unbounded upper: high >= threshold = guaranteed loss (YES wins)
      if (trade.range_max == null && trade.range_min != null && high >= trade.range_min) {
        return 'guaranteed_loss';
      }
    }

    return 'undecided';
  }

  /**
   * Check for take-profit signals. Returns { signal, reason, obsDetail } or null.
   */
  _checkTakeProfit(trade, marketBid, obs, forecast) {
    const entryAsk = trade.entry_ask || (trade.cost / trade.shares);
    const hoursRemaining = forecast?.hoursToResolution || null;
    const maxPriceSeen = trade.max_price_seen || 0;

    let obsSignal = null;
    let marketSignal = null;
    let obsDetail = null;

    // ── Observation-based TP (need obs data) ──────────────────────
    if (obs) {
      const high = trade.range_unit === 'C' ? obs.running_high_c : obs.running_high_f;
      const unitLabel = trade.range_unit || 'F';

      // 1. Unbounded YES upper: running high >= threshold → threshold crossed
      if (trade.side === 'YES' && trade.range_max == null && trade.range_min != null && high >= trade.range_min) {
        obsSignal = 'obs_threshold_crossed';
        obsDetail = `Running high: ${high}°${unitLabel} >= threshold ${trade.range_min}°${unitLabel}`;
      }

      // 2. Bounded range: running high INSIDE range + hours < 4 + bid > 2x entry
      if (!obsSignal && trade.range_min != null && trade.range_max != null) {
        const inRange = high >= trade.range_min && high <= trade.range_max;
        if (inRange && hoursRemaining != null && hoursRemaining < 4 && marketBid > entryAsk * 2) {
          obsSignal = 'obs_in_range_strong';
          obsDetail = `Running high: ${high}°${unitLabel} (in range ${trade.range_min}-${trade.range_max}°${unitLabel}), ${hoursRemaining.toFixed(1)}hrs remaining`;
        }

        // 3. Running high within 1° of boundary + trending up
        if (!obsSignal && obs.temp_f != null) {
          const currentTemp = trade.range_unit === 'C' ? obs.temp_c : obs.temp_f;
          const nearMax = trade.range_max != null && Math.abs(high - trade.range_max) <= 1;
          const nearMin = trade.range_min != null && Math.abs(high - trade.range_min) <= 1;
          const trendingUp = currentTemp > high; // current reading exceeds running high = still climbing

          if ((nearMax || nearMin) && trendingUp) {
            obsSignal = 'obs_near_boundary_risk';
            obsDetail = `Running high: ${high}°${unitLabel} near boundary, current temp ${currentTemp}°${unitLabel} trending up`;
          }
        }
      }
    }

    // ── Market-based TP (all trade types) ─────────────────────────
    // 1. Bid > 3x entry ask
    if (marketBid > entryAsk * 3) {
      marketSignal = 'bid_3x_entry';
    }
    // 2. Bid dropped 20%+ from peak (only if peak was meaningful: > 1.5x entry)
    else if (maxPriceSeen > entryAsk * 1.5 && marketBid < maxPriceSeen * 0.8) {
      marketSignal = 'bid_declining_from_peak';
    }
    // 3. Bid > 50¢ and entry < 20¢
    else if (marketBid > 0.50 && entryAsk < 0.20) {
      marketSignal = 'bid_high_value';
    }

    // ── Combined signal ──────────────────────────────────────────
    if (obsSignal && marketSignal) {
      return {
        signal: 'combined_obs_market',
        reason: `Combined TP: ${obsSignal} + ${marketSignal}`,
        obsDetail,
      };
    }

    if (obsSignal) {
      return { signal: obsSignal, reason: `Observation TP: ${obsSignal}`, obsDetail };
    }

    if (marketSignal) {
      return { signal: marketSignal, reason: `Market TP: ${marketSignal}`, obsDetail: null };
    }

    return null;
  }

  /**
   * Resolve a guaranteed outcome. Win pays $1/share, loss pays $0.
   */
  async _resolveGuaranteed(trade, signal, currentProbability, forecast) {
    const isWin = signal === 'guaranteed_win';
    const payout = isWin ? 1.00 : 0.00;
    const pnl = Math.round((payout * trade.shares - trade.cost) * 100) / 100;
    const now = new Date().toISOString();

    const exitData = {
      status: 'resolved',
      exit_reason: signal,
      exit_price: payout,
      exit_bid: trade.current_bid,
      exit_ask: trade.current_ask,
      exit_probability: currentProbability,
      exit_forecast_temp: forecast?.temp || null,
      exited_at: now,
      pnl,
      fees: 0,
    };

    const { error } = await db
      .from('trades')
      .update(exitData)
      .eq('id', trade.id);

    if (error) {
      this._log('error', `Failed to resolve ${signal}`, { error: error.message, tradeId: trade.id });
      return false;
    }

    this._log('info', `RESOLVED (${signal}): ${trade.side} ${trade.city} ${trade.range_name} [${trade.platform}]`, {
      entry: (trade.entry_ask * 100).toFixed(0) + '¢',
      payout: '$' + payout.toFixed(2),
      pnl: (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2),
    });

    this.alerts.tradeExit({
      ...trade,
      exit_reason: signal,
      exit_price: payout,
      pnl,
      fees: 0,
    });

    return true;
  }

  /**
   * Execute an exit. Update trade record with exit data + P&L.
   */
  async _executeExit(trade, price, currentProbability, forecast, exitReason = 'evaluator') {
    const exitBid = trade.side === 'YES' ? price.bid : (1 - price.ask);
    const exitAsk = trade.side === 'YES' ? price.ask : (1 - price.bid);
    const isGuaranteed = exitReason === 'guaranteed_loss';

    // Check spread — don't force exit into bad spread (skip for guaranteed loss — dump it regardless)
    if (!isGuaranteed && price.spread > config.entry.MAX_SPREAD * 2) {
      this._log('warn', `Exit delayed — spread too wide: ${(price.spread * 100).toFixed(0)}¢`, {
        city: trade.city, range: trade.range_name,
      });
      return false;
    }

    // Check bid — need a minimum price to bother selling (skip for guaranteed loss — take whatever's there)
    if (!isGuaranteed && exitBid < 0.02) {
      this._log('warn', `Exit delayed — bid too low: ${(exitBid * 100).toFixed(0)}¢`, {
        city: trade.city, range: trade.range_name,
      });
      return false;
    }

    // Calculate P&L — early exit pays fee on BOTH entry and exit (Kalshi); Polymarket = 0
    const entryPrice = trade.entry_ask || (trade.cost / trade.shares);
    const entryFeePerContract = this.adapter.getEntryFee(trade.platform, entryPrice);
    const exitFeePerContract = this.adapter.getEntryFee(trade.platform, exitBid);
    const totalFees = Math.round(trade.shares * (entryFeePerContract + exitFeePerContract) * 100) / 100;
    const revenue = exitBid * trade.shares;
    const pnl = revenue - trade.cost - totalFees;

    const now = new Date().toISOString();

    const exitData = {
      status: 'exited',
      exit_reason: exitReason,
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

    this._log('info', `EXIT (${exitReason}): ${trade.side} ${trade.city} ${trade.range_name} [${trade.platform}]`, {
      entry: (trade.entry_ask * 100).toFixed(0) + '¢',
      exit: (exitBid * 100).toFixed(0) + '¢',
      pnl: (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2),
    });

    // Queue Telegram alert
    this.alerts.tradeExit({
      ...trade,
      exit_reason: exitReason,
      exit_price: exitBid,
      pnl,
      fees: totalFees,
    });

    return true;
  }
}

module.exports = Monitor;
