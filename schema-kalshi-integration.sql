-- Kalshi Integration Database Migration
-- Run this on your Supabase database to add multi-platform support

-- =============================================================================
-- 1. Add platform columns to weather_paper_trades
-- =============================================================================

-- Add platform tracking column
ALTER TABLE weather_paper_trades
ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'polymarket';

-- Add platform-specific market ID (ticker for Kalshi, conditionId for Polymarket)
ALTER TABLE weather_paper_trades
ADD COLUMN IF NOT EXISTS platform_market_id TEXT;

-- Add fee tracking
ALTER TABLE weather_paper_trades
ADD COLUMN IF NOT EXISTS fee_rate NUMERIC DEFAULT 0.0315;

ALTER TABLE weather_paper_trades
ADD COLUMN IF NOT EXISTS fee_amount NUMERIC DEFAULT 0;

-- Add resolution source for verification
ALTER TABLE weather_paper_trades
ADD COLUMN IF NOT EXISTS resolution_source TEXT;

-- Create index for platform queries
CREATE INDEX IF NOT EXISTS idx_weather_paper_trades_platform
ON weather_paper_trades(platform);

-- =============================================================================
-- 2. Create price comparison logging table
-- =============================================================================

CREATE TABLE IF NOT EXISTS weather_price_comparisons (
  id SERIAL PRIMARY KEY,
  city TEXT NOT NULL,
  date TEXT NOT NULL,
  range_label TEXT NOT NULL,

  -- Polymarket data
  polymarket_price NUMERIC,
  polymarket_bid NUMERIC,
  polymarket_ask NUMERIC,
  polymarket_spread NUMERIC,
  polymarket_volume NUMERIC,

  -- Kalshi data
  kalshi_price NUMERIC,
  kalshi_bid NUMERIC,
  kalshi_ask NUMERIC,
  kalshi_spread NUMERIC,
  kalshi_volume NUMERIC,

  -- Comparison results
  price_diff NUMERIC,
  price_diff_pct NUMERIC,
  effective_price_diff NUMERIC,  -- Fee-adjusted
  best_platform TEXT,

  -- Arbitrage detection
  arb_opportunity BOOLEAN DEFAULT false,
  arb_profit NUMERIC,
  arb_direction TEXT,

  scanned_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for time-series queries
CREATE INDEX IF NOT EXISTS idx_price_comparisons_scanned
ON weather_price_comparisons(scanned_at DESC);

-- Index for city/date lookups
CREATE INDEX IF NOT EXISTS idx_price_comparisons_city_date
ON weather_price_comparisons(city, date);

-- =============================================================================
-- 3. Create platform health monitoring table
-- =============================================================================

CREATE TABLE IF NOT EXISTS platform_health (
  id SERIAL PRIMARY KEY,
  platform TEXT NOT NULL,

  -- Market discovery stats
  markets_found INTEGER,
  markets_with_liquidity INTEGER,

  -- API performance
  api_latency_ms INTEGER,
  api_requests INTEGER,
  api_errors INTEGER,

  -- Rate limit tracking
  rate_limit_remaining INTEGER,
  rate_limit_reset TIMESTAMPTZ,

  -- Error details
  last_error TEXT,
  error_count_1h INTEGER DEFAULT 0,

  checked_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for platform queries
CREATE INDEX IF NOT EXISTS idx_platform_health_platform_time
ON platform_health(platform, checked_at DESC);

-- =============================================================================
-- 4. Update weather_opportunities table for platform support
-- =============================================================================

ALTER TABLE weather_opportunities
ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'polymarket';

ALTER TABLE weather_opportunities
ADD COLUMN IF NOT EXISTS platform_market_id TEXT;

ALTER TABLE weather_opportunities
ADD COLUMN IF NOT EXISTS fee_adjusted_ev NUMERIC;

-- =============================================================================
-- 5. Create view for P&L by platform
-- =============================================================================

CREATE OR REPLACE VIEW weather_pnl_by_platform AS
SELECT
  platform,
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE status = 'won') as wins,
  COUNT(*) FILTER (WHERE status = 'lost') as losses,
  COUNT(*) FILTER (WHERE status = 'open') as open_positions,
  ROUND(SUM(COALESCE(pnl, 0))::numeric, 2) as total_pnl,
  ROUND(SUM(cost)::numeric, 2) as total_cost,
  ROUND(SUM(COALESCE(fee_amount, 0))::numeric, 2) as total_fees,
  ROUND(
    CASE
      WHEN COUNT(*) FILTER (WHERE status IN ('won', 'lost')) > 0
      THEN COUNT(*) FILTER (WHERE status = 'won')::numeric /
           COUNT(*) FILTER (WHERE status IN ('won', 'lost')) * 100
      ELSE 0
    END, 1
  ) as win_rate_pct,
  ROUND(
    CASE
      WHEN SUM(cost) > 0
      THEN SUM(COALESCE(pnl, 0)) / SUM(cost) * 100
      ELSE 0
    END, 1
  ) as roi_pct
FROM weather_paper_trades
GROUP BY platform;

-- =============================================================================
-- 6. Backfill existing trades as Polymarket
-- =============================================================================

UPDATE weather_paper_trades
SET platform = 'polymarket'
WHERE platform IS NULL;

UPDATE weather_paper_trades
SET resolution_source = 'Open-Meteo'
WHERE resolution_source IS NULL AND platform = 'polymarket';

-- =============================================================================
-- Done!
-- =============================================================================

-- Verify migration
SELECT 'Migration complete. New columns added:' as status;
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'weather_paper_trades'
  AND column_name IN ('platform', 'platform_market_id', 'fee_rate', 'fee_amount', 'resolution_source');
