/**
 * Risk Manager
 *
 * Enforces trading limits and risk rules for the copy trading bot.
 */

class RiskManager {
  constructor(config = {}) {
    // Trade size limits
    this.tradeSize = parseFloat(config.tradeSize || process.env.COPY_TRADE_SIZE) || 1.50;
    this.minWhaleSize = parseFloat(config.minWhaleSize || process.env.MIN_WHALE_SIZE) || 10;
    this.maxPositionPerMarket = parseFloat(config.maxPositionPerMarket || process.env.MAX_POSITION_PER_MARKET) || 5;

    // Account limits
    this.minBalanceToTrade = parseFloat(config.minBalanceToTrade || process.env.MIN_BALANCE_TO_TRADE) || 10;
    this.dailyLossLimit = parseFloat(config.dailyLossLimit || process.env.DAILY_LOSS_LIMIT) || 15;

    // State tracking
    this.marketExposure = new Map(); // market_slug -> total exposure
    this.dailyPnL = 0;
    this.dailyTradeCount = 0;
    this.lastResetDate = this.getTodayDate();

    // Logging
    this.log = config.log || console.log;
  }

  /**
   * Get today's date as YYYY-MM-DD
   */
  getTodayDate() {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Reset daily counters if it's a new day
   */
  checkDailyReset() {
    const today = this.getTodayDate();
    if (today !== this.lastResetDate) {
      this.log('info', 'Daily reset triggered', {
        oldDate: this.lastResetDate,
        newDate: today,
        finalPnL: this.dailyPnL,
        totalTrades: this.dailyTradeCount
      });
      this.dailyPnL = 0;
      this.dailyTradeCount = 0;
      this.marketExposure.clear();
      this.lastResetDate = today;
    }
  }

  /**
   * Check if we can trade based on all risk rules
   * Returns { allowed: boolean, reason?: string }
   */
  canTrade({ currentBalance, whaleTrade, marketSlug }) {
    this.checkDailyReset();

    // Rule 1: Minimum balance
    if (currentBalance < this.minBalanceToTrade) {
      return {
        allowed: false,
        reason: `Balance ($${currentBalance.toFixed(2)}) below minimum ($${this.minBalanceToTrade})`,
        rule: 'MIN_BALANCE',
      };
    }

    // Rule 2: Daily loss limit
    if (this.dailyPnL <= -this.dailyLossLimit) {
      return {
        allowed: false,
        reason: `Daily loss limit reached ($${Math.abs(this.dailyPnL).toFixed(2)} lost, limit: $${this.dailyLossLimit})`,
        rule: 'DAILY_LOSS_LIMIT',
      };
    }

    // Rule 3: Whale trade minimum size
    const whaleSize = parseFloat(whaleTrade?.size) || 0;
    if (whaleSize < this.minWhaleSize) {
      return {
        allowed: false,
        reason: `Whale trade too small ($${whaleSize.toFixed(2)}, minimum: $${this.minWhaleSize})`,
        rule: 'MIN_WHALE_SIZE',
      };
    }

    // Rule 4: Max position per market
    const currentExposure = this.marketExposure.get(marketSlug) || 0;
    if (currentExposure + this.tradeSize > this.maxPositionPerMarket) {
      return {
        allowed: false,
        reason: `Max exposure for market reached ($${currentExposure.toFixed(2)} + $${this.tradeSize} > $${this.maxPositionPerMarket})`,
        rule: 'MAX_MARKET_EXPOSURE',
      };
    }

    // Rule 5: Have enough balance for this trade
    if (currentBalance < this.tradeSize) {
      return {
        allowed: false,
        reason: `Insufficient balance for trade ($${currentBalance.toFixed(2)} < $${this.tradeSize})`,
        rule: 'INSUFFICIENT_BALANCE',
      };
    }

    return { allowed: true };
  }

  /**
   * Calculate the size we should trade
   */
  getTradeSize() {
    return this.tradeSize;
  }

  /**
   * Record a trade for tracking purposes
   */
  recordTrade({ marketSlug, size, side }) {
    this.checkDailyReset();

    const tradeSize = parseFloat(size) || 0;

    // Update market exposure
    const currentExposure = this.marketExposure.get(marketSlug) || 0;
    this.marketExposure.set(marketSlug, currentExposure + tradeSize);

    // Update daily counter
    this.dailyTradeCount++;

    this.log('info', 'Trade recorded for risk tracking', {
      marketSlug,
      size: tradeSize,
      side,
      newExposure: this.marketExposure.get(marketSlug),
      dailyTradeCount: this.dailyTradeCount,
    });
  }

  /**
   * Record P&L for a resolved position
   */
  recordPnL(amount) {
    this.checkDailyReset();
    this.dailyPnL += amount;
    this.log('info', 'P&L recorded', { amount, dailyPnL: this.dailyPnL });
  }

  /**
   * Get current risk status
   */
  getStatus() {
    this.checkDailyReset();

    return {
      tradeSize: this.tradeSize,
      minWhaleSize: this.minWhaleSize,
      maxPositionPerMarket: this.maxPositionPerMarket,
      minBalanceToTrade: this.minBalanceToTrade,
      dailyLossLimit: this.dailyLossLimit,
      currentDailyPnL: this.dailyPnL,
      dailyTradeCount: this.dailyTradeCount,
      marketExposure: Object.fromEntries(this.marketExposure),
      lastResetDate: this.lastResetDate,
    };
  }

  /**
   * Load state from database (for persistence across restarts)
   */
  async loadState(supabase) {
    try {
      const today = this.getTodayDate();

      // Load today's stats
      const { data } = await supabase
        .from('daily_stats')
        .select('*')
        .eq('date', today)
        .single();

      if (data) {
        this.dailyPnL = parseFloat(data.realized_pnl) || 0;
        this.dailyTradeCount = data.trades_count || 0;
        this.log('info', 'Risk state loaded from database', {
          date: today,
          pnl: this.dailyPnL,
          trades: this.dailyTradeCount
        });
      }

      // Load today's market exposure from my_trades
      const { data: trades } = await supabase
        .from('my_trades')
        .select('market_slug, size')
        .gte('created_at', `${today}T00:00:00Z`)
        .in('status', ['pending', 'filled']);

      if (trades) {
        for (const trade of trades) {
          const current = this.marketExposure.get(trade.market_slug) || 0;
          this.marketExposure.set(trade.market_slug, current + parseFloat(trade.size));
        }
        this.log('info', 'Market exposure loaded', {
          markets: this.marketExposure.size
        });
      }
    } catch (err) {
      this.log('warn', 'Failed to load risk state', { error: err.message });
    }
  }

  /**
   * Save state to database
   */
  async saveState(supabase) {
    try {
      const today = this.getTodayDate();

      await supabase
        .from('daily_stats')
        .upsert({
          date: today,
          trades_count: this.dailyTradeCount,
          realized_pnl: this.dailyPnL,
          updated_at: new Date().toISOString(),
        });

      this.log('info', 'Risk state saved to database');
    } catch (err) {
      this.log('warn', 'Failed to save risk state', { error: err.message });
    }
  }
}

module.exports = { RiskManager };
