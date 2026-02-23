# Handoff — Session 2026-02-23

## 1. Session Summary

Tightened `calConfirmsEdge` to require `true_edge > 0` AND 3pp gap between empirical_win_rate and ask, stopping -$291 in losses from marginal calibration-bypass entries. Fixed P&L reporting in server-bot to include exited trades. Ran comprehensive 5-part investigation into the Atlanta 76-77°F guaranteed_win trade (date mismatch, v2 downtime, NaN bankroll bug, WU lag patterns). Added immediate Telegram alert for guaranteed_win detections that fires before execution.

## 2. Current State

### Working
- `calConfirmsEdge` tightened — effectively disabled until genuinely profitable buckets accumulate (PM|bounded|<12h|25-30c approaching n=50 in ~1-2 weeks)
- Server-bot `/pnl` now shows resolved + exited trades with combined totals
- 7-day report includes exited trades in win/loss counts
- Guaranteed_win Telegram alert fires immediately on detection (before execution), includes city, range, side, ask, margin, dual_confirmed, METAR/WU readings
- All 222 pre-Feb-20 trades marked as `invalid_model` for clean post-fix P&L separation
- 67 previously-unresolvable invalid_model trades backfill-resolved using winning_range matching

### Partially Done
- `guaranteed_entry.MAX_BANKROLL_PCT` review — user explicitly deferred sizing config changes pending investigation findings (now complete, user can decide)

### Needs Attention
- **NaN bankroll bug**: First 2 restarts after deployment had corrupted bankrolls (NaN). Root cause: `initBankrolls()` computation when open trade costs sum to unexpected values during mid-deployment state. Not reproducible currently but could recur on future deployments with many rapid PM2 restarts.
- **scanGuaranteedWins only scans localToday**: Doesn't scan tomorrow's markets. If a market is for tomorrow (e.g., Feb 20 market checked at 8:35 PM ET Feb 19), guaranteed_win won't fire for it even if today's observation clearly exceeds the range. This is a design limitation, not a bug — tomorrow's observation data doesn't exist yet.
- **v1 bot `weather-bot` still exists in PM2** (stopped): Should be cleaned up (`pm2 delete weather-bot position-manager`) once all v1 positions are confirmed resolved.

## 3. Key Decisions Made

- **calConfirmsEdge: require true_edge > 0 AND 3pp gap** — effectively disables it for all current buckets while preserving the mechanism for future genuinely profitable buckets. Trade-off: may miss some marginal winners but stops the -$291 bleed from the bounded|<12h|10-15c bucket.
- **Guaranteed_win alert uses `sendNow()` (immediate)** — not queued, fires before execution. Trade-off: slightly slower cycle (Telegram API call inline) but ensures user sees detection before trade alert.
- **Did NOT change `guaranteed_entry.MAX_BANKROLL_PCT`** — user explicitly said sizing config is under review pending investigation. Now that investigation is complete, user should decide.

## 4. Next Steps

1. **Review guaranteed_entry sizing** — MAX_BANKROLL_PCT is currently 15%. The Atlanta trade deployed $133.92 (13.4% of $1000 NO bankroll). User may want to adjust based on investigation findings.
2. **Clean up v1 PM2 processes** — `pm2 delete weather-bot position-manager` once confirmed all v1 trades resolved.
3. **Monitor calConfirmsEdge pipeline** — PM|bounded|<12h|25-30c bucket approaching n=50 with 30.2% win rate and genuine edge. Should open naturally in 1-2 weeks.
4. **Consider scanGuaranteedWins for next-day markets** — Current design only scans localToday. Adding tomorrow's markets would catch cases like the Atlanta scenario where observation data exceeds a range for a market that hasn't started yet.
5. **Ensemble spread activation** — `ENSEMBLE_SPREAD.ENABLED: false` — flip to true after 7-10 days baseline (deployed Feb 16, now day 7).
6. **MOS shadow promotion** — `MOS.SHADOW_ONLY: true` — evaluate accuracy data for possible promotion to active ensemble member.

## 5. Gotchas & Warnings

- **backfill `entry_reason` was done by heuristics in commit `ddfcdb8`** — the Atlanta trade's `entry_reason: 'guaranteed_win'` was set by a SQL backfill that classified based on `entry_probability=1.0` and observation fields. Some fields on this trade (like `opportunity_id`) may reference the regular scan opportunity, not a guaranteed_win-specific one.
- **WU lag is 0-60 minutes, not fixed** — 80% zero lag, 20% up to 60 min. With `REQUIRE_DUAL_CONFIRMATION: true`, guaranteed_win entry can be delayed up to 60 min during fast-warming periods when WU trails METAR.
- **NaN bankroll after PM2 restart** — happened 3 times in rapid succession on Feb 20. Ghost trades with `shares: null, cost: NaN` blocked correct entries. If deploying changes, wait for a full cycle to complete before restarting again.
- **`invalid_model` trades are invisible to resolver** — resolver queries `WHERE status = 'open'`. These trades required manual SQL backfill.
- **opportunities table `entry_reason` column does NOT exist** — only the trades table has it. Several DB queries in this session errored on this.

## 6. Files Modified This Session

| File | Change |
|---|---|
| `config.js` | Added `CAL_MIN_TRADE_EDGE: 0.03` to calibration section |
| `lib/scanner.js` | Tightened calConfirmsEdge (line 536) and Kelly override (line 166) to require `true_edge > 0` AND 3pp empirical_win_rate - ask gap |
| `server-tools/server-bot.js` | Fixed `/pnl` to include exited trades; fixed 7-day report to count exited wins/losses |
| `lib/alerts.js` | Added `guaranteedWinDetected()` method — immediate Telegram alert before execution |
| `bot.js` | Call `alerts.guaranteedWinDetected()` before `executor.executeGuaranteedWins()` |

### SQL-only changes (no code):
- Backfill-resolved 67 invalid_model trades with correct won/pnl using winning_range matching from opportunities
- Marked 155 additional pre-Feb-20 trades as invalid_model (total: 222)

### Commits:
- `ee1c5b6` — calConfirmsEdge tightening
- `315d7f0` — Guaranteed_win Telegram alert

### Post-fix trade state:
| Status | Trades | W-L | P&L |
|---|---|---|---|
| resolved | 8 | 2-6 | -$202.85 |
| exited | 7 | 0-7 | -$179.45 |
| invalid_model | 222 | 45-177 | -$2,468.69 |
| open | 4 | — | $346.95 deployed |
