/**
 * Central configuration — all tunable parameters in one place.
 * Nothing hardcoded in module logic.
 */

require('dotenv').config();

const config = {
  // ── General ──────────────────────────────────────────────────────
  general: {
    SCAN_INTERVAL_MINUTES: 5,
    TRADING_MODE: 'paper',              // 'paper' | 'shadow' | 'live'
  },

  // ── Entry ────────────────────────────────────────────────────────
  entry: {
    MIN_EDGE_PCT: 10,                   // minimum edge % to enter
    MAX_SPREAD: 0.15,                   // hard spread cap in dollars
    MAX_SPREAD_PCT: 0.50,              // reject if spread > 50% of ask price
    MIN_ASK_PRICE: 0.10,               // skip YES trades below 10¢ (ghost markets)
    MIN_NO_ASK_PRICE: 0.05,            // NO-side floor (NO ask 5¢ = YES bid 95¢)
    MIN_HOURS_TO_RESOLUTION: 8,        // don't bet on already-known outcomes
  },

  // ── Position Sizing ──────────────────────────────────────────────
  sizing: {
    KELLY_FRACTION: 0.5,
    YES_BANKROLL: 1000,
    NO_BANKROLL: 1000,
    NO_MAX_PER_DATE: 200,               // hard cap on NO exposure per resolution date
    MAX_BANKROLL_PCT: 0.20,             // hard cap per position as % of bankroll
    MIN_BET: 10,
    MAX_VOLUME_PCT: null,               // null = no cap (paper mode), set to 25-50 for live
    HARD_REJECT_VOLUME_PCT: 75,         // hard-reject trades > 75% of visible volume
    WARN_VOLUME_PCT: 50,                // flag trades > 50% of volume in alerts
  },

  // ── Exit ─────────────────────────────────────────────────────────
  exit: {
    EVALUATOR_MODE: 'log_only',         // 'log_only' | 'active'
  },

  // ── Forecasts ────────────────────────────────────────────────────
  forecasts: {
    CACHE_MINUTES: 15,
    DEFAULT_STD_DEVS: {                 // in °C — base values for day-1 forecasts (empirical NWS/ECMWF verification)
      'very-high': 1.39,               // ~2.5°F — sources agree within 1°F
      'high': 1.67,                     // ~3.0°F — sources agree within 2°F
      'medium': 2.22,                   // ~4.0°F — sources agree within 4°F
      'low': 2.78,                      // ~5.0°F — large disagreement or single source
    },
  },

  // ── Snapshots ────────────────────────────────────────────────────
  snapshots: {
    INTERVAL_MINUTES: 60,
  },

  // ── Alerts ───────────────────────────────────────────────────────
  alerts: {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    ACTIONS_CHAT_ID: process.env.TELEGRAM_ACTIONS_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
    INFO_CHAT_ID: process.env.TELEGRAM_INFO_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
  },

  // ── Platforms ────────────────────────────────────────────────────
  platforms: {
    polymarket: {
      enabled: true,
      feeRate: 0,                             // Weather markets: zero trading fees (3.15% only applies to 15-min crypto)
      gammaUrl: 'https://gamma-api.polymarket.com',
      clobUrl: 'https://clob.polymarket.com',
    },
    kalshi: {
      enabled: true,
      feeRate: 0,                             // Legacy flat rate (unused) — see takerFeeMultiplier
      takerFeeMultiplier: 0.07,               // Actual fee: 0.07 * P * (1-P) per contract, charged at entry only
      apiUrl: 'https://api.elections.kalshi.com/trade-api/v2',
      apiKey: process.env.KALSHI_API_KEY,
      privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
    },
  },

  // ── Cities ───────────────────────────────────────────────────────
  // All cities from both platforms. Easy to add/remove.
  cities: {
    nyc:           { lat: 40.7128, lon: -74.0060, tz: 'America/New_York',      unit: 'F', nwsStation: 'KNYC', polymarketStation: 'KLGA' },
    chicago:       { lat: 41.8781, lon: -87.6298, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KMDW', polymarketStation: 'KORD' },
    miami:         { lat: 25.7617, lon: -80.1918, tz: 'America/New_York',      unit: 'F', nwsStation: 'KMIA', polymarketStation: 'KMIA' },
    atlanta:       { lat: 33.7490, lon: -84.3880, tz: 'America/New_York',      unit: 'F', nwsStation: 'KATL', polymarketStation: 'KATL' },
    dallas:        { lat: 32.7767, lon: -96.7970, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KDAL', polymarketStation: 'KDAL' },
    seattle:       { lat: 47.6062, lon: -122.3321, tz: 'America/Los_Angeles',  unit: 'F', nwsStation: 'KSEA', polymarketStation: 'KSEA' },
    denver:        { lat: 39.7392, lon: -104.9903, tz: 'America/Denver',       unit: 'F', nwsStation: 'KDEN' },
    austin:        { lat: 30.2672, lon: -97.7431, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KAUS' },
    houston:       { lat: 29.7604, lon: -95.3698, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KHOU' },
    philadelphia:  { lat: 39.9526, lon: -75.1652, tz: 'America/New_York',      unit: 'F', nwsStation: 'KPHL' },
    dc:            { lat: 38.9072, lon: -77.0369, tz: 'America/New_York',      unit: 'F', nwsStation: 'KDCA' },
    vegas:         { lat: 36.1699, lon: -115.1398, tz: 'America/Los_Angeles',  unit: 'F', nwsStation: 'KLAS' },
    'new orleans': { lat: 29.9511, lon: -90.0715, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KMSY' },
    'san francisco': { lat: 37.7749, lon: -122.4194, tz: 'America/Los_Angeles', unit: 'F', nwsStation: 'KSFO' },
    'los angeles': { lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles',  unit: 'F', nwsStation: 'KLAX' },
    phoenix:       { lat: 33.4484, lon: -112.0740, tz: 'America/Phoenix',      unit: 'F', nwsStation: 'KPHX' },
    boston:         { lat: 42.3601, lon: -71.0589, tz: 'America/New_York',      unit: 'F', nwsStation: 'KBOS' },
    london:        { lat: 51.5074, lon: -0.1278, tz: 'Europe/London',          unit: 'C', polymarketStation: 'EGLC' },
    seoul:         { lat: 37.5665, lon: 126.9780, tz: 'Asia/Seoul',            unit: 'C', polymarketStation: 'RKSI' },
    toronto:       { lat: 43.6532, lon: -79.3832, tz: 'America/Toronto',       unit: 'C', polymarketStation: 'CYYZ' },
    'buenos aires': { lat: -34.6037, lon: -58.3816, tz: 'America/Argentina/Buenos_Aires', unit: 'C', polymarketStation: 'SAEZ' },
    ankara:        { lat: 39.9334, lon: 32.8597, tz: 'Europe/Istanbul',        unit: 'C', polymarketStation: 'LTAC' },
    wellington:    { lat: -41.2865, lon: 174.7762, tz: 'Pacific/Auckland',     unit: 'C', polymarketStation: 'NZWN' },
  },

  // ── Supabase ─────────────────────────────────────────────────────
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

};

module.exports = config;
