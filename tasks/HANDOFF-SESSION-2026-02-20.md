# Handoff — Session 2026-02-20

## Session Summary
Completed an 8-point dependency audit of the entry pipeline per `/home/deployer/prompts/task.md`, then implemented 4 critical bug fixes from `/home/deployer/prompts/~bugs.md`. Also fixed a 5th bug (model_valid filter in city calibration) found mid-session by Claude AI. Discovered two additional architectural issues (bucket win attribution inflation, guaranteed_win WU platform-awareness gap) that are documented but not yet fixed.

## Current State

### What's Working
- **Backfill complete**: 118 `ensemble_corrected` MAE records across 15 cities now in `v2_forecast_accuracy`
- **Resolver skip bug fixed**: Both passes (trades + opportunities) now independently check per-source vs ensemble_corrected records — backfill won't be blocked by existing per-source data
- **std_dev vs range_width gate**: Blocking trades where forecast uncertainty dwarfs the range (London 2.2x, Seattle 3.7x hitting)
- **City-level calConfirmsEdge block**: 250 city calibration entries loaded; blocking 0-win cities in specific buckets (Ankara, Toronto, London, Seattle, Dallas hitting)
- **MOS SHADOW_ONLY enforced**: MOS removed from active forecast set — also fixes the equal-weight fallback bug where MOS's missing weight entry forced all cities to equal-weight averaging
- **model_valid filter**: Invalid model runs (model_valid=false) excluded at DB level in `_loadCityCalibration` — 1,840 rows excluded, 151 buckets corrected
- **Weighted ensemble restored**: Chicago now using inverse-MAE weighted ensemble (48.9°F) instead of equal-weight (49.5°F)
- **Chicago blocked**: ensemble_corrected MAE 3.19°F > BOUNDED_MAX_MAE_F 1.8°F → correctly blocking bounded trades

### What's Partially Done
- **Bucket win attribution bug** (CONFIRMED, NOT FIXED): `would_have_won` credits wins to ALL price/time buckets a market_id passed through. Inflates cheap-bucket and long-lead-time win rates. Fix approach not yet decided.
- **Guaranteed_win WU platform awareness** (CONFIRMED GAP, NOT FIXED): `scanGuaranteedWins` uses composite `running_high` as primary, not platform-aware WU branching like monitor.js guaranteed_loss. `REQUIRE_DUAL_CONFIRMATION=true` provides partial protection.
- **ECMWF/GEM/UKMO shadow enforcement**: Only MOS handled by Fix 4. Other shadow sources still leak into active set through same mechanism (but weighted averaging naturally downweights them).

### What Needs Attention
- Bucket win attribution is the most impactful remaining issue — calibration data quality affects all edge decisions
- Guaranteed_win without platform-aware WU branching could cause the same false-positive pattern as the Miami guaranteed_loss bug

## Key Decisions Made
1. **model_valid filter at DB level** — moved from JS filtering (`row.model_valid === false` was dead code since field not in select) to Supabase `.or('model_valid.is.null,model_valid.eq.true')`. Cleaner and fewer rows transferred.
2. **std_dev gate only on bounded YES** — unbounded ranges don't have meaningful range_width to compare against
3. **City calConfirmsEdge only blocks 0-win buckets** — didn't want to be overly aggressive; if a city has even 1 win in a bucket, calConfirmsEdge can still approve
4. **MOS SHADOW_ONLY as explicit active-set removal** — rather than adding demotion logic, simply remove from active set at initialization (cleaner, respects existing config flag)

## Next Steps
1. **Decide on bucket win attribution fix** — three options: (a) dedup during calibration by only counting the latest snapshot per market_id per bucket, (b) only credit the bucket where the trade was first logged, (c) weight by time-in-bucket. Option (a) is simplest but still inflates if a market appears in multiple buckets.
2. **Add platform-aware WU branching to scanGuaranteedWins** — mirror the pattern from monitor.js guaranteed_loss
3. **Enforce ECMWF/GEM/UKMO shadow mode** — extend the MOS pattern to other shadow sources
4. **Monitor filter effectiveness** — watch `std_dev_vs_range`, `cal_city_block`, and `city_mae_too_high` hit rates over next few days
5. **Flip ENSEMBLE_SPREAD.ENABLED** — target ~Feb 23-26 after baseline data

## Gotchas & Warnings
- **Supabase 1000-row limit**: Any analysis script using Supabase JS client gets silently capped at 1000 rows. Use SQL via `exec_sql` RPC or paginate for accurate counts.
- **calConfirmsEdge uses `let` not `const`** — this was changed to allow city-level override. If refactoring, don't revert to const.
- **_loadCityCalibration aggregation uses Sets** — `markets.add(row.market_id)` and `wins.add(row.market_id)` dedup by market_id within a bucket. But the same market_id appears across MULTIPLE buckets (the win attribution bug).
- **MOS equal-weight fallback was subtle** — MOS with n<3 had no weight entry, causing `activeSourceKeys.every(k => cityWeights[k])` to fail, forcing ALL sources to equal-weight. Removing MOS from active set fixes this indirectly.
- **std_dev conversion**: `forecast.stdDev` is always in °C internally. The gate converts to market unit: `stdDev * (9/5)` for °F markets. This uses the delta conversion (multiply by 9/5), NOT `fahrenheitToCelsius()` which is for absolute temps only.

## Files Modified This Session
- **`config.js`** — Added `MAX_STD_RANGE_RATIO: 2.0` to entry section
- **`lib/forecast-engine.js`** — Added MOS SHADOW_ONLY enforcement after active-set initialization (~line 1062)
- **`lib/resolver.js`** — Fixed skip bug in both accuracy recording passes (trades ~line 747, opportunities ~line 858) to independently check per-source vs ensemble_corrected
- **`lib/scanner.js`** — (1) Added `city` param to `_applyFilters` + both callers, (2) std_dev vs range_width gate, (3) city-level calConfirmsEdge block with `_loadCityCalibration()` method, (4) model_valid DB-level filter in `_loadCityCalibration`

## Commits
- `1769cc6` — Fix 4 critical entry pipeline bugs (config.js, forecast-engine.js, resolver.js, scanner.js)
- `48e6679` — Fix model_valid filter in _loadCityCalibration (scanner.js)
