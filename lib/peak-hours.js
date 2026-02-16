/**
 * peak-hours.js — Dynamic per-city peak hour from METAR observation history
 *
 * Computes when each city typically hits its daily high temperature,
 * then adds a safety buffer to determine the "cooling hour" — the
 * local hour after which temps are assumed to only drop.
 *
 * Shared singleton: imported by both scanner and monitor.
 * .get(cityKey) is synchronous (safe for use in sync methods).
 */

const config = require('../config');
const { querySQL } = require('./db');

const _cache = {};    // { cityKey: coolingHour }
let _initialized = false;

function _log(msg, data) {
  const ts = new Date().toISOString();
  const suffix = data ? ' ' + JSON.stringify(data) : '';
  console.log(`${ts} \x1b[36m[PEAK-HOURS]\x1b[0m ${msg}${suffix}`);
}

/**
 * Initialize peak hours for all cities. Call once at startup.
 */
async function initialize() {
  if (!config.observer.DYNAMIC_PEAK_HOUR) {
    _log('Dynamic peak hours disabled — using static COOLING_HOUR');
    _initialized = true;
    return;
  }

  const windowDays = config.forecasts.CALIBRATION_WINDOW_DAYS || 21;
  const buffer = config.observer.PEAK_HOUR_BUFFER || 2;
  const minHour = config.observer.PEAK_HOUR_MIN || 14;
  const maxHour = config.observer.PEAK_HOUR_MAX || 20;
  const minSamples = config.observer.PEAK_HOUR_MIN_SAMPLES || 3;
  const fallback = config.observer.COOLING_HOUR || 17;

  try {
    // Get the latest observation per city/date where temp equaled the running high
    // (the moment the daily peak was reached). DISTINCT ON picks the latest such
    // observation per day. Rounds °C to 1 decimal to handle float precision.
    const sql = `
      SELECT DISTINCT ON (city, target_date)
        city, target_date, observed_at
      FROM metar_observations
      WHERE target_date >= current_date - interval '${windowDays} days'
        AND (
          (temp_f IS NOT NULL AND running_high_f IS NOT NULL AND temp_f = running_high_f)
          OR (ROUND(temp_c::numeric, 1) IS NOT NULL AND ROUND(running_high_c::numeric, 1) IS NOT NULL
              AND ROUND(temp_c::numeric, 1) = ROUND(running_high_c::numeric, 1))
        )
      ORDER BY city, target_date, observed_at DESC
    `;

    const rows = await querySQL(sql);
    if (!rows || rows.length === 0) {
      _log('No peak observations found — using static fallback');
      _initialized = true;
      return;
    }

    // Group by city, convert observed_at to local hour, average
    const cityPeaks = {}; // { cityKey: [localHour, localHour, ...] }

    for (const row of rows) {
      const cityKey = row.city;
      const cityConfig = config.cities[cityKey];
      if (!cityConfig) continue;

      // Convert UTC observed_at to local hour
      const observedAt = new Date(row.observed_at);
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: cityConfig.tz, hour: '2-digit', hour12: false,
      });
      const parts = formatter.formatToParts(observedAt);
      const localHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');

      if (!cityPeaks[cityKey]) cityPeaks[cityKey] = [];
      cityPeaks[cityKey].push(localHour);
    }

    // Compute cooling hour per city: avg peak + buffer, clamped
    const logParts = [];
    for (const [cityKey, hours] of Object.entries(cityPeaks)) {
      if (hours.length < minSamples) {
        _cache[cityKey] = fallback;
        logParts.push(`${cityKey}=${fallback}(fallback, n=${hours.length})`);
        continue;
      }
      const avgPeak = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
      const coolingHour = Math.min(maxHour, Math.max(minHour, avgPeak + buffer));
      _cache[cityKey] = coolingHour;
      logParts.push(`${cityKey}=${avgPeak}→${coolingHour}(n=${hours.length})`);
    }

    _log(`Peak hours computed: ${logParts.join(', ')}`);
  } catch (err) {
    _log(`Failed to compute peak hours — using static fallback: ${err.message}`);
  }

  _initialized = true;
}

/**
 * Get the cooling hour for a city. Synchronous (reads from cache).
 * Returns the dynamic value if available, otherwise static fallback.
 */
function get(cityKey) {
  if (!config.observer.DYNAMIC_PEAK_HOUR) {
    return config.observer.COOLING_HOUR || 17;
  }
  return _cache[cityKey] || config.observer.COOLING_HOUR || 17;
}

module.exports = { initialize, get };
