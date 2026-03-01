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
  constructor(alerts, platformAdapter, scanner, executor) {
    this.alerts = alerts;
    this.adapter = platformAdapter;
    this.scanner = scanner;
    this.executor = executor;
    this.fetchModule = null;
    this.wuScraper = new WUScraper();
    this.fastPollWUScraper = new WUScraper({ requestDelay: 0 });
    this._pendingAlerted = new Set(); // debounce: city_date_platform_rangeName_side — reset daily
    this._pendingAlertedDate = null;
    this._wuLeadsLogged = new Set(); // debounce: city_date_stationId per day
    this._wuLeadsLoggedDate = null;
    this._fastPollAlerted = new Set(); // debounce: fast_city_date_platform_range_side
    this._fastPollDate = null;
    this._lastFastPollGWScanAt = 0; // timestamp of last fast-poll-triggered GW scan
    this._lastPws429AlertAt = 0; // debounce PWS 429 alerts to once per hour
    this._pwsBiasMap = new Map(); // station_id → { rolling_bias, distance_to_metar_km, reliable, n_samples }
    this._pwsBiasLoadedAt = 0; // timestamp of last bias cache load
    this._pwsGwDedup = new Set(); // PWS GW dedup: "city|date|platform|rangeName|side"
    this._pwsGwDedupDate = null;
    this._pwsAvgErrorCache = new Map(); // city → { avgError, loadedAt }
    this._pwsAvgErrorLoadedAt = 0;
  }

  async _fetch(url) {
    if (!this.fetchModule) {
      this.fetchModule = (await import('node-fetch')).default;
    }
    return this.fetchModule(url, { signal: AbortSignal.timeout(15000) });
  }

  /**
   * Load PWS station bias cache from DB. Called at first fast poll and refreshed every 30 min.
   */
  async _loadPwsBiasCache() {
    try {
      const { data: rows } = await query(
        `SELECT station_id, city, rolling_bias, bias_stddev, distance_to_metar_km, reliable, n_samples
         FROM pws_station_bias`
      );
      this._pwsBiasMap.clear();
      let reliableCount = 0, warmupCount = 0, unreliableCount = 0;
      for (const row of (rows || [])) {
        this._pwsBiasMap.set(row.station_id, {
          city: row.city,
          rolling_bias: row.rolling_bias != null ? parseFloat(row.rolling_bias) : null,
          distance_to_metar_km: row.distance_to_metar_km != null ? parseFloat(row.distance_to_metar_km) : null,
          reliable: row.reliable,
          n_samples: row.n_samples || 0,
        });
        if (row.n_samples >= 576 && row.reliable) reliableCount++;
        else if (row.n_samples < 576) warmupCount++;
        else unreliableCount++;
      }
      this._pwsBiasLoadedAt = Date.now();
      if (rows && rows.length > 0) {
        this._log('info', `PWS bias cache loaded: ${reliableCount} reliable, ${warmupCount} warmup, ${unreliableCount} unreliable`);
      }
    } catch (err) {
      this._log('warn', 'Failed to load PWS bias cache', { error: err.message });
    }
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
    const stats = { citiesPolled: 0, newHighs: 0, newPendingEvents: 0, observations: [] };

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
        // No open trades — add both stations/platforms when both exist
        const stations = new Set();
        const platforms = new Set();
        if (cityConfig.polymarketStation) { stations.add(cityConfig.polymarketStation); platforms.add('polymarket'); }
        if (cityConfig.nwsStation) { stations.add(cityConfig.nwsStation); platforms.add('kalshi'); }
        if (stations.size === 0) continue;
        const localToday = this._getLocalToday(cityConfig.tz);
        cityTrades.set(cityKey, {
          stations,
          platforms,
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
                   WHERE city = $3 AND target_date = $4 AND station_id = $5 AND observed_at = $6`,
                  [authHighF, authHighC, cityKey, localToday, stationId, obs.observedAt]
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
            const pendingCount = await this._checkMetarPending(cityKey, localToday, obs, wuObs, info.unit);
            stats.newPendingEvents += pendingCount;
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
       ON CONFLICT (city, target_date, station_id, observed_at) DO UPDATE SET
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
    if (!this.adapter || !this.alerts) return 0;
    if (!config.guaranteed_entry?.ENABLED) return 0;

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
        `SELECT id, platform, range_name, side, ask_at_detection, wu_confirmed_at, market_repriced_at, wu_triggered
         FROM metar_pending_events WHERE city = $1 AND target_date = $2`,
        [cityKey, targetDate]
      );
      const eventMap = new Map();
      for (const evt of (existing || [])) {
        eventMap.set(`${evt.platform}_${evt.range_name}_${evt.side}`, evt);
      }

      const newAlerts = [];

      for (const range of ranges) {
        if (config.platforms[range.platform]?.guaranteedWinEnabled === false) continue;

        // Determine if METAR crossed and compute side
        let side = null, threshold = null, metarGap = null;
        let wuCrossed = false;

        // Unbounded YES ("X or higher"): METAR >= range_min
        if (range.rangeMax == null && range.rangeMin != null && metarHigh >= range.rangeMin) {
          side = 'YES'; threshold = range.rangeMin; metarGap = metarHigh - range.rangeMin;
          wuCrossed = wuHigh != null && wuHigh >= range.rangeMin;
        }

        // Bounded NO: METAR > range_max
        if (range.rangeMin != null && range.rangeMax != null && metarHigh > range.rangeMax) {
          side = 'NO'; threshold = range.rangeMax; metarGap = metarHigh - range.rangeMax;
          wuCrossed = wuHigh != null && wuHigh > range.rangeMax;
        }

        if (!side) continue;

        const evtKey = `${range.platform}_${range.rangeName}_${side}`;
        const existingEvt = eventMap.get(evtKey);

        // Both sources crossed — set wu_confirmed_at if pending event exists, then skip
        if (wuCrossed) {
          if (existingEvt && !existingEvt.wu_confirmed_at) {
            await query(
              `UPDATE metar_pending_events SET wu_confirmed_at = NOW() WHERE id = $1`,
              [existingEvt.id]
            );
          }
          continue;
        }

        const winningAsk = side === 'YES' ? range.ask : (1 - range.bid);

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
          wuTriggered: false, // main observe path is always METAR-triggered
        });
      }
      return newAlerts.length;
    } catch (err) {
      this._log('warn', `METAR pending check failed for ${cityKey}`, { error: err.message });
      return 0;
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
      const { data: existingRow } = await queryOne(
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
              if (config.platforms[r.platform]?.guaranteedWinEnabled === false) return false;
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
   * Shared range-checking logic. Checks each range for boundary crossing,
   * snapshots orderbooks, inserts/updates metar_pending_events.
   * Extracted from metarFastPoll for reusability.
   *
   * @param {string} cityKey
   * @param {object} cityConfig - config.cities[cityKey]
   * @param {string} localToday - YYYY-MM-DD
   * @param {number} effHighC - effective running high in °C
   * @param {number} effHighF - effective running high in °F
   * @param {Array} ranges - market ranges from adapter.getMarkets()
   * @param {Map} eventMap - existing metar_pending_events keyed by platform_rangeName_side
   * @param {string} pollSource - 'fast_poll'
   * @param {string} [detectionStation] - ICAO station used for this detection (e.g. KLGA, KNYC)
   * @param {Set} [platformFilter] - if provided, only process ranges for these platforms
   * @returns {{ detections: number, newRanges: string[], gwCandidates: Object[] }}
   */
  async _processRangesForCity(cityKey, cityConfig, localToday, effHighC, effHighF, ranges, eventMap, pollSource, detectionStation, platformFilter, wuTriggered = false, metarOnlyHigh = null, wuOnlyHigh = null) {
    const gwConfig = config.guaranteed_entry;
    const unit = cityConfig.unit;
    const effHigh = unit === 'C' ? effHighC : effHighF;

    let detections = 0;
    const newRanges = []; // range names with first-time detections (for alerts)
    const gwCandidates = []; // enriched data for fast-path GW evaluation

    for (const range of ranges) {
      if (platformFilter && !platformFilter.has(range.platform)) continue;
      if (config.platforms[range.platform]?.guaranteedWinEnabled === false) continue;

      let side = null, threshold = null, gap = null;

      // Unbounded YES: high >= rangeMin
      if (range.rangeMax == null && range.rangeMin != null && effHigh >= range.rangeMin) {
        side = 'YES'; threshold = range.rangeMin; gap = effHigh - range.rangeMin;
      }
      // Bounded NO: high > rangeMax
      if (range.rangeMin != null && range.rangeMax != null && effHigh > range.rangeMax) {
        side = 'NO'; threshold = range.rangeMax; gap = effHigh - range.rangeMax;
      }

      if (!side) continue;

      // Dual-station cities (e.g. NYC KLGA≠KNYC, Chicago KORD≠KMDW) need wider Kalshi gap
      const isKalshi = range.platform === 'kalshi';
      const cityConf = config.cities[cityKey] || {};
      const isDualStation = isKalshi && cityConf.nwsStation && cityConf.polymarketStation
        && cityConf.nwsStation !== cityConf.polymarketStation;
      const minGap = isDualStation
        ? (unit === 'C' ? 0.8 : 1.5)
        : (unit === 'C' ? (gwConfig.METAR_ONLY_MIN_GAP_C || 0.5) : (gwConfig.METAR_ONLY_MIN_GAP_F || 0.5));
      if (gap < minGap) continue;

      const winningAsk = side === 'YES' ? range.ask : (1 - range.bid);
      const evtKey = `${range.platform}_${range.rangeName}_${side}`;
      const existingEvt = eventMap.get(evtKey);

      // Snapshot orderbook for this range (fresh, bypass cache for Kalshi)
      let askDepth = null;
      let kalshiAskDepth = null;
      let kalshiMarketId = null;
      let kalshiAsk = null;

      try {
        if (range.platform === 'polymarket' && range.tokenId) {
          const ob = await this.adapter._pmFetchOrderbook(range.tokenId);
          if (ob) askDepth = ob.ask_depth;
        } else if (range.platform === 'polymarket' && !range.tokenId) {
          this._log('warn', `${pollSource}: no tokenId for ${range.rangeName} (Polymarket)`, { city: cityKey });
        } else if (range.platform === 'kalshi' && range.marketId) {
          this.adapter.kalshiOrderbookCache.delete(range.marketId);
          const ob = await this.adapter._klFetchOrderbook(range.marketId);
          if (ob) kalshiAskDepth = ob.ask_depth;
          kalshiMarketId = range.marketId;
          kalshiAsk = winningAsk;
        } else if (range.platform === 'kalshi' && !range.marketId) {
          this._log('warn', `${pollSource}: no marketId for ${range.rangeName} (Kalshi)`, { city: cityKey });
        }

        // Cross-platform: also snapshot the OTHER platform if available
        const otherPlatform = range.platform === 'polymarket' ? 'kalshi' : 'polymarket';
        const closeEnough = (a, b) => a == null && b == null || (a != null && b != null && Math.abs(a - b) < 1);
        const otherRange = ranges.find(r => {
          if (r.platform !== otherPlatform) return false;
          if (unit === 'F') return r.rangeMin === range.rangeMin && r.rangeMax === range.rangeMax;
          if (range.platform === 'polymarket') {
            const minF = range.rangeMin != null ? range.rangeMin * 9 / 5 + 32 : null;
            const maxF = range.rangeMax != null ? range.rangeMax * 9 / 5 + 32 : null;
            return closeEnough(r.rangeMin, minF) && closeEnough(r.rangeMax, maxF);
          } else {
            const minC = range.rangeMin != null ? (range.rangeMin - 32) * 5 / 9 : null;
            const maxC = range.rangeMax != null ? (range.rangeMax - 32) * 5 / 9 : null;
            return closeEnough(r.rangeMin, minC) && closeEnough(r.rangeMax, maxC);
          }
        });
        if (otherRange) {
          if (otherPlatform === 'kalshi' && otherRange.marketId) {
            this.adapter.kalshiOrderbookCache.delete(otherRange.marketId);
            const ob = await this.adapter._klFetchOrderbook(otherRange.marketId);
            if (ob) kalshiAskDepth = ob.ask_depth;
            kalshiMarketId = otherRange.marketId;
            kalshiAsk = side === 'YES' ? otherRange.ask : (1 - otherRange.bid);
          } else if (otherPlatform === 'polymarket' && otherRange.tokenId) {
            const ob = await this.adapter._pmFetchOrderbook(otherRange.tokenId);
            if (ob) askDepth = ob.ask_depth;
          }
        }
      } catch (err) {
        this._log('warn', `${pollSource} orderbook snapshot failed`, { city: cityKey, range: range.rangeName, error: err.message });
      }

      if (!existingEvt) {
        // FIRST DETECTION — INSERT with orderbook snapshot
        await query(
          `INSERT INTO metar_pending_events
             (city, target_date, platform, range_name, side, range_min, range_max,
              range_unit, metar_high, metar_gap, ask_at_detection,
              ask_depth, kalshi_market_id, kalshi_ask_at_detection, kalshi_ask_depth,
              poll_source, detection_station, wu_triggered)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT (city, target_date, platform, range_name, side) DO NOTHING`,
          [cityKey, localToday, range.platform, range.rangeName, side,
           range.rangeMin, range.rangeMax, unit, effHigh, gap, winningAsk,
           askDepth ? JSON.stringify(askDepth) : null,
           kalshiMarketId, kalshiAsk,
           kalshiAskDepth ? JSON.stringify(kalshiAskDepth) : null,
           pollSource, detectionStation || null, wuTriggered]
        );
        detections++;

        // Collect GW candidate for fast-path evaluation (skip full scanner re-scan)
        gwCandidates.push({
          city: cityKey,
          target_date: localToday,
          platform: range.platform,
          range_name: range.rangeName,
          range_type: range.rangeType || ((range.rangeMin == null || range.rangeMax == null) ? 'unbounded' : 'bounded'),
          side,
          ask: winningAsk,
          bid: side === 'YES' ? range.bid : (1 - range.ask),
          token_id: range.tokenId,
          market_id: range.marketId,
          volume: range.volume || 0,
          range_min: range.rangeMin,
          range_max: range.rangeMax,
          range_unit: unit,
          effHigh,
          gap,
          wuTriggered,
          metar_high: metarOnlyHigh,
          wu_high: wuOnlyHigh,
          _freshBookAsk: askDepth?.[0]?.price || null,
        });

        // Alert (debounce by in-memory Set)
        const alertKey = `fast_${cityKey}_${localToday}_${range.platform}_${range.rangeName}_${side}`;
        if (!this._fastPollAlerted.has(alertKey)) {
          this._fastPollAlerted.add(alertKey);
          newRanges.push(range.rangeName);
          this._log('info', `${pollSource} detection: ${cityKey} ${range.rangeName} ${side}`, {
            effHigh, gap: Math.round(gap * 10) / 10, ask: winningAsk,
            hasPolyOB: !!askDepth, hasKalshiOB: !!kalshiAskDepth,
            wuTriggered,
          });
        }
      } else {
        // SUBSEQUENT POLL — UPDATE unresolved fields + latest orderbook
        const updates = [];
        const params = [];
        let paramIdx = 1;

        // Market repricing: Polymarket side
        if (!existingEvt.market_repriced_at && winningAsk > gwConfig.MAX_ASK) {
          updates.push(`market_repriced_at = $${paramIdx++}`);
          params.push(new Date().toISOString());
        }

        // Market repricing: Kalshi side
        if (!existingEvt.kalshi_market_repriced_at && kalshiAsk != null && kalshiAsk > gwConfig.MAX_ASK) {
          updates.push(`kalshi_market_repriced_at = $${paramIdx++}`);
          params.push(new Date().toISOString());
        }

        // Update latest observation values
        updates.push(`metar_high = $${paramIdx++}`);
        params.push(effHigh);

        // Update orderbook snapshots (always overwrite with latest)
        if (askDepth) {
          updates.push(`ask_depth = $${paramIdx++}`);
          params.push(JSON.stringify(askDepth));
        }
        if (kalshiAskDepth) {
          updates.push(`kalshi_ask_depth = $${paramIdx++}`);
          params.push(JSON.stringify(kalshiAskDepth));
        }
        if (kalshiMarketId && !existingEvt.kalshi_market_id) {
          updates.push(`kalshi_market_id = $${paramIdx++}`);
          params.push(kalshiMarketId);
        }
        if (kalshiAsk != null && !existingEvt.kalshi_ask_at_detection) {
          updates.push(`kalshi_ask_at_detection = $${paramIdx++}`);
          params.push(kalshiAsk);
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

    return { detections, newRanges, gwCandidates };
  }

  /**
   * Fast METAR-only poll loop. Independent from observe() — no WU, no DB observation writes.
   * Uses single batch HTTP request for all active stations (aviationweather.gov accepts comma-separated IDs).
   * Checks boundary crossings, snapshots orderbooks from both platforms,
   * logs to metar_pending_events with poll_source='fast_poll'.
   * Called on its own setInterval (20s default), not inside _runCycle().
   */
  async metarFastPoll() {
    const fastPollStart = Date.now();
    const gwConfig = config.guaranteed_entry;
    if (!gwConfig?.ENABLED) return { polled: 0, detections: 0 };

    const { start: activeStart, end: activeEnd } = config.observer.ACTIVE_HOURS;

    // Reset fast-poll debounce daily
    const today = new Date().toISOString().split('T')[0];
    if (this._fastPollDate !== today) {
      this._fastPollAlerted = new Set();
      this._fastPollDate = today;
    }

    // 1. Build list of active cities and their per-platform stations
    const activeCities = []; // { cityKey, cityConfig, localToday, stationsByPlatform }
    const stationSet = new Set();

    for (const [cityKey, cityConfig] of Object.entries(config.cities)) {
      const localHour = this._getLocalHour(cityConfig.tz);
      if (localHour < activeStart || localHour >= activeEnd) continue;

      const localToday = this._getLocalToday(cityConfig.tz);
      const stationsByPlatform = {};
      if (cityConfig.polymarketStation) stationsByPlatform.polymarket = cityConfig.polymarketStation;
      if (cityConfig.nwsStation) stationsByPlatform.kalshi = cityConfig.nwsStation;
      if (Object.keys(stationsByPlatform).length === 0) continue;

      activeCities.push({ cityKey, cityConfig, localToday, stationsByPlatform });
      for (const s of Object.values(stationsByPlatform)) stationSet.add(s);
    }

    if (activeCities.length === 0) return { polled: 0, detections: 0 };

    // 2. Single batch METAR fetch for all active stations
    const stationIds = [...stationSet].join(',');
    let metarMap; // station → METAR data
    try {
      const url = `${METAR_API_BASE}?ids=${stationIds}&format=json`;
      const resp = await this._fetch(url);
      if (!resp.ok) {
        this._log('warn', `Fast poll batch METAR fetch failed`, { status: resp.status });
        return { polled: 0, detections: 0 };
      }
      const data = await resp.json();
      if (!Array.isArray(data)) return { polled: 0, detections: 0 };

      metarMap = new Map();
      for (const obs of data) {
        if (obs.icaoId && obs.temp != null) {
          metarMap.set(obs.icaoId, obs);
        }
      }
    } catch (err) {
      this._log('warn', `Fast poll batch METAR fetch error`, { error: err.message });
      return { polled: 0, detections: 0 };
    }

    // 3. Batch DB queries — running highs + pending events for all active cities
    //    Collect unique (city, date) pairs
    const cityDatePairs = activeCities
      .filter(c => Object.values(c.stationsByPlatform).some(s => metarMap.has(s)))
      .map(c => ({ cityKey: c.cityKey, localToday: c.localToday }));
    const uniqueDates = [...new Set(cityDatePairs.map(p => p.localToday))];

    // 3a. Batch running highs: one query using DISTINCT ON, per station
    const runningHighMap = new Map(); // "city|date|station" → { running_high_c, running_high_f }
    try {
      const { data: highRows } = await query(
        `SELECT DISTINCT ON (city, target_date, station_id)
                city, target_date, station_id, running_high_c, running_high_f
         FROM metar_observations
         WHERE target_date = ANY($1)
         ORDER BY city, target_date, station_id, created_at DESC`,
        [uniqueDates]
      );
      for (const row of (highRows || [])) {
        runningHighMap.set(`${row.city}|${row.target_date}|${row.station_id}`, row);
      }
    } catch (err) {
      this._log('warn', `Fast poll batch running-high query failed`, { error: err.message });
    }

    // 3b. Batch pending events: one query for all active dates
    const pendingEventMap = new Map(); // "city|date" → Map("platform_rangeName_side" → evt)
    try {
      const { data: pendingRows } = await query(
        `SELECT id, city, target_date, platform, range_name, side,
                ask_at_detection, kalshi_ask_at_detection, kalshi_market_id,
                wu_confirmed_at, market_repriced_at, kalshi_market_repriced_at
         FROM metar_pending_events
         WHERE target_date = ANY($1)`,
        [uniqueDates]
      );
      for (const evt of (pendingRows || [])) {
        const cityDateKey = `${evt.city}|${evt.target_date}`;
        if (!pendingEventMap.has(cityDateKey)) {
          pendingEventMap.set(cityDateKey, new Map());
        }
        pendingEventMap.get(cityDateKey).set(`${evt.platform}_${evt.range_name}_${evt.side}`, evt);
      }
    } catch (err) {
      this._log('warn', `Fast poll batch pending-events query failed`, { error: err.message });
    }

    // 3.5. Parallel PWS fetch for ALL active cities with pwsStations (data collection)
    let pwsMap = new Map();
    try {
      pwsMap = await this._fetchPwsBatch(activeCities, metarMap);
    } catch (err) {
      this._log('warn', `PWS batch fetch failed`, { error: err.message });
    }

    // 4. Pass 1 — Near-threshold check + identify WU targets (tiering)
    let polled = 0;
    let detections = 0;
    const nearThresholdCities = []; // cities with ranges near a GW boundary
    const wuTargets = []; // cityKeys needing WU calls

    for (const { cityKey, cityConfig, localToday, stationsByPlatform } of activeCities) {
      const hasAnyMetar = Object.values(stationsByPlatform).some(s => metarMap.has(s));
      if (!hasAnyMetar) continue;

      try {
        polled++;

        const ranges = await this.adapter.getMarkets(cityKey, localToday);
        if (!ranges || ranges.length === 0) continue;

        const eventMap = pendingEventMap.get(`${cityKey}|${localToday}`) || new Map();

        // Build station→platforms[] groups
        const stationGroups = new Map();
        for (const [platform, station] of Object.entries(stationsByPlatform)) {
          if (!stationGroups.has(station)) stationGroups.set(station, new Set());
          stationGroups.get(station).add(platform);
        }

        // Compute effHigh per station and check if any range is near a GW boundary
        let cityIsNearThreshold = false;
        let cityNeedsWU = false;
        const stationData = [];

        for (const [station, platforms] of stationGroups) {
          const metar = metarMap.get(station);
          if (!metar) continue;

          const tempC = metar.temp;
          const tempF = Math.round(tempC * 9 / 5 + 32);
          const highRow = runningHighMap.get(`${cityKey}|${localToday}|${station}`);
          const dbHighC = highRow?.running_high_c ?? -Infinity;
          const dbHighF = highRow?.running_high_f ?? -Infinity;
          const effHighC = Math.max(tempC, dbHighC === -Infinity ? tempC : dbHighC);
          const effHighF = Math.max(tempF, dbHighF === -Infinity ? tempF : dbHighF);

          const unit = cityConfig.unit;
          const effHigh = unit === 'C' ? effHighC : effHighF;
          const buffer = unit === 'C' ? (gwConfig.GW_NEAR_THRESHOLD_BUFFER_C || 0.5) : (gwConfig.GW_NEAR_THRESHOLD_BUFFER_F || 1.0);

          for (const range of ranges) {
            if (!platforms.has(range.platform)) continue;
            if (config.platforms[range.platform]?.guaranteedWinEnabled === false) continue;

            // Unbounded YES: boundary = rangeMin
            if (range.rangeMax == null && range.rangeMin != null && effHigh >= range.rangeMin - buffer) {
              cityIsNearThreshold = true;
              if (range.platform === 'polymarket') cityNeedsWU = true;
            }
            // Bounded NO: boundary = rangeMax
            if (range.rangeMin != null && range.rangeMax != null && effHigh > range.rangeMax - buffer) {
              cityIsNearThreshold = true;
              if (range.platform === 'polymarket') cityNeedsWU = true;
            }
          }

          stationData.push({ station, platforms, tempC, tempF, effHighC, effHighF });
        }

        if (!cityIsNearThreshold) continue; // TIERING: skip cities not near any boundary

        nearThresholdCities.push({
          cityKey, cityConfig, localToday, stationsByPlatform,
          ranges, eventMap, stationData
        });

        if (cityNeedsWU && cityConfig.polymarketStation) {
          wuTargets.push({ cityKey, localToday });
        }
      } catch (err) {
        this._log('warn', `Fast poll failed for ${cityKey}`, { error: err.message });
      }
    }

    // 5. Pass 2 — Parallel WU calls for near-threshold Polymarket cities
    const wuHighMap = new Map(); // cityKey → { highF, highC }
    if (wuTargets.length > 0) {
      const wuPromises = wuTargets.map(({ cityKey, localToday }) => {
        const promise = this.fastPollWUScraper.getHighTempForCity(cityKey, localToday);
        const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
        return Promise.race([promise, timeout]).then(result => ({ cityKey, result }));
      });

      const wuResults = await Promise.allSettled(wuPromises);
      for (const settled of wuResults) {
        if (settled.status === 'fulfilled' && settled.value?.result) {
          wuHighMap.set(settled.value.cityKey, settled.value.result);
        }
      }

      if (wuHighMap.size > 0) {
        this._log('info', `Fast poll WU: ${wuHighMap.size}/${wuTargets.length} responses`, {
          cities: [...wuHighMap.keys()]
        });
      }
    }

    // 6. Pass 3 — Process near-threshold cities with WU-enhanced temps
    const allGWCandidates = []; // collect GW candidates for fast-path evaluation

    for (const ntCity of nearThresholdCities) {
      const { cityKey, cityConfig, localToday, ranges, eventMap, stationData } = ntCity;

      try {
        const cityNewRanges = [];
        let cityWuTriggered = false;
        let cityMetarHigh = null;
        let cityWuHigh = null;

        for (const { station, platforms, effHighC, effHighF } of stationData) {
          const wuResult = wuHighMap.get(cityKey);
          const unit = cityConfig.unit;
          const cityConf = config.cities[cityKey] || {};

          // Only apply WU to the Polymarket station (prevents cross-station contamination)
          const isPolymarketStation = station === cityConf.polymarketStation;
          const wuHighVal = isPolymarketStation && wuResult
            ? (unit === 'C' ? wuResult.highC : wuResult.highF)
            : null;
          const effHighVal = unit === 'C' ? effHighC : effHighF;
          const hasWUEnhancement = wuHighVal != null && Number.isFinite(wuHighVal) && wuHighVal > effHighVal;

          if (hasWUEnhancement) {
            const wuEffHighC = Math.max(effHighC, wuResult.highC);
            const wuEffHighF = Math.max(effHighF, wuResult.highF);

            if (platforms.has('polymarket') && platforms.has('kalshi')) {
              // Dual-platform station (e.g. Atlanta KATL) — split: WU for PM, METAR for Kalshi
              const pmResult = await this._processRangesForCity(
                cityKey, cityConfig, localToday, wuEffHighC, wuEffHighF, ranges, eventMap, 'fast_poll',
                station, new Set(['polymarket']), true, effHighVal, wuHighVal
              );
              detections += pmResult.detections;
              cityNewRanges.push(...pmResult.newRanges);
              allGWCandidates.push(...(pmResult.gwCandidates || []));

              const klResult = await this._processRangesForCity(
                cityKey, cityConfig, localToday, effHighC, effHighF, ranges, eventMap, 'fast_poll',
                station, new Set(['kalshi'])
              );
              detections += klResult.detections;
              cityNewRanges.push(...klResult.newRanges);
              allGWCandidates.push(...(klResult.gwCandidates || []));
            } else {
              // Polymarket-only station
              const result = await this._processRangesForCity(
                cityKey, cityConfig, localToday, wuEffHighC, wuEffHighF, ranges, eventMap, 'fast_poll',
                station, platforms, true, effHighVal, wuHighVal
              );
              detections += result.detections;
              cityNewRanges.push(...result.newRanges);
              allGWCandidates.push(...(result.gwCandidates || []));
            }

            cityWuTriggered = true;
            cityMetarHigh = effHighVal;
            cityWuHigh = wuHighVal;

            this._log('info', `wu_fast_poll enhancement: ${cityKey} ${station}`, {
              metarHigh: effHighVal, wuHigh: wuHighVal
            });

            // Record WU-leads-METAR event (must call here — observe() sees WU-enhanced running_high)
            const localHour = this._getLocalHour(cityConfig.tz);
            await this._checkWULeads(cityKey, station, localHour, localToday,
              { runningHighF: effHighF, runningHighC: effHighC },
              { highF: wuResult.highF, highC: wuResult.highC },
              cityConfig.unit
            );
          } else {
            // No WU enhancement — standard processing
            const result = await this._processRangesForCity(
              cityKey, cityConfig, localToday, effHighC, effHighF, ranges, eventMap, 'fast_poll',
              station, platforms
            );
            detections += result.detections;
            cityNewRanges.push(...result.newRanges);
            allGWCandidates.push(...(result.gwCandidates || []));
            if (cityMetarHigh == null) cityMetarHigh = effHighVal;
          }
        }

        // Fire Telegram alert for new detections in this city
        if (cityNewRanges.length > 0 && this.alerts) {
          const unit = cityConfig.unit;
          await this.alerts.metarPending({
            city: cityKey,
            date: localToday,
            metarHigh: cityMetarHigh,
            wuHigh: cityWuHigh,
            unit,
            rangesAffected: cityNewRanges,
            wuTriggered: cityWuTriggered,
          });
        }
      } catch (err) {
        this._log('warn', `Fast poll failed for ${cityKey}`, { error: err.message });
      }
    }

    const durationMs = Date.now() - fastPollStart;
    const durationSec = (durationMs / 1000).toFixed(1);
    const tiered = polled - nearThresholdCities.length;
    if (detections > 0 || durationMs > 10000) {
      this._log('info', `Fast poll complete: ${polled} cities (${tiered} tiered out), ${detections} detections, ${wuHighMap.size} WU, ${durationSec}s`);
    }

    // Step 6.5: PWS GW — independent from METAR near-threshold gate
    if (config.pws_gw?.ENABLED && pwsMap.size > 0 && this.scanner && this.executor) {
      try {
        const pwsCandidates = await this._checkPwsGW(activeCities, pwsMap, pendingEventMap);
        allGWCandidates.push(...pwsCandidates);
      } catch (err) {
        this._log('error', 'PWS GW check failed', { error: err.message });
      }
    }

    // If new first-detections found, fast-path GW evaluation + execution
    // Skips full scanGuaranteedWins() re-scan of all 23 cities — uses pre-computed candidates
    if (allGWCandidates.length > 0 && this.scanner && this.executor) {
      try {
        const fastPathStart = Date.now();
        this._log('info', `Fast poll: ${allGWCandidates.length} GW candidate(s) — fast-path evaluation`);

        const gwResult = await this.scanner.evaluateGWFastPath(allGWCandidates);

        if (gwResult.entries.length > 0) {
          await this.alerts.guaranteedWinDetected(gwResult.entries);
          const gwTrades = await this.executor.executeGuaranteedWins(gwResult.entries);
          const fastPathMs = Date.now() - fastPathStart;
          this._log('info', `Fast-path GW: ${gwResult.entries.length} entries, ${gwTrades.length} executed in ${fastPathMs}ms`);
        }
        if (gwResult.missed?.length > 0) {
          await this.alerts.guaranteedWinMissed(gwResult.missed);
        }
        this._lastFastPollGWScanAt = Date.now();
      } catch (err) {
        this._log('error', 'Fast-path GW failed', { error: err.message });
      }
    }

    // Write observations AFTER order placement (non-blocking for speed)
    // The 90s fallback scanGuaranteedWins() in bot.js still reads from metar_observations,
    // so we need this written — just not blocking the critical execution path.
    if (detections > 0) {
      this._writeObservationsFromFastPoll(activeCities, metarMap, runningHighMap, wuHighMap)
        .catch(err => this._log('warn', 'Post-order observation write failed', { error: err.message }));
    }

    // Fire-and-forget: write PWS observations for ALL active cities (data collection)
    if (pwsMap.size > 0) {
      const pwsCities = pwsMap.size;
      const pwsOnline = [...pwsMap.values()].reduce((sum, d) => sum + d.stationsOnline, 0);
      this._writePwsObservations(activeCities, pwsMap, metarMap, runningHighMap, nearThresholdCities)
        .then(writes => {
          if (writes > 0) {
            this._log('info', `PWS: ${writes} rows written, ${pwsCities} cities, ${pwsOnline} stations online`);
          }
        })
        .catch(err => this._log('warn', 'PWS observation write failed', { error: err.message }));
    }

    return { polled, detections };
  }

  /**
   * PWS Guaranteed-Win detection — independent from METAR near-threshold gate.
   * Uses corrected median from PWS stations to detect boundary crossings earlier than METAR.
   *
   * @param {Array} activeCities - from metarFastPoll step 1
   * @param {Map} pwsMap - cityKey → { correctedMedian, stationsOnline, ... }
   * @param {Map} pendingEventMap - "city|date" → Map("platform_rangeName_side" → evt)
   * @returns {Array} gwCandidates compatible with evaluateGWFastPath
   */
  async _checkPwsGW(activeCities, pwsMap, pendingEventMap) {
    const pwsGwConfig = config.pws_gw;
    if (!pwsGwConfig?.ENABLED) return [];

    // Reset dedup daily
    const today = new Date().toISOString().split('T')[0];
    if (this._pwsGwDedupDate !== today) {
      this._pwsGwDedup.clear();
      this._pwsGwDedupDate = today;
    }

    // Refresh avg corrected error cache every 30 min
    if (Date.now() - this._pwsAvgErrorLoadedAt > 1800000) {
      await this._loadPwsAvgErrorCache();
    }

    const gwCandidates = [];
    let eligibleCount = 0;
    let crossingCount = 0;

    for (const { cityKey, cityConfig, localToday } of activeCities) {
      const pwsData = pwsMap.get(cityKey);
      if (!pwsData) continue;

      // Eligibility check 1: min stations configured
      const configuredStations = (cityConfig.pwsStations || []).length;
      if (configuredStations < pwsGwConfig.MIN_STATIONS_CONFIGURED) continue;

      // Eligibility check 2: min stations online this cycle
      if (pwsData.stationsOnline < pwsGwConfig.MIN_STATIONS_ONLINE) continue;

      // Eligibility check 3: corrected median must exist
      if (pwsData.correctedMedian == null || !Number.isFinite(pwsData.correctedMedian)) continue;

      // Eligibility check 4: avg corrected error <= threshold
      const avgError = this._pwsAvgErrorCache.get(cityKey);
      if (avgError == null || avgError > pwsGwConfig.MAX_AVG_CORRECTED_ERROR) continue;

      // Eligibility check 5: at least one calibrated station (n_samples >= 576)
      const cityStations = cityConfig.pwsStations || [];
      const hasCalibrated = cityStations.some(sid => {
        const bias = this._pwsBiasMap.get(sid);
        return bias && bias.n_samples >= 576 && bias.reliable;
      });
      if (!hasCalibrated) continue;

      eligibleCount++;

      // Get market ranges (adapter has cache, so this is cheap)
      let ranges;
      try {
        ranges = await this.adapter.getMarkets(cityKey, localToday);
      } catch (err) {
        this._log('warn', `PWS GW: failed to get markets for ${cityKey}`, { error: err.message });
        continue;
      }
      if (!ranges || ranges.length === 0) continue;

      const unit = cityConfig.unit;
      const correctedMedian = pwsData.correctedMedian;
      const minGap = unit === 'C' ? pwsGwConfig.MIN_GAP_C : pwsGwConfig.MIN_GAP_F;

      for (const range of ranges) {
        if (config.platforms[range.platform]?.guaranteedWinEnabled === false) continue;

        let side = null, gap = null;

        // Unbounded YES: correctedMedian >= rangeMin
        if (range.rangeMax == null && range.rangeMin != null && correctedMedian >= range.rangeMin) {
          side = 'YES';
          gap = correctedMedian - range.rangeMin;
        }
        // Bounded NO: correctedMedian > rangeMax
        if (range.rangeMin != null && range.rangeMax != null && correctedMedian > range.rangeMax) {
          side = 'NO';
          gap = correctedMedian - range.rangeMax;
        }

        if (!side) continue;
        if (gap < minGap) continue;

        // PWS-specific dedup (independent from METAR dedup)
        const dedupKey = `${cityKey}|${localToday}|${range.platform}|${range.rangeName}|${side}`;
        if (this._pwsGwDedup.has(dedupKey)) continue;
        this._pwsGwDedup.add(dedupKey);

        crossingCount++;

        // Compute winning ask
        const winningAsk = side === 'YES' ? range.ask : (1 - range.bid);

        // Snapshot orderbook for fresh ask
        let freshBookAsk = null;
        try {
          if (range.platform === 'polymarket' && range.tokenId) {
            const ob = await this.adapter._pmFetchOrderbook(range.tokenId);
            if (ob && ob.asks && ob.asks.length > 0) {
              freshBookAsk = parseFloat(ob.asks[0].price);
            }
          } else if (range.platform === 'kalshi' && range.marketId) {
            this.adapter.kalshiOrderbookCache.delete(range.marketId);
            const ob = await this.adapter._klFetchOrderbook(range.marketId);
            if (ob && ob.ask != null) {
              freshBookAsk = side === 'YES' ? ob.ask : (1 - ob.bid);
            }
          }
        } catch (err) {
          this._log('warn', `PWS GW orderbook snapshot failed: ${cityKey} ${range.rangeName}`, { error: err.message });
        }

        gwCandidates.push({
          city: cityKey,
          target_date: localToday,
          platform: range.platform,
          market_id: range.marketId || null,
          token_id: range.tokenId || null,
          range_name: range.rangeName,
          range_min: range.rangeMin,
          range_max: range.rangeMax,
          range_type: range.rangeMax == null ? 'unbounded' : 'bounded',
          range_unit: unit,
          side,
          ask: freshBookAsk || winningAsk,
          bid: range.bid,
          volume: range.volume || 0,
          gap,
          effHigh: correctedMedian,
          metar_high: null, // PWS-only — no METAR high needed
          wu_high: null,
          wuTriggered: false,
          entry_reason_override: 'guaranteed_win_pws',
          pws_corrected_median: correctedMedian,
          pws_stations_online: pwsData.stationsOnline,
          pws_avg_error: avgError,
          _freshBookAsk: freshBookAsk,
        });
      }
    }

    if (eligibleCount > 0 || crossingCount > 0) {
      this._log('info', `PWS GW: ${eligibleCount} eligible cities, ${crossingCount} crossings detected`);
    }

    return gwCandidates;
  }

  /**
   * Load per-city average corrected error from pws_observations.
   * Cached for 30 min. Uses 2-day window to match the analysis period.
   */
  async _loadPwsAvgErrorCache() {
    try {
      const { data: rows } = await query(
        `SELECT city, AVG(ABS(pws_corrected_median - metar_temp)) as avg_error
         FROM pws_observations
         WHERE polled_at >= NOW() - INTERVAL '2 days'
           AND pws_corrected_median IS NOT NULL AND metar_temp IS NOT NULL
           AND stations_online >= 2
         GROUP BY city`
      );
      this._pwsAvgErrorCache.clear();
      for (const row of (rows || [])) {
        const err = parseFloat(row.avg_error);
        if (Number.isFinite(err)) {
          this._pwsAvgErrorCache.set(row.city, Math.round(err * 100) / 100);
        }
      }
      this._pwsAvgErrorLoadedAt = Date.now();
      if (rows && rows.length > 0) {
        const eligible = [...this._pwsAvgErrorCache.entries()]
          .filter(([, e]) => e <= (config.pws_gw?.MAX_AVG_CORRECTED_ERROR || 2.0))
          .map(([c, e]) => `${c}(${e})`);
        this._log('info', `PWS avg error cache loaded: ${rows.length} cities, ${eligible.length} eligible: ${eligible.join(', ')}`);
      }
    } catch (err) {
      this._log('warn', 'Failed to load PWS avg error cache', { error: err.message });
    }
  }

  /**
   * Write lightweight observation rows from fast poll METAR data.
   * Only writes when current temp (or WU temp) exceeds stored running high.
   * Uses GREATEST in upsert to never lower the running_high.
   * WU data only applied to Polymarket stations (prevents cross-station contamination).
   */
  async _writeObservationsFromFastPoll(activeCities, metarMap, runningHighMap, wuHighMap) {
    let writes = 0;
    for (const { cityKey, cityConfig, localToday, stationsByPlatform } of activeCities) {
      const uniqueStations = new Set(Object.values(stationsByPlatform));
      for (const station of uniqueStations) {
        const metar = metarMap.get(station);
        if (!metar || metar.temp == null || metar.obsTime == null) continue;

        const tempC = metar.temp;
        const tempF = Math.round(tempC * 9 / 5 + 32);

        // Only apply WU to the Polymarket station (dual-station guard)
        const isPolymarketStation = station === cityConfig.polymarketStation;
        const wuResult = isPolymarketStation ? wuHighMap?.get(cityKey) : null;
        const wuC = wuResult?.highC ?? -Infinity;
        const wuF = wuResult?.highF ?? -Infinity;

        // Effective temp = max(METAR, WU) for skip check
        const effectiveC = Math.max(tempC, wuC === -Infinity ? tempC : wuC);

        // Check against stored running high — only write if new high from either source
        const highKey = `${cityKey}|${localToday}|${station}`;
        const highRow = runningHighMap.get(highKey);
        const dbHighC = highRow?.running_high_c ?? -Infinity;
        const dbHighF = highRow?.running_high_f ?? -Infinity;

        if (dbHighC !== -Infinity && effectiveC <= dbHighC) continue;

        // Running high includes WU
        const runHighC = Math.max(tempC, dbHighC === -Infinity ? tempC : dbHighC, wuC === -Infinity ? -Infinity : wuC);
        const runHighF = Math.max(tempF, dbHighF === -Infinity ? tempF : dbHighF, wuF === -Infinity ? -Infinity : wuF);

        const observedAt = new Date(metar.obsTime * 1000);

        // Verify within local day
        const { startUTC, endUTC } = this._getUTCWindowForLocalDate(localToday, cityConfig.tz);
        if (observedAt < startUTC || observedAt >= endUTC) continue;

        const wuHighF = wuC !== -Infinity ? wuResult.highF : null;
        const wuHighC = wuC !== -Infinity ? wuResult.highC : null;

        try {
          await query(
            `INSERT INTO metar_observations
               (city, station_id, target_date, observed_at, temp_c, temp_f,
                running_high_c, running_high_f, wu_high_f, wu_high_c, observation_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
             ON CONFLICT (city, target_date, station_id, observed_at) DO UPDATE SET
               running_high_c = GREATEST(metar_observations.running_high_c, EXCLUDED.running_high_c),
               running_high_f = GREATEST(metar_observations.running_high_f, EXCLUDED.running_high_f),
               wu_high_f = GREATEST(metar_observations.wu_high_f, EXCLUDED.wu_high_f),
               wu_high_c = GREATEST(metar_observations.wu_high_c, EXCLUDED.wu_high_c)`,
            [cityKey, station, localToday, observedAt.toISOString(), tempC, tempF, runHighC, runHighF, wuHighF, wuHighC]
          );
          writes++;
        } catch (err) {
          this._log('warn', 'Fast poll obs write failed', { city: cityKey, station, error: err.message });
        }
      }
    }
    return writes;
  }

  /**
   * Fetch PWS current observations for all active cities in parallel.
   * Returns Map: cityKey → { stationIds, temps, ages, online, median, max, min, spread }
   */
  async _fetchPwsBatch(activeCities, metarMap) {
    const WU_API_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';
    const PWS_MAX_AGE_SEC = 300; // 5 min — discard stale readings
    const PWS_TIMEOUT_MS = 8000;
    const PWS_SANITY_DIFF = 30; // reject if abs(pws - metar) > 30 (broken sensor)
    const BIAS_MIN_SAMPLES = 576; // min samples before applying correction
    const pwsMap = new Map();
    let total429s = 0;

    // Refresh bias cache every 30 min (resolver updates it each cycle)
    if (Date.now() - this._pwsBiasLoadedAt > 1800000) {
      await this._loadPwsBiasCache();
    }

    // Ensure fetch module is loaded
    if (!this.fetchModule) {
      this.fetchModule = (await import('node-fetch')).default;
    }
    const fetchFn = this.fetchModule;

    // Build flat list of (cityKey, stationId, unit) for parallel fetch
    const fetchList = [];
    for (const { cityKey, cityConfig } of activeCities) {
      const stations = cityConfig.pwsStations;
      if (!stations || stations.length === 0) continue;
      for (const stationId of stations) {
        const units = cityConfig.unit === 'C' ? 'm' : 'e';
        fetchList.push({ cityKey, stationId, units, unit: cityConfig.unit });
      }
    }

    if (fetchList.length === 0) return pwsMap;

    // Fire all requests in parallel with 8s timeout
    const results = await Promise.allSettled(
      fetchList.map(async ({ cityKey, stationId, units, unit }) => {
        const url = `https://api.weather.com/v2/pws/observations/current?stationId=${stationId}&format=json&units=${units}&apiKey=${WU_API_KEY}`;
        try {
          const resp = await fetchFn(url, { signal: AbortSignal.timeout(PWS_TIMEOUT_MS) }).catch(() => null);
          if (!resp) return { cityKey, stationId, unit, error: 'fetch_failed' };
          if (resp.status === 429) return { cityKey, stationId, unit, error: '429' };
          if (!resp.ok) return { cityKey, stationId, unit, error: `http_${resp.status}` };
          const data = await resp.json();
          const obs = data?.observations?.[0];
          if (!obs) return { cityKey, stationId, unit, error: 'no_observations' };

          const tempField = unit === 'C' ? obs.metric : obs.imperial;
          const temp = tempField?.temp;
          if (temp == null || !Number.isFinite(temp)) return { cityKey, stationId, unit, error: 'no_temp' };

          const epoch = obs.epoch;
          const ageSec = epoch ? Math.round(Date.now() / 1000 - epoch) : null;
          const lat = obs.lat != null ? obs.lat : null;
          const lon = obs.lon != null ? obs.lon : null;

          return { cityKey, stationId, unit, temp, ageSec, epoch, lat, lon };
        } catch (err) {
          return { cityKey, stationId, unit, error: err.message };
        }
      })
    );

    // Build METAR temp lookup for sanity filter
    const cityMetarTemp = new Map();
    for (const { cityKey, cityConfig } of activeCities) {
      const station = cityConfig.polymarketStation || cityConfig.nwsStation;
      if (!station) continue;
      const metar = metarMap?.get(station);
      if (metar && metar.temp != null) {
        cityMetarTemp.set(cityKey, cityConfig.unit === 'C' ? metar.temp : Math.round(metar.temp * 9 / 5 + 32));
      }
    }

    // Group results by city
    const cityResults = new Map();
    for (const settled of results) {
      if (settled.status !== 'fulfilled') continue;
      const r = settled.value;
      if (r.error === '429') total429s++;
      if (!cityResults.has(r.cityKey)) cityResults.set(r.cityKey, []);

      const online = !r.error && r.ageSec != null && r.ageSec < PWS_MAX_AGE_SEC && r.ageSec >= 0;

      // Sanity filter: reject readings with extreme METAR divergence
      let sane = true;
      if (online && r.temp != null && cityMetarTemp.has(r.cityKey)) {
        const diff = Math.abs(r.temp - cityMetarTemp.get(r.cityKey));
        if (diff > PWS_SANITY_DIFF) {
          sane = false;
          this._log('warn', `PWS sanity filter: ${r.stationId} ${r.cityKey} temp=${r.temp} metar=${cityMetarTemp.get(r.cityKey)} diff=${diff}`);
        }
      }

      cityResults.get(r.cityKey).push({
        stationId: r.stationId,
        temp: r.error ? null : r.temp,
        ageSec: r.error ? null : r.ageSec,
        online: online && sane,
        lat: r.lat || null,
        lon: r.lon || null,
        error: r.error || null,
      });
    }

    // Compute aggregates per city (raw + corrected)
    for (const [cityKey, stationResults] of cityResults) {
      const stationIds = stationResults.map(s => s.stationId);
      const temps = stationResults.map(s => s.temp);
      const ages = stationResults.map(s => s.ageSec);
      const onlineArr = stationResults.map(s => s.online);
      const lats = stationResults.map(s => s.lat);
      const lons = stationResults.map(s => s.lon);

      // Raw aggregates (online + sane stations only)
      const onlineTemps = stationResults
        .filter(s => s.online && Number.isFinite(s.temp))
        .map(s => s.temp)
        .sort((a, b) => a - b);

      let median = null, max = null, min = null, spread = null;
      if (onlineTemps.length > 0) {
        max = onlineTemps[onlineTemps.length - 1];
        min = onlineTemps[0];
        spread = Math.round((max - min) * 10) / 10;
        const mid = Math.floor(onlineTemps.length / 2);
        median = onlineTemps.length % 2 === 1
          ? onlineTemps[mid]
          : Math.round(((onlineTemps[mid - 1] + onlineTemps[mid]) / 2) * 10) / 10;
      }

      // Distance-weighted corrected temp
      let correctedMedian = null, correctedSpread = null;
      const correctedEntries = []; // { correctedTemp, weight }
      for (const s of stationResults) {
        if (!s.online || !Number.isFinite(s.temp)) continue;
        const bias = this._pwsBiasMap.get(s.stationId);

        // Exclude broken sensors: enough samples but extreme bias
        if (bias && bias.n_samples >= BIAS_MIN_SAMPLES && !bias.reliable) continue;

        let correctedTemp;
        let weight;
        if (bias && bias.n_samples >= BIAS_MIN_SAMPLES && bias.rolling_bias != null && bias.reliable) {
          // Calibrated: apply bias correction + distance weight
          correctedTemp = Math.round((s.temp - bias.rolling_bias) * 10) / 10;
          weight = (bias.distance_to_metar_km && bias.distance_to_metar_km > 0)
            ? 1 / bias.distance_to_metar_km
            : 1; // fallback weight if no distance
        } else {
          // Warmup (no bias entry or < 576 samples): use raw temp, half weight
          correctedTemp = s.temp;
          weight = 0.5;
        }
        correctedEntries.push({ correctedTemp, weight });
      }

      if (correctedEntries.length > 0) {
        const totalWeight = correctedEntries.reduce((sum, e) => sum + e.weight, 0);
        correctedMedian = Math.round(
          correctedEntries.reduce((sum, e) => sum + e.correctedTemp * e.weight, 0) / totalWeight * 10
        ) / 10;
        const corrTemps = correctedEntries.map(e => e.correctedTemp).sort((a, b) => a - b);
        correctedSpread = Math.round((corrTemps[corrTemps.length - 1] - corrTemps[0]) * 10) / 10;
      }

      pwsMap.set(cityKey, {
        stationIds, temps, ages, online: onlineArr, lats, lons,
        median, max, min, spread,
        stationsOnline: onlineTemps.length,
        correctedMedian, correctedSpread,
      });
    }

    // 429 alerting — debounced to once per hour
    if (total429s >= 3) {
      const now = Date.now();
      if (now - this._lastPws429AlertAt > 3600000) {
        this._lastPws429AlertAt = now;
        this._log('warn', `PWS API: ${total429s} 429 responses in this cycle`);
        if (this.alerts) {
          this.alerts.sendNow(`⚠️ PWS API rate limit: ${total429s} HTTP 429 responses in one fast-poll cycle`).catch(() => {});
        }
      }
    }
    if (total429s > 0) {
      this._log('warn', `PWS 429 count: ${total429s}`);
    }

    return pwsMap;
  }

  /**
   * Fire-and-forget: write PWS observation rows for all active cities with data.
   * One row per city per poll cycle.
   */
  async _writePwsObservations(activeCities, pwsMap, metarMap, runningHighMap, nearThresholdCities) {
    let writes = 0;
    const nearThresholdSet = new Set((nearThresholdCities || []).map(c => c.cityKey));

    for (const { cityKey, cityConfig, localToday, stationsByPlatform } of activeCities) {
      const pwsData = pwsMap.get(cityKey);
      if (!pwsData) continue;

      try {
        // METAR context: find the primary station temp + age
        let metarTemp = null;
        let metarAgeSec = null;
        let runningHigh = null;
        const primaryStation = cityConfig.polymarketStation || cityConfig.nwsStation;
        if (primaryStation) {
          const metar = metarMap.get(primaryStation);
          if (metar && metar.temp != null) {
            metarTemp = cityConfig.unit === 'C' ? metar.temp : Math.round(metar.temp * 9 / 5 + 32);
            if (metar.obsTime) {
              metarAgeSec = Math.round(Date.now() / 1000 - metar.obsTime);
            }
          }
          const highRow = runningHighMap.get(`${cityKey}|${localToday}|${primaryStation}`);
          if (highRow) {
            runningHigh = cityConfig.unit === 'C' ? highRow.running_high_c : highRow.running_high_f;
          }
        }

        // nearest_boundary + pws_median_gap only for near-threshold cities (they have ranges loaded)
        let nearestBoundary = null;
        let pwsMedianGap = null;
        if (nearThresholdSet.has(cityKey) && pwsData.median != null) {
          const ntCity = nearThresholdCities.find(c => c.cityKey === cityKey);
          if (ntCity?.ranges) {
            const unit = cityConfig.unit;
            let closestDist = Infinity;
            for (const range of ntCity.ranges) {
              // Unbounded YES: boundary = rangeMin
              if (range.rangeMax == null && range.rangeMin != null) {
                const dist = Math.abs(pwsData.median - range.rangeMin);
                if (dist < closestDist) { closestDist = dist; nearestBoundary = range.rangeMin; }
              }
              // Bounded: both boundaries
              if (range.rangeMin != null) {
                const distMin = Math.abs(pwsData.median - range.rangeMin);
                if (distMin < closestDist) { closestDist = distMin; nearestBoundary = range.rangeMin; }
              }
              if (range.rangeMax != null) {
                const distMax = Math.abs(pwsData.median - range.rangeMax);
                if (distMax < closestDist) { closestDist = distMax; nearestBoundary = range.rangeMax; }
              }
            }
            if (nearestBoundary != null) {
              pwsMedianGap = Math.round((pwsData.median - nearestBoundary) * 10) / 10;
            }
          }
        }

        const stationsConfigured = (cityConfig.pwsStations || []).length;

        await query(
          `INSERT INTO pws_observations
             (city, target_date, station_ids, temps, obs_ages_sec, online,
              station_lats, station_lons,
              pws_median, pws_max, pws_min, pws_spread,
              pws_corrected_median, pws_corrected_spread,
              stations_online, stations_configured,
              metar_temp, metar_age_sec, running_high,
              pws_median_gap, nearest_boundary)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
          [
            cityKey, localToday,
            pwsData.stationIds, pwsData.temps, pwsData.ages, pwsData.online,
            pwsData.lats, pwsData.lons,
            pwsData.median, pwsData.max, pwsData.min, pwsData.spread,
            pwsData.correctedMedian, pwsData.correctedSpread,
            pwsData.stationsOnline, stationsConfigured,
            metarTemp, metarAgeSec, runningHigh,
            pwsMedianGap, nearestBoundary,
          ]
        );
        writes++;
      } catch (err) {
        this._log('warn', `PWS obs write failed for ${cityKey}`, { error: err.message });
      }
    }

    return writes;
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
