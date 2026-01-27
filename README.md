# Polymarket Whale Tracker

Track whale wallets on Polymarket and get real-time Telegram alerts when they make significant trades.

## Features

- **Wallet Tracking** - Monitor multiple Polymarket wallet addresses with auto-polling every 30s
- **Trade Detection** - Fetches trades from the Polymarket Data API, deduplicates, and stores to Supabase
- **Telegram Alerts** - Whale alert notifications for trades above a configurable threshold ($100 default), rate-limited to 1 per 10s
- **Web Dashboard** - Dark-themed React UI with live activity feed, wallet management, stats, and discovery
- **Wallet Discovery** - Curated list of 8 known whale wallets with one-click tracking
- **Wallet Analytics** - Per-wallet stats: trade count, volume, buy/sell breakdown, hourly activity, top markets
- **Auto-Cleanup** - Daily job deletes trades older than 7 days to stay within Supabase free tier (500MB)
- **Production Ready** - Structured JSON logging, graceful shutdown, exponential backoff, Render Blueprint

## Tech Stack

- **Backend**: Node.js 18+ / Express (single `server.js`, no build step)
- **Database**: PostgreSQL on Supabase (free tier)
- **Frontend**: React 18 + Tailwind CSS via CDN (single `public/index.html`)
- **Alerts**: Telegram Bot API
- **Hosting**: Render.com (free tier web service)
- **APIs**: Polymarket Data API + Gamma API (no auth required)

## Quick Start

```bash
git clone https://github.com/steveoduro/polymarket-whale-tracker.git
cd polymarket-whale-tracker
npm install
cp .env.example .env
# Edit .env with your Supabase + Telegram credentials
npm start
# Open http://localhost:3000
```

## Setup

1. **Supabase**: Create a project at [supabase.com](https://supabase.com), then run `schema.sql` in the SQL Editor
2. **Telegram Bot**: Message [@BotFather](https://t.me/BotFather) to create a bot and get the token. Send a message to your bot, then get your chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. **Environment**: Copy `.env.example` to `.env` and fill in the values
4. **Run**: `npm start` (production) or `npm run dev` (auto-reload)

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SUPABASE_URL` | Supabase project URL | required |
| `SUPABASE_ANON_KEY` | Supabase anon/public key | required |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | optional |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for alerts | optional |
| `POLL_INTERVAL_MS` | How often to poll for new trades (ms) | `30000` |
| `ALERT_MIN_SIZE` | Minimum trade size in USD to trigger alert | `100` |
| `TRADE_RETENTION_DAYS` | Days to keep trades before cleanup | `7` |
| `NODE_ENV` | Environment (`development` or `production`) | `development` |
| `PORT` | Server port | `3000` |

## API Endpoints

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Simple health check (for Render uptime monitoring) |
| GET | `/api/health` | Detailed health with polling status, error count, wallet count |

### Wallets
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/wallets` | List all tracked wallets |
| POST | `/api/wallets/add` | Add a wallet (auto-fills username from Gamma API) |
| PATCH | `/api/wallets/:id` | Update wallet (nickname, notes, is_active) |
| DELETE | `/api/wallets/:id` | Remove a wallet |
| GET | `/api/wallets/:id/stats` | Wallet analytics (volume, buy/sell, top markets, hourly activity) |

### Trades
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trades` | Recent trades (query: `wallet_id`, `limit`) |

### Discovery
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/discover/top-traders` | Curated whale list with tracking status |

### Alerts
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/alerts/test` | Send a test alert to Telegram |
| GET | `/api/alerts/history` | Alert log with trade details |
| GET | `/api/alerts` | Same as history (legacy) |

### Polling Control
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/polling/start` | Start the trade poller |
| POST | `/api/polling/stop` | Stop the trade poller |

### Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings/:key` | Get an app setting |
| PUT | `/api/settings/:key` | Update an app setting |

## Dashboard

Open `http://localhost:3000` to access the dashboard with four tabs:

- **Live Activity** - Auto-refreshing trade feed with wallet/size filters, color-coded BUY/SELL, Polymarket links
- **Wallets** - Add/remove wallets, toggle active/paused, view stats modal with hourly activity charts
- **Discover** - Browse curated whale wallets, filter by category (crypto, politics, sports), one-click track
- **Alerts** - Send test alerts, view alert history with delivery status

## Deploy to Render

1. Push to GitHub
2. Go to [render.com](https://render.com) > New > **Blueprint**
3. Connect your GitHub repo (Render auto-detects `render.yaml`)
4. Set the secret environment variables in the Render dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Deploy - polling starts automatically on boot and catches up on missed trades

## Architecture

```
Polymarket Data API ──poll every 30s──> server.js ──upsert──> Supabase (trades)
                                           │
                                           ├──> Telegram Bot API (alerts for trades >= $100)
                                           │
                                           └──> public/index.html (React dashboard)
```

- **Polling**: Sequential per-wallet to respect rate limits, exponential backoff on failure (1s → 5min cap)
- **Dedup**: Composite key `transactionHash-conditionId-outcomeIndex` (one tx can have multiple fills)
- **Alerts**: Rate-limited to 1 message per 10 seconds, queued in memory
- **Cleanup**: Daily job deletes trades/alerts older than 7 days

## Known Whales (Curated)

| Username | Category | Notes |
|----------|----------|-------|
| distinct-baguette | crypto | High-frequency 15-min crypto arbitrage |
| Theo4 | politics, crypto | Largest trader, $60M+ portfolio |
| SilverRocket | politics | $15M+ profit on 2024 elections |
| kch123 | sports | $8.5M+ profit, market maker |
| PrincessCaro | politics, crypto | Large concentrated positions |
| LainInTheWired | crypto | BTC/ETH predictions |
| JackSparrow | politics, crypto | Large volume across categories |
| Dbrody | politics | Election market specialist |

## License

MIT
