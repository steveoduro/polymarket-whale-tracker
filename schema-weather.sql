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

  UNIQUE(market_slug, created_at::date)
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

COMMENT ON TABLE weather_paper_trades IS 'Paper and live trades for weather markets';

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
