# Polymarket Weather Bot - Project Instructions

## Project Overview

Weather market trading bot that scans Polymarket and Kalshi for temperature prediction markets, identifies mispriced ranges using multi-source weather forecasts, and executes paper trades using Kelly criterion sizing.

## Key Files

| File | Purpose |
|------|---------|
| `run-weather-bot.js` | Main bot entry point, CONFIG, scan cycle logic |
| `lib/weather-api.js` | Multi-source forecasts (Open-Meteo, NWS, WeatherAPI) |
| `lib/weather-trader.js` | Trade execution, resolution, range matching |
| `lib/mispricing-detector.js` | Edge calculation, Kelly sizing, opportunity detection |
| `lib/polymarket-api.js` | Polymarket CLOB/Gamma API integration |
| `lib/kalshi-api.js` | Kalshi API integration |

## Database (Supabase)

Project ID: `fypjlmcykuqcxqzamaqn`

Key tables:
- `weather_paper_trades` - All trades with P&L
- `weather_opportunities` - Detected opportunities (including filtered)
- `forecast_history` - Historical forecast snapshots
- `forecast_accuracy` - Tracks which weather source is most accurate per city
- `market_snapshots` - Hourly price snapshots

## Architecture Notes

### Scan Cycle Flow
1. Fetch markets from both platforms
2. Get multi-source forecasts (Open-Meteo + NWS for US + WeatherAPI)
3. Detect mispricing opportunities
4. Filter by edge thresholds (3% min, $0.03/share min after fees)
5. Size positions with Kelly criterion
6. Execute paper trades
7. Check for resolutions

### Edge Calculation
```
grossEdge = trueProbability - executionPrice
feeCost = executionPrice × feeRate
netEdge = grossEdge - feeCost
```
- Polymarket fee: 3.15%
- Kalshi fee: 1.2%

### Multi-Source Weather
- Open-Meteo: Primary source, global
- NWS: US cities only, authoritative for Kalshi resolution
- WeatherAPI: Backup/tiebreaker
- Consensus confidence: sources within 1°F = very-high

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

# Or via Telegram
/pull polymarket
/restart weather-bot
/logs weather-bot
```

## Testing Changes

After any code change:
1. Check PM2 logs for errors: `pm2 logs weather-bot --lines 50`
2. Wait for next scan cycle (5 min intervals)
3. Verify in Supabase that opportunities/trades are being logged correctly

## Lessons Reference

See `~/claude-workspace/lessons/trading-bots.md` for accumulated lessons on edge calculations, position management, API quirks, and common bugs.
