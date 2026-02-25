# Recent Changes Log

Last updated: 2026-02-25 00:15 UTC

## Commits

### Fix missed-alert debounce resetting at UTC midnight
**Date:** 2026-02-25

The `_missedAlerted` debounce Set was resetting at midnight UTC based on `new Date().toISOString()`. American cities are still on the previous local date for 5-8 hours after that boundary, so the same missed entry (NYC Kalshi 30-31° NO) re-triggered a Telegram alert at 7:03 PM EST (00:03 UTC).

Changes:
- `scanner.js`: Replaced UTC-date-based Set reset with 2-day TTL pruning — entries stay until `target_date` is 2+ days old
- `scanner.js`: Changed debounce key delimiter from `_` to `|` to avoid ambiguity with city names containing underscores (e.g. `los_angeles`)
- Removed unused `_missedAlertedDate` field

---

### a1761d7 — Kalshi gap check always applies regardless of dual confirmation
**Date:** 2026-02-24

WU and METAR both read KLGA-area temps for NYC, so dual confirmation from the same geographic location doesn't reduce the KLGA-to-KNYC divergence risk. The 1.5F Kalshi gap buffer was wrapped inside `if (!dualConfirmed)` — when both sources agreed (they always will, same station), the gap check was skipped entirely.

Changes:
- `scanner.js`: Changed `if (!dualConfirmed)` to `if (!dualConfirmed || isKalshi)` so the Kalshi min gap always runs
- `scanner.js`: Added `_missedAlerted` Set for daily debounce — `scanGuaranteedWins()` filters missed array before returning, preventing repeated Telegram alerts for the same missed entries

Background: NYC trade on Feb 24 — KLGA hit 32F, gap was only 0.5F above threshold. Central Park (KNYC) stayed at 30-31F. Only saved from a bad entry because ask was already below MIN_ASK.

---

### Bulk backfill of 228K unresolved opportunities
**Date:** 2026-02-24 (manual SQL, no code change)

The resolver was processing only 200 opps/cycle via individual API calls. Backlog of 228,475 unresolved opportunities (from Feb 20 probability fix) would have taken ~95 hours to drain. Bulk SQL UPDATE joining `v2_forecast_accuracy` resolved 220,664 rows instantly. Remaining 7,611 (Seoul/Wellington Feb 20-21 missing from accuracy table) backfilled from `metar_observations` running highs.

Result: Cycle time dropped from 121-160s to ~100s. Calibration tables (`market_calibration`, `model_calibration`) rebuilt with full dataset on next cycle.

---

### e0f64c0 — Fast poll triggers immediate GW execution on detection
**Date:** 2026-02-24

Previously detection-to-execution lag was up to 4.5 min (fast poll detects at 5s intervals, but GW scan waited for observer 3min + 90s timer). Now when `metarFastPoll()` finds new boundary crossings, it writes observations to DB and immediately triggers `scanGuaranteedWins()` + execution.

Changes:
- `metar-observer.js`: Constructor takes scanner + executor refs
- `metar-observer.js`: `_writeObservationsFromFastPoll()` — writes new highs to `metar_observations` using GREATEST upsert so GW scanner sees fresh data
- `metar-observer.js`: Fast poll GW trigger — scan + execute inline after detections > 0
- `bot.js`: Double-exec guard — 90s GW timer skips if fast poll ran <30s ago

Expected: detection-to-execution drops from ~4.5min to <15s.

---

### 1095717 — Platform-aware station selection in fast poll
**Date:** 2026-02-24

NYC uses KLGA for Polymarket but KNYC for Kalshi resolution. Fast poll now maps each platform to its correct station and evaluates ranges against station-specific METAR temps.

---

## Post-Deployment Logs (2026-02-25 00:15 UTC)

```
Cycle #2 complete in 86.4s
  marketsScanned: 37
  logged: 426
  approved: 0
  filtered: 426
  tradesEntered: 0
  monitored: 3
  exits: 0
  resolved: 0
  backfilled: 0

Observer: 21 cities polled, 0 new highs
Guaranteed-win scan: 1 missed entries (0 new) {"reasons":["below_metar_gap"]}
METAR fast poll loop: every 5s
```
