# Changelog

All notable changes to this project will be documented in this file.

## [2.1.0] - 2026-02-09

### Fixed
- **edge_at_entry lookup bug**: Re-entry edge comparison was querying `weather_opportunities` table which failed when traded range != recommended range (defaulting to 0%, making comparison useless). Now reads `edge_at_entry` directly from the position record.
- **Re-entries not monitored for exits**: Re-entries in `reentry_trades` were never checked for take-profit or forecast-shift exits — they just held to resolution. Now `getOpenPositions()` fetches from BOTH tables, tags with `_source`, and exit methods update the correct table.
- **Re-entry chains**: Exited re-entries can now be re-entered with three protections:
  1. Only `forecast_shift` exits qualify (take-profit already captured value)
  2. New edge must exceed previous entry's `edge_at_entry`
  3. Cost capped at 2x the ORIGINAL trade cost (chains back via `original_trade_id`)
- `executeReentry()` always links new re-entries to the original `weather_paper_trades` record, not the intermediate re-entry
- `getCurrentPrice()` handles missing `market_slug` on re-entries by looking up from original trade
- Telegram messages now indicate "(re-entry)" when exiting or re-entering re-entry positions

### Migration
```sql
ALTER TABLE reentry_trades
  ADD COLUMN IF NOT EXISTS market_slug TEXT,
  ADD COLUMN IF NOT EXISTS managed_by TEXT;
```

## [2.0.0] - 2026-02-08

### Added
- **Position Manager (Bot B)** — monitors open positions alongside Bot A
  - Tiered take-profit: LONGSHOT (<25¢) → exit at 75¢, MIDRANGE (25-40¢) → 55¢, FAVORITE (40¢+) → 85¢
  - Forecast-shift exits: exit when forecast moves outside traded range (min bid 15¢ threshold)
  - Re-entry system: re-enter forecast-exited positions when edge returns
  - Kelly criterion sizing for re-entries with 2x cost cap
  - New file: `lib/position-manager.js` (core logic)
  - New file: `run-position-manager.js` (entry point, CONFIG, PM2 process)
  - PM2 process: `position-manager` (10-minute scan intervals)
- New tables: `reentry_trades`, `position_manager_logs`
- Separate P&L tracking for Bot A vs Bot B
- Telegram alerts tagged `[Bot A]` / `[Bot B]` for clarity
- Bot A skips re-entry into positions Bot B has exited (checks `status != exited` in dedup)

### Fixed
- **Duplicate re-entries**: Dedup changed from `original_trade_id` to city+date+range query (Seoul had 4x $217.83 duplicates)
- **Take-profit at a loss**: Added profitability guard — skip take-profit if `netExitPerShare <= entryPrice` (Dallas 84¢→85¢ lost $2.92 to fees)
- **Re-entry guardrails**: Added exit-type filter (forecast_shift only), edge comparison vs original, 2x cost cap

## [1.3.0] - 2026-02-04

### Added
- Multi-source weather integration for improved forecast accuracy
  - NWS (National Weather Service) for all US cities - authoritative, free
  - WeatherAPI.com for all cities globally - free tier 1M requests/month
  - Consensus-based confidence: sources agree within 1°F = very-high confidence
  - Accuracy tracking per source to learn which works best per city
  - Dynamic US city detection (new US cities auto-get NWS, no manual mapping)
- Analytics metrics for trade quality tracking
  - Entry metrics: bid/ask/spread/liquidity/forecast/edge/kelly_fraction/entry_hour_utc
  - Close metrics: closing_price, forecast_temp_at_close, forecast_confidence_at_close
  - New `market_snapshots` table for hourly price history (retained indefinitely)
- Detailed opportunity logging showing edgePct, mispricingPct, trueProbability for debugging
- Minimum dollar edge threshold ($0.05/share after fees) to prevent unprofitable trades on cheap ranges
- Filtered opportunity logging: opportunities skipped by edge filters now saved to database with status='filtered' for post-resolution backtesting
  - Tracks filter_reason, net_edge_dollars, edge_at_entry
  - Enables would_have_won analysis after market resolution

### Changed
- Lowered MIN_EDGE_DOLLARS from $0.05 to $0.03 per share (backtest showed $0.05 blocked 92% of trades, need more data to find optimal threshold)

### Fixed
- Cross-platform deduplication: now uses city+date instead of slug to prevent contradictory positions on same city/date across Polymarket and Kalshi
- Cross-cycle deduplication: pre-populates executedMarkets set with existing open positions at cycle start (one efficient query)
- Edge filter now uses trade-level `edgePct` instead of market-level `mispricingPct`
- Minimum edge threshold enforced at 3% before trade execution
- Opportunity saving now works (fixed invalid onConflict constraint)
- Telegram alerts now show both "Market mispricing" and "Trade edge" for transparency
- Overround edge inflation: edge/Kelly now calculated using execution price, not normalized price (was overbetting ~1-5% in overround markets)
- Added logging for empty Kelly positions to debug why valid opportunities skip execution
- Kalshi range parsing: now handles "X° to Y°" format (was only matching Polymarket's "X-Y°F" hyphen format)
- Added resolution logging showing city, date, platform, range, actualTemp, result for verification

### Changed
- Precipitation trading disabled (ENABLE_PRECIPITATION: false) - locks capital for full month with weak forecast signal; existing positions resolve normally

## [1.2.0] - 2026-02-03

### Added
- Kalshi platform integration with multi-platform scanning
- Best-price routing for overlap cities (NYC, Chicago, Miami, Seattle, Dallas, Atlanta)
- Platform fee adjustment in Kelly sizing (Kalshi 1.2% vs Polymarket 3.15%)
- Overround normalization for Kalshi markets

## [1.1.0] - 2026-02-01

### Added
- Weather bot for temperature and precipitation market trading
- Range mispricing strategy with Kelly criterion sizing
- Forecast arbitrage strategy for forecast shift detection
- Paper trading mode with P&L tracking
- Telegram alerts for trades and resolutions

## [1.0.0] - 2026-01-26

### Added
- Initial project setup
- Database schema for tracked_wallets, trades, alerts_log, app_settings
- Express server with CRUD endpoints for wallets
- React frontend with trades and wallets panels
- Environment configuration template
