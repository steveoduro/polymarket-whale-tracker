#!/usr/bin/env node
/**
 * Weather Mispricing Bot - CLI Runner
 *
 * Exploits mispriced probability distributions in Polymarket temperature markets.
 *
 * Usage:
 *   node run-weather-bot.js           # Paper trading mode (default)
 *   node run-weather-bot.js --live    # Live trading (real money!)
 *   node run-weather-bot.js --scan    # Scan only, no trades
 *   node run-weather-bot.js --status  # Show performance stats
 *   node run-weather-bot.js --resolve # Check resolutions only
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { WeatherAPI } = require('./lib/weather-api');
const { MarketScanner } = require('./lib/market-scanner');
const { MispricingDetector } = require('./lib/mispricing-detector');
const { WeatherTrader } = require('./lib/weather-trader');
const { PolymarketAPI } = require('./lib/polymarket-api');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // Mode
  PAPER_MODE: true,

  // Capital
  PAPER_BANKROLL: 1000,
  MAX_POSITION_PCT: 0.30,         // Max 30% of capital per market
  MAX_PER_RANGE_PCT: 0.15,        // Max 15% per single range
  MAX_OPEN_POSITIONS: 10,         // Max markets at once

  // Strategy thresholds
  MIN_MISPRICING_PCT: 2,          // Only trade if 2%+ edge
  MIN_RANGE_PRICE: 0.10,          // Range must be at least 10¢
  MAX_RANGE_PRICE: 0.85,          // Don't buy above 85¢
  HEDGE_RANGES: true,             // Spread across nearby ranges

  // Polling - maximize 10k calls/day
  SCAN_INTERVAL_MS: 2 * 60 * 1000,       // Scan every 2 minutes
  RESOLUTION_CHECK_MS: 30 * 60 * 1000,   // Check resolutions every 30 min

  // Cities - all supported
  ACTIVE_CITIES: [
    'london', 'nyc', 'atlanta', 'miami', 'chicago',
    'dallas', 'seattle', 'toronto', 'seoul',
    'buenos aires', 'ankara', 'wellington',
    'denver', 'phoenix', 'los angeles'
  ],

  // Alerts
  TELEGRAM_ON_TRADE: true,
  TELEGRAM_DAILY_SUMMARY: true,
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
    trade: '\x1b[35m[TRADE]\x1b[0m',
  }[level] || `[${level.toUpperCase()}]`;

  console.log(`${timestamp} ${prefix} ${message}${extra}`);
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

function formatTradeAlert(opportunity, positions) {
  const market = opportunity.market;
  const forecast = opportunity.forecast;
  const totalCost = positions.totalCost.toFixed(2);
  const maxPayout = positions.maxPayout;

  let msg = `🌡️ *WEATHER OPPORTUNITY*\n\n`;
  msg += `📍 ${market.city.toUpperCase()} - ${market.dateStr}\n`;
  msg += `🎯 Forecast: ${forecast.highC}°C / ${forecast.highF}°F (${forecast.confidence})\n\n`;
  msg += `*Market Analysis:*\n`;
  msg += `  Total probability: ${(opportunity.totalProbability * 100).toFixed(1)}%\n`;
  msg += `  Edge: ${opportunity.mispricingPct.toFixed(1)}%\n\n`;
  msg += `*Position (Paper):*\n`;

  for (const pos of positions.positions) {
    msg += `  Buy ${pos.range}: $${pos.amount.toFixed(2)} @ ${(pos.price * 100).toFixed(0)}¢\n`;
  }

  msg += `\n💰 Cost: $${totalCost} | Max Payout: $${maxPayout}`;

  return msg;
}

function formatResolutionAlert(result, stats) {
  const { trade, actualTemp, winningRange, won, pnl } = result;

  let msg = `📊 *WEATHER TRADE RESOLVED*\n\n`;
  msg += `📍 ${trade.city.toUpperCase()} - ${trade.target_date}\n`;
  msg += `🌡️ Actual High: ${actualTemp}°\n\n`;
  msg += `Result: ${won ? '✅ WON' : '❌ LOST'} (${winningRange || 'unknown'})\n`;
  msg += `  Position: $${trade.cost.toFixed(2)} @ ${(trade.entry_price * 100).toFixed(0)}¢\n`;
  msg += `  P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n\n`;
  msg += `Running: $${stats.totalPnL.toFixed(2)} (${stats.wins}W/${stats.losses}L, ${stats.winRate})`;

  return msg;
}

// =============================================================================
// MAIN BOT CLASS
// =============================================================================

class WeatherBot {
  constructor(paperMode = true) {
    this.paperMode = paperMode;
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    this.weatherApi = new WeatherAPI({ log });
    this.marketScanner = new MarketScanner({ log });
    this.detector = new MispricingDetector({
      minMispricingPct: CONFIG.MIN_MISPRICING_PCT,
      minRangePrice: CONFIG.MIN_RANGE_PRICE,
      maxRangePrice: CONFIG.MAX_RANGE_PRICE,
      log,
    });
    this.trader = new WeatherTrader({
      supabase: this.supabase,
      paperMode: this.paperMode,
      paperBankroll: CONFIG.PAPER_BANKROLL,
      log,
    });

    this.isRunning = false;
    this.scanInterval = null;
    this.resolveInterval = null;
    this.lastScanTime = null;
  }

  async initialize() {
    log('info', 'Initializing Weather Bot...', { paperMode: this.paperMode });

    // Test DB connection
    const { error } = await this.supabase.from('weather_paper_trades').select('count').limit(1);
    if (error && !error.message.includes('does not exist')) {
      log('warn', 'DB tables may not exist - run schema-weather.sql first');
    }

    log('success', 'Weather Bot initialized');
  }

  async runScanCycle() {
    log('info', '=== Starting scan cycle ===');
    this.lastScanTime = new Date();

    try {
      // 1. Get active temperature markets
      const markets = await this.marketScanner.getActiveTemperatureMarkets();
      log('info', `Found ${markets.length} temperature markets`);

      // 2. Filter for active cities and valid dates
      const today = new Date();
      const validMarkets = markets.filter(m => {
        const cityMatch = CONFIG.ACTIVE_CITIES.includes(m.city);
        const dateValid = m.date > today; // Future date only
        const notTooFar = (m.date - today) < 7 * 86400000; // Within 7 days
        return cityMatch && dateValid && notTooFar;
      });

      log('info', `${validMarkets.length} markets match city/date filters`);

      // 3. Check each market for opportunities
      const opportunities = [];

      for (const market of validMarkets) {
        // Skip if we already have a position
        const hasPosition = await this.trader.hasExistingPosition(market.slug);
        if (hasPosition) {
          continue;
        }

        // Get forecast
        const forecast = await this.weatherApi.getForecastForDate(market.city, market.dateStr);
        if (!forecast) continue;

        // Analyze for mispricing
        const opportunity = this.detector.analyzeMarket(market, forecast);
        if (opportunity) {
          opportunities.push(opportunity);
        }
      }

      // 4. Rank and trade opportunities
      const ranked = this.detector.rankOpportunities(opportunities);
      log('info', `Found ${ranked.length} profitable opportunities`);

      // Check position limit
      const openCount = await this.trader.getOpenPositionCount();
      const slotsAvailable = CONFIG.MAX_OPEN_POSITIONS - openCount;

      for (const opp of ranked.slice(0, slotsAvailable)) {
        await this.executeOpportunity(opp);
      }

      // Log API usage
      const apiStats = this.weatherApi.getStats();
      log('info', 'Scan cycle complete', {
        marketsScanned: validMarkets.length,
        opportunities: ranked.length,
        apiCalls: apiStats.requestCount,
      });

    } catch (err) {
      log('error', 'Scan cycle failed', { error: err.message });
    }
  }

  async executeOpportunity(opportunity) {
    // Generate position sizes
    const capital = this.trader.paperBalance;
    const positions = this.detector.generatePositions(opportunity, capital, {
      maxPositionPct: CONFIG.MAX_POSITION_PCT,
      maxPerRange: CONFIG.MAX_PER_RANGE_PCT,
      hedgeRanges: CONFIG.HEDGE_RANGES,
    });

    if (positions.positions.length === 0) {
      log('warn', 'No valid positions generated', { market: opportunity.market.slug });
      return;
    }

    log('trade', 'Executing opportunity', {
      city: opportunity.market.city,
      date: opportunity.market.dateStr,
      edge: opportunity.mispricingPct.toFixed(1) + '%',
      cost: positions.totalCost.toFixed(2),
    });

    // Execute trades
    const results = await this.trader.executeTrades(opportunity, positions);

    // Send Telegram alert
    if (CONFIG.TELEGRAM_ON_TRADE) {
      const alert = formatTradeAlert(opportunity, positions);
      await sendTelegram(alert);
    }
  }

  async runResolutionCycle() {
    log('info', '=== Checking resolutions ===');

    try {
      const resolved = await this.trader.checkResolutions(this.weatherApi);

      if (resolved.length > 0) {
        const stats = await this.trader.getStats();

        for (const result of resolved) {
          if (CONFIG.TELEGRAM_ON_TRADE) {
            const alert = formatResolutionAlert(result, stats);
            await sendTelegram(alert);
          }
        }

        log('info', `Resolved ${resolved.length} trades`, {
          wins: resolved.filter(r => r.won).length,
          losses: resolved.filter(r => !r.won).length,
        });
      }
    } catch (err) {
      log('error', 'Resolution check failed', { error: err.message });
    }
  }

  start() {
    if (this.isRunning) {
      log('warn', 'Bot already running');
      return;
    }

    this.isRunning = true;
    log('info', 'Starting Weather Bot', {
      scanInterval: CONFIG.SCAN_INTERVAL_MS / 1000 + 's',
      resolveInterval: CONFIG.RESOLUTION_CHECK_MS / 1000 + 's',
    });

    // Initial runs
    this.runScanCycle();
    this.runResolutionCycle();

    // Set up intervals
    this.scanInterval = setInterval(() => this.runScanCycle(), CONFIG.SCAN_INTERVAL_MS);
    this.resolveInterval = setInterval(() => this.runResolutionCycle(), CONFIG.RESOLUTION_CHECK_MS);
  }

  stop() {
    if (this.scanInterval) clearInterval(this.scanInterval);
    if (this.resolveInterval) clearInterval(this.resolveInterval);
    this.isRunning = false;
    log('info', 'Weather Bot stopped');
  }

  async getStats() {
    return await this.trader.getStats();
  }
}

// =============================================================================
// CLI COMMANDS
// =============================================================================

async function showStatus() {
  console.log('\n=== Weather Bot Status ===\n');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  // Get trade stats
  const { data: trades } = await supabase
    .from('weather_paper_trades')
    .select('status, pnl, cost, city, target_date, range_name')
    .order('created_at', { ascending: false });

  if (!trades || trades.length === 0) {
    console.log('No trades recorded yet.\n');
    return;
  }

  const wins = trades.filter(t => t.status === 'won');
  const losses = trades.filter(t => t.status === 'lost');
  const open = trades.filter(t => t.status === 'open');
  const totalPnL = trades.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
  const totalCost = trades.reduce((sum, t) => sum + (parseFloat(t.cost) || 0), 0);

  console.log('Overall Performance:');
  console.log(`  Total Trades: ${trades.length}`);
  console.log(`  Wins: ${wins.length}`);
  console.log(`  Losses: ${losses.length}`);
  console.log(`  Open: ${open.length}`);
  console.log(`  Win Rate: ${wins.length + losses.length > 0 ? ((wins.length / (wins.length + losses.length)) * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  Total P&L: $${totalPnL.toFixed(2)}`);
  console.log(`  Total Cost: $${totalCost.toFixed(2)}`);
  console.log(`  ROI: ${totalCost > 0 ? ((totalPnL / totalCost) * 100).toFixed(1) + '%' : 'N/A'}`);

  // Recent trades
  console.log('\nRecent Trades:');
  for (const trade of trades.slice(0, 10)) {
    const icon = trade.status === 'won' ? '✅' : trade.status === 'lost' ? '❌' : '⏳';
    const pnlStr = trade.pnl !== null ? ` | P&L: $${parseFloat(trade.pnl).toFixed(2)}` : '';
    console.log(`  ${icon} ${trade.city} ${trade.target_date} | ${trade.range_name} | $${parseFloat(trade.cost).toFixed(2)}${pnlStr}`);
  }

  // By city
  console.log('\nPerformance by City:');
  const byCity = {};
  for (const t of trades) {
    if (!byCity[t.city]) byCity[t.city] = { wins: 0, losses: 0, pnl: 0 };
    if (t.status === 'won') byCity[t.city].wins++;
    if (t.status === 'lost') byCity[t.city].losses++;
    byCity[t.city].pnl += parseFloat(t.pnl) || 0;
  }
  for (const [city, stats] of Object.entries(byCity)) {
    const wr = stats.wins + stats.losses > 0 ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0) + '%' : '-';
    console.log(`  ${city.padEnd(15)} ${stats.wins}W/${stats.losses}L (${wr}) | $${stats.pnl.toFixed(2)}`);
  }

  console.log('');
}

async function scanOnly() {
  console.log('\n=== Scan Mode (No Trading) ===\n');

  const weatherApi = new WeatherAPI({ log });
  const scanner = new MarketScanner({ log });
  const detector = new MispricingDetector({
    minMispricingPct: CONFIG.MIN_MISPRICING_PCT,
    minRangePrice: CONFIG.MIN_RANGE_PRICE,
    maxRangePrice: CONFIG.MAX_RANGE_PRICE,
    log,
  });

  const markets = await scanner.getActiveTemperatureMarkets();
  console.log(`Found ${markets.length} temperature markets\n`);

  const today = new Date();
  let opportunityCount = 0;

  for (const market of markets) {
    if (!CONFIG.ACTIVE_CITIES.includes(market.city)) continue;
    if (market.date <= today) continue;

    const forecast = await weatherApi.getForecastForDate(market.city, market.dateStr);
    if (!forecast) continue;

    const opp = detector.analyzeMarket(market, forecast);
    if (opp) {
      opportunityCount++;
      console.log(`\n📊 OPPORTUNITY: ${market.city.toUpperCase()} - ${market.dateStr}`);
      console.log(`   Forecast: ${forecast.highC}°C / ${forecast.highF}°F (${forecast.confidence})`);
      console.log(`   Total Prob: ${(opp.totalProbability * 100).toFixed(1)}%`);
      console.log(`   Edge: ${opp.mispricingPct.toFixed(1)}%`);
      console.log(`   Best Range: ${opp.bestRange.name} @ ${(opp.bestRange.price * 100).toFixed(0)}¢`);
      console.log(`   EV: ${(opp.expectedValue.evPct).toFixed(1)}% per dollar`);
    }
  }

  console.log(`\n\nTotal opportunities found: ${opportunityCount}\n`);
}

async function resolveOnly() {
  console.log('\n=== Resolution Check ===\n');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const weatherApi = new WeatherAPI({ log });
  const trader = new WeatherTrader({ supabase, paperMode: true, log });

  const resolved = await trader.checkResolutions(weatherApi);

  if (resolved.length === 0) {
    console.log('No trades to resolve.\n');
  } else {
    console.log(`Resolved ${resolved.length} trades.\n`);
  }
}

async function runBot(liveMode = false) {
  const paperMode = !liveMode;

  console.log('\n' + '='.repeat(60));
  console.log(paperMode
    ? '  🌡️ WEATHER BOT - PAPER TRADING MODE'
    : '  💰 WEATHER BOT - LIVE TRADING MODE');
  console.log('='.repeat(60) + '\n');

  if (liveMode) {
    console.log('\x1b[33m⚠️  LIVE TRADING - Real money will be used!\x1b[0m');
    console.log('    Starting in 5 seconds... (Ctrl+C to cancel)\n');
    await new Promise(r => setTimeout(r, 5000));
  }

  const bot = new WeatherBot(paperMode);
  await bot.initialize();

  await sendTelegram(
    `🌡️ *Weather Bot Started*\n` +
    `Mode: ${paperMode ? 'Paper 📝' : 'Live 💰'}\n` +
    `Capital: $${CONFIG.PAPER_BANKROLL}\n` +
    `Cities: ${CONFIG.ACTIVE_CITIES.length}`
  );

  bot.start();

  // Graceful shutdown
  const shutdown = async (signal) => {
    log('info', `Shutdown: ${signal}`);
    bot.stop();

    const stats = await bot.getStats();
    await sendTelegram(
      `🛑 *Weather Bot Stopped*\n` +
      `Trades: ${stats.totalTrades || 0}\n` +
      `P&L: $${(stats.totalPnL || 0).toFixed(2)}\n` +
      `Win Rate: ${stats.winRate || 'N/A'}`
    );

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log('info', 'Weather bot running. Press Ctrl+C to stop.');
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Weather Mispricing Bot

Usage:
  node run-weather-bot.js           Paper trading mode (default)
  node run-weather-bot.js --live    Live trading (real money!)
  node run-weather-bot.js --scan    Scan only, no trades
  node run-weather-bot.js --status  Show performance stats
  node run-weather-bot.js --resolve Check resolutions only

Strategy:
  Exploits mispriced probability distributions in temperature markets.
  When total probability < 100%, free edge exists.
`);
    return;
  }

  if (args.includes('--status')) {
    await showStatus();
    return;
  }

  if (args.includes('--scan')) {
    await scanOnly();
    return;
  }

  if (args.includes('--resolve')) {
    await resolveOnly();
    return;
  }

  const liveMode = args.includes('--live');
  await runBot(liveMode);
}

main().catch(err => {
  log('error', 'Fatal error', { error: err.message });
  process.exit(1);
});
