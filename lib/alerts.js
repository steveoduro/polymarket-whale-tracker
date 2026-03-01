/**
 * alerts.js — Telegram notification system
 *
 * Queue-based: modules push messages, bot.js flushes at end of cycle.
 * Two channels: actions (trades, exits) and info (summaries, heartbeat).
 */

const config = require('../config');

class Alerts {
  constructor() {
    this.token = config.alerts.TELEGRAM_BOT_TOKEN;
    this.actionsChatId = config.alerts.ACTIONS_CHAT_ID;
    this.infoChatId = config.alerts.INFO_CHAT_ID;
    this.queue = [];
    this.enabled = !!this.token && !!this.actionsChatId;
  }

  /**
   * Queue a message for the actions channel (trades, exits, errors)
   */
  action(text) {
    if (!this.enabled) return;
    this.queue.push({ chatId: this.actionsChatId, text });
  }

  /**
   * Queue a message for the info channel (summaries, heartbeat)
   */
  info(text) {
    if (!this.enabled) return;
    const chatId = this.infoChatId || this.actionsChatId;
    this.queue.push({ chatId, text });
  }

  /**
   * Flush all queued messages. Called at end of each cycle.
   * Returns count of messages sent.
   */
  async flush() {
    if (!this.enabled || this.queue.length === 0) return 0;

    const messages = [...this.queue];
    this.queue = [];
    let sent = 0;

    for (const msg of messages) {
      try {
        await this._send(msg.chatId, msg.text);
        sent++;
        // Telegram rate limit: ~30 msgs/sec, be conservative
        if (messages.length > 5) {
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (err) {
        console.error(`[ALERT] Failed to send Telegram message: ${err.message}`);
      }
    }

    return sent;
  }

  /**
   * Send immediately (bypass queue). For critical errors only.
   */
  async sendNow(text, channel = 'actions') {
    if (!this.enabled) return;
    const chatId = channel === 'info' ? (this.infoChatId || this.actionsChatId) : this.actionsChatId;
    try {
      await this._send(chatId, text);
    } catch (err) {
      console.error(`[ALERT] Failed to send immediate message: ${err.message}`);
    }
  }

  // ── Formatted message builders ─────────────────────────────────

  /**
   * New trade entered
   */
  tradeEntry(trade) {
    const side = trade.side === 'NO' ? 'NO' : 'YES';
    const isGW = trade.entry_reason?.startsWith('guaranteed_win');
    const isPwsGw = trade.entry_reason === 'guaranteed_win_pws';
    const isCal = trade.entry_reason === 'cal_confirms';
    const isLive = trade.execution_mode === 'live';
    const emoji = isPwsGw ? '📡' : isGW ? '🎯' : isCal ? '📐' : (side === 'NO' ? '🔴' : '🟢');
    const tag = isPwsGw ? ' PWS-GW' : isGW ? ' GW' : isCal ? ' CAL' : '';
    const liveTag = isLive ? ' — LIVE' : '';
    const unit = trade.range_unit || 'F';
    const lines = [
      `${emoji} NEW ${side}${tag} TRADE [${trade.platform.toUpperCase()}]${liveTag}`,
      ``,
      `📍 ${trade.city.toUpperCase()} — ${trade.target_date}`,
      `📊 ${trade.range_name}`,
    ];
    if (isLive && trade.order_id) {
      lines.push(`🔗 Order: ${trade.order_id}`);
    }
    if (trade.entry_forecast_temp != null) {
      lines.push(`🌡️ Forecast: ${trade.entry_forecast_temp}°${unit}`);
    }
    if (isPwsGw && trade.observation_high != null) {
      lines.push(`📡 PWS: ${trade.observation_high}°${unit} (${trade.pws_stations_online || '?'} stn)`);
    } else if (trade.entry_reason === 'guaranteed_win' && trade.observation_high != null) {
      if (trade.wu_triggered) {
        lines.push(`🌡️ WU: ${trade.wu_high}°${unit} → METAR: ${trade.observation_high}°${unit}`);
      } else {
        const wuSuffix = trade.wu_high != null ? ` → WU: ${trade.wu_high}°${unit}` : '';
        lines.push(`🌡️ METAR: ${trade.observation_high}°${unit}${wuSuffix}`);
      }
    }
    lines.push(
      `💰 ${(trade.entry_ask * 100).toFixed(0)}¢ ask (${(trade.entry_spread * 100).toFixed(0)}¢ spread)`,
      `📈 Edge: ${trade.entry_edge_pct.toFixed(1)}% | Prob: ${(trade.entry_probability * 100).toFixed(0)}%`,
      `💵 ${trade.shares.toFixed(0)} shares @ $${trade.cost.toFixed(2)}`,
    );
    if (trade.pct_of_volume != null && trade.pct_of_volume > config.sizing.WARN_VOLUME_PCT) {
      lines.push(`⚠️ Position is ${trade.pct_of_volume.toFixed(0)}% of visible volume — may not fill live`);
    }
    if (isLive) {
      this.sendNow(lines.join('\n'));  // live trades: send immediately for verification
    } else {
      this.action(lines.join('\n'));
    }
  }

  /**
   * Guaranteed-win detection — fires immediately before execution.
   * Sends one message per entry so user sees it before the trade alert.
   */
  async guaranteedWinDetected(entries) {
    for (const entry of entries) {
      const side = entry.side === 'NO' ? 'NO' : 'YES';
      const unit = entry.range_unit || 'F';
      const isPws = entry.entry_reason === 'guaranteed_win_pws';
      const isDual = entry.dual_confirmed;
      const wuTriggered = entry.wu_triggered || false;

      let header, confirmLine;

      if (isPws) {
        header = '📡 GUARANTEED WIN — PWS EARLY DETECTION';
        confirmLine = `🔍 PWS corrected: ${entry.pws_corrected_median}°${unit} (${entry.pws_stations_online} stations)`;
      } else if (wuTriggered) {
        header = isDual ? '🎯 GUARANTEED WIN DETECTED (WU-LED)' : '⚠️ GUARANTEED WIN — WU-LED, SINGLE SOURCE';
        const metarText = entry.observation_high != null ? `METAR: ${entry.observation_high}°${unit}` : null;
        const wuText = entry.wu_high != null ? `WU: ${entry.wu_high}°${unit}` : null;
        confirmLine = isDual
          ? `🔍 WU-triggered, METAR confirmed — ${[wuText, metarText].filter(Boolean).join(', ')}`
          : `🔍 WU-triggered, METAR pending — ${[wuText, metarText].filter(Boolean).join(', ')}`;
      } else {
        header = isDual ? '🎯 GUARANTEED WIN DETECTED' : '⚠️ GUARANTEED WIN — SINGLE SOURCE';
        const metarText = entry.observation_high != null ? `METAR: ${entry.observation_high}°${unit}` : null;
        const wuText = entry.wu_high != null ? `WU: ${entry.wu_high}°${unit}` : null;
        confirmLine = isDual
          ? `🔍 METAR-triggered, WU confirmed — ${[metarText, wuText].filter(Boolean).join(', ')}`
          : `🔍 SINGLE confirmed — ${[metarText, wuText].filter(Boolean).join(', ')}`;
      }

      const lines = [
        header,
        ``,
        `📍 ${entry.city.toUpperCase()} — ${entry.target_date}`,
        `📊 ${entry.range_name} ${side} [${entry.platform.toUpperCase()}]`,
        `💰 Ask: ${(entry.ask * 100).toFixed(0)}¢ | Margin: ${entry.margin != null ? (entry.margin * 100).toFixed(1) + '%' : 'N/A'}`,
        confirmLine,
        ``,
        `Executing...`,
      ];
      await this.sendNow(lines.join('\n'));
    }
  }

  /**
   * Guaranteed-win missed — fires immediately for awareness.
   * Shows entries that were detected but skipped due to filters.
   */
  async guaranteedWinMissed(entries) {
    for (const entry of entries) {
      const unit = entry.unit || 'F';
      const sources = [];
      if (entry.observation_high != null) sources.push(`METAR: ${entry.observation_high}°${unit}`);
      // Only show WU for Polymarket (WU is PM resolution source; Kalshi uses NWS)
      if (entry.wu_high != null && entry.platform === 'polymarket') sources.push(`WU: ${entry.wu_high}°${unit}`);

      let reasonText;
      if (entry.reason === 'below_min_ask') {
        reasonText = `Ask ${(entry.ask * 100).toFixed(0)}¢ below MIN_ASK ${(entry.minAsk * 100).toFixed(0)}¢`;
      } else if (entry.reason === 'above_max_ask') {
        reasonText = `Ask ${(entry.ask * 100).toFixed(0)}¢ above MAX_ASK ${(entry.maxAsk * 100).toFixed(0)}¢`;
      } else if (entry.reason === 'below_min_bid') {
        reasonText = `Bid ${entry.bid}¢ below min ${entry.minBid}¢ (market disagrees)`;
      } else if (entry.reason === 'single_source_only') {
        reasonText = `Only one source confirms — dual required`;
      } else {
        reasonText = entry.reason;
      }

      const lines = [
        `💡 GUARANTEED WIN MISSED`,
        ``,
        `📍 ${entry.city.toUpperCase()} — ${entry.target_date}`,
        `📊 ${entry.range_name} ${entry.side} [${entry.platform.toUpperCase()}]`,
        `💰 Ask: ${entry.ask != null ? (entry.ask * 100).toFixed(0) + '¢' : 'N/A'}`,
        `🔍 ${sources.join(', ') || 'No observation data'}`,
        `❌ ${reasonText}`,
      ];
      await this.sendNow(lines.join('\n'));
    }
  }

  /**
   * Trade exited
   * PnL verified: trade.pnl = revenue - cost - fees (actual profit, not gross payout)
   */
  tradeExit(trade) {
    const pnlEmoji = trade.pnl >= 0 ? '✅' : '❌';
    const isGW = trade.entry_reason?.startsWith('guaranteed_win');
    const isCal = trade.entry_reason === 'cal_confirms';
    const isLive = trade.execution_mode === 'live';
    const tag = isGW ? ' GW' : isCal ? ' CAL' : '';
    const liveTag = isLive ? ' — LIVE' : '';
    const lines = [
      `${pnlEmoji}${tag} EXIT [${trade.platform.toUpperCase()}]${liveTag} — ${trade.exit_reason}`,
      ``,
      `📍 ${trade.city.toUpperCase()} — ${trade.target_date}`,
      `📊 ${trade.range_name} ${trade.side}`,
    ];
    if (trade.running_high != null && (trade.exit_reason === 'guaranteed_loss' || trade.exit_reason === 'guaranteed_win')) {
      lines.push(`🌡️ Running high: ${trade.running_high}°${trade.running_high_unit || 'F'}`);
    }
    lines.push(
      `💰 Entry: ${(trade.entry_ask * 100).toFixed(0)}¢ → Exit: ${(trade.exit_price * 100).toFixed(0)}¢`,
      `💵 P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} (fees: $${trade.fees.toFixed(2)})`,
    );
    this.action(lines.join('\n'));
  }

  /**
   * Trade resolved
   * PnL verified: trade.pnl = revenue - cost - fees (actual profit, not gross payout)
   */
  tradeResolved(trade) {
    const isGW = trade.entry_reason?.startsWith('guaranteed_win');
    const isCal = trade.entry_reason === 'cal_confirms';
    const isLive = trade.execution_mode === 'live';
    const emoji = trade.won ? '🏆' : '💀';
    const tag = isGW ? ' GW' : isCal ? ' CAL' : '';
    const liveTag = isLive ? ' — LIVE' : '';
    const unit = trade.range_unit || 'F';
    const lines = [
      `${emoji}${tag} RESOLVED [${trade.platform.toUpperCase()}]${liveTag}`,
      ``,
      `📍 ${trade.city.toUpperCase()} — ${trade.target_date}`,
      `📊 ${trade.range_name} ${trade.side} — ${trade.won ? 'WON' : 'LOST'}`,
      `🌡️ Actual: ${trade.actual_temp}°${unit}`,
    ];
    if (trade.entry_forecast_temp != null) {
      lines.push(`🌡️ Forecast was: ${trade.entry_forecast_temp}°${unit}`);
    }
    lines.push(`💵 P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}`);
    this.action(lines.join('\n'));
  }

  /**
   * METAR pending — observation crossed threshold but WU hasn't confirmed yet.
   * Fires immediately so user knows a guaranteed-win is imminent.
   */
  async metarPending(data) {
    const unit = data.unit || 'F';
    const wuTriggered = data.wuTriggered || false;
    const title = wuTriggered ? '⏳ WU BOUNDARY CROSSED' : '⏳ METAR BOUNDARY CROSSED';

    let obsLine;
    if (wuTriggered) {
      const metarText = data.metarHigh != null ? `${data.metarHigh}°${unit}` : 'pending';
      obsLine = `🌡️ WU: ${data.wuHigh}°${unit} ✓ | METAR: ${metarText} (not yet)`;
    } else {
      const wuText = data.wuHigh != null ? `${data.wuHigh}°${unit}` : 'not yet reported';
      obsLine = `🌡️ METAR: ${data.metarHigh}°${unit} ✓ | WU: ${wuText}`;
    }

    const lines = [
      title,
      ``,
      `📍 ${data.city.toUpperCase()} — ${data.date}`,
      obsLine,
      `📊 Ranges affected: ${data.rangesAffected.join(', ')}`,
      ``,
      `Evaluating for guaranteed-win entry.`,
    ];
    await this.sendNow(lines.join('\n'));
  }

  /**
   * System error
   */
  error(context, err) {
    this.action([
      `🚨 SYSTEM ERROR`,
      ``,
      `Context: ${context}`,
      `Error: ${err.message || err}`,
    ].join('\n'));
  }

  /**
   * Cycle summary (info channel)
   */
  cycleSummary(stats) {
    this.info([
      `📊 Scan Cycle Complete`,
      ``,
      `Markets scanned: ${stats.marketsScanned || 0}`,
      `Opportunities: ${stats.opportunitiesLogged || 0} logged, ${stats.entered || 0} entered`,
      `Open positions: ${stats.openPositions || 0}`,
      `Exits this cycle: ${stats.exits || 0}`,
    ].join('\n'));
  }

  /**
   * Bot startup
   */
  startup() {
    this.info([
      `🤖 Weather Bot v2 Started`,
      ``,
      `Mode: ${config.general.TRADING_MODE}`,
      `Scan interval: ${config.general.SCAN_INTERVAL_MINUTES}m`,
      `Exit evaluator: ${config.exit.EVALUATOR_MODE}`,
      `Platforms: ${[config.platforms.polymarket.enabled && 'PM', config.platforms.kalshi.enabled && 'KL'].filter(Boolean).join(' + ')}`,
    ].join('\n'));
  }

  // ── Internal ───────────────────────────────────────────────────

  async _send(chatId, text) {
    const fetch = (await import('node-fetch')).default;
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram API ${res.status}: ${body}`);
    }
  }
}

module.exports = Alerts;
