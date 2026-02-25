# Recent Changes Log

Last updated: 2026-02-25 14:42 UTC

## Commits

### eca8a96 — Resolver re-evaluates won on backfill + observer polls both stations
**Date:** 2026-02-25

**Fix 1: Resolver won re-evaluation**
`_backfillExitedTrades()` only re-evaluated `won` when `won IS NULL`. Guaranteed-win trades had `won=TRUE` pre-set from METAR, so backfill filled `actual_temp` but never checked if the assumption was correct. Two trades were affected:
- NYC 30-31°F NO (`a96d4f0a`): assumed won, actual loss → pnl corrected to -134.25
- Ankara 12°C NO (`9ffeacc1`): assumed won, actual loss → pnl corrected to -20.01

Now always computes `correctWon` via `_didTradeWin()` when actual data is available. If it differs from the pre-set value, corrects both `won` and `pnl` and logs a `CORRECTED won` warning.

**Fix 2: Observer station fallback**
When no open trades exist for a city, `observe()` defaulted to `polymarketStation` regardless of platform. Kalshi cities (NYC=KNYC, Chicago=KMDW) were polled via the wrong station (KLGA, KORD) until after first trade entry. Now adds both stations/platforms in the no-trades fallback path.

---

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

## Post-Deployment Logs (2026-02-25 14:42 UTC)

```
Cycle #1 complete in 151.4s
  marketsScanned: 36
  logged: 441
  approved: 0
  filtered: 441
  tradesEntered: 0
  monitored: 0
  exits: 0
  resolved: 0
  backfilled: 200

Observer: 22 cities polled, 0 new highs
Resolver: Backfilled 200 opportunities
  - WU vs METAR mismatches: miami(2F), chicago(1F), dallas(1F)
  - CLI vs NWS obs mismatches: miami(1F), denver(-1F), los angeles(1F)

Model calibration (last 7 days):
  residualStdDev: F=6.52 (n=347), C=1.51 (n=166)
  calibrationBuckets: 0-10%→0.7%(n=919), 10-25%→5.6%(n=780), 25-50%→23.4%(n=252)

METAR fast poll loop: every 5s
```
