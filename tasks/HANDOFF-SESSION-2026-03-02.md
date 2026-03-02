# Handoff — Session 2026-03-02

## Session Summary

Designed and deployed confidence-weighted PWS GW position sizing (3 iterations). Final formula: `dollars = bankroll × 15% × city_factor × time_factor`. Investigated the Sao Paulo loss bug — root cause found in monitor.js overwriting observation_high at resolution. Analyzed ask-based sizing as a potential replacement for time_factor and compiled going-live considerations.

## Current State

### What's Working
- **PWS GW sizing (live)**: Confidence-weighted formula deployed. Day 1 results: 9W/1L/1 open, +$183 P&L on $435 deployed (42% ROI)
- **Combined GW pipeline**: METAR (28W/5L) + PWS (9W/1L) + dual (1W/1L) = 38W/7L, 84% win rate, +$1,038 total P&L
- **All 3 entry strategies active**: Edge trading, METAR GW, PWS GW — all running paper mode

### What's Partially Done
- **Sao Paulo bug**: Root cause identified (see below), fix NOT yet implemented
- **Ask-based sizing**: Fully analyzed (see below), NOT yet implemented. User wants this as the next change.
- **PWS missed entry tracking**: Only Telegram alerts — no DB persistence for analysis

### What Needs Attention
- **Wellington (open trade)**: PWS entered at 22¢ ($35.86). Likely a loss — METAR only reached 12°C, never crossed 12.5°C boundary. PWS showed 12.7-13°C briefly. Watch for resolution.
- **Going live**: User asked about combining METAR + PWS for real funds. Several blockers remain (see Next Steps).

## Key Decisions Made

1. **Removed gap as sizing factor**: Early PWS detections inherently have minimum gaps (0.5°). Penalizing gap penalizes the strategy's core value (early entry at low prices). All 7 GW losses had exactly 0.5° gap — gap doesn't predict outcomes.

2. **Bankroll percentage over hardcoded dollars**: First iteration used MAX_PER_TRADE=$50. User rejected this — not scalable. Switched to `bankroll × 15%` base.

3. **2-factor formula (city × time)**: city_factor captures station accuracy, time_factor captures diminishing lead-time value. Produces reasonable spread: London morning $55 → NYC afternoon $7.

4. **Keep ask out of sizing (for now)**: Simulation showed adding ask as 3rd multiplicative factor crushes upside on best trades (London 22¢: profit $191→$57). User's next-session proposal: replace time_factor entirely with ask_factor.

## Sao Paulo Bug — Root Cause

**Problem**: Trade entered at 16:39 UTC with PWS correctedMedian=25.3°C (gap=0.8°C, valid entry). Trade resolved as loss with observation_high=24°C. Where did 25.3 become 24?

**Root cause**: `lib/monitor.js:537` — `_resolveGuaranteedWin()` unconditionally overwrites `observation_high`:
```javascript
observation_high: trade.range_unit === 'C' ? runningHighC : runningHighF,
```
This reads from `metar_observations.running_high_c`, which was 24°C for Sao Paulo that day. The PWS correctedMedian of 25.3°C — correctly stored at entry time by executor — gets clobbered.

**Why this matters beyond cosmetics**: The overwritten value makes it look like the trade entered at observation_high=24 (below the 24.5 boundary), which looks like a detection bug. In reality, PWS correctly detected a fleeting spike to 25.3°C that METAR never confirmed. This is a legit false positive, not a system error.

**PWS timeline for Sao Paulo 2026-03-01**:
- 16:20 UTC: correctedMedian=23.7°C (below boundary)
- 16:33 UTC: correctedMedian=24.7°C (gap=0.2 < MIN_GAP 0.5, blocked)
- 16:39:22 UTC: correctedMedian=25.3°C (gap=0.8 ≥ 0.5, **ENTRY TRIGGERED**)
- 16:40:08 UTC: correctedMedian=24.3°C (already dropped back)
- METAR final: 24°C — never crossed 24.5 boundary

**Fix needed**: In `_resolveGuaranteedWin()`, preserve the original `observation_high` for PWS trades:
```javascript
observation_high: trade.entry_reason === 'guaranteed_win_pws'
  ? trade.observation_high  // preserve PWS correctedMedian from entry
  : (trade.range_unit === 'C' ? runningHighC : runningHighF),
```

**Separate question**: Should PWS require sustained crossing (2+ consecutive polls above threshold) rather than a single spike? The Sao Paulo case shows a 1-minute spike can trigger entry on a false positive. This is a strategy-level decision, not a bug fix.

## Ask-Based Sizing Analysis

User proposed replacing time_factor with ask_factor: `askFactor = (MAX_ASK - ask) / (MAX_ASK - MIN_ASK)` clamped [0.30, 1.00].

**Rationale**: Low ask = early detection = high ROI opportunity. High ask = market already knows = low ROI, not worth the variance.

**Data (Day 1 PWS resolved trades)**:

| Ask Bucket | Trades | Wins | P&L | Avg Win ROI |
|------------|--------|------|-----|-------------|
| ≤80¢ | 6 | 5 | +$174 | 80.5% |
| >80¢ | 4 | 4 | +$9 | 10.5% |

The >80¢ trades won 4/4 but returned only $9.12 total on $97.78 capital. They add variance without meaningful return.

**Simulation: Current (city × time) vs Proposed (city × ask)**:

