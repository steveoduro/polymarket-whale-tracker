-- Polymarket Whale Tracker Database Schema
-- Run this in Supabase SQL Editor

-- =============================================================================
-- TRACKED WALLETS
-- =============================================================================
CREATE TABLE tracked_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address TEXT UNIQUE NOT NULL,
  username TEXT,
  nickname TEXT,
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for address lookups
CREATE UNIQUE INDEX idx_tracked_wallets_address ON tracked_wallets(address);

COMMENT ON TABLE tracked_wallets IS 'Polygon wallet addresses we are monitoring';
COMMENT ON COLUMN tracked_wallets.address IS 'Polygon wallet address (lowercase)';
COMMENT ON COLUMN tracked_wallets.username IS 'Polymarket username if known';
COMMENT ON COLUMN tracked_wallets.nickname IS 'Our custom label for this wallet';
COMMENT ON COLUMN tracked_wallets.notes IS 'Strategy notes about this wallet';

-- =============================================================================
-- TRADES
-- =============================================================================
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
  polymarket_trade_id TEXT UNIQUE NOT NULL,
  market_slug TEXT,
  market_question TEXT,
  outcome TEXT,
  side TEXT,
  price NUMERIC,
  size NUMERIC,
  timestamp TIMESTAMPTZ,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for querying trades by wallet and time
CREATE INDEX idx_trades_wallet_timestamp ON trades(wallet_id, timestamp DESC);

-- Unique index for deduplication
CREATE UNIQUE INDEX idx_trades_polymarket_id ON trades(polymarket_trade_id);

COMMENT ON TABLE trades IS 'All detected trades from tracked wallets';
COMMENT ON COLUMN trades.polymarket_trade_id IS 'Unique trade ID from Polymarket API for deduplication';
COMMENT ON COLUMN trades.outcome IS 'YES or NO';
COMMENT ON COLUMN trades.side IS 'BUY or SELL';
COMMENT ON COLUMN trades.size IS 'Trade size in USDC';
COMMENT ON COLUMN trades.raw_data IS 'Full API response for debugging';

-- =============================================================================
-- ALERTS LOG
-- =============================================================================
CREATE TABLE alerts_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
  alert_type TEXT DEFAULT 'telegram',
  sent_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'sent',
  error_message TEXT
);

-- Index for recent alerts
CREATE INDEX idx_alerts_log_sent_at ON alerts_log(sent_at DESC);

COMMENT ON TABLE alerts_log IS 'Log of all sent notifications';
COMMENT ON COLUMN alerts_log.alert_type IS 'telegram, discord, etc.';
COMMENT ON COLUMN alerts_log.status IS 'sent, failed';

-- =============================================================================
-- APP SETTINGS
-- =============================================================================
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE app_settings IS 'Application configuration stored as key-value pairs';

-- Insert default settings
INSERT INTO app_settings (key, value) VALUES
  ('min_trade_size', '1000'),
  ('poll_interval_seconds', '60'),
  ('telegram_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- HELPER FUNCTION: Update updated_at timestamp
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to tracked_wallets
CREATE TRIGGER update_tracked_wallets_updated_at
  BEFORE UPDATE ON tracked_wallets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to app_settings
CREATE TRIGGER update_app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
