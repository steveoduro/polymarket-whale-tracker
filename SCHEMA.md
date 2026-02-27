# Database Schema Reference

PostgreSQL (self-hosted, localhost:5432). All timestamps UTC.

Three-layer architecture:
1. **Base tables** — append-only, single responsibility (opportunities, trades, market_resolutions)
2. **Lookup tables** — rebuilt by resolver each cycle (model_calibration, market_calibration, city_error_distribution)
3. **Materialized views** — pre-joined, refreshed after each resolution cycle (market_outcomes_mv, features_ml_mv, performance_mv)

---

## trades

Primary trade ledger. One row per executed trade (edge or guaranteed-win).

### INSERT (edge trades — executor.js:250)
```
opportunity_id, city, target_date, platform, market_id, token_id,
range_name, range_min, range_max, range_type, range_unit,
side, entry_ask, entry_bid, entry_spread, entry_volume,
shares, cost, entry_edge_pct, entry_probability, entry_kelly,
entry_forecast_temp, entry_forecast_confidence, entry_ensemble,
entry_reason,
pct_of_volume, hours_to_resolution, entry_bid_depth, entry_ask_depth,
status, current_probability, current_bid, current_ask,
max_price_seen, min_probability_seen, evaluator_log
```

### INSERT (guaranteed-win trades — executor.js:463)
```
city, target_date, platform, market_id, token_id,
range_name, range_min, range_max, range_type, range_unit,
side, entry_ask, entry_bid, entry_spread, entry_volume,
shares, cost, entry_edge_pct, entry_probability, entry_kelly,
entry_forecast_temp, entry_forecast_confidence, entry_ensemble,
entry_reason, observation_high, wu_high, dual_confirmed,
pct_of_volume, status, current_probability, current_bid, current_ask,
max_price_seen, min_probability_seen, evaluator_log
```

### UPDATE (monitor — monitor.js:324, dynamic SET)
```
current_probability, current_bid, current_ask,
max_price_seen,        -- only if new high
min_probability_seen,  -- only if new low
evaluator_log          -- JSON array, last 500 entries
```

### UPDATE (resolver — resolver.js:241, on resolution)
```
status = 'resolved', actual_temp, won, pnl, fees,
resolved_at, resolution_station, observation_high, wu_high
```

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `entry_ask` | numeric | NOT `ask` — price at entry |
| `entry_probability` | numeric | 0-1 scale, corrected if available |
| `cost` | numeric | Total $ spent (shares * entry_ask) |
| `shares` | numeric | Number of shares purchased |
| `won` | boolean | NULL until resolved |
| `pnl` | numeric | revenue - cost - fees (actual profit) |
| `fees` | numeric | Platform fees paid |
| `status` | text | 'open' → 'resolved' (or 'exited') |
| `entry_reason` | text | 'edge' or 'guaranteed_win' |
| `entry_ensemble` | jsonb | Source breakdown at entry time |
| `entry_forecast_temp` | numeric | Ensemble forecast in city's unit (°F/°C) |
| `evaluator_log` | jsonb | Array of monitor evaluation snapshots |
| `range_type` | text | 'bounded' or 'unbounded' (see note below) |
| `range_unit` | text | 'F' or 'C' |
| `platform` | text | 'polymarket' or 'kalshi' |

> **range_type note**: DB stores `'bounded'` and `'unbounded'` (no `_upper`/`_lower` suffix).
> The JS code uses `'unbounded_upper'`/`'unbounded_lower'` internally during evaluation,
> but the platform adapter normalizes to just `'unbounded'` before storage. When querying,
> use `range_type = 'bounded'` or `range_type = 'unbounded'`.

---

## opportunities

Every range evaluated each scan cycle. One row per range/side/cycle.

### INSERT (scanner.js:664)
```
city, target_date, platform, market_id, range_name, range_min, range_max,
range_type, range_unit, side, bid, ask, spread, volume,
forecast_temp, forecast_confidence, forecast_sources,
ensemble_temp, ensemble_std_dev, our_probability, edge_pct,
expected_value, kelly_fraction, action, filter_reason,
hours_to_resolution, range_width,
bid_depth, ask_depth,
cal_empirical_win_rate, cal_n, cal_true_edge, cal_bucket,
corrected_probability, correction_ratio,
forecast_to_near_edge, forecast_to_far_edge, forecast_in_range,
source_disagreement_deg, market_implied_divergence
```

