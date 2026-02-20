#!/usr/bin/env node
/**
 * wu-audit.js — Compare resolved Polymarket trades against Weather Underground
 *
 * Usage: node scripts/wu-audit.js [--date YYYY-MM-DD]
 *
 * Lists all resolved Polymarket trades, shows our actual_temp + station,
 * and provides WU URLs for manual spot-checking.
 *
 * Pre-live requirement: if discrepancies found, build WU scraper as canonical source.
 */

const config = require('../config');
const { query } = require('../lib/db');

const WU_HISTORY_BASE = 'https://www.wunderground.com/history/daily';
const WU_CITY_PATHS = {
  nyc:            'us/ny/new-york-city',
  chicago:        'us/il/chicago',
  miami:          'us/fl/miami',
  atlanta:        'us/ga/atlanta',
  dallas:         'us/tx/dallas',
  seattle:        'us/wa/seattle',
  denver:         'us/co/denver',
  austin:         'us/tx/austin',
  houston:        'us/tx/houston',
  philadelphia:   'us/pa/philadelphia',
  dc:             'us/dc/washington',
  vegas:          'us/nv/las-vegas',
  'new orleans':  'us/la/new-orleans',
  'san francisco':'us/ca/san-francisco',
  'los angeles':  'us/ca/los-angeles',
  phoenix:        'us/az/phoenix',
  boston:          'us/ma/boston',
  london:         'gb/london',
  seoul:          'kr/incheon',
  toronto:        'ca/on/toronto',
  'buenos aires': 'ar/buenos-aires',
  ankara:         'tr/cubuk',
  wellington:     'nz/wellington',
};

function getWUUrl(city, dateStr) {
  const cityPath = WU_CITY_PATHS[city.toLowerCase()];
  if (!cityPath) return null;
  const cityConfig = config.cities[city.toLowerCase()];
  const station = cityConfig?.polymarketStation;
  if (!station) return null;
  const [y, m, d] = dateStr.split('-');
  return `${WU_HISTORY_BASE}/${cityPath}/${station}/date/${y}-${parseInt(m)}-${parseInt(d)}`;
}

(async () => {
  const dateArg = process.argv.find((a, i) => process.argv[i - 1] === '--date');

  let sql = `SELECT id, city, target_date, platform, side, range_name,
                    actual_temp, range_unit, won, pnl, resolution_station, resolved_at
             FROM trades
             WHERE status = $1 AND platform = $2`;
  const params = ['resolved', 'polymarket'];

  if (dateArg) {
    sql += ' AND target_date = $3';
    params.push(dateArg);
  }

  sql += ' ORDER BY resolved_at DESC';

  if (!dateArg) {
    sql += ' LIMIT 30';
  }

  const { data: trades, error } = await query(sql, params);
  if (error) { console.error('DB error:', error.message); process.exit(1); }

  if (!trades || trades.length === 0) {
    console.log('No resolved Polymarket trades found.');
    process.exit(0);
  }

  // Group by city+date for cleaner output
  const groups = new Map();
  for (const t of trades) {
    const key = `${t.city}|${t.target_date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  console.log(`\n  WU Audit: ${trades.length} resolved Polymarket trades\n`);
  console.log('  For each city/date, compare "Our actual" with WU History page.\n');
  console.log('  ' + '='.repeat(78));

  for (const [key, groupTrades] of groups) {
    const [city, date] = key.split('|');
    const wuUrl = getWUUrl(city, date);
    const actual = groupTrades[0].actual_temp;
    const unit = groupTrades[0].range_unit || 'F';
    const station = groupTrades[0].resolution_station || 'unknown';

    console.log(`\n  ${city.toUpperCase()} — ${date}`);
    console.log(`  Our actual: ${actual}°${unit}  (station: ${station})`);
    console.log(`  WU URL: ${wuUrl || 'N/A'}`);
    console.log(`  WU shows: ___°${unit}  (fill in manually)`);
    console.log(`  Match: [ ]`);
    console.log(`  ──`);

    for (const t of groupTrades) {
      const result = t.won ? 'WON' : 'LOST';
      const pnl = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
      console.log(`    ${t.side} ${t.range_name} → ${result} (${pnl})`);
    }
  }

  console.log('\n  ' + '='.repeat(78));
  console.log(`\n  Instructions:`);
  console.log(`  1. Open each WU URL above`);
  console.log(`  2. Find "Max Temperature" in the History table`);
  console.log(`  3. Compare with "Our actual" — should match exactly`);
  console.log(`  4. If any differ by 1°+, note it — this means METAR→WU rounding path diverges\n`);

  process.exit(0);
})();
