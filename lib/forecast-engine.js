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
const MIN_BIAS_SAMPLES = 5;     // per source/unit
const MIN_STDDEV_SAMPLES = 10;  // per unit
const CALIBRATION_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

class ForecastEngine {
  constructor() {
    this.cache = new Map();   // key: `${source}:${city}` → { data, fetchedAt }
    this.cacheMinutes = config.forecasts.CACHE_MINUTES;
    this.stdDevs = config.forecasts.DEFAULT_STD_DEVS;
    this.log = this._log.bind(this);

    // Calibration data (loaded from v2_forecast_accuracy, cached with TTL)
    this.calibration = null;       // { biases, empiricalStdDevs, loadedAt }
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

    // Fetch from all available sources (uses cache if fresh)
    const [om, nws, wa] = await Promise.all([
      this._getOpenMeteo(city, cityConfig, dateStr),
      isUS ? this._getNWS(city, cityConfig, dateStr) : null,
      this._getWeatherAPI(city, cityConfig, dateStr),
    ]);

    // Collect valid temps in Fahrenheit for ensemble
    const sources = {};
    const tempsF = [];

    if (om != null) { sources.openmeteo = om; tempsF.push(om); }
    if (nws != null) { sources.nws = nws; tempsF.push(nws); }
    if (wa != null) { sources.weatherapi = wa; tempsF.push(wa); }

    // Shadow sources — fetch in parallel, log only, do NOT add to tempsF
    const cityKey = city.toLowerCase();
    const [ecmwf, gem, ukmo] = await Promise.all([
      this._getECMWF(city, cityConfig, dateStr),
      cityKey === 'toronto' ? this._getGEM(city, cityConfig, dateStr) : null,
      cityKey === 'london' ? this._getUKMO(city, cityConfig, dateStr) : null,
    ]);
    if (ecmwf != null) sources.ecmwf = ecmwf;
    if (gem != null) sources.gem = gem;
    if (ukmo != null) sources.ukmo = ukmo;

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
            break;
          }
        }
      }
    }

    // ── Bias correction (Task 1) ──────────────────────────────────
    // Subtract per-source measured bias before averaging.
    // Bias = avg(forecast - actual) from v2_forecast_accuracy.
    // Negative bias means cold → subtracting it ADDS to the forecast.
    const cal = await this._getCalibration();
    const activeSourceKeys = Object.keys(sources).filter(k => tempsF.includes(sources[k]));
    const correctedTempsF = [];

    for (const srcKey of activeSourceKeys) {
      const rawF = sources[srcKey];
      // Look up bias: use city's unit to find the matching bias entry
      const biasKey = `${srcKey}:${unit}`;
      const biasEntry = cal.biases[biasKey];
      let correctedF = rawF;

      if (biasEntry && biasEntry.n >= MIN_BIAS_SAMPLES) {
        // Bias is in the city's unit. Convert to °F delta if city is °C.
        const biasF = unit === 'C' ? biasEntry.bias * (9 / 5) : biasEntry.bias;
        correctedF = rawF - biasF;
      }
      correctedTempsF.push(correctedF);
    }

    const avgF = correctedTempsF.length > 0
      ? correctedTempsF.reduce((a, b) => a + b, 0) / correctedTempsF.length
      : tempsF.reduce((a, b) => a + b, 0) / tempsF.length;
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

    // ── Empirical std dev (Task 2) ──────────────────────────────
    // Use measured residual std dev from accuracy data (after bias removal).
    // Falls back to hardcoded confidence tiers if insufficient data.
    const empirical = cal.empiricalStdDevs[unit];
    let stdDevC;
    if (empirical && empirical.n >= MIN_STDDEV_SAMPLES) {
      // Empirical std dev is in the city's unit — convert to °C
      stdDevC = unit === 'C' ? empirical.stdDev : empirical.stdDev * (5 / 9);
    } else {
      // Fallback to hardcoded tiers
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
    const hoursToResolution = this._getHoursToResolution(dateStr, cityConfig.tz);
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
        this.calibration = { biases: {}, empiricalStdDevs: {}, loadedAt: Date.now() };
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
      .select('source, unit, error, abs_error')
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

    // Log calibration state
    const biasKeys = Object.entries(biases)
      .filter(([, v]) => v.n >= MIN_BIAS_SAMPLES)
      .map(([k, v]) => `${k}=${v.bias > 0 ? '+' : ''}${v.bias}(n=${v.n})`);
    const stdKeys = Object.entries(empiricalStdDevs)
      .filter(([, v]) => v.n >= MIN_STDDEV_SAMPLES)
      .map(([k, v]) => `${k}=${v.stdDev}°(n=${v.n})`);

    this.log('info', 'Calibration loaded', {
      biases: biasKeys.length > 0 ? biasKeys.join(', ') : 'none (insufficient data)',
      empiricalStdDevs: stdKeys.length > 0 ? stdKeys.join(', ') : 'none (insufficient data)',
      totalRows: data.length,
    });

    return { biases, empiricalStdDevs };
  }
}

module.exports = ForecastEngine;
