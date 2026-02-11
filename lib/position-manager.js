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
    this.kalshiApi = config.kalshiApi || null;
    this.log = config.log || console.log;
    this.sendTelegram = config.sendTelegram || (() => {});
    this.config = config.settings || {};

    // Defaults (overridable via config.settings)
    this.takeProfit = this.config.TAKE_PROFIT || {
      LONGSHOT: { maxEntry: 0.25, exitAt: 0.75 },
      MIDRANGE: { maxEntry: 0.40, exitAt: 0.55 },
      FAVORITE: { maxEntry: 0.75, exitAt: 0.85 },
      SUPER_FAVORITE: { maxEntry: 1.00, exitAt: 0.95 },
    };
    this.stopLossEnabled = this.config.STOP_LOSS_ENABLED ?? false;
    this.forecastExitEnabled = this.config.FORECAST_EXIT_ENABLED ?? true;
    this.forecastExitMinDays = this.config.FORECAST_EXIT_MIN_DAYS ?? 1;
    this.forecastExitMinBid = this.config.FORECAST_EXIT_MIN_BID ?? 0.15;
    this.reentryEnabled = this.config.REENTRY_ENABLED ?? true;
    this.reentryMinEdgePct = this.config.REENTRY_MIN_EDGE_PCT ?? 0.03;
    this.reentryMinEdgeDollars = this.config.REENTRY_MIN_EDGE_DOLLARS ?? 0.01;
    this.polymarketFee = this.config.POLYMARKET_FEE ?? 0.0315;
    this.paperBankroll = this.config.PAPER_BANKROLL ?? 1000;
    this.telegramOnExit = this.config.TELEGRAM_ON_EXIT ?? true;
    this.telegramOnReentry = this.config.TELEGRAM_ON_REENTRY ?? true;

    // Forecast exit intelligence
    this.forecastExitMarginMultiplier = this.config.FORECAST_EXIT_MIN_MARGIN_MULTIPLIER ?? 1.0;
    this.forecastExitDefaultErrorF = this.config.FORECAST_EXIT_DEFAULT_ERROR_F ?? 2.0;
    this.forecastExitConfirmChecks = this.config.FORECAST_EXIT_CONFIRM_CHECKS ?? 2;

    // In-memory shift tracker: positionId → { firstSeen, count, lastForecast }
    // Resets on restart (conservative: fresh start = no stale state)
    this.shiftTracker = {};
  }

  /**
   * Get platform-appropriate fee rate for a position
   */
  getFeeRate(position) {
    return (position.platform || 'polymarket') === 'kalshi' ? 0.012 : this.polymarketFee;
  }

  /**
   * Main cycle - check all open positions for exit conditions
   */
  async run() {
    this.log('info', '=== Position Manager scan cycle ===');

    // Clear source error cache so it refreshes each cycle
    this._sourceErrorCache = null;

    try {
      const openPositions = await this.getOpenPositions();
      const origCount = openPositions.filter(p => p._source === 'weather_paper_trades').length;
      const reentryCount = openPositions.filter(p => p._source === 'reentry_trades').length;
      this.log('info', `Monitoring ${openPositions.length} positions (${origCount} original, ${reentryCount} re-entries)`);

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
            // Verify exit is actually profitable after fees
            const entryPrice = parseFloat(position.entry_price);
            const netExitPerShare = currentPrice.bid * (1 - this.getFeeRate(position));
            if (netExitPerShare <= entryPrice) {
              this.log('warn', 'Take profit skipped - not profitable after fees', {
                city: position.city,
                range: position.range_name,
                entryPrice: (entryPrice * 100).toFixed(0) + '¢',
                bid: (currentPrice.bid * 100).toFixed(0) + '¢',
                netPerShare: (netExitPerShare * 100).toFixed(1) + '¢',
              });
              // Fall through to forecast check instead of exiting at a loss
            } else {
              await this.executeTakeProfit(position, currentPrice, entryTier, exitThreshold);
              exits++;
              continue;
            }
          }

          // Check FORECAST SHIFT condition (two-gate: error margin + stability)
          if (this.forecastExitEnabled) {
            const daysToResolution = this.getDaysToResolution(position.target_date);
            if (daysToResolution >= this.forecastExitMinDays) {
              const forecast = await this.getCurrentForecast(position.city, position.target_date, position.platform);
              if (forecast) {
                const forecastInRange = this.isForecastInRange(forecast, position.range_name);
                const posKey = `${position._source}:${position.id}`;

                if (forecastInRange) {
                  // Forecast back in range — clear any pending shift
                  if (this.shiftTracker[posKey]) {
                    this.log('info', 'Forecast returned to range — shift cleared', {
                      city: position.city,
                      range: position.range_name,
                      forecast: forecast.temp_f + '°F',
                      source: forecast.primarySource,
                      pendingChecks: this.shiftTracker[posKey].count,
                    });
                    delete this.shiftTracker[posKey];
                  }
                } else {
                  // Forecast is outside range — apply two gates

                  // GATE 1: Error margin — shift must exceed source's typical error
                  const distance = this.calculateDistanceFromRange(forecast, position.range_name);
                  const sourceErrors = await this.getSourceErrors();
                  const cityKey = position.city.toLowerCase();
                  const source = forecast.primarySource || 'openmeteo';
                  const sourceError = sourceErrors[`${cityKey}:${source}`] ?? this.forecastExitDefaultErrorF;
                  const minMargin = sourceError * this.forecastExitMarginMultiplier;

                  if (distance <= minMargin) {
                    // Within error margin — likely noise, hold
                    await this.logAction(position, 'skip_forecast_exit', currentPrice, {
                      entryTier,
                      exitThreshold,
                      forecast: forecast.temp_f,
                      reason: `Forecast shifted but within error margin (${distance.toFixed(1)}°F <= ${minMargin.toFixed(1)}°F ${source} error) — holding`,
                    });
                    this.log('info', 'Forecast shift within error margin — holding', {
                      city: position.city,
                      range: position.range_name,
                      forecast: forecast.temp_f + '°F',
                      distance: distance.toFixed(1) + '°F',
                      sourceError: minMargin.toFixed(1) + '°F',
                      source,
                    });
                    // Clear shift tracker since we're treating this as noise
                    delete this.shiftTracker[posKey];
                    continue;
                  }

                  // GATE 2: Stability confirmation — shift must persist across N consecutive checks
                  if (!this.shiftTracker[posKey]) {
                    // First time seeing this position outside range past error margin
                    this.shiftTracker[posKey] = {
                      firstSeen: Date.now(),
                      count: 1,
                      lastForecast: forecast.temp_f,
                    };
                    await this.logAction(position, 'skip_forecast_exit', currentPrice, {
                      entryTier,
                      exitThreshold,
                      forecast: forecast.temp_f,
                      reason: `Forecast shift detected (${distance.toFixed(1)}°F > ${minMargin.toFixed(1)}°F error) — waiting for confirmation (1/${this.forecastExitConfirmChecks})`,
                    });
                    this.log('info', 'Forecast shift detected — waiting for confirmation', {
                      city: position.city,
                      range: position.range_name,
                      forecast: forecast.temp_f + '°F',
                      distance: distance.toFixed(1) + '°F',
                      source,
                      check: `1/${this.forecastExitConfirmChecks}`,
                    });
                    continue;
                  }

                  // Subsequent check — increment counter
                  this.shiftTracker[posKey].count++;
                  this.shiftTracker[posKey].lastForecast = forecast.temp_f;

                  if (this.shiftTracker[posKey].count < this.forecastExitConfirmChecks) {
                    await this.logAction(position, 'skip_forecast_exit', currentPrice, {
                      entryTier,
                      exitThreshold,
                      forecast: forecast.temp_f,
                      reason: `Forecast shift persists — confirmation ${this.shiftTracker[posKey].count}/${this.forecastExitConfirmChecks}`,
                    });
                    this.log('info', 'Forecast shift persists — still confirming', {
                      city: position.city,
                      range: position.range_name,
                      forecast: forecast.temp_f + '°F',
                      check: `${this.shiftTracker[posKey].count}/${this.forecastExitConfirmChecks}`,
                    });
                    continue;
                  }

                  // Shift confirmed — execute exit (or skip if bid too low)
                  this.log('info', 'Forecast shift CONFIRMED — proceeding with exit', {
                    city: position.city,
                    range: position.range_name,
                    forecast: forecast.temp_f + '°F',
                    distance: distance.toFixed(1) + '°F',
                    source,
                    checks: this.shiftTracker[posKey].count,
                    elapsedMin: Math.round((Date.now() - this.shiftTracker[posKey].firstSeen) / 60000),
                  });
                  delete this.shiftTracker[posKey];

                  if (currentPrice.bid < this.forecastExitMinBid) {
                    await this.logAction(position, 'skip_forecast_exit', currentPrice, {
                      entryTier,
                      exitThreshold,
                      forecast: forecast.temp_f,
                      reason: `Forecast shift confirmed but bid ${(currentPrice.bid * 100).toFixed(0)}¢ < ${(this.forecastExitMinBid * 100).toFixed(0)}¢ threshold — holding`,
                    });
                    this.log('info', 'Skipping forecast exit — bid too low', {
                      city: position.city,
                      date: position.target_date,
                      bid: (currentPrice.bid * 100).toFixed(0) + '¢',
                      minBid: (this.forecastExitMinBid * 100).toFixed(0) + '¢',
                    });
                  } else {
                    // Pass distance/source info to executeForecastExit for richer Telegram msgs
                    forecast._exitMeta = { distance, source, sourceError: minMargin };
                    await this.executeForecastExit(position, currentPrice, forecast);
                    exits++;
                  }
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

      // Report Bot B P&L
      const stats = await this.getStats();
      this.log('info', 'Position Manager cycle complete', {
        positions: openPositions.length,
        exits,
        monitored,
        botB_pnl: '$' + stats.exitPnl.toFixed(2),
        botB_exits: stats.exitWins + 'W/' + stats.exitLosses + 'L',
        botB_reentries: stats.reentryCount,
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
    // Fetch from weather_paper_trades (both Polymarket and Kalshi)
    const { data: originalPositions, error: err1 } = await this.supabase
      .from('weather_paper_trades')
      .select('*')
      .eq('status', 'open');

    if (err1) {
      this.log('error', 'Failed to fetch open positions', { error: err1.message });
      return [];
    }

    // Fetch open re-entries too (Fix 2: monitor re-entries for exits)
    const { data: reentryPositions, error: err2 } = await this.supabase
      .from('reentry_trades')
      .select('*')
      .eq('status', 'open');

    if (err2) {
      this.log('warn', 'Failed to fetch re-entry positions', { error: err2.message });
    }

    // Tag source so exit logic updates the correct table
    const allPositions = [
      ...(originalPositions || []).map(p => ({ ...p, _source: 'weather_paper_trades' })),
      ...(reentryPositions || []).map(p => ({ ...p, _source: 'reentry_trades' })),
    ];

    return allPositions;
  }

  /**
   * Fetch current market price for a Kalshi position via event API
   */
  async getKalshiCurrentPrice(position) {
    if (!this.kalshiApi) return null;
    try {
      const eventTicker = position.market_slug;
      if (!eventTicker) return null;

      const markets = await this.kalshiApi.getEventMarkets(eventTicker);
      const match = markets.find(m => m.subtitle === position.range_name);
      if (!match) return null;

      return {
        price: match.yesBid,
        bid: match.yesBid,
        ask: match.yesAsk,
        spread: match.yesAsk - match.yesBid,
        volume: match.volume,
      };
    } catch (err) {
      this.log('warn', 'getKalshiCurrentPrice failed', { city: position.city, error: err.message });
      return null;
    }
  }

  /**
   * Fetch current market price for a position's range
   */
  async getCurrentPrice(position) {
    // Route to Kalshi API for Kalshi positions
    const platform = position.platform || 'polymarket';
    if (platform === 'kalshi') return this.getKalshiCurrentPrice(position);

    try {
      let slug = position.market_slug;

      // Re-entries may not have market_slug — look up from original trade
      if (!slug && position._source === 'reentry_trades' && position.original_trade_id) {
        const { data: origTrade } = await this.supabase
          .from('weather_paper_trades')
          .select('market_slug')
          .eq('id', position.original_trade_id)
          .single();
        slug = origTrade?.market_slug;
      }

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
    const spread = bestAsk - bestBid;
    const volume = parseFloat(market.volume) || 0;

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
      spread,
      volume,
    };
  }

  /**
   * Update max/min price tracking for a position
   */
  async updatePriceTracking(position, currentPrice) {
    // Skip price tracking for re-entries (no max/min columns in reentry_trades)
    if (position._source === 'reentry_trades') return;

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
    if (price < this.takeProfit.FAVORITE.maxEntry) return 'FAVORITE';
    return 'SUPER_FAVORITE';
  }

  /**
   * Execute take profit exit
   */
  async executeTakeProfit(position, currentPrice, entryTier, exitThreshold) {
    const exitPrice = currentPrice.bid;
    const shares = parseFloat(position.shares);
    const entryPrice = parseFloat(position.entry_price);
    const grossProfit = (exitPrice - entryPrice) * shares;
    const fee = exitPrice * shares * this.getFeeRate(position);
    const netPnl = grossProfit - fee;

    const table = position._source || 'weather_paper_trades';
    const isReentry = table === 'reentry_trades';

    // Build update fields — reentry_trades doesn't have exit_pnl column
    const updateFields = {
      status: 'exited',
      exit_reason: 'take_profit',
      exit_price: exitPrice,
      exit_time: new Date().toISOString(),
      pnl: netPnl,
      exit_bid: currentPrice.bid,
      exit_ask: currentPrice.ask,
      exit_spread: currentPrice.spread,
      exit_volume: currentPrice.volume,
    };
    if (!isReentry) {
      updateFields.managed_by = 'position_manager';
      updateFields.exit_pnl = netPnl;
    }

    const { error } = await this.supabase
      .from(table)
      .update(updateFields)
      .eq('id', position.id);

    if (error) {
      this.log('error', 'Failed to update trade for take profit', { error: error.message });
      return;
    }

    const label = isReentry ? 'TAKE PROFIT (re-entry)' : 'TAKE PROFIT';
    this.log('success', `${label} executed`, {
      city: position.city,
      date: position.target_date,
      range: position.range_name,
      entryPrice: (entryPrice * 100).toFixed(0) + '¢',
      exitPrice: (exitPrice * 100).toFixed(0) + '¢',
      netPnl: '$' + netPnl.toFixed(2),
      tier: entryTier,
    });

    await this.logAction(position, 'exit_take_profit', currentPrice, {
      entryTier,
      exitThreshold,
      netPnl,
      reason: `Price ${(exitPrice * 100).toFixed(0)}¢ hit ${entryTier} target ${(exitThreshold * 100).toFixed(0)}¢`,
      source: table,
    });

    if (this.telegramOnExit) {
      const gainPct = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(0);
      const ptag = (position.platform || 'polymarket') === 'kalshi' ? '[KL] ' : '[PM] ';
      await this.sendTelegram(
        `🎯 *[Bot B] ${ptag}${label}*: ${position.city} ${position.range_name}\n` +
        `Date: ${position.target_date}\n` +
        `Entry: ${(entryPrice * 100).toFixed(0)}¢ → Exit: ${(exitPrice * 100).toFixed(0)}¢\n` +
        `P&L: $${netPnl.toFixed(2)} (${gainPct}% gain)\n` +
        `Tier: ${entryTier} (threshold: ${(exitThreshold * 100).toFixed(0)}¢)`
      );
    }
  }

  /**
   * Get current forecast for a city/date
   */
  async getCurrentForecast(city, targetDate, platform = null) {
    try {
      const forecast = await this.weatherApi.getMultiSourceForecast(city, targetDate, platform);
      if (!forecast) return null;
      return {
        temp_f: forecast.highF,
        temp_c: forecast.highC,
        confidence: forecast.confidence,
        primarySource: forecast.primarySource,
        consensus: forecast.consensus,
        sources: forecast.sources,
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
    const fee = exitPrice * shares * this.getFeeRate(position);
    const netPnl = grossProfit - fee;

    const table = position._source || 'weather_paper_trades';
    const isReentry = table === 'reentry_trades';

    const updateFields = {
      status: 'exited',
      exit_reason: 'forecast_shift',
      exit_price: exitPrice,
      exit_time: new Date().toISOString(),
      pnl: netPnl,
      exit_bid: currentPrice.bid,
      exit_ask: currentPrice.ask,
      exit_spread: currentPrice.spread,
      exit_volume: currentPrice.volume,
    };
    if (!isReentry) {
      updateFields.managed_by = 'position_manager';
      updateFields.exit_pnl = netPnl;
    }

    const { error } = await this.supabase
      .from(table)
      .update(updateFields)
      .eq('id', position.id);

    if (error) {
      this.log('error', 'Failed to update trade for forecast exit', { error: error.message });
      return;
    }

    const label = isReentry ? 'FORECAST EXIT (re-entry)' : 'FORECAST EXIT';
    const meta = forecast._exitMeta || {};
    this.log('warn', `${label} executed`, {
      city: position.city,
      date: position.target_date,
      range: position.range_name,
      forecastTemp: forecast.temp_f + '°F',
      source: meta.source || forecast.primarySource || 'unknown',
      distance: meta.distance ? meta.distance.toFixed(1) + '°F' : 'n/a',
      sourceError: meta.sourceError ? meta.sourceError.toFixed(1) + '°F' : 'n/a',
      exitPrice: (exitPrice * 100).toFixed(0) + '¢',
      netPnl: '$' + netPnl.toFixed(2),
    });

    await this.logAction(position, 'exit_forecast_shift', currentPrice, {
      forecast: forecast.temp_f,
      reason: `Forecast ${forecast.temp_f}°F shifted ${meta.distance ? meta.distance.toFixed(1) + '°F' : ''} outside ${position.range_name} (source: ${meta.source || forecast.primarySource || '?'}, error margin: ${meta.sourceError ? meta.sourceError.toFixed(1) + '°F' : '?'}) — confirmed`,
      source: table,
    });

    if (this.telegramOnExit) {
      const sourceInfo = meta.source ? `Source: ${meta.source} (error: ${meta.sourceError?.toFixed(1) || '?'}°F)\n` : '';
      const distInfo = meta.distance ? `Shift: ${meta.distance.toFixed(1)}°F outside range\n` : '';
      const ptag = (position.platform || 'polymarket') === 'kalshi' ? '[KL] ' : '[PM] ';
      await this.sendTelegram(
        `⚠️ *[Bot B] ${ptag}${label}*: ${position.city} ${position.range_name}\n` +
        `Date: ${position.target_date}\n` +
        `Forecast shifted to ${forecast.temp_f}°F (outside range)\n` +
        `${distInfo}${sourceInfo}` +
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
   * Load average forecast errors per city per source from forecast_accuracy table.
   * Returns a lookup like { "seattle:nws": 0.4, "seattle:openmeteo": 2.7, ... }
   * Caches result for the current cycle.
   */
  async getSourceErrors() {
    // Return cached if available (refreshed each cycle in run())
    if (this._sourceErrorCache) return this._sourceErrorCache;

    const sourceColumns = {
      openmeteo: 'open_meteo_error_f',
      nws: 'nws_error_f',
      weatherapi: 'weatherapi_error_f',
    };

    const { data, error } = await this.supabase
      .from('forecast_accuracy')
      .select('city, open_meteo_error_f, nws_error_f, weatherapi_error_f')
      .not('actual_temp_f', 'is', null);

    if (error || !data) {
      this.log('warn', 'Failed to load source errors', { error: error?.message });
      this._sourceErrorCache = {};
      return this._sourceErrorCache;
    }

    // Accumulate errors per city:source
    const accumulated = {};
    for (const row of data) {
      const city = row.city.toLowerCase();
      for (const [source, col] of Object.entries(sourceColumns)) {
        const val = parseFloat(row[col]);
        if (!isNaN(val)) {
          const key = `${city}:${source}`;
          if (!accumulated[key]) accumulated[key] = [];
          accumulated[key].push(val);
        }
      }
    }

    // Average per city:source
    const avgErrors = {};
    for (const [key, vals] of Object.entries(accumulated)) {
      avgErrors[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }

    this._sourceErrorCache = avgErrors;
    return avgErrors;
  }

  /**
   * Calculate how far a forecast is outside a range (in native units).
   * Returns 0 if the forecast is inside the range.
   * Positive value = how many degrees outside the nearest boundary.
   */
  calculateDistanceFromRange(forecast, rangeName) {
    const cleaned = rangeName.replace(/Â/g, '');
    let temp = forecast.temp_f;
    let isCelsius = false;

    if (cleaned.includes('°C')) {
      temp = (forecast.temp_f - 32) * 5 / 9;
      isCelsius = true;
    }

    // "X or higher/above"
    if (/higher|above/i.test(cleaned)) {
      const threshold = parseFloat(cleaned.match(/-?[\d.]+/)?.[0]);
      if (isNaN(threshold)) return 0;
      return temp >= threshold ? 0 : threshold - temp;
    }

    // "X or below"
    if (/below/i.test(cleaned)) {
      const threshold = parseFloat(cleaned.match(/-?[\d.]+/)?.[0]);
      if (isNaN(threshold)) return 0;
      return temp <= threshold ? 0 : temp - threshold;
    }

    // "X-Y" range
    const unit = isCelsius ? '°C' : '°';
    const rangeMatch = cleaned.match(/(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)/);
    if (rangeMatch) {
      const low = parseFloat(rangeMatch[1]);
      const high = parseFloat(rangeMatch[2]);
      if (temp < low) return low - temp;
      if (temp > high) return temp - high;
      return 0;
    }

    // Single value "X°F" or "X°C"
    const single = cleaned.match(/(-?[\d.]+)\s*°/);
    if (single) {
      const n = parseFloat(single[1]);
      const dist = Math.abs(temp - n);
      return dist < 0.5 ? 0 : dist - 0.5;
    }

    return 0;
  }

  /**
   * Check for re-entry opportunities on recently exited positions
   */
  async checkReentryOpportunities() {
    // PROTECTION 1: Only forecast_shift exits (take-profit exits already captured value)
    // Fetch exited positions from weather_paper_trades
    const { data: exitedOriginals, error: err1 } = await this.supabase
      .from('weather_paper_trades')
      .select('*')
      .eq('managed_by', 'position_manager')
      .eq('status', 'exited')
      .eq('exit_reason', 'forecast_shift')
      .gte('exit_time', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .gte('target_date', new Date().toISOString().split('T')[0]);

    // Fix 3: Also fetch exited re-entries for re-entry of re-entries
    const { data: exitedReentries, error: err2 } = await this.supabase
      .from('reentry_trades')
      .select('*')
      .eq('status', 'exited')
      .eq('exit_reason', 'forecast_shift')
      .gte('exit_time', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .gte('target_date', new Date().toISOString().split('T')[0]);

    // Combine with source tags
    const allExited = [
      ...((exitedOriginals || []).map(p => ({ ...p, _source: 'weather_paper_trades' }))),
      ...((exitedReentries || []).map(p => ({ ...p, _source: 'reentry_trades' }))),
    ];

    if (allExited.length === 0) return;

    this.log('info', `Checking ${allExited.length} exited positions for re-entry (${(exitedOriginals || []).length} original, ${(exitedReentries || []).length} re-entries)`);

    const checkedCombos = new Set();

    for (const position of allExited) {
      try {
        // Dedup by city + date + range
        const comboKey = `${position.city}|${position.target_date}|${position.range_name}`;
        if (checkedCombos.has(comboKey)) continue;
        checkedCombos.add(comboKey);

        const { data: existing } = await this.supabase
          .from('reentry_trades')
          .select('id')
          .eq('city', position.city)
          .eq('target_date', position.target_date)
          .eq('range_name', position.range_name)
          .eq('status', 'open')
          .limit(1);

        if (existing && existing.length > 0) continue;

        // Get current market data
        const currentPrice = await this.getCurrentPrice(position);
        if (!currentPrice) continue;

        // Get current forecast (platform-aware: Kalshi forces NWS)
        const forecast = await this.getCurrentForecast(position.city, position.target_date, position.platform);
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
        const netEdgeDollars = edge - (currentPrice.ask * this.getFeeRate(position));

        if (edge < this.reentryMinEdgePct || netEdgeDollars < minEdgeDollars) {
          await this.logAction(position, 'skip_reentry', currentPrice, {
            reason: `Edge ${(edge * 100).toFixed(1)}% / $${netEdgeDollars.toFixed(3)} below threshold`,
          });
          continue;
        }

        // PROTECTION 2: Edge must be higher than PREVIOUS entry's edge
        // Fix 1: Use edge_at_entry from position instead of weather_opportunities lookup
        const previousEdge = parseFloat(position.edge_at_entry) || 0;
        const reentryEdgePct = edge * 100;

        if (reentryEdgePct < previousEdge + 0.5) {
          await this.logAction(position, 'skip_reentry', currentPrice, {
            reason: `Re-entry edge ${reentryEdgePct.toFixed(1)}% not higher than previous ${previousEdge.toFixed(1)}% - skipping`,
          });
          this.log('info', 'Re-entry edge not higher than previous entry', {
            city: position.city,
            range: position.range_name,
            reentryEdge: reentryEdgePct.toFixed(1) + '%',
            previousEdge: previousEdge.toFixed(1) + '%',
            source: position._source,
          });
          continue;
        }

        // Execute re-entry (passes exited position for chain tracing)
        await this.executeReentry(position, currentPrice, forecast, edge, previousEdge);

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
  async executeReentry(exitedPosition, currentPrice, forecast, edge, previousEdge = 0) {
    const entryPrice = currentPrice.ask;
    const bankroll = await this.getBankroll();

    // Simple Kelly sizing for re-entry
    const kellyFraction = 0.5;
    const maxPositionPct = 0.20;
    const trueProbability = this.calculateTrueProbability(forecast.confidence);

    // Kelly formula: f = (p*b - q) / b where b = (1-fee-price)/price
    const effectivePayout = 1 - this.getFeeRate(position);
    const b = (effectivePayout - entryPrice) / entryPrice;
    const p = trueProbability;
    const q = 1 - p;
    let fullKelly = b > 0 ? (p * b - q) / b : 0;
    fullKelly = Math.max(0, fullKelly);

    let positionSize = Math.min(
      bankroll * maxPositionPct,
      bankroll * fullKelly * kellyFraction
    );

    // PROTECTION 3: Cap at 2x ORIGINAL trade cost (follow chain back to weather_paper_trades)
    let originalTradeId;
    let originalCost;
    let marketSlug = exitedPosition.market_slug || null;

    if (exitedPosition._source === 'reentry_trades') {
      // It's a re-entry — follow chain to original weather_paper_trades record
      originalTradeId = exitedPosition.original_trade_id;
      const { data: original } = await this.supabase
        .from('weather_paper_trades')
        .select('cost, market_slug')
        .eq('id', exitedPosition.original_trade_id)
        .single();
      originalCost = parseFloat(original?.cost) || parseFloat(exitedPosition.cost);
      if (!marketSlug) marketSlug = original?.market_slug || null;
    } else {
      // It's from weather_paper_trades — this IS the original
      originalTradeId = exitedPosition.id;
      originalCost = parseFloat(exitedPosition.cost);
    }

    const maxReentryCost = originalCost * 2;
    positionSize = Math.min(positionSize, maxReentryCost);

    if (positionSize < 10) {
      this.log('info', 'Re-entry position too small', {
        city: exitedPosition.city,
        positionSize: positionSize.toFixed(2),
      });
      return;
    }

    const shares = positionSize / entryPrice;

    // Record re-entry — always link to ORIGINAL weather_paper_trades record
    const insertFields = {
      original_trade_id: originalTradeId,
      city: exitedPosition.city,
      target_date: exitedPosition.target_date,
      platform: exitedPosition.platform || 'polymarket',
      range_name: exitedPosition.range_name,
      entry_price: entryPrice,
      cost: positionSize,
      shares: shares,
      edge_at_entry: edge * 100,
      forecast_temp_f: forecast.temp_f,
      status: 'open',
      entry_bid: currentPrice.bid || null,
      entry_ask: currentPrice.ask || null,
      entry_spread: currentPrice.spread || null,
      entry_volume: currentPrice.volume || null,
    };
    // Include market_slug if available (column added via migration)
    if (marketSlug) insertFields.market_slug = marketSlug;

    let { data: reentry, error } = await this.supabase
      .from('reentry_trades')
      .insert(insertFields)
      .select()
      .single();

    // If insert fails due to missing market_slug column (pre-migration), retry without it
    if (error && insertFields.market_slug && error.message && error.message.includes('market_slug')) {
      delete insertFields.market_slug;
      const retry = await this.supabase
        .from('reentry_trades')
        .insert(insertFields)
        .select()
        .single();
      reentry = retry.data;
      error = retry.error;
    }

    if (error) {
      this.log('error', 'Failed to insert re-entry trade', { error: error.message });
      return;
    }

    const reentryEdgePct = (edge * 100).toFixed(1);
    const isReentryOfReentry = exitedPosition._source === 'reentry_trades';
    const label = isReentryOfReentry ? 'RE-ENTRY (of re-entry)' : 'RE-ENTRY';

    this.log('success', `${label} executed`, {
      city: exitedPosition.city,
      date: exitedPosition.target_date,
      range: exitedPosition.range_name,
      entryPrice: (entryPrice * 100).toFixed(0) + '¢',
      edge: reentryEdgePct + '%',
      previousEdge: previousEdge.toFixed(1) + '%',
      edgeImprovement: (edge * 100 - previousEdge).toFixed(1) + '%',
      cost: '$' + positionSize.toFixed(2),
      originalCost: '$' + originalCost.toFixed(2),
      costCap: '$' + maxReentryCost.toFixed(2),
    });

    await this.logAction(exitedPosition, 'reentry', currentPrice, {
      reentry_id: reentry?.id,
      edge: edge * 100,
      previousEdge: previousEdge,
      cost: positionSize,
      originalCost: originalCost,
    });

    if (this.telegramOnReentry) {
      const ptag = (exitedPosition.platform || 'polymarket') === 'kalshi' ? '[KL] ' : '[PM] ';
      await this.sendTelegram(
        `🔄 *[Bot B] ${ptag}${label}*: ${exitedPosition.city} ${exitedPosition.range_name}\n` +
        `Date: ${exitedPosition.target_date}\n` +
        `Previous exit: ${(parseFloat(exitedPosition.exit_price) * 100).toFixed(0)}¢ | Original cost: $${originalCost.toFixed(2)}\n` +
        `Re-entry: ${(entryPrice * 100).toFixed(0)}¢ | Cost: $${positionSize.toFixed(2)} (cap: $${maxReentryCost.toFixed(2)})\n` +
        `Edge: ${reentryEdgePct}% (was ${previousEdge.toFixed(1)}%, +${(edge * 100 - previousEdge).toFixed(1)}%)`
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
        // Platform-aware resolution: Kalshi uses NWS, Polymarket uses Open-Meteo
        const platform = reentry.platform || 'polymarket';
        const actual = platform === 'kalshi'
          ? await this.weatherApi.getKalshiResolutionHigh(reentry.city, reentry.target_date)
          : await this.weatherApi.getHistoricalHigh(reentry.city, reentry.target_date);
        if (!actual) {
          this.log('warn', 'No actual temp for re-entry resolution', {
            city: reentry.city,
            date: reentry.target_date,
            platform,
          });
          continue;
        }

        const won = this.isForecastInRange({ temp_f: actual.highF, temp_c: actual.highC }, reentry.range_name);
        const pnl = won
          ? (1 - parseFloat(reentry.entry_price)) * parseFloat(reentry.shares) * (1 - this.getFeeRate(reentry))
          : -parseFloat(reentry.cost);

        const resolvedAt = new Date().toISOString();
        const updateFields = {
          status: won ? 'won' : 'lost',
          pnl: pnl,
          exit_reason: 'resolution',
          exit_time: resolvedAt,
          exit_price: won ? 1.0 : 0.0,
          actual_high_temp: actual.highF,
          resolved_at: resolvedAt,
        };

        let { error: updateError } = await this.supabase
          .from('reentry_trades')
          .update(updateFields)
          .eq('id', reentry.id);

        // If new columns don't exist yet (pre-migration), retry without them
        if (updateError && updateError.message && (updateError.message.includes('actual_high_temp') || updateError.message.includes('resolved_at'))) {
          delete updateFields.actual_high_temp;
          delete updateFields.resolved_at;
          await this.supabase
            .from('reentry_trades')
            .update(updateFields)
            .eq('id', reentry.id);
        }

        this.log('info', 'Re-entry trade resolved', {
          city: reentry.city,
          date: reentry.target_date,
          range: reentry.range_name,
          result: won ? 'WON' : 'LOST',
          actualHighF: actual.highF,
          pnl: '$' + pnl.toFixed(2),
        });

        // Log resolution to position_manager_logs for audit trail
        await this.logAction(reentry, 'resolution', { bid: won ? 1.0 : 0.0, ask: won ? 1.0 : 0.0 }, {
          reentry_id: reentry.id,
          original_trade_id: reentry.original_trade_id,
          result: won ? 'won' : 'lost',
          actual_high_temp: actual.highF,
          pnl: pnl,
          reason: `resolution: ${won ? 'WON' : 'LOST'} (actual: ${actual.highF}°F)`,
        });

        if (this.telegramOnExit) {
          const icon = won ? '✅' : '❌';
          const ptag = (reentry.platform || 'polymarket') === 'kalshi' ? '[KL] ' : '[PM] ';
          await this.sendTelegram(
            `${icon} *[Bot B] ${ptag}RE-ENTRY RESOLVED*: ${reentry.city} ${reentry.range_name}\n` +
            `Date: ${reentry.target_date}\n` +
            `Result: ${won ? 'WON' : 'LOST'}\n` +
            `Entry: ${(parseFloat(reentry.entry_price) * 100).toFixed(0)}¢ | P&L: $${pnl.toFixed(2)}`
          );
        }

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
      // Build details object from extra fields not in fixed columns
      const { entryTier, exitThreshold, forecast, forecastInRange, reason, ...detailFields } = extra;
      const details = Object.keys(detailFields).length > 0 ? detailFields : null;

      const insertFields = {
        trade_id: position.id,
        city: position.city,
        target_date: position.target_date,
        range_name: position.range_name,
        action: action,
        entry_price: parseFloat(position.entry_price) || null,
        current_price: currentPrice?.price || null,
        current_bid: currentPrice?.bid || null,
        current_ask: currentPrice?.ask || null,
        entry_tier: entryTier || null,
        exit_threshold: exitThreshold || null,
        forecast_temp_f: forecast || null,
        forecast_in_range: forecastInRange ?? null,
        reason: reason || null,
        details: details,
        platform: position.platform || 'polymarket',
        source_table: position._source || 'weather_paper_trades',
      };

      let { error } = await this.supabase
        .from('position_manager_logs')
        .insert(insertFields);

      // If new columns don't exist yet (pre-migration), retry without them
      if (error && error.message) {
        const retryFields = { ...insertFields };
        let needsRetry = false;
        if (error.message.includes('details')) { delete retryFields.details; needsRetry = true; }
        if (error.message.includes('platform')) { delete retryFields.platform; needsRetry = true; }
        if (error.message.includes('source_table')) { delete retryFields.source_table; needsRetry = true; }
        if (needsRetry) {
          await this.supabase
            .from('position_manager_logs')
            .insert(retryFields);
        }
      }
    } catch (err) {
      this.log('warn', 'Failed to log action', { error: err.message });
    }
  }

  /**
   * Get Bot B stats (exit P&L + re-entry P&L)
   */
  async getStats() {
    // Bot B managed exits
    const { data: exits } = await this.supabase
      .from('weather_paper_trades')
      .select('pnl, exit_reason')
      .eq('managed_by', 'position_manager')
      .eq('status', 'exited');

    const exitPnl = (exits || []).reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
    const exitWins = (exits || []).filter(t => parseFloat(t.pnl) > 0).length;
    const exitLosses = (exits || []).filter(t => parseFloat(t.pnl) <= 0).length;
    const takeProfitCount = (exits || []).filter(t => t.exit_reason === 'take_profit').length;
    const forecastExitCount = (exits || []).filter(t => t.exit_reason === 'forecast_shift').length;

    // Bot B re-entries
    const { data: reentries } = await this.supabase
      .from('reentry_trades')
      .select('status, pnl');

    const reentryPnl = (reentries || []).filter(t => t.pnl).reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
    const reentryCount = (reentries || []).length;

    return {
      exitPnl,
      exitWins,
      exitLosses,
      takeProfitCount,
      forecastExitCount,
      reentryPnl,
      reentryCount,
      totalPnl: exitPnl + reentryPnl,
    };
  }
}

module.exports = { PositionManager };
