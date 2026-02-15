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
const { db } = require('./db');
const WUScraper = require('./wu-scraper');

const METAR_API_BASE = 'https://aviationweather.gov/api/data/metar';

class METARObserver {
  constructor(alerts) {
    this.alerts = alerts;
    this.fetchModule = null;
    this.wuScraper = new WUScraper();
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
    const { data: openTrades, error } = await db
      .from('trades')
      .select('city, target_date, platform')
      .eq('status', 'open');

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

      // Polymarket cities: WU is authoritative for running_high
      // Kalshi-only cities: METAR is authoritative
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

              // For Polymarket cities: WU drives the running high
              if (hasPolymarket) {
                const authHighF = Math.max(wuObs.highF, obs.runningHighF);
                const authHighC = Math.max(wuObs.highC, obs.runningHighC);
                if (authHighF !== obs.runningHighF || authHighC !== obs.runningHighC) {
                  await db.from('metar_observations')
                    .update({ running_high_f: authHighF, running_high_c: authHighC })
                    .eq('city', cityKey)
                    .eq('target_date', localToday)
                    .eq('observed_at', obs.observedAt);
                  this._log('info', `WU authoritative update: ${cityKey}`, {
                    metar: metarHigh, wu: wuHigh,
                    runningHigh: info.unit === 'C' ? authHighC : authHighF,
                  });
                }
              }
            } else if (hasPolymarket) {
              // WU failed — METAR fallback for Polymarket city
              this._log('warn', `WU unavailable for ${cityKey}, using METAR fallback`);
            }
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
    const { data: existing } = await db
      .from('metar_observations')
      .select('running_high_c, running_high_f, observation_count')
      .eq('city', city)
      .eq('target_date', dateStr)
      .eq('station_id', stationId)
      .order('created_at', { ascending: false })
      .limit(1);

    const prevHighC = existing?.[0]?.running_high_c ?? -Infinity;
    const prevHighF = existing?.[0]?.running_high_f ?? -Infinity;
    const prevCount = existing?.[0]?.observation_count ?? 0;
    const isNewHigh = tempC > prevHighC;

    const runningHighC = Math.max(tempC, prevHighC === -Infinity ? tempC : prevHighC);
    const runningHighF = Math.max(tempF, prevHighF === -Infinity ? tempF : prevHighF);

    // Insert observation row
    const { error: insertErr } = await db
      .from('metar_observations')
      .upsert({
        city,
        station_id: stationId,
        target_date: dateStr,
        observed_at: observedAt.toISOString(),
        temp_c: tempC,
        temp_f: tempF,
        running_high_c: runningHighC,
        running_high_f: runningHighF,
        observation_count: prevCount + 1,
      }, { onConflict: 'city,target_date,observed_at' });

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
   * Update the latest METAR observation row with WU cross-validation data.
   */
  async _updateWUData(city, targetDate, observedAt, wuObs) {
    try {
      await db.from('metar_observations')
        .update({
          wu_high_f: wuObs.highF,
          wu_high_c: wuObs.highC,
          wu_observation_count: wuObs.observationCount,
        })
        .eq('city', city)
        .eq('target_date', targetDate)
        .eq('observed_at', observedAt);
    } catch (err) {
      this._log('warn', `Failed to update WU data`, { city, error: err.message });
    }
  }
}

module.exports = METARObserver;
