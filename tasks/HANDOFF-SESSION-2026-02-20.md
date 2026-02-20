# Handoff — Session 2026-02-20

## Session Summary
Three-phase session: (1) Migrated from Supabase to self-hosted PostgreSQL. (2) Fixed 3 critical probability calculation bugs and backfilled 233,674 historical opportunities. (3) Tightened filter rules based on independent audit — calConfirmsEdge floor, NO ask price window, model calibration diagnostic logging.

## What Was Done and Its Impact

### Phase 1: Supabase → PostgreSQL Migration
- **What:** Rewrote all 9 modules from Supabase JS client to raw `pg` queries
- **Impact:** No more Supabase dependency, faster queries, full DB control
- **Post-migration bugs fixed:** numeric type coercion (NaN), JSONB serialization, stale data cleanup
- **Commit:** `533555b`

### Phase 2: Probability Engine Fix + Backfill
Three bugs found and fixed in the probability calculation pipeline:

**Bug 1 — normalCDF (forecast-engine.js)**
- **What:** Abramowitz & Stegun 7.1.26 coefficients approximate `erfc(z)` using `exp(-z²)`, but code used `exp(-x²/2)` without transforming `z = |x|/√2`
- **Impact:** 2.9% error at 1σ, compounding across all probability calculations. normalCDF(1) returned 0.8703 instead of correct 0.8413
- **Fix:** `z = Math.abs(x) / Math.SQRT2`, then `exp(-z * z)`

**Bug 2 — Empirical CDF source (resolver.js)**
- **What:** `_refreshCityErrorDistribution()` used `source != 'ensemble_corrected'` (per-source errors, ~1.5-2x wider than ensemble)
- **Impact:** 5 cities had inflated CDF probabilities by 20-40 percentage points
- **Fix:** Changed to `source = 'ensemble_corrected'`. All CDFs deactivated (n=9, threshold=30) — will self-activate in ~3 weeks

**Bug 3 — cityStdDevs (forecast-engine.js)**
- **What:** Per-source pooled residuals used for city std devs instead of ensemble_corrected data
- **Impact:** Std dev ~1.5-2x too narrow for cities with ensemble data
- **Fix:** Added ensemble_corrected override query. Not yet active (n=8-9, threshold=10) — activates in 1-4 days

**Backfill (scripts/backfill-probability.js)**
- 233,674 opportunities recalculated with fixed normalCDF
- 4,246 skipped (bad price data, not probability issue)
- All set to `model_valid=true`
- Calibration buckets now monotonically increasing: 6.1% win rate at 0-10% → 79.3% at 90-100%

**Calibration contamination fix (resolver.js)**
- `model_calibration` and `market_calibration` queries had NO time window — accumulated all history
- Added 60-day rolling window to both
- Added `model_valid` filter to diagnostic `_computeCalibration()` query
- **Commits:** `ac0d090`, `3e0521a`, `8803ed7`

### Phase 3: Filter Tightening (Post-Audit)
Based on independent database audit that revealed the model is still ~2x overconfident on YES (even after CDF fix) and filter bypasses were letting bad trades through:

**calConfirmsEdge positive-edge floor (scanner.js line 484)**
- **What:** calConfirmsEdge was bypassing MIN_EDGE_PCT even for trades with negative corrected edge (-11.98% Buenos Aires). A single coarse bucket's historical win rate was overriding the model for multiple cities.
- **Fix:** Added `edgePct >= 0` requirement. calConfirmsEdge now amplifies valid signals, doesn't create them from nothing.
- **Impact:** Blocks all negative-edge calConfirmsEdge entries (Toronto 0°C, Buenos Aires 32°C, London 16°C, Chicago 46-47°F, Dallas 80-81°F)

**NO ask price window (config.js)**
- **What:** NO performance data showed only the 20-30¢ bucket is profitable (71.4% win rate, +$300). The <20¢ bucket (50% win, -$103) and >30¢ bucket (16.7% win, -$373) both lose money.
- **Fix:** `MIN_NO_ASK_PRICE: 0.05 → 0.20`, added `MAX_NO_ASK_PRICE: 0.30`
- **Impact:** 5 NO trades blocked by floor, 122 blocked by cap in first cycle

