/**
 * Polymarket Weather Market Scanner
 *
 * Finds and parses temperature markets from Polymarket.
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Month names for date parsing
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

class MarketScanner {
  constructor(config = {}) {
    this.log = config.log || console.log;
    this.cache = new Map();
    this.cacheExpiry = 60000; // 1 minute cache
  }

  /**
   * Fetch all active temperature markets from Polymarket
   */
  async getActiveTemperatureMarkets() {
    try {
      // Check cache
      const cached = this.cache.get('temperature_markets');
      if (cached && Date.now() - cached.time < this.cacheExpiry) {
        return cached.data;
      }

      const resp = await fetch(`${GAMMA_API}/markets?active=true&closed=false&limit=200`);
      if (!resp.ok) {
        throw new Error(`Gamma API error: ${resp.status}`);
      }

      const allMarkets = await resp.json();

      // Filter for temperature/weather markets
      const tempMarkets = allMarkets.filter(m => {
        const q = (m.question || '').toLowerCase();
        return (
          q.includes('temperature') ||
          q.includes('highest temp') ||
          q.includes('high temp') ||
          (q.includes('weather') && (q.includes('°c') || q.includes('°f')))
        );
      });

      // Parse each market
      const parsed = tempMarkets.map(m => this.parseMarket(m)).filter(Boolean);

      // Cache results
      this.cache.set('temperature_markets', { data: parsed, time: Date.now() });

      this.log('info', `Found ${parsed.length} temperature markets`);
      return parsed;
    } catch (err) {
      this.log('error', 'Failed to fetch markets', { error: err.message });
      return [];
    }
  }

  /**
   * Parse a market into structured data
   */
  parseMarket(market) {
    try {
      const question = market.question || '';
      const city = this.extractCity(question);
      const date = this.extractDate(question);
      const unit = this.extractUnit(question);
      const ranges = this.parseRanges(market.outcomes, market.outcomePrices, market.clobTokenIds);

      if (!city || !date || ranges.length === 0) {
        return null;
      }

      // Calculate total probability
      const totalProb = ranges.reduce((sum, r) => sum + r.price, 0);

      return {
        id: market.id,
        slug: market.slug,
        question: question,
        city: city,
        date: date,
        dateStr: date.toISOString().split('T')[0],
        unit: unit,
        ranges: ranges,
        totalProbability: totalProb,
        mispricingPct: Math.round((1 - totalProb) * 10000) / 100, // e.g., 4.5%
        volume: parseFloat(market.volume) || 0,
        endDate: market.endDate,
        closed: market.closed,
        resolved: market.resolved,
      };
    } catch (err) {
      this.log('warn', 'Failed to parse market', { slug: market.slug, error: err.message });
      return null;
    }
  }

  /**
   * Extract city name from question
   */
  extractCity(question) {
    const q = question.toLowerCase();

    // Common city patterns
    const cityPatterns = [
      { pattern: /in\s+london/i, city: 'london' },
      { pattern: /in\s+new\s+york/i, city: 'nyc' },
      { pattern: /in\s+nyc/i, city: 'nyc' },
      { pattern: /in\s+atlanta/i, city: 'atlanta' },
      { pattern: /in\s+miami/i, city: 'miami' },
      { pattern: /in\s+chicago/i, city: 'chicago' },
      { pattern: /in\s+dallas/i, city: 'dallas' },
      { pattern: /in\s+seattle/i, city: 'seattle' },
      { pattern: /in\s+toronto/i, city: 'toronto' },
      { pattern: /in\s+seoul/i, city: 'seoul' },
      { pattern: /in\s+buenos\s+aires/i, city: 'buenos aires' },
      { pattern: /in\s+ankara/i, city: 'ankara' },
      { pattern: /in\s+wellington/i, city: 'wellington' },
      { pattern: /in\s+denver/i, city: 'denver' },
      { pattern: /in\s+phoenix/i, city: 'phoenix' },
      { pattern: /in\s+los\s+angeles/i, city: 'los angeles' },
      { pattern: /in\s+la\b/i, city: 'los angeles' },
    ];

    for (const { pattern, city } of cityPatterns) {
      if (pattern.test(question)) {
        return city;
      }
    }

    return null;
  }

  /**
   * Extract date from question
   */
  extractDate(question) {
    // Pattern: "on January 31" or "January 31?"
    const match = question.match(/(\w+)\s+(\d{1,2})/i);
    if (!match) return null;

    const monthStr = match[1].toLowerCase();
    const day = parseInt(match[2]);

    const monthIdx = MONTH_NAMES.indexOf(monthStr);
    if (monthIdx === -1) return null;

    // Assume current year, but handle year boundary
    const now = new Date();
    let year = now.getFullYear();

    // If month is before current month, might be next year
    const testDate = new Date(year, monthIdx, day);
    if (testDate < now - 86400000 * 30) { // More than 30 days in past
      year++;
    }

    return new Date(year, monthIdx, day);
  }

  /**
   * Extract temperature unit from question
   */
  extractUnit(question) {
    if (question.includes('°F') || question.includes('°f')) return 'F';
    if (question.includes('°C') || question.includes('°c')) return 'C';

    // US cities default to F
    const usCities = ['nyc', 'new york', 'atlanta', 'miami', 'chicago', 'dallas', 'seattle', 'denver', 'phoenix', 'los angeles'];
    const q = question.toLowerCase();
    for (const city of usCities) {
      if (q.includes(city)) return 'F';
    }

    return 'C';
  }

  /**
   * Parse outcome ranges with prices and token IDs
   */
  parseRanges(outcomes, outcomePricesStr, tokenIds) {
    if (!outcomes || !outcomePricesStr) return [];

    let prices;
    try {
      prices = JSON.parse(outcomePricesStr);
    } catch {
      return [];
    }

    const tokens = tokenIds || [];

    return outcomes.map((outcome, i) => {
      const parsed = this.parseRange(outcome);
      return {
        name: outcome,
        price: parseFloat(prices[i]) || 0,
        tokenId: tokens[i] || null,
        ...parsed,
      };
    }).filter(r => r.min !== undefined);
  }

  /**
   * Parse a single range string into min/max bounds
   */
  parseRange(rangeStr) {
    // Handle "X°C or below" / "X°F or below"
    if (/below/i.test(rangeStr)) {
      const num = rangeStr.match(/-?[\d.]+/);
      if (num) {
        return { min: -Infinity, max: parseFloat(num[0]) };
      }
    }

    // Handle "X°C or higher" / "X°F or above"
    if (/higher|above/i.test(rangeStr)) {
      const num = rangeStr.match(/-?[\d.]+/);
      if (num) {
        return { min: parseFloat(num[0]), max: Infinity };
      }
    }

    // Handle "X-Y" range (e.g., "45-50°F")
    const rangeMatch = rangeStr.match(/(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)/);
    if (rangeMatch) {
      return {
        min: parseFloat(rangeMatch[1]),
        max: parseFloat(rangeMatch[2]),
      };
    }

    // Handle single number "X°C" or "X°F"
    const single = rangeStr.match(/(-?[\d.]+)\s*°/);
    if (single) {
      const n = parseFloat(single[1]);
      // Single degree means n-0.5 to n+0.5 (rounds to n)
      return { min: n - 0.5, max: n + 0.5 };
    }

    return {};
  }

  /**
   * Check if a temperature fits within a range
   */
  tempFitsRange(temp, range) {
    if (range.min === undefined || range.max === undefined) return false;
    return temp >= range.min && temp <= range.max;
  }

  /**
   * Find which range a temperature falls into
   */
  findWinningRange(temp, ranges) {
    for (const range of ranges) {
      if (this.tempFitsRange(temp, range)) {
        return range;
      }
    }
    return null;
  }

  /**
   * Get a specific market by slug
   */
  async getMarketBySlug(slug) {
    try {
      const resp = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
      if (!resp.ok) return null;

      const markets = await resp.json();
      if (markets.length === 0) return null;

      return this.parseMarket(markets[0]);
    } catch (err) {
      this.log('error', 'Failed to fetch market', { slug, error: err.message });
      return null;
    }
  }
}

module.exports = { MarketScanner };
