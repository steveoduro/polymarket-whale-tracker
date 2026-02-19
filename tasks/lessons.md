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

## Kelly Criterion (Corrected)
- The simplified Kelly `(p*payout - q) / payout` is WRONG for prediction markets — it ignores purchase price
- Correct formula: `b = (payout - ask) / ask` (net odds), then `kelly = (b*p - q) / b`
- At expensive asks (>50¢), the simplified formula overestimates by 3-5x. At cheap asks (<20¢), the difference is small
- Example: prob=0.80, ask=0.75, payout=0.9685 → old=59.4%, correct=11.4% (5.2x overestimate)
- Always use half-Kelly (`KELLY_FRACTION=0.5`) on top of the correct formula for additional safety

## PnL & Fee Calculations (Corrected Again)
- **Polymarket weather**: ZERO trading fees (the 3.15% only applies to 15-min crypto markets)
- **Kalshi**: Per-contract fee = `0.07 × price × (1-price)`, charged on ENTRY only when held to settlement
  - Early exit (before settlement): fee charged on BOTH entry and exit trades
  - Settlement: no additional fee (free)
  - Max fee: 1.75¢/contract at 50¢ price
- Never assume fee models are the same across platforms — research each platform's actual fee structure
- Win PnL (Kalshi): `revenue - cost - entryFee`; Loss PnL: `-cost - entryFee`
- Win PnL (Polymarket): `revenue - cost`; Loss PnL: `-cost`

## Forecast Std Dev Calibration
- Default std devs were 2-3x too small (1°F day-1 vs empirical 2.5-3.5°F)
- Correct base values (day-1): very-high=2.5°F, high=3.0°F, medium=4.0°F, low=5.0°F
- Time scaling: use `sqrt(daysOut)` not `hours/48` — base values are day-1 accuracy, grows with sqrt for longer leads
- Impact: massively reduces number of trades passing edge threshold — this is correct, bot was overtrading
- After changing std devs, audit existing open trades and invalidate those that wouldn't pass new filters

## Continuity Correction (Integer Temperature Resolution)
- Both platforms resolve to whole-degree integers (NWS CLI for Kalshi, Weather Underground for Polymarket)
- Polymarket explicitly states: "measures temperatures to whole degrees Fahrenheit/Celsius"
- A range "34-35°F" means the integer is 34 or 35 → continuous range [33.5, 35.5]
- Without correction, a 2°F range only covers 1°F in the CDF → ~50% underestimate of probability
- Apply ±0.5 to ALL parsed range boundaries for both platforms
- For Kalshi: "above X" → min=X+0.5, "below X" → max=X-0.5, "between X and Y" → [X-0.5, Y+0.5]
- For Polymarket °C single values (e.g., "6°C"): already had ±0.5 — no change needed
- Resolver outcome checks still work correctly with ±0.5 bounds since actual temps are always integers

## HTTP Reliability
- ALL external HTTP calls need timeouts — one hung request can stall an entire scan cycle (7+ min observed)
- Use `AbortSignal.timeout(15000)` (Node 20+) — cleaner than manual AbortController
- Telegram API gets shorter timeout (10s) since it's non-critical
- Wrap each major cycle step in independent try/catch — scanner crash shouldn't prevent resolver from running

## Caching & Performance
- Kalshi API returns all markets for a series in one call — cache at series level (4-min TTL), not per city/date
- This reduced API calls from ~368/cycle to ~23/cycle, saving ~60s per cycle
- In-memory cache clears on PM2 restart — first cycle after restart is slower, that's expected
- Cursor-based pagination needed for Kalshi (200 per page limit) — without it, markets beyond page 1 are silently dropped

## Bankroll Management
- In-memory bankroll tracking drifts over time as trades resolve/exit and free capital
- Fix: call `initBankrolls()` (queries DB for open trade costs) at the start of every cycle
- Without this, bot progressively deploys less capital as bankroll variable never recovers

