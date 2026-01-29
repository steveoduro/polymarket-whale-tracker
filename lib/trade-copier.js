/**
 * Trade Copier
 *
 * Monitors whale trades and copies them based on configured rules.
 * Supports multiple target wallets with per-whale market filters.
 */

const { PolymarketAPI } = require('./polymarket-api');
const { RiskManager } = require('./risk-manager');

// Target wallets to copy - each with their own market filters
const TARGET_WALLETS = [
  {
    address: '0xe00740bce98a594e26861838885ab310ec3b548c',
    username: 'distinct-baguette',
    markets: ['crypto'], // 15-min crypto up/down
  },
  {
    address: '0x38cc1d1f95d12039324809d8bb6ca6da6cbef88e',
    username: 'NoonienSoong',
    markets: ['weather'], // Weather markets
  },
  {
    address: '0x08cf0b0fec3d42d9920bb0dfbc49fde635088cbc',
    username: 'HondaCivic',
    markets: ['weather'], // Weather markets
  },
  {
    address: '0x2ec681d5cbf2ba6d1e8f0e87b2e6026b0bc438c8',
    username: 'micro88so8z',
    markets: ['crypto'], // BTC markets
  },
];

// Market filter patterns by category
const MARKET_FILTERS = {
  crypto: [
    /bitcoin\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
    /ethereum\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
    /solana\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
    /xrp\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
    /btc\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
    /eth\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
    /sol\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
  ],
  weather: [
    /temperature.*high/i,
    /temperature.*low/i,
    /weather/i,
    /rain/i,
    /snow/i,
    /degrees/i,
    /fahrenheit/i,
    /celsius/i,
  ],
};

class TradeCopier {
  constructor(config = {}) {
    this.supabase = config.supabase;
    this.targetWallets = config.targetWallets || TARGET_WALLETS;
    this.paperMode = config.paperMode ?? true;

    // Build address lookup map
    this.targetsByAddress = new Map();
    for (const target of this.targetWallets) {
      this.targetsByAddress.set(target.address.toLowerCase(), target);
    }

    // Initialize API and Risk Manager
    this.api = new PolymarketAPI({
      paperMode: this.paperMode,
      log: this.log.bind(this),
    });

    this.riskManager = new RiskManager({
      log: this.log.bind(this),
    });

    // Tracking
    this.processedTrades = new Set();
    this.isRunning = false;
    this.pollInterval = null;
    this.lastCheckTime = null;

    // Per-whale stats
    this.whaleStats = new Map();
    for (const target of this.targetWallets) {
      this.whaleStats.set(target.username, {
        tradesChecked: 0,
        tradesCopied: 0,
        tradesSkipped: 0,
      });
    }

    // Global stats
    this.stats = {
      tradesChecked: 0,
      tradesMatched: 0,
      tradesCopied: 0,
      tradesSkipped: 0,
      errors: 0,
    };

    // Custom logging function
    this.logFn = config.log || console.log;
  }

