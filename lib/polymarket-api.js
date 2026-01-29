/**
 * Polymarket CLOB API Wrapper
 *
 * Handles authentication, order placement, and market data queries.
 * Requires: @polymarket/clob-client and ethers
 */

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CHAIN_ID = 137; // Polygon

// Signature types for different wallet types
const SignatureType = {
  EOA: 0,           // Standard MetaMask wallet
  POLY_PROXY: 1,    // Magic Link / Google login
  GNOSIS_SAFE: 2,   // Multisig
};

class PolymarketAPI {
  constructor(config = {}) {
    this.privateKey = config.privateKey || process.env.WALLET_PRIVATE_KEY;
    this.funderAddress = config.funderAddress || process.env.WALLET_ADDRESS;
    this.signatureType = config.signatureType ?? SignatureType.EOA;

    this.client = null;
    this.apiCreds = null;
    this.initialized = false;

    // Paper trading mode (default: true for safety)
    this.paperMode = config.paperMode ?? true;

    // Logging
    this.log = config.log || console.log;
  }

  /**
   * Initialize the CLOB client with API credentials
   */
  async initialize() {
    if (this.initialized) return;

    if (!this.privateKey) {
      throw new Error('WALLET_PRIVATE_KEY is required');
    }

    try {
      // Dynamic import for ES modules compatibility
      const { ClobClient } = await import('@polymarket/clob-client');
      const { Wallet } = await import('ethers');

      const signer = new Wallet(this.privateKey);
      this.walletAddress = signer.address;

      // Step 1: Create temp client to derive API credentials
      const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);

      this.log('info', 'Deriving API credentials from wallet...');
      this.apiCreds = await tempClient.createOrDeriveApiKey();

      // Step 2: Create full client with credentials
      this.client = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        signer,
        this.apiCreds,
        this.signatureType,
        this.funderAddress || this.walletAddress
      );

      this.initialized = true;
      this.log('info', 'Polymarket API initialized', {
        wallet: this.walletAddress,
        paperMode: this.paperMode
      });

