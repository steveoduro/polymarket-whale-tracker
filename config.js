/**
 * Central configuration — loads sub-configs and merges into one object.
 * All consumer code still does require('./config') or require('../config').
 */

require('dotenv').config();

const cities = require('./config/cities');
const trading = require('./config/trading');
const forecasts = require('./config/forecasts');
const platforms = require('./config/platforms');
const observation = require('./config/observation');

const config = {
  general: {
    SCAN_INTERVAL_MINUTES: 5,
    TRADING_MODE: 'paper',
  },

  alerts: {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    ACTIONS_CHAT_ID: process.env.TELEGRAM_ACTIONS_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
    INFO_CHAT_ID: process.env.TELEGRAM_INFO_CHAT_ID || process.env.TELEGRAM_CHAT_ID,
  },

  snapshots: {
    INTERVAL_MINUTES: 60,
  },

  ...trading,      // { entry, calibration, sizing, exit }
  ...forecasts,    // { forecasts: {...} }
  ...platforms,    // { platforms: {...} }
  ...observation,  // { guaranteed_entry, observer, observation_entry_gate, pws_gw }

  cities,
};

module.exports = config;