## Telegram Alerts
- Never use `parse_mode: 'HTML'` with dynamic content — unescaped `<`, `>`, `&` characters cause silent send failures
- Plain text is more reliable; only use HTML/Markdown parse_mode with fully controlled template strings

## Timezone Consistency
- NEVER use UTC (`new Date().toISOString().split('T')[0]`) to determine "today" for trade operations — always use city-local timezone via `Intl.DateTimeFormat('en-CA', { timeZone: tz })`
- Scanner uses city-local dates (correct). Resolver/backfill must match.
- UTC midnight ≠ local midnight. At 00:06 UTC, Toronto is still 19:06 EST yesterday. Resolving based on UTC date creates an enter → resolve → re-enter loop for trades in western timezones
- Belt-and-suspenders: executor dedup should check both `open` AND `resolved` status to prevent re-entry of just-resolved trades
- For backfill, use the *earliest* local "today" across all timezones as the safe cutoff (most-ahead timezone = most conservative)

## Dual-Station Cities & Forecast Uncertainty
- NYC (KNYC vs KLGA) and Chicago (KMDW vs KORD) have 2-6°F station microclimate gaps
- Forecast engine produces ONE forecast (lat/lon based) but platforms resolve at DIFFERENT stations
- Conservative fix: bump confidence tier down one level for dual-station cities → wider std dev → fewer false-edge trades
- Full fix (future): produce separate forecasts per station using station-specific coordinates

## Position Sizing with Fees
- Kelly formula correctly computes edge including fees, but share count was dividing by `ask` not `effectiveCost`
- For Kalshi at 50¢: fee = 1.75¢, dividing by ask overallocates ~3.5% (7 extra shares per $100)
- Fix: `Math.floor(dollars / effectiveCost)` — cost record stays as `shares * ask` (resolver P&L needs contract cost only)

## Weather Underground as Polymarket's Source of Truth
- Polymarket does NOT resolve from NWS or METAR APIs directly — they use Weather Underground History page
- WU displays integer temperatures (whole degrees F or C)
- **Weather.com v1 JSON API**: `api.weather.com/v1/location/{STATION}:9:{COUNTRY}/observations/historical.json?apiKey=e1f10a1e78da46f5b10a1e78da96f525&units={e|m}&startDate=YYYYMMDD&endDate=YYYYMMDD`
- API key `e1f10a1e78da46f5b10a1e78da96f525` is the well-known public key embedded in WU frontend — no auth needed
- US stations: `max_temp` field in last observation captures sub-hourly peaks (this is what WU displays)
- International stations: `max_temp` is null — must compute max from hourly `temp` readings
- Location format: `{ICAO_STATION}:9:{ISO_COUNTRY_CODE}` (e.g., KORD:9:US, EGLC:9:GB, NZWN:9:NZ)
- WU `max_temp` can differ from METAR computed max by 1°F due to sub-hourly peaks — WU is the correct value for Polymarket resolution
- Rate limit WU API calls (2.5s between requests) — no documented rate limit but be conservative

## Server Timezone Safety
- `_getHoursToResolution` used `new Date(year, month, day)` which interprets parts in SERVER local timezone
- Must use `Date.UTC(year, month, day)` so offset calculation works regardless of server timezone
- Same applies to any `new Date(dateStr + 'T23:00:00')` without 'Z' suffix — server-timezone dependent
- **UTC+13 timezone wrapping bug**: Hour-only offset calculation via `Intl.DateTimeFormat` with just `hour` component wraps UTC+13 to -11. Fix: use full date components (year, month, day, hour, minute, second) to compute offset from a known UTC reference point. The `_getUTCWindowForLocalDate()` helper in resolver.js and metar-observer.js is the canonical implementation.

## Supabase Unbounded Queries
- `_recordAccuracy()` was fetching ALL 28k+ opportunities every 5 minutes — no date filter or limit
- During Supabase platform outage, this hammered the recovering DB
- Fix: scope to `resolved_at >= 2 days ago` with `.limit(500)` — sufficient for accuracy tracking

