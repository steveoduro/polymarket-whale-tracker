/**
 * Polymarket Weather Market Scanner
 *
 * Finds and parses temperature markets from Polymarket.
 *
 * IMPORTANT: The Gamma API filtering (tags, search) does NOT work for weather markets.
 * We must use direct slug queries: gamma-api.polymarket.com/events?slug={slug}
 *
 * Strategy:
 * 1. Generate expected slug patterns for cities + upcoming dates
 * 2. Query each slug directly via the Gamma API
 * 3. Parse the negRisk multi-outcome format
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Month names for slug generation and date parsing
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

// Cities with their slug format
// Slug format: "highest-temperature-in-{city}-on-{month}-{day}"
const WEATHER_CITIES = [
  { key: 'nyc', slugName: 'nyc', displayName: 'NYC' },
  { key: 'london', slugName: 'london', displayName: 'London' },
  { key: 'seoul', slugName: 'seoul', displayName: 'Seoul' },
  { key: 'dallas', slugName: 'dallas', displayName: 'Dallas' },
  { key: 'toronto', slugName: 'toronto', displayName: 'Toronto' },
  { key: 'miami', slugName: 'miami', displayName: 'Miami' },
  { key: 'buenos aires', slugName: 'buenos-aires', displayName: 'Buenos Aires' },
  { key: 'atlanta', slugName: 'atlanta', displayName: 'Atlanta' },
  { key: 'chicago', slugName: 'chicago', displayName: 'Chicago' },
  { key: 'seattle', slugName: 'seattle', displayName: 'Seattle' },
  { key: 'ankara', slugName: 'ankara', displayName: 'Ankara' },
  { key: 'wellington', slugName: 'wellington', displayName: 'Wellington' },
];

class MarketScanner {
  constructor(config = {}) {
    this.log = config.log || console.log;
    this.cache = new Map();
    this.cacheExpiry = 60000; // 1 minute cache
    this.daysAhead = config.daysAhead || 7; // How many days ahead to check
  }

  /**
   * Generate slug for a city and date
   * Example: "highest-temperature-in-nyc-on-january-31"
   */
  generateSlug(city, date) {
    const month = MONTH_NAMES[date.getMonth()];
    const day = date.getDate();
    return `highest-temperature-in-${city.slugName}-on-${month}-${day}`;
  }

  /**
   * Generate all expected slugs for upcoming dates
   */
  generateExpectedSlugs() {
    const slugs = [];
    const today = new Date();

    for (let i = 0; i <= this.daysAhead; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);

      for (const city of WEATHER_CITIES) {
        slugs.push({
          slug: this.generateSlug(city, date),
          city: city,
          date: date,
          dateStr: date.toISOString().split('T')[0],
        });
      }
    }

    return slugs;
  }

  /**
   * Fetch a single event by slug from Gamma API
   */
  async fetchEventBySlug(slug) {
    try {
      const resp = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`);
      if (!resp.ok) {
        return null;
      }

      const events = await resp.json();
      if (!events || events.length === 0) {
        return null;
      }

      return events[0];
    } catch (err) {
      this.log('warn', `Failed to fetch event: ${slug}`, { error: err.message });
      return null;
    }
  }

  /**
   * Fetch all active temperature markets from Polymarket
   * Uses direct slug queries since API filtering doesn't work for weather
   */
  async getActiveTemperatureMarkets() {
    try {
      // Check cache
      const cached = this.cache.get('temperature_markets');
      if (cached && Date.now() - cached.time < this.cacheExpiry) {
        return cached.data;
      }

      const expectedSlugs = this.generateExpectedSlugs();
      this.log('info', `Checking ${expectedSlugs.length} potential weather market slugs...`);

      const markets = [];
      let found = 0;
      let notFound = 0;

      // Query each slug (with rate limiting)
      for (const { slug, city, date, dateStr } of expectedSlugs) {
        const event = await this.fetchEventBySlug(slug);

        if (event) {
          found++;
          const parsed = this.parseEvent(event, city, date, dateStr);
          if (parsed) {
            markets.push(parsed);
          }
        } else {
          notFound++;
        }

        // Small delay to avoid rate limiting (50ms between requests)
        await new Promise(r => setTimeout(r, 50));
      }

      this.log('info', `Found ${found} weather markets (${notFound} slugs not found)`);

      // Cache results
      this.cache.set('temperature_markets', { data: markets, time: Date.now() });

      return markets;
    } catch (err) {
      this.log('error', 'Failed to fetch markets', { error: err.message });
      return [];
    }
  }

  /**
   * Parse a Gamma API event response into our market format
   * Events have a negRisk structure with multiple outcome markets
   */
  parseEvent(event, cityInfo, date, dateStr) {
    try {
      // Event structure from Gamma API:
      // - id, slug, title, description
      // - markets: array of outcome markets (each is a binary YES/NO)
      // - negRiskMarketId: the parent market ID

      if (!event.markets || event.markets.length === 0) {
        this.log('warn', `Event has no markets: ${event.slug}`);
        return null;
      }

      // Extract ranges from markets
      const ranges = event.markets.map(market => {
        // Each market represents one temperature range outcome
        // The market question contains the range (e.g., "≤17°F" or "20-21°F")
        const outcomeStr = market.groupItemTitle || market.question || '';
        const parsed = this.parseRange(outcomeStr);

        // Get price from outcomePrices (YES probability)
        let price = 0;
        if (market.outcomePrices) {
          try {
            const prices = JSON.parse(market.outcomePrices);
            price = parseFloat(prices[0]) || 0; // First price is YES
          } catch {}
        }

        // Get token IDs
        let tokenId = null;
        if (market.clobTokenIds && market.clobTokenIds.length > 0) {
          tokenId = market.clobTokenIds[0]; // YES token
        }

        return {
          name: outcomeStr,
          price: price,
          tokenId: tokenId,
          conditionId: market.conditionId,
          marketId: market.id,
          volume: parseFloat(market.volume) || 0,
          liquidity: parseFloat(market.liquidity) || 0,
          ...parsed,
        };
      }).filter(r => r.min !== undefined);

      if (ranges.length === 0) {
        this.log('warn', `No valid ranges parsed for: ${event.slug}`);
        return null;
      }

      // Calculate total probability
      const totalProb = ranges.reduce((sum, r) => sum + r.price, 0);

      // Determine unit from ranges
      const unit = this.extractUnitFromRanges(ranges);

      return {
        id: event.id,
        slug: event.slug,
        question: event.title || `Highest temperature in ${cityInfo.displayName} on ${dateStr}?`,
        city: cityInfo.key,
        date: date,
        dateStr: dateStr,
        unit: unit,
        ranges: ranges,
        totalProbability: totalProb,
        mispricingPct: Math.round((1 - totalProb) * 10000) / 100,
        volume: parseFloat(event.volume) || 0,
        liquidity: parseFloat(event.liquidity) || 0,
        negRiskMarketId: event.negRiskMarketID,
        endDate: event.endDate,
        closed: event.closed,
        resolved: event.resolved,
        resolutionSource: event.resolutionSource,
      };
    } catch (err) {
      this.log('warn', 'Failed to parse event', { slug: event?.slug, error: err.message });
      return null;
    }
  }

  /**
   * Legacy method - parse a single market (for backwards compatibility)
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
        mispricingPct: Math.round((1 - totalProb) * 10000) / 100,
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
    const match = question.match(/(\w+)\s+(\d{1,2})/i);
    if (!match) return null;

    const monthStr = match[1].toLowerCase();
    const day = parseInt(match[2]);

    const monthIdx = MONTH_NAMES.indexOf(monthStr);
    if (monthIdx === -1) return null;

    const now = new Date();
    let year = now.getFullYear();

    const testDate = new Date(year, monthIdx, day);
    if (testDate < now - 86400000 * 30) {
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

    const usCities = ['nyc', 'new york', 'atlanta', 'miami', 'chicago', 'dallas', 'seattle', 'denver', 'phoenix', 'los angeles'];
    const q = question.toLowerCase();
    for (const city of usCities) {
      if (q.includes(city)) return 'F';
    }

    return 'C';
  }

  /**
   * Extract unit from parsed ranges
   */
  extractUnitFromRanges(ranges) {
    for (const range of ranges) {
      if (range.name.includes('°F') || range.name.includes('°f')) return 'F';
      if (range.name.includes('°C') || range.name.includes('°c')) return 'C';
    }
    return 'F'; // Default to F for US-centric markets
  }

  /**
   * Parse outcome ranges with prices and token IDs (legacy format)
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
   * Handles formats like: "≤17°F", "18-19°F", "≥28°F", "20-21°F"
   */
  parseRange(rangeStr) {
    // Handle "≤X" or "X or below" format
    if (/≤|below|or\s+less/i.test(rangeStr)) {
      const num = rangeStr.match(/-?[\d.]+/);
      if (num) {
        return { min: -Infinity, max: parseFloat(num[0]) };
      }
    }

    // Handle "≥X" or "X or higher/above" format
    if (/≥|higher|above|or\s+more/i.test(rangeStr)) {
      const num = rangeStr.match(/-?[\d.]+/);
      if (num) {
        return { min: parseFloat(num[0]), max: Infinity };
      }
    }

    // Handle "X-Y" range (e.g., "18-19°F" or "20-21°F")
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
      const event = await this.fetchEventBySlug(slug);
      if (!event) return null;

      // Try to extract city and date from the slug
      const cityMatch = WEATHER_CITIES.find(c => slug.includes(c.slugName));
      const dateMatch = slug.match(/on-(\w+)-(\d+)/);

      let date = null;
      let dateStr = null;

      if (dateMatch) {
        const monthIdx = MONTH_NAMES.indexOf(dateMatch[1].toLowerCase());
        if (monthIdx !== -1) {
          const day = parseInt(dateMatch[2]);
          const year = new Date().getFullYear();
          date = new Date(year, monthIdx, day);
          dateStr = date.toISOString().split('T')[0];
        }
      }

      if (!cityMatch || !date) {
        this.log('warn', `Could not parse city/date from slug: ${slug}`);
        return null;
      }

      return this.parseEvent(event, cityMatch, date, dateStr);
    } catch (err) {
      this.log('error', 'Failed to fetch market', { slug, error: err.message });
      return null;
    }
  }
}

module.exports = { MarketScanner, WEATHER_CITIES };
