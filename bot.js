/**
 * bot.js — Coordinator
 *
 * Thin orchestrator: timing, main loop, error handling.
 * No business logic — delegates to modules.
 *
 * Phase 3: Full lifecycle — scan, trade, monitor, resolve, learn.
 */

const config = require('./config');
const PlatformAdapter = require('./lib/platform-adapter');
const ForecastEngine = require('./lib/forecast-engine');
const Scanner = require('./lib/scanner');
const Executor = require('./lib/executor');
const Monitor = require('./lib/monitor');
const Resolver = require('./lib/resolver');
const Alerts = require('./lib/alerts');

class Bot {
  constructor() {
    this.adapter = new PlatformAdapter();
    this.forecast = new ForecastEngine();
    this.scanner = new Scanner(this.adapter, this.forecast);
    this.alerts = new Alerts();
    this.executor = new Executor(this.adapter, this.alerts);
    this.monitor = new Monitor(this.adapter, this.forecast, this.alerts);
    this.resolver = new Resolver(this.forecast, this.alerts);

    this.cycleCount = 0;
    this.lastSnapshotAt = 0;
    this.running = false;
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[32m';
    const label = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[BOT]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Start the bot. Runs initial cycle, then schedules repeating.
   */
  async start() {
    this._log('info', '═══════════════════════════════════════════════════');
    this._log('info', 'Weather Trading Bot v2 starting');
    this._log('info', `Mode: ${config.general.TRADING_MODE}`);
    this._log('info', `Scan interval: ${config.general.SCAN_INTERVAL_MINUTES}m`);
    this._log('info', `Platforms: ${[
      config.platforms.polymarket.enabled && 'Polymarket',
      config.platforms.kalshi.enabled && 'Kalshi',
    ].filter(Boolean).join(' + ')}`);
    this._log('info', `Cities: ${Object.keys(config.cities).length}`);
    this._log('info', `Exit evaluator: ${config.exit.EVALUATOR_MODE}`);
    this._log('info', `Bankroll: YES $${config.sizing.YES_BANKROLL} / NO $${config.sizing.NO_BANKROLL}`);
    this._log('info', '═══════════════════════════════════════════════════');

    // Initialize executor bankrolls from existing open trades
    await this.executor.initBankrolls();

    this.alerts.startup();
    await this.alerts.flush();

    this.running = true;

    // Run first cycle immediately
    await this._runCycle();

    // Schedule subsequent cycles
    this._scheduleNextCycle();
  }

  _scheduleNextCycle() {
    if (!this.running) return;

    const intervalMs = config.general.SCAN_INTERVAL_MINUTES * 60 * 1000;
    setTimeout(async () => {
      await this._runCycle();
      this._scheduleNextCycle();
    }, intervalMs);
  }

  /**
   * Run one complete scan cycle.
   */
  async _runCycle() {
    this.cycleCount++;
    const cycleStart = Date.now();
    this._log('info', `──── Cycle #${this.cycleCount} starting ────`);

    try {
      // 1. Scanner: evaluate all markets, log opportunities
      const scanResult = await this.scanner.scan();

      // 2. Executor: size and record trades for approved entries
      let trades = [];
      if (scanResult.opportunities.length > 0) {
        trades = await this.executor.execute(scanResult.opportunities);
      }

      // 3. Monitor: re-evaluate all open positions
      const monitorResult = await this.monitor.evaluate();

      // 4. Resolver: resolve trades, backfill opportunities, record accuracy
      const resolverResult = await this.resolver.resolve();

      // 5. Snapshots (every SNAPSHOT_INTERVAL_MINUTES)
      const snapshotIntervalMs = config.snapshots.INTERVAL_MINUTES * 60 * 1000;
      if (Date.now() - this.lastSnapshotAt >= snapshotIntervalMs) {
        const snapshotCount = await this.scanner.captureSnapshots();
        this.lastSnapshotAt = Date.now();
        this._log('info', `Snapshots captured: ${snapshotCount}`);
      }

      // 6. Cycle summary
      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      this._log('info', `Cycle #${this.cycleCount} complete in ${elapsed}s`, {
        marketsScanned: scanResult.marketsScanned,
        logged: scanResult.logged,
        approved: scanResult.opportunities.length,
        filtered: scanResult.filtered,
        tradesEntered: trades.length,
        monitored: monitorResult.evaluated,
        exits: monitorResult.exits,
        resolved: resolverResult.tradesResolved,
        backfilled: resolverResult.opportunitiesBackfilled,
      });

      this.alerts.cycleSummary({
        marketsScanned: scanResult.marketsScanned,
        opportunitiesLogged: scanResult.logged,
        entered: trades.length,
        openPositions: monitorResult.evaluated,
        exits: monitorResult.exits,
      });

    } catch (err) {
      this._log('error', `Cycle #${this.cycleCount} FAILED`, { error: err.message, stack: err.stack });
      this.alerts.error(`Cycle #${this.cycleCount}`, err);
    }

    // 7. Flush alert queue
    try {
      const sent = await this.alerts.flush();
      if (sent > 0) this._log('info', `Sent ${sent} Telegram alerts`);
    } catch (err) {
      this._log('error', 'Alert flush failed', { error: err.message });
    }
  }

  /**
   * Graceful shutdown.
   */
  stop() {
    this._log('info', 'Bot stopping...');
    this.running = false;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

const bot = new Bot();

process.on('SIGINT', () => {
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bot.stop();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught exception: ${err.message}\n${err.stack}`);
  bot.alerts.sendNow(`🚨 FATAL: ${err.message}`).then(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] Unhandled rejection: ${reason}`);
  bot.alerts.sendNow(`🚨 UNHANDLED REJECTION: ${reason}`).catch(() => {});
});

bot.start().catch(err => {
  console.error(`[FATAL] Bot failed to start: ${err.message}\n${err.stack}`);
  process.exit(1);
});
