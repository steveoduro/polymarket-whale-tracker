# GW Pipeline Research & Improvement Plan

**Date:** 2026-02-27
**Status:** Research complete, implementation pending

---

## 1. THE CORE PROBLEM: DATA LATENCY

### Detection Price Distribution (last 10 days, 308 detections)

| Price Bucket | Count | % |
|---|---|---|
| Already repriced (>= 99c) | 243 | 79% |
| Mostly repriced (95-99c) | 24 | 8% |
| Partially repriced (90-95c) | 9 | 3% |
| Actionable value (80-90c) | 13 | 4% |
| Good value (50-80c) | 8 | 3% |
| Great value (< 50c) | 11 | 4% |

**79% of boundary crossings are detected AFTER market has fully repriced.**

### METAR Observation Frequency (measured 2026-02-27)

| City | Avg Min Between Obs | Notes |
|---|---|---|
| Chicago | 12.8 | 2 stations (KORD+KMDW), peak hours |
| New Orleans | 18.7 | |
| DC | 20.6 | |
| Houston | 21.6 | |
| Seoul | 29.2 | |
| Ankara | 29.9 | |
| London | 30.1 | |
| Atlanta | 33.8 | |
| Miami | 47.6 | |
| Seattle | 49.6 | |
| Toronto | 53.9 | |
| Dallas | 58.7 | |
| NYC | 59.1 | |
| Boston | 59.1 | |
| LA | 59.3 | |

Most US cities get **one METAR update per hour**. Market makers see data 20-55 minutes before us.

---

## 2. THE SOLUTION: WU PWS (Personal Weather Station) API

### Discovery

The `api.weather.com/v2/pws/observations/current` endpoint returns **real-time observations from nearby personal weather stations** with ~10 second freshness. We already have the API key.

### Live Test Results (2026-02-27 ~19:49 UTC)

| City | METAR (age ~55min) | WU PWS (age ~10s) | Delta | PWS Station |
|---|---|---|---|---|
| Chicago | 57°F | **60°F** | +3°F | KILFRANK74 (2.6mi from KORD) |
| Dallas | 78°F | **84°F** | +6°F | KTXSOUTH104 (6.1mi from KDFW) |
| Miami | 82°F | **86°F** | +4°F | KFLWESTM8 (2.0mi from KMIA) |
| Atlanta | 65°F | 64°F | -1°F | KGAATLAN707 (6.3mi from KATL) |
| NYC | 44°F | 43°F | -1°F | KNYREGOP4 (3.3mi from KLGA) |

Dallas was **6°F ahead** via PWS. That's the difference between buying at 40c vs seeing 99c.

### API Details

**Endpoint:** `https://api.weather.com/v2/pws/observations/current?stationId={ID}&format=json&units=e&apiKey=e1f10a1e78da46f5b10a1e78da96f525`

**Find nearby stations:** `https://api.weather.com/v3/location/near?geocode={lat},{lon}&product=pws&format=json&apiKey={key}`

**Response structure:**
```json
{
  "observations": [{
    "stationID": "KILFRANK74",
    "obsTimeUtc": "2026-02-27T19:49:05Z",
    "epoch": 1772221745,
    "imperial": { "temp": 60 }
  }]
}
```

### Verified Stations Per City

```
NYC (KLGA):     KNYREGOP4 (3.3mi), KNYNEWYO1313 (4.4mi), KNYNEWYO2206 (5.2mi)
Chicago (KORD): KILFRANK74 (2.6mi), KILELMHU35 (4.7mi), KILADDIS10 (5.1mi)
Dallas (KDFW):  KTXSOUTH104 (6.1mi), KTXIRVIN222 (6.6mi), KTXEULES74 (6.6mi)
Atlanta (KATL): KGAATLAN707 (6.3mi), KGAATLAN628 (7.1mi), KGAATLAN919 (8.4mi)
Miami (KMIA):   KFLWESTM8 (2.0mi), KFLMIAMI232 (6.4mi), KFLMIAMI1081 (7.8mi)
```

