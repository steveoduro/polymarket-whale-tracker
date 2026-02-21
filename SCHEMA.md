# Database Schema Reference

PostgreSQL via Supabase (direct pg connection). All timestamps UTC.

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

### UPDATE (resolver — resolver.js:238, on resolution)
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

### INSERT (scanner.js:609)
```
city, target_date, platform, market_id, range_name, range_min, range_max,
range_type, range_unit, side, bid, ask, spread, volume,
forecast_temp, forecast_confidence, forecast_sources,
ensemble_temp, ensemble_std_dev, our_probability, edge_pct,
expected_value, kelly_fraction, action, filter_reason,
would_pass_at_5pct, would_pass_at_8pct, would_pass_at_10pct, would_pass_at_15pct,
old_filter_would_block, old_filter_reasons, hours_to_resolution, range_width,
bid_depth, ask_depth,
cal_empirical_win_rate, cal_n, cal_true_edge, cal_bucket,
corrected_probability, correction_ratio
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
| `edge_pct` | numeric | (probability - ask) / ask * 100 |
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
| `would_pass_at_*` | boolean | Counterfactual: would this pass at different edge thresholds |
| `cal_*` | various | Calibration bucket data (empirical win rate, n, true edge) |
| `correction_ratio` | numeric | From model_calibration table (actual_win_rate / avg_model_prob) |
| `bid_depth` / `ask_depth` | jsonb | Order book depth snapshot |
| `range_type` | text | 'bounded' or 'unbounded' (same as trades — no suffix in DB) |

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

### Common queries
```sql
-- Per-source MAE
SELECT source, unit, ROUND(AVG(abs_error)::numeric, 2) as mae, COUNT(*) as n
FROM v2_forecast_accuracy GROUP BY source, unit ORDER BY unit, mae;

-- Per-city ensemble accuracy
SELECT city, unit, ROUND(AVG(abs_error)::numeric, 2) as mae, COUNT(*) as n
FROM v2_forecast_accuracy WHERE source = 'ensemble_corrected'
GROUP BY city, unit ORDER BY unit, mae;
```

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

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `station` | text | ICAO station code (e.g., KNYC, KAUS) |
| `cli_high_f` | numeric | Daily high from NWS CLI report (what Kalshi uses) |
| `nws_obs_high_f` | numeric | Max from NWS hourly observations |
| `diff_f` | numeric | cli_high_f - nws_obs_high_f |
| `cli_raw` | jsonb | Raw CLI report data for debugging |

---

## metar_observations

METAR + Weather Underground observation data, polled every 10 min during active hours.

### INSERT (metar-observer.js:269)
```
city, station_id, target_date, observed_at, temp_c, temp_f,
running_high_c, running_high_f, observation_count
```
Conflict key: `(city, target_date, observed_at)`

### UPDATE (WU data — metar-observer.js:333)
```
wu_high_f, wu_high_c, wu_observation_count
```

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `running_high_f/c` | numeric | Running daily maximum from METAR |
| `wu_high_f/c` | numeric | Running daily maximum from Weather Underground API |
| `observation_count` | integer | Number of METAR readings so far today |
| `station_id` | text | ICAO station code (e.g., KLGA, KNYC) |
| `target_date` | date | Local date for the observation |

---

## snapshots

Hourly market state snapshots for all city/date/platform combos.

### INSERT (scanner.js:1011)
```
city, target_date, platform, ranges, forecast_temp,
forecast_confidence, forecast_sources, depth_data
```

| Column | Type | Notes |
|--------|------|-------|
| `ranges` | jsonb | Full range data (bid/ask/spread/volume per range) |
| `depth_data` | jsonb | Order book depth at snapshot time |

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

| Column | Type | Notes |
|--------|------|-------|
| `match` | boolean | WU and METAR agree |
| `diff_f` | numeric | WU - METAR difference in °F |

---

## Quick Reference: Common Query Patterns

```sql
-- P&L summary
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

-- Model calibration check
SELECT range_type, model_prob_bucket, n,
  ROUND(avg_model_prob::numeric, 3) as model_prob,
  ROUND(actual_win_rate::numeric, 3) as win_rate,
  ROUND(correction_ratio::numeric, 3) as ratio
FROM model_calibration
WHERE n >= 30
ORDER BY range_type, model_prob_bucket;

-- Backtest: would_have_won by price bucket
SELECT
  CASE WHEN ask < 0.2 THEN '<20c'
       WHEN ask < 0.3 THEN '20-30c'
       WHEN ask < 0.4 THEN '30-40c'
       ELSE '40c+' END as bucket,
  side, COUNT(*) as n,
  ROUND(AVG(CASE WHEN would_have_won THEN 1.0 ELSE 0.0 END) * 100, 1) as win_pct
FROM opportunities
WHERE action = 'entered' AND would_have_won IS NOT NULL
GROUP BY 1, side ORDER BY side, bucket;
```
