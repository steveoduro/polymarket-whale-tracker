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
    const emoji = side === 'NO' ? '🔴' : '🟢';
    const unit = trade.range_unit || 'F';
    const lines = [
      `${emoji} NEW ${side} TRADE [${trade.platform.toUpperCase()}]`,
      ``,
      `📍 ${trade.city.toUpperCase()} — ${trade.target_date}`,
      `📊 ${trade.range_name}`,
    ];
    if (trade.entry_forecast_temp != null) {
      lines.push(`🌡️ Forecast: ${trade.entry_forecast_temp}°${unit}`);
    }
    if (trade.entry_reason === 'guaranteed_win' && trade.observation_high != null) {
      lines.push(`🌡️ Observed: ${trade.observation_high}°${unit}${trade.wu_high != null ? ` (WU: ${trade.wu_high}°${unit})` : ''}`);
    }
    lines.push(
      `💰 ${(trade.entry_ask * 100).toFixed(0)}¢ ask (${(trade.entry_spread * 100).toFixed(0)}¢ spread)`,
      `📈 Edge: ${trade.entry_edge_pct.toFixed(1)}% | Prob: ${(trade.entry_probability * 100).toFixed(0)}%`,
      `💵 ${trade.shares.toFixed(0)} shares @ $${trade.cost.toFixed(2)}`,
    );
    if (trade.pct_of_volume != null && trade.pct_of_volume > config.sizing.WARN_VOLUME_PCT) {
      lines.push(`⚠️ Position is ${trade.pct_of_volume.toFixed(0)}% of visible volume — may not fill live`);
    }
    this.action(lines.join('\n'));
  }

  /**
   * Trade exited
   * PnL verified: trade.pnl = revenue - cost - fees (actual profit, not gross payout)
   */
  tradeExit(trade) {
    const pnlEmoji = trade.pnl >= 0 ? '✅' : '❌';
    const lines = [
      `${pnlEmoji} EXIT [${trade.platform.toUpperCase()}] — ${trade.exit_reason}`,
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
    const emoji = trade.won ? '🏆' : '💀';
    const unit = trade.range_unit || 'F';
    const lines = [
      `${emoji} RESOLVED [${trade.platform.toUpperCase()}]`,
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
