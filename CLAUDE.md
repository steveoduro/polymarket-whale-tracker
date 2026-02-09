# Polymarket Weather Bot - Project Instructions

## Project Overview

Weather market trading bot that scans Polymarket and Kalshi for temperature prediction markets, identifies mispriced ranges using multi-source weather forecasts, and executes paper trades using Kelly criterion sizing.

## Key Files

| File | Purpose |
|------|---------|
| `run-weather-bot.js` | Bot A entry point, CONFIG, scan cycle logic |
| `run-position-manager.js` | Bot B entry point, CONFIG, PM2 process |
| `lib/weather-api.js` | Multi-source forecasts (Open-Meteo, NWS, WeatherAPI) |
| `lib/weather-trader.js` | Trade execution, resolution, range matching |
| `lib/position-manager.js` | Bot B: take-profit, forecast exits, re-entries |
| `lib/mispricing-detector.js` | Edge calculation, Kelly sizing, opportunity detection |
| `lib/polymarket-api.js` | Polymarket CLOB/Gamma API integration |
| `lib/kalshi-api.js` | Kalshi API integration (disabled) |

## Database (Supabase)

Project ID: `fypjlmcykuqcxqzamaqn`

Key tables:
- `weather_paper_trades` - All trades with P&L (Bot A creates, Bot B manages exits)
- `reentry_trades` - Bot B re-entry positions (linked to originals via `original_trade_id`)
- `position_manager_logs` - Bot B action logs (monitor, exit, skip, reentry)
- `weather_opportunities` - Detected opportunities (including filtered)
- `forecast_history` - Historical forecast snapshots
- `forecast_accuracy` - Tracks which weather source is most accurate per city
- `market_snapshots` - Hourly price snapshots
- `no_opportunities` - NO trades (betting against ranges far from forecast, status: open/exited/won/lost)

Important columns:
- `weather_paper_trades.managed_by` = 'position_manager' when Bot B exits a trade
- `weather_paper_trades.edge_at_entry` - Edge % stored at trade time (used for re-entry comparison)
- `reentry_trades.original_trade_id` - Always links to the original `weather_paper_trades` record (even for re-entry of re-entries)
- `reentry_trades.market_slug` - Stored for price lookups (falls back to original trade if missing)

## Architecture Notes

### Two-Bot System
- **Bot A (`weather-bot`)**: Scans markets, enters positions, resolves trades. 5-minute cycles.
- **Bot B (`position-manager`)**: Monitors positions, takes profit, forecast exits, re-entries. 10-minute cycles.
- Bot B runs alongside Bot A — does NOT create initial entries (only re-entries)
- When Bot B exits a position, it sets `managed_by = 'position_manager'` and `status = 'exited'`
- Bot A's dedup includes exited positions, preventing re-entry into Bot B exits

### Bot A Scan Cycle
1. Fetch markets from Polymarket (Kalshi disabled)
2. Get multi-source forecasts (Open-Meteo + NWS for US + WeatherAPI)
3. Detect mispricing opportunities
4. Filter by edge thresholds (3% min, $0.03/share min after fees)
5. Size positions with Kelly criterion
6. Execute paper trades
7. Check for resolutions

### Bot B Position Manager Cycle
1. Fetch open positions from BOTH `weather_paper_trades` AND `reentry_trades`
2. Tag each with `_source` for table-aware updates
3. For each position: fetch current price from Gamma API
4. Check take-profit (tiered thresholds based on entry price tier)
5. Check forecast-shift exit (if forecast moves outside range, bid > 15¢)
6. Check re-entry opportunities on recently exited positions
7. Re-entry protections: forecast_shift only, edge must improve, 2x cost cap
8. Re-entries chain back to original trade via `original_trade_id`

### Edge Calculation
```
grossEdge = trueProbability - executionPrice
feeCost = executionPrice × feeRate
netEdge = grossEdge - feeCost
```
- Polymarket fee: 3.15%
- Kalshi fee: 1.2% (disabled)

