# Recent Changes Log

Last updated: 2026-02-27 17:16 UTC

## Commits

### (pending) — feat: database schema restructure — market_resolutions, ML features, mviews
**Date:** 2026-02-27

**Changes:**
- Created `market_resolutions` table — one row per resolved market (dedup from opportunities)
- Added 5 ML feature columns to `opportunities`: `forecast_to_near_edge`, `forecast_to_far_edge`, `forecast_in_range`, `source_disagreement_deg`, `market_implied_divergence`
- Dropped 9 dead columns: `would_pass_at_*` (4), `old_filter_*` (2), `summary_count`, `min_edge_pct`, `max_edge_pct`
- Created 3 materialized views: `market_outcomes_mv` (2,783 rows), `features_ml_mv` (1,545 rows), `performance_mv` (36 rows)
- Created `mv_refresh_log` table — tracks refresh timing and row counts
- Resolver writes to `market_resolutions` at trade resolution + opportunity backfill
- Resolver refreshes all 3 mviews (CONCURRENTLY) after each cycle with timing logged
- Scanner computes 5 ML features in both `_evaluateYes()` and `_evaluateNo()`
- Deleted `_wouldV1Block()` and `_getV1BlockReasons()` (dead code)
- ML script reads from `features_ml_mv` instead of raw opportunities table
- ML FEATURES expanded from 14 → 29 columns
- Backfilled 2,287 resolved markets into `market_resolutions`

Files: `lib/scanner.js`, `lib/resolver.js`, `ml_win_predictor.py`, `SCHEMA.md`, DB migrations

---

### 60242b8 — feat: per-city calibration for cal_confirms
**Date:** 2026-02-27

Files: `lib/scanner.js`, `lib/resolver.js`, DB migration

---

### da746ac — fix: GW station bug, pending event gate, position pre-filter, bid sanity check
**Date:** 2026-02-27

Files: `config.js`, `lib/scanner.js`, `lib/metar-observer.js`, `lib/alerts.js`

---

## Post-Deployment Logs (2026-02-27 17:16 UTC)

```
Bot restarted at 17:12 UTC with schema restructure changes

Cycle #1 (17:12-17:16):
  Scanner: 68 markets, 855 logged, 2 approved, 853 filtered
  Monitor: 3 positions, 0 exits, 3 holds
  Observer: 29 cities polled, 2 new highs
  Resolver: Backfilled 200 opportunities
  Market calibration table refreshed
  Materialized views refreshed (market_outcomes_mv: 11.2s, features_ml_mv: 41ms, performance_mv: 9ms)
  Cycle complete in 207.5s

New ML columns verified:
  855 opportunities, 855 near_edge filled, 629 far_edge filled (226 unbounded = NULL), 855 in_range, 855 source_disagree, 855 mkt_implied

No errors. No crashes. Empty error log.
```
