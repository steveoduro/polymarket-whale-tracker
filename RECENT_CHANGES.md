# Recent Changes Log

Last updated: 2026-03-01 22:45 UTC

## Commits

### (latest) — Cap model calibration correction ratio

**Date:** 2026-03-01

The 0-5% unbounded bucket in `model_calibration` had a 12.6x correction ratio (model says 2.3%,
actual win rate 29%). This inflated a Miami "75°F or below" YES from 3.6% raw → 46% corrected,
creating false 35% edge. The trade entered at 11¢ with forecast 79.6°F — clearly wrong.

Added `MAX_CORRECTION_RATIO: 3.0` in config. Both calibration paths in scanner now cap the ratio.
With 3.0x cap: 3.6% × 3.0 = 10.9% → edge = -0.1% → correctly filtered.

Edge trade record: 4W/30L (-$879). Most losses are boundary-adjacent bets where calibration
inflated probabilities. The cap prevents the most egregious cases.

**Files:** `config/trading.js`, `lib/scanner.js`

---

### Previous — PWS GW bug fixes: bid, alerts, dedup

**Date:** 2026-03-01

Five fixes to the PWS guaranteed-win pipeline:

1. **NO bid inversion**: `_checkPwsGW()` passed `range.bid` (YES bid) for NO candidates instead
   of `1 - range.ask` (NO bid). Caused negative spread display (-14¢) in Telegram alerts.

2. **All alerts now immediate**: `tradeEntry`, `tradeExit`, `tradeResolved`, and `error` switched
   from queued `this.action()` to `this.sendNow()`. GW trades execute during fast polls between
   scan cycles — queued alerts were lost on PM2 restart before the next cycle could flush them.

3. **PWS position dedup**: After PM2 restart, in-memory `_pwsGwDedup` clears → PWS re-detects
   crossings → false "Executing..." alerts fire before executor's DB dedup blocks them.
   `evaluateGWFastPath()` now checks DB for existing `guaranteed_win_pws` trades before passing
   candidates through.

4. **PWS cross-platform dedup**: Same city/range/side on both Polymarket + Kalshi entered two
   separate PWS trades (Miami 78-79°F at 66¢ + 88¢). Same weather outcome, double the capital.
   Now keeps only the lowest-ask platform per city/range/side.

5. **PWS/METAR alert distinction**: Missed alerts show `📡 PWS GW MISSED` vs `💡 METAR GW MISSED`.
   Exit/resolved alerts show `PWS-GW` tag. `below_pws_gap` reason text added.

**Files:** `lib/metar-observer.js`, `lib/scanner.js`, `lib/alerts.js`

---

### Previous — Delay Kalshi resolution until 7 AM local

**Date:** 2026-03-01

Resolver was resolving Kalshi trades at midnight local using preliminary NWS CLI data.
Some NWS offices publish CLIs before midnight (OKC published at 11:15 PM Central).
Added a guard: Kalshi trades wait until 7 AM local to ensure the official CLI is available.
Polymarket unaffected — WU historical data is final at midnight.

**Files:** `lib/resolver.js`

---

## Post-Deployment Logs (2026-03-01 22:45 UTC)

```
PWS avg error cache loaded: 26 cities, 9 eligible: buenos aires(1.25), chicago(0.84),
  dallas(1.3), london(0.6), nyc(1.18), paris(1.18), sao paulo(0.93), toronto(1.32),
  wellington(0.77)
Scan complete: 67 markets, 0 approved, 740 filtered
Evaluating 18 open positions, 0 exits, 18 holds
PWS GW: 8 eligible cities, 0 crossings detected
```
