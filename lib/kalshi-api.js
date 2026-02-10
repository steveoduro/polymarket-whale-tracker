/**
 * Kalshi API Client
 *
 * Fetches weather market data from Kalshi's public API.
 * Trading requires authentication with API key + RSA private key.
 *
 * API Docs: https://trading-api.readme.io/reference/
 * Base URL (prod): https://api.elections.kalshi.com/trade-api/v2
 * Base URL (demo): https://demo-api.elections.kalshi.com/trade-api/v2
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const KALSHI_API_PROD = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_API_DEMO = 'https://demo-api.elections.kalshi.com/trade-api/v2';

/**
 * Make HTTPS request using Node's built-in https module
 * More reliable than fetch for some APIs
 */
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'WeatherBot/1.0',
        ...options.headers,
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 100)}`));
          }
        } else {
          const error = new Error(`HTTP ${res.statusCode}: ${res.statusMessage} - ${data}`);
          error.status = res.statusCode;
          error.body = data;
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    // Write body if provided
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// Known weather series tickers (discovered via API)
// Format: KXHIGH{CITY} for highest temperature
const WEATHER_SERIES = {
  // Cities overlapping with Polymarket
  nyc: { series: 'KXHIGHNY', displayName: 'NYC' },
  chicago: { series: 'KXHIGHCHI', displayName: 'Chicago' },
  miami: { series: 'KXHIGHMIA', displayName: 'Miami' },
  seattle: { series: 'KXHIGHTSEA', displayName: 'Seattle' },
  atlanta: { series: 'KXHIGHTATL', displayName: 'Atlanta' },  // Renamed from KXHIGHATL (2026-02)

  // Kalshi-only cities
  denver: { series: 'KXHIGHDEN', displayName: 'Denver' },
  houston: { series: 'KXHIGHOU', displayName: 'Houston' },
  'los angeles': { series: 'KXHIGHLAX', displayName: 'Los Angeles' },
  philadelphia: { series: 'KXHIGHPHIL', displayName: 'Philadelphia' },
  dc: { series: 'KXHIGHTDC', displayName: 'Washington DC' },
  'las vegas': { series: 'KXHIGHTLV', displayName: 'Las Vegas' },
  'new orleans': { series: 'KXHIGHTNOLA', displayName: 'New Orleans' },
  'san francisco': { series: 'KXHIGHTSFO', displayName: 'San Francisco' },
  austin: { series: 'KXHIGHAUS', displayName: 'Austin' },
  boston: { series: 'KXHIGHTBOS', displayName: 'Boston' },
  phoenix: { series: 'KXHIGHTPHX', displayName: 'Phoenix' },
  minneapolis: { series: 'KXHIGHTMIN', displayName: 'Minneapolis' },
};

// Cities that overlap with Polymarket (for comparison/arbitrage)
const OVERLAP_CITIES = ['nyc', 'chicago', 'miami', 'seattle', 'atlanta'];

class KalshiAPI {
  constructor(config = {}) {
    this.baseUrl = config.demo ? KALSHI_API_DEMO : KALSHI_API_PROD;
    this.log = config.log || console.log;
    this.cache = new Map();
    this.cacheExpiry = config.cacheExpiry || 60000; // 1 minute cache

    // Authentication for trading
    this.apiKeyId = config.apiKeyId || null;
    this.privateKeyPath = config.privateKeyPath || null;
    this.privateKey = null;

    // Load private key if path provided
    if (this.privateKeyPath && fs.existsSync(this.privateKeyPath)) {
      try {
        this.privateKey = fs.readFileSync(this.privateKeyPath, 'utf8');
        this.log('info', 'Kalshi private key loaded successfully');
      } catch (err) {
        this.log('warn', 'Failed to load Kalshi private key', { error: err.message });
      }
    }

    // Rate limiting
    this.requestQueue = [];
    this.activeRequests = 0;
    this.maxRequestsPerSecond = config.maxRequestsPerSecond || 8;
    this.lastRequestTime = 0;

    // Stats
    this.stats = {
      requestCount: 0,
      errors: 0,
      lastError: null,
    };
  }

  /**
   * Check if trading is enabled (has credentials)
   */
  isTradingEnabled() {
    return !!(this.apiKeyId && this.privateKey);
  }

  /**
   * Generate authentication headers for signed requests
   * Kalshi uses RSA-SHA256 signature: sign(timestamp + method + path)
   */
  generateAuthHeaders(method, path) {
    if (!this.isTradingEnabled()) {
      throw new Error('Kalshi trading not configured - missing API key or private key');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method.toUpperCase() + path;

    // Sign with RSA-SHA256
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    const signature = sign.sign(this.privateKey, 'base64');

    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
  }

  /**
   * Make a rate-limited API request
   */
  async request(endpoint, options = {}) {
    // Simple rate limiting - ensure at least 125ms between requests (8/sec)
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minDelay = 1000 / this.maxRequestsPerSecond;

    if (timeSinceLastRequest < minDelay) {
      await new Promise(r => setTimeout(r, minDelay - timeSinceLastRequest));
    }

    this.lastRequestTime = Date.now();
    this.stats.requestCount++;

    const url = `${this.baseUrl}${endpoint}`;

    try {
      const data = await httpsRequest(url, options);
      return data;
    } catch (err) {
      this.stats.errors++;

      // Better error messages
      if (err.message === 'Request timeout') {
        this.stats.lastError = `Request timeout: ${url}`;
      } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        this.stats.lastError = `DNS resolution failed for Kalshi API`;
      } else if (err.code === 'ECONNREFUSED') {
        this.stats.lastError = `Connection refused by Kalshi API (may be geo-blocked)`;
      } else {
        this.stats.lastError = err.message;
      }

      throw err;
    }
  }

  /**
   * Get all open markets for a weather series
   * @param {string} seriesTicker - e.g., 'KXHIGHNY'
   */
  async getMarketsForSeries(seriesTicker, status = 'open') {
    const cacheKey = `markets_${seriesTicker}_${status}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheExpiry) {
      return cached.data;
    }

    try {
      const data = await this.request(`/markets?series_ticker=${seriesTicker}&status=${status}&limit=100`);
      const markets = data.markets || [];

      this.cache.set(cacheKey, { data: markets, time: Date.now() });
      return markets;
    } catch (err) {
      this.log('warn', `Failed to fetch Kalshi markets for ${seriesTicker}`, { error: err.message });
      return [];
    }
  }

  /**
   * Get all active weather temperature markets
   */
  async getActiveTemperatureMarkets() {
    const cacheKey = 'all_temperature_markets';
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheExpiry) {
      return cached.data;
    }

    const allMarkets = [];

    for (const [city, info] of Object.entries(WEATHER_SERIES)) {
      try {
        const markets = await this.getMarketsForSeries(info.series);

        // Group by event (date)
        const eventGroups = this.groupMarketsByEvent(markets, city, info);
        allMarkets.push(...eventGroups);

      } catch (err) {
        this.log('warn', `Failed to fetch Kalshi ${city} markets`, { error: err.message });
      }

      // Small delay between series to be nice to API
      await new Promise(r => setTimeout(r, 50));
    }

    this.cache.set(cacheKey, { data: allMarkets, time: Date.now() });
    this.log('info', `Kalshi: Found ${allMarkets.length} temperature market events`);

    return allMarkets;
  }

  /**
   * Group individual binary markets into event-level objects
   * Each Kalshi event (e.g., KXHIGHNY-26FEB03) has multiple outcome markets
   */
  groupMarketsByEvent(markets, city, cityInfo) {
    // Group by event_ticker
    const eventMap = new Map();

    for (const market of markets) {
      const eventTicker = market.event_ticker;
      if (!eventMap.has(eventTicker)) {
        eventMap.set(eventTicker, {
          eventTicker,
          markets: [],
          city,
          cityInfo,
        });
      }
      eventMap.get(eventTicker).markets.push(market);
    }

    // Convert each event group to our normalized format
    const events = [];
    for (const [eventTicker, group] of eventMap) {
      const parsed = this.parseEventGroup(group);
      if (parsed) {
        events.push(parsed);
      }
    }

    return events;
  }

  /**
   * Parse a group of Kalshi markets for the same event into our format
   */
  parseEventGroup(group) {
    const { eventTicker, markets, city, cityInfo } = group;

    if (markets.length === 0) return null;

    // Extract date from event ticker (e.g., KXHIGHNY-26FEB03 -> Feb 3, 2026)
    const dateMatch = eventTicker.match(/(\d{2})([A-Z]{3})(\d{2})$/);
    if (!dateMatch) {
      this.log('warn', `Could not parse date from Kalshi event: ${eventTicker}`);
      return null;
    }

    const [, yearShort, monthStr, day] = dateMatch;
    const year = 2000 + parseInt(yearShort);
    const monthMap = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
    };
    const month = monthMap[monthStr];
    const date = new Date(year, month, parseInt(day));
    const dateStr = date.toISOString().split('T')[0];

    // Parse each market into a range outcome
    const ranges = markets.map(market => this.parseMarketToRange(market)).filter(r => r !== null);

    if (ranges.length === 0) return null;

    // Calculate total probability and other stats
    const totalProb = ranges.reduce((sum, r) => sum + r.price, 0);
    const avgSpread = ranges.reduce((sum, r) => sum + (r.spread || 0), 0) / ranges.length;
    const hasLiquidity = avgSpread < 0.10; // Kalshi typically has tighter spreads

    // Sample market for metadata
    const sample = markets[0];

    return {
      platform: 'kalshi',
      id: eventTicker,
      slug: eventTicker, // Use event ticker as slug equivalent
      question: sample.title?.replace(/\*\*/g, '') || `Highest temperature in ${cityInfo.displayName} on ${dateStr}`,
      city: city,
      date: date,
      dateStr: dateStr,
      unit: 'F', // Kalshi US markets are Fahrenheit
      ranges: ranges,
      totalProbability: totalProb,
      mispricingPct: Math.round((1 - totalProb) * 10000) / 100,
      avgSpread: avgSpread,
      hasLiquidity: hasLiquidity,
      volume: markets.reduce((sum, m) => sum + (m.volume || 0), 0),
      liquidity: markets.reduce((sum, m) => sum + (m.liquidity || 0), 0),
      closeTime: sample.close_time,
      closed: sample.status !== 'active',
      resolved: !!sample.result,
      resolutionSource: 'NWS', // National Weather Service

      // Kalshi-specific
      eventTicker: eventTicker,
      seriesTicker: cityInfo.series,
      feeType: 'quadratic',
      estimatedFee: 0.012, // ~1.2% average
    };
  }

  /**
   * Parse a single Kalshi market into our range format
   */
  parseMarketToRange(market) {
    try {
      // Prices are in cents, convert to decimals
      const yesBid = (market.yes_bid || 0) / 100;
      const yesAsk = (market.yes_ask || 0) / 100;
      const price = yesBid; // Use bid as price (what you'd get to sell/what's available)
      const spread = yesAsk - yesBid;

      // Parse range from strike_type
      let min, max;
      const floorStrike = market.floor_strike;
      const capStrike = market.cap_strike;

      if (market.strike_type === 'greater') {
        // "38° or above"
        min = floorStrike + 1;
        max = Infinity;
      } else if (market.strike_type === 'less') {
        // "29° or below"
        min = -Infinity;
        max = capStrike - 1;
      } else if (market.strike_type === 'between') {
        // "36° to 37°"
        min = floorStrike;
        max = capStrike;
      } else {
        return null;
      }

      return {
        name: market.subtitle || market.yes_sub_title || `${min}-${max}°F`,
        price: price,
        bestBid: yesBid,
        bestAsk: yesAsk,
        spread: spread,
        tokenId: market.ticker, // Market ticker is the unique ID for trading
        marketId: market.ticker,
        volume: market.volume || 0,
        liquidity: (market.liquidity || 0) / 100, // Convert from cents
        openInterest: market.open_interest || 0,
        min: min,
        max: max,

        // Kalshi-specific
        strikeType: market.strike_type,
        floorStrike: floorStrike,
        capStrike: capStrike,
      };
    } catch (err) {
      this.log('warn', 'Failed to parse Kalshi market', { ticker: market.ticker, error: err.message });
      return null;
    }
  }

  /**
   * Get markets for overlap cities only (for comparison with Polymarket)
   */
  async getOverlapCityMarkets() {
    const markets = await this.getActiveTemperatureMarkets();
    return markets.filter(m => OVERLAP_CITIES.includes(m.city));
  }

  /**
   * Discover all available weather series from Kalshi
   * Useful for finding new cities/markets
   */
  async discoverWeatherSeries() {
    try {
      const data = await this.request('/series?limit=500');
      const series = data.series || [];

      const weatherSeries = series.filter(s =>
        s.category?.toLowerCase() === 'weather' ||
        s.title?.toLowerCase().includes('temperature') ||
        s.title?.toLowerCase().includes('precipitation') ||
        s.ticker?.includes('HIGH') ||
        s.ticker?.includes('TEMP') ||
        s.ticker?.includes('PRECIP')
      );

      this.log('info', `Discovered ${weatherSeries.length} Kalshi weather series`, {
        tickers: weatherSeries.map(s => s.ticker)
      });

      return weatherSeries;
    } catch (err) {
      this.log('error', 'Failed to discover Kalshi series', { error: err.message });
      return [];
    }
  }

  /**
   * Make an authenticated API request (for trading endpoints)
   */
  async authenticatedRequest(method, endpoint, body = null) {
    if (!this.isTradingEnabled()) {
      throw new Error('Kalshi trading not configured - missing API key or private key');
    }

    // Rate limiting
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minDelay = 1000 / this.maxRequestsPerSecond;

    if (timeSinceLastRequest < minDelay) {
      await new Promise(r => setTimeout(r, minDelay - timeSinceLastRequest));
    }

    this.lastRequestTime = Date.now();
    this.stats.requestCount++;

    const url = `${this.baseUrl}${endpoint}`;
    const path = `/trade-api/v2${endpoint}`;

    try {
      const authHeaders = this.generateAuthHeaders(method, path);
      const options = {
        method,
        headers: authHeaders,
      };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const data = await httpsRequest(url, options);
      return data;
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err.message;
      throw err;
    }
  }

  // ============================================
  // TRADING METHODS (require authentication)
  // ============================================

  /**
   * Get account balance
   */
  async getBalance() {
    const data = await this.authenticatedRequest('GET', '/portfolio/balance');
    return {
      balance: (data.balance || 0) / 100, // Convert cents to dollars
      available: (data.payout || 0) / 100,
    };
  }

  /**
   * Get current positions
   */
  async getPositions() {
    const data = await this.authenticatedRequest('GET', '/portfolio/positions');
    return (data.market_positions || []).map(pos => ({
      ticker: pos.ticker,
      marketId: pos.market_ticker,
      position: pos.position, // positive = yes, negative = no
      avgPrice: (pos.market_exposure || 0) / Math.abs(pos.position || 1) / 100,
      totalCost: Math.abs(pos.market_exposure || 0) / 100,
      restingOrderCount: pos.resting_order_count || 0,
    }));
  }

  /**
   * Place an order on Kalshi
   * @param {string} ticker - Market ticker (e.g., 'KXHIGHNY-26FEB03-T38')
   * @param {string} side - 'yes' or 'no'
   * @param {number} count - Number of contracts
   * @param {number} limitPrice - Price in cents (1-99)
   * @param {string} type - 'market' or 'limit'
   */
  async placeOrder(ticker, side, count, limitPrice = null, type = 'limit') {
    const order = {
      ticker,
      action: 'buy',
      side,
      count,
      type,
    };

    if (type === 'limit' && limitPrice !== null) {
      order.yes_price = side === 'yes' ? limitPrice : null;
      order.no_price = side === 'no' ? limitPrice : null;
    }

    this.log('info', 'Placing Kalshi order', order);

    const data = await this.authenticatedRequest('POST', '/portfolio/orders', order);

    return {
      orderId: data.order?.order_id,
      ticker: data.order?.ticker,
      side: data.order?.side,
      count: data.order?.count,
      price: (data.order?.yes_price || data.order?.no_price || 0) / 100,
      status: data.order?.status,
      filledCount: data.order?.filled_count || 0,
    };
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    await this.authenticatedRequest('DELETE', `/portfolio/orders/${orderId}`);
    return { success: true, orderId };
  }

  /**
   * Get order history
   */
  async getOrders(status = null) {
    let endpoint = '/portfolio/orders';
    if (status) {
      endpoint += `?status=${status}`;
    }
    const data = await this.authenticatedRequest('GET', endpoint);
    return data.orders || [];
  }

  /**
   * Get fills (executed trades)
   */
  async getFills(ticker = null) {
    let endpoint = '/portfolio/fills';
    if (ticker) {
      endpoint += `?ticker=${ticker}`;
    }
    const data = await this.authenticatedRequest('GET', endpoint);
    return data.fills || [];
  }

  /**
   * Get API stats
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset stats (call at start of each scan cycle)
   */
  resetStats() {
    this.stats = {
      requestCount: 0,
      errors: 0,
      lastError: null,
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }
}

module.exports = {
  KalshiAPI,
  WEATHER_SERIES,
  OVERLAP_CITIES,
  KALSHI_API_PROD,
  KALSHI_API_DEMO,
};