## Platform-Aware Guaranteed Loss (Feb 18, 2026)
- `running_high = Math.max(METAR, WU)` — can overshoot reality. Safe for guaranteed_win (conservative), **dangerous for guaranteed_loss** (triggers false exits).
- Use `wu_high` (WU-only reading) for guaranteed_loss "exceeded" checks — WU is Polymarket's resolution source; for Kalshi, `min(METAR, WU) = wu_high` means "both agree".
- For "didn't reach" day-over checks, `running_high` (Math.max) is safe — if the max hasn't reached the range, neither source has.
- **Case study**: Miami 86-87°F was exited as guaranteed_loss (METAR obs_high=85°F overshoot) but WU actual=86°F (in range, trade won).
- Always null-guard `wu_high` — WU API can fail while METAR succeeds. Falling through to "undecided" is safer than a wrong guaranteed_loss.

## Monitor Must Mirror Scanner Entry Logic
- Any bypass in scanner (e.g., calConfirmsEdge) needs a corresponding hold logic in monitor. Otherwise monitor's edge_gone will immediately kill trades that scanner entered with calibration-justified edge.
- Pattern: scanner enters at unfavorable raw probability because calibration says the trade wins historically → monitor sees low probability → edge_gone fires → trade killed immediately.
- Fix: monitor loads `market_calibration` table and suppresses edge_gone when `empirical_win_rate > marketBid`.

## Audit Trail Fields at Exit Time
- `won`, `actual_temp`, `observation_high`, `wu_high` must all be populated in EVERY exit path: monitor's `_resolveGuaranteed()`, monitor's `_executeExit()`, and resolver's `_resolveTrades()`.
- Historical backfill via `_backfillExitedTrades()` handles records created before the fix.
- Pre-observer era trades (before Feb 13) will permanently have NULL observation fields — no data exists.

## Column Names (Trades Table)
- Use `entry_ask` not `entry_price`, `range_name` not `range_label`
- Status values: `open`, `exited`, `resolved` (NOT `active`)
- metar_observations: `wu_high_f`/`wu_high_c` stored separately from `running_high_f`/`running_high_c`

## Calibration Data Quality
- **Bucket win attribution inflation**: `would_have_won` is set per-row (per scan cycle) based on whether the range won, not the entry price. A market moving through multiple price/time buckets credits a win to ALL buckets. This inflates cheap-bucket and long-lead-time win rates. Impact: `calConfirmsEdge` becomes too permissive for marginal trades.
- **model_valid field must be in .select() or filtered at DB level**: `row.model_valid === false` with strict equality returns false when field is undefined (not selected). Result: invalid model runs silently included in calibration. Fix: filter at DB level with `.or('model_valid.is.null,model_valid.eq.true')`.
- **Supabase JS client caps at 1000 rows by default**: Analysis scripts using `.select()` without `.limit()` or pagination silently return max 1000 rows. Use `exec_sql` RPC for full counts, or set explicit high limits.

## Shadow Source Management
- **MOS SHADOW_ONLY was dead code**: Config flag existed but was never read by forecast-engine. Active-set initialization (`rankings.map(r => r.source)`) included ALL ranked sources regardless of config flags.
- **MOS missing weight entry caused equal-weight fallback**: MOS with n<WEIGHT_MIN had no weight entry, causing `activeSourceKeys.every(k => cityWeights[k])` to fail → all cities with MOS in their rankings fell back to equal-weight averaging. Removing shadow sources from active set fixes this.
- **fahrenheitToCelsius() vs delta conversion**: For std dev, spread, and other deltas, multiply by 5/9 (C→F: multiply by 9/5). `fahrenheitToCelsius()` is for absolute temperatures ONLY. Getting this wrong over/under-states gates by ~17°.

## Resolver Accuracy Recording
- **Skip bug pattern**: Checking "any accuracy record exists" before recording blocks new record types (e.g., ensemble_corrected) when per-source records already exist. Fix: check each record type independently.

---

*Add new lessons as discovered from paper trading and live trading.*