      return true;
    } catch (err) {
      this.log('error', 'Failed to initialize Polymarket API', { error: err.message });
      throw err;
    }
  }

  /**
   * Get market information by slug or condition ID
   */
  async getMarket(slugOrConditionId) {
    try {
      const resp = await fetch(`${GAMMA_HOST}/markets?slug=${encodeURIComponent(slugOrConditionId)}`);
      if (!resp.ok) {
        // Try by condition ID
        const resp2 = await fetch(`${GAMMA_HOST}/markets?condition_id=${slugOrConditionId}`);
        if (!resp2.ok) throw new Error(`Market not found: ${slugOrConditionId}`);
        const markets = await resp2.json();
        return markets[0] || null;
      }
      const markets = await resp.json();
      return markets[0] || null;
    } catch (err) {
      this.log('error', 'Failed to get market', { slug: slugOrConditionId, error: err.message });
      return null;
    }
  }

  /**
   * Get market by searching for question text (for crypto up/down markets)
   */
  async findMarketByQuestion(questionPattern) {
    try {
      // Search active markets
      const resp = await fetch(`${GAMMA_HOST}/markets?active=true&limit=100`);
      if (!resp.ok) throw new Error('Failed to fetch markets');

      const markets = await resp.json();

      // Find matching market
      const match = markets.find(m =>
        m.question && m.question.toLowerCase().includes(questionPattern.toLowerCase())
      );

      return match || null;
    } catch (err) {
      this.log('error', 'Failed to find market', { pattern: questionPattern, error: err.message });
      return null;
    }
  }

  /**
   * Get token IDs for a market's outcomes
   * Returns { yes: tokenId, no: tokenId }
   */
  async getMarketTokenIds(market) {
    if (!market) return null;

    // Token IDs are in clobTokenIds array: [yesTokenId, noTokenId]
    if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
      return {
        yes: market.clobTokenIds[0],
        no: market.clobTokenIds[1],
      };
    }

    // Fallback: try to get from tokens array
    if (market.tokens && market.tokens.length >= 2) {
      return {
        yes: market.tokens.find(t => t.outcome === 'Yes')?.token_id,
        no: market.tokens.find(t => t.outcome === 'No')?.token_id,
      };
    }

    return null;
  }

  /**
   * Get current prices for a market
   */
  async getMarketPrices(market) {
    if (!market) return null;

    try {
      // Prices are in outcomePrices as strings
      if (market.outcomePrices) {
        const prices = JSON.parse(market.outcomePrices);
        return {
          yes: parseFloat(prices[0]),
          no: parseFloat(prices[1]),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get wallet balance (USDC)
   */
  async getBalance() {
    if (!this.initialized) await this.initialize();

    try {
      const balance = await this.client.getBalanceAllowance({
        asset_type: 'COLLATERAL',
      });
      return {
        balance: parseFloat(balance.balance) || 0,
        allowance: parseFloat(balance.allowance) || 0,
      };
    } catch (err) {
      this.log('error', 'Failed to get balance', { error: err.message });
      return { balance: 0, allowance: 0 };
    }
  }

  /**
   * Place a limit order
   *
   * @param {Object} params
   * @param {string} params.tokenId - ERC1155 token ID
   * @param {number} params.price - Price (0.01 to 0.99)
   * @param {number} params.size - Size in outcome tokens
   * @param {string} params.side - 'BUY' or 'SELL'
   * @returns {Object} Order result or paper trade log
   */
  async placeOrder({ tokenId, price, size, side }) {
    if (!this.initialized) await this.initialize();

    const orderParams = {
      tokenID: tokenId,
      price: price,
      size: size,
      side: side,
    };

    // Paper trading mode - just log what would happen
    if (this.paperMode) {
      this.log('info', '[PAPER] Would place order', orderParams);
      return {
        paper: true,
        wouldPlace: orderParams,
        timestamp: new Date().toISOString(),
      };
    }

    // Live trading
    try {
      const result = await this.client.createAndPostOrder(orderParams);
      this.log('info', 'Order placed', { orderId: result.id, ...orderParams });
      return result;
    } catch (err) {
      this.log('error', 'Failed to place order', { error: err.message, ...orderParams });
      throw err;
    }
  }

  /**
   * Place a market order (immediate execution)
   */
  async placeMarketOrder({ tokenId, size, side }) {
    if (!this.initialized) await this.initialize();

    const orderParams = {
      tokenID: tokenId,
      size: size,
      side: side,
    };

    if (this.paperMode) {
      this.log('info', '[PAPER] Would place market order', orderParams);
      return {
        paper: true,
        wouldPlace: { ...orderParams, type: 'MARKET' },
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const result = await this.client.createAndPostMarketOrder(orderParams);
      this.log('info', 'Market order placed', { orderId: result.id, ...orderParams });
      return result;
    } catch (err) {
      this.log('error', 'Failed to place market order', { error: err.message, ...orderParams });
      throw err;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    if (!this.initialized) await this.initialize();

    if (this.paperMode) {
      this.log('info', '[PAPER] Would cancel order', { orderId });
      return { paper: true, cancelled: orderId };
    }

    try {
      await this.client.cancelOrder(orderId);
      this.log('info', 'Order cancelled', { orderId });
      return { cancelled: orderId };
    } catch (err) {
      this.log('error', 'Failed to cancel order', { orderId, error: err.message });
      throw err;
    }
  }

  /**
   * Get open orders
   */
  async getOpenOrders() {
    if (!this.initialized) await this.initialize();

    try {
      return await this.client.getOpenOrders();
    } catch (err) {
      this.log('error', 'Failed to get open orders', { error: err.message });
      return [];
    }
  }

  /**
   * Get order by ID
   */
  async getOrder(orderId) {
    if (!this.initialized) await this.initialize();

    try {
      return await this.client.getOrder(orderId);
    } catch (err) {
      this.log('error', 'Failed to get order', { orderId, error: err.message });
      return null;
    }
  }
}

module.exports = { PolymarketAPI, SignatureType, CLOB_HOST, GAMMA_HOST, CHAIN_ID };
