# Handoff — Session 2026-02-19

## Session Summary
Completed the Kalshi investigation task from `/home/deployer/prompts/task.md`. Analysis across 3 parallel agents found Kalshi's -$1,825 loss is driven by 2x model overconfidence (31.2% vs 16.4% on Polymarket), systematic cold biases on US cities (Chicago -4.3°F, Miami -3.6°F), and low-probability tail trades pricing in as "cheap." Implemented Kalshi trading disable (`tradingEnabled: false`) while keeping the full scan/log pipeline active for calibration.

## Current State

### What's Working
- Kalshi scanning + opportunity logging continues (all logged as `platform_trading_disabled`)
- Polymarket trading active with tightened MAE gate (1.8°F/1.0°C bounded, 2.7°F/1.5°C unbounded)
- Ensemble spread gate blocking high-disagreement trades (53 hits last cycle, mostly Miami)
- Guaranteed-win scanner gated for disabled platforms
- 4 open Kalshi trades + 14 open Polymarket trades still being monitored/resolved normally

### What's Partially Done
- Kalshi re-enablement criteria not formally defined — need calibration data to mature
- Ensemble spread feature (`ENSEMBLE_SPREAD.ENABLED: false`) still collecting baseline data (flip after 7-10 days)
- MOS still in shadow mode (`MOS.SHADOW_ONLY: true`)

### What Needs Attention
- System is net **-$1,321** overall (Kalshi -$1,825, Polymarket +$504 including exited)
- Only 4 profitable cities: Seoul (+$707), London (+$380), Seattle (+$378), Dallas (+$170)
- Postgres migration from Supabase scheduled for Friday Feb 21

## Key Decisions Made
1. **Disable Kalshi trading entirely** — model overconfidence 2x worse than Polymarket, -11.4% true edge on Kalshi vs +0.1% on Polymarket. Config flip to re-enable when calibration matures.
2. **Keep full logging pipeline active** — `enabled: true` + `tradingEnabled: false` means scanner still evaluates and logs all Kalshi opportunities with `platform_trading_disabled` as filter reason, feeding calibration tables.
3. **Guaranteed-win scanner also gated** — uses `continue` (skips entirely) instead of logging, since guaranteed-win opps don't go through the opportunity table pipeline.

## Next Steps
1. **Monitor Polymarket-only performance** — with Kalshi disabled, the blended P&L should trend positive
2. **Define Kalshi re-enable criteria** — target: model overconfidence < 10%, per-city MAE < 2.0°F, ensemble_corrected MAE validates
3. **Flip ENSEMBLE_SPREAD.ENABLED** — after 7-10 days baseline data (target: ~Feb 23-26)
4. **Postgres migration** — scheduled Feb 21
5. **Consider station-specific forecasting for Kalshi** — KLAX (coastal) vs downtown LA, KDEN (plains) vs urban Denver

## Gotchas & Warnings
- The investigation found station distance does NOT strongly correlate with forecast bias (r=-0.22) — it's tempting to blame station locations but the real issue is model overconfidence on US cities
- The `tradingEnabled === false` check uses strict equality — setting it to `undefined` or removing it won't block; it must be explicitly `false`
- Guaranteed-win scanner uses `continue` (not filter logging) — so guaranteed-win opps for Kalshi won't appear in the opportunities table at all. This is intentional to avoid false positives.
- Exited trades are real losses — any analysis must include `status IN ('open', 'exited', 'resolved')`, not just resolved trades

## Files Modified This Session
- `config.js` — Added `tradingEnabled: false` to `platforms.kalshi`
- `lib/scanner.js` — Added `platform_trading_disabled` filter in `_applyFilters()` + gate in `scanGuaranteedWins()`
