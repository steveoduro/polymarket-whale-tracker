/**
 * forecast-engine.js — Multi-source weather forecasts with caching and ensemble
 *
 * Sources: NWS (US cities), Open-Meteo (global), WeatherAPI (global)
 * Caching: Per-source, configurable expiry
 * Ensemble: Equal weight average with spread-based confidence + std dev
 */

const config = require('../config');
const { db } = require('./db');

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const ECMWF_BASE = 'https://api.open-meteo.com/v1/ecmwf';
const GEM_BASE = 'https://api.open-meteo.com/v1/gem';
const UKMO_BASE = 'https://api.open-meteo.com/v1/forecast'; // uses ?models=ukmo_seamless
const NWS_API_BASE = 'https://api.weather.gov';
const WEATHERAPI_BASE = 'https://api.weatherapi.com/v1';

const NWS_HEADERS = {
  'User-Agent': '(weather-trading-bot, weather-bot@example.com)',
  'Accept': 'application/geo+json',
};

function celsiusToFahrenheit(c) { return (c * 9 / 5) + 32; }
function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }

// Minimum sample sizes for calibration
const MIN_BIAS_SAMPLES = 3;     // per source/unit (lowered from 5 to activate bias correction with existing data)
const MIN_STDDEV_SAMPLES = 10;  // per unit
const CALIBRATION_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

