# Recent Changes Log

Last updated: 2026-02-25 18:12 UTC

## Commits

### f84fab3 — Go live with GW trading on Polymarket ($10 bankroll)
**Date:** 2026-02-25

Live trading for guaranteed-win entries on Polymarket CLOB:
- **CLOB client**: Lazy init with GNOSIS_SAFE signature type (proxy wallet signer ≠ funder)
- **Split bankrolls**: live $10 (real money) + paper $1000 (simulation continues)
- **Fill verification**: Poll 2s × 15 = 30s, cancel if unfilled, no DB record
- **Safety guards**: Live only for polymarket + tokenId required + abort if ask moved up >5¢
- **DB migration**: `execution_mode TEXT DEFAULT 'paper'` + `order_id TEXT` on trades
- **Alerts**: Tagged `— LIVE` with order ID on entry/exit/resolved messages
- **Server-bot /pnl**: Shows separate LIVE and PAPER stats for GW pool
- **Kill switch**: `GW_LIVE_ENABLED: false` + restart = instant paper-only

Files: `config.js`, `lib/platform-adapter.js`, `lib/executor.js`, `lib/alerts.js`, `server-tools/server-bot.js`, `package.json`, `scripts/derive-api-keys.js` (new)

---

### 3f70e6b — Raise GW sizing — $1000 pool at 20% per trade
**Date:** 2026-02-25

---

### eca8a96 — Resolver re-evaluates won on backfill + observer polls both stations
**Date:** 2026-02-25

---

## Post-Deployment Logs (2026-02-25 18:12 UTC)

```
Bankrolls initialized:
  yesBankroll: $1000.00
  noBankroll: $1000.00
  gwLiveBankroll: $10.00
  gwPaperBankroll: $641.49
  openTrades: 2

Cycle #1 complete:
  marketsScanned: 39
  logged: 471
  approved: 0
  filtered: 471

Monitor: 2 open positions evaluated
  - toronto 1°C NO: GUARANTEED WIN (runningHigh 2°C) — deferred to resolver
  - chicago 32-33°F NO: GUARANTEED WIN (runningHigh 34°F) — deferred to resolver

METAR fast poll: every 5s
Observer: WU-leads confirmed for chicago, nyc, toronto, miami
```
