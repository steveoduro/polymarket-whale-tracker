# Recent Changes Log

Last updated: 2026-02-27 15:39 UTC

## Commits

### (pending) — feat: per-city calibration for cal_confirms
**Date:** 2026-02-27

**Problem:** `market_calibration` had no city dimension — pooled all cities together. Atlanta's 8-14% win rate was masked by Seoul's 44% in shared buckets. cal_confirms entered Atlanta trades using Seoul's win rate → consistent losses.

**Changes:**
- Added `city` column to `market_calibration` table (nullable — global rows leave it null)
- `_refreshCalibrationTable()` in resolver.js: added second INSERT block that groups by city with `HAVING COUNT(*) >= 10`
- `_getCalibration()` in scanner.js: new optional `city` param — tries city-specific key first (n >= 15 gate), falls back to global
- `_loadCalibration()`: key construction now differentiates global vs city rows
- All 3 `_getCalibration` call sites pass city (Kelly sizing, logging, calConfirmsEdge decision)
- `calBucket` logging includes `|city` suffix when city row was used
- Removed `_loadCityCalibration()`, `this._cityCal`, and zero-wins veto block (all redundant now)
- Updated unique constraint to include city: `COALESCE(city, '')`

**Result:** 176 global + 355 city = 531 calibration buckets loaded. Atlanta `bounded|12-24h|15-20c` now shows 0% city win rate (n=15) vs 10% global — cal_confirms correctly blocks.

Files: `lib/scanner.js`, `lib/resolver.js`, DB migration

---

### da746ac — fix: GW station bug, pending event gate, position pre-filter, bid sanity check
**Date:** 2026-02-27

**Fix 1 — Station-aware observation query (critical):**
- `scanGuaranteedWins()` used `_getLatestObservation(city, date)` with no station filter
- For dual-station cities (Chicago KORD/KMDW, NYC KLGA/KNYC), whichever wrote last won
- Chicago KMDW=42°F was used for PM ranges when KORD=41°F is correct → entered 2 losing trades
- Fix: `_getLatestObservation` accepts optional stationId; scanner loads per-platform observations

**Fix 2 — Gate scanGuaranteedWins on pending events:**
- 90s fallback was a price-polling engine — re-entered on stale crossings when ask drifted
- Chicago trades entered 82-96 min after detection, no new METAR data, just ask drift
- Fix: load `metar_pending_events` at scan start, skip ranges with no temperature crossing
- Fails open if query errors (existing behavior preserved)

**Fix 3 — Pre-filter open positions before filter chain:**
- Dedup ran after ask filters → held positions with repriced ask hit `missed[]`
- Produced false "GUARANTEED WIN MISSED" Telegram alerts for positions already held
- Fix: early continue at top of range loop using `_positionKeys` (both methods)

**Fix 4 — GW_MIN_BID market sanity check:**
- Chicago YES "42°F or higher" had bid=$0.01, ask=$0.33 — market priced near-zero
- Scanner entered anyway because it only checked ask
- Fix: `GW_MIN_BID: 0.10` in config, check in both `scanGuaranteedWins` and `evaluateGWFastPath`
- Shows as `below_min_bid` in missed alerts

**Result:** GW scan went from 5 missed entries → 1 (legitimate `below_metar_gap`). No false re-entries.

Files: `config.js`, `lib/scanner.js`, `lib/metar-observer.js`, `lib/alerts.js`

---

### f98e414 — feat: GW fast-path pipeline + fix kalshi_ask_at_detection overwrite bug
**Date:** 2026-02-26

Files: `lib/metar-observer.js`, `lib/scanner.js`, `lib/executor.js`, `lib/platform-adapter.js`

---

### 7c84ac9 — fix: GW pipeline — allow multiple NOs, fix Kalshi missed alerts, platform-aware dedup
**Date:** 2026-02-26

Files: `lib/scanner.js`, `lib/executor.js`

---

### 83f0333 — fix: don't show WU temp in Kalshi missed alerts (Kalshi resolves via NWS)
**Date:** 2026-02-26

Files: `lib/alerts.js`

---

### 8d66de8 — feat: WU fast poll integration + wu_leads tuning + tiering
**Date:** 2026-02-26

Files: `config.js`, `lib/wu-scraper.js`, `lib/metar-observer.js`

---

## Post-Deployment Logs (2026-02-27 15:39 UTC)

```
Bot restarted at 15:28 UTC with per-city calibration changes

Cycle #1 (15:28-15:31):
  Scanner: Loaded 176 calibration buckets (pre-rebuild, global only)
  Scan: 68 markets, 865 logged, 0 approved, 0 entered
  Monitor: 2 positions, 0 exits, 2 holds
  Observer: 28 cities polled, 2 new highs
  Resolver: Market calibration table refreshed (now has global + city rows)
  Backfilled 200 opportunities
  Cycle complete in 182.9s

Cycle #2 (15:36-15:39):
  Scanner: Loaded 531 calibration buckets (176 global + 355 city)
  Scan: 68 markets, 865 logged, 0 approved, 0 entered
  Monitor: 2 positions, 0 exits, 2 holds
  Observer: 28 cities polled, 2 new highs (nyc KLGA 35°F, nyc KNYC 37°F)
  Fast poll: 26 cities (19 tiered out), 0 detections, 7/7 WU
  Resolver: Market calibration table refreshed
  Cycle complete in 147.0s

No errors. No crashes. Empty error log.
```
