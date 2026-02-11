/**
 * platform-adapter.js — Unified interface for Polymarket + Kalshi
 *
 * All platform-specific logic lives here. The rest of the bot is platform-agnostic.
 * Exposes: getMarkets, getPrice, getFeeRate, executeBuy, executeSell, getResolutionData
 */

const config = require('../config');
const crypto = require('crypto');
const https = require('https');

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Polymarket slug generation
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// Polymarket city slug mappings
const PM_CITY_SLUGS = {
  nyc: 'new-york-city', chicago: 'chicago', miami: 'miami', atlanta: 'atlanta',
  dallas: 'dallas', seattle: 'seattle', london: 'london', seoul: 'seoul',
  toronto: 'toronto', 'buenos aires': 'buenos-aires', ankara: 'ankara',
  wellington: 'wellington',
};

// Kalshi series tickers per city
const KALSHI_SERIES = {
  nyc: 'KXHIGHNY', chicago: 'KXHIGHCHI', miami: 'KXHIGHMIA',
  atlanta: 'KXHIGHATL', dallas: 'KXHIGHDAL', seattle: 'KXHIGHSEA',
  denver: 'KXHIGHDEN', austin: 'KXHIGHAUS', houston: 'KXHIGHHOU',
  philadelphia: 'KXHIGHPHL', dc: 'KXHIGHDCA', vegas: 'KXHIGHLAS',
  'new orleans': 'KXHIGHMSY', 'san francisco': 'KXHIGHSFO',
  'los angeles': 'KXHIGHLAX', phoenix: 'KXHIGHPHX', boston: 'KXHIGHBOS',
  toronto: 'KXHIGHTOR', 'buenos aires': 'KXHIGHEZE', ankara: 'KXHIGHANK',
  wellington: 'KXHIGHWLG', london: 'KXHIGHLHR', seoul: 'KXHIGHICN',
};

const KALSHI_MONTH_MAP = { 0: 'JAN', 1: 'FEB', 2: 'MAR', 3: 'APR', 4: 'MAY', 5: 'JUN',
  6: 'JUL', 7: 'AUG', 8: 'SEP', 9: 'OCT', 10: 'NOV', 11: 'DEC' };

class PlatformAdapter {
  constructor() {
    this.kalshiKey = config.platforms.kalshi.apiKey;
    this.kalshiPrivateKey = null;
    this.lastKalshiRequest = 0;
    this.fetchModule = null; // lazy-loaded
    // Cache Kalshi series data: key → { data, fetchedAt }
    this.kalshiCache = new Map();
    this.kalshiCacheTTL = 4 * 60 * 1000; // 4 minutes (shorter than 5m scan interval)

    // Load Kalshi private key if configured
    if (config.platforms.kalshi.enabled && config.platforms.kalshi.privateKeyPath) {
      try {
        const fs = require('fs');
        this.kalshiPrivateKey = fs.readFileSync(config.platforms.kalshi.privateKeyPath, 'utf8');
      } catch (err) {
        console.log(`[WARN] Kalshi private key not loaded: ${err.message}`);
      }
    }
  }