Need to map stations for: Seoul, Toronto, London, Ankara, Wellington, Buenos Aires, Sao Paulo,
Seattle, Denver, Boston, Philadelphia, Houston, Austin, San Antonio, Minneapolis, Oklahoma City,
New Orleans, DC, San Francisco, Phoenix, Las Vegas, Paris.

### Integration Design

- Poll 3 PWS per city alongside METAR in metarFastPoll
- Track `pws_running_high` per city (same pattern as METAR running_high)
- Use **minimum of 3 stations** as detection signal (filters outlier PWS)
- Require PWS temp >= range_min + **1.5°F gap** (vs current 0.5°F for METAR)
- Wider gap compensates for PWS-to-official-station variance (typically ±2°F)
- METAR still serves as confirmation layer (dual-confirmed = tighter gap allowed)
- Track PWS-to-official bias per station over time for calibration

### Risk Factors

- PWS sensors can be unreliable — mitigated by min-of-3
- PWS temps differ from official by ±2°F — mitigated by wider gap
- PWS stations can go offline — fallback to METAR-only (current behavior)
- Rate limits unknown — test sustained polling at 15s intervals for 25 cities × 3 stations = 75 calls/15s

---

## 3. TRADE PERFORMANCE (baseline)

### Overall GW Stats

| Entry Reason | Mode | Side | Total | Wins | Losses | Avg Ask | Total PnL |
|---|---|---|---|---|---|---|---|
| guaranteed_win_metar_only | paper | NO | 17 | 16 | 1 | 0.783 | +$573.72 |
| guaranteed_win_metar_only | paper | YES | 4 | 2 | 2 | 0.535 | -$70.84 |
| guaranteed_win | paper | NO | 2 | 1 | 1 | 0.435 | -$82.17 |
| **TOTAL** | | | **23** | **19** | **4** | | **+$420.71** |

**82% win rate, +$420 total.** Profitable but tiny volume (23 trades in ~10 days).

### By City

| City | Side | Total | Wins | Losses | PnL | Avg Ask |
|---|---|---|---|---|---|---|
| Toronto | NO | 3 | 3 | 0 | +$59.94 | 0.870 |
| Seoul | NO | 2 | 2 | 0 | +$71.01 | 0.780 |
| London | NO | 2 | 2 | 0 | +$25.85 | 0.750 |
| Chicago | NO | 2 | 1 | 1 | -$40.44 | 0.630 |
| NYC | NO | 2 | 1 | 1 | -$128.91 | 0.545 |
| Ankara | NO | 1 | 1 | 0 | **+$348.48** | 0.340 |
| Seoul | YES | 1 | 1 | 0 | +$41.76 | 0.760 |
| Wellington | YES | 1 | 1 | 0 | +$11.48 | 0.720 |

Ankara's single trade at 34c made $348 — low ask = high profit.

### Detection-to-Trade Timing (successful trades)

| City | Ask at Detection | Entry Ask | Detection→Trade (sec) |
|---|---|---|---|
| Ankara 4°C NO | 0.34 | 0.34 | 1s |
| Seoul 10°C NO | 0.71 | 0.71 | 1s |
| Toronto 0°C NO | 0.88 | 0.88 | 0s |
| Buenos Aires 27°C NO | 0.80 | 0.80 | 2s |
| Miami 76-77°F NO | 0.767 | 0.767 | 7s |
| Dallas 78-79°F NO | 0.92 | 0.92 | 6s |
| London 18°C NO | 0.55 | 0.55 | 1s |
| Seoul 13°C YES | 0.62 | **0.76** | 171s (price moved up!) |
| Chicago 42°F YES | 0.37 | 0.33 | **4908s** (entered much later) |

When we DO catch them, detection→trade is 0-8 seconds. Excellent execution speed.
Seoul YES: ask moved from 62c to 76c in 3 minutes — **price moves FAST after crossing**.

