/**
 * Mispricing Detector
 *
 * Core strategy logic for identifying profitable weather market opportunities.
 * Detects probability gaps and forecast disagreements.
 */

class MispricingDetector {
  constructor(config = {}) {
    // Strategy thresholds
    this.minMispricingPct = config.minMispricingPct || 3;        // Min 3% edge
    this.minRangePrice = config.minRangePrice || 0.10;           // Range must be at least 10¢
    this.maxRangePrice = config.maxRangePrice || 0.85;           // Don't buy above 85¢
    this.minForecastConfidence = config.minForecastConfidence || 'low'; // Accept all confidence levels

    this.log = config.log || console.log;
  }

  /**
   * Analyze a market for mispricing opportunities
   *
   * @param {Object} market - Parsed market from MarketScanner
   * @param {Object} forecast - Forecast from WeatherAPI
   * @returns {Object|null} - Opportunity or null if none found
   */
  analyzeMarket(market, forecast) {
    if (!market || !forecast) return null;

    // Skip if market is closed or resolved
    if (market.closed || market.resolved) return null;

    // Get forecast temperature in market's unit
    const forecastTemp = market.unit === 'F' ? forecast.highF : forecast.highC;

    // Find ranges that match forecast
    const matchingRanges = this.findMatchingRanges(market.ranges, forecastTemp);

    // Calculate total probability
    const totalProb = market.totalProbability;
    const mispricingPct = market.mispricingPct;

    // Check if there's enough edge
    if (mispricingPct < this.minMispricingPct && matchingRanges.length === 0) {
      return null;
    }

    // Find best range to trade
    const bestRange = this.findBestRange(market.ranges, forecastTemp, matchingRanges);
    if (!bestRange) return null;

    // Price filters
    if (bestRange.price < this.minRangePrice) {
      this.log('info', 'Range price too low', {
        market: market.slug,
        range: bestRange.name,
        price: bestRange.price,
        min: this.minRangePrice
      });
      return null;
    }

    if (bestRange.price > this.maxRangePrice) {
      this.log('info', 'Range price too high', {
        market: market.slug,
        range: bestRange.name,
        price: bestRange.price,
        max: this.maxRangePrice
      });
      return null;
    }

    // Calculate expected value
    const ev = this.calculateExpectedValue(bestRange, forecast, mispricingPct);

    // Build opportunity object
    return {
      market: market,
      forecast: forecast,
      forecastTemp: forecastTemp,
      totalProbability: totalProb,
      mispricingPct: mispricingPct,
      bestRange: bestRange,
      matchingRanges: matchingRanges,
      expectedValue: ev,
      confidence: forecast.confidence,
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Find ranges that match the forecast temperature
   * Returns ranges where forecast falls within ±2 degrees
   */
  findMatchingRanges(ranges, forecastTemp) {
    const matching = [];

    for (const range of ranges) {
      if (range.min === undefined) continue;

      // Check if forecast is in range or within 1 degree of range
      const inRange = forecastTemp >= range.min && forecastTemp <= range.max;
      const nearRange = forecastTemp >= range.min - 1 && forecastTemp <= range.max + 1;

      if (inRange) {
        matching.push({ ...range, matchType: 'exact' });
      } else if (nearRange) {
        matching.push({ ...range, matchType: 'near' });
      }
    }

    // Sort by closeness to forecast
    matching.sort((a, b) => {
      const aMid = (a.min + a.max) / 2;
      const bMid = (b.min + b.max) / 2;
      return Math.abs(forecastTemp - aMid) - Math.abs(forecastTemp - bMid);
    });

    return matching;
  }

  /**
   * Find the best range to trade
   */
  findBestRange(ranges, forecastTemp, matchingRanges) {
    // First priority: exact match with good price
    const exactMatch = matchingRanges.find(r =>
      r.matchType === 'exact' &&
      r.price >= this.minRangePrice &&
      r.price <= this.maxRangePrice
    );
    if (exactMatch) return exactMatch;

    // Second priority: near match with good price
    const nearMatch = matchingRanges.find(r =>
      r.matchType === 'near' &&
      r.price >= this.minRangePrice &&
      r.price <= this.maxRangePrice
    );
    if (nearMatch) return nearMatch;

    // Third priority: any match
    if (matchingRanges.length > 0) {
      return matchingRanges[0];
    }

    return null;
  }

  /**
   * Calculate expected value for a position
   *
   * EV = (probability of winning * payout) - cost
   *
   * For a $1 payout at price P:
   * - Cost per share = P
   * - Payout per share = $1 (if win)
   * - EV per share = (winProb * $1) - P
   */
  calculateExpectedValue(range, forecast, mispricingPct) {
    const price = range.price;

    // Estimate win probability based on forecast confidence and range match
    let baseWinProb = price; // Market's implied probability

    // Adjust for forecast edge
    // If we think forecast is better than market, add edge
    const confidenceMultiplier = {
      'very-high': 1.15,
      'high': 1.10,
      'medium': 1.05,
      'low': 1.0,
    }[forecast.confidence] || 1.0;

    // Adjusted probability (capped at 0.95)
    const adjustedProb = Math.min(baseWinProb * confidenceMultiplier, 0.95);

    // Add mispricing edge (if total prob < 100%, free edge exists)
    const mispricingEdge = mispricingPct / 100;
    const finalProb = Math.min(adjustedProb + mispricingEdge, 0.98);

    // EV per dollar spent
    // Spend $1 at price P = get 1/P shares
    // If win: payout = 1/P * $1 = $1/P
    // EV = finalProb * (1/P) - 1
    const evPerDollar = finalProb * (1 / price) - 1;

    return {
      winProbability: finalProb,
      impliedProb: price,
      evPerDollar: evPerDollar,
      evPct: evPerDollar * 100,
      isPositive: evPerDollar > 0,
    };
  }

  /**
   * Generate position sizes for an opportunity
   *
   * Uses percentage-of-capital sizing with hedging across multiple ranges
   *
   * @param {Object} opportunity - Detected opportunity
   * @param {number} capital - Available capital
   * @param {Object} config - Position config
   */
  generatePositions(opportunity, capital, config = {}) {
    const {
      maxPositionPct = 0.30,        // Max 30% of capital per market
      maxPerRange = 0.15,           // Max 15% per single range
      hedgeRanges = true,           // Spread across nearby ranges
    } = config;

    const maxForMarket = capital * maxPositionPct;
    const maxPerRangeAmount = capital * maxPerRange;

    const positions = [];

    if (hedgeRanges && opportunity.matchingRanges.length > 1) {
      // Spread across matching ranges
      // Weight by closeness to forecast
      const totalWeight = opportunity.matchingRanges.reduce((sum, r) => {
        const mid = (r.min + r.max) / 2;
        const distance = Math.abs(opportunity.forecastTemp - mid);
        return sum + (1 / (distance + 1));
      }, 0);

      let allocated = 0;
      for (const range of opportunity.matchingRanges) {
        if (allocated >= maxForMarket) break;
        if (range.price < this.minRangePrice || range.price > this.maxRangePrice) continue;

        const mid = (range.min + range.max) / 2;
        const distance = Math.abs(opportunity.forecastTemp - mid);
        const weight = (1 / (distance + 1)) / totalWeight;

        let amount = Math.min(
          maxForMarket * weight,
          maxPerRangeAmount,
          maxForMarket - allocated
        );

        // Round to reasonable amount
        amount = Math.round(amount * 100) / 100;

        if (amount >= 1) { // Min $1 position
          const shares = amount / range.price;
          positions.push({
            range: range.name,
            tokenId: range.tokenId,
            side: 'BUY',
            price: range.price,
            amount: amount,
            shares: Math.floor(shares * 100) / 100,
            potentialPayout: Math.floor(shares),
          });
          allocated += amount;
        }
      }
    } else {
      // Single range position
      const range = opportunity.bestRange;
      const amount = Math.min(maxForMarket, maxPerRangeAmount);
      const shares = amount / range.price;

      positions.push({
        range: range.name,
        tokenId: range.tokenId,
        side: 'BUY',
        price: range.price,
        amount: Math.round(amount * 100) / 100,
        shares: Math.floor(shares * 100) / 100,
        potentialPayout: Math.floor(shares),
      });
    }

    return {
      positions,
      totalCost: positions.reduce((sum, p) => sum + p.amount, 0),
      maxPayout: Math.max(...positions.map(p => p.potentialPayout)),
      marketSlug: opportunity.market.slug,
    };
  }

  /**
   * Score and rank multiple opportunities
   */
  rankOpportunities(opportunities) {
    return opportunities
      .filter(o => o.expectedValue.isPositive)
      .sort((a, b) => {
        // Sort by EV per dollar, then by mispricing %
        const evDiff = b.expectedValue.evPerDollar - a.expectedValue.evPerDollar;
        if (Math.abs(evDiff) > 0.01) return evDiff;
        return b.mispricingPct - a.mispricingPct;
      });
  }

  /**
   * Detect forecast shift opportunities
   *
   * When forecast shifts significantly, find ranges that became underpriced
   * because the market hasn't adjusted yet.
   *
   * @param {Object} market - Parsed market from MarketScanner
   * @param {Object} currentForecast - Current forecast from WeatherAPI
   * @param {Object} forecastShift - Shift data from WeatherAPI.compareForecast()
   * @returns {Object|null} - Opportunity or null if none found
   */
  detectForecastShift(market, currentForecast, forecastShift) {
    if (!market || !currentForecast || !forecastShift) return null;

    // Skip if market is closed or resolved
    if (market.closed || market.resolved) return null;

    // Get temperatures in market's unit
    const currentTemp = market.unit === 'F' ? forecastShift.currentHighF : forecastShift.currentHighC;
    const previousTemp = market.unit === 'F' ? forecastShift.previousHighF : forecastShift.previousHighC;
    const shift = market.unit === 'F' ? forecastShift.shiftF : forecastShift.shiftC;

    // Find the range that NOW matches the forecast (post-shift)
    const newMatchingRanges = this.findMatchingRanges(market.ranges, currentTemp);

    // Find the range that PREVIOUSLY matched (pre-shift)
    const oldMatchingRanges = this.findMatchingRanges(market.ranges, previousTemp);

    if (newMatchingRanges.length === 0) {
      return null;
    }

    // The opportunity exists when:
    // 1. The new matching range has a low price (market hasn't adjusted)
    // 2. The shift is significant enough to be confident

    const bestNewRange = newMatchingRanges[0];

    // If the new range price is too high, market already adjusted
    if (bestNewRange.price > this.maxRangePrice) {
      this.log('info', 'Forecast shift detected but market already adjusted', {
        market: market.slug,
        shift: shift,
        newRange: bestNewRange.name,
        price: bestNewRange.price,
      });
      return null;
    }

    // If price is too low, might be too risky
    if (bestNewRange.price < this.minRangePrice) {
      this.log('info', 'Forecast shift range price too low', {
        market: market.slug,
        range: bestNewRange.name,
        price: bestNewRange.price,
        min: this.minRangePrice,
      });
      return null;
    }

    // Calculate expected value for forecast shift
    // We have information edge: we know forecast shifted but market may not reflect it yet
    const ev = this.calculateForecastShiftEV(bestNewRange, currentForecast, forecastShift);

    // Build opportunity object
    return {
      market: market,
      forecast: currentForecast,
      forecastTemp: currentTemp,
      totalProbability: market.totalProbability,
      mispricingPct: market.mispricingPct,
      bestRange: bestNewRange,
      matchingRanges: newMatchingRanges,
      expectedValue: ev,
      confidence: currentForecast.confidence,
      detectedAt: new Date().toISOString(),
      // Forecast shift specific fields
      strategy: 'forecast_arbitrage',
      forecastShift: forecastShift,
      previousTemp: previousTemp,
      shiftAmount: shift,
      shiftDirection: forecastShift.direction,
      oldMatchingRanges: oldMatchingRanges,
    };
  }

  /**
   * Calculate expected value for forecast shift opportunity
   *
   * Key insight: If forecast shifted by X degrees, and market hasn't adjusted,
   * we have information edge. The true probability is higher than market price.
   */
  calculateForecastShiftEV(range, forecast, forecastShift) {
    const price = range.price;

    // Base probability is the market price
    let adjustedProb = price;

    // Confidence multiplier based on forecast confidence
    const confidenceMultiplier = {
      'very-high': 1.25,  // Higher than normal - we have shift info
      'high': 1.20,
      'medium': 1.10,
      'low': 1.0,
    }[forecast.confidence] || 1.0;

    // Shift magnitude bonus: bigger shifts = more confidence
    const shiftMagnitude = Math.abs(forecastShift.shiftF);
    const shiftBonus = shiftMagnitude >= 4 ? 1.15 : shiftMagnitude >= 2 ? 1.10 : 1.05;

    // Combined adjustment (capped at 0.90 to be conservative)
    adjustedProb = Math.min(price * confidenceMultiplier * shiftBonus, 0.90);

    // EV per dollar spent
    const evPerDollar = adjustedProb * (1 / price) - 1;

    return {
      winProbability: adjustedProb,
      impliedProb: price,
      evPerDollar: evPerDollar,
      evPct: evPerDollar * 100,
      isPositive: evPerDollar > 0,
      shiftEdge: (adjustedProb - price) / price, // How much edge from shift
    };
  }

  /**
   * Rank forecast shift opportunities
   */
  rankForecastShiftOpportunities(opportunities) {
    return opportunities
      .filter(o => o.expectedValue.isPositive)
      .sort((a, b) => {
        // Sort by shift magnitude first (bigger shifts = more confident)
        const shiftDiff = Math.abs(b.shiftAmount) - Math.abs(a.shiftAmount);
        if (Math.abs(shiftDiff) > 0.5) return shiftDiff;
        // Then by EV
        return b.expectedValue.evPerDollar - a.expectedValue.evPerDollar;
      });
  }
}

module.exports = { MispricingDetector };
