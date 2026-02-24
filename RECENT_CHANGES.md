# Recent Changes Log

Last updated: 2026-02-24

## Commits

### e0f64c0 — Fast poll triggers immediate GW execution on detection
**Date:** 2026-02-24

Previously detection-to-execution lag was up to 4.5 min (fast poll detects at 5s intervals, but GW scan waited for observer 3min + 90s timer). Now when `metarFastPoll()` finds new boundary crossings, it writes observations to DB and immediately triggers `scanGuaranteedWins()` + execution.

Changes:
- `metar-observer.js`: Constructor takes scanner + executor refs
- `metar-observer.js`: `_writeObservationsFromFastPoll()` — writes new highs to `metar_observations` using GREATEST upsert so GW scanner sees fresh data
- `metar-observer.js`: Fast poll GW trigger — scan + execute inline after detections > 0
- `bot.js`: Double-exec guard — 90s GW timer skips if fast poll ran <30s ago

Expected: detection-to-execution drops from ~4.5min to <15s.

---

### 1095717 — Platform-aware station selection in fast poll
**Date:** 2026-02-24

NYC uses KLGA for Polymarket but KNYC for Kalshi resolution. Fast poll now maps each platform to its correct station and evaluates ranges against station-specific METAR temps.

Changes:
- `stationsByPlatform` replaces single station per city
- Running high query keyed by `city|date|station` (not `city|date`)
- Station groups invert the map: station -> platforms for processing
- `_processRangesForCity` gains `platformFilter` + `detection_station` params
- `detection_station` column added to `metar_pending_events`

---

### 19c9a07 — Fix _bothCrossThreshold always-true bug, add Kalshi min gap
**Date:** 2026-02-24

Fixed guaranteed-win entry logic where dual confirmation was always passing. Added platform-aware minimum gap (Kalshi needs wider buffer due to NWS CLI vs METAR divergence).

---

### 02c4c1b — Lower fast poll interval from 20s to 5s
**Date:** 2026-02-24

Reduced `METAR_FAST_POLL_INTERVAL_SECONDS` from 20 to 5 for faster boundary crossing detection.

---

### 8c9ffeb — Batch DB queries in fast poll
**Date:** 2026-02-24

Replaced per-city DB queries with batch queries using `DISTINCT ON` and `ANY($1)`. Reduced from ~42 queries per poll to 2.

---

## Post-Deployment Logs (2026-02-24 22:01 UTC)

```
Cycle #1 complete in 160.5s
  marketsScanned: 38
  logged: 455
  approved: 0
  filtered: 455
  tradesEntered: 0
  monitored: 3
  exits: 0
  resolved: 0
  backfilled: 200

Observer: 22 cities polled, 1 new highs
Observer found 1 new highs — triggering immediate GW scan
Guaranteed-win scan: 1 missed entries (below_min_ask)
METAR fast poll loop: every 5s
Snapshots captured: 38

Source rankings (sample):
  nyc: openmeteo(1.43) > nws(1.5) > mos(1.92 DEMOTED) > ecmwf(2.56) > weatherapi(2.62 DEMOTED)
  chicago: openmeteo(2.35) > weatherapi(2.88) > mos(3 DEMOTED) > nws(3.36) > ecmwf(4.37 DEMOTED)
  miami: openmeteo(0.73) > nws(0.96) > mos(1.2 DEMOTED) > ecmwf(1.5 DEMOTED) > weatherapi(2.78 DEMOTED)
  london: ecmwf(0.36) > ukmo(0.52) > weatherapi(0.6) > openmeteo(0.67 DEMOTED)

City gates:
  seoul: fully eligible (MAE 0.77C, n=11)
  toronto: fully eligible (MAE 0.75C, n=13)
  nyc: unbounded-only (MAE 1.81F > 1.8 bounded threshold, n=13)
  chicago: BLOCKED (MAE 3.83F > 2.7 threshold, n=13)
  atlanta: fully eligible (MAE 1.65F, n=13)
  dallas: fully eligible (MAE 1.28F, n=13)
  seattle: fully eligible (MAE 1.21F, n=13)
  denver: BLOCKED (MAE 6.51F > 2.7 threshold, n=13)
  austin: BLOCKED (MAE 4.25F > 2.7 threshold, n=13)
  los angeles: unbounded-only (MAE 2.28F > 1.8 bounded threshold, n=13)
  miami: fully eligible (MAE 1.16F, n=13)
  london: fully eligible (MAE 0.53C, n=13)
  ankara: fully eligible (MAE 0.85C, n=13)

Model calibration (last 7 days):
  residual std dev: F=6.67 (n=337), C=1.49 (n=170)
  calibration: 0-10% -> 0.7% win rate (n=852), 10-25% -> 5% (n=876)
```