### Backfill columns (set by resolver, not at INSERT)
```
actual_temp, winning_range, would_have_won, resolved_at, trade_id, model_valid
```

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `our_probability` | numeric | Raw model probability (0-1) |
| `corrected_probability` | numeric | After calibration correction (NULL if no correction) |
| `edge_pct` | numeric | (probability - ask) * 100 |
| `ensemble_temp` | numeric | Weighted ensemble forecast temp (city's unit) |
| `ensemble_std_dev` | numeric | Std dev used for probability calc (city's unit) |
| `forecast_temp` | numeric | Same as ensemble_temp for Polymarket; kalshiTemp for Kalshi |
| `action` | text | 'entered', 'filtered', 'executor_blocked', 'summary', 'ghost_deleted' |
| `filter_reason` | text | NULL if passed; semicolon-separated reason codes if filtered |
| `kelly_fraction` | numeric | Half-Kelly sizing fraction |
| `trade_id` | uuid | Set after executor creates trade (UPDATE) |
| `would_have_won` | boolean | Backfilled by resolver after resolution (NULL until then) |
| `actual_temp` | numeric | Backfilled — actual observed high for resolution |
| `winning_range` | text | Backfilled — which range name won |
| `model_valid` | boolean | NULL or true; used to exclude invalidated model data |
| `cal_*` | various | Calibration bucket data (empirical win rate, n, true edge) |
| `correction_ratio` | numeric | From model_calibration table (actual_win_rate / avg_model_prob) |
| `bid_depth` / `ask_depth` | jsonb | Order book depth snapshot |
| `range_type` | text | 'bounded' or 'unbounded' (same as trades — no suffix in DB) |
| `forecast_to_near_edge` | numeric | Signed distance from ensemble_temp to closer range boundary. Negative = inside range. NULL for historical data before this column was added. |
| `forecast_to_far_edge` | numeric | Signed distance to farther boundary. NULL for unbounded ranges. |
| `forecast_in_range` | boolean | True if ensemble_temp within [range_min, range_max]. |
| `source_disagreement_deg` | numeric | Std dev across individual forecast source temps. NULL if <2 sources. |
| `market_implied_divergence` | numeric | ensemble_temp - market_implied_mean. Sparse in historical data (market_implied only loaded for 3 recent days). |

### Dropped columns (removed Feb 27, 2026)
The following columns were removed as dead/derivable:
- `would_pass_at_5pct`, `would_pass_at_8pct`, `would_pass_at_10pct`, `would_pass_at_15pct` — derivable as `edge_pct >= X`
- `old_filter_would_block`, `old_filter_reasons` — retired v1 filter comparison
- `summary_count`, `min_edge_pct`, `max_edge_pct` — retired summary-row pattern

### action values (verified from DB)
| Value | Count | Meaning |
|-------|-------|---------|
| `filtered` | ~285k | Failed one or more filters |
| `entered` | ~29k | Passed all filters, sent to executor |
| `executor_blocked` | ~17k | Passed filters but executor rejected (bankroll, dup, volume) |
| `summary` | ~2k | Aggregate summary rows |
| `ghost_deleted` | 1 | Deleted ghost market cleanup |

### Common filter_reason values
```
low_edge, high_spread, spread_pct, ghost_market, no_ask_floor, no_ask_cap,
max_model_market_ratio, min_hours, city_mae_gate, observation_boundary,
market_divergence, platform_trading_disabled, kalshi_city_blocked,
calBlocksEdge, high_std_range_ratio
```

---

## market_resolutions (NEW)

Resolution facts for each resolved market. One row per unique market_id. Written by resolver at trade resolution time and during opportunity backfill. This is the single source of truth for resolution data — the backfill columns on `opportunities` are kept for backward compatibility with calibration rebuilds.

### INSERT (resolver.js — _resolveTrades + _backfillOpportunities)
```
market_id, city, target_date, platform, range_name, range_min, range_max,
range_type, range_unit, actual_temp, winning_range, resolved_at, resolution_station
```
Conflict key: `UNIQUE (market_id)` — ON CONFLICT DO NOTHING (dedup).

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `market_id` | text | Unique market identifier from platform |
| `actual_temp` | numeric | Observed high temperature (in range_unit) |
| `winning_range` | text | Range name that won, or NULL if no range won |
| `resolved_at` | timestamptz | When resolution was determined |
| `resolution_station` | text | Station/source used for resolution (NULL for backfilled) |

### Indexes
- `UNIQUE (market_id)` — primary dedup key
- `(city, target_date)` — city/date lookups
- `(platform, target_date)` — platform filtering

---

## model_calibration

Correction ratios by range_type x model probability bucket. Rebuilt on each resolution cycle (TRUNCATE + INSERT). Used by scanner `_getModelCalibration()` to adjust raw model probability.

### INSERT (resolver.js:627)
```
range_type, model_prob_bucket, n, avg_model_prob, actual_win_rate, correction_ratio
```
Source: aggregated from `opportunities` WHERE `side='YES'`, `would_have_won IS NOT NULL`, `hours_to_resolution BETWEEN 8 AND 60`, last 60 days.

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `range_type` | text | 'bounded' or 'unbounded' |
| `model_prob_bucket` | text | '0-5%', '5-10%', ... '70-75%', '75%+' (16 buckets, 5pp each) |
| `n` | integer | Unique markets in bucket (must be >= 30 for scanner to use) |
| `avg_model_prob` | numeric | Average raw model probability in bucket |
| `actual_win_rate` | numeric | Empirical win rate (0-1) |
| `correction_ratio` | numeric | actual_win_rate / avg_model_prob — multiply raw prob by this |

### Usage in scanner (scanner.js:1271)
```
Lookup key: "{range_type}|{model_prob_bucket}"
If n >= 30: corrected_probability = raw_probability * correction_ratio
If n < 30: correction_ratio defaults to 1.0 (no correction)
```

---

## v2_forecast_accuracy

Per-source and ensemble accuracy records. Written at resolution time.

### INSERT (resolver.js:788)
```
city, target_date, source, confidence, forecast_temp, actual_temp,
error, abs_error, unit, hours_before_resolution
```

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `source` | text | 'openmeteo', 'nws', 'weatherapi', 'ecmwf', 'ensemble_corrected', etc. |
| `error` | numeric | forecast - actual (signed, in city's unit) |
| `abs_error` | numeric | \|error\| (always positive) |
| `unit` | text | 'F' or 'C' |
| `city` | text | Lowercase city key |
| `confidence` | text | 'very-high', 'high', 'medium', 'low' |
| `hours_before_resolution` | numeric | Lead time when forecast was made |

---

## city_error_distribution

Per-city error percentiles for probability distribution calibration. Rebuilt on each resolution cycle (TRUNCATE + INSERT).

### INSERT (resolver.js:688)
```
city, unit, n, mean_error, stddev_error,
p5, p10, p15, p20, p25, p30, p35, p40, p45, p50,
p55, p60, p65, p70, p75, p80, p85, p90, p95,
is_active
```

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `stddev_error` | numeric | NOT mae — standard deviation of signed errors |
| `p5` through `p95` | numeric | Error percentiles (signed, in city's unit) |
| `mean_error` | numeric | Average signed error (= bias) |
| `is_active` | boolean | Whether city has enough data for active distribution |
| `n` | integer | Number of ensemble_corrected records used |

---

## cli_audit

NWS CLI (Climatological Report Daily) vs NWS hourly obs comparison. For Kalshi resolution verification — CLI is the authoritative source.

### INSERT (resolver.js:1231)
```
city, station, target_date, cli_high_f, nws_obs_high_f, diff_f, cli_raw
```
Conflict key: `(city, target_date)`

---

## metar_observations

METAR + Weather Underground observation data, polled every 10 min during active hours.

### INSERT (metar-observer.js:269)
```
city, station_id, target_date, observed_at, temp_c, temp_f,
running_high_c, running_high_f, observation_count
```
Conflict key: `(city, target_date, observed_at)`

---

## snapshots

Hourly market state snapshots for all city/date/platform combos.

### INSERT (scanner.js:1011)
```
city, target_date, platform, ranges, forecast_temp,
forecast_confidence, forecast_sources, depth_data
```

---

## ensemble_spread

ECMWF 51-member ensemble spread data. One row per city/date (upsert).

### INSERT (forecast-engine.js:159)
```
city, target_date, ensemble_std_c, ensemble_mean_c, member_count,
member_min_c, member_max_c, deterministic_c, hours_to_resolution
```
Conflict key: `(city, target_date)`

---

## market_implied

Market-implied temperature from mid-price reconstruction.

### INSERT (scanner.js:1101)
```
city, target_date, platform, implied_mean, implied_median, implied_std_dev,
ensemble_temp, ensemble_std_dev, mean_divergence, sum_implied_probs,
num_ranges, avg_spread, range_data
```

| Column | Type | Notes |
|--------|------|-------|
| `implied_mean` | numeric | Probability-weighted implied temperature |
| `mean_divergence` | numeric | ensemble_temp - implied_mean (model vs market) |
| `range_data` | jsonb | Per-range mid-prices used for reconstruction |

---

## wu_audit

WU vs METAR high comparison, logged at resolution.

### INSERT (resolver.js:409)
```
city, target_date, station_id, wu_high_f, wu_high_c,
metar_high_f, metar_high_c, match, diff_f
```
Conflict key: `(city, station_id, target_date)`

---

## mv_refresh_log

Tracks materialized view refresh performance. Written by resolver after each REFRESH CONCURRENTLY.

| Column | Type | Notes |
|--------|------|-------|
| `view_name` | text | 'market_outcomes_mv', 'features_ml_mv', or 'performance_mv' |
| `started_at` | timestamptz | When refresh started |
| `finished_at` | timestamptz | When refresh completed |
| `duration_ms` | numeric | Refresh duration in milliseconds |
| `row_count` | bigint | Row count after refresh |
| `success` | boolean | Whether refresh succeeded |
| `error_message` | text | Error details on failure |

---

## Materialized Views

All mviews are refreshed CONCURRENTLY after each resolution cycle (resolver.js `_refreshMaterializedViews`). Each has a unique index to support concurrent refresh.

### market_outcomes_mv

One row per unique resolved market (DISTINCT ON market_id). The deduplication layer that joins opportunities with market_resolutions. Picks the most recent scan for each market (latest created_at).

- Source: `opportunities` LEFT JOIN `market_resolutions`
- Filter: `action IN ('entered', 'filtered') AND side IN ('YES', 'NO')`
- `would_have_won` is computed from market_resolutions.actual_temp + range bounds
- Unique index: `(market_id)`

### features_ml_mv

ML training dataset. One row per resolved YES market with all features assembled. Read by `ml_win_predictor.py`.

- Source: `market_outcomes_mv` LEFT JOIN `ensemble_spread`
- Filter: `would_have_won IS NOT NULL AND side = 'YES' AND our_probability IS NOT NULL`
- Includes: all scanner features + month + day_of_week + ECMWF member spread
- Unique index: `(market_id)`

### performance_mv

P&L and win rate summary by key dimensions. For system health dashboards.

- Source: `trades WHERE status = 'resolved'`
- Grouped by: city, platform, range_type, side, entry_reason, price_tier, lead_time
- Unique index: `(city, platform, range_type, side, entry_reason, price_tier, lead_time)`

---

## Quick Reference: Common Query Patterns

```sql
-- P&L summary (from mview)
SELECT city, platform, side, entry_reason, SUM(n) as n, SUM(wins) as wins,
  ROUND(SUM(wins)::numeric / NULLIF(SUM(n), 0) * 100, 1) as win_pct,
  SUM(total_pnl) as total_pnl
FROM performance_mv
GROUP BY city, platform, side, entry_reason ORDER BY total_pnl DESC;

-- ML feature dataset
SELECT COUNT(*), AVG(ask::float), AVG(hours_to_resolution::float)
FROM features_ml_mv;

-- Mview refresh health
SELECT view_name,
  COUNT(*) as refreshes,
  ROUND(AVG(duration_ms)::numeric, 0) as avg_ms,
  MAX(started_at) as last_refresh
FROM mv_refresh_log WHERE success = true
GROUP BY view_name ORDER BY view_name;

-- P&L summary (from trades directly)
SELECT platform, side, COUNT(*) as n,
  SUM(CASE WHEN won THEN 1 ELSE 0 END) as wins,
  ROUND(AVG(CASE WHEN won THEN 1.0 ELSE 0.0 END) * 100, 1) as win_pct,
  ROUND(SUM(pnl)::numeric, 2) as total_pnl
FROM trades WHERE status = 'resolved'
GROUP BY platform, side ORDER BY platform, side;

-- Recent opportunities with edge
SELECT city, target_date, range_name, side, action,
  ROUND(edge_pct::numeric, 1) as edge,
  ROUND(our_probability::numeric, 3) as prob,
  ask, filter_reason
FROM opportunities
WHERE created_at > NOW() - INTERVAL '1 hour'
  AND action = 'entered'
ORDER BY edge_pct DESC NULLS LAST;

-- Forecast accuracy by city (rolling 21-day window)
SELECT city, unit,
  ROUND(AVG(abs_error)::numeric, 2) as mae,
  ROUND(AVG(error)::numeric, 2) as bias,
  COUNT(*) as n
FROM v2_forecast_accuracy
WHERE source = 'ensemble_corrected'
  AND target_date > CURRENT_DATE - INTERVAL '21 days'
GROUP BY city, unit ORDER BY mae DESC;
```