| Trade | Ask | Current$ | NewAsk$ | Current P&L | New P&L |
|-------|-----|----------|---------|-------------|---------|
| London 43¢ | 0.43 | $74.82 | $34.22 | +$99.18 | +$45.37 |
| Paris 73¢ | 0.73 | $63.51 | $10.91 | +$23.49 | +$4.04 |
| Miami 66¢ | 0.66 | $54.12 | $6.75 | +$27.88 | +$3.48 |
| Miami 54¢ | 0.54 | $45.90 | $9.75 | +$39.10 | +$8.31 |
| Sao Paulo 48¢ | 0.48 | $38.88 | $12.00 | -$38.88 | -$12.00 |
| Chicago 93¢ | 0.93 | $32.55 | $9.79 | +$2.45 | +$0.74 |
| Chicago 95¢ | 0.95 | $27.55 | $9.79 | +$1.35 | +$0.48 |
| Chicago 51¢ | 0.51 | $23.97 | $15.77 | +$23.03 | +$15.15 |
| NYC 93¢ | 0.93 | $20.46 | $6.75 | +$1.54 | +$0.51 |
| NYC 82¢ | 0.82 | $17.22 | $6.75 | +$3.78 | +$1.48 |
| **Totals** | | **$399** | **$122** | **+$183** | **+$67** |

**Summary**: ROI improves (45.8% → 55.1%) but absolute profit drops significantly ($183 → $67). Ask-based sizing is more capital-efficient but deploys much less.

**Recommendation**: Consider a hybrid approach or raising the bankroll to compensate. Or lower MAX_ASK to 0.80 first (cuts 4 low-value trades) and keep time_factor for remaining trades.

## MAX_ASK Reduction (0.95 → 0.80)

**Impact on Day 1 data**: Would filter 4 trades (Chicago 93¢, Chicago 95¢, NYC 93¢, NYC 82¢). Total P&L on those 4: +$9.12. All won, but only 4.9-10.5% ROI on capital deployed.

**Net**: Lose $9.12 profit, save $97.78 capital for better opportunities. The user explicitly asked for this change.

**Implementation**: Change `MAX_ASK: 0.95` → `MAX_ASK: 0.80` in `config/observation.js` pws_gw section. One-line change.

## PWS Missed Entry Tracking

Currently `guaranteedWinMissed()` in alerts.js sends Telegram messages but doesn't persist to DB. User said: "if we are not tracking why we aren't entering pws then we should."

**What to track**: PWS crossings that were filtered by MIN_ASK, MAX_ASK, MIN_BID, MIN_GAP, or city eligibility (MAX_AVG_CORRECTED_ERROR). These are already in the `missed` array in `evaluateGWFastPath()` — need to persist them.

**Options**:
1. **Add to system_events**: Quick, no schema change. `event_type='pws_gw_missed'`, details has filter reason, city, ask, gap, etc.
2. **New table**: `pws_gw_missed_entries` with structured columns for proper querying.

Option 1 is simpler and adequate for analysis. Can always migrate to a dedicated table later.

## Going Live Considerations

1. **Unified dedup strategy**: Currently PWS and METAR are independent (both can enter same market). For live: either keep independent (2x capital risk on same outcome) or PWS-first/METAR-skip (less capital, same coverage). User needs to decide.

2. **METAR-only cities must stay**: Seoul (4W/1L, +$216) and Ankara (3W/0L, +$651) have no PWS coverage. METAR pipeline must remain active for these.

3. **Kalshi live never tested**: Kalshi `tradingEnabled: false` since Feb 21. Live execution on Kalshi has never run. Need a test trade before going live.

4. **Bankroll structure**: Currently separate paper bankrolls (PWS $500, METAR $1,000). For live: combine into one? Keep separate? Affects position sizing.

5. **Confidence sizing for METAR too**: Currently METAR uses flat 20%. Could apply city_factor to METAR as well — but METAR has a different error profile and is already confirmed by temperature crossing.

6. **Platform funding**: Live trading requires USDC on Polymarket and USD on Kalshi. Need to check account balances.

7. **Sustained crossing requirement**: Sao Paulo showed a 1-minute spike that triggered entry. Consider requiring 2+ consecutive polls showing crossing before live entry.

## Next Steps (Prioritized)

1. **Fix Sao Paulo observation_high bug** in monitor.js — preserve PWS correctedMedian on resolution
2. **Lower MAX_ASK to 0.80** in config/observation.js — one-line change, immediate impact
3. **Implement ask-based sizing** (replace time_factor with ask_factor) — user's explicit request
4. **Persist PWS missed entries to DB** — system_events approach
5. **Decide sustained crossing policy** — require 2+ polls before PWS entry?
6. **Going-live checklist**: unified dedup, bankroll structure, Kalshi test, platform funding

## Gotchas & Warnings

- **monitor.js observation_high overwrite**: Affects ALL GW trades at resolution, not just PWS. For METAR trades it's usually fine (running_high matches or exceeds detection value), but it can mask the actual detection temperature.
- **PWS fleeting spikes**: Sao Paulo correctedMedian went 23.7→25.3→24.3 in ~7 minutes. Single-poll detection is vulnerable to these. Consider debounce.
- **Wellington likely loss**: PWS entered at 22¢ based on correctedMedian that METAR never confirmed. Will resolve overnight.
- **city_factor uses approximate avg_error**: Computed from 2-3 day rolling window. Cities with few observations may have noisy estimates.

## Files Modified This Session

- **`config/observation.js`** — Added confidence-weighted sizing params (MIN_CONFIDENCE_FACTOR, TIME_FULL/REDUCED hours)
- **`lib/executor.js`** — Implemented confidence-weighted sizing in `_executeGuaranteedSingle()` for PWS trades
- **`lib/scanner.js`** — Pass `gap` field through from PWS candidate to entry object
- **`RECENT_CHANGES.md`** — Updated with sizing changes and fresh logs
