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
| `range_type` | text | 'bounded' or 'unbounded_upper' or 'unbounded_lower' |
| `range_unit` | text | 'F' or 'C' |
| `platform` | text | 'polymarket' or 'kalshi' |

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

### Key column notes
| Column | Type | Notes |
|--------|------|-------|
| `our_probability` | numeric | Raw model probability (0-1) |
| `corrected_probability` | numeric | After calibration correction (NULL if no correction) |
| `edge_pct` | numeric | (probability - ask) / ask * 100 |
| `ensemble_temp` | numeric | Weighted ensemble forecast temp (city's unit) |
| `ensemble_std_dev` | numeric | Std dev used for probability calc (city's unit) |
| `forecast_temp` | numeric | Same as ensemble_temp for Polymarket; kalshiTemp for Kalshi |
| `action` | text | 'enter', 'log', 'reject', 'executor_blocked' |
| `filter_reason` | text | NULL if passed; comma-separated reason codes if filtered |
| `kelly_fraction` | numeric | Half-Kelly sizing fraction |
| `trade_id` | uuid | Set after executor creates trade (UPDATE) |
| `would_pass_at_*` | boolean | Counterfactual: would this pass at different edge thresholds |
| `cal_*` | various | Calibration bucket data (empirical win rate, n, true edge) |
| `bid_depth` / `ask_depth` | jsonb | Order book depth snapshot |

### Common filter_reason values
```
low_edge, high_spread, spread_pct, ghost_market, no_ask_floor, no_ask_cap,
max_model_market_ratio, min_hours, city_mae_gate, observation_boundary,
market_divergence, platform_trading_disabled, kalshi_city_blocked,
calBlocksEdge, high_std_range_ratio
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
ORDER BY edge_pct DESC NULLS LAST;

-- Forecast accuracy by city
SELECT city, unit,
  ROUND(AVG(abs_error)::numeric, 2) as mae,
  ROUND(AVG(error)::numeric, 2) as bias,
  COUNT(*) as n
FROM v2_forecast_accuracy
WHERE source = 'ensemble_corrected'
  AND target_date > CURRENT_DATE - INTERVAL '21 days'
GROUP BY city, unit ORDER BY mae DESC;
```
