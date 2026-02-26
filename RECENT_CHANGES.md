# Recent Changes Log

Last updated: 2026-02-26 16:35 UTC

## Commits

### (pending) — fix: _checkWULeads queryOne destructuring bug
**Date:** 2026-02-26

- `_checkWULeads()` used `const existingRow = await queryOne(...)` — queryOne returns `{data, error}` wrapper, always truthy
- This caused every poll to enter the "existing row" branch, never reaching the INSERT path
- Result: wu_leads_events table was permanently empty despite correct thresholds
- Fix: `const { data: existingRow } = await queryOne(...)`

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

### 1fe5a76 — Fast poll 5s→15s + overlap guard
**Date:** 2026-02-26

- `METAR_FAST_POLL_INTERVAL_SECONDS: 5` → `15` (28 cities at 5s caused overlapping polls)
- Added `_fastPollRunning` mutex in bot.js to prevent concurrent fast polls
- Result: clean non-overlapping polls, ~5-12s typical duration

---

### fb4bb08 — Kalshi city expansion, dead ticker cleanup, stale platform alerts
**Date:** 2026-02-25

- **11 stale Kalshi tickers fixed**: Kalshi migrated from KXHIGH→KXHIGHT prefix
- **6 dead international KALSHI_SERIES removed**: toronto, buenos aires, ankara, wellington, london, seoul
- **3 new Kalshi cities**: san antonio, minneapolis, oklahoma city
- **Stale platform alert**: scanner tracks consecutive cycles with 0 markets per city/platform

---

## Post-Deployment Logs (2026-02-26 16:35 UTC)

```
Bot restarted at 16:32 UTC, clean startup, cycle #1 complete in 190.9s
Scanner: 68 markets scanned, 835 logged, 0 approved
Monitor: 2 open positions
Fast poll WU: 11/11 responses (nyc, chicago, miami, atlanta, seattle, london, toronto, buenos aires, ankara, paris, sao paulo)
GW scan: 1 missed entry (above_max_ask)

wu_leads_events: 0 rows (queryOne bug just fixed — METAR currently leads WU in all cities, WU-leads pattern fires when WU peaks before METAR during 12-2pm rising phase)
```
