# Handoff: Weather Intelligence Overhaul Session - 2026-02-10

## 1. Session Summary

Implemented the two-gate forecast exit system (Priority 1) to stop whipsaw bleeding on forecast-shift exits/re-entries. Gate 1 checks if a forecast shift exceeds the source's historical average error for that city; Gate 2 requires the shift to persist across 2 consecutive bot checks (~20 min). Also updated CITY_SOURCE_PRIORITY (Priority 2) based on fresh `forecast_accuracy` data, fixing Atlanta (now NWS first) and Denver (now WeatherAPI first). Both bots restarted cleanly and are running in production.

## 2. Current State

### Working
- **Two-gate forecast exit** (Bot B): Error margin + stability confirmation fully implemented and running
- **NO trading stability gate** (Bot A): Same 2-check confirmation pattern for NO forecast exits
- **Source priority per city**: All 21 cities updated with data-backed priority ordering and sample sizes
- **Source error lookup**: `getSourceErrors()` queries `forecast_accuracy` table, caches per cycle
- **Distance calculation**: `calculateDistanceFromRange()` handles all range formats (X-Y, "or higher", "or below", single value, Celsius)
- **Enriched Telegram messages**: Forecast exits now show source, distance from range, and error margin
- Both bots running in PM2 (`weather-bot`, `position-manager`) with 0 errors

### Partially Done / Not Started
- **Priority 3: Aviation METAR** (not started) - Early actual temperatures via airport observations
- **Priority 4: Dynamic accuracy tracking** (not started) - Continuous source accuracy updates
- **Confidence gating** (not started) - Exit logic doesn't yet consider forecast confidence level or multi-source consensus direction

### Needs Attention
- **Low sample sizes**: Some cities have only 1-2 data points per source (e.g., Atlanta NWS: n=1, Wellington WA: n=1). Priorities will need re-evaluation as more data accumulates
- **Monitoring**: Need 24-48h of data to verify the two-gate system is correctly filtering noise vs real shifts. Query:
  ```sql
  SELECT action, reason, COUNT(*)
  FROM position_manager_logs
  WHERE action IN ('skip_forecast_exit', 'exit_forecast_shift')
  AND created_at > NOW() - INTERVAL '48 hours'
  GROUP BY action, reason
  ORDER BY count DESC;
  ```

## 3. Key Decisions Made

### Architecture
- **In-memory shift tracker** (not DB): Resets on restart, which is the safe default. A restart means fresh state = conservative = no stale pending shifts acting on outdated data. Trade-off: a genuine shift in progress gets reset, adding one more cycle delay.
- **Cache source errors per cycle**: `_sourceErrorCache` cleared at start of `run()`, reloaded once per cycle. Avoids hammering Supabase but stays fresh.
- **Position key format**: `${position._source}:${position.id}` — prevents collisions between `weather_paper_trades` and `reentry_trades` records with same numeric ID.