**Model calibration diagnostic logging (scanner.js)**
- **What:** `_loadModelCalibration` silently defaulted to ratio=1.0 when buckets had n<30. No signal in logs when correction pipeline was effectively dead.
- **Fix:** Logs `"Model calibration: 17 buckets active (n≥30), 15 below threshold"`. Warns if zero buckets active.
- **Impact:** Early detection if correction pipeline breaks again

**Correction pipeline confirmation**
- model_calibration rebuilt at 05:47 UTC with backfilled data
- Unbounded ratios (0.085-0.283) now crushing phantom edge: raw 25.3% → corrected 4.9% for Buenos Aires unbounded
- 17 buckets active with n≥30, corrections applying on every scan cycle
- **Commits:** `d2e4543`, `edafa09`

## Current State

### What's Working
- **Probability engine:** Fixed normalCDF, ensemble CDF source, cityStdDevs override
- **Correction pipeline:** 17 buckets active, ratios deflating overconfident unbounded YES trades
- **Filter stack:** calConfirmsEdge requires positive corrected edge, NO trades restricted to 20-30¢
- **Backfilled history:** 253,225 valid opportunities, 0 invalid
- **23 open trades:** Healthy, monitored each cycle. Some entered with old inflated probabilities.

### What Activates Automatically
- **cityStdDevs ensemble override:** n=8-9 per city, threshold=10. Ankara/London in ~1 day, US cities in 2-3 days, Seoul/Wellington in 3-4 days. Will widen std devs to match real forecast error.
- **Empirical CDF:** n=9 per city, threshold=30. ~3 weeks out. Uses actual error distribution instead of normal approximation.
- **model_calibration buckets filling:** 15 buckets at n<30 will activate as data accumulates. Particularly `unbounded|75%+` (n=15) and `bounded|50-55%` (n=11).

### What Needs Attention
- **Model still ~2x overconfident on YES:** Root cause is `ensemble_std_dev` = source agreement spread, not forecast error. cityStdDevs activation (1-4 days) will help.
- **NO side has no correction ratios:** Only protected by price window (20-30¢). Dedicated NO correction needs more resolved NO data (27 trades insufficient).
- **Bucket win attribution bug** (from prior session) — calibration data quality issue still open
- **22 open trades from pre-fix era:** 3 BAD ($101), 6 MARGINAL ($230), 10 OK ($496). Riding to resolution.

## Commits This Session
- `533555b` — Migrate from Supabase to self-hosted PostgreSQL
- `ac0d090` — Fix 3 probability calculation bugs
- `8803ed7` — Add probability calculation lessons
- `3e0521a` — Add calibration time windows and backfill historical probabilities
- `cd75a37` — Update handoff and lessons with backfill results
- `d2e4543` — Add calConfirmsEdge positive-edge floor + raise NO ask minimum to 20¢
- `edafa09` — Add NO ask price cap at 30¢ + model calibration diagnostic logging

## System Events Logged
- `#8` probability_engine_fix
- `#9` probability_backfill
- `#10` calibration_time_windows
- `#11` filter_tightening

## Files Modified
- **`lib/db.js`** — pg.types.setTypeParser for numeric coercion
- **`lib/forecast-engine.js`** — normalCDF fix, ensemble cityStdDevs override
- **`lib/resolver.js`** — CDF WHERE clause, 60-day calibration windows, model_valid filter
- **`lib/scanner.js`** — JSONB stringify, calConfirmsEdge floor, NO ask cap, calibration logging
- **`lib/executor.js`** — JSONB stringify, defensive Number() coercion
- **`config.js`** — Removed Supabase config, NO ask price window
- **`scripts/backfill-probability.js`** — New: probability recalculation script
- **`tasks/lessons.md`** — Probability, calibration, and PostgreSQL lessons
- **`/home/deployer/server-tools/server-bot.js`** — Supabase→PG rewrite (outside git)

## Gotchas for Next Session
- **6-hour calibration cache:** After any probability fix, must restart bot to flush
- **model_calibration rebuilt by resolver:** Changes to opportunity data only affect model_calibration after the next resolver cycle (runs every scan cycle)
- **Correction ratios need n≥30:** New probability buckets start at ratio=1.0 until enough data accumulates
- **Backfill used normalCDF only:** When empirical CDFs reactivate (~3 weeks), probabilities will shift for cities with enough ensemble data
- **NO side unprotected by corrections:** Only the price window (20-30¢) guards NO trades. Don't lower MIN_NO_ASK_PRICE without dedicated NO correction ratios.
