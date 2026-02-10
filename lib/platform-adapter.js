/**
 * Platform Adapter
 *
 * Normalizes market data from Polymarket and Kalshi into a unified format.
 * Handles city mapping, price comparison, and best-price routing.
 */

// City mapping between platforms
const CITY_MAP = {
  // Polymarket slug → normalized key → Kalshi series
  // Overlapping cities (available on both)
  nyc: {
    normalized: 'nyc',
    polySlug: 'nyc',
    kalshiSeries: 'KXHIGHNY',
    displayName: 'NYC',
    overlap: true,
  },
  chicago: {
    normalized: 'chicago',
    polySlug: 'chicago',
    kalshiSeries: 'KXHIGHCHI',
    displayName: 'Chicago',
    overlap: true,
  },
  miami: {
    normalized: 'miami',
    polySlug: 'miami',
    kalshiSeries: 'KXHIGHMIA',
    displayName: 'Miami',
    overlap: true,
  },
  seattle: {
    normalized: 'seattle',
    polySlug: 'seattle',
    kalshiSeries: 'KXHIGHTSEA',
    displayName: 'Seattle',
    overlap: true,
  },

  // Polymarket-only cities
  london: {
    normalized: 'london',
    polySlug: 'london',
    kalshiSeries: null,
    displayName: 'London',
    overlap: false,
  },
  seoul: {
    normalized: 'seoul',
    polySlug: 'seoul',
    kalshiSeries: null,
    displayName: 'Seoul',
    overlap: false,
  },
  toronto: {
    normalized: 'toronto',
    polySlug: 'toronto',
    kalshiSeries: null,
    displayName: 'Toronto',
    overlap: false,
  },
  dallas: {
    normalized: 'dallas',
    polySlug: 'dallas',
    kalshiSeries: null, // Dallas removed from Kalshi weather (2026-02)
    displayName: 'Dallas',
    overlap: false,
  },
  atlanta: {
    normalized: 'atlanta',
    polySlug: 'atlanta',
    kalshiSeries: 'KXHIGHTATL',
    displayName: 'Atlanta',
    overlap: true,
  },
  ankara: {
    normalized: 'ankara',
    polySlug: 'ankara',
    kalshiSeries: null,
    displayName: 'Ankara',
    overlap: false,
  },
  wellington: {
    normalized: 'wellington',
    polySlug: 'wellington',
    kalshiSeries: null,
    displayName: 'Wellington',
    overlap: false,
  },
  'buenos aires': {
    normalized: 'buenos aires',
    polySlug: 'buenos-aires',
    kalshiSeries: null,
    displayName: 'Buenos Aires',
    overlap: false,
  },

  // Kalshi-only cities
  denver: {
    normalized: 'denver',
    polySlug: null,
    kalshiSeries: 'KXHIGHDEN',
    displayName: 'Denver',
    overlap: false,
  },
  houston: {
    normalized: 'houston',
    polySlug: null,
    kalshiSeries: 'KXHIGHOU',
    displayName: 'Houston',
    overlap: false,
  },
  'los angeles': {
    normalized: 'los angeles',
    polySlug: null,
    kalshiSeries: 'KXHIGHLAX',
    displayName: 'Los Angeles',
    overlap: false,
  },
  philadelphia: {
    normalized: 'philadelphia',
    polySlug: null,
    kalshiSeries: 'KXHIGHPHIL',
    displayName: 'Philadelphia',
    overlap: false,
  },
  dc: {
    normalized: 'dc',
    polySlug: null,
    kalshiSeries: 'KXHIGHTDC',
    displayName: 'Washington DC',
    overlap: false,
  },
  'las vegas': {
    normalized: 'las vegas',
    polySlug: null,
    kalshiSeries: 'KXHIGHTLV',
    displayName: 'Las Vegas',
    overlap: false,
  },
  'new orleans': {
    normalized: 'new orleans',
    polySlug: null,
    kalshiSeries: 'KXHIGHTNOLA',
    displayName: 'New Orleans',
    overlap: false,
  },
  'san francisco': {
    normalized: 'san francisco',
    polySlug: null,
    kalshiSeries: 'KXHIGHTSFO',
    displayName: 'San Francisco',
    overlap: false,
  },
  austin: {
    normalized: 'austin',
    polySlug: null,
    kalshiSeries: 'KXHIGHAUS',
    displayName: 'Austin',
    overlap: false,
  },
  boston: {
    normalized: 'boston',
    polySlug: null,
    kalshiSeries: 'KXHIGHTBOS',
    displayName: 'Boston',
    overlap: false,
  },
  phoenix: {
    normalized: 'phoenix',
    polySlug: null,
    kalshiSeries: 'KXHIGHTPHX',
    displayName: 'Phoenix',
    overlap: false,
  },
  minneapolis: {
    normalized: 'minneapolis',
    polySlug: null,
    kalshiSeries: 'KXHIGHTMIN',
    displayName: 'Minneapolis',
    overlap: false,
  },
};

