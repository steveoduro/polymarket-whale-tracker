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
    MAX_MODEL_MARKET_RATIO: 3.0,       // reject if model prob > 3x market price (temporary guardrail)
    YES_CANDIDATE_COUNT: 5,            // number of YES candidate ranges to evaluate per city/date
    YES_MAX_FORECAST_DISTANCE: 3.0,    // candidates within this many stddevs of forecast
  },

  // ── Calibration Thresholds ─────────────────────────────────────
  calibration: {
    CAL_BLOCKS_MIN_N: 25,        // minimum n for calBlocksEdge (blocking negative-edge buckets)
    CAL_CONFIRMS_MIN_N: 50,      // minimum n for calConfirmsEdge, Kelly override, hold override
  },

  // ── Position Sizing ──────────────────────────────────────────────
  sizing: {
    KELLY_FRACTION: 0.5,
    YES_BANKROLL: 1000,
    NO_BANKROLL: 1000,
    NO_MAX_PER_DATE: 200,               // hard cap on NO exposure per resolution date
    MAX_BANKROLL_PCT: 0.20,             // hard cap per position as % of bankroll
    MIN_BET: 10,
    MAX_VOLUME_PCT: 25,                 // cap position at 25% of visible volume
    HARD_REJECT_VOLUME_PCT: 75,         // hard-reject trades > 75% of visible volume
    WARN_VOLUME_PCT: 50,                // flag trades > 50% of volume in alerts
  },

  // ── Exit ─────────────────────────────────────────────────────────
  exit: {
    EVALUATOR_MODE: 'log_only',         // 'log_only' | 'active' (applies to signals NOT in ACTIVE_SIGNALS)
    ACTIVE_SIGNALS: ['guaranteed_loss', 'guaranteed_win'],  // these signal types always execute regardless of EVALUATOR_MODE
    TAKE_PROFIT: {
      OBSERVATION_SPIKE: {
        ENABLED: true,                  // detect unconfirmed bid spikes on YES unbounded upper
        TRIGGER_BID: 0.50,              // bid must be above this to trigger
        MODE: 'log_only',              // 'log_only' | 'active' — promote after 3-5 days of validated signals
      },
    },
  },

  // ── Forecasts ────────────────────────────────────────────────────
  forecasts: {
    CACHE_MINUTES: 15,
    CALIBRATION_WINDOW_DAYS: 21,        // rolling window for bias/std dev calibration (seasonal adaptation)
    MIN_CITY_STDDEV_SAMPLES: 10,       // minimum samples for per-city std dev (falls back to pooled)
    LEAD_TIME_BUCKETS: [               // lead-time bias bucketing (narrowed from audit data)
      { name: 'near', min: 0, max: 6 },            // 0-6h — at/near resolution
      { name: 'same-day', min: 7, max: 24 },       // 7-24h — same day
      { name: 'next-day', min: 25, max: 48 },      // 25-48h — next day
      { name: 'multi-day', min: 49, max: Infinity }, // 49h+ — 2+ days out
    ],
    DEFAULT_STD_DEVS: {                 // FALLBACK ONLY — used until empirical std devs accumulate (≥10 data points/unit)
      'very-high': 1.39,               // ~2.5°F — sources agree within 1°F
      'high': 1.67,                     // ~3.0°F — sources agree within 2°F
      'medium': 2.22,                   // ~4.0°F — sources agree within 4°F
      'low': 2.78,                      // ~5.0°F — large disagreement or single source
    },
    CITY_ELIGIBILITY: {                 // Block trades in cities where forecast MAE is too high for the range type
      BOUNDED_MAX_MAE_F: 2.5,          // max MAE (°F) for bounded range trades (typically 2°F wide)
      BOUNDED_MAX_MAE_C: 1.5,          // max MAE (°C) for bounded range trades
      UNBOUNDED_MAX_MAE_F: 4.0,        // max MAE (°F) for unbounded range trades
      UNBOUNDED_MAX_MAE_C: 2.0,        // max MAE (°C) for unbounded range trades
      MIN_SAMPLES: 5,                   // minimum accuracy records before gating (below this, allow all)
    },
    ENSEMBLE_SPREAD: {
      ENABLED: false,          // flip to true after 7-10 days of baseline
      MIN_BASELINE_DAYS: 7,
      MULTIPLIER_FLOOR: 0.5,
      MULTIPLIER_CEILING: 2.0,
    },
    MOS: {
      SHADOW_ONLY: true,       // flip to false to promote to active ensemble member
    },
    SOURCE_MANAGEMENT: {                // Per-city source promotion/demotion thresholds
      DEMOTION_MAE_F: 4.0,             // absolute ceiling — always demote above this (°F)
      DEMOTION_MAE_C: 2.0,             // absolute ceiling — always demote above this (°C)
      RELATIVE_DEMOTION_FACTOR: 1.8,   // demote if MAE > 1.8x best source for that city
      SOFT_DEMOTION_MAX_WEIGHT: 0.10,  // max weight for soft-demoted sources (10%) — used when MIN_ACTIVE prevents full demotion
      MIN_SAMPLES: 7,                   // minimum records before demoting (higher bar — one bad week shouldn't kill a source)
      MIN_ACTIVE_SOURCES: 2,            // never fully demote below this many active sources (soft demotion still applies)
      WEIGHT_MIN_SAMPLES: 3,            // minimum records before weighting (lowered from 5 to activate with existing data)
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

  // ── Guaranteed Entry ─────────────────────────────────────────────
  guaranteed_entry: {
    ENABLED: true,
    MIN_MARGIN_CENTS: 5,              // minimum profit per share after fees (cents)
    MAX_ASK: 0.97,                    // don't buy above 97¢
    MIN_ASK: 0.30,                    // safety floor — if ask < 30¢, observation might be wrong
    MAX_BANKROLL_PCT: 0.15,           // 15% of matching-side bankroll per guaranteed-win trade
    REQUIRE_DUAL_CONFIRMATION: true,  // require both WU and METAR to agree
  },

  // ── Observer ─────────────────────────────────────────────────────
  observer: {
    POLL_INTERVAL_MINUTES: 10,     // how often to poll METAR observations
    ACTIVE_HOURS: { start: 6, end: 23 },  // local time range to poll (skip overnight)
    COOLING_HOUR: 17,              // fallback default if no METAR history (5 PM)
    DYNAMIC_PEAK_HOUR: true,       // enable per-city peak hour from METAR data
    PEAK_HOUR_BUFFER: 2,           // hours after observed average peak = cooling hour
    PEAK_HOUR_MIN: 14,             // floor clamp (2 PM — no city peaks before this)
    PEAK_HOUR_MAX: 20,             // ceiling clamp (8 PM — safety upper bound)
    PEAK_HOUR_MIN_SAMPLES: 3,      // minimum peak observations before trusting dynamic value
  },

  // ── Observation Entry Gate ──────────────────────────────────────
  observation_entry_gate: {
    ENABLED: true,
    BOUNDARY_BUFFER_F: 1.0,  // Block if running high is within 1°F of range ceiling
    BOUNDARY_BUFFER_C: 0.5,  // Block if running high is within 0.5°C of range ceiling
  },

  // ── Cities ───────────────────────────────────────────────────────
  // All cities from both platforms. Easy to add/remove.
  // wuCountry: ISO 2-letter country code for Weather Underground API (STATION:9:COUNTRY)
  cities: {
    nyc:           { lat: 40.7128, lon: -74.0060, tz: 'America/New_York',      unit: 'F', nwsStation: 'KNYC', polymarketStation: 'KLGA', wuCountry: 'US' },
    chicago:       { lat: 41.8781, lon: -87.6298, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KMDW', polymarketStation: 'KORD', wuCountry: 'US' },
    miami:         { lat: 25.7617, lon: -80.1918, tz: 'America/New_York',      unit: 'F', nwsStation: 'KMIA', polymarketStation: 'KMIA', wuCountry: 'US' },
    atlanta:       { lat: 33.7490, lon: -84.3880, tz: 'America/New_York',      unit: 'F', nwsStation: 'KATL', polymarketStation: 'KATL', wuCountry: 'US' },
    dallas:        { lat: 32.7767, lon: -96.7970, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KDAL', polymarketStation: 'KDAL', wuCountry: 'US' },
    seattle:       { lat: 47.6062, lon: -122.3321, tz: 'America/Los_Angeles',  unit: 'F', nwsStation: 'KSEA', polymarketStation: 'KSEA', wuCountry: 'US' },
    denver:        { lat: 39.7392, lon: -104.9903, tz: 'America/Denver',       unit: 'F', nwsStation: 'KDEN', wuCountry: 'US' },
    austin:        { lat: 30.2672, lon: -97.7431, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KAUS', wuCountry: 'US' },
    houston:       { lat: 29.7604, lon: -95.3698, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KHOU', wuCountry: 'US' },
    philadelphia:  { lat: 39.9526, lon: -75.1652, tz: 'America/New_York',      unit: 'F', nwsStation: 'KPHL', wuCountry: 'US' },
    dc:            { lat: 38.9072, lon: -77.0369, tz: 'America/New_York',      unit: 'F', nwsStation: 'KDCA', wuCountry: 'US' },
    vegas:         { lat: 36.1699, lon: -115.1398, tz: 'America/Los_Angeles',  unit: 'F', nwsStation: 'KLAS', wuCountry: 'US' },
    'new orleans': { lat: 29.9511, lon: -90.0715, tz: 'America/Chicago',       unit: 'F', nwsStation: 'KMSY', wuCountry: 'US' },
    'san francisco': { lat: 37.7749, lon: -122.4194, tz: 'America/Los_Angeles', unit: 'F', nwsStation: 'KSFO', wuCountry: 'US' },
    'los angeles': { lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles',  unit: 'F', nwsStation: 'KLAX', wuCountry: 'US' },
    phoenix:       { lat: 33.4484, lon: -112.0740, tz: 'America/Phoenix',      unit: 'F', nwsStation: 'KPHX', wuCountry: 'US' },
    boston:         { lat: 42.3601, lon: -71.0589, tz: 'America/New_York',      unit: 'F', nwsStation: 'KBOS', wuCountry: 'US' },
    london:        { lat: 51.5074, lon: -0.1278, tz: 'Europe/London',          unit: 'C', polymarketStation: 'EGLC', wuCountry: 'GB' },
    seoul:         { lat: 37.5665, lon: 126.9780, tz: 'Asia/Seoul',            unit: 'C', polymarketStation: 'RKSI', wuCountry: 'KR' },
    toronto:       { lat: 43.6532, lon: -79.3832, tz: 'America/Toronto',       unit: 'C', polymarketStation: 'CYYZ', wuCountry: 'CA' },
    'buenos aires': { lat: -34.6037, lon: -58.3816, tz: 'America/Argentina/Buenos_Aires', unit: 'C', polymarketStation: 'SAEZ', wuCountry: 'AR' },
    ankara:        { lat: 39.9334, lon: 32.8597, tz: 'Europe/Istanbul',        unit: 'C', polymarketStation: 'LTAC', wuCountry: 'TR' },
    wellington:    { lat: -41.2865, lon: 174.7762, tz: 'Pacific/Auckland',     unit: 'C', polymarketStation: 'NZWN', wuCountry: 'NZ' },
  },

  // ── Supabase ─────────────────────────────────────────────────────
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

};

module.exports = config;
