/**
 * bot.js — Coordinator
 *
 * Thin orchestrator: timing, main loop, error handling.
 * No business logic — delegates to modules.
 *
 * Phase 3: Full lifecycle — scan, trade, monitor, resolve, learn.
 */

const config = require('./config');
const { db } = require('./lib/db');
const PlatformAdapter = require('./lib/platform-adapter');
const ForecastEngine = require('./lib/forecast-engine');
const Scanner = require('./lib/scanner');
const Executor = require('./lib/executor');
const Monitor = require('./lib/monitor');
const Resolver = require('./lib/resolver');
const METARObserver = require('./lib/metar-observer');
const Alerts = require('./lib/alerts');
const peakHours = require('./lib/peak-hours');

class Bot {
  constructor() {
    this.adapter = new PlatformAdapter();
    this.forecast = new ForecastEngine();
    this.scanner = new Scanner(this.adapter, this.forecast);
    this.alerts = new Alerts();
    this.executor = new Executor(this.adapter, this.alerts);
    this.monitor = new Monitor(this.adapter, this.forecast, this.alerts);
    this.resolver = new Resolver(this.forecast, this.alerts);
    this.observer = new METARObserver(this.alerts);

    this.cycleCount = 0;
    this.lastSnapshotAt = 0;
    this.lastObserverAt = 0;
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

    // Initialize dynamic per-city peak hours from METAR history
    await peakHours.initialize();

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

    // Refresh bankrolls from DB each cycle (resolved/exited trades free capital)
    await this.executor.initBankrolls();

    // Each step has its own try/catch — failures are independent
    let scanResult = { opportunities: [], logged: 0, filtered: 0, marketsScanned: 0 };
    let trades = [];
    let monitorResult = { evaluated: 0, exits: 0 };
    let resolverResult = { tradesResolved: 0, opportunitiesBackfilled: 0 };

    // 1. Scanner: evaluate all markets, log opportunities
    try {
      scanResult = await this.scanner.scan();
    } catch (err) {
      this._log('error', `Scanner failed in cycle #${this.cycleCount}`, { error: err.message });
      this.alerts.error(`Scanner cycle #${this.cycleCount}`, err);
    }

    // 2. Executor: size and record trades for approved entries
    try {
      if (scanResult.opportunities.length > 0) {
        trades = await this.executor.execute(scanResult.opportunities);

        // Fix data quality: update opportunities the executor rejected
        // (bankroll, volume, dedup, etc.) so they don't show as 'entered' in DB
        const enteredOppIds = new Set(trades.map(t => t.opportunity_id).filter(Boolean));
        for (const opp of scanResult.opportunities) {
          if (opp.opportunity_id && !enteredOppIds.has(opp.opportunity_id)) {
            await db.from('opportunities').update({ action: 'executor_blocked' }).eq('id', opp.opportunity_id);
          }
        }
      }
    } catch (err) {
      this._log('error', `Executor failed in cycle #${this.cycleCount}`, { error: err.message });
      this.alerts.error(`Executor cycle #${this.cycleCount}`, err);
    }

    // 3. Monitor: re-evaluate all open positions
    try {
      monitorResult = await this.monitor.evaluate();
    } catch (err) {
      this._log('error', `Monitor failed in cycle #${this.cycleCount}`, { error: err.message });
      this.alerts.error(`Monitor cycle #${this.cycleCount}`, err);
    }

    // 4. METAR Observer: poll intraday observations for all cities
    let observerRanThisCycle = false;
    try {
      const observerIntervalMs = config.observer.POLL_INTERVAL_MINUTES * 60 * 1000;
      if (Date.now() - this.lastObserverAt >= observerIntervalMs) {
        const obsResult = await this.observer.observe();
        this.lastObserverAt = Date.now();
        observerRanThisCycle = true;
        if (obsResult.citiesPolled > 0) {
          this._log('info', `Observer: ${obsResult.citiesPolled} cities polled, ${obsResult.newHighs} new highs`);
        }
      }
    } catch (err) {
      this._log('error', `Observer failed in cycle #${this.cycleCount}`, { error: err.message });
    }

    // 4a. Guaranteed-win entries: observation-based risk-free trades
    try {
      if (config.guaranteed_entry?.ENABLED && observerRanThisCycle) {
        const gwResult = await this.scanner.scanGuaranteedWins();
        if (gwResult.entries.length > 0) {
          const gwTrades = await this.executor.executeGuaranteedWins(gwResult.entries);
          this._log('info', `Guaranteed wins: ${gwResult.entries.length} found, ${gwTrades.length} entered`);
        }
      }
    } catch (err) {
      this._log('error', `Guaranteed-win scan failed`, { error: err.message });
    }

    // 5. Resolver: resolve trades, backfill opportunities, record accuracy
    try {
      resolverResult = await this.resolver.resolve();
    } catch (err) {
      this._log('error', `Resolver failed in cycle #${this.cycleCount}`, { error: err.message });
      this.alerts.error(`Resolver cycle #${this.cycleCount}`, err);
    }

    // 6. Snapshots (every SNAPSHOT_INTERVAL_MINUTES)
    try {
      const snapshotIntervalMs = config.snapshots.INTERVAL_MINUTES * 60 * 1000;
      if (Date.now() - this.lastSnapshotAt >= snapshotIntervalMs) {
        const snapshotCount = await this.scanner.captureSnapshots();
        this.lastSnapshotAt = Date.now();
        this._log('info', `Snapshots captured: ${snapshotCount}`);
      }
    } catch (err) {
      this._log('error', `Snapshots failed in cycle #${this.cycleCount}`, { error: err.message });
    }

    // 7. Cycle summary
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

    // 8. Flush alert queue
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
// Only start when run directly (not when required by other scripts)

if (require.main === module || process.env.pm_id !== undefined) {
  const bot = new Bot();

  process.on('SIGINT', async () => {
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    bot.stop();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    console.error(`[FATAL] Uncaught exception: ${err.message}\n${err.stack}`);
    bot.alerts.sendNow(`🚨 FATAL: ${err.message}`).catch(() => {}).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`[FATAL] Unhandled rejection: ${reason}`);
    bot.alerts.sendNow(`🚨 UNHANDLED REJECTION: ${reason}`).catch(() => {});
  });

  bot.start().catch(err => {
    console.error(`[FATAL] Bot failed to start: ${err.message}\n${err.stack}`);
    process.exit(1);
  });
}

module.exports = Bot;
