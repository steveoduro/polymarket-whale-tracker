# Recent Changes Log

Last updated: 2026-03-01 15:00 UTC

## Commits

### (latest) — PWS GW bug fixes: bid, alerts, dedup

**Date:** 2026-03-01

Five fixes to the PWS guaranteed-win pipeline:

1. **NO bid inversion**: `_checkPwsGW()` passed `range.bid` (YES bid) for NO candidates instead
   of `1 - range.ask` (NO bid). Caused negative spread display (-14¢) in Telegram alerts.

2. **All alerts now immediate**: `tradeEntry`, `tradeExit`, `tradeResolved`, and `error` switched
   from queued `this.action()` to `this.sendNow()`. GW trades execute during fast polls between
   scan cycles — queued alerts were lost on PM2 restart before the next cycle could flush them.
   (Paris 12°C PWS trade executed at 73¢ but user never saw the trade notification.)

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

### Previous — Detect unbounded lower NO ranges in GW entry

**Date:** 2026-03-01

Ranges like "57°F or below" (rangeMin=null, rangeMax=57.5) were never detected as GW
entry opportunities. Both `_checkPwsGW()` and `evaluateGWFastPath()` only handled
unbounded upper YES and bounded NO. The monitor's `_checkAlreadyDecided()` already
handled these correctly for existing positions — only the entry path was missing.

**Files:** `lib/metar-observer.js`, `lib/scanner.js`

---

### Previous — Fix PWS GW eligibility metric + corrected median calculation

**Date:** 2026-03-01

Two fixes to PWS guaranteed-win accuracy:

1. **GW-hour eligibility filter**: `_loadPwsAvgErrorCache()` now filters to 10am-4pm local time
   per city timezone (was all-day average). Seattle's all-day error (1.71°F) masked a 2.88°F
   GW-hour error — now correctly blocked.

2. **True median replaces weighted average**: `pws_corrected_median` was actually a
   distance-weighted mean. With 3 stations, an outlier pulled the average. Now uses a true
   median — with 3 stations the outlier is discarded.

**Files:** `lib/metar-observer.js`

---

## Post-Deployment Logs (2026-03-01 14:57 UTC)

```
PWS avg error cache loaded: 25 cities, 12 eligible: buenos aires(1.38), chicago(0.92),
  dallas(1.33), dc(1.54), london(0.6), miami(1.75), minneapolis(1.71), nyc(1.68),
  paris(1.18), sao paulo(1.06), toronto(1.45), wellington(0.79)
Scan complete: 55 markets, 1 approved, 657 filtered
Evaluating 9 open positions, 0 exits, 9 holds
GW confirmed: seoul 11°C, london 12°C, paris 12°C
```
