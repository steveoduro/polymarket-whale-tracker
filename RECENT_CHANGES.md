# Recent Changes Log

Last updated: 2026-02-27 22:35 UTC

## Commits

### (pending) — GW research: same-batch adjacent-NO protection + Kalshi GW verification

**Date:** 2026-02-27

**Changes:**
- **Bug**: YES and adjacent NO could enter in the same batch (Seoul: 12°C NO + 13°C YES entered 9ms apart). DB-based adjacent-NO check only catches previously committed trades.
- **Fix**: Second-pass filter in both `scanGuaranteedWins` and `evaluateGWFastPath` — builds batch YES threshold, blocks NOs where `range_max <= batch YES range_min`. Multiple NOs without a YES in the batch are unaffected.
- **Kalshi GW verified working**: `guaranteedWinEnabled: true` was never changed. 2 Kalshi GW trades exist (Dallas 80-81° open, NYC 30-31° resolved). The 4 previously missed Kalshi detections (Dallas/DC/Denver/NYC at 0.5°F gap) were correctly blocked by gap check — dual-station cities need 1.5°F.

Files: `lib/scanner.js`

---

### 651e3f0 — GW research: fix fast-path parity, duplicate alert dedup

**Date:** 2026-02-27

**Changes:**
- Fast-path entry builder now passes `metar_high`/`wu_high` separately, computes `dual_confirmed` properly, sets `entry_reason` based on result
- Event-driven GW scan gated by 3s fast-poll debounce (was sending duplicate "Executing..." alerts)

Files: `bot.js`, `lib/scanner.js`, `lib/metar-observer.js`

---

### 3e7abdf — GW research: Kalshi resolution must use CLI, not NWS obs
**Date:** 2026-02-27

Files: `lib/resolver.js`, DB backfill

---

### 3bf6fdd — GW research: fix dropped detections, adjacent-NO protection, race dedup, range_type bug
**Date:** 2026-02-27

Files: `bot.js`, `lib/executor.js`, `lib/scanner.js`, `lib/metar-observer.js`, `GW_RESEARCH.md`

---

## Post-Deployment Logs (2026-02-27 22:35 UTC)

```
Bot restarted at 22:31 UTC with same-batch adjacent-NO protection

Cycle #1:
  Scanner: 67 markets, 758 logged, 0 approved
  Monitor: 3 positions (incl Dallas 80-81 GW), 0 exits
  Resolver: 0 resolved, 200 opps backfilled
  Fast poll: running every 15s, WU 10/10 responses

Kalshi GW status:
  guaranteedWinEnabled: true (config)
  Pending events: 10 Kalshi detections today
  Trades: 2 Kalshi GW (1 open, 1 resolved)
  Most detections blocked by gap (0.5°F < 1.5°F for dual-station) or already repriced (ask=1.0)

Empty error log.
```
