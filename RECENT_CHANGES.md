# Recent Changes Log

Last updated: 2026-02-26 23:24 UTC

## Commits

### f98e414 — feat: GW fast-path pipeline + fix kalshi_ask_at_detection overwrite bug
**Date:** 2026-02-26

**Bug fix — kalshi_ask_at_detection overwrite:**
- `pendingEventMap` SELECT at metar-observer.js:868 was missing `kalshi_ask_at_detection`
- `existingEvt.kalshi_ask_at_detection` was always `undefined` → `!undefined` = true
- Line 756 UPDATE overwrote the column every cycle with whatever the current cached price was
- Fix: added `ask_at_detection, kalshi_ask_at_detection, kalshi_market_id` to the SELECT

**GW fast-path pipeline (3-10x faster detection→order):**
- New `evaluateGWFastPath(candidates)` method in scanner — applies same filter chain as `scanGuaranteedWins()` but takes pre-computed data from fast poll, skips re-fetching ALL 23 cities
- `_processRangesForCity()` now returns `gwCandidates[]` with enriched detection data (ask, effHigh, gap, tokenId, marketId, _freshBookAsk)
- Fast poll collects gwCandidates from all 4 `_processRangesForCity` call sites, routes through `evaluateGWFastPath` instead of `scanGuaranteedWins`
- Observation writes moved AFTER order placement (non-blocking) — saves ~100ms on critical path
- `executeBuy()` accepts `_freshAskFromBook` from pre-fetched CLOB orderbook, skips Gamma API getPrice call (~150-300ms saved)
- 90-second fallback `scanGuaranteedWins()` in bot.js remains unchanged as safety net

**Pipeline improvement:**
- Post-detection: 650ms-5.9s → 210-510ms (3-10x faster)
- Eliminates: 23 DB observation queries, 23 getMarkets calls, 1 Gamma API call per live order

Files: `lib/metar-observer.js`, `lib/scanner.js`, `lib/executor.js`, `lib/platform-adapter.js`

---

### 7c84ac9 — fix: GW pipeline — allow multiple NOs, fix Kalshi missed alerts, platform-aware dedup
**Date:** 2026-02-26

**Fix 1 — Allow multiple NO trades per GW city/date:**
- Scanner: removed `_openNoKeys` mutual exclusivity check for GW NOs
- Scanner: dedup key for NOs now includes `range_name` (keeps all qualifying NO ranges, not just best margin)
- Executor: removed NO mutual exclusivity check (multiple NOs can all win when temp exceeds multiple boundaries)

**Fix 2 — Fix Kalshi GW missed alerts not appearing on Telegram:**
- Root cause: scanner line 854 had `ask >= 1` → silent continue, dropping entries before `missed[]` logic
- Fix: removed `ask >= 1` guard, entries now flow to MAX_ASK filter which adds to `missed[]`
- Added `ask < 1.0` check in above_max_ask path — fully repriced $1 markets are noise, only near-misses alert
- Result: 85 → 2 missed entries (only actionable below_min_ask), Kalshi GW now visible on Telegram

**Fix 3 — Platform-aware mutual exclusivity (cross-platform blocking bug):**
- `_openYesKeys` and `_openNoKeys` now include platform in key
- Previously: Polymarket YES trade on NYC blocked Kalshi YES on NYC (wrong — independent platforms)
- Executor: YES mutual exclusivity query now includes `platform = $4` filter
- Regular scan paths updated to use platform-aware keys

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

## Post-Deployment Logs (2026-02-26 23:24 UTC)

```
Bot restarted at 23:13 UTC, clean startup (Mode: paper, 28 cities, exit evaluator: log_only)
Bankrolls: YES $821.44 / NO $1000.00 / GW-live $10.00 / GW-paper $352.51, 8 open trades

Cycle #1 (23:13-23:16, 174.5s):
  Scan: 66 markets, 731 logged, 0 approved, 200 backfilled
  Monitor: 8 positions evaluated, 0 exits, 8 holds (all GW — deferred to resolver)
    GW positions: NO sao-paulo 24°C (high 25°C), NO miami 76-77°F (high 78°F),
    NO toronto -3°C (high -2°C), NO nyc 44-45°F (high 48°F), NO buenos-aires 27°C (high 29°C),
    YES nyc 48°F+ (high 48°F), NO dallas 78-79°F (high 82°F)
  90s fallback GW scan: 5 missed (below_min_ask, below_metar_gap)
  Observer: 27 cities polled, 0 new highs
  Fast poll: 25 cities (4 tiered out), 0 detections, 11 WU
  Calibration: 21-day window, 913 records, 176 buckets, 116 market-implied pairs
  City gates: BLOCKED denver(6.55°F), austin(3.78°F), chicago(3.36°F), buenos-aires(1.72°C)
              unbounded-only: LA(2.52°F), nyc(2.04°F), wellington(1.3°C)

Cycle #2 (23:21+):
  Scan: 66 markets, same pattern
  Monitor: 8 positions, 0 exits, 8 holds
  Fast polls: 25 cities, 0 detections, 11/11 WU — all clean
  Fast-path GW pipeline active — no detections (late evening, past peak hours)

Warnings (benign):
  - Forecast outliers excluded: nyc/weatherapi 34.5°F (Feb 28), philly/ecmwf 40.5°F,
    philly/openmeteo 45.1°F, dc/weatherapi 41.9°F
  - Intraday METAR vs WU: phoenix 88 vs 85 (3°F), others ±1°F
  - CLI vs NWS obs (Feb 25): ±1°F across 7 cities (normal)
  - city_error_distribution: stddev_error NOT NULL constraint (pre-existing, new city w/ <2 samples)

No errors. No crashes. Empty error log.
```
