# Handoff — Session 2026-02-13

## Session Summary
Fixed the critical platform-station mismatch in the resolver (NYC/Chicago trades were resolving with the wrong weather station), implemented 7 audit fixes from a full codebase correctness audit, and discovered that Polymarket resolves via Weather Underground (not METAR directly). Added WU audit plumbing for post-resolution spot-checking.

## Current State

### Working
- Bot running (weather-bot-v2, PM2), all fixes deployed
- Platform-aware resolution: Kalshi→nwsStation, Polymarket→polymarketStation
- Dual-station std dev bump for NYC/Chicago
- Fee-inclusive share calculation for Kalshi
- Date.UTC() fix for timezone-safe hours-to-resolution
- WU audit URLs logged on every Polymarket resolution
- `scripts/wu-audit.js` ready for manual spot-checking tonight

### Partially Done
- WU audit: need to manually check resolved Polymarket trades against WU History pages after tonight's US city resolutions. This is the first real test of METAR vs WU alignment.
- `resolution_station` field: only populated for trades resolved AFTER commit `c62eba1` — older resolved trades show `null`

### Needs Attention
- **Pre-live: WU scraper** — Polymarket resolves via Weather Underground, not METAR. Our METAR approach is a proxy. If spot-checks show drift, build WU scraper as canonical source. WU pages are JS-rendered (need headless browser).
- **YES bankroll nearly drained** — $115 remaining of $1000. NO bankroll at $545. Consider whether to increase bankroll or wait for resolutions to free capital.

## Key Decisions Made
- Dual-station std dev: chose confidence tier demotion (simple, conservative) over separate per-station forecasts (complex, accurate). Can revisit after collecting data.
- WU audit: manual spot-check first, automated scraper only if drift detected. Avoids premature complexity.
- Fee-inclusive sizing: `shares = dollars / effectiveCost` but `cost` record stays as `shares * ask` (contract cost only) — compatible with resolver P&L which tracks fees separately.
- Range boundaries: both platforms use integer resolution. Polymarket explicitly confirms "whole degrees." Continuity correction (±0.5) is correct.

## Next Steps (Prioritized)
1. **Tonight**: After US cities resolve (~05:00-08:00 UTC), run `node scripts/wu-audit.js` and manually compare 3-5 cities against WU History pages
2. **If WU drift found**: Design WU scraper (headless browser, likely Puppeteer)
3. **Forecast engine platform-awareness** (audit #6 partial): Currently bumping std dev, but longer-term should produce separate forecasts per station for dual-station cities
4. **Consider bankroll increase** or resetting after paper mode validation period

## Gotchas & Warnings
- WU History pages are JavaScript-rendered — WebFetch/curl can't read them. Need Puppeteer or similar for automation.
- `resolution_station` is null for all pre-fix trades. Don't filter on it for historical analysis.
- The `NO_MAX_PER_DATE` was $200 in config but some dates show $600+ exposure — this is because bankroll refreshes from DB each cycle and existing trades from before the cap was implemented aren't retroactively capped.
- Seoul/Wellington resolve earliest (timezone ahead) — good canaries for resolution bugs.

## Files Modified This Session
- `lib/resolver.js` — Platform-aware `_getActualHigh()`, WU URL logging, WU city paths, `_getWUUrl()` helper
- `lib/forecast-engine.js` — Dual-station std dev bump (#6), Date.UTC fix (#13), generalized outlier detection (#9)
- `lib/executor.js` — Fee-inclusive share calculation (#11)
- `lib/scanner.js` — Hours filter cleanup (#10), snapshot platform tagging (#12)
- `bot.js` — SIGTERM flush handler (#21)
- `scripts/wu-audit.js` — New: WU spot-check script
- `tasks/lessons.md` — Added 5 new lesson sections

## Commits
- `c62eba1` — Platform-aware resolution routing
- `3aaa377` — 7 audit fixes (#6, #9, #10, #11, #12, #13, #21)
- `6cb31fb` — WU audit logging + spot-check script
