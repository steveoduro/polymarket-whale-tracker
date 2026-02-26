# Recent Changes Log

Last updated: 2026-02-26 21:45 UTC

## Commits

### (pending) — fix: GW pipeline — allow multiple NOs, fix Kalshi missed alerts, platform-aware dedup
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

### ebfd735 — fix: _checkWULeads queryOne destructuring bug
**Date:** 2026-02-26

- `_checkWULeads()` used `const existingRow = await queryOne(...)` — queryOne returns `{data, error}` wrapper, always truthy
- This caused every poll to enter the "existing row" branch, never reaching the INSERT path
- Result: wu_leads_events table was permanently empty despite correct thresholds
- Fix: `const { data: existingRow } = await queryOne(...)`

Files: `lib/metar-observer.js`

---

### f027fd6 — fix: call _checkWULeads from fast poll where METAR-only values are available
**Date:** 2026-02-26

- Self-defeating write order: fast poll writes `running_high = max(wu, metar)` to DB, then observe() reads it back and `_checkWULeads` sees gap=0
- Fix: call `_checkWULeads` from the fast poll's `hasWUEnhancement` block where METAR-only effHigh values are still available
- Manually backfilled 2 wu_leads_events: Wellington (gap=2°C) and NYC (gap=2°F)

Files: `lib/metar-observer.js`

---

### 805ca8e — feat: thread wu_triggered through alerts for detection source visibility
**Date:** 2026-02-26

- metarPending alert: title/obs line switches based on wuTriggered (WU vs METAR boundary crossed)
- guaranteedWinDetected: header shows "(WU-LED)" for wu_triggered entries
- tradeEntry: observation line shows "WU: X → METAR: Y" for wu_triggered
- Scanner: batch query wu_triggered flags from metar_pending_events into scanGuaranteedWins entries
- Executor: passes wu_triggered through to trade record

Files: `lib/alerts.js`, `lib/scanner.js`, `lib/executor.js`, `lib/metar-observer.js`

---

### 8d66de8 — feat: WU fast poll integration + wu_leads tuning + tiering
**Date:** 2026-02-26

Three-part fix to improve GW detection speed and reduce fast poll overhead:

**Fix 1 — wu_leads config tuning:**
- `WU_LEAD_MIN_GAP_F`: 2.5 → 1.0 (only 1/29 events exceeded 2.5°F)
- `WU_LEAD_MIN_GAP_C`: 1.5 → 0.5
- `WU_LEAD_MAX_LOCAL_HOUR`: 12 → 14 (captures 12-2pm rising phase)

**Fix 2 — WU in fast poll for near-threshold Polymarket cities:**
- `WUScraper` constructor now accepts `{ requestDelay }` option (default 2500ms)
- Second `fastPollWUScraper` instance with `requestDelay: 0` for parallel calls
- Fast poll restructured into 3 passes:
  1. Near-threshold check (tiering): skip cities not within 1°F/0.5°C of a GW boundary
  2. Parallel WU calls for Polymarket near-threshold cities (3s timeout)
  3. Process with platform-split: WU-enhanced for Polymarket, METAR-only for Kalshi
- `_processRangesForCity` gains `wuTriggered` param → stored in `metar_pending_events`
- `_writeObservationsFromFastPoll` writes WU-enhanced `running_high` for Polymarket stations
- Dual-station guard: WU only applied to Polymarket station (KLGA not KNYC, KORD not KMDW)

**DB migration:**
- `ALTER TABLE metar_pending_events ADD COLUMN wu_triggered BOOLEAN DEFAULT false`

Files: `config.js`, `lib/wu-scraper.js`, `lib/metar-observer.js`

---

## Post-Deployment Logs (2026-02-26 21:45 UTC)

```
Bot restarted at 21:42 UTC, clean startup, cycle #1 complete in 174.0s
Scanner: 67 markets scanned, 756 logged, 0 approved
Monitor: 9 open positions
Fast poll WU: 13/13 responses (all near-threshold cities)
GW scan: 2 missed entries (below_min_ask) — Kalshi $1 markets now filtered silently
WU fast poll: NYC METAR=45°F, WU=47°F (enhancement active)
```