### Take-Profit Tiers
| Tier | Entry Range | Exit Threshold |
|------|------------|----------------|
| LONGSHOT | < 25¢ | 75¢ |
| MIDRANGE | 25-40¢ | 55¢ |
| FAVORITE | 40¢+ | 85¢ |

Profitability guard: skip take-profit if `netExitPerShare <= entryPrice` (fees can eat thin margins)

### NO Trading (in Bot A's scan cycle)
NO trading bets AGAINST ranges far from forecast. Integrated into `run-weather-bot.js`:
- **Scan**: `scanNoOpportunities(validMarkets)` at end of `runScanCycle()`
- **Monitor**: `monitorNoPositions()` at end of `runScanCycle()`
- **Resolve**: `resolveNoTrades()` inside `runResolutionCycle()`
- Probability: normal distribution with 1.5°C std dev, `normalCDF()` + `calculateRangeProbability()`
- Entry: distance ≥3°C, YES bid ≥18%, edge ≥10%, half Kelly sizing
- Separate $1,000 bankroll (80% max deployed, 20% max position)
- Take-profit: NO price ≥ 95¢
- Forecast exit: distance drops < 2°C with ≥1 day to resolution and NO bid ≥ 70¢
- Table: `no_opportunities` (status: open, exited, won, lost)
- NO price derivation: `NO ask = 1 - YES bid`, `NO bid = 1 - YES ask`

### Multi-Source Weather
- Open-Meteo: Primary source, global
- NWS: US cities only, authoritative for Kalshi resolution
- WeatherAPI: Backup/tiebreaker
- Consensus confidence: sources within 1°F = very-high
- CITY_SOURCE_PRIORITY in weather-api.js controls per-city source ordering

## Common Issues & Solutions

### Range Parsing
- Polymarket: "X-Y°F" (hyphen)
- Kalshi: "X° to Y°" (word "to")
- `tempMatchesRange()` in weather-trader.js handles both

### Cross-Platform Deduplication
- Use `city+date` key, not market slug
- Pre-load existing positions at cycle start

### Overround Markets
- Use execution price (not normalized) for edge calculation
- Total probability > 100% means overround

## Deploy & Restart

Bot runs on Hetzner VPS as `deployer` user:
```bash
# SSH via Tailscale
ssh deployer@100.78.2.17

# PM2 processes
pm2 restart weather-bot       # Bot A
pm2 restart position-manager  # Bot B
pm2 logs weather-bot --lines 50
pm2 logs position-manager --lines 50
```

## Testing Changes

After Bot A changes:
1. `pm2 restart weather-bot && pm2 logs weather-bot --lines 50`
2. Wait for next scan cycle (5 min intervals)
3. Verify in Supabase that opportunities/trades are being logged correctly

After Bot B changes:
1. `pm2 restart position-manager && pm2 logs position-manager --lines 50`
2. Wait for next scan cycle (10 min intervals)
3. Check that positions from BOTH tables are monitored
4. Verify exit updates go to correct table (`_source` tagging)
5. Check re-entry logic with `position_manager_logs` table

### Diagnostic Scripts (in /tmp/)
- `/tmp/full-state.js` - All open positions, today's exits, all re-entries, capital summary
- `/tmp/check-all-reentries.js` - All re-entry trades with details
- `/tmp/check-reentry-logs.js` - Skip reentry logs from latest cycle

## Known Gotchas
- **Re-entry market_slug**: `reentry_trades` may not have `market_slug` (migration dependent). Code falls back to looking up from original trade.
- **Same-day positions**: Forecast exit is skipped for positions resolving today (`daysToResolution < forecastExitMinDays`)
- **Wellington whipsaw pattern**: Forecast-exit at 15¢ then re-enter at 21¢ within same cycle. Min bid threshold (15¢) prevents exit, but exact boundary (bid == 15¢) still passes.
- **Far-out positions (Feb 28)**: No forecast available >16 days out. These just get passively monitored.
- **Kalshi**: Disabled. Bot B can't monitor Kalshi positions (no Gamma API pricing). Any remaining Kalshi positions hold to resolution.

## Lessons Reference

See `~/claude-workspace/lessons/trading-bots.md` for accumulated lessons on edge calculations, position management, API quirks, and common bugs.
