# Handoff — Session 2026-02-18

## 1. Session Summary
Fixed four data quality and correctness issues in the monitor and resolver modules: (1) edge_gone suppression for calConfirmsEdge trades, (2) backfilling won/actual_temp on monitor-exited trades, (3) populating observation_high/wu_high audit trail fields, and (4) making guaranteed_loss platform-aware by using WU-only for "exceeded" checks instead of Math.max(METAR, WU).

## 2. Current State

### Working
- **Monitor calConfirmsEdge hold**: Trades with positive empirical_win_rate from market_calibration are no longer killed by edge_gone. Console logs "CAL HOLD" with bucket details.
- **won/actual_temp populated**: Monitor now sets `won` and `actual_temp` at exit time for guaranteed_win/loss. Resolver backfills historical records on each cycle.
- **observation_high/wu_high audit trail**: All exit paths (monitor + resolver) now populate observation_high and wu_high from metar_observations. Backfill covered 67 historical trades.
- **Platform-aware guaranteed_loss**: "Exceeded" checks use `wu_high` only (conservative — WU is Polymarket resolution source, and min(METAR,WU) = both-agree for Kalshi). "Didn't reach" day-over checks still use `running_high` (Math.max is conservative there since if max hasn't reached, neither source has).
- **All 4 commits pushed** to remote.

### Partially Done
- 13 trades from today's date have NULL won/actual_temp — will be backfilled once their local date passes.
- 30 trades from pre-observer era (Feb 11-12) have NULL observation_high/wu_high — no observer data exists for those dates.

### Needs Attention
- **Calibration data still accumulating**: calConfirmsEdge hold only fires when `n >= 50` in market_calibration. Many buckets don't have enough samples yet. Monitor will log "CAL HOLD" more frequently as data grows.
- **wu_high null guard**: If WU API fails during observer poll, `wu_high` stays NULL in metar_observations. The guaranteed_loss "exceeded" check has a null guard (`wuHigh != null`) — it falls through to day-over or undecided, so no false exits, but the trade may be held longer than necessary.

## 3. Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| Use `wu_high` for guaranteed_loss "exceeded" (not running_high) | running_high = Math.max(METAR, WU) can overshoot. Miami 86-87°F trade was falsely exited because METAR was 85°F while WU was 86°F (in range). WU is Polymarket's resolution source. |
| Keep `running_high` for guaranteed_win | Overshooting on win detection is safe/conservative — worst case we hold a winner slightly longer. |
| Keep `running_high` for day-over "didn't reach" | If Math.max hasn't reached the range, neither source has, so it's a safe loss signal. |
| Null guard on wu_high instead of fallback to running_high | Falling through to undecided is safer than a potentially wrong guaranteed_loss. |
| Backfill runs every cycle (not one-time) | New trades exit continuously; the `or('won.is.null,observation_high.is.null')` filter ensures only unprocessed trades are touched. Filters to target_date < localToday to avoid premature resolution. |

## 4. Next Steps (Prioritized)

1. **Monitor live behavior** — Watch PM2 logs for "CAL HOLD", "GUARANTEED_LOSS (source: WU)", and "GUARANTEED_WIN (source: max)" messages to confirm all 4 fixes work correctly in production.
2. **Win rate analysis** — Now that `won` is populated on all historical trades, run win/loss analysis to evaluate overall bot performance and calibration accuracy.
3. **Ensemble spread activation** — After 7-10 days baseline (target ~Feb 23-26), flip `ENSEMBLE_SPREAD.ENABLED: true` in config.
4. **MOS activation** — After accuracy data accumulates, flip `MOS.SHADOW_ONLY: false`.
5. **Exit evaluator activation** — Currently `log_only` mode. Once confident in take_profit/edge_gone signals, enable actual exits.

## 5. Gotchas & Warnings

- **wu_high can be NULL** even when running_high is populated — WU API may fail while METAR succeeds. The guaranteed_loss null guard handles this, but it means some cities may not get fast guaranteed_loss detection during WU outages.
- **Calibration bucket matching** uses `askPrice` (0-1 scale, e.g., 0.35) mapped to price buckets like `0.30-0.40`. If scanner entry_ask is stored differently, bucket lookup may fail silently.
- **30 pre-observer trades** will permanently have NULL observation_high/wu_high — no observer data exists for Feb 11-12. This is expected and documented.
- **_backfillExitedTrades()** runs every resolver cycle — it's idempotent but queries trades table each time. Not a performance concern at current volume but worth noting.

## 6. Files Modified This Session

| File | Changes |
|------|---------|
| `lib/monitor.js` | Added `_loadCalibration()`, `_getCalibration()` for calConfirmsEdge hold; set `won`/`actual_temp` in `_resolveGuaranteed()` and `_executeExit()`; expanded `_getLatestObservation()` select to include wu_high fields; rewrote `_checkAlreadyDecided()` for platform-aware guaranteed_loss using wu_high for exceeded checks |
| `lib/resolver.js` | Added `_backfillExitedTrades()` method for won/actual_temp/observation_high/wu_high; added observation lookup in `_resolveTrades()` for normal resolution; wired backfill into `resolve()` stats |

### Commits
- `0f67c8c` — Fix monitor edge_gone: suppress for calConfirmsEdge trades
- `307a82d` — Backfill won/actual_temp on monitor-exited trades
- `ccbcccf` — Populate observation_high/wu_high audit trail on all exits
- `a97fe1e` — Platform-aware guaranteed_loss: use WU for exceeded, Math.max for day-over