### Trade-offs
- **Error margin multiplier = 1.0x**: Conservative starting point. If we see too many false exits still slipping through, can increase to 1.5x. If too many real shifts are being suppressed, lower to 0.5x.
- **Default error = 2.0°F**: For cities/sources with no accuracy data. This is intentionally conservative (don't exit on thin evidence). Covers the gap until more data accumulates.
- **Stability checks = 2**: Minimum viable — catches single-reading noise. Could increase to 3 if oscillation patterns persist, but that would mean 30+ min delay before exit.
- **NO trades: stability gate only, no error margin gate**: NO trades already use a 2°C distance threshold which serves a similar purpose to the error margin. Adding both gates would over-filter.

### What the plan called for but was adapted
- The plan's `getSourceErrors()` assumed `forecast_accuracy` had generic `source`/`abs_error_f` columns. The actual table has per-source columns (`open_meteo_error_f`, `nws_error_f`, `weatherapi_error_f`). Implementation adapted to iterate these columns correctly.

## 4. Next Steps (Prioritized)

### Immediate: Monitor & Validate (24-48h)
- Watch Bot B logs for `skip_forecast_exit` vs `exit_forecast_shift` patterns
- Verify no positions are being held that should have exited (check P&L on next resolution batch)
- If tuning needed, adjust `FORECAST_EXIT_MIN_MARGIN_MULTIPLIER` or `FORECAST_EXIT_CONFIRM_CHECKS` in `run-position-manager.js` CONFIG

### Priority 3: Early Actuals + Forecast Confidence — Next Session

Two sub-tasks, both researched in the planning session:

#### 3A: Aviation Weather (METAR) — Early Actuals
**Goal**: Know actual daily high by 4-5 PM local, 1-2h before Polymarket resolves.

**API choice: aviationweather.gov** (chosen after evaluating 6 alternatives):

| Source | Verdict | Reason |
|--------|---------|--------|
| **aviationweather.gov** | PRIMARY | Free, no key, all airports in 1 call, 0.1°C precision (US), gov reliability, 100 req/min |
| **CheckWX** | BACKUP | Free 3K req/day, pre-decoded F+C, but needs API key registration |
| AVWX REST | Skip | Single-station queries, unclear limits |
| OpenWeatherMap | Skip | No raw METAR — modeled/interpolated, not actual observations |
| metar-taf.com | Skip | Credit-based, no free tier |
| Aviation Edge | Skip | Enterprise pricing, overkill |

**Tested live endpoint** (confirmed working for all 11 airports):
```
GET https://aviationweather.gov/api/data/metar?ids=KJFK,KLGA,KORD,KSEA,KATL,KDFW,EGLL,CYYZ,RKSI,NZWN,LTAC&format=json
```

**Key findings from research**:
- METAR temps come from same ASOS/AWOS instruments weather services use
- Hourly snapshots may miss peak between observations: typical underestimate of daily max is **0.2-0.6°C (0.4-1.1°F)**
- US stations (K-prefix) provide 0.1°C precision via METAR T-group (e.g., `T10281144` = -2.8°C)
- International stations only report whole-degree Celsius
- Daily high typically occurs 2-5 PM local; concentrate polling noon–6 PM local
- Custom User-Agent header recommended to prevent automated filtering

**Airport codes**:
KJFK/KLGA (NYC), KORD (Chicago), KSEA (Seattle), KATL (Atlanta), KDFW (Dallas), EGLL (London), CYYZ (Toronto), RKSI (Seoul), NZWN (Wellington), LTAC (Ankara)

**What this enables**:
1. Exit losers before resolution at 10¢ instead of $0 (save ~10¢ × shares)
2. Hold winners with certainty instead of panic-exiting on forecast noise
3. For NO trades: KNOW we won before market resolves
4. Late-day arbitrage: market mispriced after we know actual

**Polling schedule**: ~24 requests/day (hourly, all airports per call)

**Files to modify**:
- `lib/weather-api.js`: Add METAR fetching, airport code mapping per city, max temp tracking
- `lib/position-manager.js`: Add early-actual exit logic (if actual known and position is loser, exit immediately)
- Possibly new table `metar_observations` or `actual_temp_tracker`

#### 3B: Ensemble Forecast Uncertainty — Confidence Signal
**Goal**: Use ensemble model spread as a confidence metric for trading decisions.

**API: Open-Meteo Ensemble API** (free, no key):
```
GET https://ensemble-api.open-meteo.com/v1/ensemble?latitude=52.52&longitude=13.41&hourly=temperature_2m&models=icon_seamless_eps
```

- 15+ ensemble models: ECMWF IFS (51 members), GFS (31 members), DWD ICON, etc.
- Returns temperature forecasts from each ensemble member
- Narrow spread = high confidence, wide spread = uncertain
- **Use case**: Bet more aggressively when ensembles converge; reduce position size or skip when they diverge
- Could feed into Gate 1 error margin — if ensemble spread is tight, use tighter error threshold
- Total: 2-3 requests/day per city

**Combined daily API load for Priority 3**: ~27 calls/day (all free, no keys needed)

### Priority 4: Dynamic Accuracy Tracking
- Weight recent accuracy more than old accuracy (exponential decay or rolling window)
- Auto-update CITY_SOURCE_PRIORITY based on latest data
- Could be a periodic job that runs after resolutions

### Other Ideas from task.md (Lower Priority)
- Time-to-resolution tolerance (more lenient for 3+ days out)
- Seasonal accuracy patterns
- Weather model run times (forecasts update at specific hours — freshest data matters)

## 5. Gotchas & Warnings

### forecast_accuracy table schema
The table does NOT have generic `source`/`abs_error_f` columns. It has per-source columns:
- `open_meteo_error_f`, `nws_error_f`, `weatherapi_error_f`
- `open_meteo_forecast_f`, `nws_forecast_f`, `weatherapi_forecast_f`
- Keyed by `(city, market_date)` with UNIQUE constraint

### primarySource values
From `getMultiSourceForecast()` via `selectBestForecast()`: `'openmeteo'`, `'nws'`, `'weatherapi'`, or `'consensus'`. These must match the keys used in `getSourceErrors()` lookup (`city:source`).

### Celsius ranges
`calculateDistanceFromRange()` converts forecast to Celsius when the range contains `°C`. The returned distance is in the range's native unit. The error margin from `getSourceErrors()` is always in °F. For Celsius ranges, a 2.0°F default error = ~1.1°C margin, which is reasonable but not exact. Worth revisiting if international city exits behave oddly.

### Bot B cycles at 10 min, Bot A at 5 min
The stability gate's "2 consecutive checks" means ~20 min for Bot B (YES positions) but ~10 min for Bot A (NO positions). This is fine — NO positions already have the 2°C distance threshold as an additional filter.

### shiftTracker resets on restart
If Bot B is restarted mid-confirmation (after check 1/2), the pending shift is lost and starts over. This is by design (conservative), but be aware that a `pm2 restart position-manager` during an active shift will add one cycle delay.

## 6. Files Modified This Session

| File | Changes |
|------|---------|
| `lib/position-manager.js` | Added `shiftTracker`, `getSourceErrors()`, `calculateDistanceFromRange()`, two-gate forecast exit logic, enriched `getCurrentForecast()` pass-through, enhanced `executeForecastExit()` Telegram/logs |
| `run-position-manager.js` | Added 3 config params (`FORECAST_EXIT_MIN_MARGIN_MULTIPLIER`, `FORECAST_EXIT_DEFAULT_ERROR_F`, `FORECAST_EXIT_CONFIRM_CHECKS`), updated startup banner |
| `run-weather-bot.js` | Added `noShiftTracker` to WeatherBot constructor, wrapped NO forecast exit in stability confirmation gate (2 consecutive checks) |
| `lib/weather-api.js` | Updated `CITY_SOURCE_PRIORITY` for all 21 cities with fresh accuracy data: Atlanta→NWS first, Denver→WA first, refreshed all comments with sample sizes |

### Commits
1. `8706bbd` - Add two-gate forecast exit system to prevent whipsaw bleeding
2. `d495a32` - Update CITY_SOURCE_PRIORITY from latest forecast_accuracy data