class ForecastEngine {
  constructor() {
    this.cache = new Map();   // key: `${source}:${city}` → { data, fetchedAt }
    this.cacheMinutes = config.forecasts.CACHE_MINUTES;
    this.stdDevs = config.forecasts.DEFAULT_STD_DEVS;
    this.log = this._log.bind(this);

    // Calibration data (loaded from v2_forecast_accuracy, cached with TTL)
    this.calibration = null;       // { biases, empiricalStdDevs, loadedAt, cityMAE, cityActiveSources, ... }

    // Weight delta logging: log once per city per calibration period
    this._weightDeltaLogged = new Set();
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const label = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Get forecast for a city/date. Returns ensemble result with all source data.
   * This is the main entry point — handles caching, fetching, and ensemble.
   *
   * @param {string} city - city key from config
   * @param {string} dateStr - YYYY-MM-DD
   * @returns {{ temp, unit, confidence, stdDev, sources, ensemble }}
   */
  async getForecast(city, dateStr) {
    const cityConfig = config.cities[city.toLowerCase()];
    if (!cityConfig) return null;

    const unit = cityConfig.unit; // 'F' or 'C'
    const isUS = !!cityConfig.nwsStation;

    // Fetch from ALL available sources in parallel (uses cache if fresh)
    const cityKey = city.toLowerCase();
    const [om, nws, wa, ecmwf, gem, ukmo] = await Promise.all([
      this._getOpenMeteo(city, cityConfig, dateStr),
      isUS ? this._getNWS(city, cityConfig, dateStr) : null,
      this._getWeatherAPI(city, cityConfig, dateStr),
      this._getECMWF(city, cityConfig, dateStr),
      cityKey === 'toronto' ? this._getGEM(city, cityConfig, dateStr) : null,
      cityKey === 'london' ? this._getUKMO(city, cityConfig, dateStr) : null,
    ]);

    // Collect all valid source results
    const allResults = {};
    if (om != null) allResults.openmeteo = om;
    if (nws != null) allResults.nws = nws;
    if (wa != null) allResults.weatherapi = wa;
    if (ecmwf != null) allResults.ecmwf = ecmwf;
    if (gem != null) allResults.gem = gem;
    if (ukmo != null) allResults.ukmo = ukmo;

    // Determine per-city active sources from calibration (Layer 2)
    const cal = await this._getCalibration();
    const DEFAULT_ACTIVE = new Set(['openmeteo', 'nws', 'weatherapi']);
    const activeSources = cal.cityActiveSources?.[cityKey] || DEFAULT_ACTIVE;

    // Split into active (contribute to ensemble) and shadow (tracked only)
    const sources = {};
    const tempsF = [];
    const activeSourceKeys = [];

    for (const [srcKey, temp] of Object.entries(allResults)) {
      sources[srcKey] = temp;
      if (activeSources.has(srcKey)) {
        tempsF.push(temp);
        activeSourceKeys.push(srcKey);
      }
    }

    if (tempsF.length === 0) {
      this.log('warn', `No forecast available for ${city} on ${dateStr}`);
      return null;
    }

    // Outlier detection (3+ sources): remove any source >8°F from the mean of the others
    if (tempsF.length >= 3) {
      let outlierVal = null;
      let maxDeviation = 0;
      for (let i = 0; i < tempsF.length; i++) {
        const others = tempsF.filter((_, j) => j !== i);
        const othersMean = others.reduce((a, b) => a + b, 0) / others.length;
        const deviation = Math.abs(tempsF[i] - othersMean);
        if (deviation > 8 && deviation > maxDeviation) {
          maxDeviation = deviation;
          outlierVal = tempsF[i];
        }
      }

      if (outlierVal != null) {
        for (const [key, val] of Object.entries(sources)) {
          if (val === outlierVal) {
            this.log('warn', 'Forecast outlier excluded', { city, date: dateStr, source: key, value: outlierVal });
            delete sources[key];
            tempsF.splice(tempsF.indexOf(outlierVal), 1);
            const askIdx = activeSourceKeys.indexOf(key);
            if (askIdx !== -1) activeSourceKeys.splice(askIdx, 1);
            break;
          }
        }
      }
    }

    // ── Bias correction (4-level cascade: per-city+lead → per-city → global+lead → global) ──
    // Subtract per-source measured bias before averaging.
    // Bias = avg(forecast - actual) from v2_forecast_accuracy.
    // Negative bias means cold → subtracting it ADDS to the forecast.
    const hoursToResolution = this._getHoursToResolution(dateStr, cityConfig.tz);

    // Determine lead-time bucket for bias lookup
    const leadBuckets = config.forecasts.LEAD_TIME_BUCKETS || [
      { name: 'near', min: 0, max: 6 },
      { name: 'same-day', min: 7, max: 24 },
      { name: 'next-day', min: 25, max: 48 },
      { name: 'multi-day', min: 49, max: Infinity },
    ];
    let leadBucket = null;
    if (hoursToResolution != null) {
      const bucket = leadBuckets.find(b => hoursToResolution >= b.min && hoursToResolution <= b.max);
      if (bucket) leadBucket = bucket.name;
    }

    const correctedTempsF = [];

    for (const srcKey of activeSourceKeys) {
      const rawF = sources[srcKey];

      // 4-level bias cascade — use the most specific available
      let biasEntry = null;

      // Level 1: per-city per-source lead-time-specific
      if (leadBucket) {
        const key1 = `${cityKey}:${srcKey}:${unit}:${leadBucket}`;
        const entry1 = cal.cityLeadBiases?.[key1];
        if (entry1 && entry1.n >= MIN_BIAS_SAMPLES) biasEntry = entry1;
      }

      // Level 2: per-city per-source pooled
      if (!biasEntry) {
        const key2 = `${cityKey}:${srcKey}:${unit}`;
        const entry2 = cal.cityBiases?.[key2];
        if (entry2 && entry2.n >= MIN_BIAS_SAMPLES) biasEntry = entry2;
      }

      // Level 3: global per-source lead-time-specific (existing)
      if (!biasEntry && leadBucket) {
        const key3 = `${srcKey}:${unit}:${leadBucket}`;
        const entry3 = cal.leadBiases?.[key3];
        if (entry3 && entry3.n >= MIN_BIAS_SAMPLES) biasEntry = entry3;
      }

      // Level 4: global per-source pooled (existing fallback)
      if (!biasEntry) {
        const key4 = `${srcKey}:${unit}`;
        const entry4 = cal.biases?.[key4];
        if (entry4 && entry4.n >= MIN_BIAS_SAMPLES) biasEntry = entry4;
      }

      let correctedF = rawF;
      if (biasEntry) {
        // Bias is in the city's unit. Convert to °F delta if city is °C.
        const biasF = unit === 'C' ? biasEntry.bias * (9 / 5) : biasEntry.bias;
        correctedF = rawF - biasF;
      }
      correctedTempsF.push(correctedF);
    }

    // ── Weighted or equal-weight averaging (Layer 4) ──
    const equalWeightAvgF = correctedTempsF.length > 0
      ? correctedTempsF.reduce((a, b) => a + b, 0) / correctedTempsF.length
      : tempsF.reduce((a, b) => a + b, 0) / tempsF.length;

    let avgF;
    const cityWeights = cal.citySourceWeights?.[cityKey];
    if (cityWeights && activeSourceKeys.length > 0 && activeSourceKeys.every(k => cityWeights[k])) {
      // Inverse-MAE weighted average
      let totalWeight = 0;
      let weightedSum = 0;
      for (let i = 0; i < activeSourceKeys.length; i++) {
        const w = cityWeights[activeSourceKeys[i]];
        weightedSum += correctedTempsF[i] * w;
        totalWeight += w;
      }
      avgF = weightedSum / totalWeight;

      // Log delta once per city per calibration period
      if (!this._weightDeltaLogged.has(cityKey)) {
        this._weightDeltaLogged.add(cityKey);
        const delta = avgF - equalWeightAvgF;
        this.log('info', `Weighted ensemble delta`, {
          city, weighted: Math.round(avgF * 10) / 10,
          equalWeight: Math.round(equalWeightAvgF * 10) / 10,
          delta: Math.round(delta * 10) / 10,
        });
      }
    } else {
      avgF = equalWeightAvgF;
    }
    const spreadF = tempsF.length > 1 ? Math.max(...tempsF) - Math.min(...tempsF) : 0;

    // Confidence from source agreement (still useful for logging/DB, no longer drives std dev)
    let confidence;
    if (tempsF.length >= 2 && spreadF <= 1) confidence = 'very-high';
    else if (tempsF.length >= 2 && spreadF <= 2) confidence = 'high';
    else if (tempsF.length >= 2 && spreadF <= 4) confidence = 'medium';
    else confidence = 'low';

    // Dual-station cities: bump confidence for logging (actual std dev no longer uses tiers)
    if (cityConfig.nwsStation && cityConfig.polymarketStation &&
        cityConfig.nwsStation !== cityConfig.polymarketStation) {
      if (confidence === 'very-high') confidence = 'high';
      else if (confidence === 'high') confidence = 'medium';
      else if (confidence === 'medium') confidence = 'low';
    }

    // ── Empirical std dev: per-city → pooled per-unit → hardcoded fallback ──
    const minCitySamples = config.forecasts.MIN_CITY_STDDEV_SAMPLES || 10;
    const cityStd = cal.cityStdDevs?.[cityKey];
    const empirical = cal.empiricalStdDevs[unit];
    let stdDevC;

    if (cityStd && cityStd.n >= minCitySamples) {
      // Per-city std dev (in city's unit) — convert to °C
      stdDevC = cityStd.unit === 'C' ? cityStd.stdDev : cityStd.stdDev * (5 / 9);
    } else if (empirical && empirical.n >= MIN_STDDEV_SAMPLES) {
      // Pooled per-unit
      stdDevC = unit === 'C' ? empirical.stdDev : empirical.stdDev * (5 / 9);
    } else {
      // Hardcoded fallback
      stdDevC = this.stdDevs[confidence];
      this.log('warn', `Using fallback std dev (${unit} n=${empirical?.n || 0} < ${MIN_STDDEV_SAMPLES})`, { city, confidence });
    }

    // Spread-based widening: if sources disagree by > 4°F, add extra uncertainty
    if (spreadF > 4) {
      stdDevC += (spreadF * 5 / 9) * 0.3;
    }

    // Dual-station additive: add ~1°C for cities with differing platform stations
    if (cityConfig.nwsStation && cityConfig.polymarketStation &&
        cityConfig.nwsStation !== cityConfig.polymarketStation) {
      stdDevC += 1.0; // ~1.8°F extra for station microclimate gap
    }

    // Scale std dev by days to resolution (sqrt growth — standard uncertainty propagation)
    if (hoursToResolution !== null) {
      const daysOut = Math.max(0.5, hoursToResolution / 24);
      const timeFactor = Math.sqrt(daysOut);
      stdDevC = stdDevC * timeFactor;
    }

    // Convert ensemble to market unit (using bias-corrected average)
    const tempInUnit = unit === 'C' ? fahrenheitToCelsius(avgF) : avgF;
    const roundedTemp = Math.round(tempInUnit * 10) / 10;

    // Source snapshot in market unit for DB storage
    const sourcesInUnit = {};
    for (const [key, valF] of Object.entries(sources)) {
      sourcesInUnit[key] = unit === 'C'
        ? Math.round(fahrenheitToCelsius(valF) * 10) / 10
        : Math.round(valF * 10) / 10;
    }

    return {
      city,
      date: dateStr,
      temp: roundedTemp,           // in market unit
      tempF: Math.round(avgF * 10) / 10,
      unit,
      confidence,
      stdDev: Math.round(stdDevC * 100) / 100,  // in °C (for normal distribution)
      sources: sourcesInUnit,       // individual source temps in market unit
      sourcesF: { ...sources },     // individual source temps in °F
      sourceCount: tempsF.length,
      spreadF: Math.round(spreadF * 10) / 10,
      hoursToResolution: hoursToResolution !== null ? Math.round(hoursToResolution * 10) / 10 : null,
    };
  }

  /**
   * Calculate probability that actual temp falls in [min, max] range
   * Uses normal distribution with ensemble mean and std dev.
   *
   * @param {number} forecastTemp - ensemble temp in market unit
   * @param {number} stdDev - in °C
   * @param {number|null} rangeMin - null for lower-unbounded
   * @param {number|null} rangeMax - null for upper-unbounded
   * @param {string} unit - 'F' or 'C'
   * @returns {number} probability 0-1
   */
  calculateProbability(forecastTemp, stdDev, rangeMin, rangeMax, unit) {
    // Convert everything to °C for calculation
    const meanC = unit === 'F' ? fahrenheitToCelsius(forecastTemp) : forecastTemp;
    const minC = rangeMin == null ? -Infinity : (unit === 'F' ? fahrenheitToCelsius(rangeMin) : rangeMin);
    const maxC = rangeMax == null ? Infinity : (unit === 'F' ? fahrenheitToCelsius(rangeMax) : rangeMax);

    if (minC === -Infinity && maxC === Infinity) return 1;
    if (minC === -Infinity) return this._normalCDF((maxC - meanC) / stdDev);
    if (maxC === Infinity) return 1 - this._normalCDF((minC - meanC) / stdDev);

    const p = this._normalCDF((maxC - meanC) / stdDev) - this._normalCDF((minC - meanC) / stdDev);
    return Math.min(1, Math.max(0, p));
  }

  /**
   * Hours until resolution for a target date in a given timezone.
   * Resolution = end of target_date local time (approx 23:00).
   * Returns null if timezone is unavailable.
   */
  _getHoursToResolution(dateStr, timezone) {
    try {
      const now = Date.now();
      // Use Intl to get current time in target timezone, then compute UTC offset
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      const nowUTC = new Date();
      const parts = formatter.formatToParts(nowUTC);
      const getPart = (type) => parseInt(parts.find(p => p.type === type)?.value || '0');
      // Use Date.UTC so offset is correct regardless of server timezone
      const localNow = new Date(Date.UTC(getPart('year'), getPart('month') - 1, getPart('day'),
        getPart('hour'), getPart('minute'), getPart('second')));
      const offsetMs = nowUTC.getTime() - localNow.getTime();

      // Resolution time in UTC = target_date 23:00 local + offset
      // Parse dateStr components to avoid server-timezone interpretation
      const [y, m, d] = dateStr.split('-').map(Number);
      const resolutionUTC = new Date(Date.UTC(y, m - 1, d, 23, 0, 0) + offsetMs);

      const hoursRemaining = (resolutionUTC.getTime() - now) / (1000 * 60 * 60);
      return Math.max(0, hoursRemaining);
    } catch {
      return null;
    }
  }

  /**
   * Standard normal CDF approximation (Abramowitz & Stegun)
   */
  _normalCDF(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;

    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1 / (1 + p * Math.abs(x));
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return 0.5 * (1 + sign * y);
  }

  // ── Source fetchers (with caching) ─────────────────────────────

  async _getOpenMeteo(city, cityConfig, dateStr) {
    const cacheKey = `openmeteo:${city}`;
    const cached = this._getCached(cacheKey);
    if (cached) {
      const day = cached.find(d => d.date === dateStr);
      return day ? day.highF : null;
    }

    try {
      const fetch = (await import('node-fetch')).default;
      const url = `${OPEN_METEO_BASE}?latitude=${cityConfig.lat}&longitude=${cityConfig.lon}` +
        `&daily=temperature_2m_max,temperature_2m_min&timezone=${encodeURIComponent(cityConfig.tz)}&forecast_days=16`;

      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const forecasts = data.daily.time.map((date, i) => ({
        date,
        highF: Math.round(celsiusToFahrenheit(data.daily.temperature_2m_max[i]) * 10) / 10,
      }));

      this._setCache(cacheKey, forecasts);
      const day = forecasts.find(d => d.date === dateStr);
      return day ? day.highF : null;
    } catch (err) {
      this.log('warn', `Open-Meteo fetch failed for ${city}`, { error: err.message });
      return null;
    }
  }

  async _getNWS(city, cityConfig, dateStr) {
    const cacheKey = `nws:${city}`;
    const cached = this._getCached(cacheKey);
    if (cached) {
      const day = cached.find(d => d.date === dateStr);
      return day ? day.highF : null;
    }

    try {
      const fetch = (await import('node-fetch')).default;

      // Step 1: grid point
      const pointUrl = `${NWS_API_BASE}/points/${cityConfig.lat.toFixed(4)},${cityConfig.lon.toFixed(4)}`;
      const pointResp = await fetch(pointUrl, { headers: NWS_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!pointResp.ok) throw new Error(`NWS points ${pointResp.status}`);

      const pointData = await pointResp.json();
      const forecastUrl = pointData.properties?.forecast;
      if (!forecastUrl) throw new Error('No forecast URL');

      // Step 2: forecast
      const forecastResp = await fetch(forecastUrl, { headers: NWS_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!forecastResp.ok) throw new Error(`NWS forecast ${forecastResp.status}`);

      const forecastData = await forecastResp.json();
      const periods = forecastData.properties?.periods || [];

      const forecasts = [];
      for (const period of periods) {
        if (!period.isDaytime) continue;
        const pDate = new Date(period.startTime).toISOString().split('T')[0];
        forecasts.push({ date: pDate, highF: period.temperature });
      }

      this._setCache(cacheKey, forecasts);
      const day = forecasts.find(d => d.date === dateStr);
      return day ? day.highF : null;
    } catch (err) {
      this.log('warn', `NWS fetch failed for ${city}`, { error: err.message });
      return null;
    }
  }

  async _getWeatherAPI(city, cityConfig, dateStr) {
    const apiKey = process.env.WEATHERAPI_KEY;
    if (!apiKey) return null;

    const cacheKey = `weatherapi:${city}`;
    const cached = this._getCached(cacheKey);
    if (cached) {
      const day = cached.find(d => d.date === dateStr);
      return day ? day.highF : null;
    }

    try {
      const fetch = (await import('node-fetch')).default;
      const url = `${WEATHERAPI_BASE}/forecast.json?key=${apiKey}&q=${cityConfig.lat},${cityConfig.lon}&days=14&aqi=no`;

      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const forecasts = (data.forecast?.forecastday || []).map(d => ({
        date: d.date,
        highF: d.day.maxtemp_f,
      }));

      this._setCache(cacheKey, forecasts);
      const day = forecasts.find(d => d.date === dateStr);
      return day ? day.highF : null;
    } catch (err) {
      this.log('warn', `WeatherAPI fetch failed for ${city}`, { error: err.message });
      return null;
    }
  }

  // ── Shadow source fetchers ───────────────────────────────────

  async _getECMWF(city, cityConfig, dateStr) {
    const cacheKey = `ecmwf:${city}`;
    const cached = this._getCached(cacheKey);
    if (cached) {
      const day = cached.find(d => d.date === dateStr);
      return day ? day.highF : null;
    }

    try {
      const fetch = (await import('node-fetch')).default;
      const url = `${ECMWF_BASE}?latitude=${cityConfig.lat}&longitude=${cityConfig.lon}` +
        `&daily=temperature_2m_max&timezone=${encodeURIComponent(cityConfig.tz)}&forecast_days=16`;

      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const forecasts = data.daily.time.map((date, i) => ({
        date,
        highF: data.daily.temperature_2m_max[i] != null
          ? Math.round(celsiusToFahrenheit(data.daily.temperature_2m_max[i]) * 10) / 10
          : null,
      })).filter(d => d.highF != null);

      this._setCache(cacheKey, forecasts);
      const day = forecasts.find(d => d.date === dateStr);
      return day ? day.highF : null;
    } catch (err) {
      this.log('warn', `ECMWF fetch failed for ${city}`, { error: err.message });
      return null;
    }
  }

  async _getGEM(city, cityConfig, dateStr) {
    const cacheKey = `gem:${city}`;
    const cached = this._getCached(cacheKey);
    if (cached) {
      const day = cached.find(d => d.date === dateStr);
      return day ? day.highF : null;
    }

    try {
      const fetch = (await import('node-fetch')).default;
      const url = `${GEM_BASE}?latitude=${cityConfig.lat}&longitude=${cityConfig.lon}` +
        `&daily=temperature_2m_max&timezone=${encodeURIComponent(cityConfig.tz)}&forecast_days=16`;

      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const forecasts = data.daily.time.map((date, i) => ({
        date,
        highF: data.daily.temperature_2m_max[i] != null
          ? Math.round(celsiusToFahrenheit(data.daily.temperature_2m_max[i]) * 10) / 10
          : null,
      })).filter(d => d.highF != null);

      this._setCache(cacheKey, forecasts);
      const day = forecasts.find(d => d.date === dateStr);
      return day ? day.highF : null;
    } catch (err) {
      this.log('warn', `GEM fetch failed for ${city}`, { error: err.message });
      return null;
    }
  }

  async _getUKMO(city, cityConfig, dateStr) {
    const cacheKey = `ukmo:${city}`;
    const cached = this._getCached(cacheKey);
    if (cached) {
      const day = cached.find(d => d.date === dateStr);
      return day ? day.highF : null;
    }

    try {
      const fetch = (await import('node-fetch')).default;
      const url = `${UKMO_BASE}?models=ukmo_seamless&latitude=${cityConfig.lat}&longitude=${cityConfig.lon}` +
        `&daily=temperature_2m_max&timezone=${encodeURIComponent(cityConfig.tz)}&forecast_days=7`;

      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data = await resp.json();
      const forecasts = data.daily.time.map((date, i) => ({
        date,
        highF: data.daily.temperature_2m_max[i] != null
          ? Math.round(celsiusToFahrenheit(data.daily.temperature_2m_max[i]) * 10) / 10
          : null,
      })).filter(d => d.highF != null);

      this._setCache(cacheKey, forecasts);
      const day = forecasts.find(d => d.date === dateStr);
      return day ? day.highF : null;
    } catch (err) {
      this.log('warn', `UKMO fetch failed for ${city}`, { error: err.message });
      return null;
    }
  }

  // ── City Eligibility (Layer 1) ─────────────────────────────────

  /**
   * Check if a city is eligible for trading based on forecast MAE.
   * @param {string} cityKey - lowercased city key
   * @returns {{ mae, n, unit, allowBounded, allowUnbounded }}
   */
  async getCityEligibility(cityKey) {
    const cal = await this._getCalibration();
    const cityData = cal.cityMAE?.[cityKey.toLowerCase()];
    const CE = config.forecasts.CITY_ELIGIBILITY || {};
    const minSamples = CE.MIN_SAMPLES || 5;

    // No data or insufficient samples → allow all (don't block with no evidence)
    if (!cityData || cityData.n < minSamples) {
      return { mae: cityData?.mae ?? null, n: cityData?.n ?? 0, unit: cityData?.unit ?? null, allowBounded: true, allowUnbounded: true };
    }

    const boundedMax = cityData.unit === 'C' ? (CE.BOUNDED_MAX_MAE_C || 1.5) : (CE.BOUNDED_MAX_MAE_F || 2.5);
    const unboundedMax = cityData.unit === 'C' ? (CE.UNBOUNDED_MAX_MAE_C || 2.0) : (CE.UNBOUNDED_MAX_MAE_F || 4.0);

    return {
      mae: cityData.mae,
      n: cityData.n,
      unit: cityData.unit,
      allowBounded: cityData.mae <= boundedMax,
      allowUnbounded: cityData.mae <= unboundedMax,
    };
  }

  // ── Cache helpers ──────────────────────────────────────────────

  _getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > this.cacheMinutes * 60 * 1000) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  _setCache(key, data) {
    this.cache.set(key, { data, fetchedAt: Date.now() });
  }

  /**
   * Clear all cached data (call when you want to force refresh)
   */
  clearCache() {
    this.cache.clear();
  }

  // ── Calibration data (bias correction + empirical std dev) ───────

  /**
   * Get calibration data (cached with 6-hour TTL).
   * Returns { biases: { 'source:unit': { bias, stdDev, n } }, empiricalStdDevs: { 'F': {...}, 'C': {...} } }
   */
  async _getCalibration() {
    if (this.calibration && (Date.now() - this.calibration.loadedAt < CALIBRATION_CACHE_MS)) {
      return this.calibration;
    }

    try {
      const cal = await this._loadCalibrationFromDB();
      this.calibration = { ...cal, loadedAt: Date.now() };
      return this.calibration;
    } catch (err) {
      this.log('warn', 'Failed to load calibration data, using empty', { error: err.message });
      if (!this.calibration) {
        this.calibration = {
          biases: {}, empiricalStdDevs: {}, cityStdDevs: {}, leadBiases: {},
          cityMAE: {}, cityActiveSources: {}, citySourceWeights: {},
          cityBiases: {}, cityLeadBiases: {}, citySourceRanking: {},
          loadedAt: Date.now(),
        };
      }
      return this.calibration;
    }
  }

  /**
   * Load bias corrections and empirical std devs from v2_forecast_accuracy.
   * Computes per-source bias and pooled residual std dev per unit.
   */
  async _loadCalibrationFromDB() {
    const windowDays = config.forecasts.CALIBRATION_WINDOW_DAYS || 21;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const { data, error } = await db
      .from('v2_forecast_accuracy')
      .select('source, unit, error, abs_error, city, hours_before_resolution')
      .gte('target_date', cutoffStr)
      .order('target_date', { ascending: false })
      .limit(2000);

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      this.log('info', 'No calibration data in v2_forecast_accuracy — using defaults');
      return { biases: {}, empiricalStdDevs: {} };
    }

    this.log('info', `Calibration window: ${windowDays} days (since ${cutoffStr}), ${data.length} records`);

    // ── Per-source bias ──
    const bySourceUnit = {};
    for (const row of data) {
      const key = `${row.source}:${row.unit}`;
      if (!bySourceUnit[key]) bySourceUnit[key] = [];
      bySourceUnit[key].push(row.error);
    }

    const biases = {};
    for (const [key, errors] of Object.entries(bySourceUnit)) {
      const n = errors.length;
      const bias = errors.reduce((a, b) => a + b, 0) / n;
      const residuals = errors.map(e => e - bias);
      const stdDev = n > 1
        ? Math.sqrt(residuals.reduce((a, b) => a + b * b, 0) / (n - 1))
        : 0;
      biases[key] = {
        bias: Math.round(bias * 100) / 100,
        stdDev: Math.round(stdDev * 100) / 100,
        n,
      };
    }

    // ── Pooled residual std dev per unit (after per-source bias removal) ──
    const residualsByUnit = { F: [], C: [] };
    for (const row of data) {
      const srcKey = `${row.source}:${row.unit}`;
      const srcBias = biases[srcKey]?.bias || 0;
      const residual = row.error - srcBias;
      if (residualsByUnit[row.unit]) {
        residualsByUnit[row.unit].push(residual);
      }
    }

    const empiricalStdDevs = {};
    for (const [unit, residuals] of Object.entries(residualsByUnit)) {
      if (residuals.length === 0) continue;
      const n = residuals.length;
      const stdDev = n > 1
        ? Math.sqrt(residuals.reduce((a, b) => a + b * b, 0) / (n - 1))
        : 0;
      empiricalStdDevs[unit] = {
        stdDev: Math.round(stdDev * 100) / 100,
        n,
      };
    }

    // ── Per-city residual std dev (after per-source bias removal) ──
    const minCitySamples = config.forecasts.MIN_CITY_STDDEV_SAMPLES || 10;
    const residualsByCity = {};
    for (const row of data) {
      const srcKey = `${row.source}:${row.unit}`;
      const srcBias = biases[srcKey]?.bias || 0;
      const residual = row.error - srcBias;
      const cityKey = row.city?.toLowerCase();
      if (!cityKey) continue;
      if (!residualsByCity[cityKey]) residualsByCity[cityKey] = { residuals: [], unit: row.unit };
      residualsByCity[cityKey].residuals.push(residual);
    }

    const cityStdDevs = {};
    for (const [cityKey, { residuals, unit }] of Object.entries(residualsByCity)) {
      const n = residuals.length;
      if (n >= minCitySamples) {
        const stdDev = Math.sqrt(residuals.reduce((a, b) => a + b * b, 0) / (n - 1));
        cityStdDevs[cityKey] = { stdDev: Math.round(stdDev * 100) / 100, n, unit };
      }
    }

    // ── Lead-time bucketed bias per source ──
    const LEAD_BUCKETS = config.forecasts.LEAD_TIME_BUCKETS || [
      { name: 'near', min: 0, max: 6 },
      { name: 'same-day', min: 7, max: 24 },
      { name: 'next-day', min: 25, max: 48 },
      { name: 'multi-day', min: 49, max: Infinity },
    ];

    const bySourceUnitLead = {};
    for (const row of data) {
      if (row.hours_before_resolution == null) continue;
      const bucket = LEAD_BUCKETS.find(b =>
        row.hours_before_resolution >= b.min && row.hours_before_resolution <= b.max);
      if (!bucket) continue;
      const key = `${row.source}:${row.unit}:${bucket.name}`;
      if (!bySourceUnitLead[key]) bySourceUnitLead[key] = [];
      bySourceUnitLead[key].push(row.error);
    }

    const leadBiases = {};
    for (const [key, errors] of Object.entries(bySourceUnitLead)) {
      const n = errors.length;
      if (n >= MIN_BIAS_SAMPLES) {
        const bias = errors.reduce((a, b) => a + b, 0) / n;
        leadBiases[key] = { bias: Math.round(bias * 100) / 100, n };
      }
    }

    // ── Layer 2 first: Per-city per-source MAE ranking + active source sets ──
    // (Computed before Layer 1 so cityMAE only reflects active sources)
    const SM = config.forecasts.SOURCE_MANAGEMENT || {};
    const DEMOTION_MAE = { F: SM.DEMOTION_MAE_F || 4.0, C: SM.DEMOTION_MAE_C || 2.0 };
    const SM_MIN_SAMPLES = SM.MIN_SAMPLES || 7;
    const MIN_ACTIVE = SM.MIN_ACTIVE_SOURCES || 2;
    const WEIGHT_MIN = SM.WEIGHT_MIN_SAMPLES || 3;
    const RELATIVE_FACTOR = SM.RELATIVE_DEMOTION_FACTOR || 1.8;
    const SOFT_MAX_WEIGHT = SM.SOFT_DEMOTION_MAX_WEIGHT || 0.10;

    const byCitySource = {};
    for (const row of data) {
      const ck = row.city?.toLowerCase();
      if (!ck || row.abs_error == null) continue;
      const key = `${ck}:${row.source}`;
      if (!byCitySource[key]) byCitySource[key] = { errors: [], absErrors: [], unit: row.unit, source: row.source, city: ck };
      byCitySource[key].errors.push(row.error);
      byCitySource[key].absErrors.push(row.abs_error);
    }

    // Build per-city rankings
    const citySourceRanking = {};
    for (const [, entry] of Object.entries(byCitySource)) {
      const { city: ck, source, absErrors, unit } = entry;
      if (!citySourceRanking[ck]) citySourceRanking[ck] = [];
      const n = absErrors.length;
      const mae = absErrors.reduce((a, b) => a + b, 0) / n;
      citySourceRanking[ck].push({ source, mae: Math.round(mae * 100) / 100, n, unit });
    }
    // Sort each city's sources by MAE ascending (best first)
    for (const ck of Object.keys(citySourceRanking)) {
      citySourceRanking[ck].sort((a, b) => a.mae - b.mae);
    }

    // Determine active/demoted per city (relative + absolute threshold)
    const DEFAULT_ACTIVE = new Set(['openmeteo', 'nws', 'weatherapi']);
    const cityActiveSources = {};
    const citySoftDemoted = {};
    for (const [ck, rankings] of Object.entries(citySourceRanking)) {
      const cityUnit = rankings[0]?.unit || 'F';
      const absoluteThreshold = DEMOTION_MAE[cityUnit] || 4.0;

      // Find best source MAE among those with sufficient samples
      const qualified = rankings.filter(r => r.n >= SM_MIN_SAMPLES);
      const bestMAE = qualified.length > 0 ? qualified[0].mae : null;
      const relativeThreshold = bestMAE != null ? bestMAE * RELATIVE_FACTOR : null;

      // Start with all sources as active candidates
      const active = new Set(rankings.map(r => r.source));
      const softDemoted = new Set();

      // Demote worst first
      for (let i = rankings.length - 1; i >= 0; i--) {
        const r = rankings[i];
        if (r.n < SM_MIN_SAMPLES) continue;

        const exceedsAbsolute = r.mae > absoluteThreshold;
        const exceedsRelative = relativeThreshold != null && r.mae > relativeThreshold;

        if (exceedsAbsolute || exceedsRelative) {
          const reason = exceedsAbsolute ? 'absolute' : 'relative';
          if (active.size > MIN_ACTIVE) {
            active.delete(r.source);
            this.log('info', `Source demotion: ${ck}/${r.source} FULL (${reason}, MAE=${r.mae}°${cityUnit}${relativeThreshold ? ', rel_threshold=' + relativeThreshold.toFixed(2) : ''})`);
          } else {
            softDemoted.add(r.source);
            this.log('info', `Source demotion: ${ck}/${r.source} SOFT (${reason}, MAE=${r.mae}°${cityUnit}, capped at ${SOFT_MAX_WEIGHT * 100}% weight)`);
          }
        }
      }

      cityActiveSources[ck] = active;
      citySoftDemoted[ck] = softDemoted;
    }

    // ── Layer 1: Per-city MAE (active sources only — for city eligibility gate) ──
    // Computed AFTER Layer 2 so demoted sources don't inflate a city's MAE
    const cityMAE = {};
    for (const [ck, rankings] of Object.entries(citySourceRanking)) {
      const active = cityActiveSources[ck] || new Set();
      const activeRankings = rankings.filter(r => active.has(r.source));
      if (activeRankings.length === 0) continue;
      // Weighted by sample count: each source's MAE weighted by how many records it has
      let totalN = 0;
      let weightedMAE = 0;
      for (const r of activeRankings) {
        weightedMAE += r.mae * r.n;
        totalN += r.n;
      }
      cityMAE[ck] = { mae: Math.round((weightedMAE / totalN) * 100) / 100, n: totalN, unit: activeRankings[0].unit };
    }

    // ── Layer 3: Per-city per-source bias (4-level cascade) ──
    const cityBiases = {};
    for (const [, entry] of Object.entries(byCitySource)) {
      const { city: ck, source, errors, unit } = entry;
      const n = errors.length;
      if (n >= MIN_BIAS_SAMPLES) {
        const bias = errors.reduce((a, b) => a + b, 0) / n;
        const key = `${ck}:${source}:${unit}`;
        cityBiases[key] = { bias: Math.round(bias * 100) / 100, n };
      }
    }

    // Per-city per-source lead-time bias
    const byCitySourceLead = {};
    for (const row of data) {
      if (row.hours_before_resolution == null) continue;
      const ck = row.city?.toLowerCase();
      if (!ck) continue;
      const bucket = LEAD_BUCKETS.find(b =>
        row.hours_before_resolution >= b.min && row.hours_before_resolution <= b.max);
      if (!bucket) continue;
      const key = `${ck}:${row.source}:${row.unit}:${bucket.name}`;
      if (!byCitySourceLead[key]) byCitySourceLead[key] = [];
      byCitySourceLead[key].push(row.error);
    }

    const cityLeadBiases = {};
    for (const [key, errors] of Object.entries(byCitySourceLead)) {
      const n = errors.length;
      if (n >= MIN_BIAS_SAMPLES) {
        const bias = errors.reduce((a, b) => a + b, 0) / n;
        cityLeadBiases[key] = { bias: Math.round(bias * 100) / 100, n };
      }
    }

    // ── Layer 4: Per-city inverse-MAE source weights (with soft-demotion caps) ──
    const citySourceWeights = {};
    for (const [ck, rankings] of Object.entries(citySourceRanking)) {
      const active = cityActiveSources[ck] || new Set();
      const softDemoted = citySoftDemoted[ck] || new Set();
      const qualified = rankings.filter(r => active.has(r.source) && r.n >= WEIGHT_MIN);
      if (qualified.length === 0) continue;

      const inverseMAEs = qualified.map(r => 1 / Math.max(r.mae, 0.1));
      const total = inverseMAEs.reduce((a, b) => a + b, 0);

      // Compute base weights
      const weights = {};
      qualified.forEach((r, i) => {
        weights[r.source] = inverseMAEs[i] / total;
      });

      // Apply soft-demotion caps: cap weight, redistribute excess to non-demoted sources
      let excess = 0;
      const nonDemoted = [];
      for (const src of Object.keys(weights)) {
        if (softDemoted.has(src) && weights[src] > SOFT_MAX_WEIGHT) {
          excess += weights[src] - SOFT_MAX_WEIGHT;
          weights[src] = SOFT_MAX_WEIGHT;
        } else if (!softDemoted.has(src)) {
          nonDemoted.push(src);
        }
      }
      if (excess > 0 && nonDemoted.length > 0) {
        const nonDemotedTotal = nonDemoted.reduce((a, src) => a + weights[src], 0);
        for (const src of nonDemoted) {
          weights[src] += excess * (weights[src] / nonDemotedTotal);
        }
      }

      citySourceWeights[ck] = {};
      for (const [src, w] of Object.entries(weights)) {
        citySourceWeights[ck][src] = Math.round(w * 1000) / 1000;
      }
    }

    // Log calibration state
    const biasKeys = Object.entries(biases)
      .filter(([, v]) => v.n >= MIN_BIAS_SAMPLES)
      .map(([k, v]) => `${k}=${v.bias > 0 ? '+' : ''}${v.bias}(n=${v.n})`);
    const stdKeys = Object.entries(empiricalStdDevs)
      .filter(([, v]) => v.n >= MIN_STDDEV_SAMPLES)
      .map(([k, v]) => `${k}=${v.stdDev}°(n=${v.n})`);

    const cityStdKeys = Object.entries(cityStdDevs)
      .map(([k, v]) => `${k}=${v.stdDev}°${v.unit}(n=${v.n})`);
    const leadKeys = Object.entries(leadBiases)
      .map(([k, v]) => `${k}=${v.bias > 0 ? '+' : ''}${v.bias}(n=${v.n})`);

    this.log('info', 'Calibration loaded', {
      biases: biasKeys.length > 0 ? biasKeys.join(', ') : 'none (insufficient data)',
      empiricalStdDevs: stdKeys.length > 0 ? stdKeys.join(', ') : 'none (insufficient data)',
      cityStdDevs: cityStdKeys.length > 0 ? cityStdKeys.join(', ') : 'none (insufficient data)',
      leadBiases: leadKeys.length > 0 ? leadKeys.join(', ') : 'none (insufficient data)',
      totalRows: data.length,
    });

    // Log city eligibility (once per calibration refresh)
    const CE = config.forecasts.CITY_ELIGIBILITY || {};
    for (const [ck, d] of Object.entries(cityMAE)) {
      const boundedMax = d.unit === 'C' ? (CE.BOUNDED_MAX_MAE_C || 1.5) : (CE.BOUNDED_MAX_MAE_F || 2.5);
      const unboundedMax = d.unit === 'C' ? (CE.UNBOUNDED_MAX_MAE_C || 2.0) : (CE.UNBOUNDED_MAX_MAE_F || 4.0);
      const minSamples = CE.MIN_SAMPLES || 5;
      if (d.n < minSamples) {
        this.log('info', `City gate: ${ck} fully eligible (MAE ${d.mae}°${d.unit}, n=${d.n} < min_samples ${minSamples})`);
      } else if (d.mae > unboundedMax) {
        this.log('info', `City gate: ${ck} BLOCKED (MAE ${d.mae}°${d.unit} > ${unboundedMax}° threshold, n=${d.n})`);
      } else if (d.mae > boundedMax) {
        this.log('info', `City gate: ${ck} unbounded-only (MAE ${d.mae}°${d.unit} > ${boundedMax}° bounded threshold, n=${d.n})`);
      } else {
        this.log('info', `City gate: ${ck} fully eligible (MAE ${d.mae}°${d.unit}, n=${d.n})`);
      }
    }

    // Log source rankings per city (once per calibration refresh)
    for (const [ck, rankings] of Object.entries(citySourceRanking)) {
      const active = cityActiveSources[ck] || new Set();
      const softDemoted = citySoftDemoted[ck] || new Set();
      const parts = rankings.map(r => {
        let status = '';
        if (!active.has(r.source)) status = ' DEMOTED';
        else if (softDemoted.has(r.source)) status = ' SOFT-DEMOTED';
        return `${r.source}(${r.mae}°${status})`;
      });
      this.log('info', `Source ranking for ${ck}: ${parts.join(' > ')}`);
    }

    // Log per-city biases (once per calibration refresh)
    const cityBiasKeys = Object.entries(cityBiases)
      .map(([k, v]) => `${k}=${v.bias > 0 ? '+' : ''}${v.bias}(n=${v.n})`);
    if (cityBiasKeys.length > 0) {
      this.log('info', `Per-city biases: ${cityBiasKeys.join(', ')}`);
    }

    // Reset weight delta logging for new calibration period
    this._weightDeltaLogged = new Set();

    return { biases, empiricalStdDevs, cityStdDevs, leadBiases,
             cityMAE, cityActiveSources, citySourceWeights, cityBiases, cityLeadBiases, citySourceRanking };
  }
}

module.exports = ForecastEngine;
