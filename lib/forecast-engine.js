/**
 * forecast-engine.js — Multi-source weather forecasts with caching and ensemble
 *
 * Sources: NWS (US cities), Open-Meteo (global), WeatherAPI (global)
 * Caching: Per-source, configurable expiry
 * Ensemble: Equal weight average with spread-based confidence + std dev
 */

const config = require('../config');

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const NWS_API_BASE = 'https://api.weather.gov';
const WEATHERAPI_BASE = 'https://api.weatherapi.com/v1';

const NWS_HEADERS = {
  'User-Agent': '(weather-trading-bot, weather-bot@example.com)',
  'Accept': 'application/geo+json',
};

function celsiusToFahrenheit(c) { return (c * 9 / 5) + 32; }
function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }

class ForecastEngine {
  constructor() {
    this.cache = new Map();   // key: `${source}:${city}` → { data, fetchedAt }
    this.cacheMinutes = config.forecasts.CACHE_MINUTES;
    this.stdDevs = config.forecasts.DEFAULT_STD_DEVS;
    this.log = this._log.bind(this);
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

    if (tempsF.length === 0) {
      this.log('warn', `No forecast available for ${city} on ${dateStr}`);
      return null;
    }

    // Outlier detection (3+ sources, >8°F deviation from others' avg)
    if (tempsF.length >= 3) {
      const sorted = [...tempsF].sort((a, b) => a - b);
      const lowAvg = (sorted[1] + sorted[2]) / 2;
      const highAvg = (sorted[0] + sorted[1]) / 2;

      let outlierVal = null;
      if (lowAvg - sorted[0] > 8) outlierVal = sorted[0];
      else if (sorted[2] - highAvg > 8) outlierVal = sorted[2];

      if (outlierVal != null) {
        // Remove outlier source
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

    // Ensemble: equal weight average
    const avgF = tempsF.reduce((a, b) => a + b, 0) / tempsF.length;
    const spreadF = tempsF.length > 1 ? Math.max(...tempsF) - Math.min(...tempsF) : 0;

    // Confidence from source agreement
    let confidence;
    if (tempsF.length >= 2 && spreadF <= 1) confidence = 'very-high';
    else if (tempsF.length >= 2 && spreadF <= 2) confidence = 'high';
    else if (tempsF.length >= 2 && spreadF <= 4) confidence = 'medium';
    else confidence = 'low';

    // Widen std dev when sources disagree
    let stdDevC = this.stdDevs[confidence];
    if (spreadF > 4) {
      // Add extra uncertainty proportional to disagreement
      // Note: spreadF is a temperature DELTA, not absolute — convert with *5/9 only
      stdDevC += (spreadF * 5 / 9) * 0.3;
    }

    // Convert ensemble to market unit
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

      const resp = await fetch(url);
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
      const pointResp = await fetch(pointUrl, { headers: NWS_HEADERS });
      if (!pointResp.ok) throw new Error(`NWS points ${pointResp.status}`);

      const pointData = await pointResp.json();
      const forecastUrl = pointData.properties?.forecast;
      if (!forecastUrl) throw new Error('No forecast URL');

      // Step 2: forecast
      const forecastResp = await fetch(forecastUrl, { headers: NWS_HEADERS });
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

      const resp = await fetch(url);
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
}

module.exports = ForecastEngine;
