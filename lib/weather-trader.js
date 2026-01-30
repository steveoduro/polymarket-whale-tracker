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
    this.paperMode = config.paperMode ?? true;
    this.paperBankroll = config.paperBankroll || 1000;

    this.log = config.log || console.log;

    // In-memory state for paper trading
    this.paperBalance = this.paperBankroll;
    this.openPositions = [];
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

    // Check paper balance
    if (this.paperBalance < position.amount) {
      throw new Error(`Insufficient paper balance: $${this.paperBalance.toFixed(2)} < $${position.amount.toFixed(2)}`);
    }

    // Deduct from paper balance
    this.paperBalance -= position.amount;

    const trade = {
      id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      opportunityId: null,
      marketSlug: market.slug,
      city: market.city,
      targetDate: market.dateStr,
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
    };

    // Track in memory
    this.openPositions.push(trade);

    // Save to database
    if (this.supabase) {
      await this.savePaperTrade(trade, opportunity);
    }

    this.log('info', 'Paper trade executed', {
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
        const oppRecord = {
          market_slug: opportunity.market.slug,
          market_question: opportunity.market.question,
          city: opportunity.market.city,
          target_date: opportunity.market.dateStr,
          forecast_high_c: opportunity.forecast.highC,
          forecast_high_f: opportunity.forecast.highF,
          forecast_confidence: opportunity.confidence,
          ranges: JSON.stringify(opportunity.market.ranges.map(r => ({
            name: r.name,
            price: r.price,
          }))),
          total_probability: opportunity.totalProbability,
          mispricing_pct: opportunity.mispricingPct,
          recommended_range: opportunity.bestRange.name,
          recommended_price: opportunity.bestRange.price,
          expected_value: opportunity.expectedValue.evPerDollar,
          status: 'traded',
        };

        const { data: opp, error: oppErr } = await this.supabase
          .from('weather_opportunities')
          .upsert(oppRecord, { onConflict: 'market_slug,created_at::date' })
          .select('id')
          .single();

        if (!oppErr && opp) {
          opportunityId = opp.id;
        }
      }

      // Save trade
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
      // Get actual temperature
      const actual = await weatherApi.getHistoricalHigh(trade.city, trade.target_date);
      if (!actual) {
        this.log('warn', 'Could not get actual temp', { city: trade.city, date: trade.target_date });
        return null;
      }

      // Determine which range won
      // We need to get the market ranges to check
      const { data: opp } = await this.supabase
        .from('weather_opportunities')
        .select('ranges')
        .eq('market_slug', trade.market_slug)
        .single();

      let winningRange = null;
      let actualTemp = actual.highF; // Default to F

      // Determine unit from trade's range name
      if (trade.range_name.includes('°C')) {
        actualTemp = actual.highC;
      }

      if (opp && opp.ranges) {
        const ranges = JSON.parse(opp.ranges);
        // Find winning range (simplified - check if actual temp matches)
        for (const range of ranges) {
          if (this.tempMatchesRange(actualTemp, range.name)) {
            winningRange = range.name;
            break;
          }
        }
      }

      // Calculate P&L
      const won = trade.range_name === winningRange;
      let pnl;
      if (won) {
        // Shares pay out $1 each
        pnl = trade.shares - trade.cost;
      } else {
        // Lose entire cost
        pnl = -trade.cost;
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
        })
        .eq('id', trade.id);

      // Update paper balance
      if (won) {
        this.paperBalance += trade.shares; // Add payout
      }

      // Update daily stats
      await this.updateDailyStats(trade.target_date, pnl, won);

      this.log('info', 'Trade resolved', {
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
    } catch (err) {
      this.log('error', 'Trade resolution failed', { tradeId: trade.id, error: err.message });
      return null;
    }
  }

  /**
   * Check if temperature matches a range string
   */
  tempMatchesRange(temp, rangeStr) {
    // "X°C or below"
    if (/below/i.test(rangeStr)) {
      const num = parseFloat(rangeStr.match(/-?[\d.]+/)?.[0]);
      return !isNaN(num) && temp <= num;
    }

    // "X°C or higher/above"
    if (/higher|above/i.test(rangeStr)) {
      const num = parseFloat(rangeStr.match(/-?[\d.]+/)?.[0]);
      return !isNaN(num) && temp >= num;
    }

    // "X-Y" range
    const rangeMatch = rangeStr.match(/(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)/);
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1]);
      const max = parseFloat(rangeMatch[2]);
      return temp >= min && temp <= max;
    }

    // Single number "X°C" - means X-0.5 to X+0.5
    const single = rangeStr.match(/(-?[\d.]+)\s*°/);
    if (single) {
      const n = parseFloat(single[1]);
      return temp >= n - 0.5 && temp < n + 0.5;
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
