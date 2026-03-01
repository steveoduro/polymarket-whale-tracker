/**
 * City definitions — 23 cities across Polymarket + Kalshi.
 * Grouped by region, one field per line for readability.
 */

const cities = {
  // ── US Northeast ──────────────────────────────────────────────────
  nyc: {
    lat: 40.7128, lon: -74.0060,
    tz: 'America/New_York',
    unit: 'F',
    nwsStation: 'KNYC',
    polymarketStation: 'KLGA',
    wuCountry: 'US',
    kalshiNwsPriority: true,
    pwsStations: ['KNYREGOP4', 'KNYNEWYO1313', 'KNYNEWYO2206'],
  },
  boston: {
    lat: 42.3601, lon: -71.0589,
    tz: 'America/New_York',
    unit: 'F',
    nwsStation: 'KBOS',
    wuCountry: 'US',
    pwsStations: ['KMABOSTO331', 'KMABOSTO395', 'KMASOMER98'], // KMAJAMAI25 replaced — dead (invalid JSON)
  },
  philadelphia: {
    lat: 39.9526, lon: -75.1652,
    tz: 'America/New_York',
    unit: 'F',
    nwsStation: 'KPHL',
    wuCountry: 'US',
    pwsStations: ['KPAPHILA259', 'KPAPHILA508', 'KNJHADDO33'], // KPAPHILA367 replaced — 5% uptime
  },
  dc: {
    lat: 38.9072, lon: -77.0369,
    tz: 'America/New_York',
    unit: 'F',
    nwsStation: 'KDCA',
    wuCountry: 'US',
    pwsStations: ['KDCWASHI467', 'KDCWASHI286', 'KDCWASHI481'], // KDCWASHI468/600 replaced — 31% uptime each
  },

  // ── US Southeast ──────────────────────────────────────────────────
  miami: {
    lat: 25.7617, lon: -80.1918,
    tz: 'America/New_York',
    unit: 'F',
    nwsStation: 'KMIA',
    polymarketStation: 'KMIA',
    wuCountry: 'US',
    kalshiBlocked: true,
    pwsStations: ['KFLWESTM8', 'KFLMIAMI232', 'KFLMIAMI1081'],
  },
  atlanta: {
    lat: 33.7490, lon: -84.3880,
    tz: 'America/New_York',
    unit: 'F',
    nwsStation: 'KATL',
    polymarketStation: 'KATL',
    wuCountry: 'US',
    pwsStations: ['KGAATLAN707', 'KGAATLAN628', 'KGAATLAN919'],
  },
  'new orleans': {
    lat: 29.9511, lon: -90.0715,
    tz: 'America/Chicago',
    unit: 'F',
    nwsStation: 'KMSY',
    wuCountry: 'US',
    pwsStations: ['KLAGRETN52', 'KLANEWOR447'], // KLANEWOR292/490 replaced — temp=null (broken sensors); KLAGRETN14 removed earlier
  },

  // ── US Midwest ────────────────────────────────────────────────────
  chicago: {
    lat: 41.8781, lon: -87.6298,
    tz: 'America/Chicago',
    unit: 'F',
    nwsStation: 'KMDW',
    polymarketStation: 'KORD',
    wuCountry: 'US',
    kalshiBlocked: true,
    pwsStations: ['KILFRANK74', 'KILELMHU35', 'KILADDIS10'],
  },
  minneapolis: {
    lat: 44.9778, lon: -93.2650,
    tz: 'America/Chicago',
    unit: 'F',
    nwsStation: 'KMSP',
    wuCountry: 'US',
    pwsStations: ['KMNMINNE514', 'KMNMINNE644', 'KMNMINNE423'],
  },
  'oklahoma city': {
    lat: 35.4676, lon: -97.5164,
    tz: 'America/Chicago',
    unit: 'F',
    nwsStation: 'KOKC',
    wuCountry: 'US',
    pwsStations: ['KOKMIDWE27', 'KOKMIDWE53', 'KOKOKLAH944'],
  },

  // ── US South / Texas ──────────────────────────────────────────────
  dallas: {
    lat: 32.7767, lon: -96.7970,
    tz: 'America/Chicago',
    unit: 'F',
    nwsStation: 'KDFW',
    polymarketStation: 'KDAL',
    wuCountry: 'US',
    pwsStations: ['KTXSOUTH104', 'KTXIRVIN222', 'KTXEULES74'],
  },
  austin: {
    lat: 30.2672, lon: -97.7431,
    tz: 'America/Chicago',
    unit: 'F',
    nwsStation: 'KAUS',
    wuCountry: 'US',
    kalshiNwsPriority: true,
    pwsStations: ['KTXAUSTI4026', 'KTXAUSTI3940', 'KTXAUSTI2291'],
  },
  houston: {
    lat: 29.7604, lon: -95.3698,
    tz: 'America/Chicago',
    unit: 'F',
    nwsStation: 'KHOU',
    wuCountry: 'US',
    pwsStations: ['KTXHOUST3045', 'KTXHOUST275', 'KTXHOUST3203'],
  },
  'san antonio': {
    lat: 29.4241, lon: -98.4936,
    tz: 'America/Chicago',
    unit: 'F',
    nwsStation: 'KSAT',
    wuCountry: 'US',
    pwsStations: ['KTXSANAN2227', 'KTXSANAN3718', 'KTXSANAN2533'], // KTXSANAN2786 replaced — temp=null (broken sensor)
  },

  // ── US West ───────────────────────────────────────────────────────
  seattle: {
    lat: 47.6062, lon: -122.3321,
    tz: 'America/Los_Angeles',
    unit: 'F',
    nwsStation: 'KSEA',
    polymarketStation: 'KSEA',
    wuCountry: 'US',
    pwsStations: ['KWASEATT2605', 'KWASEATT2649', 'KWASEATT2336'],
  },
  denver: {
    lat: 39.7392, lon: -104.9903,
    tz: 'America/Denver',
    unit: 'F',
    nwsStation: 'KDEN',
    wuCountry: 'US',
    pwsStations: ['KCODENVE1252', 'KCODENVE1541'], // KCODENVE1305 (never online) + KCODENVE1144 (1% uptime) removed
  },
  vegas: {
    lat: 36.1699, lon: -115.1398,
    tz: 'America/Los_Angeles',
    unit: 'F',
    nwsStation: 'KLAS',
    wuCountry: 'US',
    pwsStations: ['KNVLASVE611', 'KNVLASVE932', 'KNVNORTH120'], // KNVLASVE1650 replaced — 8% uptime
  },
  'san francisco': {
    lat: 37.7749, lon: -122.4194,
    tz: 'America/Los_Angeles',
    unit: 'F',
    nwsStation: 'KSFO',
    wuCountry: 'US',
    pwsStations: ['KCASANFR1771', 'KCASANFR2206', 'KCASANFR698'],
  },
  'los angeles': {
    lat: 34.0522, lon: -118.2437,
    tz: 'America/Los_Angeles',
    unit: 'F',
    nwsStation: 'KLAX',
    wuCountry: 'US',
    kalshiNwsPriority: true,
    pwsStations: ['KCALOSAN1311', 'KCAGLEND125', 'KCALOSAN815'],
  },
  phoenix: {
    lat: 33.4484, lon: -112.0740,
    tz: 'America/Phoenix',
    unit: 'F',
    nwsStation: 'KPHX',
    wuCountry: 'US',
    pwsStations: ['KAZPHOEN1864', 'KAZLAVEE24'],
  },

  // ── International ─────────────────────────────────────────────────
  london: {
    lat: 51.5074, lon: -0.1278,
    tz: 'Europe/London',
    unit: 'C',
    polymarketStation: 'EGLC',
    wuCountry: 'GB',
    pwsStations: ['ILONDO915', 'ILONDO657', 'ILONDO609'],
  },
  seoul: {
    lat: 37.5665, lon: 126.9780,
    tz: 'Asia/Seoul',
    unit: 'C',
    polymarketStation: 'RKSI',
    wuCountry: 'KR',
    pwsStations: ['IYONGS9'],
  },
  toronto: {
    lat: 43.6532, lon: -79.3832,
    tz: 'America/Toronto',
    unit: 'C',
    polymarketStation: 'CYYZ',
    wuCountry: 'CA',
    pwsStations: ['ITORON152', 'ITORONTO313', 'ITORON207'],
  },
  'buenos aires': {
    lat: -34.6037, lon: -58.3816,
    tz: 'America/Argentina/Buenos_Aires',
    unit: 'C',
    polymarketStation: 'SAEZ',
    wuCountry: 'AR',
    pwsStations: ['ICOMUNA131', 'IBUENO123', 'ICOMUN123'],
  },
  ankara: {
    lat: 39.9334, lon: 32.8597,
    tz: 'Europe/Istanbul',
    unit: 'C',
    polymarketStation: 'LTAC',
    wuCountry: 'TR',
    pwsStations: [],
  },
  wellington: {
    lat: -41.2865, lon: 174.7762,
    tz: 'Pacific/Auckland',
    unit: 'C',
    polymarketStation: 'NZWN',
    wuCountry: 'NZ',
    pwsStations: ['IWELLI407', 'IWELLI522', 'IWELLI36'],
  },
  paris: {
    lat: 48.8566, lon: 2.3522,
    tz: 'Europe/Paris',
    unit: 'C',
    polymarketStation: 'LFPG',
    wuCountry: 'FR',
    pwsStations: ['ISAINT5183', 'IPARIS18247', 'IMALAKOF172'], // IPARIS18258 replaced — dead (invalid JSON)
  },
  'sao paulo': {
    lat: -23.5505, lon: -46.6333,
    tz: 'America/Sao_Paulo',
    unit: 'C',
    polymarketStation: 'SBGR',
    wuCountry: 'BR',
    pwsStations: ['ISOPAU318', 'ISOPAU288', 'ISOPAULO494'],
  },
};

module.exports = cities;
