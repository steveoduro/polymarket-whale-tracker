/**
 * metar-observer.js — Real-time intraday temperature tracking
 *
 * Polls current METAR observations for cities with open positions.
 * Tracks running daily high per city/date in metar_observations table.
 * Called every 30 minutes from the bot loop during active hours.
 *
 * Data feeds into the exit evaluator for guaranteed_win/loss detection.
 */

const config = require('../config');
const { query, queryOne } = require('./db');
const WUScraper = require('./wu-scraper');

const METAR_API_BASE = 'https://aviationweather.gov/api/data/metar';

class METARObserver {
  constructor(alerts, platformAdapter) {
    this.alerts = alerts;
    this.adapter = platformAdapter;
    this.fetchModule = null;
    this.wuScraper = new WUScraper();
    this._pendingAlerted = new Set(); // debounce: city_date_platform_rangeName_side — reset daily
    this._pendingAlertedDate = null;
    this._wuLeadsLogged = new Set(); // debounce: city_date_stationId per day
    this._wuLeadsLoggedDate = null;
  }

  async _fetch(url) {
    if (!this.fetchModule) {
      this.fetchModule = (await import('node-fetch')).default;
    }
    return this.fetchModule(url, { signal: AbortSignal.timeout(15000) });
  }

  _log(level, msg, data) {
    const ts = new Date().toISOString();
    const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    const label = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[OBSERVER]';
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    console.log(`${ts} ${color}${label}\x1b[0m ${msg}${suffix}`);
  }

