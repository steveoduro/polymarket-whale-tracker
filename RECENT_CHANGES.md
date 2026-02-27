# Recent Changes Log

Last updated: 2026-02-27 21:01 UTC

## Commits

### (pending) — GW research: fix dropped detections, adjacent-NO protection, race dedup, range_type bug
**Date:** 2026-02-27

**Changes:**
- **GW Research Fix #1 — Dropped detections**: 30s suppression window → 3s debounce (was blocking 90s fallback scan)
- **GW Research Fix #1 — Pending event trigger**: `_checkMetarPending()` returns newAlerts count, `observe()` surfaces `newPendingEvents`, event-driven GW scan fires on new pending events (not just new highs)
- **Adjacent-NO protection**: Skip NO entry when `range_max <= open YES range_min` (correlated risk). 3-layer check: executor DB safety net + scanner `scanGuaranteedWins` + fast-path `evaluateGWFastPath`
- **Race dedup**: In-memory `_gwSubmitted` Set on Executor closes race window between async DB duplicate checks
- **range_type bug fix**: GW fast-poll candidates now include `range_type` — was causing NOT NULL constraint violation on trades INSERT (blocked Dallas 80-81 and OKC 77-78 entries)

Files: `bot.js`, `lib/executor.js`, `lib/scanner.js`, `lib/metar-observer.js`, `GW_RESEARCH.md`

---

### ee95760 — fix: float precision in edge features, calibration reads from mview, mview index
**Date:** 2026-02-27

Files: `lib/scanner.js`, `lib/resolver.js`, DB migration

---

### 9960524 — feat: database schema restructure — market_resolutions, ML features, mviews
**Date:** 2026-02-27

Files: `lib/scanner.js`, `lib/resolver.js`, `ml_win_predictor.py`, `SCHEMA.md`, DB migrations

---

### 60242b8 — feat: per-city calibration for cal_confirms
**Date:** 2026-02-27

Files: `lib/scanner.js`, `lib/resolver.js`, DB migration

---

## Post-Deployment Logs (2026-02-27 21:01 UTC)

```
Bot restarted at 21:00 UTC with GW research fixes

Key events from previous cycle:
  Observer: 28 cities polled, 0 new highs, 0 new pending (new log format working)
  GW fast-poll detected: dallas 80-81°F NO (ask=0.90, Kalshi), oklahoma city 77-78°F NO (ask=0.93, Kalshi)
  GW fast-path: 2 entries approved from 3 candidates
  ERROR: range_type NULL constraint on trades INSERT — FIXED in this commit
  90s fallback scan running correctly (no suppression)

Empty error log after restart.
```
