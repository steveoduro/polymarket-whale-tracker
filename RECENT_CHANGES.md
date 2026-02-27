# Recent Changes Log

Last updated: 2026-02-27 21:45 UTC

## Commits

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

## Post-Deployment Logs (2026-02-27 21:37 UTC)

```
Bot restarted at 21:34 UTC with CLI-only Kalshi resolution

Cycle #1:
  Scanner: 67 markets, 771 logged, 0 approved
  Monitor: 3 positions (incl Dallas 80-81 GW), 0 exits
  Resolver: 0 trades resolved (Dallas stays open — CLI for today not yet available), 200 opps backfilled
  CLI vs NWS obs mismatch logged: denver 2026-02-25 (cli=67, nws=66, diff=1)
  Materialized views refreshed

Backfill corrections applied:
  24,311 opportunities: actual_temp corrected to CLI
  6,113 opportunities: would_have_won flipped
  4 trades: actual_temp corrected
  41 market_resolutions: actual_temp corrected
  10 forecast_accuracy: actual_temp, error, abs_error corrected
  All 3 mviews refreshed

Empty error log.
```
