# Handoff — Session 2026-02-13 (Evening)

## Session Summary
Implemented all 4 tasks from the new task.md: Wellington timezone fix, WU JSON API scraper (replacing HTML scraping approach), METAR intraday observer, and enhanced exit evaluator with guaranteed win/loss detection. Discovered Weather.com v1 JSON API — no headless browser needed. All features verified working in production cycle.

## Current State

### Working
- **WU scraper** (`lib/wu-scraper.js`): Uses Weather.com v1 JSON API (`api.weather.com/v1/location/{STATION}:9:{COUNTRY}/observations/historical.json`). US stations have `max_temp` field (sub-hourly peaks); international compute max from hourly `temp`. Rate-limited 2.5s/request.
- **METAR observer** (`lib/metar-observer.js`): Polls every 30 min during active hours (6am-11pm local), tracks running daily high in `metar_observations` table. First cycle polled 12 cities, 2 new highs.
- **Enhanced exit evaluator**: Detects guaranteed win/loss from observation signals. Buenos Aires already flagged as GUARANTEED LOSS (running high 29°C exceeds 27.5°C max). All in `log_only` mode.
- **Wellington timezone fix**: Full date-based offset via `Intl.DateTimeFormat` — handles UTC+13 correctly.
- **WU vs METAR audit**: Auto-logged to `wu_audit` table on every Polymarket resolution. Seattle Feb 12 showed 1°F diff (WU 53°F vs METAR 52°F).
- **Bot cycle**: 163s, 28 positions monitored, 200 opportunities backfilled, no errors.

### Partially Done
- `scripts/wu-audit.js` still references old `WU_CITY_PATHS` from resolver.js (now removed). Needs update to use WU scraper directly.

### Needs Attention
- **Calibration buckets show miscalibration**: 25-50% model confidence → only 2.9% actual win rate (n=104). Model is systematically overconfident in the mid-range. Consider raising MIN_EDGE_PCT or adjusting std dev further.
- **YES bankroll nearly exhausted**: $346 remaining. 28 open trades.
- **5 positions flagged for exit** (log_only): NO miami 78-79°F, YES chicago 50°F+, YES buenos aires 27°C or below (guaranteed loss), YES atlanta 60-61°F, YES denver 54° or below. Consider flipping to `active` mode.

## Key Decisions Made
- **WU JSON API over HTML scraping**: Weather.com v1 API returns all the data we need as JSON. No puppeteer/cheerio required. API key is the well-known public key embedded in WU frontend.
- **US `max_temp` vs computed max**: US stations report `max_temp` in the last observation (captures sub-hourly peaks not seen in hourly data). International stations return `max_temp: null` — we compute max from hourly readings.
- **METAR observer only today's date**: No point polling future dates. Only polls cities with open trades during active local hours.
- **Guaranteed win/loss in log_only**: Conservative approach — observe for a few days before enabling automatic exits on observation signals.
- **WU as primary Polymarket source**: Resolver now tries WU API first for Polymarket, METAR as fallback. Both results logged to `wu_audit` for comparison.

## Next Steps (Prioritized)
1. **Update `scripts/wu-audit.js`** to use WU scraper class instead of old `WU_CITY_PATHS`
2. **Monitor WU vs METAR diffs** over next few days — validate WU API accuracy before trusting it for resolution
3. **Consider flipping exit evaluator to `active` mode** for guaranteed_loss positions (Buenos Aires is a clear case)
4. **Address calibration miscalibration** — 25-50% bucket has 2.9% actual win rate, model is overconfident
5. **Consider bankroll increase** or wait for current 28 trades to resolve

## Gotchas & Warnings
- **WU API key** (`e1f10a1e78da46f5b10a1e78da96f525`) is a well-known public key but could theoretically be rotated by The Weather Company. Monitor for 401s.
- **WU `max_temp` discrepancy**: Chicago Feb 12: WU API `max_temp=40°F` vs METAR computed max `39°F`. The 1°F diff is from WU capturing sub-hourly peaks. This is the **correct** value for Polymarket resolution.
- **Observer upsert conflict**: Uses `onConflict: 'city,target_date,observed_at'` — if METAR returns the same observation twice (same timestamp), it upserts instead of duplicating.
- **`wuCountry` config**: Added to all 23 cities (US, GB, KR, CA, AR, TR, NZ). If new cities are added, must include `wuCountry`.

## Files Modified This Session
- `lib/wu-scraper.js` — **NEW**: Weather.com v1 JSON API client
- `lib/metar-observer.js` — **NEW**: Intraday METAR observation poller
- `config.js` — Added `observer` config section, `wuCountry` to all 23 cities
- `lib/resolver.js` — Wellington timezone fix, WU API integration, removed `WU_CITY_PATHS`/`_getWUUrl()`, added `_logWUAudit()`
- `lib/monitor.js` — Added `_getLatestObservation()`, `_checkAlreadyDecided()`, observation signal integration
- `bot.js` — Integrated METARObserver as step 4 in cycle

## DB Tables Created
- `metar_observations` (city, station_id, target_date, observed_at, temp_c/f, running_high_c/f, observation_count)
- `wu_audit` (city, target_date, station_id, wu_high_f/c, metar_high_f/c, match, diff_f)

## Commits
- `58a86fc` — Model recalibration (from previous session continuation)
- `f8eaeae` — WU scraper, METAR observer, enhanced exit evaluator, Wellington timezone fix
