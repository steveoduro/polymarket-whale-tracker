#!/usr/bin/env node
/**
 * Trade Copier CLI Runner
 *
 * Run this on the VPS to copy trades from distinct-baguette.
 * Operates independently from the main server.js tracker.
 *
 * Usage:
 *   node run-copier.js                    # Run in paper mode (default)
 *   node run-copier.js --live             # Run in live trading mode
 *   node run-copier.js --check            # Check configuration and exit
 *   node run-copier.js --status           # Show current status and exit
 *   node run-copier.js --test-api         # Test Polymarket API connection
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { TradeCopier } = require('./lib/trade-copier');
const { PolymarketAPI } = require('./lib/polymarket-api');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // Supabase
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_ANON_KEY,

  // Wallet
  walletAddress: process.env.WALLET_ADDRESS,
  privateKey: process.env.WALLET_PRIVATE_KEY,

  // Trading settings
  copyTradeSize: parseFloat(process.env.COPY_TRADE_SIZE) || 1.50,
  minWhaleSize: parseFloat(process.env.MIN_WHALE_SIZE) || 10,
  maxPositionPerMarket: parseFloat(process.env.MAX_POSITION_PER_MARKET) || 5,
  minBalanceToTrade: parseFloat(process.env.MIN_BALANCE_TO_TRADE) || 10,
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT) || 15,

  // Polling
  pollIntervalMs: parseInt(process.env.COPIER_POLL_INTERVAL_MS) || 10000,

  // Telegram alerts (optional)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
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

  console.log(`${timestamp} ${prefix} ${message}${extra}`);
}

// =============================================================================
// TELEGRAM NOTIFICATIONS
// =============================================================================

async function sendTelegramAlert(text) {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    log('warn', 'Failed to send Telegram alert', { error: err.message });
  }
}

// =============================================================================
// COMMANDS
// =============================================================================

async function checkConfig() {
  console.log('\n=== Configuration Check ===\n');

  const checks = [
    { name: 'SUPABASE_URL', value: CONFIG.supabaseUrl, required: true },
    { name: 'SUPABASE_ANON_KEY', value: CONFIG.supabaseKey, required: true, mask: true },
    { name: 'WALLET_ADDRESS', value: CONFIG.walletAddress, required: false },
    { name: 'WALLET_PRIVATE_KEY', value: CONFIG.privateKey, required: false, mask: true },
    { name: 'COPY_TRADE_SIZE', value: CONFIG.copyTradeSize, required: false },
    { name: 'MIN_WHALE_SIZE', value: CONFIG.minWhaleSize, required: false },
    { name: 'TELEGRAM_BOT_TOKEN', value: CONFIG.telegramBotToken, required: false, mask: true },
  ];

  let allRequired = true;

  for (const check of checks) {
    const present = !!check.value;
    const displayValue = check.mask && check.value
      ? check.value.slice(0, 8) + '...'
      : check.value || '(not set)';

    if (present) {
      log('success', `${check.name}: ${displayValue}`);
    } else if (check.required) {
      log('error', `${check.name}: MISSING (required)`);
      allRequired = false;
    } else {
      log('warn', `${check.name}: (not set)`);
    }
  }

  console.log('\n=== Trading Settings ===\n');
  console.log(`  Trade Size:          $${CONFIG.copyTradeSize.toFixed(2)} per copy trade`);
  console.log(`  Min Whale Size:      $${CONFIG.minWhaleSize.toFixed(2)} (only copy trades >= this)`);
  console.log(`  Max Per Market:      $${CONFIG.maxPositionPerMarket.toFixed(2)} total exposure`);
  console.log(`  Min Balance:         $${CONFIG.minBalanceToTrade.toFixed(2)} (stop if below)`);
  console.log(`  Daily Loss Limit:    $${CONFIG.dailyLossLimit.toFixed(2)}`);
  console.log(`  Poll Interval:       ${CONFIG.pollIntervalMs}ms`);

  if (!allRequired) {
    console.log('\n\x1b[31mConfiguration incomplete. Set required variables in .env\x1b[0m\n');
    process.exit(1);
  }

  console.log('\n\x1b[32mConfiguration OK\x1b[0m\n');
}

async function testApi() {
  console.log('\n=== Polymarket API Test ===\n');

  if (!CONFIG.privateKey) {
    log('warn', 'WALLET_PRIVATE_KEY not set - skipping API test');
    console.log('\nTo test the API, add your wallet private key to .env\n');
    return;
  }

  try {
    const api = new PolymarketAPI({
      paperMode: true,
      log: log,
    });

    log('info', 'Initializing API...');
    await api.initialize();
    log('success', 'API initialized');

    log('info', 'Fetching wallet balance...');
    const balance = await api.getBalance();
    log('success', `Balance: $${balance.balance.toFixed(2)} USDC`);

    log('info', 'Testing market lookup...');
    const market = await api.findMarketByQuestion('Bitcoin Up or Down');
    if (market) {
      log('success', `Found market: ${market.question?.slice(0, 60)}...`);
    } else {
      log('warn', 'No active Bitcoin Up/Down market found (may be between windows)');
    }

    console.log('\n\x1b[32mAPI Test Passed\x1b[0m\n');
  } catch (err) {
    log('error', 'API test failed', { error: err.message });
    console.log('\nTroubleshooting:');
    console.log('  1. Check WALLET_PRIVATE_KEY is correct');
    console.log('  2. Ensure wallet has been used on Polymarket');
    console.log('  3. Check internet/proxy connection\n');
    process.exit(1);
  }
}

async function showStatus() {
  console.log('\n=== Trade Copier Status ===\n');

  const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

  // Get today's stats
  const today = new Date().toISOString().split('T')[0];

  const { data: dailyStats } = await supabase
    .from('daily_stats')
    .select('*')
    .eq('date', today)
    .single();

  const { data: recentTrades } = await supabase
    .from('my_trades')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  const { count: totalTrades } = await supabase
    .from('my_trades')
    .select('*', { count: 'exact', head: true });

  console.log('Today\'s Stats:');
  if (dailyStats) {
    console.log(`  Trades:     ${dailyStats.trades_count || 0}`);
    console.log(`  Volume:     $${(dailyStats.total_volume || 0).toFixed(2)}`);
    console.log(`  P&L:        $${(dailyStats.realized_pnl || 0).toFixed(2)}`);
  } else {
    console.log('  No trades today');
  }

  console.log(`\nTotal Trades (all time): ${totalTrades || 0}`);

  if (recentTrades && recentTrades.length > 0) {
    console.log('\nRecent Trades:');
    for (const trade of recentTrades.slice(0, 5)) {
      const time = new Date(trade.created_at).toLocaleString();
      const status = trade.status === 'paper' ? '📝' : trade.status === 'filled' ? '✅' : trade.status === 'failed' ? '❌' : '⏳';
      console.log(`  ${status} ${time} | ${trade.side} ${trade.outcome} @ ${trade.price} | $${trade.size} | ${trade.market_question?.slice(0, 40)}...`);
    }
  }

  console.log('');
}

async function runCopier(liveMode = false) {
  const paperMode = !liveMode;

  console.log('\n' + '='.repeat(60));
  console.log(paperMode
    ? '  🧪 TRADE COPIER - PAPER TRADING MODE'
    : '  💰 TRADE COPIER - LIVE TRADING MODE');
  console.log('='.repeat(60) + '\n');

  if (liveMode) {
    console.log('\x1b[33m⚠️  LIVE TRADING ENABLED - Real money will be used!\x1b[0m');
    console.log('    Starting in 5 seconds... (Ctrl+C to cancel)\n');
    await new Promise(r => setTimeout(r, 5000));
  }

  // Initialize Supabase
  const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

  // Test connection
  const { error: dbError } = await supabase.from('tracked_wallets').select('count').single();
  if (dbError && dbError.code !== 'PGRST116') {
    log('error', 'Database connection failed', { error: dbError.message });
    process.exit(1);
  }
  log('success', 'Database connected');

  // Initialize copier
  const copier = new TradeCopier({
    supabase,
    paperMode,
    log: log,
  });

  await copier.initialize();

  // Send startup alert
  await sendTelegramAlert(
    `🤖 *Trade Copier Started*\n` +
    `Mode: ${paperMode ? 'Paper Trading 📝' : 'Live Trading 💰'}\n` +
    `Trade Size: $${CONFIG.copyTradeSize.toFixed(2)}\n` +
    `Target: distinct-baguette`
  );

  // Start polling
  copier.startPolling(CONFIG.pollIntervalMs);

  // Status logging every minute
  const statusInterval = setInterval(() => {
    const stats = copier.getStats();
    log('info', 'Status update', {
      checked: stats.tradesChecked,
      matched: stats.tradesMatched,
      copied: stats.tradesCopied,
      skipped: stats.tradesSkipped,
      errors: stats.errors,
    });
  }, 60000);

  // Graceful shutdown
  const shutdown = async (signal) => {
    log('info', `Shutdown signal received: ${signal}`);
    clearInterval(statusInterval);
    copier.stopPolling();

    // Save final state
    if (supabase) {
      await copier.riskManager.saveState(supabase);
    }

    // Send shutdown alert
    await sendTelegramAlert(
      `🛑 *Trade Copier Stopped*\n` +
      `Trades copied: ${copier.stats.tradesCopied}\n` +
      `Trades skipped: ${copier.stats.tradesSkipped}`
    );

    log('info', 'Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep running
  log('info', 'Trade copier running. Press Ctrl+C to stop.');
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Trade Copier CLI

Usage:
  node run-copier.js              Run in paper trading mode (safe, no real trades)
  node run-copier.js --live       Run in live trading mode (uses real money!)
  node run-copier.js --check      Check configuration
  node run-copier.js --status     Show current status
  node run-copier.js --test-api   Test Polymarket API connection

Environment Variables (set in .env):
  SUPABASE_URL            Supabase project URL
  SUPABASE_ANON_KEY       Supabase anon key
  WALLET_ADDRESS          Your Polymarket wallet address
  WALLET_PRIVATE_KEY      Your wallet private key (for live trading)
  COPY_TRADE_SIZE         Amount to trade per copy ($1.50 default)
  MIN_WHALE_SIZE          Min whale trade size to copy ($10 default)
  MAX_POSITION_PER_MARKET Max exposure per market ($5 default)
  MIN_BALANCE_TO_TRADE    Stop trading below this ($10 default)
  DAILY_LOSS_LIMIT        Stop if daily loss exceeds ($15 default)
`);
    return;
  }

  if (args.includes('--check')) {
    await checkConfig();
    return;
  }

  if (args.includes('--test-api')) {
    await checkConfig();
    await testApi();
    return;
  }

  if (args.includes('--status')) {
    await showStatus();
    return;
  }

  // Default: run the copier
  const liveMode = args.includes('--live');
  await runCopier(liveMode);
}

main().catch(err => {
  log('error', 'Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
