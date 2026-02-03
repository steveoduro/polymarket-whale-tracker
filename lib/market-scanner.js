/**
 * Multi-Platform Weather Market Scanner
 *
 * Finds and parses temperature markets from Polymarket and Kalshi.
 *
 * POLYMARKET: Uses direct slug queries (Gamma API filtering doesn't work for weather)
 * KALSHI: Uses series ticker queries (much more reliable)
 *
 * Strategy:
 * 1. Generate expected slug patterns for Polymarket
 * 2. Query Kalshi series directly (no slug guessing needed)
 * 3. Merge and deduplicate markets from both platforms
 */

const { KalshiAPI, OVERLAP_CITIES } = require('./kalshi-api');
const { PlatformAdapter, CITY_MAP, PLATFORM_FEES } = require('./platform-adapter');

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

// Cities with precipitation markets
const PRECIPITATION_CITIES = ['nyc', 'seattle'];

class MarketScanner {
  constructor(config = {}) {
    this.log = config.log || console.log;
    this.cache = new Map();
    this.cacheExpiry = 60000; // 1 minute cache
    this.daysAhead = config.daysAhead || 7; // How many days ahead to check

    // Multi-platform support
    this.kalshiEnabled = config.kalshiEnabled || false;
    this.kalshiApi = this.kalshiEnabled ? new KalshiAPI({ log: this.log, demo: config.kalshiDemo }) : null;
    this.platformAdapter = new PlatformAdapter({
      log: this.log,
      preferredPlatform: config.preferredPlatform || 'best_price',
      enableArbitrage: config.enableArbitrage || false,
    });
  }

