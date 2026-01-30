-- Weather Mispricing Bot - Database Schema
-- Run this in Supabase SQL Editor

-- =============================================================================
-- WEATHER OPPORTUNITIES
-- =============================================================================
CREATE TABLE IF NOT EXISTS weather_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Market identification
  market_slug TEXT NOT NULL,
  market_question TEXT,
  city TEXT NOT NULL,
  target_date DATE NOT NULL,

  -- Forecast data
  forecast_high_c NUMERIC,
  forecast_high_f NUMERIC,
  forecast_confidence TEXT,  -- 'very-high', 'high', 'medium', 'low'
  forecast_source TEXT DEFAULT 'open-meteo',

  -- Market analysis
  ranges JSONB,  -- [{name: "8°C", price: 0.35}, ...]
  total_probability NUMERIC,  -- Sum of all prices (should be ~1.0)
  mispricing_pct NUMERIC,     -- 100 - (total_probability * 100)

  -- Recommended trade
  recommended_range TEXT,
  recommended_price NUMERIC,
  expected_value NUMERIC,

  -- Status tracking
  status TEXT DEFAULT 'detected',  -- detected, traded, expired, resolved
  created_at TIMESTAMPTZ DEFAULT now(),

  -- One opportunity per market per target date
  UNIQUE(market_slug, target_date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_weather_opp_date ON weather_opportunities(target_date);
CREATE INDEX IF NOT EXISTS idx_weather_opp_city ON weather_opportunities(city);
CREATE INDEX IF NOT EXISTS idx_weather_opp_status ON weather_opportunities(status);

COMMENT ON TABLE weather_opportunities IS 'Detected mispricing opportunities in weather markets';

-- =============================================================================
-- WEATHER PAPER TRADES
-- =============================================================================
CREATE TABLE IF NOT EXISTS weather_paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID REFERENCES weather_opportunities(id) ON DELETE SET NULL,

  -- Market info
  market_slug TEXT NOT NULL,
  city TEXT NOT NULL,
  target_date DATE NOT NULL,

  -- Position
  range_name TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'BUY',
  shares NUMERIC NOT NULL,
  entry_price NUMERIC NOT NULL,
  cost NUMERIC NOT NULL,  -- shares * price

  -- Strategy identification
  strategy TEXT DEFAULT 'range_mispricing',  -- 'range_mispricing' or 'forecast_arbitrage'
  forecast_shift_f NUMERIC,  -- For forecast_arbitrage: how much forecast shifted in °F

  -- Resolution
  actual_high_temp NUMERIC,
  winning_range TEXT,
  pnl NUMERIC,
  status TEXT DEFAULT 'open',  -- open, won, lost
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_weather_trades_status ON weather_paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_weather_trades_date ON weather_paper_trades(target_date);
CREATE INDEX IF NOT EXISTS idx_weather_trades_city ON weather_paper_trades(city);
CREATE INDEX IF NOT EXISTS idx_weather_trades_unresolved ON weather_paper_trades(target_date)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_weather_trades_strategy ON weather_paper_trades(strategy);

COMMENT ON TABLE weather_paper_trades IS 'Paper and live trades for weather markets';

-- =============================================================================
-- FORECAST HISTORY (for Forecast Arbitrage strategy)
-- =============================================================================
CREATE TABLE IF NOT EXISTS forecast_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city TEXT NOT NULL,
  target_date DATE NOT NULL,
  high_temp_c NUMERIC NOT NULL,
  high_temp_f NUMERIC NOT NULL,
  confidence TEXT,  -- 'very-high', 'high', 'medium', 'low'
  fetched_at TIMESTAMPTZ DEFAULT now(),

  -- Index for fast lookups: city + target_date + time
  CONSTRAINT forecast_history_unique UNIQUE (city, target_date, fetched_at)
);

