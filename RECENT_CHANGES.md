# Recent Changes Log

Last updated: 2026-02-28 01:10 UTC

## Commits

### (latest) — PWS bias correction framework (data collection only)

**Date:** 2026-02-28

**Changes:**
- **pws_station_bias table**: Per-station rolling bias, stddev, distance to METAR, reliable flag
- **Resolver**: `_updatePwsStationBias()` runs each cycle — unnests pws_observations arrays, computes 21-day rolling bias per station, upserts bias table. Min 576 samples (~1 active day) before marking reliable.
- **Observer**: Loads bias cache every 30 min. Applies sanity filter (reject abs(pws-metar) > 30°F). Computes distance-weighted corrected median during warmup (raw temp, half weight) and post-calibration (bias-corrected, 1/distance weight). Captures station lat/lon from API responses.
- **New columns on pws_observations**: `pws_corrected_median`, `pws_corrected_spread`, `station_lats`, `station_lons`
- **NO changes to GW detection or trading logic** — corrected values written for analysis only

Files: `lib/resolver.js`, `lib/metar-observer.js`, DB migration

---

### 75a529c — PWS data collection integration

**Date:** 2026-02-28

**Changes:**
- Added `pwsStations` config for all 28 cities (78 stations total: 26 cities with coverage, ankara=0)
- Created `pws_observations` table with per-poll rows (station arrays, aggregates, METAR context)
- `_fetchPwsBatch()`: parallel 8s-timeout requests for ~45 stations, 429 alerting
- `_writePwsObservations()`: fire-and-forget after GW processing
- PWS coverage summary logged at startup

Files: `config.js`, `lib/metar-observer.js`, `bot.js`, DB migration

---

### (prev) — GW research: same-batch adjacent-NO protection + Kalshi GW verification

**Date:** 2026-02-27

Files: `lib/scanner.js`

---

## Post-Deployment Logs (2026-02-28 01:08 UTC)

```
Bot running with PWS data collection + bias framework

PWS status:
  Coverage: 25 cities x 3 stations, 1 city x 2 (phoenix), 1 x 1 (seoul), 1 x 0 (ankara)
  Bias table: 65 stations, 0 reliable (all warmup <576 samples), 0 unreliable
  Sanity filter active: KLAGRETN14 (new orleans) -37°F rejected (diff=109 vs metar)
  Corrected median: populated (equals raw during warmup, will diverge post-calibration)

Fast poll cycle:
  25 cities polled, 58-61 stations online per cycle
  Cycle time: 10-11s (PWS adds negligible latency)
  WU: 9/9 near-threshold responses
  Zero 429 errors, zero API issues

Resolver:
  PWS station bias updated: 65 stations each cycle
  Market calibration, model calibration, city error distribution all refreshed

GW detection:
  Unaffected — 0 detections (evening hours, temps declining)
  Dallas 80-81 NO still held (running high 82°F)

Empty error log.
```
