# Recent Changes Log

Last updated: 2026-02-28 07:20 UTC

## Commits

### (latest) — Fix Dallas Kalshi station: KDAL → KDFW

**Date:** 2026-02-28

**Root cause:** KDAL (Love Field) doesn't publish NWS CLI reports — zero records in IEM for 2026. Kalshi resolves via NWS CLI at KDFW (DFW Airport). Confirmed by matching KDFW CLI highs against Kalshi settlement values (Feb 23-26: exact match).

**Impact:** Dallas GW trade (NO 80-81°) lost because METAR at KDAL showed 82°F but KDFW CLI = 81°F. The 1°F discrepancy (WU sub-hourly peak vs CLI hourly) crossed the boundary. Trade genuinely lost — not a resolver bug.

**Changes:**
- Config: Dallas `nwsStation` changed from `KDAL` to `KDFW`
- Resolver: Added `KDFW` to METAR_COORDS lookup map
- DB: Fixed accuracy records — Feb 25 actual corrected from 81→82 (KDFW CLI), all station refs updated to KDFW

**Verification:** All 20 Kalshi stations checked — KDAL is the ONLY one missing CLI data.

Files: `config.js`, `lib/resolver.js`

---

### f4bb2e0 — Fix Kalshi premature resolution via Open-Meteo fallback

**Date:** 2026-02-28

**Changes:**
- Open-Meteo historical fallback now gated for Kalshi trades < 3 days old (skip fallback, wait for CLI)
- Prevents Open-Meteo (which can differ from CLI by 1-2°F) from resolving Kalshi trades prematurely

Files: `lib/resolver.js`

---

### de8947e — Fix PWS distance calculation: use actual METAR station coords

**Date:** 2026-02-28

**Changes:**
- Added METAR_COORDS lookup with actual airport coordinates for all 30 ICAO stations
- Distance calculation now uses airport coords instead of city center

Files: `lib/resolver.js`

---

### 7d07830 — PWS bias correction framework (data collection only)

**Date:** 2026-02-28

**Changes:**
- pws_station_bias table, resolver bias computation, observer bias cache + corrected median
- NO changes to GW detection or trading logic

Files: `lib/resolver.js`, `lib/metar-observer.js`, DB migration

---

### 75a529c — PWS data collection integration

**Date:** 2026-02-28

Files: `config.js`, `lib/metar-observer.js`, `bot.js`, DB migration

---

## Post-Deployment Logs (2026-02-28 07:20 UTC)

```
Bot running with KDFW fix for Dallas Kalshi

Cycle #1 complete in 96.0s:
  Markets scanned: 46
  Opportunities: 546 logged, 0 approved, 546 filtered
  Trades: 0 entered, 0 resolved
  Backfilled: 200 opportunities
  Monitor: 2 positions (seoul NO 12°C GW held)

Resolver:
  PWS station bias: 70 stations, 0 unreliable
  CLI vs NWS obs mismatches (expected 1°F): seattle, philly, dc, vegas, nyc, sf, minneapolis
  Model calibration refreshed

Fast poll:
  5 international cities active (london, seoul, ankara, wellington, paris)
  PWS: 4 cities, 8 stations online
  WU: 5/5 responses

Empty error log.
```
