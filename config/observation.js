/**
 * Observation configuration — guaranteed entry, METAR observer,
 * observation entry gate, PWS guaranteed-win strategy.
 */

module.exports = {
  guaranteed_entry: {
    ENABLED: true,
    MIN_MARGIN_CENTS: 5,
    MAX_ASK: 0.97,
    MIN_ASK: 0.30,
    MIN_ASK_DUAL_CONFIRMED: 0.15,
    MAX_BANKROLL_PCT: 0.20,
    REQUIRE_DUAL_CONFIRMATION: false,
    GW_SCAN_INTERVAL_SECONDS: 90,
    METAR_FAST_POLL_INTERVAL_SECONDS: 15,
    METAR_ONLY_MIN_GAP_F: 0.5,
    METAR_ONLY_MIN_GAP_C: 0.5,
    GW_NEAR_THRESHOLD_BUFFER_F: 1.0,
    GW_NEAR_THRESHOLD_BUFFER_C: 0.5,
    GW_MIN_BID: 0.10,
    GW_LIVE_ENABLED: false,
    GW_METAR_BANKROLL: 10,
    GW_PAPER_BANKROLL: 1000,
  },

  observer: {
    POLL_INTERVAL_MINUTES: 10,
    PEAK_POLL_INTERVAL_MINUTES: 3,
    PEAK_HOURS: { start: 10, end: 18 },
    ACTIVE_HOURS: { start: 6, end: 23 },
    COOLING_HOUR: 17,
    DYNAMIC_PEAK_HOUR: true,
    PEAK_HOUR_BUFFER: 2,
    PEAK_HOUR_MIN: 14,
    PEAK_HOUR_MAX: 20,
    PEAK_HOUR_MIN_SAMPLES: 3,
    WU_LEAD_MIN_GAP_F: 1.0,
    WU_LEAD_MIN_GAP_C: 0.5,
    WU_LEAD_MAX_LOCAL_HOUR: 14,
  },

  observation_entry_gate: {
    ENABLED: true,
    BOUNDARY_BUFFER_F: 1.0,
    BOUNDARY_BUFFER_C: 0.5,
  },

  pws_gw: {
    ENABLED: true,
    MIN_STATIONS_CONFIGURED: 2,
    MIN_STATIONS_ONLINE: 2,
    MAX_AVG_CORRECTED_ERROR: 2.0,
    MIN_GAP_F: 1.0,
    MIN_GAP_C: 0.5,
    MIN_ASK: 0.20,
    MAX_ASK: 0.95,
    MIN_BID: 0.10,
    BANKROLL: 500,
    // Confidence-weighted sizing: dollars = bankroll × MAX_BANKROLL_PCT × city_factor × time_factor
    // city_factor = (MAX_ERROR - avgError) / MAX_ERROR, clamped [MIN_CONFIDENCE, 1.0]
    // time_factor = 1.0 before FULL hour, linear decay to MIN by REDUCED hour
    MAX_BANKROLL_PCT: 0.15,
    MIN_CONFIDENCE_FACTOR: 0.3,
    TIME_FULL_CONFIDENCE_HOUR: 12,
    TIME_REDUCED_HOUR: 15,
  },
};
