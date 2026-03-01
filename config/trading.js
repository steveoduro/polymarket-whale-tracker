/**
 * Trading configuration — entry, calibration, sizing, exit.
 */

module.exports = {
  entry: {
    MIN_EDGE_PCT: 10,
    MAX_SPREAD: 0.15,
    MAX_SPREAD_PCT: 0.50,
    MIN_ASK_PRICE: 0.10,
    MIN_NO_ASK_PRICE: 0.20,
    MAX_NO_ASK_PRICE: 0.30,
    MIN_HOURS_TO_RESOLUTION: 8,
    MAX_MODEL_MARKET_RATIO: 3.0,
    YES_CANDIDATE_COUNT: 5,
    YES_MAX_FORECAST_DISTANCE: 3.0,
    MAX_ENSEMBLE_SPREAD_F: 7.0,
    MAX_ENSEMBLE_SPREAD_C: 4.0,
    MAX_STD_RANGE_RATIO: 2.0,
    MAX_MARKET_DIVERGENCE_C: 1.0,
  },

  calibration: {
    CAL_BLOCKS_MIN_N: 15,
    CAL_CONFIRMS_MIN_N: 50,
    CAL_MIN_TRADE_EDGE: 0.03,
  },

  sizing: {
    KELLY_FRACTION: 0.5,
    YES_BANKROLL: 1000,
    NO_BANKROLL: 1000,
    NO_MAX_PER_DATE: 200,
    MAX_BANKROLL_PCT: 0.20,
    MIN_BET: 10,
    MAX_VOLUME_PCT: 25,
    HARD_REJECT_VOLUME_PCT: 75,
    WARN_VOLUME_PCT: 50,
  },

  exit: {
    EVALUATOR_MODE: 'log_only',
    ACTIVE_SIGNALS: ['guaranteed_loss', 'guaranteed_win'],
    TAKE_PROFIT: {
      OBSERVATION_SPIKE: {
        ENABLED: true,
        TRIGGER_BID: 0.50,
        MODE: 'log_only',
      },
    },
  },
};
