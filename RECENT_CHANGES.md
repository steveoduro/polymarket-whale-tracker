# Recent Changes Log

Last updated: 2026-03-01 02:20 UTC

## Commits

### (latest) — Config reorganization + PWS GW strategy

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

## Post-Deployment Logs (2026-03-01 02:20 UTC)

```
Bot restarted with config split + PWS GW strategy.

Startup verification:
  Config: 14 keys, 28 cities — all values preserved
  Bankrolls: YES $977.90 / NO $1000.00 / GW Live $10.00 / GW Paper $604.85 / PWS GW $500.00
  PWS coverage: 25 cities x 3 stations, 1 x 2, 1 x 1, 1 x 0 (ankara)
  7 open trades

Fast poll running:
  23 cities polled, 47-48 PWS stations online
  0 GW detections (overnight — expected)
  PWS data collection: 23 rows/cycle

PWS GW eligible cities (12):
  london(0.68), toronto(1.00), wellington(1.10), paris(1.10),
  minneapolis(1.23), buenos aires(1.25), sao paulo(1.51),
  chicago(1.66), dc(1.72), seattle(1.74), dallas(1.90), miami(1.93)

Empty error log.
```
