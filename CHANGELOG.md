# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0] - 2026-02-04

### Added
- Analytics metrics for trade quality tracking
  - Entry metrics: bid/ask/spread/liquidity/forecast/edge/kelly_fraction/entry_hour_utc
  - Close metrics: closing_price, forecast_temp_at_close, forecast_confidence_at_close
  - New `market_snapshots` table for hourly price history (retained indefinitely)
- Detailed opportunity logging showing edgePct, mispricingPct, trueProbability for debugging

### Fixed
- Cross-platform deduplication: now uses city+date instead of slug to prevent contradictory positions on same city/date across Polymarket and Kalshi
- Cross-cycle deduplication: pre-populates executedMarkets set with existing open positions at cycle start (one efficient query)
- Edge filter now uses trade-level `edgePct` instead of market-level `mispricingPct`
- Minimum edge threshold enforced at 3% before trade execution
- Opportunity saving now works (fixed invalid onConflict constraint)
- Telegram alerts now show both "Market mispricing" and "Trade edge" for transparency

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
