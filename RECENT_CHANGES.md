# Recent Changes Log

Last updated: 2026-03-01 03:10 UTC

## Commits

### (latest) — Remove broken PWS station KLAGRETN14

**Date:** 2026-03-01

- Removed KLAGRETN14 from New Orleans pwsStations — reports -25°F constantly (broken sensor)
- Was causing 90°F deviation log spam every cycle

**Files:** `config/cities.js`

---

### Previous — Config reorganization + PWS GW strategy

**Date:** 2026-03-01

**Task 1: Config Reorganization**
- Split monolithic `config.js` into organized sub-files under `config/`:
  - `config/cities.js` — 28 city definitions, reformatted 1-field-per-line, grouped by region
  - `config/trading.js` — entry, calibration, sizing, exit
  - `config/forecasts.js` — forecast engine params
  - `config/platforms.js` — Polymarket + Kalshi configs
  - `config/observation.js` — guaranteed_entry, observer, observation_entry_gate, pws_gw
- `config.js` is now a ~35 line loader that merges sub-configs
- Zero consumer changes — all `require('./config')` calls see the same object shape

**Task 2: PWS Guaranteed-Win Strategy**
- New 3rd entry strategy alongside forecast-based edge trading and METAR GW
- PWS corrected median detects boundary crossings earlier than METAR (80-300 min lead)
- 12 eligible cities (avg corrected error ≤2.0°): London, Toronto, Paris, Wellington, Minneapolis, Buenos Aires, Sao Paulo, Chicago, DC, Seattle, Dallas, Miami
- Runtime eligibility check (not hardcoded): min stations, online count, avg error, calibration
- Independent from METAR — both can enter the same market for head-to-head comparison
- Separate $500 paper bankroll, 15% max per position
- Config: `pws_gw` section with all thresholds

**Files:**
- `config.js` (rewritten as loader)
- `config/cities.js`, `config/trading.js`, `config/forecasts.js`, `config/platforms.js`, `config/observation.js` (NEW)
- `lib/metar-observer.js` — `_checkPwsGW()` method, `_loadPwsAvgErrorCache()`, integrated into `metarFastPoll()` step 6.5
- `lib/scanner.js` — `evaluateGWFastPath()` updated for PWS thresholds + entry_reason
- `lib/executor.js` — PWS bankroll tracking, entry_reason-based dedup, PWS-specific sizing
- `lib/alerts.js` — PWS-specific alert formatting (📡 emoji, PWS corrected median display)

---

### Previous — Fix Dallas Kalshi station: KDAL → KDFW

**Date:** 2026-02-28

Files: `config.js`, `lib/resolver.js`

---

## Post-Deployment Logs (2026-03-01 03:10 UTC)

```
Fast poll running stable after KLAGRETN14 removal:
  24 cities polled, 46-47 PWS stations online
  6-7 PWS GW eligible cities, 0 crossings detected (overnight — expected)
  9 WU responses/cycle, 23 PWS rows/cycle
  No KLAGRETN14 spam in logs
  Empty error log
```
