-- Polymarket Copy Trading Bot - Phase 2 Database Schema
-- Run this in Supabase SQL Editor AFTER the initial schema.sql

-- =============================================================================
-- MY TRADES (our copy trades)
-- =============================================================================
CREATE TABLE IF NOT EXISTS my_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  copied_from_trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
  market_slug TEXT,
  market_question TEXT,
  side TEXT,           -- BUY or SELL
  outcome TEXT,        -- YES or NO
  size NUMERIC,        -- Our trade size in USDC
  price NUMERIC,       -- Price at time of copy
  status TEXT DEFAULT 'pending',  -- pending, filled, failed, cancelled, skipped, paper
  polymarket_order_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  filled_at TIMESTAMPTZ
);

-- Index for querying by status
CREATE INDEX IF NOT EXISTS idx_my_trades_status ON my_trades(status);

-- Index for querying by date
CREATE INDEX IF NOT EXISTS idx_my_trades_created_at ON my_trades(created_at DESC);

-- Index for linking to original trade
CREATE INDEX IF NOT EXISTS idx_my_trades_copied_from ON my_trades(copied_from_trade_id);

COMMENT ON TABLE my_trades IS 'Our copy trades - tracking what we copy from whales';
COMMENT ON COLUMN my_trades.copied_from_trade_id IS 'Reference to the whale trade we copied';
COMMENT ON COLUMN my_trades.status IS 'pending=order placed, filled=executed, failed=error, cancelled=cancelled, skipped=risk check failed, paper=paper trade';
COMMENT ON COLUMN my_trades.polymarket_order_id IS 'Order ID from Polymarket CLOB API';

-- =============================================================================
-- DAILY STATS (P&L tracking)
-- =============================================================================
CREATE TABLE IF NOT EXISTS daily_stats (
  date DATE PRIMARY KEY,
  trades_count INT DEFAULT 0,
  total_volume NUMERIC DEFAULT 0,
  realized_pnl NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Trigger for auto-updating updated_at
CREATE TRIGGER update_daily_stats_updated_at
  BEFORE UPDATE ON daily_stats
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE daily_stats IS 'Daily trading statistics and P&L';
COMMENT ON COLUMN daily_stats.trades_count IS 'Number of copy trades executed today';
COMMENT ON COLUMN daily_stats.total_volume IS 'Total USDC volume traded today';
COMMENT ON COLUMN daily_stats.realized_pnl IS 'Realized profit/loss for the day';

-- =============================================================================
-- COPIER SETTINGS (optional - for runtime config)
-- =============================================================================

-- Add copier-specific settings to app_settings
INSERT INTO app_settings (key, value) VALUES
  ('copier_enabled', 'false'),
  ('copier_paper_mode', 'true'),
  ('copier_trade_size', '1.50'),
  ('copier_min_whale_size', '10'),
  ('copier_max_position_per_market', '5'),
  ('copier_min_balance', '10'),
  ('copier_daily_loss_limit', '15')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- VIEWS (helpful queries)
-- =============================================================================

-- View: Today's copy trades
CREATE OR REPLACE VIEW today_copy_trades AS
SELECT
  id,
  market_question,
  side,
  outcome,
  size,
  price,
  status,
  created_at,
  filled_at
FROM my_trades
WHERE created_at >= CURRENT_DATE
ORDER BY created_at DESC;

-- View: Trade summary by status
CREATE OR REPLACE VIEW trade_status_summary AS
SELECT
  status,
  COUNT(*) as count,
  SUM(size) as total_volume,
  AVG(size) as avg_size
FROM my_trades
GROUP BY status;

-- View: Daily performance
CREATE OR REPLACE VIEW daily_performance AS
SELECT
  date,
  trades_count,
  total_volume,
  realized_pnl,
  CASE
    WHEN total_volume > 0 THEN (realized_pnl / total_volume * 100)
    ELSE 0
  END as roi_pct
FROM daily_stats
ORDER BY date DESC;
