# Recent Changes Log

Last updated: 2026-02-25 22:55 UTC

## Commits

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

## Post-Deployment Logs (2026-02-25 22:55 UTC)

```
Bankrolls initialized:
  yesBankroll: $1000.00
  noBankroll: $800.20
  gwLiveBankroll: $10.00
  gwPaperBankroll: $513.69
  openTrades: 4

Calibration: 21 days (since 2026-02-04), 747 records
Ensemble_corrected MAE: chicago=3.98°F, nyc=1.78°F, miami=1.12°F, dallas=1.32°F,
  london=0.61°C, seoul=0.77°C, toronto=0.75°C, ankara=0.86°C, wellington=1.09°C

Accuracy recorded: 61 entries (first batch with platform + resolution_station)
  Kalshi: KAUS(5), KDEN(4), KLAX(4), KMDW(4), KMIA(4), KNYC(4)
  Polymarket: CYYZ(5), EGLC(5), KATL(4), KDAL(5), KMIA(4), KORD(4), KSEA(5), SAEZ(4)

Cycle #1 complete: 45 markets scanned, 524 opps logged, 200 backfilled
```
