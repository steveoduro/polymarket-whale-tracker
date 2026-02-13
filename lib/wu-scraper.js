/**
 * wu-scraper.js — Weather Underground data via Weather.com API
 *
 * Uses the Weather.com v1 historical observations API (same data source
 * that powers WU's history page). No HTML scraping or headless browser needed.
 *
 * API: api.weather.com/v1/location/{STATION}:9:{COUNTRY}/observations/historical.json
 * - US stations: `max_temp` field in last observation = daily high (integer °F)
 * - International: `max_temp` is null — compute max from hourly `temp` readings
 * - API key is the well-known WU public key embedded in their frontend
 */

const config = require('../config');

const WU_API_BASE = 'https://api.weather.com/v1/location';
const WU_API_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';
const REQUEST_DELAY_MS = 2500; // Rate limit: 2.5s between requests

class WUScraper {
  constructor() {
    this.fetchModule = null;
    this.lastRequestAt = 0;
  }

  async _fetch(url) {
    if (!this.fetchModule) {
      this.fetchModule = (await import('node-fetch')).default;
    }

    // Rate limiting
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < REQUEST_DELAY_MS) {
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS - elapsed));
    }
    this.lastRequestAt = Date.now();

    return this.fetchModule(url, { signal: AbortSignal.timeout(15000) });
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const label = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[WU]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Get the daily high temperature from Weather Underground for a station/date.
   *
   * @param {string} stationId - ICAO station code (e.g., 'KORD', 'NZWN')
   * @param {string} dateStr - 'YYYY-MM-DD'
   * @param {string} countryCode - ISO 2-letter country code (e.g., 'US', 'NZ')
   * @param {string} unit - 'F' or 'C' — determines which units to request
   * @returns {{ highF: number, highC: number, source: 'wunderground', maxTempField: number|null } | null}
   */
  async getHighTemp(stationId, dateStr, countryCode, unit) {
    if (!stationId || !countryCode) return null;

    const dateCompact = dateStr.replace(/-/g, '');
    const unitParam = unit === 'C' ? 'm' : 'e'; // m=metric, e=imperial
    const locationId = `${stationId}:9:${countryCode}`;
    const url = `${WU_API_BASE}/${locationId}/observations/historical.json?apiKey=${WU_API_KEY}&units=${unitParam}&startDate=${dateCompact}&endDate=${dateCompact}`;

    try {
      const resp = await this._fetch(url);
      if (!resp.ok) {
        this._log('warn', `WU API HTTP ${resp.status}`, { stationId, date: dateStr });
        return null;
      }

      const data = await resp.json();
      const observations = data?.observations;
      if (!Array.isArray(observations) || observations.length === 0) {
        this._log('warn', 'WU API returned no observations', { stationId, date: dateStr });
        return null;
      }

      // US stations have max_temp in the last observation; international don't
      const lastObs = observations[observations.length - 1];
      const maxTempField = lastObs.max_temp;

      // Compute max from all hourly readings as fallback/verification
      const temps = observations
        .map(o => o.temp)
        .filter(t => t != null);

      if (temps.length === 0) {
        this._log('warn', 'WU API: no temp readings in observations', { stationId, date: dateStr });
        return null;
      }

      const computedMax = Math.max(...temps);

      // Use max_temp field if available (captures sub-hourly peaks), otherwise computed
      const high = maxTempField != null ? maxTempField : computedMax;

      let highF, highC;
      if (unit === 'C') {
        highC = high;
        highF = Math.round(high * 9 / 5 + 32);
      } else {
        highF = high;
        highC = Math.round((high - 32) * 5 / 9);
      }

      return {
        highF,
        highC,
        source: 'wunderground',
        maxTempField,
        computedMax,
        observationCount: observations.length,
      };
    } catch (err) {
      this._log('warn', `WU API fetch failed`, { stationId, date: dateStr, error: err.message });
      return null;
    }
  }

  /**
   * Get WU high temp for a city using config-based station/country lookup.
   * Automatically uses the Polymarket station (WU's resolution source).
   */
  async getHighTempForCity(city, dateStr) {
    const cityConfig = config.cities[city.toLowerCase()];
    if (!cityConfig) return null;

    const stationId = cityConfig.polymarketStation || cityConfig.nwsStation;
    const countryCode = cityConfig.wuCountry;
    if (!stationId || !countryCode) return null;

    return this.getHighTemp(stationId, dateStr, countryCode, cityConfig.unit);
  }
}

module.exports = WUScraper;
