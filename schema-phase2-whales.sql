-- Polymarket Copy Trading Bot - Per-Whale Tracking Migration
-- Run this in Supabase SQL Editor to add whale tracking columns

-- Add whale tracking columns to my_trades
ALTER TABLE my_trades
ADD COLUMN IF NOT EXISTS copied_from_whale TEXT,
ADD COLUMN IF NOT EXISTS copied_from_address TEXT;

-- Index for per-whale queries
CREATE INDEX IF NOT EXISTS idx_my_trades_whale ON my_trades(copied_from_whale);

-- Comments
COMMENT ON COLUMN my_trades.copied_from_whale IS 'Username of the whale we copied (e.g., distinct-baguette)';
COMMENT ON COLUMN my_trades.copied_from_address IS 'Wallet address of the whale we copied';

-- =============================================================================
-- VIEWS: Per-Whale Performance
-- =============================================================================

-- View: Performance breakdown by whale
CREATE OR REPLACE VIEW whale_performance AS
SELECT
  copied_from_whale as whale,
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE pnl > 0) as wins,
  COUNT(*) FILTER (WHERE pnl < 0) as losses,
  COUNT(*) FILTER (WHERE pnl IS NULL AND status IN ('paper', 'filled', 'pending')) as pending,
  COALESCE(SUM(size), 0) as total_volume,
  COALESCE(SUM(pnl), 0) as total_pnl,
  COALESCE(AVG(pnl) FILTER (WHERE pnl IS NOT NULL), 0) as avg_pnl,
  CASE
    WHEN COUNT(*) FILTER (WHERE pnl IS NOT NULL) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE pnl > 0)::numeric /
      COUNT(*) FILTER (WHERE pnl IS NOT NULL) * 100, 1
    )
    ELSE 0
  END as win_rate_pct,
  MIN(created_at) as first_trade,
  MAX(created_at) as last_trade
FROM my_trades
WHERE copied_from_whale IS NOT NULL
  AND status IN ('paper', 'filled', 'pending')
GROUP BY copied_from_whale
ORDER BY total_pnl DESC;

-- View: Daily performance by whale
CREATE OR REPLACE VIEW whale_daily_performance AS
SELECT
  DATE(created_at) as trade_date,
  copied_from_whale as whale,
  COUNT(*) as trades,
  COUNT(*) FILTER (WHERE pnl > 0) as wins,
  COUNT(*) FILTER (WHERE pnl < 0) as losses,
  COALESCE(SUM(pnl), 0) as pnl,
  CASE
    WHEN COUNT(*) FILTER (WHERE pnl IS NOT NULL) > 0
    THEN ROUND(
      COUNT(*) FILTER (WHERE pnl > 0)::numeric /
      COUNT(*) FILTER (WHERE pnl IS NOT NULL) * 100, 1
    )
    ELSE 0
  END as win_rate_pct
FROM my_trades
WHERE copied_from_whale IS NOT NULL
  AND status IN ('paper', 'filled', 'pending')
GROUP BY DATE(created_at), copied_from_whale
ORDER BY trade_date DESC, pnl DESC;

-- View: Recent trades with whale info
CREATE OR REPLACE VIEW recent_whale_trades AS
SELECT
  id,
  copied_from_whale as whale,
  market_question,
  side,
  outcome,
  size,
  price,
  status,
  pnl,
  resolved_outcome,
  created_at,
  resolved_at
FROM my_trades
WHERE status IN ('paper', 'filled', 'pending')
ORDER BY created_at DESC
LIMIT 50;

-- View: Best performing whales (by win rate, min 5 resolved trades)
CREATE OR REPLACE VIEW best_whales AS
SELECT
  copied_from_whale as whale,
  COUNT(*) FILTER (WHERE pnl IS NOT NULL) as resolved_trades,
  COUNT(*) FILTER (WHERE pnl > 0) as wins,
  COUNT(*) FILTER (WHERE pnl < 0) as losses,
  COALESCE(SUM(pnl), 0) as total_pnl,
  ROUND(
    COUNT(*) FILTER (WHERE pnl > 0)::numeric /
    NULLIF(COUNT(*) FILTER (WHERE pnl IS NOT NULL), 0) * 100, 1
  ) as win_rate_pct
FROM my_trades
WHERE copied_from_whale IS NOT NULL
  AND status IN ('paper', 'filled')
GROUP BY copied_from_whale
HAVING COUNT(*) FILTER (WHERE pnl IS NOT NULL) >= 5
ORDER BY win_rate_pct DESC, total_pnl DESC;