  /**
   * Generate slug for a city and date
   * Example: "highest-temperature-in-nyc-on-january-31-2026"
   * Note: 2026+ markets include the year in the slug
   */
  generateSlug(city, date) {
    const month = MONTH_NAMES[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();
    // 2026+ markets include year in slug
    return `highest-temperature-in-${city.slugName}-on-${month}-${day}-${year}`;
  }

  /**
   * Generate all expected slugs for upcoming dates
   * Generates BOTH patterns (with and without year) for resilience
   */
  generateExpectedSlugs() {
    const slugs = [];
    const today = new Date();

    for (let i = 0; i <= this.daysAhead; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);

      for (const city of WEATHER_CITIES) {
        const month = MONTH_NAMES[date.getMonth()];
        const day = date.getDate();
        const year = date.getFullYear();

        // Try with year first (2026+ pattern)
        slugs.push({
          slug: `highest-temperature-in-${city.slugName}-on-${month}-${day}-${year}`,
          city: city,
          date: date,
          dateStr: date.toISOString().split('T')[0],
        });
        // Also try without year (legacy/fallback pattern)
        slugs.push({
          slug: `highest-temperature-in-${city.slugName}-on-${month}-${day}`,
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
      const marketsByKey = new Map(); // city+date -> market (for deduplication)
      let found = 0;
      let notFound = 0;

      // Query each slug (with rate limiting)
      for (const { slug, city, date, dateStr } of expectedSlugs) {
        const event = await this.fetchEventBySlug(slug);

        if (event) {
          found++;
          const parsed = this.parseEvent(event, city, date, dateStr);
          if (parsed) {
            // Deduplicate by city+date - prefer open markets over closed
            const key = `${city.key}-${dateStr}`;
            const existing = marketsByKey.get(key);
            if (!existing) {
              marketsByKey.set(key, parsed);
            } else if (existing.closed && !parsed.closed) {
              // Replace closed market with open one
              marketsByKey.set(key, parsed);
            } else if (!existing.closed && !parsed.closed && slug.includes(String(date.getFullYear()))) {
              // Both open - prefer the one with year in slug (more specific)
              marketsByKey.set(key, parsed);
            }
          }
        } else {
          notFound++;
        }

        // Small delay to avoid rate limiting (50ms between requests)
        await new Promise(r => setTimeout(r, 50));
      }

      // Convert map to array
      for (const market of marketsByKey.values()) {
        markets.push(market);
      }

      this.log('info', `Found ${found} weather markets, ${markets.length} after deduplication (${notFound} slugs not found)`);

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

        // Get bid/ask for spread tracking
        const bestBid = parseFloat(market.bestBid) || 0;
        const bestAsk = parseFloat(market.bestAsk) || 1;
        const spread = bestAsk - bestBid;

        // Use bestBid as price (what you'd actually pay)
        // Fall back to outcomePrices only if bestBid is 0
        let price = bestBid;
        if (price === 0 && market.outcomePrices) {
          try {
            const prices = JSON.parse(market.outcomePrices);
            price = parseFloat(prices[0]) || 0;
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
          bestBid: bestBid,
          bestAsk: bestAsk,
          spread: spread,
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

      // Calculate average spread to assess liquidity
      const avgSpread = ranges.reduce((sum, r) => sum + (r.spread || 0), 0) / ranges.length;
      const hasLiquidity = avgSpread < 0.50; // Less than 50% spread = tradeable

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
        avgSpread: avgSpread,
        hasLiquidity: hasLiquidity,
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
   * Generate precipitation market slugs
   * Generates BOTH patterns (with and without year) for resilience
   */
  generatePrecipitationSlugs() {
    const slugs = [];
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Check current month and next 2 months
    for (let i = 0; i <= 2; i++) {
      const monthIdx = (currentMonth + i) % 12;
      const year = currentMonth + i >= 12 ? currentYear + 1 : currentYear;
      const month = MONTH_NAMES[monthIdx];

      for (const city of PRECIPITATION_CITIES) {
        // Try with year first (2026+ pattern)
        slugs.push({
          slug: `precipitation-in-${city}-in-${month}-${year}`,
          city: city,
          month: month,
          monthIdx: monthIdx,
          year: year,
          type: 'precipitation',
        });
        // Also try without year (legacy pattern)
        slugs.push({
          slug: `precipitation-in-${city}-in-${month}`,
          city: city,
          month: month,
          monthIdx: monthIdx,
          year: year,
          type: 'precipitation',
        });
      }
    }

    return slugs;
  }

  /**
   * Fetch all active precipitation markets
   */
  async getActivePrecipitationMarkets() {
    try {
      // Check cache
      const cached = this.cache.get('precipitation_markets');
      if (cached && Date.now() - cached.time < this.cacheExpiry) {
        return cached.data;
      }

      const expectedSlugs = this.generatePrecipitationSlugs();
      this.log('info', `Checking ${expectedSlugs.length} potential precipitation market slugs...`);

      const markets = [];
      const marketsByKey = new Map(); // city+month+year -> market (for deduplication)
      let found = 0;
      let notFound = 0;

      for (const slugInfo of expectedSlugs) {
        const event = await this.fetchEventBySlug(slugInfo.slug);

        if (event) {
          found++;
          const parsed = this.parsePrecipitationEvent(event, slugInfo);
          if (parsed) {
            // Deduplicate by city+month+year - prefer open markets over closed
            const key = `${slugInfo.city}-${slugInfo.month}-${slugInfo.year}`;
            const existing = marketsByKey.get(key);
            if (!existing) {
              marketsByKey.set(key, parsed);
            } else if (existing.closed && !parsed.closed) {
              // Replace closed market with open one
              marketsByKey.set(key, parsed);
            } else if (!existing.closed && !parsed.closed && slugInfo.slug.includes(String(slugInfo.year))) {
              // Both open - prefer the one with year in slug (more specific)
              marketsByKey.set(key, parsed);
            }
          }
        } else {
          notFound++;
        }

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 50));
      }

      // Convert map to array
      for (const market of marketsByKey.values()) {
        markets.push(market);
      }

      this.log('info', `Found ${found} precipitation markets, ${markets.length} after deduplication (${notFound} slugs not found)`);

      // Cache results
      this.cache.set('precipitation_markets', { data: markets, time: Date.now() });

      return markets;
    } catch (err) {
      this.log('error', 'Failed to fetch precipitation markets', { error: err.message });
      return [];
    }
  }

  /**
   * Parse a precipitation market event
   */
  parsePrecipitationEvent(event, slugInfo) {
    try {
      if (!event.markets || event.markets.length === 0) {
        this.log('warn', `Precipitation event has no markets: ${event.slug}`);
        return null;
      }

      // Extract ranges from markets
      const ranges = event.markets.map(market => {
        const outcomeStr = market.groupItemTitle || market.question || '';
        const parsed = this.parsePrecipitationRange(outcomeStr);

        // For precipitation markets, use bestBid as the price
        // outcomePrices often contains default/oracle values (~45%) that don't reflect actual market
        const bestBid = parseFloat(market.bestBid) || 0;
        const bestAsk = parseFloat(market.bestAsk) || 1;
        const spread = bestAsk - bestBid;

        // Use bestBid as primary price (what someone will actually pay)
        // Fall back to outcomePrices only if bestBid is 0
        let price = bestBid;
        if (price === 0 && market.outcomePrices) {
          try {
            const prices = JSON.parse(market.outcomePrices);
            price = parseFloat(prices[0]) || 0;
          } catch {}
        }

        // Get token IDs
        let tokenId = null;
        if (market.clobTokenIds && market.clobTokenIds.length > 0) {
          tokenId = market.clobTokenIds[0];
        }

        return {
          name: outcomeStr,
          price: price,
          bestBid: bestBid,
          bestAsk: bestAsk,
          spread: spread,
          tokenId: tokenId,
          conditionId: market.conditionId,
          marketId: market.id,
          volume: parseFloat(market.volume) || 0,
          liquidity: parseFloat(market.liquidity) || 0,
          ...parsed,
        };
      }).filter(r => r.min !== undefined);

      if (ranges.length === 0) {
        this.log('warn', `No valid ranges parsed for precipitation: ${event.slug}`);
        return null;
      }

      // Calculate total probability
      const totalProb = ranges.reduce((sum, r) => sum + r.price, 0);

      // Calculate average spread to assess liquidity
      const avgSpread = ranges.reduce((sum, r) => sum + (r.spread || 0), 0) / ranges.length;
      const hasLiquidity = avgSpread < 0.50; // Less than 50% spread = tradeable

      return {
        id: event.id,
        slug: event.slug,
        question: event.title || `Precipitation in ${slugInfo.city.toUpperCase()} in ${slugInfo.month}?`,
        city: slugInfo.city,
        month: slugInfo.month,
        monthIdx: slugInfo.monthIdx,
        year: slugInfo.year,
        type: 'precipitation',
        unit: 'inches',
        ranges: ranges,
        totalProbability: totalProb,
        mispricingPct: Math.round((1 - totalProb) * 10000) / 100,
        avgSpread: avgSpread,
        hasLiquidity: hasLiquidity,
        volume: parseFloat(event.volume) || 0,
        liquidity: parseFloat(event.liquidity) || 0,
        negRiskMarketId: event.negRiskMarketID,
        endDate: event.endDate,
        closed: event.closed,
        resolved: event.resolved,
      };
    } catch (err) {
      this.log('warn', 'Failed to parse precipitation event', { slug: event?.slug, error: err.message });
      return null;
    }
  }

  /**
   * Parse a precipitation range string into min/max bounds (in inches)
   * Handles formats like: "<3"", "3-4"", "7" or more"
   */
  parsePrecipitationRange(rangeStr) {
    // Handle "<X"" or "under X" format
    if (/^<|under|less than/i.test(rangeStr)) {
      const num = rangeStr.match(/[\d.]+/);
      if (num) {
        return { min: 0, max: parseFloat(num[0]) };
      }
    }

    // Handle "X" or more" or "X+"
    if (/or more|\+|above|over/i.test(rangeStr)) {
      const num = rangeStr.match(/[\d.]+/);
      if (num) {
        return { min: parseFloat(num[0]), max: Infinity };
      }
    }

    // Handle "X-Y"" range
    const rangeMatch = rangeStr.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
    if (rangeMatch) {
      return {
        min: parseFloat(rangeMatch[1]),
        max: parseFloat(rangeMatch[2]),
      };
    }

    // Handle single number with inches symbol
    const single = rangeStr.match(/([\d.]+)\s*["″]/);
    if (single) {
      const n = parseFloat(single[1]);
      return { min: n - 0.25, max: n + 0.25 };
    }

    return {};
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

  /**
   * Diagnostic: Try to discover weather markets via search/title
   * Run this periodically (every hour) to detect slug format changes
   */
  async discoverWeatherMarkets() {
    try {
      // Try searching by title keywords
      const resp = await fetch(`${GAMMA_API}/events?limit=50&closed=false&title=highest+temperature`);
      if (!resp.ok) return null;

      const events = await resp.json();
      if (!events || events.length === 0) return null;

      // Log any slugs we find that don't match our expected pattern
      const ourSlugs = new Set(this.generateExpectedSlugs().map(s => s.slug));
      const unknownSlugs = events
        .filter(e => !ourSlugs.has(e.slug) && !e.closed)
        .map(e => e.slug);

      if (unknownSlugs.length > 0) {
        this.log('warn', 'Found weather markets with unknown slug patterns', {
          count: unknownSlugs.length,
          examples: unknownSlugs.slice(0, 5)
        });
      }

      return { total: events.length, unknown: unknownSlugs.length };
    } catch (err) {
      this.log('warn', 'Discovery check failed', { error: err.message });
      return null;
    }
  }

  // ==========================================================================
  // MULTI-PLATFORM METHODS
  // ==========================================================================

  /**
   * Scan ALL platforms for temperature markets
   * Returns merged, deduplicated markets with platform comparison data
   */
  async getAllTemperatureMarkets() {
    const startTime = Date.now();

    // Scan Polymarket
    const polymarketMarkets = await this.getActiveTemperatureMarkets();
    const polyLatency = Date.now() - startTime;

    // Scan Kalshi if enabled
    let kalshiMarkets = [];
    let kalshiLatency = 0;
    if (this.kalshiEnabled && this.kalshiApi) {
      const kalshiStart = Date.now();
      try {
        kalshiMarkets = await this.kalshiApi.getActiveTemperatureMarkets();
        kalshiLatency = Date.now() - kalshiStart;
      } catch (err) {
        this.log('warn', 'Kalshi scan failed', { error: err.message });
      }
    }

    // Merge markets from both platforms
    const merged = this.platformAdapter.mergeMarkets(polymarketMarkets, kalshiMarkets);

    this.log('info', 'Multi-platform scan complete', {
      polymarket: { markets: polymarketMarkets.length, latencyMs: polyLatency },
      kalshi: { markets: kalshiMarkets.length, latencyMs: kalshiLatency, enabled: this.kalshiEnabled },
      merged: {
        total: merged.all.length,
        overlap: merged.overlap.length,
        polyOnly: merged.polymarketOnly.length,
        kalshiOnly: merged.kalshiOnly.length,
      },
    });

    return merged;
  }

  /**
   * Scan ALL platforms for precipitation markets
   * (Currently Polymarket only - Kalshi precipitation support TBD)
   */
  async getAllPrecipitationMarkets() {
    // For now, just return Polymarket precipitation markets
    // Kalshi precipitation integration can be added later
    const polymarketMarkets = await this.getActivePrecipitationMarkets();

    return {
      all: polymarketMarkets.map(m => this.platformAdapter.normalizePolymarket(m)),
      polymarketOnly: polymarketMarkets,
      kalshiOnly: [],
      overlap: [],
      comparisons: [],
    };
  }

  /**
   * Get platform health stats
   */
  getPlatformHealth() {
    const health = {
      polymarket: {
        status: 'ok',
        lastError: null,
      },
      kalshi: {
        enabled: this.kalshiEnabled,
        status: this.kalshiEnabled ? 'ok' : 'disabled',
        lastError: null,
        stats: this.kalshiApi?.getStats() || null,
      },
    };

    return health;
  }

  /**
   * Reset platform stats (call at start of scan cycle)
   */
  resetPlatformStats() {
    if (this.kalshiApi) {
      this.kalshiApi.resetStats();
    }
  }

  /**
   * Discover all available Kalshi weather series
   */
  async discoverKalshiSeries() {
    if (!this.kalshiApi) {
      this.log('warn', 'Kalshi API not enabled');
      return null;
    }
    return await this.kalshiApi.discoverWeatherSeries();
  }
}

module.exports = { MarketScanner, WEATHER_CITIES, PRECIPITATION_CITIES, OVERLAP_CITIES };
