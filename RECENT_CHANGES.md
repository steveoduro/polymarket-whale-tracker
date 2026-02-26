# Recent Changes Log

Last updated: 2026-02-26 02:50 UTC

## Commits

### (pending) — WU fast poll integration + wu_leads fix + tiering
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

### d1bbe49 — docs: update RECENT_CHANGES.md with latest deployment logs
**Date:** 2026-02-26

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

## Post-Deployment Logs (2026-02-26 02:50 UTC)

```
Bot restarted at 02:45 UTC, clean startup, 0 errors
WU-leads METAR confirmed events firing with lowered thresholds (1.0°F):
  chicago (37°F), toronto (2°C), seattle (51°F), miami (72°F),
  nyc (43°F), atlanta (62°F), dallas (80°F), denver (66°F)

Scanner: 65 markets scanned, 687 logged, 0 approved
Monitor: 4 open positions, 3 confirmed GW (toronto, chicago, seattle)

Fast poll tiering active — will show "N tiered out" during daytime hours
WU fast poll will fire for near-threshold Polymarket cities during 10am-2pm local
```
