/**
 * Resolution Tracker
 *
 * Monitors paper/pending trades and checks for market resolution.
 * Updates trades with resolved outcome and P&L.
 */

const GAMMA_HOST = 'https://gamma-api.polymarket.com';

class ResolutionTracker {
  constructor(config = {}) {
    this.supabase = config.supabase;
    this.pollIntervalMs = config.pollIntervalMs || 60000; // Check every minute
    this.pollInterval = null;
    this.isRunning = false;

    // Cache of market resolutions to avoid repeated API calls
    this.resolvedMarkets = new Map();

    // Stats
    this.stats = {
      checksPerformed: 0,
      tradesResolved: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
    };

    this.log = config.log || console.log;
  }

  /**
   * Fetch market data from Gamma API
   */
  async getMarketBySlug(slug) {
    // Check cache first
    if (this.resolvedMarkets.has(slug)) {
      return this.resolvedMarkets.get(slug);
    }

    try {
      const resp = await fetch(`${GAMMA_HOST}/markets?slug=${encodeURIComponent(slug)}`);
      if (!resp.ok) return null;

      const markets = await resp.json();
      const market = markets[0] || null;

      // Cache if resolved
      if (market && (market.closed || market.resolved)) {
        this.resolvedMarkets.set(slug, market);
      }

      return market;
    } catch (err) {
      this.log('warn', 'Failed to fetch market', { slug, error: err.message });
      return null;
    }
  }

  /**
   * Determine the winning outcome from market data
   * Returns 'Yes', 'No', or null if not resolved
   */
  getWinningOutcome(market) {
    if (!market) return null;

    // Check if market is resolved
    if (!market.closed && !market.resolved) {
      return null;
    }

    // Method 1: Check resolutionSource or resolvedBy
    if (market.outcome) {
      return market.outcome;
    }

    // Method 2: Check outcome prices (winner = 1.00, loser = 0.00)
    if (market.outcomePrices) {
      try {
        const prices = JSON.parse(market.outcomePrices);
        const yesPrice = parseFloat(prices[0]);
        const noPrice = parseFloat(prices[1]);

        if (yesPrice >= 0.99) return 'Yes';
        if (noPrice >= 0.99) return 'No';
      } catch {}
    }

    // Method 3: Check tokens array for winner
    if (market.tokens) {
      for (const token of market.tokens) {
        if (token.winner === true) {
          return token.outcome; // 'Yes' or 'No'
        }
      }
    }

    return null;
  }

  /**
   * Calculate P&L for a trade given the resolution
   *
   * For a BUY trade:
   *   - If our outcome won: PnL = size * (1 - price) / price
   *     (we paid `price` per share, received $1 per share)
   *   - If our outcome lost: PnL = -size
   *     (we lose our entire stake)
   *
   * For a SELL trade:
   *   - If the outcome we sold won: PnL = -size * (1 - price) / price
   *     (we have to pay out)
   *   - If the outcome we sold lost: PnL = size
   *     (we keep the premium)
   */
  calculatePnL(trade, winningOutcome) {
    const size = parseFloat(trade.size) || 0;
    const price = parseFloat(trade.price) || 0.5;
    const ourOutcome = (trade.outcome || '').toLowerCase();
    const winner = (winningOutcome || '').toLowerCase();
    const side = (trade.side || '').toUpperCase();

    const ourOutcomeWon = ourOutcome === winner;

    if (side === 'BUY') {
      if (ourOutcomeWon) {
        // We bought shares at `price`, they're now worth $1 each
        // Profit = (1 - price) * numberOfShares
        // numberOfShares = size / price (since size is in USDC)
        const numShares = size / price;
        return numShares * (1 - price);
      } else {
        // We lose our stake
        return -size;
      }
    } else if (side === 'SELL') {
      if (ourOutcomeWon) {
        // We sold shares that won - we owe the payout
        const numShares = size / price;
        return -numShares * (1 - price);
      } else {
        // We sold shares that lost - we keep the premium
        return size;
      }
    }

    return 0;
  }