// Platform fee rates
const PLATFORM_FEES = {
  polymarket: {
    takerFee: 0.0315, // 3.15% taker fee
    feeType: 'flat',
  },
  kalshi: {
    takerFee: 0.012, // ~1.2% average (quadratic structure)
    feeType: 'quadratic',
  },
};

class PlatformAdapter {
  constructor(config = {}) {
    this.log = config.log || console.log;
    this.preferredPlatform = config.preferredPlatform || 'best_price'; // 'polymarket', 'kalshi', or 'best_price'
    this.enableArbitrage = config.enableArbitrage || false;
  }

  /**
   * Normalize a Polymarket market to unified format
   */
  normalizePolymarket(market) {
    return {
      platform: 'polymarket',
      platformMarketId: market.id,
      platformSlug: market.slug,
      city: market.city,
      cityInfo: CITY_MAP[market.city] || null,
      date: market.date,
      dateStr: market.dateStr,
      type: market.type || 'temperature',
      unit: market.unit,
      title: market.question,

      // Normalized outcomes
      outcomes: market.ranges.map(r => ({
        label: r.name,
        rangeMin: r.min,
        rangeMax: r.max,
        unit: market.unit,
        price: r.price,
        bestBid: r.bestBid || r.price,
        bestAsk: r.bestAsk || r.price,
        spread: r.spread || 0,
        volume: r.volume || 0,
        tokenId: r.tokenId,
        conditionId: r.conditionId,
      })),

      // Metadata
      totalProbability: market.totalProbability,
      mispricingPct: market.mispricingPct,
      avgSpread: market.avgSpread,
      hasLiquidity: market.hasLiquidity,
      volume: market.volume,
      closeTime: market.endDate,
      closed: market.closed,
      resolved: market.resolved,
      resolutionSource: 'Open-Meteo',

      // Fee info
      estimatedFee: PLATFORM_FEES.polymarket.takerFee,
      feeType: PLATFORM_FEES.polymarket.feeType,

      // Original market for reference
      _raw: market,
    };
  }

  /**
   * Normalize a Kalshi market to unified format
   */
  normalizeKalshi(market) {
    return {
      platform: 'kalshi',
      platformMarketId: market.eventTicker,
      platformSlug: market.eventTicker,
      city: market.city,
      cityInfo: CITY_MAP[market.city] || null,
      date: market.date,
      dateStr: market.dateStr,
      type: 'temperature',
      unit: market.unit,
      title: market.question,

      // Normalized outcomes
      outcomes: market.ranges.map(r => ({
        label: r.name,
        rangeMin: r.min,
        rangeMax: r.max,
        unit: 'F',
        price: r.price,
        bestBid: r.bestBid,
        bestAsk: r.bestAsk,
        spread: r.spread || 0,
        volume: r.volume || 0,
        tokenId: r.tokenId, // Kalshi market ticker
        openInterest: r.openInterest || 0,
      })),

      // Metadata
      totalProbability: market.totalProbability,
      mispricingPct: market.mispricingPct,
      avgSpread: market.avgSpread,
      hasLiquidity: market.hasLiquidity,
      volume: market.volume,
      closeTime: market.closeTime,
      closed: market.closed,
      resolved: market.resolved,
      resolutionSource: 'NWS',

      // Fee info
      estimatedFee: PLATFORM_FEES.kalshi.takerFee,
      feeType: PLATFORM_FEES.kalshi.feeType,

      // Original market for reference
      _raw: market,
    };
  }

