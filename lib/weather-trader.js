/**
 * Weather Trader
 *
 * Executes paper and live trades for weather opportunities.
 * Handles position tracking, resolution, and P&L calculation.
 */

class WeatherTrader {
  constructor(config = {}) {
    this.supabase = config.supabase;
    this.polymarketApi = config.polymarketApi;
    this.kalshiApi = config.kalshiApi || null;
    this.paperMode = config.paperMode ?? true;
    this.paperBankroll = config.paperBankroll || 1000;

    this.log = config.log || console.log;

    // In-memory state for paper trading
    this.paperBalance = this.paperBankroll;
    this.openPositions = [];
  }

  /**
   * Detect which platform a market is from
   */
  detectPlatform(market) {
    if (market.platform) return market.platform;
    if (market.eventTicker || market.seriesTicker) return 'kalshi';
    return 'polymarket';
  }

  /**
   * Execute trades for an opportunity
   *
   * @param {Object} opportunity - From MispricingDetector
   * @param {Array} positions - From generatePositions()
   */
  async executeTrades(opportunity, positions) {
    const results = [];

    for (const position of positions.positions) {
      try {
        const result = await this.executeSingleTrade(opportunity, position);
        results.push(result);
      } catch (err) {
        this.log('error', 'Trade execution failed', {
          range: position.range,
          error: err.message
        });
        results.push({
          success: false,
          error: err.message,
          position,
        });
      }
    }

    return results;
  }

  /**
   * Execute a single trade
   */
  async executeSingleTrade(opportunity, position) {
    const market = opportunity.market;

    if (this.paperMode) {
      // Paper trade - just record it
      return await this.executePaperTrade(opportunity, position);
    } else {
      // Live trade via Polymarket API
      return await this.executeLiveTrade(opportunity, position);
    }
  }

