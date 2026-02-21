# Handoff — Session 2026-02-21

## Session Summary

Ran the full 7-query Kalshi root cause analysis, verified all findings from `~bugs.md`, and implemented the 3-layer Kalshi fix: NWS-priority ensemble, std_dev multiplier, and city-level blocks. Key discovery: Kalshi API `rules_primary` metadata confirms ALL station configs are already correct — the problem is NWS forecast bias and ensemble dilution, not station mismatches.

## Current State

### What's Working
- All 3 Kalshi fixes deployed and verified in production:
  - `kalshiBlocked: true` for Chicago + Miami (NWS -6°F/-4°F bias makes them untradeable)
  - `kalshiNwsPriority: true` for NYC/Austin/LA with `NWS_WEIGHT_BOOST: 3.0`
  - `STD_DEV_MULTIPLIER: 1.8` for all Kalshi probability calculations
- Polymarket pipeline completely unaffected (verified: same forecast_temp, same std_dev)
- Market divergence gate (from prior session) working: 17+ hits per cycle
- entry_probability now stores corrected values
- Scan order optimized (markets before forecast — saves API calls for 8 inactive cities)

### What's Partially Done
- Kalshi tradingEnabled still `false` — intentionally. Need 2+ weeks of post-fix data before re-evaluating re-enable for BOTH YES and NO
- The `would_have_won` backfill will accumulate on the new Kalshi parameters going forward, enabling proper evaluation

### What Needs Attention
- **Monitor post-fix Kalshi data quality**: The key metric is whether Kalshi opportunities logged with the new parameters would have won. After 2 weeks, run Q6 from task.md again with `created_at > '2026-02-21'` to see if win rates improve
- **Do NOT re-enable NO early**: Post-pause data shows NO bounded 40c+ at 31% win rate / 58¢ avg ask — deeply underwater. The std_dev fix affects both sides
- **Chicago/Miami investigation resolved**: Stations are correct (KMDW = "Chicago Midway", KMIA = "Miami International Airport" per Kalshi API). The NWS forecast itself is systematically cold for these cities. May need to explore alternative forecast sources or NWS bias correction specifically for these cities

## Key Decisions Made

1. **All Kalshi stations confirmed correct via API metadata** — `rules_primary` field on settled markets contains the exact station name. Chicago Midway (KMDW) and Miami International (KMIA) are what Kalshi uses. Bugs.md assumed KORD→KMDW swap was needed; this was wrong.

2. **NWS boost approach: parallel `kalshiTemp` in forecast object** — Rather than changing the getForecast() signature to take platform (would require different forecasts per platform), we compute a separate `kalshiTemp` alongside `temp` and let the scanner pick based on `range.platform`. Zero impact on Polymarket path.

3. **Std dev multiplier of 1.8x** — Based on Q4 data showing 13-69pp overconfidence across all Kalshi probability buckets. Starting conservative; can adjust after post-fix data accumulates.

4. **City blocks use filter system, not platform adapter** — Added `kalshi_city_blocked` as a filter reason in `_applyFilters` rather than blocking at the platform-adapter level. This preserves opportunity logging for blocked cities (valuable for monitoring if bias improves over time).

## Next Steps (Prioritized)

1. **Wait 2 weeks** — Let post-fix data accumulate. The key evaluation: are Kalshi `would_have_won` rates improving with the NWS-boosted forecast and wider std_dev?
2. **Re-run Q6** after 2 weeks with date filter on new data only — compare to pre-fix 0% win rate
3. **Evaluate Chicago/Miami** — If NWS bias corrects over time (the bias correction system has -5.67°F bias recorded for Chicago), the `kalshiBlocked` flag could be removed. But the bias needs to stabilize.
4. **Consider NWS-only mode for Kalshi** — Q7 showed Austin NWS was perfect (0.00°F bias). For cities where NWS MAE < 1.5°F, a more aggressive approach: use NWS forecast directly for Kalshi (no ensemble), with ensemble as fallback.
5. **ECMWF ensemble spread activation** — Still at `ENABLED: false`, waiting for baseline. Now at 5 days of data — consider enabling after 7-10 days.

## Gotchas & Warnings

- **LA has NWS SOFT-DEMOTED**: Source ranking shows `nws(1.41° SOFT-DEMOTED)` for LA. The NWS_WEIGHT_BOOST multiplies the already-capped weight (10%) by 3x = 30%. This is intentional — the demotion was relative (1.41° is within threshold for NWS priority cities).
- **Two scan cycles overlap after restart**: First post-restart scan produces entries with new parameters alongside pre-restart entries from ~5 min earlier. The 10-minute query window shows both — this is normal.
- **Chicago MAE gate fires before kalshi_city_blocked**: Chicago's ensemble MAE (3.74°F) exceeds the unbounded threshold (2.7°F), so the MAE gate blocks it before `_applyFilters` even runs. The `kalshiBlocked` filter is defense-in-depth for when MAE improves.
- **Kalshi API rate limits**: The station investigation used authenticated API calls. 250ms delay between requests was sufficient. For bulk queries, increase to 500ms.

## Files Modified This Session

- **`config.js`** — Added `STD_DEV_MULTIPLIER: 1.8` + `NWS_WEIGHT_BOOST: 3.0` to kalshi platform config; added `kalshiBlocked: true` for Chicago/Miami, `kalshiNwsPriority: true` for NYC/Austin/LA
- **`lib/forecast-engine.js`** — Added Kalshi NWS-priority ensemble computation (parallel `kalshiAvgF`); added `kalshiTemp` field to forecast result object
- **`lib/scanner.js`** — Added `kalshi_city_blocked` filter reason; modified `_evaluateYes` and `_evaluateNo` to use `kalshiTemp` and `STD_DEV_MULTIPLIER` for Kalshi ranges; updated opportunity objects to store platform-specific `forecast_temp` and `ensemble_std_dev`

## Commits

- `442c5da` — Kalshi 3-layer fix: NWS-priority ensemble, std_dev multiplier, city blocks
