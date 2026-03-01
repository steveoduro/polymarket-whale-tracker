/**
 * Platform configuration — Polymarket + Kalshi.
 */

module.exports = {
  platforms: {
    polymarket: {
      enabled: true,
      guaranteedWinEnabled: true,
      feeRate: 0,
      gammaUrl: 'https://gamma-api.polymarket.com',
      clobUrl: 'https://clob.polymarket.com',
      apiKey: process.env.POLY_API_KEY,
      apiSecret: process.env.POLY_API_SECRET,
      apiPassphrase: process.env.POLY_API_PASSPHRASE,
      funderAddress: process.env.POLY_FUNDER_ADDRESS,
    },
    kalshi: {
      enabled: true,
      tradingEnabled: false,
      guaranteedWinEnabled: true,
      feeRate: 0,
      takerFeeMultiplier: 0.07,
      apiUrl: 'https://api.elections.kalshi.com/trade-api/v2',
      apiKey: process.env.KALSHI_API_KEY,
      privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
      STD_DEV_MULTIPLIER: 1.8,
      NWS_WEIGHT_BOOST: 3.0,
    },
  },
};