  async _fetch(url, opts = {}) {
    if (!this.fetchModule) {
      this.fetchModule = (await import('node-fetch')).default;
    }
    // 15s timeout to prevent hung cycles
    if (!opts.signal) {
      opts.signal = AbortSignal.timeout(15000);
    }
    return this.fetchModule(url, opts);
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const label = level === 'warn' ? '[WARN]' : '[INFO]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Get fee rate for a platform
   */
  getFeeRate(platform) {
    return config.platforms[platform]?.feeRate || 0;
  }

  // ══════════════════════════════════════════════════════════════════
  // UNIFIED INTERFACE
  // ══════════════════════════════════════════════════════════════════

  /**
   * Get all available markets for a city/date from all enabled platforms.
   * Returns normalized range objects.
   *
   * @param {string} city
   * @param {string} dateStr - YYYY-MM-DD
   * @returns {Array<{ platform, marketId, rangeName, rangeMin, rangeMax, rangeType, rangeUnit, bid, ask, spread, volume }>}
   */
  async getMarkets(city, dateStr) {
    const results = [];

    const [pmRanges, klRanges] = await Promise.all([
      config.platforms.polymarket.enabled ? this._getPolymarketRanges(city, dateStr) : [],
      config.platforms.kalshi.enabled ? this._getKalshiRanges(city, dateStr) : [],
    ]);

    results.push(...pmRanges, ...klRanges);
    return results;
  }

  /**
   * Get current price for a specific market/range.
   * @returns {{ bid, ask, spread, volume }}
   */
  async getPrice(platform, marketId) {
    if (platform === 'polymarket') {
      return this._getPolymarketPrice(marketId);
    } else if (platform === 'kalshi') {
      return this._getKalshiPrice(marketId);
    }
    return null;
  }

  /**
   * Simulate buying at the ask (paper mode).
   */
  async executeBuy(opportunity) {
    return {
      paper: true,
      platform: opportunity.platform,
      price: opportunity.ask,
      shares: opportunity.shares,
      cost: opportunity.ask * opportunity.shares,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Simulate selling at the bid (paper mode).
   */
  async executeSell(position) {
    const price = await this.getPrice(position.platform, position.marketId);
    if (!price) return null;
    return {
      paper: true,
      platform: position.platform,
      price: price.bid,
      shares: position.shares,
      revenue: price.bid * position.shares,
      timestamp: new Date().toISOString(),
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // POLYMARKET
  // ══════════════════════════════════════════════════════════════════

  async _getPolymarketRanges(city, dateStr) {
    const slug = this._pmSlug(city, dateStr);
    if (!slug) return [];

    try {
      const event = await this._pmFetchEvent(slug);
      if (!event || !event.markets) return [];

      const cityConfig = config.cities[city.toLowerCase()];
      const unit = cityConfig?.unit || 'F';

      return event.markets.map(m => {
        const rangeName = m.groupItemTitle || m.question || '';
        const parsed = this._parseRange(rangeName, unit);
        if (parsed.rangeMin === undefined && parsed.rangeMax === undefined) return null;

        const bid = parseFloat(m.bestBid) || 0;
        let ask = parseFloat(m.bestAsk) || 0;

        // Fallback to outcomePrices
        if (ask === 0 && m.outcomePrices) {
          try {
            const prices = JSON.parse(m.outcomePrices);
            ask = parseFloat(prices[0]) || 0;
          } catch {}
        }

        return {
          platform: 'polymarket',
          marketId: m.id || m.conditionId,
          tokenId: m.clobTokenIds?.[0] || null,
          rangeName,
          rangeMin: parsed.rangeMin,
          rangeMax: parsed.rangeMax,
          rangeType: (parsed.rangeMin == null || parsed.rangeMax == null) ? 'unbounded' : 'bounded',
          rangeUnit: unit,
          bid,
          ask,
          spread: ask - bid,
          volume: parseFloat(m.volume) || 0,
          liquidity: parseFloat(m.liquidity) || 0,
        };
      }).filter(Boolean);
    } catch (err) {
      this._log('warn', `Polymarket fetch failed for ${city} ${dateStr}`, { error: err.message });
      return [];
    }
  }

  _pmSlug(city, dateStr) {
    const slugCity = PM_CITY_SLUGS[city.toLowerCase()];
    if (!slugCity) return null;

    const d = new Date(dateStr + 'T12:00:00Z');
    const month = MONTH_NAMES[d.getUTCMonth()];
    const day = d.getUTCDate();
    const year = d.getUTCFullYear();

    return `highest-temperature-in-${slugCity}-on-${month}-${day}-${year}`;
  }

  async _pmFetchEvent(slug) {
    try {
      const resp = await this._fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`);
      if (!resp.ok) return null;
      const events = await resp.json();
      return events[0] || null;
    } catch {
      return null;
    }
  }

  async _getPolymarketPrice(marketId) {
    try {
      const resp = await this._fetch(`${GAMMA_API}/markets/${marketId}`);
      if (!resp.ok) return null;
      const m = await resp.json();
      return {
        bid: parseFloat(m.bestBid) || 0,
        ask: parseFloat(m.bestAsk) || 0,
        spread: (parseFloat(m.bestAsk) || 0) - (parseFloat(m.bestBid) || 0),
        volume: parseFloat(m.volume) || 0,
      };
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // KALSHI
  // ══════════════════════════════════════════════════════════════════

  async _getKalshiRanges(city, dateStr) {
    const series = KALSHI_SERIES[city.toLowerCase()];
    if (!series) return [];

    try {
      // Build event ticker: e.g., KXHIGHNY-26FEB12
      const d = new Date(dateStr + 'T12:00:00Z');
      const yearShort = String(d.getUTCFullYear()).slice(-2);
      const month = KALSHI_MONTH_MAP[d.getUTCMonth()];
      const day = String(d.getUTCDate()).padStart(2, '0');
      const eventTicker = `${series}-${yearShort}${month}${day}`;

      const markets = await this._klFetchMarkets(series);
      if (!markets || markets.length === 0) return [];

      // Filter to this event
      const eventMarkets = markets.filter(m => m.event_ticker === eventTicker);
      if (eventMarkets.length === 0) return [];

      return eventMarkets.map(m => {
        const yesBid = (m.yes_bid || 0) / 100;
        const yesAsk = (m.yes_ask || 0) / 100;
        const parsed = this._parseKalshiRange(m);
        if (!parsed) return null;

        return {
          platform: 'kalshi',
          marketId: m.ticker,
          tokenId: m.ticker,
          rangeName: m.subtitle || m.yes_sub_title || `${parsed.rangeMin}-${parsed.rangeMax}°F`,
          rangeMin: parsed.rangeMin,
          rangeMax: parsed.rangeMax,
          rangeType: (parsed.rangeMin == null || parsed.rangeMax == null) ? 'unbounded' : 'bounded',
          rangeUnit: 'F',  // Kalshi is always °F
          bid: yesBid,
          ask: yesAsk,
          spread: yesAsk - yesBid,
          volume: m.volume || 0,
          liquidity: (m.liquidity || 0) / 100,
        };
      }).filter(Boolean);
    } catch (err) {
      this._log('warn', `Kalshi fetch failed for ${city} ${dateStr}`, { error: err.message });
      return [];
    }
  }

  _parseKalshiRange(market) {
    const floor = market.floor_strike;
    const cap = market.cap_strike;

    if (market.strike_type === 'greater') {
      return { rangeMin: floor + 1, rangeMax: null };
    } else if (market.strike_type === 'less') {
      return { rangeMin: null, rangeMax: cap - 1 };
    } else if (market.strike_type === 'between') {
      return { rangeMin: floor, rangeMax: cap };
    }
    return null;
  }

  async _klFetchMarkets(seriesTicker) {
    // Check cache first — same series data is needed for all 16 dates
    const cached = this.kalshiCache.get(seriesTicker);
    if (cached && (Date.now() - cached.fetchedAt) < this.kalshiCacheTTL) {
      return cached.data;
    }

    const apiUrl = config.platforms.kalshi.apiUrl;
    const allMarkets = [];
    let cursor = null;

    try {
      // Paginate through all results (limit 200 per page)
      do {
        // Rate limit: 8 req/sec
        const now = Date.now();
        const elapsed = now - this.lastKalshiRequest;
        if (elapsed < 125) {
          await new Promise(r => setTimeout(r, 125 - elapsed));
        }
        this.lastKalshiRequest = Date.now();

        let url = `${apiUrl}/markets?series_ticker=${seriesTicker}&status=open&limit=200`;
        if (cursor) url += `&cursor=${cursor}`;

        const headers = this.kalshiKey && this.kalshiPrivateKey
          ? this._klAuthHeaders('GET', '/trade-api/v2/markets')
          : { 'Accept': 'application/json' };

        const resp = await this._fetch(url, { headers });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const data = await resp.json();
        const markets = data.markets || [];
        allMarkets.push(...markets);

        cursor = data.cursor || null;
      } while (cursor);

      // Cache for subsequent date lookups within this cycle
      this.kalshiCache.set(seriesTicker, { data: allMarkets, fetchedAt: Date.now() });

      return allMarkets;
    } catch (err) {
      this._log('warn', `Kalshi markets fetch failed`, { series: seriesTicker, error: err.message });
      return allMarkets.length > 0 ? allMarkets : []; // Return partial results if available
    }
  }

  _klAuthHeaders(method, path) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method.toUpperCase() + path;

    try {
      const sign = crypto.createSign('RSA-SHA256');
      sign.update(message);
      const signature = sign.sign(this.kalshiPrivateKey, 'base64');

      return {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': this.kalshiKey,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
      };
    } catch {
      return { 'Accept': 'application/json' };
    }
  }

  async _getKalshiPrice(ticker) {
    const apiUrl = config.platforms.kalshi.apiUrl;
    try {
      const now = Date.now();
      if (now - this.lastKalshiRequest < 125) {
        await new Promise(r => setTimeout(r, 125 - (now - this.lastKalshiRequest)));
      }
      this.lastKalshiRequest = Date.now();

      const resp = await this._fetch(`${apiUrl}/markets/${ticker}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!resp.ok) return null;

      const data = await resp.json();
      const m = data.market || data;
      return {
        bid: (m.yes_bid || 0) / 100,
        ask: (m.yes_ask || 0) / 100,
        spread: ((m.yes_ask || 0) - (m.yes_bid || 0)) / 100,
        volume: m.volume || 0,
      };
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // RANGE PARSING (Polymarket format)
  // ══════════════════════════════════════════════════════════════════

  _parseRange(rangeStr, unit) {
    // "≤17°F" / "below" / "or less" / "or below"
    if (/≤|below|or\s+(less|below)/i.test(rangeStr)) {
      const num = rangeStr.match(/-?[\d.]+/);
      if (num) return { rangeMin: null, rangeMax: parseFloat(num[0]) };
    }

    // "≥28°F" / "above" / "or higher" / "or more"
    if (/≥|higher|above|or\s+more/i.test(rangeStr)) {
      const num = rangeStr.match(/-?[\d.]+/);
      if (num) return { rangeMin: parseFloat(num[0]), rangeMax: null };
    }

    // "18-19°F" or "18–19°F" (hyphen or en-dash)
    const rangeMatch = rangeStr.match(/(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)/);
    if (rangeMatch) {
      return { rangeMin: parseFloat(rangeMatch[1]), rangeMax: parseFloat(rangeMatch[2]) };
    }

    // Single value "6°C"
    const single = rangeStr.match(/(-?[\d.]+)\s*°/);
    if (single) {
      const n = parseFloat(single[1]);
      return { rangeMin: n - 0.5, rangeMax: n + 0.5 };
    }

    return {};
  }
}

module.exports = PlatformAdapter;
