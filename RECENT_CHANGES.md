# Recent Changes Log

Last updated: 2026-02-27 22:15 UTC

## Commits

### (pending) — GW research: fix fast-path parity, duplicate alert dedup

**Date:** 2026-02-27

**Changes:**
- **Bug**: `evaluateGWFastPath` (fast-poll entry builder) was missing `wu_high`, had `dual_confirmed` hardcoded false, and `entry_reason` always `guaranteed_win_metar_only` — while `scanGuaranteedWins` (slow path) computed all three correctly
- **Fix**: Fast-path now passes `metar_high` and `wu_high` separately through candidate objects, computes `dual_confirmed` by checking both sources independently cross the boundary, sets `entry_reason` based on result
- **Bug**: Duplicate Telegram "Executing..." alerts — fast-poll sent alert, then event-driven GW scan in main cycle re-detected same entry and sent second alert
- **Fix**: Event-driven GW scan now gated by same 3s fast-poll debounce as the 90s timer scan

Files: `bot.js`, `lib/scanner.js`, `lib/metar-observer.js`

---

### (pending) — GW research: Kalshi resolution must use CLI, not NWS obs
**Date:** 2026-02-27

**Changes:**
- **Bug**: Kalshi trades resolved at midnight local using NWS hourly obs instead of CLI (the authoritative source Kalshi actually uses). CLI isn't published until ~6-7 AM local. NWS obs can differ by 1-2°F.
- **Fix**: `_getActualHigh()` for Kalshi now waits for CLI. For dates <3 days old, returns null if CLI unavailable (trade stays open). Falls through to NWS obs only for dates >3 days old (permanent CLI gaps).
- **Cache fix**: `cliCache` now cleared every resolver cycle (was persisting stale data across cycles, preventing CLI from being found after publication)
- **Backfill**: Corrected 24,311 Kalshi opportunities, 4 trades, 41 market_resolutions, 10 forecast_accuracy rows with CLI temps. 6,113 opportunity `would_have_won` values were wrong.

Files: `lib/resolver.js`, DB backfill

---

### 3bf6fdd — GW research: fix dropped detections, adjacent-NO protection, race dedup, range_type bug
**Date:** 2026-02-27

Files: `bot.js`, `lib/executor.js`, `lib/scanner.js`, `lib/metar-observer.js`, `GW_RESEARCH.md`

---

### ee95760 — fix: float precision in edge features, calibration reads from mview, mview index
**Date:** 2026-02-27

Files: `lib/scanner.js`, `lib/resolver.js`, DB migration

---

## Post-Deployment Logs (2026-02-27 22:13 UTC)

```
Bot restarted at 22:10 UTC with fast-path parity + alert dedup fixes

Cycle #1:
  Scanner: 67 markets, 764 logged, 0 approved
  Monitor: 3 positions (incl Dallas 80-81 GW), 0 exits
  Observer: 28 cities polled, 0 new highs, 0 new pending
  GW scan: 2 missed (below_metar_gap, above_max_ask)
  Resolver: 0 resolved, 200 opps backfilled
  Fast poll: running every 15s, WU 10/10 responses
  CLI vs NWS obs mismatch: nyc 2026-02-26 (cli=49, nws=48), san antonio 2026-02-26 (cli=95, nws=93)

Empty error log.
```