  /**
   * Merge markets from both platforms, handling overlaps
   * Returns markets grouped by city+date with platform comparison
   */
  mergeMarkets(polymarketMarkets, kalshiMarkets) {
    // Normalize all markets
    const normalizedPoly = polymarketMarkets.map(m => this.normalizePolymarket(m));
    const normalizedKalshi = kalshiMarkets.map(m => this.normalizeKalshi(m));

    // Group by city+date key
    const marketMap = new Map();

    for (const market of normalizedPoly) {
      const key = `${market.city}-${market.dateStr}`;
      if (!marketMap.has(key)) {
        marketMap.set(key, { key, city: market.city, dateStr: market.dateStr, polymarket: null, kalshi: null });
      }
      marketMap.get(key).polymarket = market;
    }

    for (const market of normalizedKalshi) {
      const key = `${market.city}-${market.dateStr}`;
      if (!marketMap.has(key)) {
        marketMap.set(key, { key, city: market.city, dateStr: market.dateStr, polymarket: null, kalshi: null });
      }
      marketMap.get(key).kalshi = market;
    }

    // Process each city+date
    const results = {
      all: [], // All markets (deduplicated, best-price selected)
      polymarketOnly: [],
      kalshiOnly: [],
      overlap: [], // Markets available on both platforms
      comparisons: [], // Price comparisons for overlap markets
    };

    for (const [key, group] of marketMap) {
      const { polymarket, kalshi } = group;

      if (polymarket && kalshi) {
        // Both platforms have this market
        const comparison = this.compareMarkets(polymarket, kalshi);
        results.comparisons.push(comparison);
        results.overlap.push(comparison);

        // Select best platform for trading
        const selected = this.selectBestMarket(polymarket, kalshi);
        selected._comparison = comparison;
        results.all.push(selected);

      } else if (polymarket) {
        results.polymarketOnly.push(polymarket);
        results.all.push(polymarket);

      } else if (kalshi) {
        results.kalshiOnly.push(kalshi);
        results.all.push(kalshi);
      }
    }

    this.log('info', 'Platform merge complete', {
      total: results.all.length,
      polymarketOnly: results.polymarketOnly.length,
      kalshiOnly: results.kalshiOnly.length,
      overlap: results.overlap.length,
    });

    return results;
  }

  /**
   * Compare markets from both platforms
   */
  compareMarkets(polymarket, kalshi) {
    const comparison = {
      city: polymarket.city,
      dateStr: polymarket.dateStr,
      polymarket: {
        totalProb: polymarket.totalProbability,
        avgSpread: polymarket.avgSpread,
        hasLiquidity: polymarket.hasLiquidity,
        fee: PLATFORM_FEES.polymarket.takerFee,
      },
      kalshi: {
        totalProb: kalshi.totalProbability,
        avgSpread: kalshi.avgSpread,
        hasLiquidity: kalshi.hasLiquidity,
        fee: PLATFORM_FEES.kalshi.takerFee,
      },
      rangeComparisons: [],
      arbitrageOpportunity: null,
    };

    // Compare individual ranges where they overlap
    for (const polyOutcome of polymarket.outcomes) {
      // Find matching Kalshi range (ranges may not align exactly)
      const kalshiOutcome = this.findMatchingRange(polyOutcome, kalshi.outcomes);

      if (kalshiOutcome) {
        const rangeComp = this.compareOutcomes(polyOutcome, kalshiOutcome);
        comparison.rangeComparisons.push(rangeComp);
      }
    }

    // Check for arbitrage opportunity
    if (this.enableArbitrage) {
      comparison.arbitrageOpportunity = this.detectArbitrage(polymarket, kalshi);
    }

    return comparison;
  }

  /**
   * Find a Kalshi range that matches a Polymarket range
   * Ranges may have different boundaries (Kalshi uses 2°F buckets, Poly uses 1°F)
   */
  findMatchingRange(polyOutcome, kalshiOutcomes) {
    const polyMid = (polyOutcome.rangeMin + polyOutcome.rangeMax) / 2;

    // Find Kalshi range that contains the Polymarket range midpoint
    for (const kalshi of kalshiOutcomes) {
      if (polyMid >= kalshi.rangeMin && polyMid <= kalshi.rangeMax) {
        return kalshi;
      }
    }

    return null;
  }

