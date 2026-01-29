# Copy Trading Bot Setup Guide

## Quick Start

### 1. Run the Database Migration

Go to your Supabase SQL Editor and run the contents of `schema-phase2.sql`.

This creates:
- `my_trades` - Tracks your copy trades
- `daily_stats` - Daily P&L tracking
- Views for easy querying

### 2. Install Dependencies on VPS

```bash
# SSH into your VPS
ssh user@46.62.170.247

# Navigate to project
cd /path/to/polymarket-whale-tracker

# Pull latest code
git pull

# Install new dependencies
npm install
```

### 3. Configure Environment Variables

Add these to your `.env` file on the VPS:

```bash
# Required for paper trading
SUPABASE_URL=https://fypjlmcykuqcxqzamaqn.supabase.co
SUPABASE_ANON_KEY=your-key

# Required for live trading (get from MetaMask)
WALLET_ADDRESS=0x...your-polymarket-wallet
WALLET_PRIVATE_KEY=your-private-key

# Trading settings (adjust as needed)
COPY_TRADE_SIZE=1.50
MIN_WHALE_SIZE=10
MAX_POSITION_PER_MARKET=5
MIN_BALANCE_TO_TRADE=10
DAILY_LOSS_LIMIT=15
```

### 4. Test Configuration

```bash
# Check all settings
node run-copier.js --check

# Test API connection (requires WALLET_PRIVATE_KEY)
node run-copier.js --test-api
```

### 5. Run in Paper Mode

```bash
# Paper trading - logs what WOULD happen, no real trades
node run-copier.js

# Or use npm script
npm run copier
```

### 6. Run in Live Mode (when ready)

```bash
# LIVE TRADING - uses real money!
node run-copier.js --live

# Or use npm script
npm run copier:live
```

---

## How It Works

1. **Trade Detection**: The copier polls your Supabase database for new trades from `distinct-baguette`

2. **Market Filter**: Only copies trades on 15-minute crypto markets:
   - Bitcoin Up or Down
   - Ethereum Up or Down
   - Solana Up or Down
   - XRP Up or Down

3. **Risk Checks**: Before each copy:
   - Whale trade >= $10? (MIN_WHALE_SIZE)
   - Your balance >= $10? (MIN_BALANCE_TO_TRADE)
   - Market exposure < $5? (MAX_POSITION_PER_MARKET)
   - Daily loss < $15? (DAILY_LOSS_LIMIT)

4. **Execute Trade**: Places a $1.50 order copying the whale's position

---

## Commands

| Command | Description |
|---------|-------------|
| `node run-copier.js` | Run in paper trading mode |
| `node run-copier.js --live` | Run in live trading mode |
| `node run-copier.js --check` | Check configuration |
| `node run-copier.js --status` | Show current stats |
| `node run-copier.js --test-api` | Test Polymarket API |

---

## Getting Your Private Key from MetaMask

1. Open MetaMask
2. Click the three dots menu
3. Account Details
4. Export Private Key
5. Enter password
6. Copy the key (starts with `0x` or is 64 hex chars)

**SECURITY**: Never share your private key. Never commit it to git.

---

## Running as a Service (systemd)

Create `/etc/systemd/system/polymarket-copier.service`:

```ini
[Unit]
Description=Polymarket Copy Trading Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/polymarket-whale-tracker
ExecStart=/usr/bin/node run-copier.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable polymarket-copier
sudo systemctl start polymarket-copier
sudo journalctl -u polymarket-copier -f  # View logs
```

---

## Files Created

```
polymarket-whale-tracker/
├── lib/
│   ├── polymarket-api.js   # CLOB API wrapper
│   ├── trade-copier.js     # Copy trading logic
│   └── risk-manager.js     # Risk checks
├── run-copier.js           # CLI runner
├── schema-phase2.sql       # Database migration
├── SETUP-COPIER.md         # This file
└── .env.example            # Updated with new vars
```

---

## Monitoring

Check status anytime:
```bash
node run-copier.js --status
```

View logs in Supabase:
- `my_trades` table shows all copy attempts
- `daily_stats` table shows daily P&L

Telegram alerts will notify you of:
- Bot startup/shutdown
- Trade copies (if configured)
