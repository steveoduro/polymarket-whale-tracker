-- Polymarket Copy Trading Bot - P&L Tracking Migration
-- Run this in Supabase SQL Editor to add P&L columns

-- Add resolution tracking columns to my_trades
ALTER TABLE my_trades
ADD COLUMN IF NOT EXISTS resolved_outcome TEXT,
ADD COLUMN IF NOT EXISTS pnl NUMERIC,
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Index for finding unresolved trades
CREATE INDEX IF NOT EXISTS idx_my_trades_unresolved
ON my_trades(status, resolved_outcome)
WHERE resolved_outcome IS NULL;

-- Comments
COMMENT ON COLUMN my_trades.resolved_outcome IS 'The winning outcome (Yes/No) after market resolved';
COMMENT ON COLUMN my_trades.pnl IS 'Realized profit/loss in USDC';
COMMENT ON COLUMN my_trades.resolved_at IS 'When we detected the resolution';

-- Update the view for daily performance
CREATE OR REPLACE VIEW paper_trade_performance AS
SELECT
  DATE(created_at) as trade_date,
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE pnl > 0) as wins,
  COUNT(*) FILTER (WHERE pnl < 0) as losses,
  COUNT(*) FILTER (WHERE resolved_outcome IS NULL) as pending,
  COALESCE(SUM(pnl), 0) as total_pnl,
  COALESCE(SUM(size), 0) as total_volume,
  CASE
    WHEN COUNT(*) FILTER (WHERE pnl IS NOT NULL) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE pnl > 0)::numeric /
      COUNT(*) FILTER (WHERE pnl IS NOT NULL) * 100, 1
    )
    ELSE 0
  END as win_rate_pct
FROM my_trades
WHERE status IN ('paper', 'filled')
GROUP BY DATE(created_at)
ORDER BY trade_date DESC;

-- View for overall paper trading stats
CREATE OR REPLACE VIEW paper_trade_summary AS
SELECT
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE pnl > 0) as wins,
  COUNT(*) FILTER (WHERE pnl < 0) as losses,
  COUNT(*) FILTER (WHERE resolved_outcome IS NULL) as pending,
  COALESCE(SUM(pnl), 0) as total_pnl,
  COALESCE(SUM(size), 0) as total_volume,
  COALESCE(AVG(pnl) FILTER (WHERE pnl IS NOT NULL), 0) as avg_pnl_per_trade,
  CASE
    WHEN COUNT(*) FILTER (WHERE pnl IS NOT NULL) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE pnl > 0)::numeric /
      COUNT(*) FILTER (WHERE pnl IS NOT NULL) * 100, 1
    )
    ELSE 0
  END as win_rate_pct
FROM my_trades
WHERE status IN ('paper', 'filled');
