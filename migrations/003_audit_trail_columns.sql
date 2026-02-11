-- Migration 003: Audit trail columns for re-entry tracking
-- Run in Supabase SQL Editor (anon key can't execute DDL)

-- 1. Add actual_high_temp and resolved_at to reentry_trades
ALTER TABLE reentry_trades
  ADD COLUMN IF NOT EXISTS actual_high_temp FLOAT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- 2. Add details JSONB column to position_manager_logs
-- Stores extra context (reentry_id, cost, edge, etc.) that doesn't fit fixed columns
ALTER TABLE position_manager_logs
  ADD COLUMN IF NOT EXISTS details JSONB;

-- 3. Backfill resolved_at for already-resolved reentry trades
UPDATE reentry_trades
SET resolved_at = exit_time
WHERE status IN ('won', 'lost') AND resolved_at IS NULL AND exit_time IS NOT NULL;

-- Verify
SELECT 'reentry_trades columns' AS check_type, column_name, data_type
FROM information_schema.columns
WHERE table_name = 'reentry_trades' AND column_name IN ('actual_high_temp', 'resolved_at')
UNION ALL
SELECT 'position_manager_logs columns', column_name, data_type
FROM information_schema.columns
WHERE table_name = 'position_manager_logs' AND column_name = 'details';
