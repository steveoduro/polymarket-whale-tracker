/**
 * Forecast engine configuration — cache, calibration, std devs,
 * eligibility, ensemble spread, MOS, source management.
 */

module.exports = {
  forecasts: {
    CACHE_MINUTES: 15,
    CALIBRATION_WINDOW_DAYS: 21,
    MIN_CITY_STDDEV_SAMPLES: 20,
    LEAD_TIME_BUCKETS: [
      { name: 'near', min: 0, max: 6 },
      { name: 'same-day', min: 7, max: 24 },
      { name: 'next-day', min: 25, max: 48 },
      { name: 'multi-day', min: 49, max: Infinity },
    ],
    DEFAULT_STD_DEVS: {
      'very-high': 1.39,
      'high': 1.67,
      'medium': 2.22,
      'low': 2.78,
    },
    CITY_ELIGIBILITY: {
      BOUNDED_MAX_MAE_F: 1.8,
      BOUNDED_MAX_MAE_C: 1.0,
      UNBOUNDED_MAX_MAE_F: 2.7,
      UNBOUNDED_MAX_MAE_C: 1.5,
      MIN_SAMPLES: 5,
      PREFER_ENSEMBLE_MAE: true,
    },
    ENSEMBLE_SPREAD: {
      ENABLED: false,
      MIN_BASELINE_DAYS: 7,
      MULTIPLIER_FLOOR: 0.5,
      MULTIPLIER_CEILING: 2.0,
    },
    MOS: {
      SHADOW_ONLY: true,
    },
    SOURCE_MANAGEMENT: {
      DEMOTION_MAE_F: 4.0,
      DEMOTION_MAE_C: 2.0,
      RELATIVE_DEMOTION_FACTOR: 1.8,
      SOFT_DEMOTION_MAX_WEIGHT: 0.10,
      MIN_SAMPLES: 7,
      MIN_ACTIVE_SOURCES: 2,
      WEIGHT_MIN_SAMPLES: 3,
    },
  },
};
