# Handoff: Kalshi NWS Resolution Fix Session - 2026-02-10 (Part B)

## 1. Session Summary

Re-enabled Kalshi weather trading by fixing the resolution source mismatch. Added NWS observation-based historical temperature fetching (`getNWSObservationHigh()`) that queries the correct NWS station for each city. Made resolution logic platform-aware across all three resolution paths (YES trades, NO trades, re-entries). Kalshi now resolves via NWS observations instead of Open-Meteo, matching Kalshi's actual resolution source.

## 2. Current State

### Working
- **NWS observation fetcher**: `getNWSObservationHigh()` queries NWS API for hourly observations, finds daily max, converts C→F, rounds to integer (matching NWS CLI rounding)
- **Kalshi resolution wrapper**: `getKalshiResolutionHigh()` looks up station from CITIES config, falls back to Open-Meteo with warning if NWS fails
- **Platform-aware resolution**: All 3 resolution paths (YES in weather-trader.js, NO in run-weather-bot.js, re-entries in position-manager.js) use NWS for Kalshi trades
- **Station IDs configured**: All 15 US cities have `nwsStation` field, NYC/Chicago have `polymarketStation` (for future WU work)
- **Kalshi scanning re-enabled**: `KALSHI_ENABLED: true` in run-weather-bot.js
- **Both bots running clean**: 0 errors after restart, Kalshi integration ENABLED in logs

### Validated with Live Data
- NWS API returns data for all tested stations (KNYC, KMDW, KSEA)
- NYC Feb 9: NWS=31°F vs Open-Meteo=24.8°F (**6.2°F difference!**)
- Chicago Feb 7: NWS=25°F vs Open-Meteo=22.6°F (2.4°F diff)
- Seattle Feb 7: NWS=52°F vs Open-Meteo=51.6°F (0.4°F diff — same station)
- 2 of 8 past Kalshi trades would have flipped from LOST to WON with NWS

### Not Started
- **Polymarket WU resolution** (future): Station IDs stored in `polymarketStation` field but not used yet. Need METAR or WU API to resolve Polymarket trades with correct source.
- **NWS forecast for LA/SF/Philly**: These cities now have `nwsStation` for resolution but NWS forecasts use gridpoint API (separate config). May need `nwsGridpoint` additions.

### Needs Attention
- **Kalshi API credentials**: Bot A logs `Kalshi trading credentials not configured - market scanning only`. Need `KALSHI_API_KEY` and `KALSHI_PRIVATE_KEY_PATH` in `.env` to actually place trades.
- **Monitor first Kalshi trades**: Watch 5-10 new Kalshi trades through resolution to confirm win rate improvement
- **NWS observation count**: KNYC returns 24 obs/day (hourly), airport stations return ~312 (5-min ASOS). Both sufficient for daily max calculation.
- **Integer rounding**: NWS `highF` is rounded to nearest integer to match NWS CLI daily report format. Verify this matches Kalshi's exact resolution values.

## 3. Key Decisions Made

### Architecture
- **NWS observations API** (not CLI): Uses `api.weather.gov/stations/{id}/observations` endpoint. Free, no key, same-day data. CLI reports are delayed and harder to parse.
- **UTC time window from timezone**: Local midnight → UTC using `Intl.DateTimeFormat` offset detection. E.g., NYC midnight = 05:00Z.
- **Integer rounding for Kalshi**: `Math.round()` on converted °F to match NWS CLI integer format.
- **QC filtering**: Skip observations where `qualityControl === 'X'` (failed quality control).

### Station Mapping (Critical)
- **Kalshi and Polymarket use DIFFERENT stations for NYC and Chicago**
  - NYC: Kalshi=KNYC (Central Park), Polymarket=KLGA (LaGuardia) — 2-3°F typical diff
  - Chicago: Kalshi=KMDW (Midway), Polymarket=KORD (O'Hare) — 1-3°F typical diff
- Station IDs confirmed from Kalshi contract terms and wethr.net

### Trade-offs
- **Open-Meteo fallback**: If NWS API is down, `getKalshiResolutionHigh()` falls back to Open-Meteo with loud warning. Better to resolve with imperfect data than not resolve.
- **No NWS for Polymarket yet**: Open-Meteo resolution is "close enough" (~60% win rate). WU/METAR-based resolution would be more accurate but requires additional API integration.

## 4. Next Steps (Prioritized)

### Immediate: Configure Kalshi Trading Credentials
- Set `KALSHI_API_KEY` and `KALSHI_PRIVATE_KEY_PATH` in `.env`
- Verify bot can scan AND trade on Kalshi markets

### Monitor: First 5-10 Kalshi Trades
- Watch new Kalshi trades through full lifecycle (entry → resolution)
- Verify NWS resolution values in logs (`source: 'nws_observations'`)
- Compare win rate vs old 12% baseline

### Future: Polymarket WU Resolution
- Research METAR-based resolution for Polymarket (uses airport stations like KLGA, KORD)
- `polymarketStation` field already in CITIES config for NYC/Chicago + international cities
- aviationweather.gov METAR API is promising (free, no key, same stations)

### Future: NWS Gridpoint Forecasts for Missing Cities
- LA, SF, Philly have `nwsStation` but may lack NWS gridpoint config for forecasting
- Check if `getNWSForecast()` works for these cities or needs gridpoint additions

## 5. Gotchas & Warnings

### NWS API Quirks
- Returns temperature in Celsius (`wmoUnit:degC`) — must convert to F
- Observations have `qualityControl` field: `V`=valid, `S`=suspect, `X`=failed — only skip `X`
- KNYC (Central Park) only has hourly observations; airport stations have 5-min ASOS data
- Rate limit: ~50 requests/minute recommended (well within our usage)

### UTC Window Construction
- The timezone offset calculation uses `Intl.DateTimeFormat` at noon local time. DST transitions at midnight could theoretically cause a 1-hour window shift. Not a practical concern since weather highs occur in afternoon.

### Station Differences Cause Large Temperature Gaps
- NYC: KNYC (Central Park, urban heat island) vs Open-Meteo (grid average) = **6°F difference on Feb 9**
- This is not a bug — it's the fundamental problem we're solving. Different measurement points measure different temperatures.

## 6. Files Modified This Session

| File | Changes |
|------|---------|
| `lib/weather-api.js` | Added `nwsStation`/`polymarketStation` to CITIES config; added `getNWSObservationHigh()` + `getKalshiResolutionHigh()`; added `platform` param to `getMultiSourceForecast()` — forces NWS for Kalshi |
| `lib/weather-trader.js` | Made `resolveTemperatureTrade()` platform-aware: Kalshi→NWS, Polymarket→Open-Meteo; removed misleading warning log |
| `run-weather-bot.js` | Flipped `KALSHI_ENABLED: true`; made `resolveNoTrades()` platform-aware; passed platform to all `getMultiSourceForecast()` calls; added [PM]/[KL] tags to all Telegram alerts |
| `lib/position-manager.js` | Made `resolveReentryTrades()` platform-aware; added platform param to `getCurrentForecast()`; added [PM]/[KL] tags to all Telegram alerts |

### Commits
1. `5ae49b1` - Fix Kalshi resolution: use NWS observations instead of Open-Meteo
2. `384e70d` - Add platform-aware forecast selection and platform tags to Telegram
