# Handoff — Session 2026-02-20

## Session Summary
Completed full migration from Supabase to self-hosted PostgreSQL for both the weather-bot-v2 and the server management bot. Fixed three classes of post-migration bugs (numeric type coercion, JSONB serialization, stale NaN data). Set up secure remote database access via Tailscale for DBeaver and Claude Desktop MCP.

## Current State

### What's Working
- **Self-hosted PostgreSQL**: All 9 rewritten modules running against local PG (`127.0.0.1:5432/weatherbot`)
- **Full scan cycle verified**: 403 opportunities logged, 3 trades entered, 37 snapshots, 22 monitored, 0 errors
- **20 open trades healthy**: All have valid cost/shares (NaN trades from broken first cycle deleted)
- **Server-bot migrated**: `/pnl`, `/report`, `/errors`, `/logs` all working against local PG with v2 status model
- **Remote DB access**: DBeaver via SSH tunnel through Tailscale, Claude Desktop MCP via `@modelcontextprotocol/server-postgres`
- **Tailscale-secured PG**: Listens on localhost + Tailscale IP (100.78.2.17), pg_hba.conf allows 100.64.0.0/10

### What's Partially Done
- **Supabase cleanup**: Supabase still has the data (good as backup), but credentials/config have been removed from code. Old dump at `/tmp/supabase_dump.sql` can be cleaned up.

### What Needs Attention
- **ECMWF/GEM/UKMO shadow enforcement** (from prior session) — only MOS handled
- **Bucket win attribution bug** (from prior session) — calibration data quality issue still open
- **Supabase password rotation** — PG password was visible in session; consider changing if concerned

## Key Decisions Made
1. **Global numeric type parser** — `pg.types.setTypeParser(1700, parseFloat)` in db.js handles all numeric columns instead of per-query casting
2. **Tailscale-only remote access** — No public PG exposure; all remote access through Tailscale VPN (100.64.0.0/10)
3. **Server-bot uses direct PG** — Added `pg` dependency and `DATABASE_URL` to server-tools, queries v2 `trades` table directly
4. **PM2 delete+start for server-bot** — `pm2 restart --update-env` wasn't sufficient for picking up new dependencies; fresh `pm2 delete` + `pm2 start` was needed

## Next Steps
1. **Monitor PG stability** — Watch for connection pool issues, memory usage over next few days
2. **Flip ENSEMBLE_SPREAD.ENABLED** — Target ~Feb 23-26 after baseline data accumulates
3. **Fix bucket win attribution** — Most impactful remaining calibration issue
4. **Add platform-aware WU branching to scanGuaranteedWins**
5. **Clean up `/tmp/supabase_dump.sql`** if no longer needed as backup

## Gotchas & Warnings
- **node-postgres `numeric` returns strings**: Without the type parser, all arithmetic on numeric columns produces NaN (string concatenation). This was the root cause of NaN bankrolls/biases.
- **JSONB columns need explicit JSON.stringify()**: Supabase auto-serialized JS objects; raw pg does not. Affects scanner (4 columns) and executor (3 columns).
- **PM2 doesn't hot-reload**: After ANY code change, must `pm2 restart`. For dependency changes, may need `pm2 delete` + fresh `pm2 start`.
- **Server-bot is NOT in git**: Lives at `/home/deployer/server-tools/`, separate from polymarket repo. Changes there are not version-controlled.
- **v2 status model**: `status='resolved'` + `won` boolean (true/false), NOT `status='won'|'lost'` like v1. Server-bot was fully rewritten for this.

## Files Modified This Session
- **`lib/db.js`** — Added `pg.types.setTypeParser(1700, parseFloat)` for numeric coercion fix
- **`lib/scanner.js`** — Added `JSON.stringify()` for 4 JSONB params (forecast_sources, old_filter_reasons, bid_depth, ask_depth)
- **`lib/executor.js`** — Added `JSON.stringify()` for 3 JSONB params + defensive `Number(t.cost) || 0` in initBankrolls
- **`config.js`** — Removed dead Supabase config section (url, anonKey, serviceRoleKey)
- **`/home/deployer/server-tools/server-bot.js`** — Full rewrite: Supabase→PG, v1→v2 status model, updated bot names
- **`/home/deployer/server-tools/.env`** — Added `DATABASE_URL`
- **`/home/deployer/.pgpass`** — Added Tailscale IP entry for passwordless psql

## Commits
- `533555b` — Migrate from Supabase to self-hosted PostgreSQL (all v2 modules)
- Server-bot changes are outside git (in `/home/deployer/server-tools/`)
