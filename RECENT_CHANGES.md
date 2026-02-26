# Recent Changes Log

Last updated: 2026-02-26 01:10 UTC

## Commits

### 1fe5a76 — Fast poll 5s→15s + overlap guard
**Date:** 2026-02-26

- `METAR_FAST_POLL_INTERVAL_SECONDS: 5` → `15` (28 cities at 5s caused overlapping polls)
- Added `_fastPollRunning` mutex in bot.js to prevent concurrent fast polls
- Result: clean non-overlapping polls, ~5-12s typical duration

---

### fb4bb08 — Kalshi city expansion, dead ticker cleanup, stale platform alerts
**Date:** 2026-02-25

- **11 stale Kalshi tickers fixed**: Kalshi migrated from KXHIGH→KXHIGHT prefix (atlanta, dallas, philly, boston, dc, seattle, sf, houston, vegas, nola, phoenix)
- **6 dead international KALSHI_SERIES removed**: toronto, buenos aires, ankara, wellington, london, seoul (0 open markets)
- **3 new Kalshi cities**: san antonio (KXHIGHTSATX/KSAT), minneapolis (KXHIGHTMIN/KMSP), oklahoma city (KXHIGHTOKC/KOKC)
- **Stale platform alert**: scanner tracks consecutive cycles with 0 markets per city/platform, alerts after 12 cycles (~1 hour)
- Markets scanned: 45 → 65

Files: `config.js`, `lib/platform-adapter.js`, `lib/scanner.js`

---

### f767d6c — Platform-aware accuracy + station-aware GW gap for dual-station cities
**Date:** 2026-02-25

Fixes accuracy contamination in dual-station cities (NYC KLGA≠KNYC, Chicago KORD≠KMDW):
- **DB migration**: `platform TEXT` + `resolution_station TEXT` columns on `v2_forecast_accuracy`
- **resolver.js**: Dedup key `city:date:platform`, INSERTs include platform + resolution station
- **forecast-engine.js**: `cityMAE` + `cityEnsembleMAE` split by platform (fallback to blended if n<5)
- **scanner.js**: `getCityEligibility(city, platform)` called per-platform instead of per-city
- **GW gap**: isDualStation logic replaces blanket KALSHI gap — wider gap only for actual dual-station cities
- Removed unused `METAR_ONLY_MIN_GAP_F_KALSHI` / `METAR_ONLY_MIN_GAP_C_KALSHI` config keys

Files: `config.js`, `lib/resolver.js`, `lib/forecast-engine.js`, `lib/scanner.js`, `lib/metar-observer.js`

---

### a95f71d — Add NYC (slug fix), Paris, Sao Paulo to Polymarket scanning
**Date:** 2026-02-25

- NYC slug `new-york-city` → `nyc` (was never scanning Polymarket)
- Added Paris (LFPG, °C, FR) and Sao Paulo (SBGR, °C, BR) to config + slug mappings

---

### f84fab3 — Go live with GW trading on Polymarket ($10 bankroll)
**Date:** 2026-02-25

Live trading for guaranteed-win entries on Polymarket CLOB:
- CLOB client with GNOSIS_SAFE signature type (proxy wallet)
- Split bankrolls: live $10 + paper $1000
- Fill verification: poll 2s × 15, cancel if unfilled
- Kill switch: `GW_LIVE_ENABLED: false` (currently OFF for review)

---

## Post-Deployment Logs (2026-02-26 01:10 UTC)

```
Cycle #11 running — 65 markets, 28 cities (20 Kalshi, 23 Polymarket)
Zero errors since restart

Bankrolls:
  yesBankroll: $1000.00 | noBankroll: $800.20
  gwLiveBankroll: $10.00 | gwPaperBankroll: $513.69
  openTrades: 4

Open GW positions (all confirmed guaranteed wins):
  NO toronto 1°C (running high: 2°C)
  NO chicago 32-33°F (running high: 37°F)
  NO seattle 48-49°F (running high: 51°F)

Fast poll (METAR-only, every 15s):
  25 cities active (3 outside active hours filtered)
  Batch METAR fetch from aviationweather.gov
  Typical duration: 5-12s (only >10s logged)
  Concurrent with scan cycle: ~20-29s (API contention)

Full observer (inside each 5-min cycle):
  27 cities polled (WU + METAR comparison)
  2.5s per city = ~68s total

Model calibration (7-day window):
  ensemble_corrected: F bias=+1.74, MAE=3.42 (n=65) | C bias=+0.07, MAE=0.79 (n=35)
  Residual StdDev: F=6.55° (n=346), C=1.45° (n=154)
  WU vs METAR diffs: chicago 1°F, miami 2°F, atlanta 1°F, dallas 1°F (expected)
```
