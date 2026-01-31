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
  MAX_OPEN_POSITIONS: 10,         // Max markets at once

  // Risk Management (Kelly Criterion)
  MIN_PROBABILITY: parseFloat(process.env.MIN_PROBABILITY) || 0.20,  // Only trade ranges ≥20% probability
  KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION) || 0.5,     // Half Kelly (conservative)
  MAX_POSITION_PCT: parseFloat(process.env.MAX_POSITION_PERCENT) || 0.10,  // Max 10% of bankroll per position
  MIN_BET_SIZE: parseFloat(process.env.MIN_BET_SIZE) || 10,          // Minimum $10 per trade

  // Legacy settings (now calculated via Kelly, kept for reference)
  MAX_PER_RANGE_PCT: 0.10,        // Superseded by Kelly sizing
  HEDGE_RANGES: false,            // Disabled - Kelly sizes individual positions

  // Strategy thresholds
  MIN_MISPRICING_PCT: 2,          // Only trade if 2%+ edge
  MIN_RANGE_PRICE: 0.10,          // Range must be at least 10¢ (superseded by MIN_PROBABILITY)
  MAX_RANGE_PRICE: 0.85,          // Don't buy above 85¢

  // Forecast Arbitrage settings
  FORECAST_SHIFT_MIN_F: 2,        // Minimum 2°F shift to trigger
  FORECAST_SHIFT_MIN_C: 1,        // Minimum 1°C shift to trigger
  FORECAST_COMPARE_HOURS: 2,      // Compare to forecast from 2 hours ago

  // Polling - optimize for API limits
  SCAN_INTERVAL_MS: 5 * 60 * 1000,       // Scan every 5 minutes
  RESOLUTION_CHECK_MS: 30 * 60 * 1000,   // Check resolutions every 30 min

  // Cities - 12 active Polymarket weather markets
  ACTIVE_CITIES: [
    'nyc', 'london', 'seoul', 'dallas', 'toronto',
    'miami', 'buenos aires', 'atlanta', 'chicago',
    'seattle', 'ankara', 'wellington'
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
  const strategy = opportunity.strategy || 'range_mispricing';

  let msg = strategy === 'forecast_arbitrage'
    ? `📈 *FORECAST SHIFT DETECTED*\n\n`
    : `🌡️ *WEATHER OPPORTUNITY*\n\n`;

  msg += `📍 ${market.city.toUpperCase()} - ${market.dateStr}\n`;
  msg += `🎯 Forecast: ${forecast.highC}°C / ${forecast.highF}°F (${forecast.confidence})\n`;

  // Add shift info for forecast arbitrage
  if (strategy === 'forecast_arbitrage' && opportunity.forecastShift) {
    const shift = opportunity.forecastShift;
    msg += `🔄 Shift: ${shift.shiftF > 0 ? '+' : ''}${shift.shiftF}°F (${shift.direction})\n`;
    msg += `   Previous: ${shift.previousHighF}°F → Now: ${shift.currentHighF}°F\n`;
  }

  msg += `\n*Strategy:* ${strategy === 'forecast_arbitrage' ? 'Forecast Arbitrage' : 'Range Mispricing'}\n`;
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
      // Risk management
      minProbability: CONFIG.MIN_PROBABILITY,
      kellyFraction: CONFIG.KELLY_FRACTION,
      maxPositionPct: CONFIG.MAX_POSITION_PCT,
      minBetSize: CONFIG.MIN_BET_SIZE,
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
      // 1. Get active markets (temperature + precipitation)
      const tempMarkets = await this.marketScanner.getActiveTemperatureMarkets();
      const precipMarkets = await this.marketScanner.getActivePrecipitationMarkets();
      const markets = tempMarkets; // Keep for backwards compatibility below

      log('info', `Found ${tempMarkets.length} temperature markets, ${precipMarkets.length} precipitation markets`);

      // 2. Filter for active cities and valid dates
      const today = new Date();
      const validMarkets = markets.filter(m => {
        const cityMatch = CONFIG.ACTIVE_CITIES.includes(m.city);
        const dateValid = m.date > today; // Future date only
        const notTooFar = (m.date - today) < 7 * 86400000; // Within 7 days
        return cityMatch && dateValid && notTooFar;
      });

      log('info', `${validMarkets.length} markets match city/date filters`);

      // 3. Check each market for opportunities (BOTH strategies)
      const rangeMispricingOpps = [];
      const forecastArbitrageOpps = [];

      for (const market of validMarkets) {
        // Skip if we already have a position
        const hasPosition = await this.trader.hasExistingPosition(market.slug);
        if (hasPosition) {
          continue;
        }

        // Get forecast
        const forecast = await this.weatherApi.getForecastForDate(market.city, market.dateStr);
        if (!forecast) continue;

        // Save forecast to history (for future shift detection)
        await this.weatherApi.saveForecastHistory(this.supabase, forecast);

        // === STRATEGY 1: Range Mispricing ===
        const mispricingOpp = this.detector.analyzeMarket(market, forecast);
        if (mispricingOpp) {
          mispricingOpp.strategy = 'range_mispricing';
          rangeMispricingOpps.push(mispricingOpp);
        }

        // === STRATEGY 2: Forecast Arbitrage ===
        // Get previous forecast from N hours ago
        const previousForecast = await this.weatherApi.getPreviousForecast(
          this.supabase,
          market.city,
          market.dateStr,
          CONFIG.FORECAST_COMPARE_HOURS
        );

        if (previousForecast) {
          // Check for significant shift
          const forecastShift = this.weatherApi.compareForecast(forecast, previousForecast, {
            minShiftF: CONFIG.FORECAST_SHIFT_MIN_F,
            minShiftC: CONFIG.FORECAST_SHIFT_MIN_C,
          });

          if (forecastShift) {
            log('info', 'Forecast shift detected', {
              city: market.city,
              date: market.dateStr,
              shift: `${forecastShift.shiftF}°F (${forecastShift.direction})`,
              hours: forecastShift.hoursElapsed,
            });

            const shiftOpp = this.detector.detectForecastShift(market, forecast, forecastShift);
            if (shiftOpp) {
              forecastArbitrageOpps.push(shiftOpp);
            }
          }
        }
      }

      // 4. Analyze precipitation markets
      const precipitationOpps = [];
      for (const market of precipMarkets) {
        // Skip if we already have a position
        const hasPosition = await this.trader.hasExistingPosition(market.slug);
        if (hasPosition) continue;

        // Get monthly precipitation forecast
        const forecast = await this.weatherApi.getMonthlyPrecipitationForecast(
          market.city,
          market.monthIdx,
          market.year
        );
        if (!forecast) continue;

        // Analyze for mispricing
        const opportunity = this.detector.analyzePrecipitationMarket(market, forecast);
        if (opportunity) {
          precipitationOpps.push(opportunity);
        }
      }

      // 5. Rank opportunities from all strategies
      const rankedMispricing = this.detector.rankOpportunities(rangeMispricingOpps);
      const rankedShifts = this.detector.rankForecastShiftOpportunities(forecastArbitrageOpps);
      const rankedPrecip = this.detector.rankPrecipitationOpportunities(precipitationOpps);

      log('info', `Strategy 1 (Range Mispricing): ${rankedMispricing.length} profitable opportunities`);
      log('info', `Strategy 2 (Forecast Arbitrage): ${rankedShifts.length} shift opportunities`);
      log('info', `Strategy 3 (Precipitation): ${rankedPrecip.length} precipitation opportunities`);

      // 6. Combine and execute (prioritize forecast shifts as they're time-sensitive)
      const allOpportunities = [...rankedShifts, ...rankedMispricing, ...rankedPrecip];

      // Check position limit
      const openCount = await this.trader.getOpenPositionCount();
      const slotsAvailable = CONFIG.MAX_OPEN_POSITIONS - openCount;

      let executed = 0;
      const executedMarkets = new Set();

      for (const opp of allOpportunities) {
        if (executed >= slotsAvailable) break;

        // Don't trade same market twice in one cycle
        if (executedMarkets.has(opp.market.slug)) continue;

        await this.executeOpportunity(opp);
        executedMarkets.add(opp.market.slug);
        executed++;
      }

      // Log API usage
      const apiStats = this.weatherApi.getStats();
      log('info', 'Scan cycle complete', {
        tempMarketsScanned: validMarkets.length,
        precipMarketsScanned: precipMarkets.length,
        rangeMispricingOpps: rankedMispricing.length,
        forecastShiftOpps: rankedShifts.length,
        precipitationOpps: rankedPrecip.length,
        executed: executed,
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
    .select('status, pnl, cost, city, target_date, range_name, strategy, forecast_shift_f')
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

  // Performance by Strategy
  console.log('\nPerformance by Strategy:');
  const byStrategy = {};
  for (const t of trades) {
    const strat = t.strategy || 'range_mispricing';
    if (!byStrategy[strat]) byStrategy[strat] = { wins: 0, losses: 0, pnl: 0, cost: 0 };
    if (t.status === 'won') byStrategy[strat].wins++;
    if (t.status === 'lost') byStrategy[strat].losses++;
    byStrategy[strat].pnl += parseFloat(t.pnl) || 0;
    byStrategy[strat].cost += parseFloat(t.cost) || 0;
  }
  for (const [strat, stats] of Object.entries(byStrategy)) {
    const wr = stats.wins + stats.losses > 0 ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0) + '%' : '-';
    const roi = stats.cost > 0 ? ((stats.pnl / stats.cost) * 100).toFixed(1) + '%' : '-';
    const stratName = strat === 'forecast_arbitrage' ? 'Forecast Arbitrage' : 'Range Mispricing';
    console.log(`  ${stratName.padEnd(20)} ${stats.wins}W/${stats.losses}L (${wr}) | P&L: $${stats.pnl.toFixed(2)} | ROI: ${roi}`);
  }

  // Performance by Market Type
  console.log('\nPerformance by Market Type:');
  const byMarketType = {};
  for (const t of trades) {
    const mtype = t.market_type || 'temperature';
    if (!byMarketType[mtype]) byMarketType[mtype] = { wins: 0, losses: 0, pnl: 0, cost: 0 };
    if (t.status === 'won') byMarketType[mtype].wins++;
    if (t.status === 'lost') byMarketType[mtype].losses++;
    byMarketType[mtype].pnl += parseFloat(t.pnl) || 0;
    byMarketType[mtype].cost += parseFloat(t.cost) || 0;
  }
  for (const [mtype, stats] of Object.entries(byMarketType)) {
    const wr = stats.wins + stats.losses > 0 ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(0) + '%' : '-';
    const roi = stats.cost > 0 ? ((stats.pnl / stats.cost) * 100).toFixed(1) + '%' : '-';
    const typeName = mtype.charAt(0).toUpperCase() + mtype.slice(1);
    console.log(`  ${typeName.padEnd(15)} ${stats.wins}W/${stats.losses}L (${wr}) | P&L: $${stats.pnl.toFixed(2)} | ROI: ${roi}`);
  }

  // Recent trades
  console.log('\nRecent Trades:');
  for (const trade of trades.slice(0, 10)) {
    const icon = trade.status === 'won' ? '✅' : trade.status === 'lost' ? '❌' : '⏳';
    const pnlStr = trade.pnl !== null ? ` | P&L: $${parseFloat(trade.pnl).toFixed(2)}` : '';
    const stratIcon = trade.strategy === 'forecast_arbitrage' ? '📈' : '📊';
    const shiftStr = trade.forecast_shift_f ? ` [${trade.forecast_shift_f > 0 ? '+' : ''}${trade.forecast_shift_f}°F]` : '';
    console.log(`  ${icon} ${stratIcon} ${trade.city} ${trade.target_date} | ${trade.range_name}${shiftStr} | $${parseFloat(trade.cost).toFixed(2)}${pnlStr}`);
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

  // Forecast accuracy stats
  await showForecastAccuracy(supabase);

  // Risk settings
  console.log('\n⚙️  Risk Settings:');
  console.log(`   Min Probability: ${(CONFIG.MIN_PROBABILITY * 100).toFixed(0)}%`);
  console.log(`   Kelly Fraction: ${(CONFIG.KELLY_FRACTION * 100).toFixed(0)}% (${CONFIG.KELLY_FRACTION === 0.5 ? 'Half Kelly' : CONFIG.KELLY_FRACTION === 0.25 ? 'Quarter Kelly' : 'Custom'})`);
  console.log(`   Max Position: ${(CONFIG.MAX_POSITION_PCT * 100).toFixed(0)}% of bankroll`);
  console.log(`   Min Bet Size: $${CONFIG.MIN_BET_SIZE}`);

  console.log('');
}

async function showForecastAccuracy(supabase) {
  const { data } = await supabase
    .from('forecast_accuracy')
    .select('*')
    .not('actual_temp_f', 'is', null);

  if (!data || data.length === 0) {
    console.log('\n📊 Forecast Accuracy: No data yet (waiting for market resolutions)');
    return;
  }

  const openMeteoErrors = data.map(d => parseFloat(d.open_meteo_error_f)).filter(e => !isNaN(e));
  const tomorrowErrors = data.map(d => parseFloat(d.tomorrow_error_f)).filter(e => !isNaN(e));

  const avgOpenMeteo = openMeteoErrors.length > 0
    ? openMeteoErrors.reduce((a, b) => a + b, 0) / openMeteoErrors.length
    : null;
  const avgTomorrow = tomorrowErrors.length > 0
    ? tomorrowErrors.reduce((a, b) => a + b, 0) / tomorrowErrors.length
    : null;

  console.log('\n📊 Forecast Accuracy:');
  if (avgOpenMeteo !== null) {
    console.log(`   Open-Meteo:   ${avgOpenMeteo.toFixed(1)}°F avg error (${openMeteoErrors.length} markets)`);
  }
  if (avgTomorrow !== null) {
    console.log(`   Tomorrow.io:  ${avgTomorrow.toFixed(1)}°F avg error (${tomorrowErrors.length} markets)`);
    if (avgOpenMeteo !== null) {
      const better = avgTomorrow < avgOpenMeteo ? 'Tomorrow.io' : 'Open-Meteo';
      const diff = Math.abs(avgOpenMeteo - avgTomorrow);
      console.log(`   Better source: ${better} (by ${diff.toFixed(1)}°F)`);
    }
  }
}

async function scanOnly() {
  console.log('\n=== Scan Mode (No Trading) ===\n');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const weatherApi = new WeatherAPI({ log });
  const scanner = new MarketScanner({ log });
  const detector = new MispricingDetector({
    minMispricingPct: CONFIG.MIN_MISPRICING_PCT,
    minRangePrice: CONFIG.MIN_RANGE_PRICE,
    maxRangePrice: CONFIG.MAX_RANGE_PRICE,
    // Risk management
    minProbability: CONFIG.MIN_PROBABILITY,
    kellyFraction: CONFIG.KELLY_FRACTION,
    maxPositionPct: CONFIG.MAX_POSITION_PCT,
    minBetSize: CONFIG.MIN_BET_SIZE,
    log,
  });

  const markets = await scanner.getActiveTemperatureMarkets();
  console.log(`Found ${markets.length} temperature markets\n`);

  const today = new Date();
  let mispricingCount = 0;
  let shiftCount = 0;

  for (const market of markets) {
    if (!CONFIG.ACTIVE_CITIES.includes(market.city)) continue;
    if (market.date <= today) continue;

    const forecast = await weatherApi.getForecastForDate(market.city, market.dateStr);
    if (!forecast) continue;

    // Save forecast to history
    await weatherApi.saveForecastHistory(supabase, forecast);

    // === STRATEGY 1: Range Mispricing ===
    const opp = detector.analyzeMarket(market, forecast);
    if (opp) {
      mispricingCount++;
      // Calculate Kelly size for display
      const kelly = detector.calculateKellySize(
        opp.marketProbability,
        opp.trueProbability,
        CONFIG.PAPER_BANKROLL
      );

      console.log(`\n📊 OPPORTUNITY: ${market.city.toUpperCase()} - ${market.dateStr}`);
      console.log(`   Forecast: ${forecast.highC}°C / ${forecast.highF}°F (${opp.confidence})`);
      // Show Tomorrow.io comparison for NYC
      if (forecast.tomorrowForecast) {
        console.log(`   Tomorrow.io: ${forecast.tomorrowForecast.highC}°C / ${forecast.tomorrowForecast.highF}°F`);
        if (opp.forecastNote) {
          console.log(`   Note: ${opp.forecastNote}`);
        }
      }
      console.log(`   Best Range: ${opp.bestRange.name} @ ${(opp.bestRange.price * 100).toFixed(0)}¢`);
      console.log(`   Market Prob: ${(opp.marketProbability * 100).toFixed(1)}% → Our Prob: ${(opp.trueProbability * 100).toFixed(1)}%`);
      console.log(`   Edge: ${opp.edgePct.toFixed(1)}% | EV: ${(opp.expectedValue.evPct).toFixed(1)}%/dollar`);
      console.log(`   Kelly Size: $${kelly.recommendedBet.toFixed(2)} (${kelly.percentOfBankroll.toFixed(1)}% of bankroll)`);
    }

    // === STRATEGY 2: Forecast Arbitrage ===
    const previousForecast = await weatherApi.getPreviousForecast(
      supabase,
      market.city,
      market.dateStr,
      CONFIG.FORECAST_COMPARE_HOURS
    );

    if (previousForecast) {
      const forecastShift = weatherApi.compareForecast(forecast, previousForecast, {
        minShiftF: CONFIG.FORECAST_SHIFT_MIN_F,
        minShiftC: CONFIG.FORECAST_SHIFT_MIN_C,
      });

      if (forecastShift) {
        const shiftOpp = detector.detectForecastShift(market, forecast, forecastShift);
        if (shiftOpp) {
          shiftCount++;
          console.log(`\n📈 FORECAST SHIFT: ${market.city.toUpperCase()} - ${market.dateStr}`);
          console.log(`   Shift: ${forecastShift.shiftF > 0 ? '+' : ''}${forecastShift.shiftF}°F (${forecastShift.direction})`);
          console.log(`   Previous: ${forecastShift.previousHighF}°F → Now: ${forecastShift.currentHighF}°F`);
          console.log(`   Hours ago: ${forecastShift.hoursElapsed}`);
          console.log(`   Best Range: ${shiftOpp.bestRange.name} @ ${(shiftOpp.bestRange.price * 100).toFixed(0)}¢`);
          console.log(`   EV: ${(shiftOpp.expectedValue.evPct).toFixed(1)}% per dollar`);
        }
      }
    }
  }

  // === PRECIPITATION MARKETS ===
  console.log(`\n${'='.repeat(50)}`);
  console.log('PRECIPITATION MARKETS');
  console.log('='.repeat(50));

  const precipMarkets = await scanner.getActivePrecipitationMarkets();
  console.log(`Found ${precipMarkets.length} precipitation markets\n`);

  let precipCount = 0;

  for (const market of precipMarkets) {
    const forecast = await weatherApi.getMonthlyPrecipitationForecast(
      market.city,
      market.monthIdx,
      market.year
    );
    if (!forecast) continue;

    const opp = detector.analyzePrecipitationMarket(market, forecast);
    if (opp) {
      precipCount++;
      // Calculate Kelly size for display
      const kelly = detector.calculateKellySize(
        opp.marketProbability,
        opp.trueProbability,
        CONFIG.PAPER_BANKROLL
      );

      console.log(`\n🌧️ PRECIPITATION: ${market.city.toUpperCase()} - ${market.month.toUpperCase()} ${market.year}`);
      console.log(`   Forecast: ${forecast.estimatedMonthlyInches}" (${forecast.forecastDays}/${forecast.daysInMonth} days covered)`);
      console.log(`   Confidence: ${forecast.confidence} (${Math.round(forecast.coverageRatio * 100)}% coverage)`);
      console.log(`   Best Range: ${opp.bestRange.name} @ ${(opp.bestRange.price * 100).toFixed(0)}¢`);
      console.log(`   Market Prob: ${(opp.marketProbability * 100).toFixed(1)}% → Our Prob: ${(opp.trueProbability * 100).toFixed(1)}%`);
      console.log(`   Edge: ${opp.edgePct.toFixed(1)}% | EV: ${(opp.expectedValue.evPct).toFixed(1)}%/dollar`);
      console.log(`   Kelly Size: $${kelly.recommendedBet.toFixed(2)} (${kelly.percentOfBankroll.toFixed(1)}% of bankroll)`);
    } else {
      // Show market even if no opportunity
      console.log(`\n🌧️ ${market.city.toUpperCase()} - ${market.month.toUpperCase()}: No opportunity (forecast: ${forecast?.estimatedMonthlyInches || '?'}")`);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log('SUMMARY');
  console.log('='.repeat(50));
  console.log(`Temperature - Range Mispricing: ${mispricingCount}`);
  console.log(`Temperature - Forecast Arbitrage: ${shiftCount}`);
  console.log(`Precipitation: ${precipCount}`);
  console.log(`Total opportunities: ${mispricingCount + shiftCount + precipCount}\n`);
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
