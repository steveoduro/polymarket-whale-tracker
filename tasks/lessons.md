# Trading Bot Lessons

## Edge Calculations
- ALWAYS account for platform fees in edge calculation
- Edge thresholds: $0.05/share was too restrictive (blocked 92% of trades), lowered to $0.03 - need 100+ trades to find optimal
- Formula: netEdge = grossEdge - (marketPrice × feeRate)
- Don't double-count fees if Kelly sizing already includes them
- Overround markets: use execution price, not normalized price for edge calc
- Backtest sample size: 46 trades is too small for statistical confidence - need 100+

## Position Management
- Check for existing positions BEFORE analyzing market
- Never create duplicate positions or hedges
- Use city+date for deduplication (not slug - differs across platforms)
- Pre-load existing positions at cycle start for cross-cycle dedup
- Use percentage-based capital deployment, not position count limits
- Track deployed capital accurately
- Dedup re-entries by city+date+range, NOT by original_trade_id (same city/date can have multiple exited originals)
- When a feature creates new state (e.g., re-entries), think about whether ALL existing logic handles that new state. Example: re-entries weren't monitored for take-profit until Fix 2
- Take-profit near entry price can be a NET LOSS after fees. Always check: `exitPrice * (1 - feeRate) > entryPrice` before executing
- Re-entry chains: always link `original_trade_id` back to the `weather_paper_trades` record, never to intermediate re-entries. This ensures cost cap traces to true original.
- Read `edge_at_entry` directly from the position record, not from `weather_opportunities` (the traded range may differ from recommended range, causing lookup failure and 0% default)

## API Considerations
- Reset API counters between cycles
- Polymarket API can return stale data - verify freshness
- Handle rate limits gracefully
- Log all API responses for debugging

## Risk Management
- Paper trade extensively before live
- Set hard limits on capital deployment (e.g., 80% max)
- Kelly criterion: use fractional Kelly (0.5) for safety
- Have circuit breakers for unusual market conditions

## Backtesting & Optimization
- Always log opportunities we skip (filtered) so we can backtest after resolution
- Without filtered opportunity logging, we can't optimize filter thresholds
- Store filter_reason, net_edge_dollars, would_have_won for analysis
- Wait for 100+ resolved trades before making major threshold changes

## Common Bugs
- Boundary matching: forecast on exact boundary needs careful handling
- Kalshi uses "X° to Y°" format, Polymarket uses "X-Y°F" - handle both
- Betting against own prediction due to logic inversion
- Duplicate hedge trades when not checking existing hedges
- API counter accumulation across cycles
- Always store temperatures in consistent units. The forecast_accuracy table had international cities storing Celsius in the actual_temp_f column, making error analysis useless
- When passing actual temps to accuracy recording, always use highF regardless of what unit the trade range uses
- When querying multiple tables, tag results with `_source` so downstream logic (exit, update) targets the correct table
- Supabase with anon key can't run DDL (ALTER TABLE). Migrations must be run in the Supabase SQL Editor dashboard.
- `select('*')` returns only columns that exist in the table. If checking for a column that may not exist (pre-migration), the field will be `undefined`, not error.

## Bot B (Position Manager) Specific
- Bot B monitors positions from BOTH `weather_paper_trades` and `reentry_trades`
- When exiting a re-entry, DON'T set `exit_pnl` (column doesn't exist on `reentry_trades`). Use `pnl` only.
- When exiting a re-entry, DON'T set `managed_by` on `weather_paper_trades` table (it's in `reentry_trades`)
- Forecast exit is skipped for same-day positions (daysToResolution < forecastExitMinDays). This is correct — no point exiting hours before resolution.
- The min bid threshold for forecast exits (15¢) prevents selling at rock-bottom prices, but creates a "hold zone" where the position is known to be bad but not worth selling. This is a conscious tradeoff.
- Wellington whipsaw: forecast-exited at 15¢, re-entered at 21¢ twenty minutes later. Fixed by two-gate system (error margin + stability confirmation). No longer exits on single noisy readings.
- Re-entry `market_slug` column was added via migration. Code gracefully retries insert without it if column doesn't exist yet.

## Multi-Source Forecasts
- Use multiple weather sources (Open-Meteo, NWS, WeatherAPI)
- Consensus within 1°F = very-high confidence
- Consensus within 2°F = high confidence
- Large spread (>4°F) = low confidence - be cautious
- NWS is authoritative for US cities (Kalshi resolution source)
- Weather source accuracy varies dramatically by city. Dallas: NWS is 14x better than Open-Meteo. Seattle/Toronto/London: WeatherAPI beats Open-Meteo by 2-3x
- City-specific source prioritization is essential - one-size-fits-all approach leaves significant accuracy gains on the table
- CITY_SOURCE_PRIORITY config in weather-api.js controls per-city source ordering

## Resolution & Settlement
- Understand exact resolution rules per market
- Kalshi "between" means inclusive: X ≤ temp ≤ Y
- Settlement lag creates opportunities (outcome known, market still trading)
- Resolution timing varies by platform

## Proactive Issue Detection
- When implementing a new feature, ask: "what existing logic now has a blind spot?"
- Example: Bot B creates re-entries → but nothing monitors them for exits → they hold to resolution with no profit-taking
- Example: Bot B exits positions → Bot A might re-enter the same city/date → needed dedup fix
- Example: edge comparison looks up from opportunities table → but traded range != recommended range → 0% default
- Rule: whenever new state is created (new rows, new statuses, new tables), trace through ALL code paths that should handle that state
- **Audit checklist for EVERY status change path**: (1) Telegram notification? (2) exit_reason set? (3) exit_time set? (4) exit_price set? (5) Logged to position_manager_logs? — Run this checklist after any change to exit/resolution logic
- Example: resolveReentryTrades had no Telegram + no exit_reason/exit_time — silent resolution with incomplete data
- Example: ALL 4 resolution paths (YES temp, YES precip, re-entry, NO) were missing exit_reason/exit_time/exit_price

