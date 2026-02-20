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
const { query } = require('./db');

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

    // Load market calibration for calConfirmsEdge checks
    this._calibration = await this._loadCalibration();

    // Fetch all open trades
    const { data: openTrades, error } = await query(
      `SELECT * FROM trades WHERE status = $1 ORDER BY created_at ASC`,
      ['open']
    );

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
        forecast.unit, trade.city
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

    // Decision: is expected value of holding > selling at bid?
    const evHold = currentProbability;         // Expected value per share if held to resolution ($1 x prob)
    const sellNowValue = marketBid;            // What we get per share if we sell now
    const evAdvantage = evHold - sellNowValue;  // Positive = holding is better, negative = selling is better
    let shouldExit = evAdvantage < -0.05;       // Sell if expected hold value is 5pp+ below bid

    // calConfirmsEdge override: suppress edge_gone for YES trades when market
    // calibration says empirical win rate > current bid (holding beats selling)
    let calOverride = null;
    if (shouldExit && trade.side === 'YES' && forecast?.hoursToResolution != null) {
      const cal = this._getCalibration(trade.range_type, forecast.hoursToResolution, trade.entry_ask, trade.platform);
      if (cal && cal.n >= config.calibration.CAL_CONFIRMS_MIN_N && Number(cal.empirical_win_rate) > marketBid) {
        shouldExit = false;
        calOverride = {
          emp_win_rate: Number(cal.empirical_win_rate),
          bucket: `${trade.platform}|${trade.range_type}|${cal.lead_time_bucket}|${cal.price_bucket}`,
          n: cal.n,
        };
      }
    }

    // Build evaluator log entry
    const logEntry = {
      ts: new Date().toISOString(),
      action: shouldExit ? 'recommend_exit' : 'hold',
      exit_type: shouldExit ? 'edge_gone' : null,
      prob: Math.round(currentProbability * 10000) / 10000,
      bid: Math.round(marketBid * 10000) / 10000,
      ask: Math.round(marketAsk * 10000) / 10000,
      spread: Math.round(spread * 10000) / 10000,
      edge: Math.round(evAdvantage * 10000) / 10000,
      ev_hold: Math.round(currentProbability * 10000) / 10000,
      sell_now: Math.round(marketBid * 10000) / 10000,
      ev_advantage: Math.round(evAdvantage * 10000) / 10000,
      position_pnl_if_sell: Math.round((marketBid * trade.shares - trade.cost) * 100) / 100,
      position_pnl_if_win: Math.round((1.0 * trade.shares - trade.cost) * 100) / 100,
      reason: shouldExit
        ? `Edge gone: EV ${(currentProbability * 100).toFixed(1)}% vs bid ${(marketBid * 100).toFixed(1)}% (${(Math.abs(evAdvantage) * 100).toFixed(1)}pp, selling better)`
        : `Edge holds: EV ${(currentProbability * 100).toFixed(1)}% vs bid ${(marketBid * 100).toFixed(1)}% (+${(evAdvantage * 100).toFixed(1)}pp advantage to hold)`,
    };

    if (calOverride) {
      logEntry.cal_override = true;
      logEntry.cal_emp_win_rate = calOverride.emp_win_rate;
      logEntry.cal_bucket = calOverride.bucket;
      logEntry.cal_n = calOverride.n;
      logEntry.reason = `Cal override: model EV ${(currentProbability * 100).toFixed(1)}% but emp_win_rate ${(calOverride.emp_win_rate * 100).toFixed(1)}% > bid ${(marketBid * 100).toFixed(1)}% (${calOverride.bucket}, n=${calOverride.n}) — hold`;
    }

    if (forecast) {
      logEntry.forecast_temp = forecast.temp;
      logEntry.forecast_confidence = forecast.confidence;
    }

    // -- Observation signals (from METAR observer) ----------------
    const obs = await this._getLatestObservation(trade.city, trade.target_date);
    if (obs) {
      logEntry.running_high_f = obs.running_high_f;
      logEntry.running_high_c = obs.running_high_c;
      logEntry.wu_high_f = obs.wu_high_f;
      logEntry.wu_high_c = obs.wu_high_c;
      logEntry.hours_remaining = forecast?.hoursToResolution || null;

      const decision = this._checkAlreadyDecided(trade, obs);
      logEntry.observation_signal = decision;

      if (decision === 'guaranteed_loss') {
        const wuH = trade.range_unit === 'F' ? obs.wu_high_f : obs.wu_high_c;
        const runH = trade.range_unit === 'F' ? obs.running_high_f : obs.running_high_c;
        const triggerHigh = wuH ?? runH;
        logEntry.action = 'recommend_exit';
        logEntry.exit_type = 'guaranteed_loss';
        logEntry.wu_high = wuH;
        logEntry.reason = `WU high ${triggerHigh}° already excludes ${trade.range_name}`;
        this._log('warn', `GUARANTEED LOSS: ${trade.side} ${trade.city} ${trade.range_name}`, {
          source: 'WU',
          high: triggerHigh + '°' + (trade.range_unit || 'F'),
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

    // -- Near-resolution hold override ----------------------------
    // If bid is high and resolution is near, hold to $1 instead of selling
    const hoursRemaining = forecast?.hoursToResolution || null;
    if (marketBid >= 0.85 && hoursRemaining != null && hoursRemaining <= 12
        && logEntry.observation_signal !== 'guaranteed_loss'
        && logEntry.observation_signal !== 'guaranteed_win') {
      logEntry.action = 'hold';
      logEntry.exit_type = null;
      logEntry.near_resolution_hold = true;
      const pnlIfSell = (marketBid * trade.shares - trade.cost);
      const pnlIfWin = (1.0 * trade.shares - trade.cost);
      logEntry.reason = `Approaching resolution: bid ${(marketBid * 100).toFixed(0)}¢ with ${hoursRemaining.toFixed(1)}hrs remaining — hold to $1 (+$${pnlIfWin.toFixed(2)} if win vs +$${pnlIfSell.toFixed(2)} if sell now)`;
    }

    // -- Take-Profit signal detection -----------------------------
    // Only fires if not already guaranteed_loss, guaranteed_win, or near-resolution hold
    if (!logEntry.near_resolution_hold && (logEntry.action !== 'recommend_exit' || logEntry.exit_type === 'edge_gone')) {
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

    // Update trade record — build SET clause dynamically
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    // Always-present fields
    setClauses.push(`current_probability = $${paramIdx++}`);
    params.push(currentProbability);

    setClauses.push(`current_bid = $${paramIdx++}`);
    params.push(marketBid);

    setClauses.push(`current_ask = $${paramIdx++}`);
    params.push(marketAsk);

    // Track max price (only if new high)
    if (!trade.max_price_seen || marketBid > trade.max_price_seen) {
      setClauses.push(`max_price_seen = $${paramIdx++}`);
      params.push(marketBid);
    }

    // Track min probability (only if new low)
    if (!trade.min_probability_seen || currentProbability < trade.min_probability_seen) {
      setClauses.push(`min_probability_seen = $${paramIdx++}`);
      params.push(currentProbability);
    }

    // Append to evaluator log (keep last 500 entries — covers ~58 hours at 7-min intervals)
    const existingLog = trade.evaluator_log || [];
    const newLog = [...existingLog, logEntry].slice(-500);
    setClauses.push(`evaluator_log = $${paramIdx++}`);
    params.push(JSON.stringify(newLog));

    // Execute or log based on per-signal config
    const shouldAct = logEntry.action === 'recommend_exit' || logEntry.action === 'recommend_tp';
    const activeSignals = config.exit.ACTIVE_SIGNALS || [];
    const signalIsActive = activeSignals.includes(logEntry.exit_type);
    const globalActive = config.exit.EVALUATOR_MODE === 'active';

    let exitExecuted = false;
    if (shouldAct && (signalIsActive || globalActive)) {
      if (logEntry.exit_type === 'guaranteed_win') {
        // Guaranteed win: resolve at $1 payout, no reason to sell early
        exitExecuted = await this._resolveGuaranteed(trade, logEntry.exit_type, currentProbability, forecast, obs);
      } else if (logEntry.exit_type === 'guaranteed_loss') {
        // Guaranteed loss: sell at bid to recover whatever we can
        exitExecuted = await this._executeExit(trade, price, currentProbability, forecast, 'guaranteed_loss', obs);
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
        edge: (evAdvantage * 100).toFixed(1) + '%',
      });
    } else if (calOverride) {
      // calConfirmsEdge: model says exit but market calibration says hold
      this._log('info', `CAL HOLD: ${trade.side} ${trade.city} ${trade.range_name}`, {
        prob: (currentProbability * 100).toFixed(1) + '%',
        bid: (marketBid * 100).toFixed(0) + '¢',
        empWinRate: (calOverride.emp_win_rate * 100).toFixed(1) + '%',
        bucket: calOverride.bucket,
      });
    } else if (logEntry.near_resolution_hold) {
      // Log-only mode: near-resolution hold
      const pnlIfSell = (marketBid * trade.shares - trade.cost);
      const pnlIfWin = (1.0 * trade.shares - trade.cost);
      this._log('info', `HOLD (near resolution): ${trade.side} ${trade.city} ${trade.range_name} — bid ${(marketBid * 100).toFixed(0)}¢, ${hoursRemaining.toFixed(1)}hrs remaining, hold to $1 (+$${pnlIfWin.toFixed(2)} if win vs +$${pnlIfSell.toFixed(2)} if sell now)`);
    }

    // Update trade in DB
    params.push(trade.id);
    const { error: updateError } = await query(
      `UPDATE trades SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
      params
    );

    if (updateError) {
      this._log('warn', `Failed to update trade ${trade.id}`, { error: updateError.message });
    }

    return 'hold'; // Only return 'exit' when actually executed above
  }

  /**
   * Get latest METAR observation for a city/date from metar_observations table.
   */
  async _getLatestObservation(city, targetDate) {
    try {
      const { data, error } = await query(
        `SELECT running_high_c, running_high_f, temp_c, temp_f, observed_at, observation_count, wu_high_f, wu_high_c
         FROM metar_observations
         WHERE city = $1 AND target_date = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [city.toLowerCase(), targetDate]
      );

      if (error || !data || data.length === 0) return null;
      return data[0];
    } catch {
      return null;
    }
  }

  /**
   * Check if a trade is already decided based on observation temperatures.
   * Only uses provably-correct "boundary crossed" checks:
   *   - guaranteed_loss "exceeded": wu_high crossed past range boundary (irreversible)
   *   - guaranteed_win "reached": runHigh crossed into/past range (irreversible)
   * Day-over "didn't reach" branches REMOVED — cooling hour is unreliable
   * (saved $13 on correct exits, cost $536 on 3 wrong exits).
   * Returns 'guaranteed_win' | 'guaranteed_loss' | 'undecided'
   */
  _checkAlreadyDecided(trade, obs) {
    const runHigh = trade.range_unit === 'C' ? obs.running_high_c : obs.running_high_f;
    const wuHigh = trade.range_unit === 'C' ? obs.wu_high_c : obs.wu_high_f;

    if (trade.side === 'YES') {
      // YES on unbounded upper ("X or higher"): runHigh >= threshold = guaranteed win
      if (trade.range_max == null && trade.range_min != null && runHigh >= trade.range_min) {
        return 'guaranteed_win';
      }
      // YES on unbounded lower ("X or below"): exceeded — wu_high > max = guaranteed loss
      if (trade.range_min == null && trade.range_max != null
          && wuHigh != null && wuHigh > trade.range_max) {
        return 'guaranteed_loss';
      }
      // YES on bounded ("X-Y"): exceeded — wu_high > range_max = guaranteed loss
      if (trade.range_max != null && trade.range_min != null
          && wuHigh != null && wuHigh > trade.range_max) {
        return 'guaranteed_loss';
      }
    }

    if (trade.side === 'NO') {
      // NO on bounded: runHigh > range_max = guaranteed win (YES loses)
      if (trade.range_max != null && trade.range_min != null && runHigh > trade.range_max) {
        return 'guaranteed_win';
      }
      // NO on unbounded lower ("X or below"): runHigh > range_max = guaranteed win (YES loses)
      if (trade.range_min == null && trade.range_max != null && runHigh > trade.range_max) {
        return 'guaranteed_win';
      }
      // NO on unbounded upper: exceeded — wu_high >= threshold = guaranteed loss (YES wins)
      if (trade.range_max == null && trade.range_min != null
          && wuHigh != null && wuHigh >= trade.range_min) {
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

    // -- Observation-based TP (need obs data) ---------------------
    if (obs) {
      const high = trade.range_unit === 'C' ? obs.running_high_c : obs.running_high_f;
      const unitLabel = trade.range_unit || 'F';

      // 1. Unbounded YES upper: running high >= threshold -> threshold crossed
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

        // 3. Running high within 1 deg of boundary + trending up
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

    // 4. Observation-aware TP: bid spike without confirmation (YES unbounded upper only)
    // If bid is high but running_high hasn't crossed threshold -> market is speculating, not confirmed
    const obsSpike = config.exit?.TAKE_PROFIT?.OBSERVATION_SPIKE;
    if (!obsSignal && obsSpike?.ENABLED && obs) {
      const high = trade.range_unit === 'C' ? obs.running_high_c : obs.running_high_f;
      const unitLabel = trade.range_unit || 'F';
      if (trade.side === 'YES' && trade.range_max == null && trade.range_min != null) {
        if (marketBid >= (obsSpike.TRIGGER_BID || 0.50) && high < trade.range_min) {
          obsSignal = 'observation_unconfirmed_spike';
          obsDetail = `Bid ${(marketBid * 100).toFixed(0)}¢ but running high ${high}°${unitLabel} < threshold ${trade.range_min}°${unitLabel}`;
        }
      }
    }

    // -- Market-based TP (all trade types) ------------------------
    // 1. Bid > 3x entry ask
    if (marketBid > entryAsk * 3) {
      marketSignal = 'bid_3x_entry';
    }
    // 2. Bid dropped 20%+ from peak (only if peak was meaningful: > 1.5x entry)
    else if (maxPriceSeen > entryAsk * 1.5 && marketBid < maxPriceSeen * 0.8) {
      marketSignal = 'bid_declining_from_peak';
    }
    // 3. Bid > 50c and entry < 20c
    else if (marketBid > 0.50 && entryAsk < 0.20) {
      marketSignal = 'bid_high_value';
    }

    // -- Combined signal ------------------------------------------
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
  async _resolveGuaranteed(trade, signal, currentProbability, forecast, obs) {
    const isWin = signal === 'guaranteed_win';
    const payout = isWin ? 1.00 : 0.00;
    const pnl = Math.round((payout * trade.shares - trade.cost) * 100) / 100;
    const now = new Date().toISOString();

    const runningHighF = obs?.running_high_f ?? null;
    const runningHighC = obs?.running_high_c ?? null;
    const wuHighF = obs?.wu_high_f ?? null;
    const wuHighC = obs?.wu_high_c ?? null;

    const { error } = await query(
      `UPDATE trades
       SET status = $1, exit_reason = $2, exit_price = $3, exit_bid = $4, exit_ask = $5,
           exit_probability = $6, exit_forecast_temp = $7, exited_at = $8, won = $9,
           actual_temp = $10, pnl = $11, fees = $12, observation_high = $13, wu_high = $14
       WHERE id = $15`,
      [
        'resolved',
        signal,
        payout,
        trade.current_bid,
        trade.current_ask,
        currentProbability,
        forecast?.temp || null,
        now,
        isWin,
        null,  // actual_temp left null — backfill will set authoritative temp from WU/NWS
        pnl,
        0,
        trade.range_unit === 'C' ? runningHighC : runningHighF,
        trade.range_unit === 'C' ? wuHighC : wuHighF,
        trade.id,
      ]
    );

    if (error) {
      this._log('error', `Failed to resolve ${signal}`, { error: error.message, tradeId: trade.id });
      return false;
    }

    this._log('info', `RESOLVED (${signal}): ${trade.side} ${trade.city} ${trade.range_name} [${trade.platform}]`, {
      entry: (trade.entry_ask * 100).toFixed(0) + '¢',
      payout: '$' + payout.toFixed(2),
      pnl: (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2),
    });

    const runningHigh = obs ? (trade.range_unit === 'C' ? obs.running_high_c : obs.running_high_f) : null;
    this.alerts.tradeExit({
      ...trade,
      exit_reason: signal,
      exit_price: payout,
      pnl,
      fees: 0,
      running_high: runningHigh,
      running_high_unit: trade.range_unit || 'F',
    });

    return true;
  }

  /**
   * Execute an exit. Update trade record with exit data + P&L.
   */
  async _executeExit(trade, price, currentProbability, forecast, exitReason = 'evaluator', obs = null) {
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

    const obsHighF = obs?.running_high_f ?? null;
    const obsHighC = obs?.running_high_c ?? null;
    const obsWuF = obs?.wu_high_f ?? null;
    const obsWuC = obs?.wu_high_c ?? null;

    // For guaranteed_loss, we know the outcome. For other exits, resolver backfills later.
    const wonValue = isGuaranteed ? false : null;
    const actualTemp = isGuaranteed
      ? (trade.range_unit === 'C' ? (obsHighC ?? null) : (obsHighF ?? null))
      : null;

    const { error } = await query(
      `UPDATE trades
       SET status = $1, exit_reason = $2, exit_price = $3, exit_bid = $4, exit_ask = $5,
           exit_spread = $6, exit_volume = $7, exit_probability = $8, exit_forecast_temp = $9,
           exited_at = $10, won = $11, actual_temp = $12, pnl = $13, fees = $14,
           observation_high = $15, wu_high = $16
       WHERE id = $17`,
      [
        'exited',
        exitReason,
        exitBid,
        exitBid,
        exitAsk,
        price.spread,
        price.volume,
        currentProbability,
        forecast?.temp || null,
        now,
        wonValue,
        actualTemp,
        Math.round(pnl * 100) / 100,
        Math.round(totalFees * 100) / 100,
        trade.range_unit === 'C' ? obsHighC : obsHighF,
        trade.range_unit === 'C' ? obsWuC : obsWuF,
        trade.id,
      ]
    );

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
    const runningHigh = obs ? (trade.range_unit === 'C' ? obs.running_high_c : obs.running_high_f) : null;
    this.alerts.tradeExit({
      ...trade,
      exit_reason: exitReason,
      exit_price: exitBid,
      pnl,
      fees: totalFees,
      running_high: runningHigh,
      running_high_unit: trade.range_unit || 'F',
    });

    return true;
  }

  // -- Market calibration (calConfirmsEdge for hold decisions) ------

  async _loadCalibration() {
    try {
      const { data, error } = await query(`SELECT * FROM market_calibration`);
      if (error) throw error;

      const map = new Map();
      for (const row of (data || [])) {
        const key = `${row.platform}|${row.range_type}|${row.lead_time_bucket}|${row.price_bucket}`;
        map.set(key, row);
      }
      return map;
    } catch (err) {
      this._log('warn', 'Failed to load market calibration', { error: err.message });
      return new Map();
    }
  }

  _getCalibration(rangeType, hoursToResolution, askPrice, platform) {
    if (!this._calibration || this._calibration.size === 0) return null;

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

    const key = `${platform}|${rangeType}|${leadBucket}|${priceBucket}`;
    return this._calibration.get(key) || null;
  }
}

module.exports = Monitor;
