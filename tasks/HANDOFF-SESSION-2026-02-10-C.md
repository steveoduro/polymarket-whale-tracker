# Handoff: Weekly Platform Report & Server Bot Integration - 2026-02-10 (Part C)

## 1. Session Summary

Continued from session B (Kalshi NWS resolution fix). Fixed `KALSHI_PRIVATE_KEY_PATH` in `.env` (was `/root/...`, needed `/home/deployer/...`) to enable Kalshi trading. Researched Kalshi market timing (next-day only, created ~10:30 UTC, tradeable 15:00 UTC). Built a weekly platform intelligence report that auto-fires every Monday at 10 UTC — implemented in both Bot A (`run-weather-bot.js`) and the VPS management Telegram bot (`server-tools/server-bot.js`).

## 2. Current State

### Working
- **Kalshi credentials fixed**: `tradingEnabled: true` confirmed in weather-bot logs
- **Weekly report in Bot A**: `checkWeeklyReport()` + `runWeeklyReport()` in `run-weather-bot.js` — fires Monday 10 UTC, uses `discoverWeatherSeries()` from kalshi-api.js
- **`/report` command in server-bot**: On-demand platform report via Telegram (Kalshi series, 7-day P&L, bot health)
- **Weekly auto-fire in server-bot**: `generateReport()` extracted as reusable function, `checkWeeklyReport()` timer fires Monday 10-11 UTC via `bot.telegram.sendMessage()`
- **Both bots restarted clean**: No errors after restart

### Partially Done
- **Kalshi series discovery found 7 new tickers**: KXHIGHTBOS (Boston), KXHIGHTPHX (Phoenix), KXHIGHTMIN (Minneapolis), plus renamed tickers for Atlanta/Houston/Denver/NYC. These aren't added to `WEATHER_SERIES` in `kalshi-api.js` yet — just reported.
- **2 missing tickers**: KXHIGHDAL (Dallas), KXHIGHATL (Atlanta) — likely renamed on Kalshi's side. Should update our config.

### Needs Attention
- **No Kalshi trades entering yet**: Markets exist but are fairly priced (no edge detected). This is normal behavior, not a bug.
- **Server-bot `KNOWN_KALSHI_TICKERS` is hardcoded**: Separate from `WEATHER_SERIES` in kalshi-api.js. If new cities are added to the trading bot, the server-bot's set needs manual sync.
- **Bot A also has weekly report**: Both Bot A (weather-bot Telegram) and server-bot (VPS management Telegram) will fire reports Monday 10 UTC. User wanted it in both, but the server-bot chat is the preferred reading location (less noise).

## 3. Key Decisions Made

### Architecture
- **Report in server-bot uses plain `fetch()` to Kalshi API**: No auth needed for series discovery. Avoids importing weather project code into server-tools.
- **`KNOWN_KALSHI_TICKERS` hardcoded in server-bot**: Trade-off vs importing from kalshi-api.js. Keeps server-bot project-agnostic. Must manually sync if tickers change.
- **`generateReport()` extracted as standalone function**: Shared by both `/report` command and weekly auto-fire timer. Uses `bot.telegram.sendMessage()` for auto-fire (no `ctx` available).
- **Hourly timer check for weekly fire**: Same pattern as Bot A — `setInterval(checkWeeklyReport, 60*60*1000)` with day/hour guard. In-memory `lastWeeklyReport` dedup resets on restart (acceptable: double-fire > missed fire).

### Kalshi Market Timing
- Markets created ~10:30 UTC, tradeable at 15:00 UTC (10 AM ET)
- Only for next day — no 2+ day lookahead
- Past 17 Kalshi trades entered 0.2-8.8 hours before target dates

## 4. Next Steps (Prioritized)

### Immediate
1. **Add new Kalshi cities**: KXHIGHTBOS (Boston), KXHIGHTPHX (Phoenix), KXHIGHTMIN (Minneapolis) to `WEATHER_SERIES` in `kalshi-api.js` and `CITIES` in `weather-api.js`
2. **Update renamed tickers**: KXHIGHDAL → new ticker, KXHIGHATL → new ticker in `WEATHER_SERIES`

### Follow-up
3. **Monitor first Kalshi trades through resolution**: Verify NWS resolution values match expected (from session B work)
4. **Polymarket WU resolution**: `polymarketStation` config exists but unused — need Weather Underground or METAR API for accurate PM resolution
5. **Sync `KNOWN_KALSHI_TICKERS` in server-bot**: After updating `WEATHER_SERIES`, update the hardcoded set in `server-tools/server-bot.js`

## 5. Gotchas & Warnings

- **Server-bot `.env` is at `/home/deployer/server-tools/.env`**: Different from weather project `.env`. Has same Supabase creds but different Telegram bot token.
- **Server-bot Kalshi series filter**: Uses `fetch()` to public API + `KXHIGH*` prefix filter + exclude patterns. If Kalshi changes their ticker naming convention, filter breaks silently.
- **`lastWeeklyReport` is in-memory in both bots**: PM2 restart during Monday 10-11 window will re-trigger report. Not harmful but be aware.
- **Kalshi API for series discovery returns ALL series (not just weather)**: Must filter aggressively. Initial attempt returned 73 "new" series including non-weather ones like "contempt of Congress".
- **`/tmp/` test scripts need `NODE_PATH` and explicit dotenv path**: `require('dotenv').config({ path: '/home/deployer/polymarket-whale-tracker/.env' })` — plain `require('dotenv').config()` looks in `/tmp/`.

## 6. Files Modified This Session

| File | Changes |
|------|---------|
| `/home/deployer/polymarket-whale-tracker/.env` | Fixed `KALSHI_PRIVATE_KEY_PATH` from `/root/...` to `/home/deployer/...` |
| `/home/deployer/polymarket-whale-tracker/run-weather-bot.js` | Added `WEATHER_SERIES` import; added `checkWeeklyReport()` timer guard + `runWeeklyReport()` method with 3 sections (Kalshi series, P&L, market coverage); added weekly timer in `start()` and cleanup in `stop()` |
| `/home/deployer/server-tools/server-bot.js` | Added `KNOWN_KALSHI_TICKERS` set; added `generateReport()` function (Kalshi series, P&L, bot health); added `/report` command; added weekly auto-fire timer (Monday 10 UTC); updated `/help` text; added cleanup in SIGINT/SIGTERM handlers |

### Commits
1. `10f97b3` - Add weekly platform intelligence report to Telegram (Bot A only)
2. Server-bot changes not committed (separate project, no git repo in server-tools)