  /**
   * Compare two outcomes from different platforms
   */
  compareOutcomes(polyOutcome, kalshiOutcome) {
    const polyEffective = polyOutcome.price / (1 - PLATFORM_FEES.polymarket.takerFee);
    const kalshiEffective = kalshiOutcome.price / (1 - PLATFORM_FEES.kalshi.takerFee);

    const priceDiff = polyOutcome.price - kalshiOutcome.price;
    const effectiveDiff = polyEffective - kalshiEffective;

    return {
      polyLabel: polyOutcome.label,
      kalshiLabel: kalshiOutcome.label,
      polyPrice: polyOutcome.price,
      kalshiPrice: kalshiOutcome.price,
      polyEffective,
      kalshiEffective,
      priceDiff,
      effectiveDiff,
      priceDiffPct: (priceDiff / polyOutcome.price) * 100,
      bestPlatform: effectiveDiff <= 0 ? 'polymarket' : 'kalshi',
      bestPrice: Math.min(polyEffective, kalshiEffective),
    };
  }

  /**
   * Select the best market for trading based on configuration
   */
  selectBestMarket(polymarket, kalshi) {
    if (this.preferredPlatform === 'polymarket') {
      return polymarket;
    }
    if (this.preferredPlatform === 'kalshi') {
      return kalshi;
    }

    // best_price: compare fee-adjusted best outcomes
    const polyBest = this.findBestOutcome(polymarket);
    const kalshiBest = this.findBestOutcome(kalshi);

    if (!polyBest && !kalshiBest) {
      return polymarket; // Default to Polymarket
    }
    if (!polyBest) return kalshi;
    if (!kalshiBest) return polymarket;

    const polyEffective = polyBest.price / (1 - PLATFORM_FEES.polymarket.takerFee);
    const kalshiEffective = kalshiBest.price / (1 - PLATFORM_FEES.kalshi.takerFee);

    return polyEffective <= kalshiEffective ? polymarket : kalshi;
  }

  /**
   * Find the best outcome (highest probability at lowest price)
   */
  findBestOutcome(market) {
    if (!market.outcomes || market.outcomes.length === 0) return null;

    // For now, just return the outcome with the best price/probability ratio
    return market.outcomes.reduce((best, current) => {
      if (!best) return current;
      // Higher price = higher probability of winning
      return current.price > best.price ? current : best;
    }, null);
  }

  /**
   * Detect cross-platform arbitrage opportunity
   */
  detectArbitrage(polymarket, kalshi) {
    // Simple arb: if buying YES on one and NO on the other costs < $1
    // This is tricky because ranges don't align exactly

    // For now, just flag large price differences
    for (const polyOutcome of polymarket.outcomes) {
      const kalshiOutcome = this.findMatchingRange(polyOutcome, kalshi.outcomes);
      if (!kalshiOutcome) continue;

      const polyYes = polyOutcome.price;
      const kalshiYes = kalshiOutcome.price;

      // Check: Buy YES on cheaper, "sell" YES (buy NO) on expensive
      // Cost to buy YES on Poly + cost to buy NO on Kalshi
      const costA = polyYes + (1 - kalshiYes);
      const feesA = (polyYes * PLATFORM_FEES.polymarket.takerFee) + ((1 - kalshiYes) * PLATFORM_FEES.kalshi.takerFee);
      const profitA = 1.0 - costA - feesA;

      const costB = kalshiYes + (1 - polyYes);
      const feesB = (kalshiYes * PLATFORM_FEES.kalshi.takerFee) + ((1 - polyYes) * PLATFORM_FEES.polymarket.takerFee);
      const profitB = 1.0 - costB - feesB;

      if (profitA > 0.01 || profitB > 0.01) { // At least 1% profit
        return {
          type: 'cross_platform_arb',
          polyRange: polyOutcome.label,
          kalshiRange: kalshiOutcome.label,
          profitA: profitA,
          profitB: profitB,
          bestDirection: profitA > profitB ? 'poly_yes_kalshi_no' : 'kalshi_yes_poly_no',
          bestProfit: Math.max(profitA, profitB),
          warning: 'Resolution sources differ (Open-Meteo vs NWS) - not risk-free!',
        };
      }
    }

    return null;
  }

  /**
   * Calculate Kelly bet size with fees
   */
  kellyWithFees(trueProbability, marketPrice, fee) {
    const effectivePayout = 1 - fee;
    const b = (effectivePayout - marketPrice) / marketPrice;
    const p = trueProbability;
    const q = 1 - p;
    const kelly = (p * b - q) / b;
    return Math.max(0, kelly);
  }

  /**
   * Get fee for a platform
   */
  getFee(platform) {
    return PLATFORM_FEES[platform]?.takerFee || 0;
  }
}

module.exports = {
  PlatformAdapter,
  CITY_MAP,
  PLATFORM_FEES,
};