---

## 4. DROPPED DETECTIONS (BUG — needs investigation)

18 detections with ask <= 90c, zero position conflicts, zero range conflicts, and NO trade was made.

### Today's Drops (2026-02-27)

| City | Range | Side | Ask | Existing GW | Range Conflicts |
|---|---|---|---|---|---|
| NYC | 42-43°F | NO | **0.33** | 0 | 0 |
| Ankara | 4°C | NO | **0.57** | 0 | 0 |
| Chicago | 58-59°F | NO | 0.88 | 0 | 0 |

These should have been entered. No conflicts exist. Something in the filter chain is blocking them.

### Previous Days' Drops

| City | Date | Range | Ask | Likely Cause |
|---|---|---|---|---|
| Dallas 79-80° | Feb 26 | Kalshi NO | 0.62 | **Kalshi GW disabled** |
| Dallas 77-78° | Feb 26 | Kalshi NO | 0.90 | **Kalshi GW disabled** |
| NYC 40-41° | Feb 26 | Kalshi NO | 0.89 | **Kalshi GW disabled** |
| Denver 68-69° | Feb 24 | Kalshi NO | 0.84 | **Kalshi GW disabled** |
| Ankara 7°C | Feb 24 | Polymarket NO | 0.16 | **Below MIN_ASK (0.30)** |
| Buenos Aires 28°C | Feb 26 | Polymarket NO | 0.009 | Below MIN_ASK |
| NYC 46-47°F | Feb 26 | Polymarket NO | 0.35 | Had 2 existing GW trades (position dedup?) |
| Chicago 34-35°F | Feb 25 | Polymarket NO | 0.90 | Had 1 existing GW trade |
| Wellington 20°C, 22°C | Feb 25 | Polymarket NO | 0.87/0.89 | Had 2 existing GW trades |
| Chicago 36-37°F | Feb 24 | Polymarket NO | 0.35 | Late night (23:54 UTC) |
| Seattle 44-45°F | Feb 24 | Polymarket NO | 0.82 | Unknown |
| Seoul 3°C | Feb 24 | Polymarket NO | 0.90 | Unknown |
| Seattle 46-47°F | Feb 23 | Polymarket NO | 0.89 | Unknown |

### Root Causes to Investigate

1. **Kalshi GW disabled** — 4 trades lost. `platforms.kalshi.guaranteedWinEnabled === false`
2. **MIN_ASK too high** — Ankara at 0.16 would have been profitable (similar to 0.34 entry = +$348)
3. **Position dedup too broad** — Existing GW trade on same city/date blocks additional NOs on different ranges
4. **Unknown blocks** — NYC 33c, Ankara 57c, Chicago 88c TODAY had zero conflicts but no trade. Need to check:
   - Is `activePendingSet` gate blocking? (scanGuaranteedWins lines 911-915)
   - Did evaluateGWFastPath even fire for these?
   - Is there a filter in _processRangesForCity that's filtering before pending event creation?

---

## 5. CONFIG TUNING RECOMMENDATIONS

| Parameter | Current | Recommended | Reason |
|---|---|---|---|
| `MIN_ASK` | 0.30 | **0.15** | Ankara at 0.16 was a proven winner |
| `MIN_ASK_DUAL_CONFIRMED` | 0.15 | 0.10 | More aggressive when both sources agree |
| `GW_NEAR_THRESHOLD_BUFFER_F` | 1.0 | **2.0** | Start tracking earlier, especially with PWS |
| `GW_NEAR_THRESHOLD_BUFFER_C` | 0.5 | **1.0** | Same for Celsius cities |
| `MAX_BANKROLL_PCT` | 0.20 | **0.30** | 82% win rate deserves more capital |
| `METAR_FAST_POLL_INTERVAL_SECONDS` | 15 | **10** | PWS calls are tiny, can poll faster |
| `GW_PAPER_BANKROLL` | 1000 | **2000** | More capital for more trades |
| `platforms.kalshi.guaranteedWinEnabled` | false | **true** (for GW only) | GW is observation-based, NWS bias irrelevant |

