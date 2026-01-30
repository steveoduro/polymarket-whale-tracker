-- Weather Bot Schema Migration: Forecast Arbitrage
-- Run this in Supabase SQL Editor to add support for the Forecast Arbitrage strategy
-- Date: January 30, 2026

-- =============================================================================
-- 1. FORECAST HISTORY TABLE (new)
-- =============================================================================
CREATE TABLE IF NOT EXISTS forecast_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city TEXT NOT NULL,
  target_date DATE NOT NULL,
  high_temp_c NUMERIC NOT NULL,
  high_temp_f NUMERIC NOT NULL,
  confidence TEXT,  -- 'very-high', 'high', 'medium', 'low'
  fetched_at TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT forecast_history_unique UNIQUE (city, target_date, fetched_at)
);

-- Indexes for forecast history queries
CREATE INDEX IF NOT EXISTS idx_forecast_history_lookup
  ON forecast_history(city, target_date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_history_recent
  ON forecast_history(fetched_at DESC);

COMMENT ON TABLE forecast_history IS 'Historical forecast snapshots for detecting forecast shifts';

-- =============================================================================
-- 2. ADD COLUMNS TO WEATHER_PAPER_TRADES (if table exists)
-- =============================================================================
DO $$
BEGIN
  -- Add strategy column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'weather_paper_trades' AND column_name = 'strategy'
  ) THEN
    ALTER TABLE weather_paper_trades
    ADD COLUMN strategy TEXT DEFAULT 'range_mispricing';
  END IF;

  -- Add forecast_shift_f column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'weather_paper_trades' AND column_name = 'forecast_shift_f'
  ) THEN
    ALTER TABLE weather_paper_trades
    ADD COLUMN forecast_shift_f NUMERIC;
  END IF;
END $$;

-- Index on strategy
CREATE INDEX IF NOT EXISTS idx_weather_trades_strategy ON weather_paper_trades(strategy);

-- =============================================================================
-- 3. NEW VIEWS
-- =============================================================================

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

-- =============================================================================
-- 4. ADD TOMORROW.IO COLUMNS TO FORECAST_HISTORY
-- =============================================================================
DO $$
BEGIN
  -- Add tomorrow_high_c column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'forecast_history' AND column_name = 'tomorrow_high_c'
  ) THEN
    ALTER TABLE forecast_history ADD COLUMN tomorrow_high_c NUMERIC;
  END IF;

  -- Add tomorrow_high_f column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'forecast_history' AND column_name = 'tomorrow_high_f'
  ) THEN
    ALTER TABLE forecast_history ADD COLUMN tomorrow_high_f NUMERIC;
  END IF;
END $$;

-- =============================================================================
-- 5. FORECAST ACCURACY TABLE (track which source is more accurate)
-- =============================================================================
CREATE TABLE IF NOT EXISTS forecast_accuracy (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city TEXT NOT NULL,
  market_date DATE NOT NULL,
  open_meteo_forecast_f NUMERIC,
  tomorrow_forecast_f NUMERIC,
  actual_temp_f NUMERIC,
  open_meteo_error_f NUMERIC,
  tomorrow_error_f NUMERIC,
  resolved_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(city, market_date)
);

-- Index for querying accuracy stats
CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_city ON forecast_accuracy(city);
CREATE INDEX IF NOT EXISTS idx_forecast_accuracy_date ON forecast_accuracy(market_date);

COMMENT ON TABLE forecast_accuracy IS 'Track forecast accuracy by source (Open-Meteo vs Tomorrow.io)';

-- View: Forecast accuracy summary
CREATE OR REPLACE VIEW forecast_accuracy_summary AS
SELECT
  city,
  COUNT(*) as markets_resolved,
  ROUND(AVG(open_meteo_error_f), 2) as avg_open_meteo_error_f,
  ROUND(AVG(tomorrow_error_f), 2) as avg_tomorrow_error_f,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE open_meteo_error_f < COALESCE(tomorrow_error_f, open_meteo_error_f + 1))
    / NULLIF(COUNT(*) FILTER (WHERE tomorrow_error_f IS NOT NULL), 0), 1
  ) as open_meteo_win_pct
FROM forecast_accuracy
WHERE actual_temp_f IS NOT NULL
GROUP BY city
ORDER BY markets_resolved DESC;

-- View: Overall accuracy by source
CREATE OR REPLACE VIEW forecast_source_accuracy AS
SELECT
  'Open-Meteo' as source,
  COUNT(*) as markets,
  ROUND(AVG(open_meteo_error_f), 2) as avg_error_f,
  ROUND(MIN(open_meteo_error_f), 2) as min_error_f,
  ROUND(MAX(open_meteo_error_f), 2) as max_error_f
FROM forecast_accuracy
WHERE actual_temp_f IS NOT NULL
UNION ALL
SELECT
  'Tomorrow.io' as source,
  COUNT(*) as markets,
  ROUND(AVG(tomorrow_error_f), 2) as avg_error_f,
  ROUND(MIN(tomorrow_error_f), 2) as min_error_f,
  ROUND(MAX(tomorrow_error_f), 2) as max_error_f
FROM forecast_accuracy
WHERE tomorrow_error_f IS NOT NULL;

-- =============================================================================
-- DONE
-- =============================================================================
-- To verify, run:
-- SELECT * FROM forecast_history LIMIT 5;
-- SELECT * FROM weather_strategy_performance;
-- SELECT * FROM forecast_accuracy_summary;
-- SELECT * FROM forecast_source_accuracy;
