#!/usr/bin/env node
/**
 * Position Manager (Bot B) - Runner
 *
 * Monitors positions created by Weather Bot (Bot A), takes profit at tiered
 * thresholds, exits on forecast shifts, and re-enters when edge returns.
 *
 * Usage:
 *   node run-position-manager.js        # Run position manager
 *
 * Runs alongside weather bot:
 *   pm2 start run-position-manager.js --name position-manager
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { WeatherAPI } = require('./lib/weather-api');
const { KalshiAPI } = require('./lib/kalshi-api');
const { PositionManager } = require('./lib/position-manager');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // Scanning
  SCAN_INTERVAL_MS: 10 * 60 * 1000,  // Every 10 minutes

  // Take Profit Thresholds - TIERED BY ENTRY PRICE
  TAKE_PROFIT: {
    LONGSHOT: { maxEntry: 0.25, exitAt: 0.75 },          // Entry <25¢ → exit at 75¢
    MIDRANGE: { maxEntry: 0.40, exitAt: 0.55 },          // Entry 25-40¢ → exit at 55¢
    FAVORITE: { maxEntry: 0.75, exitAt: 0.85 },          // Entry 40-75¢ → exit at 85¢
    SUPER_FAVORITE: { maxEntry: 1.00, exitAt: 0.95 },    // Entry 75¢+ → exit at 95¢
  },

  // Stop Loss - DISABLED (data shows it hurts: -$78 worse than doing nothing)
  STOP_LOSS_ENABLED: false,

  // Forecast Shift Exit
  FORECAST_EXIT_ENABLED: true,
  FORECAST_EXIT_MIN_DAYS: 1,  // Only exit on forecast shift if 1+ day remaining
  FORECAST_EXIT_MIN_BID: 0.15,  // Don't forecast-exit if bid < 15¢ (nothing to save)
  FORECAST_EXIT_MIN_MARGIN_MULTIPLIER: 1.0,  // Shift must exceed 1x source avg error
  FORECAST_EXIT_DEFAULT_ERROR_F: 2.0,         // Fallback error if no accuracy data (conservative)
  FORECAST_EXIT_CONFIRM_CHECKS: 2,            // Require 2 consecutive out-of-range checks

  // Re-entry after exit
  REENTRY_ENABLED: true,
  REENTRY_MIN_EDGE_PCT: 0.03,      // 3% minimum edge for re-entry
  REENTRY_MIN_EDGE_DOLLARS: 0.01,  // $0.01 for longshots, $0.03 for others (tiered)

  // Capital
  PAPER_BANKROLL: 1000,

  // Platform
  POLYMARKET_FEE: 0.0315,

  // Telegram alerts
  TELEGRAM_ON_EXIT: true,
  TELEGRAM_ON_REENTRY: true,
};

// =============================================================================
// LOGGING
// =============================================================================

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  const prefix = {
    info: '\x1b[36m[INFO]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    error: '\x1b[31m[ERROR]\x1b[0m',
    success: '\x1b[32m[OK]\x1b[0m',
  }[level] || `[${level.toUpperCase()}]`;

  console.log(`${timestamp} ${prefix} [PM] ${message}${extra}`);
}

// =============================================================================
// TELEGRAM
// =============================================================================

async function sendTelegram(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    log('warn', 'Telegram send failed', { error: err.message });
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  📊 POSITION MANAGER (Bot B)');
  console.log('='.repeat(60) + '\n');

  console.log('Take Profit thresholds:');
  console.log('  LONGSHOT (<25¢): exit at 75¢');
  console.log('  MIDRANGE (25-40¢): exit at 55¢');
  console.log('  FAVORITE (40-75¢): exit at 85¢');
  console.log('  SUPER_FAVORITE (75¢+): exit at 95¢');
  console.log('Stop Loss: DISABLED (data shows harmful)');
  console.log('Forecast Exit: ENABLED (two-gate: error margin + stability)');
  console.log(`  Error margin: ${CONFIG.FORECAST_EXIT_MIN_MARGIN_MULTIPLIER}x source avg error (default ${CONFIG.FORECAST_EXIT_DEFAULT_ERROR_F}°F)`);
  console.log(`  Stability: ${CONFIG.FORECAST_EXIT_CONFIRM_CHECKS} consecutive checks required`);
  console.log('Re-entry: ENABLED');
  console.log('Scan interval: 10 minutes\n');

  // Initialize dependencies
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const weatherApi = new WeatherAPI({ log });

  // Initialize Kalshi API for position monitoring (read-only, no auth needed)
  let kalshiApi = null;
  try {
    kalshiApi = new KalshiAPI({ demo: process.env.KALSHI_DEMO === 'true', log });
    log('success', 'Kalshi API initialized for position monitoring');
  } catch (err) {
    log('warn', 'Kalshi API init failed - Kalshi positions will be skipped', { error: err.message });
  }

  // Test DB connection
  const { error: dbError } = await supabase
    .from('weather_paper_trades')
    .select('count')
    .limit(1);

  if (dbError) {
    log('error', 'Database connection failed', { error: dbError.message });
    process.exit(1);
  }

  // Check if required schema changes have been applied
  const { error: colError } = await supabase
    .from('weather_paper_trades')
    .select('managed_by')
    .limit(1);

  if (colError) {
    log('error', 'Required DB columns missing (managed_by, exit_pnl, etc.)');
    log('error', 'Run schema-position-manager.sql in Supabase SQL Editor first');
    log('error', 'File location: polymarket-whale-tracker/schema-position-manager.sql');
    process.exit(1);
  }

  const { error: tableError } = await supabase
    .from('position_manager_logs')
    .select('id')
    .limit(1);

  if (tableError) {
    log('error', 'position_manager_logs table not found');
    log('error', 'Run schema-position-manager.sql in Supabase SQL Editor first');
    process.exit(1);
  }

  const { error: reentryError } = await supabase
    .from('reentry_trades')
    .select('id')
    .limit(1);

  if (reentryError) {
    log('error', 'reentry_trades table not found');
    log('error', 'Run schema-position-manager.sql in Supabase SQL Editor first');
    process.exit(1);
  }

  const manager = new PositionManager({
    supabase,
    weatherApi,
    kalshiApi,
    log,
    sendTelegram,
    settings: CONFIG,
  });

  log('success', 'Position Manager initialized');

  // Run immediately
  await manager.run();
  await manager.resolveReentryTrades();

  // Then every 10 minutes
  const scanInterval = setInterval(async () => {
    try {
      await manager.run();
    } catch (err) {
      log('error', 'Scan cycle error', { error: err.message });
    }
  }, CONFIG.SCAN_INTERVAL_MS);

  // Resolution check every hour
  const resolveInterval = setInterval(async () => {
    try {
      await manager.resolveReentryTrades();
    } catch (err) {
      log('error', 'Resolution cycle error', { error: err.message });
    }
  }, 60 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async (signal) => {
    log('info', `Shutdown: ${signal}`);
    clearInterval(scanInterval);
    clearInterval(resolveInterval);

    await sendTelegram(`🛑 *[Bot B] Position Manager Stopped* (${signal})`);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await sendTelegram(
    `📊 *[Bot B] Position Manager Started*\n` +
    `Take Profit: LONG→75¢ / MID→55¢ / FAV→85¢ / SFAV→95¢\n` +
    `Forecast Exit: ON\n` +
    `Re-entry: ON`
  );

  log('info', 'Position Manager running. Press Ctrl+C to stop.');
}

main().catch(err => {
  log('error', 'Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