---

## 6. STRUCTURAL CODE IMPROVEMENTS

### a) Multi-NO Entry When Margin is Large

When Dallas is at 84°F, these are ALL guaranteed NOs:
- "78-79°F" range (NO ask maybe 80c)
- "76-77°F" range (NO ask maybe 90c)
- "74-75°F" range (NO ask maybe 95c)

Current code enters one NO per range but position dedup may block some.
Fix: Ensure per-range NO entries are independent (no city-level NO dedup for GW).

### b) Market Price Signal as Detection Proxy

When a YES ask drops 10+c in one cycle, someone else detected the crossing.
Add price-momentum detection: rapid ask decline = secondary GW signal.
Implementation: compare current snapshot ask vs previous cycle's ask in metar_pending_events.

### c) Pre-positioning Near Guaranteed

Enter when:
- Forecast temp >= range_min + 3°F (high confidence of crossing)
- PWS shows temp trending up and within 1°F of boundary
- Ask is still 40-60c (maximum profit)
Risk: higher — temp might not actually cross. Use smaller position size.

### d) Optimize Execution Speed

- Pre-init CLOB client at bot startup (save 100ms on first live order)
- Cache WU responses 30s per city (avoid redundant WU calls across fast-poll cycles)
- Reduce fill polling from 15 to 10 iterations (20s max wait, catches 95% of fills)

---

## 7. ALTERNATIVE DATA SOURCES

| Source | Freshness | Cost | Status |
|---|---|---|---|
| **WU PWS API** | **~10 seconds** | **Free** | **Ready — use existing key** |
| Synoptic HF-ASOS | 5 minutes | $1,875/yr | Need API key signup |
| Open-Meteo Current | 15 minutes | Free | `api.open-meteo.com/v1/forecast?current=temperature_2m` |
| IEM ASOS | 1 hour (real-time) | Free | Already using via aviationweather.gov |
| CheckWX | METAR-based | $5/mo | Same latency as current |

**WU PWS is the clear #1 priority.** Free, 10-second freshness, existing API key. Synoptic HF-ASOS is #2 if we want official station data at 5-min resolution.

---

## 8. IMPLEMENTATION PRIORITY

1. ~~**Debug dropped detections**~~ ✅ DONE (2026-02-27) — Fixed: 30s suppression window → 3s, added newPendingEvents trigger for main_observer detections
2. **Add WU PWS polling** — integrate into metarFastPoll, build pws_running_high, use as primary detection
3. ~~**Re-enable Kalshi GW**~~ ✅ DONE (2026-02-27) — Was already `guaranteedWinEnabled: true`. Verified: 2 Kalshi GW trades in DB (Dallas 80-81° open, NYC 30-31° resolved). Missed detections were correctly blocked by 1.5°F dual-station gap, not config. Same-batch adjacent-NO protection added.
4. **Config tuning** — lower MIN_ASK to 0.15, raise MAX_BANKROLL_PCT to 0.30, widen threshold buffer
5. **Multi-NO entry** — ensure multiple NO ranges can be entered when temp is well above threshold
6. **Market price signal** — detect rapid ask drops as proxy for boundary crossing
7. **Pre-positioning** — enter at high confidence before full confirmation (higher risk tier)

### Expected Impact

| Change | Est. Additional Trades/Day | Est. Daily PnL |
|---|---|---|
| WU PWS primary detection | +8-12 | +$200-400 |
| Re-enable Kalshi GW | +2-3 | +$50-100 |
| Fix dropped detections | +1-2 | +$30-80 |
| Multi-NO entry | +2-4 | +$40-100 |
| Config tuning | +1-2 | +$20-50 |
| **Total** | **+14-23** | **+$340-730** |

Current baseline: ~2 trades/day, ~$42/day PnL.
