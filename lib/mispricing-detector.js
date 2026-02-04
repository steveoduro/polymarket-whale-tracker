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

    // Risk management settings
    this.minProbability = config.minProbability || 0.20;         // Only trade ranges ≥20% probability
    this.kellyFraction = config.kellyFraction || 0.5;            // Half Kelly
    this.maxPositionPct = config.maxPositionPct || 0.10;         // Max 10% of bankroll
    this.minBetSize = config.minBetSize || 10;                   // Min $10 bet

    this.log = config.log || console.log;
  }

  /**
   * Estimate true probability based on forecast confidence
   * This is our edge over the market
   */
  estimateTrueProbability(marketProbability, forecastConfidence, isMatchingRange) {
    if (!isMatchingRange) {
      return marketProbability; // No edge on non-forecasted ranges
    }

    // Confidence boost multipliers
    const confidenceBoost = {
      'very-high': 1.25,  // 25% boost
      'high': 1.15,       // 15% boost
      'medium': 1.05,     // 5% boost
      'low': 1.00,        // No boost
    };

    const boost = confidenceBoost[forecastConfidence] || 1.0;
    const trueProbability = Math.min(marketProbability * boost, 0.95); // Cap at 95%

    return trueProbability;
  }

  /**
   * Calculate Kelly criterion bet size with optional fee adjustment
   * f* = (p * b - q) / b where b = odds, p = win prob, q = 1-p
   * With fees: effective payout is reduced, changing optimal bet size
   *
   * @param {number} fee - Platform fee rate (e.g., 0.0315 for Polymarket, 0.012 for Kalshi)
   */
  calculateKellySize(marketProbability, trueProbability, bankroll, fee = 0) {
    // Fee-adjusted Kelly: reduce effective payout
    const effectivePayout = 1 - fee;

    // Calculate edge accounting for fees
    // Without fees: edge = trueProbability - marketProbability
    // With fees: we win (effectivePayout - marketPrice) but pay marketPrice
    const b = (effectivePayout - marketProbability) / marketProbability; // Adjusted odds
    const p = trueProbability;
    const q = 1 - p;

    // Kelly formula with fees: f = (p*b - q) / b
    let fullKelly = b > 0 ? (p * b - q) / b : 0;
    fullKelly = Math.max(0, fullKelly); // Never negative

    // Also compute the naive edge for comparison
    const naiveEdge = trueProbability - marketProbability;
    const feeAdjustedEdge = (p * effectivePayout) - marketProbability;

    // Apply fraction (half Kelly is more conservative)
    const fractionalKelly = fullKelly * this.kellyFraction;

    // Calculate bet amount
    const kellyBet = bankroll * Math.max(0, fractionalKelly);

    // Apply min/max constraints
    const maxBet = bankroll * this.maxPositionPct;
    const finalBet = Math.min(Math.max(kellyBet, this.minBetSize), maxBet);

    // If Kelly suggests less than min bet, don't bet at all
    if (kellyBet < this.minBetSize && kellyBet > 0) {
      return {
        fullKelly: fullKelly,
        fractionalKelly: fractionalKelly,
        kellyBet: kellyBet,
        recommendedBet: 0,
        percentOfBankroll: 0,
        reason: 'Kelly size below minimum',
        fee: fee,
        feeAdjusted: fee > 0,
      };
    }

    return {
      fullKelly: fullKelly,
      fractionalKelly: fractionalKelly,
      kellyBet: kellyBet,
      recommendedBet: Math.round(finalBet * 100) / 100,
      percentOfBankroll: (finalBet / bankroll) * 100,
      edge: naiveEdge,
      edgePct: (naiveEdge / marketProbability) * 100,
      feeAdjustedEdge: feeAdjustedEdge,
      fee: fee,
      feeAdjusted: fee > 0,
    };
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

    // Calculate total probability
    const totalProb = market.totalProbability;

    // IMPORTANT: Normalize Kalshi prices when totalProb > 1.0 (overround)
    // Kalshi markets sum to 101-102%, Polymarket to 95-98%
    // Normalization converts overpriced ranges to fair value for edge calculation
    let analysisRanges = market.ranges;
    let isOverround = false;
    let normalizedMispricingPct = market.mispricingPct;

    if (totalProb > 1.0) {
      isOverround = true;
      // Normalize: divide each price by totalProb to get fair value
      // A 20¢ range in a 101% market → ~19.8¢ fair value
      analysisRanges = market.ranges.map(r => ({
        ...r,
        price: r.price / totalProb,
        originalPrice: r.price, // Keep original for trade execution
      }));
      // Overround markets have negative mispricing (overpriced)
      normalizedMispricingPct = (1 - totalProb) * 100; // e.g., -1% for 101% market

      this.log('info', 'Kalshi overround normalized', {
        market: market.slug,
        totalProb: (totalProb * 100).toFixed(1) + '%',
        normalizedMispricing: normalizedMispricingPct.toFixed(1) + '%',
      });
    }

    // Find ranges that match forecast (use normalized prices for analysis)
    const matchingRanges = this.findMatchingRanges(analysisRanges, forecastTemp);

    // Check if there's enough edge (use normalized mispricing)
    if (normalizedMispricingPct < this.minMispricingPct && matchingRanges.length === 0) {
      return null;
    }

    // Find best range to trade (use normalized prices)
    const bestRange = this.findBestRange(analysisRanges, forecastTemp, matchingRanges);
    if (!bestRange) return null;

    // Minimum probability filter (risk management)
    if (bestRange.price < this.minProbability) {
      this.log('info', 'Range below minimum probability', {
        market: market.slug,
        range: bestRange.name,
        probability: (bestRange.price * 100).toFixed(1) + '%',
        minimum: (this.minProbability * 100).toFixed(0) + '%'
      });
      return null;
    }

    // Max price filter
    if (bestRange.price > this.maxRangePrice) {
      this.log('info', 'Range price too high', {
        market: market.slug,
        range: bestRange.name,
        price: bestRange.price,
        max: this.maxRangePrice
      });
      return null;
    }

    // Calculate true probability and edge
    // Use normalized price for probability estimation (removes bookmaker margin)
    // Use original/execution price for edge calculation (what we actually pay)
    const normalizedPrice = bestRange.price;
    const executionPrice = isOverround ? (bestRange.originalPrice || normalizedPrice * totalProb) : normalizedPrice;
    const trueProbability = this.estimateTrueProbability(normalizedPrice, forecast.confidence, true);
    const edge = trueProbability - executionPrice; // Edge vs what we PAY

    // Calculate expected value (use normalized mispricing)
    const ev = this.calculateExpectedValue(bestRange, forecast, normalizedMispricingPct);

    // Check for dual forecast agreement (NYC with Tomorrow.io)
    let adjustedConfidence = forecast.confidence;
    let forecastNote = null;

    if (forecast.tomorrowForecast && market.city === 'nyc') {
      const openMeteoTemp = market.unit === 'F' ? forecast.highF : forecast.highC;
      const tomorrowTemp = market.unit === 'F' ? forecast.tomorrowForecast.highF : forecast.tomorrowForecast.highC;
      const diff = Math.abs(openMeteoTemp - tomorrowTemp);

      if (diff <= 1) {
        // Both sources agree - boost confidence
        adjustedConfidence = 'very-high';
        forecastNote = `Sources agree: Open-Meteo ${openMeteoTemp.toFixed(0)}°, Tomorrow.io ${tomorrowTemp.toFixed(0)}°`;
      } else if (diff <= 2) {
        // Minor disagreement - keep current confidence
        forecastNote = `Minor diff: Open-Meteo ${openMeteoTemp.toFixed(0)}°, Tomorrow.io ${tomorrowTemp.toFixed(0)}°`;
      } else {
        // Significant disagreement - lower confidence
        adjustedConfidence = 'medium';
        forecastNote = `Sources differ: Open-Meteo ${openMeteoTemp.toFixed(0)}°, Tomorrow.io ${tomorrowTemp.toFixed(0)}° (${diff.toFixed(0)}° gap)`;
      }
    }

    // Build opportunity object
    // For overround markets, bestRange has normalized price but we need original for execution
    const originalPrice = isOverround ? (bestRange.originalPrice || bestRange.price * totalProb) : bestRange.price;

    return {
      market: market,
      forecast: forecast,
      forecastTemp: forecastTemp,
      totalProbability: totalProb,
      mispricingPct: normalizedMispricingPct, // Use normalized (negative for overround)
      bestRange: {
        ...bestRange,
        // Ensure original price is available for trade execution
        originalPrice: originalPrice,
        normalizedPrice: bestRange.price,
      },
      matchingRanges: matchingRanges,
      expectedValue: ev,
      confidence: adjustedConfidence,
      forecastNote: forecastNote,
      detectedAt: new Date().toISOString(),
      // Risk management fields (use execution price for edge and Kelly)
      marketProbability: executionPrice, // actual price we pay (for Kelly)
      trueProbability: trueProbability,  // estimated true prob (from normalized + confidence boost)
      edge: edge,
      edgePct: (edge / executionPrice) * 100, // Edge relative to what we pay
      // Overround info
      isOverround: isOverround,
      originalMarketPrice: originalPrice, // actual price to pay
    };
  }

  /**
   * Check if a forecast temperature would WIN a given range
   * This is STRICT boundary checking - the forecast must be INSIDE the range to win
   */
  forecastWouldWinRange(forecastTemp, range) {
    const { min, max } = range;

    // Handle boundary ranges correctly:
    // "X or below" (min = -Infinity, max = X): forecast must be <= X
    // "X or above" (min = X, max = Infinity): forecast must be >= X
    // "X-Y" range: forecast must be >= X and <= Y

    if (min === -Infinity || min <= -100) {
      // "X or below" range
      return forecastTemp <= max;
    }

    if (max === Infinity || max >= 100) {
      // "X or above" range
      return forecastTemp >= min;
    }

    // Standard range "X-Y"
    return forecastTemp >= min && forecastTemp <= max;
  }

  /**
   * Find ranges that match the forecast temperature
   * CRITICAL: Only returns ranges where forecast would actually WIN
   */
  findMatchingRanges(ranges, forecastTemp) {
    const matching = [];

    for (const range of ranges) {
      if (range.min === undefined) continue;

      // STRICT CHECK: Forecast must be INSIDE the range to win
      const wouldWin = this.forecastWouldWinRange(forecastTemp, range);

      if (wouldWin) {
        // Calculate how centered the forecast is in the range
        let centeredness = 1.0;
        if (range.max !== Infinity && range.min !== -Infinity) {
          const mid = (range.min + range.max) / 2;
          const rangeSize = range.max - range.min;
          centeredness = 1 - Math.abs(forecastTemp - mid) / (rangeSize / 2);
        }

        matching.push({
          ...range,
          matchType: centeredness > 0.5 ? 'exact' : 'edge',
          centeredness: centeredness
        });
      }
    }

    // Sort by how centered the forecast is (most centered first)
    matching.sort((a, b) => (b.centeredness || 0) - (a.centeredness || 0));

    return matching;
  }

  /**
   * Find the best range to trade
   * Only selects ranges where forecast would WIN (strict boundary check)
   */
  findBestRange(ranges, forecastTemp, matchingRanges) {
    // Only consider ranges where we'd actually win
    // matchingRanges already filtered by forecastWouldWinRange()

    if (matchingRanges.length === 0) {
      return null;
    }

    // First priority: well-centered match with good price
    const centeredMatch = matchingRanges.find(r =>
      r.matchType === 'exact' &&
      r.price >= this.minRangePrice &&
      r.price <= this.maxRangePrice
    );
    if (centeredMatch) return centeredMatch;

    // Second priority: edge match (forecast near boundary but still inside) with good price
    const edgeMatch = matchingRanges.find(r =>
      r.matchType === 'edge' &&
      r.price >= this.minRangePrice &&
      r.price <= this.maxRangePrice
    );
    if (edgeMatch) return edgeMatch;

    // Third priority: any winning range
    const anyMatch = matchingRanges.find(r =>
      r.price >= this.minRangePrice &&
      r.price <= this.maxRangePrice
    );
    if (anyMatch) return anyMatch;

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
   * Generate position sizes for an opportunity using Kelly Criterion
   *
   * @param {Object} opportunity - Detected opportunity
   * @param {number} capital - Available capital
   * @param {Object} config - Position config including fee rate
   */
  generatePositions(opportunity, capital, config = {}) {
    const range = opportunity.bestRange;
    // Use execution price for Kelly calculation (what we actually pay)
    const marketProbability = opportunity.marketProbability || range.originalPrice || range.price;
    const trueProbability = opportunity.trueProbability ||
      this.estimateTrueProbability(marketProbability, opportunity.confidence, true);

    // Use original price for trade execution (what we actually pay)
    const executionPrice = range.originalPrice || range.price;

    // Get platform fee rate (Kalshi ~1.2%, Polymarket 3.15%)
    const platform = opportunity.market?.platform || 'polymarket';
    const fee = config.fee ?? (platform === 'kalshi' ? 0.012 : 0.0315);

    // Calculate Kelly size with fee adjustment (uses normalized probability)
    const kelly = this.calculateKellySize(marketProbability, trueProbability, capital, fee);

    const positions = [];

    // Only create position if Kelly recommends it
    if (kelly.recommendedBet > 0) {
      const amount = kelly.recommendedBet;
      // Use execution price for share calculation (actual market price)
      const shares = amount / executionPrice;

      positions.push({
        range: range.name,
        tokenId: range.tokenId,
        side: 'BUY',
        price: executionPrice, // Actual price to pay
        amount: amount,
        shares: Math.floor(shares * 100) / 100,
        potentialPayout: Math.floor(shares),
        // Kelly info for logging
        kellyFraction: kelly.fractionalKelly,
        percentOfBankroll: kelly.percentOfBankroll,
        edgePct: kelly.edgePct,
        // Fee info
        platform: platform,
        feeRate: fee,
        feeAdjustedEdge: kelly.feeAdjustedEdge,
        // Overround info
        isOverround: opportunity.isOverround || false,
        normalizedPrice: marketProbability,
      });
    }

    return {
      positions,
      totalCost: positions.reduce((sum, p) => sum + p.amount, 0),
      maxPayout: positions.length > 0 ? Math.max(...positions.map(p => p.potentialPayout)) : 0,
      marketSlug: opportunity.market.slug,
      kelly: kelly, // Include Kelly details for logging
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

  /**
   * Check if a forecast shift is against an existing position
   * Returns true if the new forecast moves AWAY from the held range
   */
  isShiftAgainstPosition(existingPosition, newForecastTemp, marketUnit) {
    // Parse the range the user holds
    const heldRange = this.parseRangeFromName(existingPosition.range_name);
    if (!heldRange || heldRange.min === undefined) return false;

    // Check if new forecast falls outside their held range
    if (heldRange.max !== Infinity && heldRange.min !== -Infinity && heldRange.min > -100) {
      // Held range like "0°C" or "24-25°F"
      const rangeCenter = (heldRange.min + heldRange.max) / 2;
      const distanceFromHeld = Math.abs(newForecastTemp - rangeCenter);

      // If forecast is more than 1.5 degrees away from held range center, it's against
      return distanceFromHeld > 1.5;
    }

    // For "X or below" boundary ranges
    if (heldRange.min === -Infinity || heldRange.min <= -100) {
      // Holding "X or below" - shift against if forecast went above X
      return newForecastTemp > heldRange.max;
    }

    // For "X or above" boundary ranges
    if (heldRange.max === Infinity || heldRange.max >= 100) {
      // Holding "X or above" - shift against if forecast went below X
      return newForecastTemp < heldRange.min;
    }

    return false;
  }

  /**
   * Parse range bounds from a range name string
   * Similar to parseRange but for stored position names
   */
  parseRangeFromName(rangeStr) {
    if (!rangeStr) return null;

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

    return null;
  }

  /**
   * Create a hedge opportunity when forecast shifts against position
   */
  createHedgeOpportunity(market, forecast, forecastShift, existingPosition) {
    const newForecastTemp = market.unit === 'F' ? forecast.highF : forecast.highC;

    // Find ranges that match the NEW forecast
    const matchingRanges = this.findMatchingRanges(market.ranges, newForecastTemp);
    const newBestRange = this.findBestRange(market.ranges, newForecastTemp, matchingRanges);

    if (!newBestRange) {
      this.log('info', 'No hedge range found for new forecast', {
        market: market.slug,
        newForecast: newForecastTemp
      });
      return null;
    }

    // Don't hedge into the same range we already hold
    if (newBestRange.name === existingPosition.range_name) {
      return null;
    }

    // Apply same filters as regular trades
    if (newBestRange.price < this.minProbability) {
      this.log('info', 'Hedge range below minimum probability', {
        market: market.slug,
        range: newBestRange.name,
        probability: (newBestRange.price * 100).toFixed(1) + '%'
      });
      return null;
    }

    if (newBestRange.price > this.maxRangePrice) {
      this.log('info', 'Hedge range price too high', {
        market: market.slug,
        range: newBestRange.name,
        price: newBestRange.price
      });
      return null;
    }

    // Calculate EV for the hedge
    const ev = this.calculateForecastShiftEV(newBestRange, forecast, forecastShift);

    return {
      market: market,
      forecast: forecast,
      forecastTemp: newForecastTemp,
      forecastShift: forecastShift,
      bestRange: newBestRange,
      matchingRanges: matchingRanges,
      expectedValue: ev,
      confidence: forecast.confidence,
      strategy: 'forecast_arbitrage_hedge',
      isHedge: true,
      hedgingPosition: existingPosition.range_name,
      hedgingPositionId: existingPosition.id,
      hedgingPositionCost: parseFloat(existingPosition.cost),
      // Risk management fields
      marketProbability: newBestRange.price,
      trueProbability: this.estimateTrueProbability(newBestRange.price, forecast.confidence, true),
      totalProbability: market.totalProbability,
      mispricingPct: market.mispricingPct,
      detectedAt: new Date().toISOString(),
    };
  }

  /**
   * Calculate hedge size - 50% of original position by default
   */
  calculateHedgeSize(existingPosition, bankroll, hedgeRatio = 0.5) {
    const originalCost = parseFloat(existingPosition.cost) || 0;
    const hedgeSize = originalCost * hedgeRatio;

    // Apply min/max constraints
    const minBet = this.minBetSize;
    const maxBet = bankroll * this.maxPositionPct;

    return Math.min(Math.max(hedgeSize, minBet), maxBet);
  }

  /**
   * Analyze a precipitation market for mispricing opportunities
   *
   * @param {Object} market - Parsed precipitation market from MarketScanner
   * @param {Object} forecast - Monthly precipitation forecast from WeatherAPI
   * @returns {Object|null} - Opportunity or null if none found
   */
  analyzePrecipitationMarket(market, forecast) {
    if (!market || !forecast) return null;

    // Skip if market is closed or resolved
    if (market.closed || market.resolved) return null;

    // Get forecast precipitation in inches
    const forecastInches = forecast.estimatedMonthlyInches;

    // Find ranges that match forecast
    const matchingRanges = this.findMatchingPrecipitationRanges(market.ranges, forecastInches);

    // Calculate total probability
    const totalProb = market.totalProbability;
    const mispricingPct = market.mispricingPct;

    // Check if there's enough edge
    if (mispricingPct < this.minMispricingPct && matchingRanges.length === 0) {
      return null;
    }

    // Find best range to trade
    const bestRange = this.findBestRange(market.ranges, forecastInches, matchingRanges);
    if (!bestRange) return null;

    // Minimum probability filter (risk management)
    if (bestRange.price < this.minProbability) {
      this.log('info', 'Precipitation range below minimum probability', {
        market: market.slug,
        range: bestRange.name,
        probability: (bestRange.price * 100).toFixed(1) + '%',
        minimum: (this.minProbability * 100).toFixed(0) + '%'
      });
      return null;
    }

    if (bestRange.price > this.maxRangePrice) {
      this.log('info', 'Precipitation range price too high', {
        market: market.slug,
        range: bestRange.name,
        price: bestRange.price,
        max: this.maxRangePrice
      });
      return null;
    }

    // Calculate true probability and edge
    const marketProbability = bestRange.price;
    const trueProbability = this.estimateTrueProbability(marketProbability, forecast.confidence, true);
    const edge = trueProbability - marketProbability;

    // Calculate expected value (use lower confidence for precipitation due to monthly timeframe)
    const ev = this.calculatePrecipitationEV(bestRange, forecast, mispricingPct);

    // Build opportunity object
    return {
      market: market,
      forecast: forecast,
      forecastInches: forecastInches,
      totalProbability: totalProb,
      mispricingPct: mispricingPct,
      bestRange: bestRange,
      matchingRanges: matchingRanges,
      expectedValue: ev,
      confidence: forecast.confidence,
      strategy: 'precipitation',
      marketType: 'precipitation',
      detectedAt: new Date().toISOString(),
      // Risk management fields
      marketProbability: marketProbability,
      trueProbability: trueProbability,
      edge: edge,
      edgePct: (edge / marketProbability) * 100,
    };
  }

  /**
   * Find precipitation ranges that match the forecast
   */
  findMatchingPrecipitationRanges(ranges, forecastInches) {
    const matching = [];

    for (const range of ranges) {
      if (range.min === undefined) continue;

      // Check if forecast is in range or within 0.5 inches
      const inRange = forecastInches >= range.min && forecastInches <= range.max;
      const nearRange = forecastInches >= range.min - 0.5 && forecastInches <= range.max + 0.5;

      if (inRange) {
        matching.push({ ...range, matchType: 'exact' });
      } else if (nearRange) {
        matching.push({ ...range, matchType: 'near' });
      }
    }

    // Sort by closeness to forecast
    matching.sort((a, b) => {
      const aMid = (a.min + (a.max === Infinity ? a.min + 2 : a.max)) / 2;
      const bMid = (b.min + (b.max === Infinity ? b.min + 2 : b.max)) / 2;
      return Math.abs(forecastInches - aMid) - Math.abs(forecastInches - bMid);
    });

    return matching;
  }

  /**
   * Calculate expected value for precipitation position
   * More conservative than temperature due to monthly timeframe uncertainty
   */
  calculatePrecipitationEV(range, forecast, mispricingPct) {
    const price = range.price;

    // Base probability is the market price
    let adjustedProb = price;

    // Lower confidence multipliers for precipitation (more uncertainty)
    const confidenceMultiplier = {
      'very-high': 1.08,  // Lower than temperature
      'high': 1.05,
      'medium': 1.02,
      'low': 1.0,
    }[forecast.confidence] || 1.0;

    // Coverage bonus: more days covered = more confidence
    const coverageBonus = forecast.coverageRatio >= 0.8 ? 1.05 : 1.0;

    // Adjusted probability (capped at 0.85 for precipitation)
    adjustedProb = Math.min(price * confidenceMultiplier * coverageBonus, 0.85);

    // Add mispricing edge
    const mispricingEdge = mispricingPct / 100;
    const finalProb = Math.min(adjustedProb + mispricingEdge, 0.90);

    // EV per dollar spent
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
   * Rank precipitation opportunities
   */
  rankPrecipitationOpportunities(opportunities) {
    return opportunities
      .filter(o => o.expectedValue.isPositive)
      .sort((a, b) => {
        // Sort by forecast coverage first (higher coverage = more reliable)
        const coverageDiff = (b.forecast.coverageRatio || 0) - (a.forecast.coverageRatio || 0);
        if (Math.abs(coverageDiff) > 0.1) return coverageDiff;
        // Then by EV
        return b.expectedValue.evPerDollar - a.expectedValue.evPerDollar;
      });
  }
}

module.exports = { MispricingDetector };
