-- Add platform and source_table columns to position_manager_logs
-- Run in Supabase SQL Editor

ALTER TABLE position_manager_logs
  ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'polymarket',
  ADD COLUMN IF NOT EXISTS source_table TEXT DEFAULT 'weather_paper_trades';
