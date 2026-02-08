-- Position Manager Bot (Bot B) Schema Migration
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Date: 2026-02-08

-- =============================================================================
-- 1. Add columns to weather_paper_trades for position management
-- =============================================================================

ALTER TABLE weather_paper_trades ADD COLUMN IF NOT EXISTS managed_by TEXT;
ALTER TABLE weather_paper_trades ADD COLUMN IF NOT EXISTS exit_reason TEXT;
ALTER TABLE weather_paper_trades ADD COLUMN IF NOT EXISTS exit_price NUMERIC;
ALTER TABLE weather_paper_trades ADD COLUMN IF NOT EXISTS exit_time TIMESTAMPTZ;
ALTER TABLE weather_paper_trades ADD COLUMN IF NOT EXISTS exit_pnl NUMERIC;
ALTER TABLE weather_paper_trades ADD COLUMN IF NOT EXISTS max_price_seen NUMERIC;
ALTER TABLE weather_paper_trades ADD COLUMN IF NOT EXISTS min_price_seen NUMERIC;

-- =============================================================================
-- 2. Create position_manager_logs table for detailed tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS position_manager_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID REFERENCES weather_paper_trades(id),
  city TEXT NOT NULL,
  target_date DATE NOT NULL,
  range_name TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'monitor', 'exit_take_profit', 'exit_forecast_shift', 'reentry', 'skip'
  entry_price NUMERIC,
  current_price NUMERIC,
  current_bid NUMERIC,
  current_ask NUMERIC,
  entry_tier TEXT,  -- 'LONGSHOT', 'MIDRANGE', 'FAVORITE'
  exit_threshold NUMERIC,
  forecast_temp_f NUMERIC,
  forecast_in_range BOOLEAN,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- 3. Create reentry_trades table for Bot B's own entries
-- =============================================================================

CREATE TABLE IF NOT EXISTS reentry_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_trade_id UUID REFERENCES weather_paper_trades(id),
  city TEXT NOT NULL,
  target_date DATE NOT NULL,
  platform TEXT NOT NULL,
  range_name TEXT NOT NULL,
  entry_price NUMERIC NOT NULL,
  cost NUMERIC NOT NULL,
  shares NUMERIC NOT NULL,
  edge_at_entry NUMERIC,
  forecast_temp_f NUMERIC,
  status TEXT DEFAULT 'open',  -- 'open', 'exited', 'won', 'lost'
  exit_price NUMERIC,
  exit_reason TEXT,
  exit_time TIMESTAMPTZ,
  pnl NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- 4. Indexes for fast lookups
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_trades_managed_by ON weather_paper_trades(managed_by);
CREATE INDEX IF NOT EXISTS idx_trades_status_managed ON weather_paper_trades(status, managed_by);
CREATE INDEX IF NOT EXISTS idx_pm_logs_trade_id ON position_manager_logs(trade_id);
CREATE INDEX IF NOT EXISTS idx_reentry_original ON reentry_trades(original_trade_id);