## Performance Data (as of Feb 9, 2026)
- Bot B managed exits: 17W / 9L, +$510 P&L
- Normalized forward rate: ~$42/day after adjusting for Kalshi losses and startup windfall
- 50% of LOSING trades hit 80¢+ before crashing to zero — take-profit captures this value
- Stop losses hurt (backtest showed -$78 worse than holding) — disabled

## Floating Point Comparisons
- Never use `<=` or `>=` for edge comparisons — floating point makes 15.0% appear as 15.0000001%, passing a "strictly greater" guard
- Use a buffer: `reentryEdgePct < previousEdge + 0.5` requires at least 0.5% real improvement
- Same principle applies to any threshold comparison with calculated values

## Forecast Exit Intelligence (Two-Gate System)
- Gate 1 (error margin): Forecast shift must exceed the source's historical avg error for that city before triggering exit. Uses `forecast_accuracy` table with per-source columns (`open_meteo_error_f`, `nws_error_f`, `weatherapi_error_f`), NOT generic `source`/`abs_error_f` columns.
- Gate 2 (stability): Shift must persist across 2 consecutive bot checks before executing exit. Single noisy readings get filtered out.
- `shiftTracker` is in-memory (not DB). Resets on restart = conservative fresh start. Be aware that `pm2 restart` during an active shift adds one cycle delay.
- Default error margin fallback is 2.0°F — conservative, errs on side of holding.
- For Celsius ranges, `calculateDistanceFromRange()` returns distance in °C but error margin from `getSourceErrors()` is in °F. The 2.0°F default ≈ 1.1°C, which works but isn't exact. Revisit if international exits behave oddly.
- `getCurrentForecast()` now passes through `primarySource`, `consensus`, `sources` — don't strip these in future refactors.

## NO Trading
- NO probability uses normal distribution with 1.5°C std dev — at 3°C+ distance, probabilities are very high (99%+)
- NO price derivation from YES: `NO ask = 1 - YES bid`, `NO bid = 1 - YES ask`
- Separate bankroll ($1,000) from YES trading — prevents NO losses from eating YES capital
- NO monitoring runs in Bot A's scan cycle (not Bot B) — keeps all NO logic in one file
- `parseRangeForNo()` handles °F→°C conversion and all range types (single, bounded, open_high, open_low)
- Forecast exit uses distance threshold (2°C) not range matching — simpler and more intuitive for NO
- NO resolution: check if actual temp DID land in range → if yes, NO lost; if no, NO won

## Platform-Specific Resolution Sources
- **Kalshi resolves via NWS CLI** (Daily Climatological Report) — uses specific NWS stations per city
- **Polymarket resolves via Weather Underground** — uses specific airport stations per city
- **Station IDs differ per platform**: NYC: Kalshi=KNYC (Central Park), Polymarket=KLGA (LaGuardia) — 2-6°F difference! Chicago: Kalshi=KMDW, Polymarket=KORD.
- Using the wrong resolution source is as bad as using the wrong weather model. ALWAYS resolve using the platform's actual resolution source.
- NWS observations API: `api.weather.gov/stations/{id}/observations?start=...&end=...` — free, no key, returns Celsius, needs User-Agent header
- NWS returns Celsius — must convert: `highF = Math.round(value * 9/5 + 32)` — round to integer to match NWS CLI format
- UTC time window must account for timezone: NYC midnight = 05:00Z (EST), not 00:00Z
- KNYC (Central Park) provides hourly obs; airport stations (KMDW, KSEA, etc.) provide 5-min ASOS data (~312 obs/day)
- Skip observations where `qualityControl === 'X'` (failed QC checks)
- `getKalshiResolutionHigh()` falls back to Open-Meteo if NWS API fails — imperfect resolution > no resolution

## Kalshi Market Timing
- Markets created ~10:30 UTC, tradeable at 15:00 UTC (10 AM ET)
- Only for next day — no 2+ day lookahead like Polymarket
- Past trade analysis: entered 0.2-8.8 hours before target dates
- If no Kalshi markets found before 15:00 UTC, it's normal — wait for market open

## Server Management Bot
- VPS management Telegram bot at `/home/deployer/server-tools/server-bot.js` (Telegraf framework)
- Separate `.env` at `/home/deployer/server-tools/.env` — different Telegram bot token, same Supabase creds
- `KNOWN_KALSHI_TICKERS` hardcoded in server-bot — must be manually synced with `WEATHER_SERIES` in `kalshi-api.js`
- Kalshi series discovery uses public API (`/series?limit=500`) — no auth needed
- Filter new series by `KXHIGH*` prefix with exclude patterns (`INFLATION`, `MOV`, `INX`, `US`, `NFL`, `MODEL`, `MAXTEMP`, `DV`) — Kalshi returns non-weather series too

## Test Scripts from /tmp/
- Scripts in `/tmp/` need `require('dotenv').config({ path: '/home/deployer/polymarket-whale-tracker/.env' })` — plain `require('dotenv').config()` looks in `/tmp/` for `.env`
- Also need `NODE_PATH=/home/deployer/polymarket-whale-tracker/node_modules` when running with `node`

---

*Add new lessons as discovered from paper trading and live trading.*