  /**
   * Compute UTC start/end for a local calendar date in a given timezone.
   * Same logic as resolver's _getUTCWindowForLocalDate (handles UTC+13 etc).
   */
  _getUTCWindowForLocalDate(dateStr, timezone) {
    const utcDate = new Date(`${dateStr}T12:00:00Z`);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false, minute: '2-digit', second: '2-digit',
    });
    const parts = formatter.formatToParts(utcDate);
    const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0');
    const localAsUTC = new Date(Date.UTC(get('year'), get('month') - 1, get('day'),
      get('hour'), get('minute'), get('second')));
    const offsetMs = localAsUTC.getTime() - utcDate.getTime();
    const startUTC = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs);
    const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
    return { startUTC, endUTC };
  }

  /**
   * Get the local hour for a timezone (for active hours check).
   */
  _getLocalHour(timezone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    return parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  }

  /**
   * Get today's date in a city's local timezone.
   */
  _getLocalToday(timezone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  }

  /**
   * Poll METAR observations for all eligible cities (not just those with open positions).
   * This enables guaranteed-win entry detection even before any position exists.
   * Returns { citiesPolled, newHighs, observations }
   */
  async observe() {
    const stats = { citiesPolled: 0, newHighs: 0, observations: [] };

    // Get open trades to know which platforms are active per city
    const { data: openTrades, error } = await query(
      'SELECT city, target_date, platform FROM trades WHERE status = $1',
      ['open']
    );

    if (error) {
      this._log('warn', 'Failed to load open trades for observer', { error: error.message });
    }

    // Build city map from open trades
    const cityTrades = new Map();
    for (const trade of (openTrades || [])) {
      const cityKey = trade.city.toLowerCase();
      const cityConfig = config.cities[cityKey];
      if (!cityConfig) continue;

      if (!cityTrades.has(cityKey)) {
        cityTrades.set(cityKey, {
          stations: new Set(),
          platforms: new Set(),
          targetDates: new Set(),
          tz: cityConfig.tz,
          unit: cityConfig.unit,
        });
      }

      const entry = cityTrades.get(cityKey);
      entry.targetDates.add(trade.target_date);
      entry.platforms.add(trade.platform);

      const station = trade.platform === 'kalshi'
        ? (cityConfig.nwsStation || cityConfig.polymarketStation)
        : (cityConfig.polymarketStation || cityConfig.nwsStation);
      if (station) entry.stations.add(station);
    }

    // Expand to ALL config.cities — ensures observations exist for guaranteed-win entries
    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
      if (cityTrades.has(cityKey)) {
        // Already has entries from open trades — just ensure today's date is included
        const entry = cityTrades.get(cityKey);
        const localToday = this._getLocalToday(cityConfig.tz);
        entry.targetDates.add(localToday);
        // Add default stations if not already present
        if (cityConfig.polymarketStation) entry.stations.add(cityConfig.polymarketStation);
        if (cityConfig.nwsStation) entry.stations.add(cityConfig.nwsStation);
        if (cityConfig.polymarketStation) entry.platforms.add('polymarket');
        if (cityConfig.nwsStation) entry.platforms.add('kalshi');
      } else {
        // No open trades — add with default station
        const station = cityConfig.polymarketStation || cityConfig.nwsStation;
        if (!station) continue;
        const localToday = this._getLocalToday(cityConfig.tz);
        cityTrades.set(cityKey, {
          stations: new Set([station]),
          platforms: new Set(cityConfig.polymarketStation ? ['polymarket'] : ['kalshi']),
          targetDates: new Set([localToday]),
          tz: cityConfig.tz,
          unit: cityConfig.unit,
        });
      }
    }

    const { start: activeStart, end: activeEnd } = config.observer.ACTIVE_HOURS;

    for (const [cityKey, info] of cityTrades) {
      // Skip cities outside active hours
      const localHour = this._getLocalHour(info.tz);
      if (localHour < activeStart || localHour >= activeEnd) continue;

      // Only observe today's date (not future dates)
      const localToday = this._getLocalToday(info.tz);
      if (!info.targetDates.has(localToday)) continue;

      // All cities: running_high = Math.max(WU, METAR) for fastest peak detection
      // WU catches peaks faster; METAR is fallback if WU unavailable
      const hasPolymarket = info.platforms.has('polymarket');

      for (const stationId of info.stations) {
        try {
          const obs = await this._pollStation(cityKey, stationId, localToday, info.tz, info.unit);
          if (obs) {
            stats.citiesPolled++;
            stats.observations.push(obs);
            if (obs.isNewHigh) stats.newHighs++;

            // Poll WU for cross-validation + authoritative running high
            const wuObs = await this._pollWU(cityKey, localToday);
            if (wuObs) {
              // Always store WU data for cross-validation
              await this._updateWUData(cityKey, localToday, obs.observedAt, wuObs);

              const metarHigh = info.unit === 'C' ? obs.runningHighC : obs.runningHighF;
              const wuHigh = info.unit === 'C' ? wuObs.highC : wuObs.highF;

              if (metarHigh !== wuHigh) {
                this._log('warn', `Intraday METAR vs WU mismatch: ${cityKey}`, {
                  metar: metarHigh, wu: wuHigh, diff: Math.abs(metarHigh - wuHigh),
                  primary: hasPolymarket ? 'WU' : 'METAR',
                });
              }

              // All cities: WU drives the running high for fastest peak detection
              const authHighF = Math.max(wuObs.highF, obs.runningHighF);
              const authHighC = Math.max(wuObs.highC, obs.runningHighC);
              if (authHighF !== obs.runningHighF || authHighC !== obs.runningHighC) {
                await query(
                  `UPDATE metar_observations
                   SET running_high_f = $1, running_high_c = $2
                   WHERE city = $3 AND target_date = $4 AND observed_at = $5`,
                  [authHighF, authHighC, cityKey, localToday, obs.observedAt]
                );
                this._log('info', `WU peak update: ${cityKey}`, {
                  metar: metarHigh, wu: wuHigh,
                  runningHigh: info.unit === 'C' ? authHighC : authHighF,
                });
              }
              // Check WU-leads-METAR pattern (morning hours only)
              await this._checkWULeads(cityKey, stationId, localHour, localToday, obs, wuObs, info.unit);
            } else {
              // WU failed — METAR fallback
              this._log('warn', `WU unavailable for ${cityKey}, using METAR fallback`);
            }

            // Check for METAR pending alerts (METAR crossed but WU hasn't confirmed)
            await this._checkMetarPending(cityKey, localToday, obs, wuObs, info.unit);
          }
        } catch (err) {
          this._log('warn', `Observer failed for ${cityKey}/${stationId}`, { error: err.message });
        }
      }
    }

    if (stats.citiesPolled > 0) {
      this._log('info', 'Observation cycle complete', {
        citiesPolled: stats.citiesPolled,
        newHighs: stats.newHighs,
      });
    }

    return stats;
  }

  /**
   * Poll a single station for latest METAR observation.
   * Updates running high in metar_observations table.
   */
  async _pollStation(city, stationId, dateStr, timezone, unit) {
    // Fetch latest METAR
    const url = `${METAR_API_BASE}?ids=${stationId}&format=json`;
    const resp = await this._fetch(url);
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const latest = data[0];
    if (latest.temp == null || latest.obsTime == null) return null;

    const tempC = latest.temp;
    const tempF = Math.round(tempC * 9 / 5 + 32);
    const observedAt = new Date(latest.obsTime * 1000);

    // Verify this observation belongs to the target local date
    const { startUTC, endUTC } = this._getUTCWindowForLocalDate(dateStr, timezone);
    if (observedAt < startUTC || observedAt >= endUTC) return null;

    // Get current running high from DB
    const { data: existing } = await query(
      `SELECT running_high_c, running_high_f, observation_count
       FROM metar_observations
       WHERE city = $1 AND target_date = $2 AND station_id = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [city, dateStr, stationId]
    );

    const prevHighC = existing?.[0]?.running_high_c ?? -Infinity;
    const prevHighF = existing?.[0]?.running_high_f ?? -Infinity;
    const prevCount = existing?.[0]?.observation_count ?? 0;
    const isNewHigh = tempC > prevHighC;

    const runningHighC = Math.max(tempC, prevHighC === -Infinity ? tempC : prevHighC);
    const runningHighF = Math.max(tempF, prevHighF === -Infinity ? tempF : prevHighF);

    // Insert observation row
    const { error: insertErr } = await query(
      `INSERT INTO metar_observations
         (city, station_id, target_date, observed_at, temp_c, temp_f,
          running_high_c, running_high_f, observation_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (city, target_date, observed_at) DO UPDATE SET
         station_id = EXCLUDED.station_id,
         temp_c = EXCLUDED.temp_c,
         temp_f = EXCLUDED.temp_f,
         running_high_c = EXCLUDED.running_high_c,
         running_high_f = EXCLUDED.running_high_f,
         observation_count = EXCLUDED.observation_count`,
      [city, stationId, dateStr, observedAt.toISOString(), tempC, tempF,
       runningHighC, runningHighF, prevCount + 1]
    );

    if (insertErr) {
      this._log('warn', `Failed to insert observation`, { city, error: insertErr.message });
    }

    if (isNewHigh) {
      this._log('info', `New daily high: ${city} ${stationId}`, {
        temp: unit === 'C' ? `${tempC}°C` : `${tempF}°F`,
        runningHigh: unit === 'C' ? `${runningHighC}°C` : `${runningHighF}°F`,
      });
    }

    return {
      city,
      stationId,
      tempC,
      tempF,
      runningHighC,
      runningHighF,
      isNewHigh,
      observedAt: observedAt.toISOString(),
    };
  }

  /**
   * Poll WU API for intraday high. Returns { highF, highC, observationCount } or null.
   */
  async _pollWU(cityKey, targetDate) {
    try {
      const result = await this.wuScraper.getHighTempForCity(cityKey, targetDate);
      if (!result) return null;
      return {
        highF: result.highF,
        highC: result.highC,
        observationCount: result.observationCount,
        source: 'wunderground',
      };
    } catch (err) {
      this._log('warn', `WU intraday poll failed for ${cityKey}`, { error: err.message });
      return null;
    }
  }

  /**
   * Check if METAR has crossed a range threshold but WU hasn't confirmed yet.
   * Logs to metar_pending_events table for Strategy A data collection.
   * DB row = debounce for persistence; in-memory Set = debounce for alerts only.
   */
  async _checkMetarPending(cityKey, targetDate, metarObs, wuObs, unit) {
    if (!this.adapter || !this.alerts) return;
    if (!config.guaranteed_entry?.ENABLED) return;

    // Reset alert debounce daily
    const today = new Date().toISOString().split('T')[0];
    if (this._pendingAlertedDate !== today) {
      this._pendingAlerted = new Set();
      this._pendingAlertedDate = today;
    }

    try {
      const ranges = await this.adapter.getMarkets(cityKey, targetDate);
      if (!ranges || ranges.length === 0) return;

      const metarHigh = unit === 'C' ? metarObs.runningHighC : metarObs.runningHighF;
      const wuHigh = wuObs ? (unit === 'C' ? wuObs.highC : wuObs.highF) : null;
      if (metarHigh == null) return;

      // Batch-load existing events for this city+date
      const { data: existing } = await query(
        `SELECT id, platform, range_name, side, ask_at_detection, wu_confirmed_at, market_repriced_at
         FROM metar_pending_events WHERE city = $1 AND target_date = $2`,
        [cityKey, targetDate]
      );
      const eventMap = new Map();
      for (const evt of (existing || [])) {
        eventMap.set(`${evt.platform}_${evt.range_name}_${evt.side}`, evt);
      }

      const newAlerts = [];

      for (const range of ranges) {
        if (config.platforms[range.platform]?.tradingEnabled === false) continue;

        // Determine if METAR crossed and compute side
        let side = null, threshold = null, metarGap = null;

        // Unbounded YES ("X or higher"): METAR >= range_min
        if (range.rangeMax == null && range.rangeMin != null && metarHigh >= range.rangeMin) {
          if (wuHigh != null && wuHigh >= range.rangeMin) continue; // Both crossed — not pending
          side = 'YES'; threshold = range.rangeMin; metarGap = metarHigh - range.rangeMin;
        }

        // Bounded NO: METAR > range_max
        if (range.rangeMin != null && range.rangeMax != null && metarHigh > range.rangeMax) {
          if (wuHigh != null && wuHigh > range.rangeMax) continue; // Both crossed
          side = 'NO'; threshold = range.rangeMax; metarGap = metarHigh - range.rangeMax;
        }

        if (!side) continue;

        const winningAsk = side === 'YES' ? range.ask : (1 - range.bid);
        const evtKey = `${range.platform}_${range.rangeName}_${side}`;
        const existingEvt = eventMap.get(evtKey);

        if (!existingEvt) {
          // FIRST DETECTION — INSERT
          await query(
            `INSERT INTO metar_pending_events
               (city, target_date, platform, range_name, side, range_min, range_max,
                range_unit, metar_high, wu_high, metar_gap, ask_at_detection)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (city, target_date, platform, range_name, side) DO NOTHING`,
            [cityKey, targetDate, range.platform, range.rangeName, side,
             range.rangeMin, range.rangeMax, unit, metarHigh, wuHigh,
             metarGap, winningAsk]
          );

          // Alert (debounce by in-memory Set)
          const alertKey = `${cityKey}_${targetDate}_${range.platform}_${range.rangeName}_${side}`;
          if (!this._pendingAlerted.has(alertKey)) {
            this._pendingAlerted.add(alertKey);
            newAlerts.push(range.rangeName);
          }
        } else {
          // SUBSEQUENT POLL — UPDATE wu_confirmed_at and market_repriced_at
          const updates = [];
          const params = [];
          let paramIdx = 1;

          // WU confirmation check (set once)
          if (!existingEvt.wu_confirmed_at && wuHigh != null) {
            const wuCrossed = (side === 'YES' && wuHigh >= threshold)
                           || (side === 'NO' && wuHigh > threshold);
            if (wuCrossed) {
              updates.push(`wu_confirmed_at = $${paramIdx++}`);
              params.push(new Date().toISOString());
            }
          }

          // Market repricing check (set ONCE when winning ask > MAX_ASK)
          if (!existingEvt.market_repriced_at && winningAsk > config.guaranteed_entry.MAX_ASK) {
            updates.push(`market_repriced_at = $${paramIdx++}`);
            params.push(new Date().toISOString());
          }

          // Always update latest observation values
          updates.push(`metar_high = $${paramIdx++}`);
          params.push(metarHigh);
          if (wuHigh != null) {
            updates.push(`wu_high = $${paramIdx++}`);
            params.push(wuHigh);
          }

          if (updates.length > 0) {
            params.push(existingEvt.id);
            await query(
              `UPDATE metar_pending_events SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
              params
            );
          }
        }
      }

      // Send consolidated alert for new detections
      if (newAlerts.length > 0) {
        await this.alerts.metarPending({
          city: cityKey,
          date: targetDate,
          metarHigh,
          wuHigh,
          unit,
          rangesAffected: newAlerts,
        });
      }
    } catch (err) {
      this._log('warn', `METAR pending check failed for ${cityKey}`, { error: err.message });
    }
  }

  /**
   * Detect WU-leads-METAR pattern: WU reports higher temp than METAR during morning hours.
   * Logs to wu_leads_events table for Strategy B data collection.
   * On subsequent polls, updates metar_confirmed_at when METAR catches up.
   */
  async _checkWULeads(cityKey, stationId, localHour, targetDate, metarObs, wuObs, unit) {
    // Reset debounce daily
    const today = new Date().toISOString().split('T')[0];
    if (this._wuLeadsLoggedDate !== today) {
      this._wuLeadsLogged = new Set();
      this._wuLeadsLoggedDate = today;
    }

    const maxHour = config.observer.WU_LEAD_MAX_LOCAL_HOUR || 12;
    const minGapF = config.observer.WU_LEAD_MIN_GAP_F || 2.5;
    const minGapC = config.observer.WU_LEAD_MIN_GAP_C || 1.5;

    const gapF = (wuObs.highF || 0) - (metarObs.runningHighF || 0);
    const gapC = (wuObs.highC || 0) - (metarObs.runningHighC || 0);
    const meetsThreshold = unit === 'C' ? gapC >= minGapC : gapF >= minGapF;

    const dedupeKey = `${cityKey}_${targetDate}_${stationId}`;

    try {
      // Check for existing row (needed for METAR-confirmed updates even after noon)
      const existingRow = await queryOne(
        `SELECT id, metar_confirmed_at FROM wu_leads_events
         WHERE city = $1 AND target_date = $2 AND station_id = $3`,
        [cityKey, targetDate, stationId]
      );

      if (existingRow) {
        // Existing row: check if METAR has caught up (gap shrunk below threshold)
        if (!existingRow.metar_confirmed_at && !meetsThreshold) {
          const metarHigh = unit === 'C' ? metarObs.runningHighC : metarObs.runningHighF;
          await query(
            `UPDATE wu_leads_events
             SET metar_confirmed_at = $1, metar_confirmed_high = $2
             WHERE id = $3`,
            [new Date().toISOString(), metarHigh, existingRow.id]
          );
          this._log('info', `WU-leads METAR confirmed: ${cityKey}`, { metarHigh, unit });
        }
        return;
      }

      // New detection — only during morning hours
      if (localHour >= maxHour) return;
      if (!meetsThreshold) return;
      if (this._wuLeadsLogged.has(dedupeKey)) return;

      // Get affected ranges
      let rangesAffected = [];
      if (this.adapter) {
        const ranges = await this.adapter.getMarkets(cityKey, targetDate);
        if (ranges) {
          rangesAffected = ranges
            .filter(r => {
              if (config.platforms[r.platform]?.tradingEnabled === false) return false;
              // Range where WU-lead matters: WU crossed threshold but METAR hasn't
              const wuVal = unit === 'C' ? wuObs.highC : wuObs.highF;
              const metarVal = unit === 'C' ? metarObs.runningHighC : metarObs.runningHighF;
              if (r.rangeMax == null && r.rangeMin != null) {
                return wuVal >= r.rangeMin && metarVal < r.rangeMin;
              }
              return false;
            })
            .map(r => r.rangeName);
        }
      }

      await query(
        `INSERT INTO wu_leads_events
           (city, target_date, station_id, local_hour, wu_high_f, wu_high_c,
            metar_high_f, metar_high_c, gap_f, gap_c, ranges_affected)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (city, target_date, station_id) DO NOTHING`,
        [cityKey, targetDate, stationId, localHour,
         wuObs.highF, wuObs.highC,
         metarObs.runningHighF, metarObs.runningHighC,
         Math.round(gapF * 100) / 100, Math.round(gapC * 100) / 100,
         JSON.stringify(rangesAffected)]
      );

      this._wuLeadsLogged.add(dedupeKey);
      this._log('info', `WU-leads-METAR detected: ${cityKey}`, {
        gapF: Math.round(gapF * 10) / 10,
        gapC: Math.round(gapC * 10) / 10,
        wuF: wuObs.highF, metarF: metarObs.runningHighF,
        ranges: rangesAffected.length,
      });
    } catch (err) {
      this._log('warn', `WU-leads check failed for ${cityKey}`, { error: err.message });
    }
  }

  /**
   * Update the latest METAR observation row with WU cross-validation data.
   */
  async _updateWUData(city, targetDate, observedAt, wuObs) {
    try {
      await query(
        `UPDATE metar_observations
         SET wu_high_f = $1, wu_high_c = $2, wu_observation_count = $3
         WHERE city = $4 AND target_date = $5 AND observed_at = $6`,
        [wuObs.highF, wuObs.highC, wuObs.observationCount, city, targetDate, observedAt]
      );
    } catch (err) {
      this._log('warn', `Failed to update WU data`, { city, error: err.message });
    }
  }
}

module.exports = METARObserver;
