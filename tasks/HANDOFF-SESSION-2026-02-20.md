# Handoff — Session 2026-02-20

## Session Summary
Two-part session: (1) Completed migration from Supabase to self-hosted PostgreSQL. (2) Fixed 3 critical probability calculation bugs (normalCDF, empirical CDF source, cityStdDevs), then performed comprehensive data audit and backfilled 233,674 historical opportunities with corrected probabilities.

## Current State

### What's Working
- **Self-hosted PostgreSQL**: All 9 rewritten modules running against local PG (`127.0.0.1:5432/weatherbot`)
- **Fixed probability engine**: normalCDF, empirical CDF, and cityStdDevs all corrected
- **Backfilled history**: 233,674 opportunities recalculated with fixed normalCDF, all `model_valid=true`
- **Calibration tables clean**: model_calibration and market_calibration now have 60-day rolling windows
- **Monotonic calibration**: Win rates properly increase with probability bucket (6.1% at 0-10% → 79.3% at 90-100%)
- **Server-bot migrated**: `/pnl`, `/report`, `/errors`, `/logs` all working against local PG
- **Remote DB access**: DBeaver via SSH tunnel through Tailscale, Claude Desktop MCP

### What's Partially Done
- **Empirical CDF**: Fixed to use `ensemble_corrected` but all CDFs currently deactivated (max ensemble n=9 per city, threshold=30). Will self-activate as ensemble data accumulates (~10 more days).
- **Ensemble cityStdDevs override**: Code deployed but not yet active (max ensemble n=9 per city, threshold=10). Will self-activate within days.

### What Needs Attention
- **Bucket win attribution bug** (from prior session) — calibration data quality issue still open
- **22 open trades entered with inflated probabilities**: 3 BAD ($101), 6 MARGINAL ($230), 10 OK ($496). Expected portfolio EV still positive (+$350) but some trades have negative edge under corrected model.
- **ECMWF/GEM/UKMO shadow enforcement** (from prior session) — only MOS handled

## Key Decisions Made
1. **Global numeric type parser** — `pg.types.setTypeParser(1700, parseFloat)` in db.js
2. **Tailscale-only remote access** — No public PG exposure
3. **normalCDF fix**: `z = |x|/√2`, then `exp(-z*z)` — matches A&S 7.1.26 specification
4. **Backfill strategy**: Recalculate with fixed normalCDF using stored raw inputs (`forecast_temp`, `ensemble_std_dev`, `range_min`, `range_max`). Set `correction_ratio=1.0` (model_calibration was contaminated). Mark all `model_valid=true` after backfill.
5. **60-day rolling window** on both calibration queries — prevents unbounded contamination accumulation
6. **Skipped rows (4,246)**: Marked `model_valid=true` without probability update — skip was due to bad prices (bid/ask=0 or null), not probability bug

## Next Steps
1. **Monitor corrected probability quality** — Watch calibration buckets over next few days
2. **Flip ENSEMBLE_SPREAD.ENABLED** — Target ~Feb 23-26 after baseline data accumulates
3. **Fix bucket win attribution** — Most impactful remaining calibration issue
4. **Consider exiting 3 BAD trades** — London 13°C YES (-25.7% edge), Seattle 44-45°F NO (-8.8%), London 12°C NO (-8.5%)
5. **Monitor PG stability** — Connection pool, memory over next few days

## Gotchas & Warnings
- **6-hour calibration cache**: After any probability fix, must restart bot to flush cache
- **node-postgres `numeric` returns strings**: Without type parser → NaN everywhere
- **JSONB needs JSON.stringify()**: Raw pg doesn't auto-serialize like Supabase
- **Backfill used normalCDF only**: Empirical CDF path was not used (all CDFs deactivated). When CDFs reactivate (~20 more days), probabilities will shift slightly for cities with enough ensemble data.
- **correction_ratio=1.0 for all backfilled rows**: Model calibration was contaminated, so backfill doesn't apply any correction ratio. As clean data accumulates and model_calibration rebuilds, new opportunities will get proper correction_ratios.

## Files Modified This Session
- **`lib/db.js`** — Added `pg.types.setTypeParser(1700, parseFloat)` for numeric coercion fix
- **`lib/scanner.js`** — Added `JSON.stringify()` for 4 JSONB params
- **`lib/executor.js`** — Added `JSON.stringify()` for 3 JSONB params + defensive `Number(t.cost) || 0`
- **`lib/forecast-engine.js`** — Fixed normalCDF (A&S z transform), added ensemble cityStdDevs override query
- **`lib/resolver.js`** — Fixed CDF WHERE clause (`source = 'ensemble_corrected'`), added 60-day windows to calibration queries, added model_valid filter to diagnostic query
- **`config.js`** — Removed dead Supabase config section
- **`scripts/backfill-probability.js`** — New: recalculates our_probability on historical opportunities
- **`tasks/lessons.md`** — Added calibration contamination and backfill lessons
- **`/home/deployer/server-tools/server-bot.js`** — Full rewrite: Supabase→PG (outside git)

## Commits
- `533555b` — Migrate from Supabase to self-hosted PostgreSQL
- `ac0d090` — Fix 3 probability calculation bugs
- `8803ed7` — Add probability calculation lessons
- `3e0521a` — Add calibration time windows and backfill historical probabilities

## DB Changes (not in git)
- `model_valid=true` on all 237,920 previously-invalidated opportunities (after backfill)
- `our_probability`, `edge_pct`, `kelly_fraction`, `expected_value`, `corrected_probability`, `correction_ratio`, `would_pass_at_*` recomputed on 233,674 rows
