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
  MAX_DEPLOYED_PCT: parseFloat(process.env.MAX_DEPLOYED_PCT) || 0.80,  // Max 80% of bankroll deployed

  // Risk Management (Kelly Criterion)
  MIN_PROBABILITY: parseFloat(process.env.MIN_PROBABILITY) || 0.20,  // Only trade ranges ≥20% probability
  KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION) || 0.5,     // Half Kelly (conservative)
  MAX_POSITION_PCT: parseFloat(process.env.MAX_POSITION_PERCENT) || 0.20,  // Max 20% of bankroll per position
  MIN_BET_SIZE: parseFloat(process.env.MIN_BET_SIZE) || 10,          // Minimum $10 per trade

  // Legacy settings (now calculated via Kelly, kept for reference)
  MAX_PER_RANGE_PCT: 0.10,        // Superseded by Kelly sizing
  HEDGE_RANGES: false,            // Disabled - Kelly sizes individual positions

  // Strategy thresholds
  MIN_MISPRICING_PCT: 3,          // Only trade if 3%+ edge (percentage)
  MIN_EDGE_DOLLARS: 0.03,         // Only trade if $0.03+ edge per share after fees (lowered from $0.05 for more data)
  ENABLE_PRECIPITATION: false,    // Disabled: locks capital for full month, weak forecast signal
  MIN_RANGE_PRICE: 0.10,          // Range must be at least 10¢ (superseded by MIN_PROBABILITY)
  MAX_RANGE_PRICE: 0.85,          // Don't buy above 85¢

  // Forecast Arbitrage settings
  FORECAST_SHIFT_MIN_F: 2,        // Minimum 2°F shift to trigger
  FORECAST_SHIFT_MIN_C: 1,        // Minimum 1°C shift to trigger
  FORECAST_COMPARE_HOURS: 2,      // Compare to forecast from 2 hours ago

  // Polling - optimize for API limits
  SCAN_INTERVAL_MS: 5 * 60 * 1000,       // Scan every 5 minutes
  RESOLUTION_CHECK_MS: 30 * 60 * 1000,   // Check resolutions every 30 min

  // Cities - Polymarket + Kalshi weather markets
  ACTIVE_CITIES: [
    // Polymarket cities
    'nyc', 'london', 'seoul', 'dallas', 'toronto',
    'miami', 'buenos aires', 'atlanta', 'chicago',
    'seattle', 'ankara', 'wellington',
    // Kalshi-only cities (US markets, Fahrenheit)
    'denver', 'houston', 'los angeles', 'philadelphia',
    'dc', 'las vegas', 'new orleans', 'san francisco', 'austin'
  ],

  // Kalshi Integration
  KALSHI_ENABLED: false,  // Disabled: 13% win rate, -$203 P&L over 56 trades
  KALSHI_DEMO: process.env.KALSHI_DEMO === 'true',  // Default to production (demo URL doesn't exist)
  KALSHI_API_KEY: process.env.KALSHI_API_KEY || null,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH || null,
  PREFERRED_PLATFORM: process.env.PREFERRED_PLATFORM || 'best_price',  // 'polymarket', 'kalshi', or 'best_price'
  ENABLE_CROSS_PLATFORM_ARB: process.env.ENABLE_CROSS_PLATFORM_ARB === 'true',

  // Platform fees (for Kelly calculations)
  POLYMARKET_FEE: 0.0315,  // 3.15% taker fee
  KALSHI_FEE: 0.012,       // ~1.2% average fee

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

  // Platform tag for multi-platform mode
  const platform = market.platform || 'polymarket';
  const platformTag = platform === 'kalshi' ? '[KL] ' : (CONFIG.KALSHI_ENABLED ? '[PM] ' : '');

  let msg;

  // Different format for hedge trades
  if (opportunity.isHedge) {
    msg = `🛡️ ${platformTag}*HEDGE TRADE*\n\n`;
    msg += `📍 ${market.city.toUpperCase()} - ${market.dateStr}\n`;
    msg += `⚠️ Forecast shifted against your position!\n\n`;
    msg += `📊 *You hold:* ${opportunity.hedgingPosition}\n`;
    msg += `🔄 *New forecast:* ${forecast.highF}°F / ${forecast.highC}°C\n`;

    if (opportunity.forecastShift) {
      const shift = opportunity.forecastShift;
      msg += `   Shift: ${shift.shiftF > 0 ? '+' : ''}${shift.shiftF}°F (${shift.direction})\n`;
    }

    msg += `\n*Hedge Position:*\n`;
    for (const pos of positions.positions) {
      msg += `  Buy ${pos.range}: $${pos.amount.toFixed(2)} @ ${(pos.price * 100).toFixed(0)}¢\n`;
    }
    msg += `\n💰 Hedge Cost: $${totalCost}`;
    msg += `\n_Hedging reduces max win but protects against shifted forecast_`;

  } else if (strategy === 'forecast_arbitrage') {
    msg = `📈 ${platformTag}*FORECAST SHIFT DETECTED*\n\n`;
    msg += `📍 ${market.city.toUpperCase()} - ${market.dateStr}\n`;
    msg += `🎯 Forecast: ${forecast.highC}°C / ${forecast.highF}°F (${forecast.confidence})\n`;

    if (opportunity.forecastShift) {
      const shift = opportunity.forecastShift;
      msg += `🔄 Shift: ${shift.shiftF > 0 ? '+' : ''}${shift.shiftF}°F (${shift.direction})\n`;
      msg += `   Previous: ${shift.previousHighF}°F → Now: ${shift.currentHighF}°F\n`;
    }

    msg += `\n*Strategy:* Forecast Arbitrage\n`;
    msg += `*Market Analysis:*\n`;
    msg += `  Total probability: ${((opportunity.totalProbability || 0) * 100).toFixed(1)}%\n`;
    msg += `  Market mispricing: ${(opportunity.mispricingPct || 0).toFixed(1)}%\n`;
    msg += `  Trade edge: ${(opportunity.edgePct || 0).toFixed(1)}%\n\n`;
    msg += `*Position (Paper):*\n`;

    for (const pos of positions.positions) {
      msg += `  Buy ${pos.range}: $${pos.amount.toFixed(2)} @ ${(pos.price * 100).toFixed(0)}¢\n`;
    }

    msg += `\n💰 Cost: $${totalCost} | Max Payout: $${maxPayout}`;

  } else if (strategy === 'precipitation' || opportunity.market?.type === 'precipitation') {
    msg = `🌧️ ${platformTag}*PRECIPITATION OPPORTUNITY*\n\n`;
    msg += `📍 ${market.city.toUpperCase()} - ${market.month ? market.month.toUpperCase() : market.dateStr}`;
    if (market.year) msg += ` ${market.year}`;
    msg += `\n`;

    if (forecast && forecast.estimatedMonthlyInches !== undefined) {
      msg += `🎯 Forecast: ${forecast.estimatedMonthlyInches.toFixed(1)}" total precipitation`;
      if (forecast.confidence) msg += ` (${forecast.confidence})`;
      msg += `\n`;
    }

    msg += `\n*Strategy:* Precipitation Mispricing\n`;
    msg += `*Market Analysis:*\n`;
    msg += `  Total probability: ${((opportunity.totalProbability || 0) * 100).toFixed(1)}%\n`;
    msg += `  Market mispricing: ${(opportunity.mispricingPct || 0).toFixed(1)}%\n`;
    msg += `  Trade edge: ${(opportunity.edgePct || 0).toFixed(1)}%\n\n`;
    msg += `*Position (Paper):*\n`;

    for (const pos of positions.positions) {
      msg += `  Buy ${pos.range}: $${pos.amount.toFixed(2)} @ ${(pos.price * 100).toFixed(0)}¢\n`;
    }

    msg += `\n💰 Cost: $${totalCost} | Max Payout: $${maxPayout}`;

  } else {
    msg = `🌡️ ${platformTag}*WEATHER OPPORTUNITY*\n\n`;
    msg += `📍 ${market.city.toUpperCase()} - ${market.dateStr}\n`;
    msg += `🎯 Forecast: ${forecast.highC}°C / ${forecast.highF}°F (${forecast.confidence})\n`;
    msg += `\n*Strategy:* Range Mispricing\n`;
    msg += `*Market Analysis:*\n`;
    msg += `  Total probability: ${((opportunity.totalProbability || 0) * 100).toFixed(1)}%\n`;
    msg += `  Market mispricing: ${(opportunity.mispricingPct || 0).toFixed(1)}%\n`;
    msg += `  Trade edge: ${(opportunity.edgePct || 0).toFixed(1)}%\n\n`;
    msg += `*Position (Paper):*\n`;

    for (const pos of positions.positions) {
      msg += `  Buy ${pos.range}: $${pos.amount.toFixed(2)} @ ${(pos.price * 100).toFixed(0)}¢\n`;
    }

    msg += `\n💰 Cost: $${totalCost} | Max Payout: $${maxPayout}`;
  }

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
    this.marketScanner = new MarketScanner({
      log,
      // Kalshi integration
      kalshiEnabled: CONFIG.KALSHI_ENABLED,
      kalshiDemo: CONFIG.KALSHI_DEMO,
      kalshiApiKey: CONFIG.KALSHI_API_KEY,
      kalshiPrivateKeyPath: CONFIG.KALSHI_PRIVATE_KEY_PATH,
      preferredPlatform: CONFIG.PREFERRED_PLATFORM,
      enableArbitrage: CONFIG.ENABLE_CROSS_PLATFORM_ARB,
    });
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
      kalshiApi: this.marketScanner.getKalshiApi(),
      log,
    });

    this.isRunning = false;
    this.scanInterval = null;
    this.resolveInterval = null;
    this.lastScanTime = null;
    this.previousMarketCount = null; // For market drop alerts
    this.scanCount = 0; // For periodic discovery checks
    this.lastSnapshotTime = 0; // For hourly market snapshots
  }

  async initialize() {
    log('info', 'Initializing Weather Bot...', {
      paperMode: this.paperMode,
      kalshiEnabled: CONFIG.KALSHI_ENABLED,
      preferredPlatform: CONFIG.PREFERRED_PLATFORM,
    });

    // Test DB connection
    const { error } = await this.supabase.from('weather_paper_trades').select('count').limit(1);
    if (error && !error.message.includes('does not exist')) {
      log('warn', 'DB tables may not exist - run schema-weather.sql first');
    }

    // Log Kalshi status
    if (CONFIG.KALSHI_ENABLED) {
      const kalshiTradingReady = this.marketScanner.isKalshiTradingEnabled();
      log('info', 'Kalshi integration ENABLED', {
        demo: CONFIG.KALSHI_DEMO,
        tradingEnabled: kalshiTradingReady,
        preferredPlatform: CONFIG.PREFERRED_PLATFORM,
        arbEnabled: CONFIG.ENABLE_CROSS_PLATFORM_ARB,
      });
      if (kalshiTradingReady) {
        log('info', 'Kalshi trading credentials loaded - ready for paper trading');
      } else {
        log('warn', 'Kalshi trading credentials not configured - market scanning only');
      }
    } else {
      log('info', 'Kalshi integration disabled - set KALSHI_ENABLED=true to enable');
    }

    log('success', 'Weather Bot initialized');
  }

  async runScanCycle() {
    log('info', '=== Starting scan cycle ===');
    this.lastScanTime = new Date();

    // Reset API counter for this cycle
    this.weatherApi.resetStats();
    this.marketScanner.resetPlatformStats();

    try {
      // 1. Get active markets (temperature + precipitation)
      // Use multi-platform scanning if Kalshi is enabled
      let tempMarkets, precipMarkets, platformData;

      if (CONFIG.KALSHI_ENABLED) {
        // Multi-platform scan
        platformData = await this.marketScanner.getAllTemperatureMarkets();
        tempMarkets = platformData.all.map(m => m._raw || m); // Extract raw markets for compatibility
        precipMarkets = await this.marketScanner.getActivePrecipitationMarkets();

        // Log platform comparison
        log('info', `Multi-platform scan: ${platformData.polymarketOnly.length} PM-only, ${platformData.kalshiOnly.length} KL-only, ${platformData.overlap.length} overlap`);

        // Log price comparisons for overlap markets
        if (platformData.comparisons.length > 0) {
          for (const comp of platformData.comparisons.slice(0, 3)) { // Log first 3
            const rangeComps = comp.rangeComparisons.slice(0, 2);
            for (const rc of rangeComps) {
              log('info', `Price comparison: ${comp.city} ${comp.dateStr} ${rc.polyLabel}`, {
                polymarket: (rc.polyPrice * 100).toFixed(0) + '¢',
                kalshi: (rc.kalshiPrice * 100).toFixed(0) + '¢',
                diff: (rc.priceDiffPct).toFixed(1) + '%',
                best: rc.bestPlatform,
              });
            }
          }
        }
      } else {
        // Polymarket-only scan (original behavior)
        tempMarkets = await this.marketScanner.getActiveTemperatureMarkets();
        precipMarkets = await this.marketScanner.getActivePrecipitationMarkets();
      }

      const markets = tempMarkets; // Keep for backwards compatibility below

      log('info', `Found ${tempMarkets.length} temperature markets, ${precipMarkets.length} precipitation markets`);

      // Check for market count drop (possible slug format change)
      const totalMarkets = tempMarkets.length + precipMarkets.length;
      if (this.previousMarketCount !== null) {
        const dropPct = (this.previousMarketCount - totalMarkets) / this.previousMarketCount;
        if (dropPct > 0.5 && this.previousMarketCount > 5) {
          const alertMsg = `⚠️ *MARKET DROP ALERT*\n\n` +
            `Markets found: ${totalMarkets} (was ${this.previousMarketCount})\n` +
            `Drop: ${(dropPct * 100).toFixed(0)}%\n\n` +
            `Possible causes:\n` +
            `- Polymarket changed slug format\n` +
            `- Markets not created yet\n` +
            `- API issue\n\n` +
            `Bot will continue scanning but may not find opportunities.`;
          await sendTelegram(alertMsg);
          log('warn', 'Market count dropped significantly', {
            previous: this.previousMarketCount,
            current: totalMarkets,
            dropPct: (dropPct * 100).toFixed(0) + '%'
          });
        }
      }
      this.previousMarketCount = totalMarkets;

      // Save market snapshots hourly for analytics
      const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
      if (Date.now() - this.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
        await this.saveMarketSnapshots(tempMarkets);
        this.lastSnapshotTime = Date.now();
      }

      // 2. Filter for active cities and valid dates
      const today = new Date();
      const validMarkets = markets.filter(m => {
        const cityMatch = CONFIG.ACTIVE_CITIES.includes(m.city);
        const dateValid = m.date > today; // Future date only
        const notTooFar = (m.date - today) < 7 * 86400000; // Within 7 days
        const notClosed = !m.closed; // Exclude closed/resolved markets
        return cityMatch && dateValid && notTooFar && notClosed;
      });

      log('info', `${validMarkets.length} markets match city/date filters`);

      // Warn if all markets were filtered out
      if (validMarkets.length === 0 && totalMarkets > 0) {
        log('warn', 'All temperature markets filtered out - check date/closed filters');
      }

      // 3. Check each market for opportunities (BOTH strategies)
      const rangeMispricingOpps = [];
      const forecastArbitrageOpps = [];

      for (const market of validMarkets) {
        // Skip illiquid markets (>50% avg spread)
        if (!market.hasLiquidity) {
          log('info', `Skipping illiquid temperature market: ${market.slug}`, {
            avgSpread: (market.avgSpread * 100).toFixed(0) + '%',
          });
          continue;
        }

        // Get forecast from all available sources
        const forecast = await this.weatherApi.getMultiSourceForecast(market.city, market.dateStr);
        if (!forecast) continue;

        // Log multi-source data (first market per cycle only to reduce noise)
        if (forecast.sourceCount > 1) {
          log('info', 'Multi-source forecast', {
            city: forecast.city,
            date: forecast.date,
            sources: Object.keys(forecast.sources),
            spread: forecast.consensus?.spread + '°F',
            consensusConf: forecast.consensus?.confidence,
            finalConf: forecast.confidence,
          });
        }

        // Save forecast to history (for future shift detection)
        await this.weatherApi.saveForecastHistory(this.supabase, forecast);

        // Check for existing position
        const existingPosition = await this.trader.getExistingPosition(market.slug);

        if (existingPosition) {
          // === HEDGE CHECK: Does forecast shift threaten our position? ===
          const previousForecast = await this.weatherApi.getPreviousForecast(
            this.supabase,
            market.city,
            market.dateStr,
            CONFIG.FORECAST_COMPARE_HOURS
          );

          if (previousForecast) {
            const forecastShift = this.weatherApi.compareForecast(forecast, previousForecast, {
              minShiftF: CONFIG.FORECAST_SHIFT_MIN_F,
              minShiftC: CONFIG.FORECAST_SHIFT_MIN_C,
            });

            if (forecastShift) {
              const forecastTemp = market.unit === 'F' ? forecast.highF : forecast.highC;
              const isAgainst = this.detector.isShiftAgainstPosition(existingPosition, forecastTemp, market.unit);

              if (isAgainst) {
                // Check if we already hedged this position
                const alreadyHedged = await this.trader.hasExistingHedge(market.slug, existingPosition.range_name);
                if (alreadyHedged) {
                  log('info', 'Hedge already exists for this position - skipping', {
                    city: market.city,
                    position: existingPosition.range_name
                  });
                  continue; // Don't create another hedge
                }

                log('info', 'Forecast shifted AGAINST position - creating hedge', {
                  city: market.city,
                  date: market.dateStr,
                  held: existingPosition.range_name,
                  newForecast: forecastTemp,
                  shift: forecastShift.shiftF + '°F',
                });

                const hedgeOpp = this.detector.createHedgeOpportunity(market, forecast, forecastShift, existingPosition);
                if (hedgeOpp) {
                  forecastArbitrageOpps.push(hedgeOpp);
                }
              } else {
                log('info', 'Forecast shift detected but favors our position', {
                  city: market.city,
                  held: existingPosition.range_name,
                  shift: forecastShift.shiftF + '°F',
                });
              }
            }
          }
          continue; // Skip Range Mispricing for markets we already hold
        }

        // === No existing position - look for new opportunities ===

        // === STRATEGY 1: Range Mispricing ===
        const mispricingOpp = this.detector.analyzeMarket(market, forecast);
        if (mispricingOpp) {
          mispricingOpp.strategy = 'range_mispricing';
          rangeMispricingOpps.push(mispricingOpp);
        }

        // === STRATEGY 2: Forecast Arbitrage (new positions) ===
        const previousForecast = await this.weatherApi.getPreviousForecast(
          this.supabase,
          market.city,
          market.dateStr,
          CONFIG.FORECAST_COMPARE_HOURS
        );

        if (previousForecast) {
          const forecastShift = this.weatherApi.compareForecast(forecast, previousForecast, {
            minShiftF: CONFIG.FORECAST_SHIFT_MIN_F,
            minShiftC: CONFIG.FORECAST_SHIFT_MIN_C,
          });

          if (forecastShift) {
            log('info', 'Forecast shift detected (new position)', {
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

      // 4. Analyze precipitation markets (if enabled)
      const precipitationOpps = [];
      if (CONFIG.ENABLE_PRECIPITATION) {
        for (const market of precipMarkets) {
          // Skip closed/resolved markets
          if (market.closed) {
            log('info', `Skipping closed precipitation market: ${market.slug}`);
            continue;
          }

          // Skip illiquid markets (>50% avg spread)
          if (!market.hasLiquidity) {
            log('info', `Skipping illiquid precipitation market: ${market.slug}`, {
              avgSpread: (market.avgSpread * 100).toFixed(0) + '%',
            });
            continue;
          }

          // Skip if we already have a position
          const hasPosition = await this.trader.hasExistingPosition(market.slug);
          if (hasPosition) continue;

          // Get monthly precipitation forecast
          const forecast = await this.weatherApi.getMonthlyPrecipitationForecast(
            market.city,
            market.monthIdx,
            market.year
          );
          if (!forecast) {
            log('warn', `No precipitation forecast for ${market.city} ${market.month} - skipping`);
            continue;
          }

          // Analyze for mispricing
          const opportunity = this.detector.analyzePrecipitationMarket(market, forecast);
          if (opportunity) {
            precipitationOpps.push(opportunity);
          }
        }
      }

      // 5. Rank opportunities from all strategies
      const rankedMispricing = this.detector.rankOpportunities(rangeMispricingOpps);
      const rankedShifts = this.detector.rankForecastShiftOpportunities(forecastArbitrageOpps);
      const rankedPrecip = this.detector.rankPrecipitationOpportunities(precipitationOpps);

      log('info', `Strategy 1 (Range Mispricing): ${rankedMispricing.length} profitable opportunities`);
      log('info', `Strategy 2 (Forecast Arbitrage): ${rankedShifts.length} shift opportunities`);
      log('info', `Strategy 3 (Precipitation): ${rankedPrecip.length} precipitation opportunities`);

      // Log details of each opportunity for debugging
      for (const opp of rankedMispricing) {
        log('info', 'Opportunity details', {
          city: opp.market.city,
          date: opp.market.dateStr,
          platform: opp.market.platform || 'polymarket',
          range: opp.bestRange?.name || 'unknown',
          price: opp.bestRange?.price?.toFixed(2) || 'N/A',
          edgePct: (opp.edgePct || 0).toFixed(1) + '%',
          mispricingPct: (opp.mispricingPct || 0).toFixed(1) + '%',
          trueProbability: ((opp.trueProbability || 0) * 100).toFixed(1) + '%',
          minEdgeRequired: CONFIG.MIN_MISPRICING_PCT + '%'
        });
      }

      // 6. Combine and execute (prioritize hedges first, then shifts, then mispricing)
      // Separate hedges from new positions
      const hedgeOpps = rankedShifts.filter(o => o.isHedge);
      const newShiftOpps = rankedShifts.filter(o => !o.isHedge);
      const combinedOpportunities = [...newShiftOpps, ...rankedMispricing, ...rankedPrecip];

      // Deduplicate by city+date, keeping the opportunity with highest trade edge
      // This ensures we only trade one platform per city/date (the better deal)
      const bestByLocation = new Map();
      for (const opp of combinedOpportunities) {
        const dedupKey = `${opp.market.city}:${opp.market.dateStr}`;
        const existing = bestByLocation.get(dedupKey);
        const oppEdge = opp.edgePct || 0;

        if (!existing || oppEdge > (existing.edgePct || 0)) {
          if (existing) {
            log('info', 'Better platform found for city/date', {
              city: opp.market.city,
              date: opp.market.dateStr,
              selected: opp.market.platform || 'polymarket',
              selectedEdge: oppEdge.toFixed(1) + '%',
              skipped: existing.market.platform || 'polymarket',
              skippedEdge: (existing.edgePct || 0).toFixed(1) + '%'
            });
          }
          bestByLocation.set(dedupKey, opp);
        }
      }
      const allNewOpportunities = Array.from(bestByLocation.values());

      // Check capital limit (80% max deployed based on CURRENT bankroll including P&L)
      let currentDeployed = await this.trader.getDeployedCapital();
      const realizedPnl = await this.trader.getTotalRealizedPnl();
      const currentBankroll = CONFIG.PAPER_BANKROLL + realizedPnl;
      const maxDeployable = currentBankroll * CONFIG.MAX_DEPLOYED_PCT;

      log('info', 'Capital status', {
        deployed: currentDeployed.toFixed(2),
        maxDeployable: maxDeployable.toFixed(2),
        available: (maxDeployable - currentDeployed).toFixed(2),
        percentDeployed: ((currentDeployed / currentBankroll) * 100).toFixed(1) + '%',
        bankroll: currentBankroll.toFixed(2),
        realizedPnl: realizedPnl.toFixed(2),
      });

      let executed = 0;
      const executedMarkets = new Set();

      // Pre-populate with existing open positions to prevent cross-cycle duplicates
      try {
        const { data: existingPositions } = await this.supabase
          .from('weather_paper_trades')
          .select('city, target_date')
          .eq('status', 'open');

        if (existingPositions) {
          for (const pos of existingPositions) {
            executedMarkets.add(`${pos.city}:${pos.target_date}`);
          }
          log('info', `Pre-loaded ${existingPositions.length} existing positions for dedup`);
        }
      } catch (err) {
        log('warn', 'Failed to load existing positions for dedup', { error: err.message });
        // Non-critical — continue without pre-population, in-cycle dedup still works
      }

      // Execute hedges first (no capital limit - they protect existing positions)
      for (const opp of hedgeOpps) {
        // Use city+date for dedup to prevent cross-platform conflicts
        const hedgeDedupKey = `${opp.market.city}:${opp.market.dateStr}`;
        if (executedMarkets.has(hedgeDedupKey)) continue;

        const result = await this.executeOpportunity(opp);
        executedMarkets.add(hedgeDedupKey);
        if (result && result.cost) {
          currentDeployed += result.cost;
        }
        log('info', 'Hedge executed (bypasses capital limit)');
      }

      // Execute new positions (subject to capital limit)
      for (const opp of allNewOpportunities) {
        // Use city+date for dedup to prevent cross-platform and cross-cycle conflicts
        const dedupKey = `${opp.market.city}:${opp.market.dateStr}`;
        if (executedMarkets.has(dedupKey)) continue;

        // Check minimum edge requirement (trade-level edge, not market-level mispricing)
        const tradeEdge = opp.edgePct || 0;
        if (tradeEdge < CONFIG.MIN_MISPRICING_PCT) {
          log('info', 'Trade edge below minimum threshold - skipping', {
            city: opp.market.city,
            date: opp.market.dateStr,
            platform: opp.market.platform || 'polymarket',
            tradeEdge: tradeEdge.toFixed(1) + '%',
            minRequired: CONFIG.MIN_MISPRICING_PCT + '%'
          });

          // Log filtered opportunity to database for backtesting
          try {
            await this.logFilteredOpportunity(opp, {
              netEdgeDollars: null,
              grossEdgeDollars: null,
              feeCost: null,
              filterReason: 'edge_pct_below_minimum',
              threshold: CONFIG.MIN_MISPRICING_PCT
            });
          } catch (err) {
            log('warn', 'Failed to log filtered opportunity', { error: err.message });
          }

          continue;
        }

        // Check minimum dollar edge per share (after fees)
        const marketPrice = opp.marketProbability || opp.bestRange?.price || 0;
        const trueProbability = opp.trueProbability || 0;
        const platform = opp.market.platform || 'polymarket';
        const feeRate = platform === 'kalshi' ? 0.012 : 0.0315;
        const grossEdgeDollars = trueProbability - marketPrice;
        const feeCost = marketPrice * feeRate;
        const netEdgeDollars = grossEdgeDollars - feeCost;

        if (netEdgeDollars < CONFIG.MIN_EDGE_DOLLARS) {
          log('info', 'Edge below minimum after fees - skipping', {
            city: opp.market.city,
            date: opp.market.dateStr,
            platform: platform,
            marketPrice: (marketPrice * 100).toFixed(0) + '¢',
            grossEdge: '$' + grossEdgeDollars.toFixed(3),
            feeCost: '$' + feeCost.toFixed(3),
            netEdge: '$' + netEdgeDollars.toFixed(3),
            threshold: '$' + CONFIG.MIN_EDGE_DOLLARS.toFixed(2),
          });

          // Log filtered opportunity to database for backtesting
          try {
            await this.logFilteredOpportunity(opp, {
              netEdgeDollars,
              grossEdgeDollars,
              feeCost,
              filterReason: 'net_edge_below_threshold',
              threshold: CONFIG.MIN_EDGE_DOLLARS
            });
          } catch (err) {
            log('warn', 'Failed to log filtered opportunity', { error: err.message });
          }

          continue;
        }

        // "Death Zone" filter: block 25-50¢ trades within 1 day of resolution
        const entryPrice = opp.bestRange?.price || opp.marketProbability || 0;
        const targetDate = new Date(opp.market.dateStr + 'T00:00:00Z');
        const now = new Date();
        const daysBeforeResolution = Math.ceil((targetDate - now) / (1000 * 60 * 60 * 24));

        if (daysBeforeResolution < 2 && entryPrice >= 0.25 && entryPrice < 0.50) {
          log('info', 'Death zone filter - skipping (25-50¢ within 1 day of resolution)', {
            city: opp.market.city,
            date: opp.market.dateStr,
            platform: platform,
            entryPrice: (entryPrice * 100).toFixed(0) + '¢',
            daysBeforeResolution,
          });

          try {
            await this.logFilteredOpportunity(opp, {
              netEdgeDollars,
              grossEdgeDollars,
              feeCost,
              filterReason: 'death_zone_price_timing',
              entryPrice,
              daysBeforeResolution,
              threshold: null,
            });
          } catch (err) {
            log('warn', 'Failed to log filtered opportunity', { error: err.message });
          }

          continue;
        }

        // Calculate position size for this opportunity (use current bankroll including P&L)
        const positions = this.detector.generatePositions(opp, currentBankroll, {
          maxPositionPct: CONFIG.MAX_POSITION_PCT,
        });

        if (positions.positions.length === 0) {
          log('info', 'No positions generated by Kelly sizing - skipping', {
            city: opp.market.city,
            date: opp.market.dateStr,
            strategy: opp.strategy,
            edgePct: opp.edgePct?.toFixed(2),
            trueProbability: opp.trueProbability?.toFixed(4),
            marketPrice: opp.marketPrice?.toFixed(4),
            kellyReason: positions.kelly?.reason || 'Kelly bet <= 0',
            kellyBet: positions.kelly?.kellyBet?.toFixed(2),
            fullKelly: positions.kelly?.fullKelly?.toFixed(4),
            recommendedBet: positions.kelly?.recommendedBet?.toFixed(2)
          });
          continue;
        }

        const tradeCost = positions.totalCost;

        // Check if this trade fits within capital limit
        if (currentDeployed + tradeCost > maxDeployable) {
          log('info', 'Trade would exceed capital limit - skipping', {
            city: opp.market.city,
            tradeCost: tradeCost.toFixed(2),
            currentDeployed: currentDeployed.toFixed(2),
            maxDeployable: maxDeployable.toFixed(2)
          });
          continue;
        }

        // Execute the trade
        const result = await this.executeOpportunity(opp);
        executedMarkets.add(dedupKey);
        if (result && result.cost) {
          currentDeployed += result.cost;
        } else {
          // Fallback: use calculated cost if result doesn't have it
          currentDeployed += tradeCost;
        }
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

      // Periodic slug discovery check (every 12 cycles = ~1 hour at 5-min intervals)
      this.scanCount++;
      if (this.scanCount % 12 === 0) {
        const discovery = await this.marketScanner.discoverWeatherMarkets();
        if (discovery && discovery.unknown > 0) {
          const alertMsg = `🔍 *SLUG DISCOVERY ALERT*\n\n` +
            `Found ${discovery.unknown} weather markets with unexpected slug patterns.\n` +
            `Check logs for details - slug format may have changed.`;
          await sendTelegram(alertMsg);
          log('warn', 'Slug discovery found unknown patterns', discovery);
        }
      }

    } catch (err) {
      log('error', 'Scan cycle failed', { error: err.message });
    }
  }

  /**
   * Log a filtered opportunity to database for backtesting
   */
  async logFilteredOpportunity(opp, filterInfo) {
    if (!this.supabase) return;

    const marketPrice = opp.marketProbability || opp.bestRange?.price || 0;
    const edgePct = opp.edgePct || 0;

    try {
      await this.supabase.from('weather_opportunities').upsert({
        market_slug: opp.market.slug || opp.market.marketSlug,
        market_question: opp.market.question || `${opp.market.city} ${opp.market.dateStr}`,
        city: opp.market.city,
        target_date: opp.market.dateStr,
        platform: opp.market.platform || 'polymarket',
        platform_market_id: opp.market.conditionId || opp.market.marketId || null,
        forecast_high_c: opp.forecast?.highC,
        forecast_high_f: opp.forecast?.highF,
        forecast_confidence: opp.confidence,
        forecast_source: opp.forecast?.primarySource || 'open-meteo',
        ranges: opp.market.ranges || [],
        total_probability: opp.totalProbability,
        mispricing_pct: opp.mispricingPct,
        recommended_range: opp.bestRange?.name,
        recommended_price: marketPrice,
        expected_value: opp.expectedValue?.ev,
        fee_adjusted_ev: opp.expectedValue?.evPct,
        // Filter tracking fields
        edge_at_entry: edgePct,
        net_edge_dollars: filterInfo.netEdgeDollars,
        filter_reason: filterInfo.filterReason,
        status: 'filtered',
        // Death zone fields (conditionally included)
        ...(filterInfo.entryPrice != null && { entry_price: filterInfo.entryPrice }),
        ...(filterInfo.daysBeforeResolution != null && { days_before_resolution: filterInfo.daysBeforeResolution }),
      }, {
        onConflict: 'market_slug,target_date',
        ignoreDuplicates: false
      });
    } catch (err) {
      log('warn', 'Failed to save filtered opportunity', { error: err.message });
    }
  }

  async executeOpportunity(opportunity) {
    // Safety net: double-check hedge doesn't already exist before executing
    if (opportunity.isHedge) {
      const alreadyHedged = await this.trader.hasExistingHedge(
        opportunity.market.slug,
        opportunity.hedgingPosition
      );
      if (alreadyHedged) {
        log('info', 'Hedge already exists - skipping execution', {
          city: opportunity.market.city,
          hedgingPosition: opportunity.hedgingPosition
        });
        return;
      }
    }

    // Generate position sizes
    const capital = this.trader.paperBalance;
    let positions;

    if (opportunity.isHedge) {
      // Use hedge sizing (50% of original position)
      const hedgeSize = this.detector.calculateHedgeSize(
        { cost: opportunity.hedgingPositionCost },
        capital,
        0.5 // 50% hedge ratio
      );

      // Create position manually with hedge size
      const range = opportunity.bestRange;
      const shares = hedgeSize / range.price;

      positions = {
        positions: [{
          range: range.name,
          tokenId: range.tokenId,
          side: 'BUY',
          price: range.price,
          amount: hedgeSize,
          shares: Math.floor(shares * 100) / 100,
          potentialPayout: Math.floor(shares),
          isHedge: true,
        }],
        totalCost: hedgeSize,
        maxPayout: Math.floor(shares),
        marketSlug: opportunity.market.slug,
      };
    } else {
      // Normal Kelly sizing
      positions = this.detector.generatePositions(opportunity, capital, {
        maxPositionPct: CONFIG.MAX_POSITION_PCT,
        maxPerRange: CONFIG.MAX_PER_RANGE_PCT,
        hedgeRanges: CONFIG.HEDGE_RANGES,
      });
    }

    if (positions.positions.length === 0) {
      log('warn', 'No valid positions generated', { market: opportunity.market.slug });
      return;
    }

    const tradeType = opportunity.isHedge ? 'hedge' : 'trade';
    log(tradeType, `Executing ${opportunity.isHedge ? 'HEDGE' : 'opportunity'}`, {
      city: opportunity.market.city,
      date: opportunity.market.dateStr,
      strategy: opportunity.strategy,
      edge: (opportunity.mispricingPct || 0).toFixed(1) + '%',
      cost: positions.totalCost.toFixed(2),
      hedging: opportunity.hedgingPosition || null,
    });

    // Execute trades
    const results = await this.trader.executeTrades(opportunity, positions);

    // Send Telegram alert
    if (CONFIG.TELEGRAM_ON_TRADE) {
      const alert = formatTradeAlert(opportunity, positions);
      await sendTelegram(alert);
    }

    // Return cost for capital tracking
    return { cost: positions.totalCost };
  }

  /**
   * Save market snapshots for analytics (hourly)
   */
  async saveMarketSnapshots(markets) {
    try {
      const snapshots = markets.map(m => ({
        city: m.city,
        target_date: m.dateStr,
        platform: m.platform || 'polymarket',
        market_slug: m.slug,
        total_probability: m.totalProbability,
        ranges: JSON.stringify(m.ranges.map(r => ({
          name: r.name,
          price: r.price,
          bid: r.bestBid || null,
          ask: r.bestAsk || null,
          spread: r.spread || null,
          volume: r.volume || null,
        }))),
        snapshot_at: new Date().toISOString(),
      }));

      // Batch insert
      const { error } = await this.supabase
        .from('market_snapshots')
        .insert(snapshots);

      if (error) {
        log('warn', 'Failed to save market snapshots', { error: error.message });
      } else {
        log('info', `Saved ${snapshots.length} market snapshots`);
      }
    } catch (err) {
      log('warn', 'Market snapshot error', { error: err.message });
      // Non-critical - don't break the scan cycle
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

  // Capital deployment (use current bankroll including realized P&L)
  const deployedCapital = open.reduce((sum, t) => sum + parseFloat(t.cost || 0), 0);
  const currentBankroll = CONFIG.PAPER_BANKROLL + totalPnL;
  const maxDeployable = currentBankroll * CONFIG.MAX_DEPLOYED_PCT;
  const capitalAvailable = maxDeployable - deployedCapital;

  console.log('\n💰 Capital Deployment:');
  console.log(`   Initial Bankroll: $${CONFIG.PAPER_BANKROLL}`);
  console.log(`   Realized P&L: $${totalPnL.toFixed(2)}`);
  console.log(`   Current Bankroll: $${currentBankroll.toFixed(2)}`);
  console.log(`   Deployed: $${deployedCapital.toFixed(2)} / $${maxDeployable.toFixed(2)} (${((deployedCapital / currentBankroll) * 100).toFixed(1)}%)`);
  console.log(`   Available: $${capitalAvailable.toFixed(2)}`);
  console.log(`   Open Positions: ${open.length}`);

  // Risk settings
  console.log('\n⚙️  Risk Settings:');
  console.log(`   Max Deployed: ${(CONFIG.MAX_DEPLOYED_PCT * 100).toFixed(0)}% of bankroll`);
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

    const forecast = await weatherApi.getMultiSourceForecast(market.city, market.dateStr);
    if (!forecast) continue;

    // Save forecast to history
    await weatherApi.saveForecastHistory(supabase, forecast);

    // === STRATEGY 1: Range Mispricing ===
    const opp = detector.analyzeMarket(market, forecast);
    if (opp) {
      mispricingCount++;
      // Calculate Kelly size for display (with fee adjustment)
      const platform = market.platform || 'polymarket';
      const fee = platform === 'kalshi' ? 0.012 : 0.0315;
      const kelly = detector.calculateKellySize(
        opp.marketProbability,
        opp.trueProbability,
        CONFIG.PAPER_BANKROLL,
        fee
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

  if (!CONFIG.ENABLE_PRECIPITATION) {
    console.log('\nPrecipitation trading DISABLED (capital efficiency - locks funds for full month)');
  } else {
    const precipMarkets = await scanner.getActivePrecipitationMarkets();
    console.log(`Found ${precipMarkets.length} precipitation markets\n`);

    let precipCount = 0;

    for (const market of precipMarkets) {
      // Check liquidity first
      if (!market.hasLiquidity) {
        console.log(`\n🌧️ ${market.city.toUpperCase()} - ${market.month.toUpperCase()}: ⚠️ ILLIQUID (${(market.avgSpread * 100).toFixed(0)}% avg spread) - skipping`);
        console.log(`   Total Prob: ${(market.totalProbability * 100).toFixed(0)}% (unreliable due to no liquidity)`);
        continue;
      }

      const forecast = await weatherApi.getMonthlyPrecipitationForecast(
        market.city,
        market.monthIdx,
        market.year
      );
      if (!forecast) {
        console.log(`\n🌧️ ${market.city.toUpperCase()} - ${market.month.toUpperCase()}: ⚠️ No forecast data available - skipping`);
        continue;
      }

      const opp = detector.analyzePrecipitationMarket(market, forecast);
      if (opp) {
        precipCount++;
        // Calculate Kelly size for display (with fee adjustment)
        const platform = market.platform || 'polymarket';
        const fee = platform === 'kalshi' ? 0.012 : 0.0315;
        const kelly = detector.calculateKellySize(
          opp.marketProbability,
          opp.trueProbability,
          CONFIG.PAPER_BANKROLL,
          fee
        );

        console.log(`\n🌧️ PRECIPITATION: ${market.city.toUpperCase()} - ${market.month.toUpperCase()} ${market.year}`);
        console.log(`   Forecast: ${forecast.estimatedMonthlyInches}" (${forecast.forecastDays}/${forecast.daysInMonth} days covered)`);
        console.log(`   Confidence: ${forecast.confidence} (${Math.round(forecast.coverageRatio * 100)}% coverage)`);
        console.log(`   Liquidity: OK (${(market.avgSpread * 100).toFixed(0)}% avg spread)`);
        console.log(`   Total Prob: ${(market.totalProbability * 100).toFixed(1)}%`);
        console.log(`   Best Range: ${opp.bestRange.name} @ ${(opp.bestRange.price * 100).toFixed(0)}¢`);
        console.log(`   Market Prob: ${(opp.marketProbability * 100).toFixed(1)}% → Our Prob: ${(opp.trueProbability * 100).toFixed(1)}%`);
        console.log(`   Edge: ${opp.edgePct.toFixed(1)}% | EV: ${(opp.expectedValue.evPct).toFixed(1)}%/dollar`);
        console.log(`   Kelly Size: $${kelly.recommendedBet.toFixed(2)} (${kelly.percentOfBankroll.toFixed(1)}% of bankroll)`);
      } else {
        // Show market even if no opportunity
        console.log(`\n🌧️ ${market.city.toUpperCase()} - ${market.month.toUpperCase()}: No opportunity (forecast: ${forecast?.estimatedMonthlyInches || '?'}")`);
        console.log(`   Liquidity: OK (${(market.avgSpread * 100).toFixed(0)}% avg spread) | Total Prob: ${(market.totalProbability * 100).toFixed(1)}%`);
      }
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
