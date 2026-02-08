/**
 * Position Manager (Bot B)
 *
 * Monitors open positions from Weather Bot (Bot A), takes profit at tiered
 * thresholds, exits on forecast shifts, and re-enters when edge returns.
 *
 * Runs alongside Bot A - does not create initial entries (except re-entries).
 * When Bot B exits a position, it marks managed_by = 'position_manager'
 * so performance can be compared between managed and unmanaged positions.
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

class PositionManager {
  constructor(config = {}) {
    this.supabase = config.supabase;
    this.weatherApi = config.weatherApi;
    this.log = config.log || console.log;
    this.sendTelegram = config.sendTelegram || (() => {});
    this.config = config.settings || {};

    // Defaults (overridable via config.settings)
    this.takeProfit = this.config.TAKE_PROFIT || {
      LONGSHOT: { maxEntry: 0.25, exitAt: 0.75 },
      MIDRANGE: { maxEntry: 0.40, exitAt: 0.55 },
      FAVORITE: { maxEntry: 1.00, exitAt: 0.85 },
    };
    this.stopLossEnabled = this.config.STOP_LOSS_ENABLED ?? false;
    this.forecastExitEnabled = this.config.FORECAST_EXIT_ENABLED ?? true;
    this.forecastExitMinDays = this.config.FORECAST_EXIT_MIN_DAYS ?? 1;
    this.reentryEnabled = this.config.REENTRY_ENABLED ?? true;
    this.reentryMinEdgePct = this.config.REENTRY_MIN_EDGE_PCT ?? 0.03;
    this.reentryMinEdgeDollars = this.config.REENTRY_MIN_EDGE_DOLLARS ?? 0.01;
    this.polymarketFee = this.config.POLYMARKET_FEE ?? 0.0315;
    this.paperBankroll = this.config.PAPER_BANKROLL ?? 1000;
    this.telegramOnExit = this.config.TELEGRAM_ON_EXIT ?? true;
    this.telegramOnReentry = this.config.TELEGRAM_ON_REENTRY ?? true;
  }

  /**
   * Main cycle - check all open positions for exit conditions
   */
  async run() {
    this.log('info', '=== Position Manager scan cycle ===');

    try {
      const openPositions = await this.getOpenPositions();
      this.log('info', `Monitoring ${openPositions.length} open positions`);

      let exits = 0;
      let monitored = 0;

      for (const position of openPositions) {
        try {
          // Get current market price for this position's range
          const currentPrice = await this.getCurrentPrice(position);
          if (!currentPrice) {
            this.log('warn', 'Could not fetch current price - skipping', {
              city: position.city,
              date: position.target_date,
              slug: position.market_slug,
            });
            continue;
          }

          // Update max/min price tracking
          await this.updatePriceTracking(position, currentPrice);

          // Determine entry tier and exit threshold
          const entryTier = this.getEntryTier(parseFloat(position.entry_price));
          const exitThreshold = this.takeProfit[entryTier].exitAt;

          // Check TAKE PROFIT condition
          if (currentPrice.bid >= exitThreshold) {
            await this.executeTakeProfit(position, currentPrice, entryTier, exitThreshold);
            exits++;
            continue;
          }

          // Check FORECAST SHIFT condition
          if (this.forecastExitEnabled) {
            const daysToResolution = this.getDaysToResolution(position.target_date);
            if (daysToResolution >= this.forecastExitMinDays) {
              const forecast = await this.getCurrentForecast(position.city, position.target_date);
              if (forecast) {
                const forecastInRange = this.isForecastInRange(forecast, position.range_name);

                if (!forecastInRange) {
                  await this.executeForecastExit(position, currentPrice, forecast);
                  exits++;
                  continue;
                }
              }
            }
          }

          // Log monitoring action
          await this.logAction(position, 'monitor', currentPrice, {
            entryTier,
            exitThreshold,
            reason: `Monitoring - bid ${(currentPrice.bid * 100).toFixed(0)}¢ < target ${(exitThreshold * 100).toFixed(0)}¢`,
          });
          monitored++;

        } catch (err) {
          this.log('error', 'Error processing position', {
            city: position.city,
            date: position.target_date,
            error: err.message,
          });
        }
      }

      // Check for re-entry opportunities
      if (this.reentryEnabled) {
        await this.checkReentryOpportunities();
      }

      this.log('info', 'Position Manager cycle complete', {
        positions: openPositions.length,
        exits,
        monitored,
      });

    } catch (err) {
      this.log('error', 'Position Manager cycle failed', { error: err.message });
    }
  }

  /**
   * Get all open positions that Bot B should monitor
   * Excludes positions already exited by Bot B
   */
  async getOpenPositions() {
    const { data, error } = await this.supabase
      .from('weather_paper_trades')
      .select('*')
      .eq('status', 'open')
      .eq('platform', 'polymarket');  // Only Polymarket (Kalshi disabled)

    if (error) {
      this.log('error', 'Failed to fetch open positions', { error: error.message });
      return [];
    }

    return data || [];
  }

  /**
   * Fetch current market price for a position's range from Polymarket Gamma API
   */
  async getCurrentPrice(position) {
    try {
      const slug = position.market_slug;
      if (!slug) return null;

      const resp = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`);
      if (!resp.ok) return null;

      const events = await resp.json();
      if (!events || events.length === 0) return null;

      const event = events[0];
      if (!event.markets || event.markets.length === 0) return null;

      // Find the matching range by name
      const rangeName = position.range_name;
      const matchingMarket = event.markets.find(m => {
        const title = m.groupItemTitle || m.question || '';
        return title === rangeName;
      });

      if (!matchingMarket) {
        // Try fuzzy match - strip whitespace and compare
        const normalizedRange = rangeName.replace(/\s+/g, '').toLowerCase();
        const fuzzyMatch = event.markets.find(m => {
          const title = (m.groupItemTitle || m.question || '').replace(/\s+/g, '').toLowerCase();
          return title === normalizedRange;
        });
        if (!fuzzyMatch) return null;
        return this._extractPriceFromMarket(fuzzyMatch);
      }

      return this._extractPriceFromMarket(matchingMarket);

    } catch (err) {
      this.log('warn', 'getCurrentPrice failed', {
        slug: position.market_slug,
        error: err.message,
      });
      return null;
    }
  }

  /**
   * Extract price/bid/ask from a Gamma API market object
   */
  _extractPriceFromMarket(market) {
    const bestBid = parseFloat(market.bestBid) || 0;
    const bestAsk = parseFloat(market.bestAsk) || 1;

    let price = bestBid;
    if (price === 0 && market.outcomePrices) {
      try {
        const prices = JSON.parse(market.outcomePrices);
        price = parseFloat(prices[0]) || 0;
      } catch {}
    }

    return {
      price,
      bid: bestBid,
      ask: bestAsk,
    };
  }

  /**
   * Update max/min price tracking for a position
   */
  async updatePriceTracking(position, currentPrice) {
    const updates = {};

    if (!position.max_price_seen || currentPrice.price > parseFloat(position.max_price_seen)) {
      updates.max_price_seen = currentPrice.price;
    }
    if (!position.min_price_seen || currentPrice.price < parseFloat(position.min_price_seen)) {
      updates.min_price_seen = currentPrice.price;
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await this.supabase
        .from('weather_paper_trades')
        .update(updates)
        .eq('id', position.id);

      if (error) {
        this.log('warn', 'Failed to update price tracking', { error: error.message });
      }
    }
  }

  /**
   * Classify entry price into tier
   */
  getEntryTier(entryPrice) {
    const price = parseFloat(entryPrice);
    if (price < this.takeProfit.LONGSHOT.maxEntry) return 'LONGSHOT';
    if (price < this.takeProfit.MIDRANGE.maxEntry) return 'MIDRANGE';
    return 'FAVORITE';
  }

  /**
   * Execute take profit exit
   */
  async executeTakeProfit(position, currentPrice, entryTier, exitThreshold) {
    const exitPrice = currentPrice.bid;
    const shares = parseFloat(position.shares);
    const entryPrice = parseFloat(position.entry_price);
    const grossProfit = (exitPrice - entryPrice) * shares;
    const fee = exitPrice * shares * this.polymarketFee;
    const netPnl = grossProfit - fee;

    // Update the trade record
    const { error } = await this.supabase
      .from('weather_paper_trades')
      .update({
        managed_by: 'position_manager',
        status: 'exited',
        exit_reason: 'take_profit',
        exit_price: exitPrice,
        exit_time: new Date().toISOString(),
        exit_pnl: netPnl,
        pnl: netPnl,
      })
      .eq('id', position.id);

    if (error) {
      this.log('error', 'Failed to update trade for take profit', { error: error.message });
      return;
    }

    this.log('success', 'TAKE PROFIT executed', {
      city: position.city,
      date: position.target_date,
      range: position.range_name,
      entryPrice: (entryPrice * 100).toFixed(0) + '¢',
      exitPrice: (exitPrice * 100).toFixed(0) + '¢',
      netPnl: '$' + netPnl.toFixed(2),
      tier: entryTier,
    });

    // Log the action
    await this.logAction(position, 'exit_take_profit', currentPrice, {
      entryTier,
      exitThreshold,
      netPnl,
      reason: `Price ${(exitPrice * 100).toFixed(0)}¢ hit ${entryTier} target ${(exitThreshold * 100).toFixed(0)}¢`,
    });

    // Send Telegram alert
    if (this.telegramOnExit) {
      const gainPct = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(0);
      await this.sendTelegram(
        `🎯 *TAKE PROFIT*: ${position.city} ${position.range_name}\n` +
        `Entry: ${(entryPrice * 100).toFixed(0)}¢ → Exit: ${(exitPrice * 100).toFixed(0)}¢\n` +
        `P&L: $${netPnl.toFixed(2)} (${gainPct}% gain)\n` +
        `Tier: ${entryTier} (threshold: ${(exitThreshold * 100).toFixed(0)}¢)`
      );
    }
  }

  /**
   * Get current forecast for a city/date
   */
  async getCurrentForecast(city, targetDate) {
    try {
      const forecast = await this.weatherApi.getMultiSourceForecast(city, targetDate);
      if (!forecast) return null;
      return {
        temp_f: forecast.highF,
        temp_c: forecast.highC,
        confidence: forecast.confidence,
      };
    } catch (err) {
      this.log('warn', 'Failed to get forecast', { city, date: targetDate, error: err.message });
      return null;
    }
  }

  /**
   * Execute forecast shift exit
   */
  async executeForecastExit(position, currentPrice, forecast) {
    const exitPrice = currentPrice.bid;
    const shares = parseFloat(position.shares);
    const entryPrice = parseFloat(position.entry_price);
    const grossProfit = (exitPrice - entryPrice) * shares;
    const fee = exitPrice * shares * this.polymarketFee;
    const netPnl = grossProfit - fee;

    const { error } = await this.supabase
      .from('weather_paper_trades')
      .update({
        managed_by: 'position_manager',
        status: 'exited',
        exit_reason: 'forecast_shift',
        exit_price: exitPrice,
        exit_time: new Date().toISOString(),
        exit_pnl: netPnl,
        pnl: netPnl,
      })
      .eq('id', position.id);

    if (error) {
      this.log('error', 'Failed to update trade for forecast exit', { error: error.message });
      return;
    }

    this.log('warn', 'FORECAST EXIT executed', {
      city: position.city,
      date: position.target_date,
      range: position.range_name,
      forecastTemp: forecast.temp_f + '°F',
      exitPrice: (exitPrice * 100).toFixed(0) + '¢',
      netPnl: '$' + netPnl.toFixed(2),
    });

    await this.logAction(position, 'exit_forecast_shift', currentPrice, {
      forecast: forecast.temp_f,
      reason: `Forecast ${forecast.temp_f}°F no longer in range ${position.range_name}`,
    });

    if (this.telegramOnExit) {
      await this.sendTelegram(
        `⚠️ *FORECAST EXIT*: ${position.city} ${position.range_name}\n` +
        `Forecast shifted to ${forecast.temp_f}°F (outside range)\n` +
        `Entry: ${(entryPrice * 100).toFixed(0)}¢ → Exit: ${(exitPrice * 100).toFixed(0)}¢\n` +
        `P&L: $${netPnl.toFixed(2)}`
      );
    }
  }

  /**
   * Check if forecast temperature falls within a range string
   * Handles: "X-Y°F", "X°F or higher", "X°F or below", "X°C"
   */
  isForecastInRange(forecast, rangeName) {
    const cleaned = rangeName.replace(/Â/g, '');
    let tempF = forecast.temp_f;

    // For Celsius ranges, convert forecast to C
    if (cleaned.includes('°C')) {
      const tempC = (tempF - 32) * 5 / 9;

      // "X°C or higher"
      if (/higher|above/i.test(cleaned)) {
        const threshold = parseFloat(cleaned.match(/-?[\d.]+/)?.[0]);
        return !isNaN(threshold) && tempC >= threshold;
      }
      // "X°C or below"
      if (/below/i.test(cleaned)) {
        const threshold = parseFloat(cleaned.match(/-?[\d.]+/)?.[0]);
        return !isNaN(threshold) && tempC <= threshold;
      }
      // "X-Y°C" range
      const rangeMatch = cleaned.match(/(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)/);
      if (rangeMatch) {
        const low = parseFloat(rangeMatch[1]);
        const high = parseFloat(rangeMatch[2]);
        return tempC >= low && tempC <= high;
      }
      // Single "X°C"
      const single = cleaned.match(/(-?[\d.]+)\s*°C/);
      if (single) {
        const n = parseFloat(single[1]);
        return Math.abs(tempC - n) < 0.5;
      }
      return false;
    }

    // Fahrenheit ranges
    // "X°F or higher"
    if (/higher|above/i.test(cleaned)) {
      const threshold = parseFloat(cleaned.match(/-?[\d.]+/)?.[0]);
      return !isNaN(threshold) && tempF >= threshold;
    }
    // "X°F or below"
    if (/below/i.test(cleaned)) {
      const threshold = parseFloat(cleaned.match(/-?[\d.]+/)?.[0]);
      return !isNaN(threshold) && tempF <= threshold;
    }
    // "X-Y°F" range
    const rangeMatch = cleaned.match(/(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)/);
    if (rangeMatch) {
      const low = parseFloat(rangeMatch[1]);
      const high = parseFloat(rangeMatch[2]);
      return tempF >= low && tempF <= high;
    }
    // Single "X°F"
    const single = cleaned.match(/(-?[\d.]+)\s*°/);
    if (single) {
      const n = parseFloat(single[1]);
      return Math.abs(tempF - n) < 0.5;
    }

    return false;
  }

  /**
   * Check for re-entry opportunities on recently exited positions
   */
  async checkReentryOpportunities() {
    // Get recently exited positions (last 24 hours) that haven't resolved yet
    const { data: exitedPositions, error } = await this.supabase
      .from('weather_paper_trades')
      .select('*')
      .eq('managed_by', 'position_manager')
      .eq('status', 'exited')
      .gte('exit_time', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .gte('target_date', new Date().toISOString().split('T')[0]);

    if (error || !exitedPositions || exitedPositions.length === 0) return;

    this.log('info', `Checking ${exitedPositions.length} exited positions for re-entry`);

    for (const position of exitedPositions) {
      try {
        // Check if we already have an open re-entry for this
        const { data: existing } = await this.supabase
          .from('reentry_trades')
          .select('id')
          .eq('original_trade_id', position.id)
          .eq('status', 'open')
          .limit(1);

        if (existing && existing.length > 0) continue;

        // Get current market data
        const currentPrice = await this.getCurrentPrice(position);
        if (!currentPrice) continue;

        // Get current forecast
        const forecast = await this.getCurrentForecast(position.city, position.target_date);
        if (!forecast || !this.isForecastInRange(forecast, position.range_name)) {
          await this.logAction(position, 'skip_reentry', currentPrice, {
            reason: forecast
              ? `Forecast ${forecast.temp_f}°F not in range ${position.range_name}`
              : 'No forecast available',
          });
          continue;
        }

        // Calculate edge using confidence-based probability
        const trueProbability = this.calculateTrueProbability(forecast.confidence);
        const edge = trueProbability - currentPrice.ask;

        // Check minimum edge thresholds (tiered)
        const minEdgeDollars = currentPrice.ask < 0.25 ? 0.01 : 0.03;
        const netEdgeDollars = edge - (currentPrice.ask * this.polymarketFee);

        if (edge < this.reentryMinEdgePct || netEdgeDollars < minEdgeDollars) {
          await this.logAction(position, 'skip_reentry', currentPrice, {
            reason: `Edge ${(edge * 100).toFixed(1)}% / $${netEdgeDollars.toFixed(3)} below threshold`,
          });
          continue;
        }

        // Execute re-entry
        await this.executeReentry(position, currentPrice, forecast, edge);

      } catch (err) {
        this.log('error', 'Re-entry check failed', {
          city: position.city,
          error: err.message,
        });
      }
    }
  }

  /**
   * Estimate true probability based on forecast confidence
   * Used for re-entry edge calculation
   */
  calculateTrueProbability(confidence) {
    const probabilities = {
      'very-high': 0.65,
      'high': 0.55,
      'medium': 0.45,
      'low': 0.35,
    };
    return probabilities[confidence] || 0.40;
  }

  /**
   * Execute a re-entry trade
   */
  async executeReentry(originalPosition, currentPrice, forecast, edge) {
    const entryPrice = currentPrice.ask;
    const bankroll = await this.getBankroll();

    // Simple Kelly sizing for re-entry
    const kellyFraction = 0.5;
    const maxPositionPct = 0.20;
    const trueProbability = this.calculateTrueProbability(forecast.confidence);

    // Kelly formula: f = (p*b - q) / b where b = (1-fee-price)/price
    const effectivePayout = 1 - this.polymarketFee;
    const b = (effectivePayout - entryPrice) / entryPrice;
    const p = trueProbability;
    const q = 1 - p;
    let fullKelly = b > 0 ? (p * b - q) / b : 0;
    fullKelly = Math.max(0, fullKelly);

    const positionSize = Math.min(
      bankroll * maxPositionPct,
      bankroll * fullKelly * kellyFraction
    );

    if (positionSize < 10) {
      this.log('info', 'Re-entry position too small', {
        city: originalPosition.city,
        positionSize: positionSize.toFixed(2),
      });
      return;
    }

    const shares = positionSize / entryPrice;

    // Record re-entry
    const { data: reentry, error } = await this.supabase
      .from('reentry_trades')
      .insert({
        original_trade_id: originalPosition.id,
        city: originalPosition.city,
        target_date: originalPosition.target_date,
        platform: originalPosition.platform || 'polymarket',
        range_name: originalPosition.range_name,
        entry_price: entryPrice,
        cost: positionSize,
        shares: shares,
        edge_at_entry: edge * 100,
        forecast_temp_f: forecast.temp_f,
        status: 'open',
      })
      .select()
      .single();

    if (error) {
      this.log('error', 'Failed to insert re-entry trade', { error: error.message });
      return;
    }

    this.log('success', 'RE-ENTRY executed', {
      city: originalPosition.city,
      date: originalPosition.target_date,
      range: originalPosition.range_name,
      entryPrice: (entryPrice * 100).toFixed(0) + '¢',
      edge: (edge * 100).toFixed(1) + '%',
      cost: '$' + positionSize.toFixed(2),
    });

    await this.logAction(originalPosition, 'reentry', currentPrice, {
      reentry_id: reentry?.id,
      edge: edge * 100,
      cost: positionSize,
    });

    if (this.telegramOnReentry) {
      await this.sendTelegram(
        `🔄 *RE-ENTRY*: ${originalPosition.city} ${originalPosition.range_name}\n` +
        `Original exit: ${(parseFloat(originalPosition.exit_price) * 100).toFixed(0)}¢\n` +
        `Re-entry: ${(entryPrice * 100).toFixed(0)}¢\n` +
        `Edge: ${(edge * 100).toFixed(1)}%\n` +
        `Cost: $${positionSize.toFixed(2)}`
      );
    }
  }

  /**
   * Get current bankroll (paper bankroll + realized P&L)
   */
  async getBankroll() {
    const { data, error } = await this.supabase
      .from('weather_paper_trades')
      .select('pnl')
      .in('status', ['won', 'lost', 'exited']);

    if (error || !data) return this.paperBankroll;

    const realizedPnl = data.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
    return this.paperBankroll + realizedPnl;
  }

  /**
   * Calculate days until target date
   */
  getDaysToResolution(targetDate) {
    const target = new Date(targetDate + 'T00:00:00Z');
    const now = new Date();
    return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
  }

  /**
   * Resolve re-entry trades that have passed their target date
   */
  async resolveReentryTrades() {
    const today = new Date().toISOString().split('T')[0];

    const { data: reentries, error } = await this.supabase
      .from('reentry_trades')
      .select('*')
      .eq('status', 'open')
      .lt('target_date', today);

    if (error || !reentries || reentries.length === 0) return;

    this.log('info', `Resolving ${reentries.length} re-entry trades`);

    for (const reentry of reentries) {
      try {
        // Get actual temperature
        const actual = await this.weatherApi.getHistoricalHigh(reentry.city, reentry.target_date);
        if (!actual) {
          this.log('warn', 'No actual temp for re-entry resolution', {
            city: reentry.city,
            date: reentry.target_date,
          });
          continue;
        }

        const won = this.isForecastInRange({ temp_f: actual.highF, temp_c: actual.highC }, reentry.range_name);
        const pnl = won
          ? (1 - parseFloat(reentry.entry_price)) * parseFloat(reentry.shares) * (1 - this.polymarketFee)
          : -parseFloat(reentry.cost);

        await this.supabase
          .from('reentry_trades')
          .update({
            status: won ? 'won' : 'lost',
            pnl: pnl,
          })
          .eq('id', reentry.id);

        this.log('info', 'Re-entry trade resolved', {
          city: reentry.city,
          date: reentry.target_date,
          range: reentry.range_name,
          result: won ? 'WON' : 'LOST',
          pnl: '$' + pnl.toFixed(2),
        });

      } catch (err) {
        this.log('error', 'Re-entry resolution failed', {
          id: reentry.id,
          error: err.message,
        });
      }
    }
  }

  /**
   * Log an action to position_manager_logs table
   */
  async logAction(position, action, currentPrice, extra = {}) {
    try {
      await this.supabase
        .from('position_manager_logs')
        .insert({
          trade_id: position.id,
          city: position.city,
          target_date: position.target_date,
          range_name: position.range_name,
          action: action,
          entry_price: parseFloat(position.entry_price) || null,
          current_price: currentPrice?.price || null,
          current_bid: currentPrice?.bid || null,
          current_ask: currentPrice?.ask || null,
          entry_tier: extra.entryTier || null,
          exit_threshold: extra.exitThreshold || null,
          forecast_temp_f: extra.forecast || null,
          forecast_in_range: extra.forecastInRange ?? null,
          reason: extra.reason || null,
        });
    } catch (err) {
      this.log('warn', 'Failed to log action', { error: err.message });
    }
  }
}

module.exports = { PositionManager };