-- Indexes for forecast history queries
CREATE INDEX IF NOT EXISTS idx_forecast_history_lookup
  ON forecast_history(city, target_date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_history_recent
  ON forecast_history(fetched_at DESC);

COMMENT ON TABLE forecast_history IS 'Historical forecast snapshots for detecting forecast shifts';

-- =============================================================================
-- WEATHER DAILY STATS
-- =============================================================================
CREATE TABLE IF NOT EXISTS weather_daily_stats (
  date DATE PRIMARY KEY,
  opportunities_found INT DEFAULT 0,
  trades_placed INT DEFAULT 0,
  trades_won INT DEFAULT 0,
  trades_lost INT DEFAULT 0,
  gross_pnl NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE weather_daily_stats IS 'Daily performance tracking for weather bot';

-- =============================================================================
-- VIEWS
-- =============================================================================

-- View: Recent opportunities
CREATE OR REPLACE VIEW recent_weather_opportunities AS
SELECT
  id,
  city,
  target_date,
  forecast_high_c,
  forecast_high_f,
  forecast_confidence,
  total_probability,
  mispricing_pct,
  recommended_range,
  recommended_price,
  expected_value,
  status,
  created_at
FROM weather_opportunities
ORDER BY created_at DESC
LIMIT 50;

-- View: Open positions
CREATE OR REPLACE VIEW weather_open_positions AS
SELECT
  t.id,
  t.city,
  t.target_date,
  t.range_name,
  t.shares,
  t.entry_price,
  t.cost,
  o.forecast_high_c,
  o.forecast_high_f,
  o.mispricing_pct
FROM weather_paper_trades t
LEFT JOIN weather_opportunities o ON t.opportunity_id = o.id
WHERE t.status = 'open'
ORDER BY t.target_date;

-- View: Performance by city
CREATE OR REPLACE VIEW weather_city_performance AS
SELECT
  city,
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE status = 'won') as wins,
  COUNT(*) FILTER (WHERE status = 'lost') as losses,
  COUNT(*) FILTER (WHERE status = 'open') as open,
  COALESCE(SUM(pnl), 0) as total_pnl,
  COALESCE(SUM(cost), 0) as total_cost,
  CASE
    WHEN COUNT(*) FILTER (WHERE status IN ('won', 'lost')) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE status = 'won')::numeric /
      COUNT(*) FILTER (WHERE status IN ('won', 'lost')) * 100, 1
    )
    ELSE 0
  END as win_rate_pct
FROM weather_paper_trades
GROUP BY city
ORDER BY total_pnl DESC;

-- View: Daily performance
CREATE OR REPLACE VIEW weather_daily_performance AS
SELECT
  date,
  opportunities_found,
  trades_placed,
  trades_won,
  trades_lost,
  gross_pnl,
  CASE
    WHEN trades_won + trades_lost > 0
    THEN ROUND(trades_won::numeric / (trades_won + trades_lost) * 100, 1)
    ELSE 0
  END as win_rate_pct
FROM weather_daily_stats
ORDER BY date DESC;

-- View: Overall summary
CREATE OR REPLACE VIEW weather_summary AS
SELECT
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE status = 'won') as wins,
  COUNT(*) FILTER (WHERE status = 'lost') as losses,
  COUNT(*) FILTER (WHERE status = 'open') as open,
  COALESCE(SUM(pnl), 0) as total_pnl,
  COALESCE(SUM(cost), 0) as total_cost,
  CASE
    WHEN COUNT(*) FILTER (WHERE status IN ('won', 'lost')) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE status = 'won')::numeric /
      COUNT(*) FILTER (WHERE status IN ('won', 'lost')) * 100, 1
    )
    ELSE 0
  END as win_rate_pct,
  CASE
    WHEN SUM(cost) > 0
    THEN ROUND(SUM(pnl)::numeric / SUM(cost) * 100, 1)
    ELSE 0
  END as roi_pct
FROM weather_paper_trades;

-- View: Performance by strategy
CREATE OR REPLACE VIEW weather_strategy_performance AS
SELECT
  COALESCE(strategy, 'range_mispricing') as strategy,
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE status = 'won') as wins,
  COUNT(*) FILTER (WHERE status = 'lost') as losses,
  COUNT(*) FILTER (WHERE status = 'open') as open,
  COALESCE(SUM(pnl), 0) as total_pnl,
  COALESCE(SUM(cost), 0) as total_cost,
  CASE
    WHEN COUNT(*) FILTER (WHERE status IN ('won', 'lost')) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE status = 'won')::numeric /
      COUNT(*) FILTER (WHERE status IN ('won', 'lost')) * 100, 1
    )
    ELSE 0
  END as win_rate_pct
FROM weather_paper_trades
GROUP BY COALESCE(strategy, 'range_mispricing')
ORDER BY total_pnl DESC;

-- View: Recent forecast shifts
CREATE OR REPLACE VIEW recent_forecast_shifts AS
SELECT
  f1.city,
  f1.target_date,
  f1.high_temp_f as current_temp_f,
  f1.high_temp_c as current_temp_c,
  f2.high_temp_f as previous_temp_f,
  f2.high_temp_c as previous_temp_c,
  (f1.high_temp_f - f2.high_temp_f) as shift_f,
  (f1.high_temp_c - f2.high_temp_c) as shift_c,
  f1.fetched_at as current_fetch,
  f2.fetched_at as previous_fetch
FROM forecast_history f1
JOIN forecast_history f2 ON f1.city = f2.city AND f1.target_date = f2.target_date
WHERE f1.fetched_at > f2.fetched_at
  AND f1.fetched_at = (
    SELECT MAX(fetched_at) FROM forecast_history
    WHERE city = f1.city AND target_date = f1.target_date
  )
  AND f2.fetched_at < f1.fetched_at - INTERVAL '1 hour'
ORDER BY ABS(f1.high_temp_f - f2.high_temp_f) DESC
LIMIT 50;
