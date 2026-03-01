# Recent Changes Log

Last updated: 2026-03-01 05:40 UTC

## Commits

### (latest) — Detect unbounded lower NO ranges in GW entry

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
   GW-hour error — now correctly blocked. Uses per-city timezone via `config.cities[].tz`
   in a `VALUES` join, not a single UTC window.

2. **True median replaces weighted average**: `pws_corrected_median` was actually a
   distance-weighted mean (`sum(temp*weight)/totalWeight`). With 3 stations, an outlier
   pulled the average. Now uses a true median — with 3 stations the outlier is discarded.
   Also fixes warmup weight bug where 0.5 weight dwarfed distance weights (0.03-0.05),
   making warmup stations dominate at 86% influence.

**Eligibility changes**: Seattle OUT (1.71→2.88), NYC IN (2.26→1.68). 12 eligible cities.

**Files:** `lib/metar-observer.js`

---

### Previous — Replace 8 dead/broken PWS stations across 8 cities

**Date:** 2026-03-01

Full health audit of all 76 PWS stations revealed 7 never reported and 7 with <50% uptime.
Replaced dead/broken stations with nearby active alternatives found via WU API.

- **Boston**: KMAJAMAI25 → KMABOSTO395 (dead, invalid JSON)
- **Philadelphia**: KPAPHILA367 → KPAPHILA259 (5% uptime)
- **DC**: KDCWASHI468/600 → KDCWASHI467/481 (31% uptime each)
- **New Orleans**: KLANEWOR292/490 → KLAGRETN52/KLANEWOR447 (temp=null, broken sensors)
- **San Antonio**: KTXSANAN2786 → KTXSANAN2227 (temp=null, broken sensor)
- **Denver**: KCODENVE1305+KCODENVE1144 removed, KCODENVE1252 added (never online + 1% uptime)
- **Vegas**: KNVLASVE1650 → KNVLASVE611 (8% uptime)
- **Paris**: IPARIS18258 → ISAINT5183 (dead, invalid JSON)

Result: 55 stations online (up from 46-47), 11 PWS GW eligible cities

**Files:** `config/cities.js`

---

### Previous — Remove broken PWS station KLAGRETN14

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

## Post-Deployment Logs (2026-03-01 03:40 UTC)

```
PWS station bias updated: 70 stations, 7 unreliable
PWS bias cache loaded: 60 reliable, 3 warmup, 7 unreliable
Fast poll WU: 9/9 responses
PWS avg error cache loaded: 25 cities, 11 eligible: buenos aires(1.25), chicago(1.56),
  dallas(1.81), dc(1.72), london(0.68), minneapolis(1.18), paris(1.1), sao paulo(1.51),
  seattle(1.7), toronto(0.95), wellington(1.04)
PWS GW: 7 eligible cities, 5 crossings detected (first poll), 0 on dedup (second poll)
PWS: 23 rows written, 23 cities, 55 stations online
Empty error log
```
