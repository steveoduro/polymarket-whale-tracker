# Recent Changes Log

Last updated: 2026-02-26 23:15 UTC

## Commits

### (pending) — feat: GW fast-path pipeline + fix kalshi_ask_at_detection overwrite bug
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

## Post-Deployment Logs (2026-02-26 23:13 UTC)

```
Bot restarted at 23:13 UTC, clean startup
Cycle #1: 66 markets scanned, 731 logged, 0 approved, 8 positions monitored
Fast poll: 25 cities (4 tiered out), 0 detections (late evening, past peak hours)
WU fast poll: 11/11 responses
New fast-path GW pipeline active — will exercise on next boundary crossing
```