  /**
   * Check and update unresolved trades
   */
  async checkUnresolvedTrades() {
    if (!this.supabase) return;

    this.stats.checksPerformed++;

    try {
      // Get trades that need resolution checking
      const { data: trades, error } = await this.supabase
        .from('my_trades')
        .select('*')
        .in('status', ['paper', 'filled', 'pending'])
        .is('resolved_outcome', null)
        .order('created_at', { ascending: true })
        .limit(20);

      if (error) throw error;
      if (!trades || trades.length === 0) return;

      this.log('info', `Checking ${trades.length} trades for resolution`);

      for (const trade of trades) {
        await this.checkTradeResolution(trade);
      }
    } catch (err) {
      this.log('error', 'Resolution check failed', { error: err.message });
    }
  }

  /**
   * Check resolution for a single trade
   */
  async checkTradeResolution(trade) {
    if (!trade.market_slug) {
      this.log('warn', 'Trade missing market_slug', { tradeId: trade.id });
      return;
    }

    const market = await this.getMarketBySlug(trade.market_slug);
    if (!market) {
      this.log('warn', 'Market not found', { slug: trade.market_slug });
      return;
    }

    const winningOutcome = this.getWinningOutcome(market);
    if (!winningOutcome) {
      // Market not resolved yet
      return;
    }

    // Calculate P&L
    const pnl = this.calculatePnL(trade, winningOutcome);
    const ourOutcomeWon = (trade.outcome || '').toLowerCase() === winningOutcome.toLowerCase();

    this.log('info', 'Trade resolved', {
      market: trade.market_question?.slice(0, 50),
      ourOutcome: trade.outcome,
      winner: winningOutcome,
      result: ourOutcomeWon ? 'WIN' : 'LOSS',
      pnl: pnl.toFixed(2),
    });

    // Update trade in database
    try {
      const { error } = await this.supabase
        .from('my_trades')
        .update({
          resolved_outcome: winningOutcome,
          pnl: pnl,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', trade.id);

      if (error) throw error;

      // Update stats
      this.stats.tradesResolved++;
      this.stats.totalPnL += pnl;
      if (pnl > 0) {
        this.stats.wins++;
      } else if (pnl < 0) {
        this.stats.losses++;
      }

      // Update daily_stats
      await this.updateDailyStats(pnl);

    } catch (err) {
      this.log('error', 'Failed to update resolved trade', { tradeId: trade.id, error: err.message });
    }
  }

  /**
   * Update daily stats with realized P&L
   */
  async updateDailyStats(pnl) {
    if (!this.supabase) return;

    const today = new Date().toISOString().split('T')[0];

    try {
      // Get current stats
      const { data: existing } = await this.supabase
        .from('daily_stats')
        .select('*')
        .eq('date', today)
        .single();

      if (existing) {
        await this.supabase
          .from('daily_stats')
          .update({
            realized_pnl: (parseFloat(existing.realized_pnl) || 0) + pnl,
            updated_at: new Date().toISOString(),
          })
          .eq('date', today);
      } else {
        await this.supabase
          .from('daily_stats')
          .insert({
            date: today,
            realized_pnl: pnl,
          });
      }
    } catch (err) {
      this.log('warn', 'Failed to update daily stats', { error: err.message });
    }
  }

  /**
   * Start resolution tracking
   */
  start() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.log('info', 'Starting resolution tracker', { intervalMs: this.pollIntervalMs });

    // Initial check
    this.checkUnresolvedTrades();

    // Set up interval
    this.pollInterval = setInterval(() => {
      this.checkUnresolvedTrades();
    }, this.pollIntervalMs);
  }

  /**
   * Stop resolution tracking
   */
  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isRunning = false;
    this.log('info', 'Resolution tracker stopped');
  }

  /**
   * Get stats
   */
  getStats() {
    const winRate = this.stats.wins + this.stats.losses > 0
      ? ((this.stats.wins / (this.stats.wins + this.stats.losses)) * 100).toFixed(1)
      : 0;

    return {
      ...this.stats,
      winRate: `${winRate}%`,
      isRunning: this.isRunning,
      cachedMarkets: this.resolvedMarkets.size,
    };
  }
}

module.exports = { ResolutionTracker };
