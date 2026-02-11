# Handoff — Session 2026-02-11

## Session Summary
Full codebase audit of v2 weather trading bot (12 reliability/correctness fixes), followed by deep investigation of fee models, forecast std devs, and range parsing. Discovered and fixed three major model errors: fee calculations (both platforms wrong), std dev calibration (2-3x too small), and missing continuity correction on integer temperature ranges. Recalculated all 29 open trades — 14 invalidated as entered under broken model. Bot now producing well-calibrated trades with 10-16% edges.

## Current State

### Working
- **Bot v2 running** as `weather-bot-v2` in PM2, ~140s cycle time, no errors
- **Fee model corrected**: Polymarket weather = 0% fees, Kalshi = `0.07 × P × (1-P)` per contract on entry only
- **Forecast std devs calibrated**: Base values now 2.5-3.5°F (were ~1°F), scaled by `sqrt(daysOut)`
- **Continuity correction**: ±0.5 applied to all range boundaries (integer temperature resolution)
- **Pipeline consistent**: scanner, executor, monitor, resolver all use `getEntryFee()` method
- **15 valid open trades** with edges recalculated under corrected model
- **All HTTP calls have 15s timeouts**, independent try/catch per cycle step, Kalshi API cached

### Partially Done
- **Exit evaluator**: Still in `log_only` mode — needs validation before flipping to `active`
- **Resolver**: Running but early — needs more resolved trades to validate PnL calculations
- **Phase 4 (Calibration)**: Not started — auto-calibrate std devs from `v2_forecast_accuracy` data
- **`invalidation_reason` column**: Not added to `trades` table yet (needs manual SQL in Supabase dashboard)

### Needs Attention
- **Manual SQL needed** in Supabase SQL Editor:
  ```sql
  ALTER TABLE trades ADD COLUMN invalidation_reason TEXT;
  UPDATE trades SET invalidation_reason = 'edge_below_threshold_after_stddev_fix' WHERE status = 'invalid_model';
  ```
- **Supabase RLS**: All writes use anon key. If RLS policies are restrictive, inserts could silently fail
- **v1 bots still running** from `_oldversion/` — stop once all v1 positions resolve

## Key Decisions Made

1. **Fee model (corrected)**: Polymarket weather markets have ZERO trading fees (3.15% only applies to 15-min crypto). Kalshi uses `0.07 × price × (1-price)` per contract, charged on entry when held to settlement, on both entry+exit for early exits. Previous session incorrectly assumed profit-only fees for both.
2. **Std dev calibration**: Empirical NWS/ECMWF verification shows day-1 forecast MAE of 2.0-2.7°F → std dev of 2.5-3.5°F. Old values (~1°F) caused massive overconfidence, entering trades with inflated edges.
3. **Time scaling**: Changed from `hours/48` (linear, backwards) to `sqrt(daysOut)` (standard uncertainty propagation). Base std dev values represent day-1 accuracy.
4. **Continuity correction**: Both platforms resolve to whole-degree integers. Range "34-35°F" maps to continuous [33.5, 35.5]. Without ±0.5, a 2°F range covers only 1°F in the CDF → ~50% underestimate.
5. **Trade invalidation**: 14 of 29 open trades would not have been entered under corrected model (edge < 10% after wider std devs). Marked as `status='invalid_model'` rather than deleted.
6. **Volume cap**: `HARD_REJECT_VOLUME_PCT` reduced from 100 to 75 — trades > 75% of visible volume are unrealistic even for paper trading.
7. **Kelly formula** (from audit): Changed from simplified `(p*payout - q) / payout` to correct `(b*p - q) / b` where `b = netProfit / effectiveCost`. Old formula overestimated by up to 5x.

## Next Steps

1. **Run manual SQL** — Add `invalidation_reason` column to trades table (see SQL above)
2. **Commit and push** — All changes are staged but not committed
3. **Monitor first resolved trades** — validate PnL calculations with corrected fee model
4. **Validate exit evaluator** — review `evaluator_log` entries to see if recommendations are profitable
5. **Phase 4: Calibration** — once 50+ entries in `v2_forecast_accuracy`, auto-calibrate std devs per city
6. **Flip evaluator to `active`** — after log_only validation
7. **Stop v1 bots** — once all v1 positions resolve

## Gotchas & Warnings

- **14 trades marked `invalid_model`** — resolver skips these, they don't pollute calibration data. Don't re-open them.
- **Kalshi `_parseKalshiRange` changed from ±1 to ±0.5** — old logic used integer adjustments (`floor + 1`, `cap - 1`), new uses ±0.5 continuity correction. If Kalshi boundaries are half-integers (not integers), this would need revisiting.
- **`exec_sql` RPC not found** — Supabase can't run DDL via the Node client anymore. All schema changes must go through the SQL Editor dashboard.
- **Kelly sizing much more conservative now** — smaller positions are expected and correct. Old model was overtrading.
- **First cycle after PM2 restart** is slower (~190s) because Kalshi cache is in-memory
- **`AbortSignal.timeout(15000)`** requires Node 20+ — verified on v20.20.0

## Files Modified This Session

| File | Description |
|------|-------------|
| `config.js` | Fee rates (Polymarket 0%, Kalshi takerFeeMultiplier 0.07), std devs (empirical values), HARD_REJECT_VOLUME_PCT 100→75, dead config cleanup |
| `lib/platform-adapter.js` | Added `getEntryFee()` method, continuity correction ±0.5 in `_parseRange` and `_parseKalshiRange`, Kalshi 4-min cache, cursor pagination |
| `lib/scanner.js` | Fee model: `entryFee`/`effectiveCost`/`payout=1.0` for YES and NO, per-city timezone scanning, Kelly formula fix |
| `lib/executor.js` | Fee model: `getEntryFee` + `effectiveCost` for Kelly sizing, Kelly formula correction |
| `lib/monitor.js` | Early exit pays entry + exit fees for Kalshi, exit counter accuracy |
| `lib/resolver.js` | Kalshi per-contract entry fee formula, Polymarket zero fees, HTTP timeout |
| `lib/forecast-engine.js` | Time scaling `sqrt(daysOut)`, HTTP timeouts on weather fetches |
| `lib/alerts.js` | Removed HTML parse_mode, HTTP timeout (10s) |
| `bot.js` | Bankroll refresh per cycle, independent try/catch per step |
| `tasks/lessons.md` | Added fee models, std dev calibration, continuity correction, Kelly correction docs |
