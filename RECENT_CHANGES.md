# Recent Changes Log

Last updated: 2026-02-27 00:16 UTC

## Commits

### (pending) — fix: GW station bug, pending event gate, position pre-filter, bid sanity check
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

## Post-Deployment Logs (2026-02-27 00:16 UTC)

```
Bot restarted at 00:12 UTC with all 4 GW fixes, clean startup
10 open positions (8 prior + 2 bad Chicago trades from station bug)

Cycle #1 (00:12-00:15):
  Monitor: 10 positions, 0 exits, 10 holds
  GW scan: 1 missed entry (below_metar_gap) — down from 5 before fixes
  No Chicago re-entries (pending event gate + station fix working)
  Fast poll: 25 cities (3 tiered out), 0 detections, 11/11 WU
  Observer: 27 cities polled, 0 new highs

No errors. No crashes. Empty error log.
```