  /**
   * Structured logging
   */
  log(level, message, data = {}) {
    if (typeof this.logFn === 'function') {
      this.logFn(level, `[TradeCopier] ${message}`, data);
    } else {
      const prefix = { info: '[INFO]', warn: '[WARN]', error: '[ERROR]' }[level] || `[${level.toUpperCase()}]`;
      console.log(`${prefix} [TradeCopier] ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
    }
  }

  /**
   * Check if a market matches the given filter categories
   */
  matchesMarketFilter(marketQuestion, filterCategories) {
    if (!marketQuestion || !filterCategories) return false;

    for (const category of filterCategories) {
      const patterns = MARKET_FILTERS[category];
      if (patterns) {
        for (const pattern of patterns) {
          if (pattern.test(marketQuestion)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Get target whale config by address
   */
  getTargetByAddress(address) {
    return this.targetsByAddress.get(address.toLowerCase());
  }

  /**
   * Initialize the copier
   */
  async initialize() {
    this.log('info', 'Initializing Trade Copier...', {
      paperMode: this.paperMode,
      targets: this.targetWallets.map(t => t.username),
    });

    // Initialize API (will fail gracefully if no credentials)
    try {
      await this.api.initialize();
    } catch (err) {
      if (this.paperMode) {
        this.log('warn', 'API not initialized (paper mode - OK to continue)', { error: err.message });
      } else {
        throw err;
      }
    }

    // Load risk state from database
    if (this.supabase) {
      await this.riskManager.loadState(this.supabase);
    }

    this.log('info', 'Trade Copier initialized', {
      targets: this.targetWallets.map(t => `${t.username} (${t.markets.join(',')})`),
      paperMode: this.paperMode,
    });
  }

  /**
   * Process a whale trade (called when tracker detects a new trade)
   */
  async processTrade(trade, wallet) {
    this.stats.tradesChecked++;

    // Check if this wallet is one of our targets
    const target = this.getTargetByAddress(wallet.address);
    if (!target) {
      return { copied: false, reason: 'Not a target wallet' };
    }

    // Update per-whale stats
    const whaleStats = this.whaleStats.get(target.username);
    if (whaleStats) whaleStats.tradesChecked++;

    // Skip if already processed
    const tradeKey = trade.polymarket_trade_id || trade.id;
    if (this.processedTrades.has(tradeKey)) {
      return { copied: false, reason: 'Already processed' };
    }
    this.processedTrades.add(tradeKey);

    this.log('info', 'Processing whale trade', {
      whale: target.username,
      market: trade.market_question?.slice(0, 50),
      side: trade.side,
      outcome: trade.outcome,
      size: trade.size,
      price: trade.price,
    });

    // Check market filter for this whale
    if (!this.matchesMarketFilter(trade.market_question, target.markets)) {
      this.stats.tradesSkipped++;
      if (whaleStats) whaleStats.tradesSkipped++;
      this.log('info', 'Skipping - market does not match whale filter', {
        whale: target.username,
        allowedMarkets: target.markets,
        market: trade.market_question?.slice(0, 80)
      });
      return { copied: false, reason: 'Market filter' };
    }

    this.stats.tradesMatched++;

    // Get current balance (use mock $50 in paper mode)
    let balance = { balance: 50 };
    if (!this.paperMode && this.api.initialized) {
      try {
        balance = await this.api.getBalance();
      } catch (err) {
        this.log('warn', 'Could not get balance, using default', { error: err.message });
      }
    } else if (this.paperMode) {
      this.log('info', 'Paper mode: using mock balance of $50');
    }

    // Check risk rules
    const riskCheck = this.riskManager.canTrade({
      currentBalance: balance.balance,
      whaleTrade: trade,
      marketSlug: trade.market_slug,
    });

    if (!riskCheck.allowed) {
      this.stats.tradesSkipped++;
      if (whaleStats) whaleStats.tradesSkipped++;
      this.log('info', 'Skipping - risk check failed', {
        reason: riskCheck.reason,
        rule: riskCheck.rule,
      });
      await this.recordMyTrade(trade, target, 'skipped', riskCheck.reason);
      return { copied: false, reason: riskCheck.reason };
    }

    // Execute copy trade
    try {
      const result = await this.executeCopyTrade(trade);
      this.stats.tradesCopied++;
      if (whaleStats) whaleStats.tradesCopied++;

      // Record trade for risk tracking
      this.riskManager.recordTrade({
        marketSlug: trade.market_slug,
        size: this.riskManager.getTradeSize(),
        side: trade.side,
      });

      // Save to database with whale info
      await this.recordMyTrade(trade, target, this.paperMode ? 'paper' : 'pending', null, result);

      // Save risk state
      if (this.supabase) {
        await this.riskManager.saveState(this.supabase);
      }

      return { copied: true, whale: target.username, result };
    } catch (err) {
      this.stats.errors++;
      this.log('error', 'Failed to copy trade', { error: err.message });
      await this.recordMyTrade(trade, target, 'failed', err.message);
      return { copied: false, reason: err.message };
    }
  }

  /**
   * Execute the actual copy trade
   */
  async executeCopyTrade(whaleTrade) {
    const tradeSize = this.riskManager.getTradeSize();

    // Get market info for token IDs
    const market = await this.api.getMarket(whaleTrade.market_slug);
    if (!market) {
      throw new Error(`Market not found: ${whaleTrade.market_slug}`);
    }

    const tokenIds = await this.api.getMarketTokenIds(market);
    if (!tokenIds) {
      throw new Error('Could not get token IDs for market');
    }

    // Determine which token to trade based on outcome
    const outcome = (whaleTrade.outcome || '').toUpperCase();
    const tokenId = outcome === 'YES' ? tokenIds.yes : tokenIds.no;

    if (!tokenId) {
      throw new Error(`No token ID for outcome: ${outcome}`);
    }

    // Calculate size in outcome tokens
    const price = parseFloat(whaleTrade.price) || 0.5;
    const sizeInTokens = tradeSize / price;

    this.log('info', 'Executing copy trade', {
      market: whaleTrade.market_question?.slice(0, 50),
      side: whaleTrade.side,
      outcome: whaleTrade.outcome,
      price: price,
      sizeUsdc: tradeSize,
      sizeTokens: sizeInTokens.toFixed(2),
      tokenId: tokenId?.slice(0, 20) + '...',
      paperMode: this.paperMode,
    });

    // Place order
    const result = await this.api.placeOrder({
      tokenId: tokenId,
      price: price,
      size: sizeInTokens,
      side: whaleTrade.side,
    });

    return result;
  }

  /**
   * Record our copy trade in the database
   */
  async recordMyTrade(whaleTrade, target, status, errorMessage = null, orderResult = null) {
    if (!this.supabase) return;

    try {
      const record = {
        copied_from_trade_id: whaleTrade.id || null,
        copied_from_whale: target.username,
        copied_from_address: target.address,
        market_slug: whaleTrade.market_slug,
        market_question: whaleTrade.market_question,
        side: whaleTrade.side,
        outcome: whaleTrade.outcome,
        size: this.riskManager.getTradeSize(),
        price: whaleTrade.price,
        status: status,
        error_message: errorMessage,
        polymarket_order_id: orderResult?.id || (orderResult?.paper ? 'PAPER' : null),
      };

      if (status === 'filled' || status === 'paper') {
        record.filled_at = new Date().toISOString();
      }

      const { error } = await this.supabase
        .from('my_trades')
        .insert(record);

      if (error) {
        this.log('warn', 'Failed to record trade', { error: error.message });
      } else {
        this.log('info', 'Trade recorded in database', { status, whale: target.username });
      }
    } catch (err) {
      this.log('warn', 'Error recording trade', { error: err.message });
    }
  }

  /**
   * Poll for new trades (standalone mode)
   */
  async pollForTrades() {
    if (!this.supabase) {
      throw new Error('Supabase client required for polling');
    }

    try {
      // Get all target wallets from database
      const targetAddresses = this.targetWallets.map(t => t.address.toLowerCase());

      const { data: wallets } = await this.supabase
        .from('tracked_wallets')
        .select('*')
        .in('address', targetAddresses);

      if (!wallets || wallets.length === 0) {
        this.log('warn', 'No target wallets found in tracked_wallets. Add them first.');
        return;
      }

      // Get recent trades since last check for all target wallets
      let query = this.supabase
        .from('trades')
        .select('*, tracked_wallets(address, username)')
        .in('wallet_id', wallets.map(w => w.id))
        .order('timestamp', { ascending: false })
        .limit(50);

      if (this.lastCheckTime) {
        query = query.gt('created_at', this.lastCheckTime);
      }

      const { data: trades, error } = await query;

      if (error) throw error;

      this.lastCheckTime = new Date().toISOString();

      if (trades && trades.length > 0) {
        this.log('info', `Found ${trades.length} trades to check`);

        for (const trade of trades) {
          const wallet = trade.tracked_wallets || wallets.find(w => w.id === trade.wallet_id);
          if (wallet) {
            await this.processTrade(trade, wallet);
          }
        }
      }
    } catch (err) {
      this.log('error', 'Poll error', { error: err.message });
    }
  }

  /**
   * Start continuous polling
   */
  startPolling(intervalMs = 10000) {
    if (this.isRunning) {
      this.log('warn', 'Already running');
      return;
    }

    this.isRunning = true;
    this.log('info', 'Starting trade copier polling', { intervalMs });

    // Initial poll
    this.pollForTrades();

    // Set up interval
    this.pollInterval = setInterval(() => {
      this.pollForTrades();
    }, intervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isRunning = false;
    this.log('info', 'Trade copier stopped');
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      paperMode: this.paperMode,
      lastCheckTime: this.lastCheckTime,
      processedCount: this.processedTrades.size,
      riskStatus: this.riskManager.getStatus(),
      whaleStats: Object.fromEntries(this.whaleStats),
    };
  }
}

module.exports = { TradeCopier, TARGET_WALLETS, MARKET_FILTERS };
