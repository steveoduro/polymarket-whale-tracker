/**
 * Trade Copier
 *
 * Monitors whale trades and copies them based on configured rules.
 * Integrates with the existing whale tracker's trade detection.
 */

const { PolymarketAPI } = require('./polymarket-api');
const { RiskManager } = require('./risk-manager');

// Target wallet to copy
const TARGET_WALLET = {
  address: '0xe00740bce98a594e26861838885ab310ec3b548c',
  username: 'distinct-baguette',
};

// Market filters - only copy trades on 15-min crypto markets
const CRYPTO_MARKET_PATTERNS = [
  /bitcoin\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
  /ethereum\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
  /solana\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
  /xrp\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
  /btc\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
  /eth\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
  /sol\s+up\s+or\s+down.*\d{1,2}:\d{2}/i,
];

class TradeCopier {
  constructor(config = {}) {
    this.supabase = config.supabase;
    this.targetWallet = config.targetWallet || TARGET_WALLET;
    this.paperMode = config.paperMode ?? true;

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

    // Stats
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
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: 'TradeCopier',
      message,
      ...data,
    };

    if (typeof this.logFn === 'function') {
      this.logFn(level, `[TradeCopier] ${message}`, data);
    } else {
      const prefix = { info: '[INFO]', warn: '[WARN]', error: '[ERROR]' }[level] || `[${level.toUpperCase()}]`;
      console.log(`${prefix} [TradeCopier] ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
    }
  }

  /**
   * Check if a market matches our crypto up/down filter
   */
  isCryptoUpDownMarket(marketQuestion) {
    if (!marketQuestion) return false;
    return CRYPTO_MARKET_PATTERNS.some(pattern => pattern.test(marketQuestion));
  }

  /**
   * Initialize the copier
   */
  async initialize() {
    this.log('info', 'Initializing Trade Copier...', { paperMode: this.paperMode });

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
      target: this.targetWallet.username,
      paperMode: this.paperMode,
      riskStatus: this.riskManager.getStatus(),
    });
  }

  /**
   * Process a whale trade (called when tracker detects a new trade)
   */
  async processTrade(trade, wallet) {
    this.stats.tradesChecked++;

    // Skip if not from target wallet
    if (wallet.address.toLowerCase() !== this.targetWallet.address.toLowerCase()) {
      return { copied: false, reason: 'Not target wallet' };
    }

    // Skip if already processed
    const tradeKey = trade.polymarket_trade_id || trade.id;
    if (this.processedTrades.has(tradeKey)) {
      return { copied: false, reason: 'Already processed' };
    }
    this.processedTrades.add(tradeKey);

    this.log('info', 'Processing whale trade', {
      wallet: wallet.username || wallet.address,
      market: trade.market_question?.slice(0, 50),
      side: trade.side,
      outcome: trade.outcome,
      size: trade.size,
      price: trade.price,
    });

    // Check market filter
    if (!this.isCryptoUpDownMarket(trade.market_question)) {
      this.stats.tradesSkipped++;
      this.log('info', 'Skipping - not a crypto up/down market', {
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
      this.log('info', 'Skipping - risk check failed', {
        reason: riskCheck.reason,
        rule: riskCheck.rule,
      });
      await this.recordMyTrade(trade, 'skipped', riskCheck.reason);
      return { copied: false, reason: riskCheck.reason };
    }

    // Execute copy trade
    try {
      const result = await this.executeCopyTrade(trade);
      this.stats.tradesCopied++;

      // Record trade for risk tracking
      this.riskManager.recordTrade({
        marketSlug: trade.market_slug,
        size: this.riskManager.getTradeSize(),
        side: trade.side,
      });

      // Save to database
      await this.recordMyTrade(trade, this.paperMode ? 'paper' : 'pending', null, result);

      // Save risk state
      if (this.supabase) {
        await this.riskManager.saveState(this.supabase);
      }

      return { copied: true, result };
    } catch (err) {
      this.stats.errors++;
      this.log('error', 'Failed to copy trade', { error: err.message });
      await this.recordMyTrade(trade, 'failed', err.message);
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
    // size in USDC / price = number of outcome tokens
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
  async recordMyTrade(whaleTrade, status, errorMessage = null, orderResult = null) {
    if (!this.supabase) return;

    try {
      const record = {
        copied_from_trade_id: whaleTrade.id || null,
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
        this.log('info', 'Trade recorded in database', { status });
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
      // Get target wallet from database
      const { data: wallet } = await this.supabase
        .from('tracked_wallets')
        .select('*')
        .ilike('address', this.targetWallet.address)
        .single();

      if (!wallet) {
        this.log('warn', 'Target wallet not found in tracked_wallets');
        return;
      }

      // Get recent trades since last check
      let query = this.supabase
        .from('trades')
        .select('*')
        .eq('wallet_id', wallet.id)
        .order('timestamp', { ascending: false })
        .limit(20);

      if (this.lastCheckTime) {
        query = query.gt('created_at', this.lastCheckTime);
      }

      const { data: trades, error } = await query;

      if (error) throw error;

      this.lastCheckTime = new Date().toISOString();

      if (trades && trades.length > 0) {
        this.log('info', `Found ${trades.length} trades to check`);

        for (const trade of trades) {
          await this.processTrade(trade, wallet);
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
    };
  }
}

module.exports = { TradeCopier, TARGET_WALLET, CRYPTO_MARKET_PATTERNS };