  /**
   * Execute paper trade
   */
  async executePaperTrade(opportunity, position) {
    const market = opportunity.market;
    const platform = this.detectPlatform(market);

    // Check paper balance
    if (this.paperBalance < position.amount) {
      throw new Error(`Insufficient paper balance: $${this.paperBalance.toFixed(2)} < $${position.amount.toFixed(2)}`);
    }

    // Deduct from paper balance
    this.paperBalance -= position.amount;

    // Handle both temperature and precipitation markets
    // For precipitation: use last day of month as target_date (for resolution timing)
    let targetDate = market.dateStr;
    if (!targetDate && market.type === 'precipitation') {
      const lastDay = new Date(market.year, market.monthIdx + 1, 0).getDate();
      targetDate = `${market.year}-${String(market.monthIdx + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }

    // Extract forecast data for trade record
    const forecast = opportunity.forecast || {};
    const forecastTempF = opportunity.forecastTemp && market.unit === 'F' ? opportunity.forecastTemp :
                          forecast.highF || null;
    const forecastTempC = opportunity.forecastTemp && market.unit === 'C' ? opportunity.forecastTemp :
                          forecast.highC || null;

    // Platform-specific fee rate
    const feeRate = platform === 'kalshi' ? 0.012 : 0.0315; // Kalshi ~1.2%, Polymarket 3.15%

    // Calculate days before resolution
    const resolveDate = new Date(targetDate + 'T00:00:00Z');
    const daysBeforeResolution = Math.ceil((resolveDate - new Date()) / (1000 * 60 * 60 * 24));

    const trade = {
      id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      opportunityId: null,
      marketSlug: market.slug,
      city: market.city,
      targetDate: targetDate,
      rangeName: position.range,
      side: position.side,
      shares: position.shares,
      entryPrice: position.price,
      cost: position.amount,
      status: 'open',
      paperMode: true,
      createdAt: new Date().toISOString(),
      // Strategy tracking
      strategy: opportunity.strategy || 'range_mispricing',
      forecastShiftF: opportunity.forecastShift?.shiftF || null,
      // Market type tracking
      marketType: opportunity.marketType || market.type || 'temperature',
      // Forecast data for post-trade analysis
      forecastTempF: forecastTempF,
      forecastTempC: forecastTempC,
      forecastConfidence: forecast.confidence || opportunity.confidence || null,
      // Hedge tracking
      isHedge: opportunity.isHedge || position.isHedge || false,
      hedgingPosition: opportunity.hedgingPosition || null,
      // Platform tracking
      platform: platform,
      platformMarketId: platform === 'kalshi' ? market.eventTicker : market.slug,
      feeRate: feeRate,
      resolutionSource: platform === 'kalshi' ? 'NWS' : 'Open-Meteo',
      // Analytics metrics at entry
      bidAtEntry: opportunity.bestRange?.bestBid || null,
      askAtEntry: opportunity.bestRange?.bestAsk || null,
      spreadAtEntry: opportunity.bestRange?.spread || null,
      liquidityAtEntry: opportunity.bestRange?.liquidity || market.liquidity || null,
      volumeAtEntry: opportunity.bestRange?.volume || null,
      forecastTempAtEntry: forecastTempF || forecastTempC || null,
      forecastConfidenceAtEntry: opportunity.confidence || forecast.confidence || null,
      edgeAtEntry: opportunity.edgePct || null,
      kellyFraction: position.kellyFraction || null,
      daysBeforeResolution: daysBeforeResolution,
      // Tolerance tracking
      toleranceDistanceC: null,
      tolerancePctUsed: null,
    };

    // Calculate tolerance metrics from forecast and range
    try {
      const fC = forecastTempC || (forecastTempF ? (forecastTempF - 32) * 5 / 9 : null);
      if (fC !== null && position.range) {
        const toC = (f) => (f - 32) * 5 / 9;
        const cleaned = position.range.replace(/Â/g, '');
        let rangeCenterC = null;
        if (cleaned.includes('°C')) {
          const nums = cleaned.match(/-?[\d.]+/g);
          if (nums) rangeCenterC = nums.length >= 2 ? (parseFloat(nums[0]) + parseFloat(nums[1])) / 2 : parseFloat(nums[0]);
        } else {
          const nums = cleaned.match(/-?[\d.]+/g);
          if (nums) rangeCenterC = nums.length >= 2 ? (toC(parseFloat(nums[0])) + toC(parseFloat(nums[1]))) / 2 : toC(parseFloat(nums[0]));
        }
        if (rangeCenterC !== null) {
          trade.toleranceDistanceC = parseFloat(Math.abs(fC - rangeCenterC).toFixed(4));
          trade.tolerancePctUsed = parseFloat(((trade.toleranceDistanceC / 0.5) * 100).toFixed(1));
        }
      }
    } catch (e) { /* tolerance calc is optional */ }

    // Track in memory
    this.openPositions.push(trade);

    // Save to database
    if (this.supabase) {
      await this.savePaperTrade(trade, opportunity);
    }

    const platformTag = platform === 'kalshi' ? '[KL]' : '[PM]';
    this.log('info', `${platformTag} Paper trade executed`, {
      platform: platform,
      city: market.city,
      date: market.dateStr,
      range: position.range,
      cost: position.amount,
      shares: position.shares,
      balance: this.paperBalance,
    });

    return {
      success: true,
      trade,
      paperBalance: this.paperBalance,
    };
  }

  /**
   * Execute live trade via Polymarket API
   */
  async executeLiveTrade(opportunity, position) {
    if (!this.polymarketApi) {
      throw new Error('Polymarket API not configured');
    }

    const result = await this.polymarketApi.placeOrder({
      tokenId: position.tokenId,
      price: position.price,
      size: position.shares,
      side: 'BUY',
    });

    const trade = {
      id: result.id || `live_${Date.now()}`,
      opportunityId: null,
      marketSlug: opportunity.market.slug,
      city: opportunity.market.city,
      targetDate: opportunity.market.dateStr,
      rangeName: position.range,
      side: position.side,
      shares: position.shares,
      entryPrice: position.price,
      cost: position.amount,
      status: 'pending',
      polymarketOrderId: result.id,
      paperMode: false,
      createdAt: new Date().toISOString(),
    };

    if (this.supabase) {
      await this.savePaperTrade(trade, opportunity);
    }

    this.log('info', 'Live trade executed', {
      orderId: result.id,
      city: opportunity.market.city,
      range: position.range,
      cost: position.amount,
    });

    return {
      success: true,
      trade,
      orderId: result.id,
    };
  }

  /**
   * Save trade to database
   */
  async savePaperTrade(trade, opportunity) {
    if (!this.supabase) return;

    try {
      // First save opportunity if not exists
      let opportunityId = null;
      if (opportunity) {
        const platform = opportunity.market.platform || 'polymarket';
        const feeRate = platform === 'kalshi' ? 0.012 : 0.0315;

        const oppRecord = {
          market_slug: opportunity.market.slug,
          market_question: opportunity.market.question,
          city: opportunity.market.city,
          target_date: opportunity.market.dateStr,
          forecast_high_c: opportunity.forecast?.highC || null,
          forecast_high_f: opportunity.forecast?.highF || null,
          forecast_confidence: opportunity.confidence || null,
          ranges: JSON.stringify(opportunity.market.ranges?.map(r => ({
            name: r.name,
            price: r.price,
          })) || []),
          total_probability: opportunity.totalProbability,
          mispricing_pct: opportunity.mispricingPct,
          recommended_range: opportunity.bestRange?.name || null,
          recommended_price: opportunity.bestRange?.price || null,
          expected_value: opportunity.expectedValue?.evPerDollar || null,
          fee_adjusted_ev: opportunity.expectedValue?.feeAdjustedEv || null,
          status: 'traded',
          platform: platform,
          platform_market_id: platform === 'kalshi' ? opportunity.market.eventTicker : opportunity.market.slug,
        };

        const { data: opp, error: oppErr } = await this.supabase
          .from('weather_opportunities')
          .upsert(oppRecord, { onConflict: 'market_slug,target_date' })
          .select('id')
          .single();

        if (oppErr) {
          this.log('warn', 'Failed to save opportunity', { error: oppErr.message });
        } else if (opp) {
          opportunityId = opp.id;
        }
      }

      // Save trade (including forecast, hedge, and platform info)
      const tradeRecord = {
        opportunity_id: opportunityId,
        market_slug: trade.marketSlug,
        city: trade.city,
        target_date: trade.targetDate,
        range_name: trade.rangeName,
        side: trade.side,
        shares: trade.shares,
        entry_price: trade.entryPrice,
        cost: trade.cost,
        status: trade.status,
        strategy: trade.strategy || 'range_mispricing',
        forecast_shift_f: trade.forecastShiftF || null,
        market_type: trade.marketType || 'temperature',
        // Forecast data for post-trade analysis
        forecast_temp_f: trade.forecastTempF || null,
        forecast_temp_c: trade.forecastTempC || null,
        forecast_confidence: trade.forecastConfidence || null,
        // Hedge tracking
        is_hedge: trade.isHedge || false,
        hedging_position: trade.hedgingPosition || null,
        // Platform tracking
        platform: trade.platform || 'polymarket',
        platform_market_id: trade.platformMarketId || trade.marketSlug,
        fee_rate: trade.feeRate || 0.0315,
        resolution_source: trade.resolutionSource || 'Open-Meteo',
        // Analytics metrics at entry
        bid_at_entry: trade.bidAtEntry || null,
        ask_at_entry: trade.askAtEntry || null,
        spread_at_entry: trade.spreadAtEntry || null,
        liquidity_at_entry: trade.liquidityAtEntry || null,
        forecast_temp_at_entry: trade.forecastTempAtEntry || null,
        forecast_confidence_at_entry: trade.forecastConfidenceAtEntry || null,
        edge_at_entry: trade.edgeAtEntry || null,
        kelly_fraction: trade.kellyFraction || null,
        entry_hour_utc: new Date().getUTCHours(),
        days_before_resolution: trade.daysBeforeResolution ?? null,
        tolerance_distance_c: trade.toleranceDistanceC ?? null,
        tolerance_pct_used: trade.tolerancePctUsed ?? null,
        entry_bid: trade.bidAtEntry || null,
        entry_ask: trade.askAtEntry || null,
        entry_spread: trade.spreadAtEntry || null,
        entry_volume: trade.volumeAtEntry || null,
      };

      const { error } = await this.supabase
        .from('weather_paper_trades')
        .insert(tradeRecord);

      if (error) {
        this.log('warn', 'Failed to save trade to DB', { error: error.message });
      }
    } catch (err) {
      this.log('warn', 'DB save error', { error: err.message });
    }
  }

  /**
   * Check and resolve open positions
   */
  async checkResolutions(weatherApi) {
    if (!this.supabase) return [];

    const resolved = [];

    try {
      // Get open trades with target_date < today
      const today = new Date().toISOString().split('T')[0];

      const { data: openTrades, error } = await this.supabase
        .from('weather_paper_trades')
        .select('*')
        .eq('status', 'open')
        .lt('target_date', today);

      if (error) throw error;
      if (!openTrades || openTrades.length === 0) return [];

      this.log('info', `Checking ${openTrades.length} trades for resolution`);

      for (const trade of openTrades) {
        const result = await this.resolveTrade(trade, weatherApi);
        if (result) {
          resolved.push(result);
        }
      }
    } catch (err) {
      this.log('error', 'Resolution check failed', { error: err.message });
    }

    return resolved;
  }

  /**
   * Resolve a single trade
   */
  async resolveTrade(trade, weatherApi) {
    try {
      // Check market type and route to appropriate resolution
      const marketType = trade.market_type || 'temperature';

      if (marketType === 'precipitation') {
        return await this.resolvePrecipitationTrade(trade, weatherApi);
      } else {
        return await this.resolveTemperatureTrade(trade, weatherApi);
      }
    } catch (err) {
      this.log('error', 'Trade resolution failed', { tradeId: trade.id, error: err.message });
      return null;
    }
  }

  /**
   * Resolve a temperature trade
   */
  async resolveTemperatureTrade(trade, weatherApi) {
    // Get actual temperature (uses Open-Meteo)
    const actual = await weatherApi.getHistoricalHigh(trade.city, trade.target_date);
    if (!actual) {
      this.log('warn', 'Could not get actual temp', { city: trade.city, date: trade.target_date });
      return null;
    }

    // Note: Kalshi uses NWS for resolution, we use Open-Meteo
    // There may be 1-2°F variance between sources
    const platform = trade.platform || 'polymarket';
    if (platform === 'kalshi') {
      this.log('info', 'Kalshi trade resolution uses Open-Meteo (Kalshi uses NWS - may differ by 1-2°F)', {
        city: trade.city,
        date: trade.target_date
      });
    }

    let actualTemp = actual.highF; // Default to Fahrenheit

    // Determine unit from trade's range name
    if (trade.range_name.includes('°C')) {
      actualTemp = actual.highC;
    }

    // Check directly if actual temp falls in our range
    const won = this.tempMatchesRange(actualTemp, trade.range_name);

    // Log resolution details for verification
    this.log('info', 'Resolution check', {
      city: trade.city,
      date: trade.target_date,
      platform: trade.platform,
      range: trade.range_name,
      actualTemp: actualTemp,
      result: won ? 'WON' : 'LOST',
      pnlImpact: won ? (trade.shares - trade.cost).toFixed(2) : (-trade.cost).toFixed(2)
    });

    // For logging purposes, show what range the temp fell in
    let winningRange = won ? trade.range_name : `Actual: ${actualTemp}`;

    // Calculate P&L
    let pnl;
    if (won) {
      // Shares pay out $1 each
      pnl = trade.shares - trade.cost;
    } else {
      // Lose entire cost
      pnl = -trade.cost;
    }

    // Get closing metrics (market is settled, so use settlement prices)
    // Closing price is 1.0 for winning range, 0.0 for losing range
    const closingPrice = won ? 1.0 : 0.0;

    // Get final forecast at close (will be close to actual since market resolved)
    let forecastAtClose = null;
    let forecastConfidenceAtClose = null;
    try {
      const closeForecast = await weatherApi.getForecastForDate(trade.city, trade.target_date);
      if (closeForecast) {
        forecastAtClose = trade.range_name.includes('°C') ? closeForecast.highC : closeForecast.highF;
        forecastConfidenceAtClose = closeForecast.confidence || null;
      }
    } catch (err) {
      // Non-critical - don't break resolution
      this.log('warn', 'Failed to get closing forecast', { error: err.message });
    }

    // Update database
    await this.supabase
      .from('weather_paper_trades')
      .update({
        actual_high_temp: actualTemp,
        winning_range: winningRange,
        pnl: pnl,
        status: won ? 'won' : 'lost',
        resolved_at: new Date().toISOString(),
        // Analytics metrics at close
        closing_price: closingPrice,
        forecast_temp_at_close: forecastAtClose,
        forecast_confidence_at_close: forecastConfidenceAtClose,
      })
      .eq('id', trade.id);

    // Update paper balance
    if (won) {
      this.paperBalance += trade.shares; // Add payout
    }

    // Update daily stats
    await this.updateDailyStats(trade.target_date, pnl, won);

    // Record forecast accuracy (always in Fahrenheit - forecast_history stores F)
    if (weatherApi && typeof weatherApi.recordForecastAccuracy === 'function') {
      await weatherApi.recordForecastAccuracy(
        this.supabase,
        trade.city,
        trade.target_date,
        actual.highF
      );
    }

    this.log('info', 'Temperature trade resolved', {
      city: trade.city,
      date: trade.target_date,
      ourRange: trade.range_name,
      actualTemp: actualTemp,
      winningRange: winningRange,
      result: won ? 'WON' : 'LOST',
      pnl: pnl.toFixed(2),
    });

    return {
      trade,
      actualTemp,
      winningRange,
      won,
      pnl,
    };
  }

  /**
   * Resolve a precipitation trade
   */
  async resolvePrecipitationTrade(trade, weatherApi) {
    // Parse month/year from target_date (format: YYYY-MM-DD where DD is last day of month)
    const dateParts = trade.target_date.split('-');
    const year = parseInt(dateParts[0]);
    const month = parseInt(dateParts[1]) - 1; // Convert to 0-indexed

    // Get actual precipitation for the month
    const actual = await weatherApi.getHistoricalPrecipitation(trade.city, month, year);
    if (!actual) {
      this.log('warn', 'Could not get actual precipitation', {
        city: trade.city,
        month: month + 1,
        year: year
      });
      return null;
    }

    const actualInches = actual.totalPrecipitationInches;

    // Check directly if actual precipitation falls in our range
    const won = this.precipMatchesRange(actualInches, trade.range_name);

    // For logging purposes, show what happened
    let winningRange = won ? trade.range_name : `Actual: ${actualInches}"`;
    let pnl;
    if (won) {
      pnl = trade.shares - trade.cost;
    } else {
      pnl = -trade.cost;
    }

    // Closing price is 1.0 for winning range, 0.0 for losing range
    const closingPrice = won ? 1.0 : 0.0;

    // Update database
    await this.supabase
      .from('weather_paper_trades')
      .update({
        actual_high_temp: actualInches, // Store precipitation in this field for now
        winning_range: winningRange,
        pnl: pnl,
        status: won ? 'won' : 'lost',
        resolved_at: new Date().toISOString(),
        // Analytics metrics at close
        closing_price: closingPrice,
      })
      .eq('id', trade.id);

    // Update paper balance
    if (won) {
      this.paperBalance += trade.shares;
    }

    // Update daily stats
    await this.updateDailyStats(trade.target_date, pnl, won);

    this.log('info', 'Precipitation trade resolved', {
      city: trade.city,
      month: month + 1,
      year: year,
      ourRange: trade.range_name,
      actualPrecipitation: actualInches + '"',
      winningRange: winningRange,
      result: won ? 'WON' : 'LOST',
      pnl: pnl.toFixed(2),
    });

    return {
      trade,
      actualPrecipitation: actualInches,
      winningRange,
      won,
      pnl,
    };
  }

  /**
   * Check if precipitation matches a range string
   * Handles formats like: "<3"", "3-4"", ">6""
   */
  precipMatchesRange(inches, rangeStr) {
    // "<X"" or "under X"
    if (/^<|under|less than/i.test(rangeStr)) {
      const num = parseFloat(rangeStr.match(/[\d.]+/)?.[0]);
      return !isNaN(num) && inches < num;
    }

    // ">X"" or "X or more" or "X+"
    if (/>|or more|\+|above|over/i.test(rangeStr)) {
      const num = parseFloat(rangeStr.match(/[\d.]+/)?.[0]);
      return !isNaN(num) && inches >= num;
    }

    // "X-Y" range
    const rangeMatch = rangeStr.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1]);
      const max = parseFloat(rangeMatch[2]);
      return inches >= min && inches < max;
    }

    return false;
  }

  /**
   * Check if temperature matches a range string
   */
  tempMatchesRange(temp, rangeStr) {
    // Clean up potential encoding issues (Â°C -> °C)
    const cleaned = rangeStr.replace(/Â/g, '');

    // "X°F or below" / "X°C or below"
    if (/below/i.test(cleaned)) {
      const num = parseFloat(cleaned.match(/-?[\d.]+/)?.[0]);
      return !isNaN(num) && temp <= num;
    }

    // "X°F or higher" / "X°C or above"
    if (/higher|above/i.test(cleaned)) {
      const num = parseFloat(cleaned.match(/-?[\d.]+/)?.[0]);
      return !isNaN(num) && temp >= num;
    }

    // "X-Y" range (e.g., "54-55°F", "24-25°F") - Polymarket format
    // OR "X° to Y°" range (e.g., "51° to 52°") - Kalshi format
    const rangeMatch = cleaned.match(/(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)/) ||  // hyphen/dash
                       cleaned.match(/(-?[\d.]+)°?\s+to\s+(-?[\d.]+)/);     // "to" word
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1]);
      const max = parseFloat(rangeMatch[2]);
      return temp >= min && temp <= max;  // Both bounds inclusive per Kalshi rules
    }

    // Single number "X°C" or "X°F" - Polymarket uses integer ranges
    // "0°C" means the actual temp rounds to 0 (i.e., Math.round(temp) === 0)
    const single = cleaned.match(/(-?[\d.]+)\s*°/);
    if (single) {
      const n = parseFloat(single[1]);
      return Math.round(temp) === n;
    }

    return false;
  }

  /**
   * Update daily stats
   */
  async updateDailyStats(date, pnl, won) {
    if (!this.supabase) return;

    try {
      const { data: existing } = await this.supabase
        .from('weather_daily_stats')
        .select('*')
        .eq('date', date)
        .single();

      if (existing) {
        await this.supabase
          .from('weather_daily_stats')
          .update({
            trades_won: existing.trades_won + (won ? 1 : 0),
            trades_lost: existing.trades_lost + (won ? 0 : 1),
            gross_pnl: existing.gross_pnl + pnl,
            updated_at: new Date().toISOString(),
          })
          .eq('date', date);
      } else {
        await this.supabase
          .from('weather_daily_stats')
          .insert({
            date,
            trades_won: won ? 1 : 0,
            trades_lost: won ? 0 : 1,
            gross_pnl: pnl,
          });
      }
    } catch (err) {
      this.log('warn', 'Failed to update daily stats', { error: err.message });
    }
  }

  /**
   * Check if we already have a position in this market
   */
  async hasExistingPosition(marketSlug) {
    if (!this.supabase) {
      return this.openPositions.some(p => p.marketSlug === marketSlug);
    }

    const { count } = await this.supabase
      .from('weather_paper_trades')
      .select('*', { count: 'exact', head: true })
      .eq('market_slug', marketSlug)
      .eq('status', 'open');

    return (count || 0) > 0;
  }

  /**
   * Get existing position details for a market (for hedging)
   */
  async getExistingPosition(marketSlug) {
    if (!this.supabase) {
      return this.openPositions.find(p => p.marketSlug === marketSlug) || null;
    }

    const { data } = await this.supabase
      .from('weather_paper_trades')
      .select('*')
      .eq('market_slug', marketSlug)
      .eq('status', 'open')
      .limit(1);

    return data && data.length > 0 ? data[0] : null;
  }

  /**
   * Get total capital deployed in open positions
   */
  async getDeployedCapital() {
    if (!this.supabase) {
      return this.openPositions.reduce((sum, p) => sum + (p.cost || 0), 0);
    }

    const { data, error } = await this.supabase
      .from('weather_paper_trades')
      .select('cost')
      .eq('status', 'open');

    if (error || !data) return 0;

    return data.reduce((sum, trade) => sum + parseFloat(trade.cost || 0), 0);
  }

  /**
   * Check if we already have a hedge for a specific position
   */
  async hasExistingHedge(marketSlug, originalRangeName) {
    if (!this.supabase) {
      return this.openPositions.some(p =>
        p.marketSlug === marketSlug &&
        p.isHedge &&
        p.hedgingPosition === originalRangeName
      );
    }

    const { data } = await this.supabase
      .from('weather_paper_trades')
      .select('id')
      .eq('market_slug', marketSlug)
      .eq('is_hedge', true)
      .eq('hedging_position', originalRangeName)
      .eq('status', 'open')
      .limit(1);

    return data && data.length > 0;
  }

  /**
   * Get open position count
   */
  async getOpenPositionCount() {
    if (!this.supabase) {
      return this.openPositions.length;
    }

    const { count } = await this.supabase
      .from('weather_paper_trades')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'open');

    return count || 0;
  }

  /**
   * Get total realized P&L from all resolved trades
   * Used to calculate current bankroll for position sizing
   */
  async getTotalRealizedPnl() {
    if (!this.supabase) {
      // In-memory: sum pnl from resolved positions (not typically tracked)
      return 0;
    }

    const { data, error } = await this.supabase
      .from('weather_paper_trades')
      .select('pnl')
      .in('status', ['won', 'lost', 'exited']);

    if (error || !data) return 0;

    return data.reduce((sum, trade) => sum + (parseFloat(trade.pnl) || 0), 0);
  }

  /**
   * Get trading stats
   */
  async getStats() {
    if (!this.supabase) {
      return {
        paperBalance: this.paperBalance,
        openPositions: this.openPositions.length,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        winRate: 'N/A',
      };
    }

    const { data: trades } = await this.supabase
      .from('weather_paper_trades')
      .select('status, pnl, cost');

    if (!trades) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        pending: 0,
        totalPnL: 0,
        winRate: 'N/A',
      };
    }

    const wins = trades.filter(t => t.status === 'won').length;
    const losses = trades.filter(t => t.status === 'lost').length;
    const pending = trades.filter(t => t.status === 'open').length;
    const totalPnL = trades.reduce((sum, t) => sum + (parseFloat(t.pnl) || 0), 0);
    const totalCost = trades.reduce((sum, t) => sum + (parseFloat(t.cost) || 0), 0);

    return {
      totalTrades: trades.length,
      wins,
      losses,
      pending,
      totalPnL,
      totalCost,
      winRate: wins + losses > 0 ? `${((wins / (wins + losses)) * 100).toFixed(1)}%` : 'N/A',
      roi: totalCost > 0 ? `${((totalPnL / totalCost) * 100).toFixed(1)}%` : 'N/A',
      paperBalance: this.paperBalance,
    };
  }
}

module.exports = { WeatherTrader };
