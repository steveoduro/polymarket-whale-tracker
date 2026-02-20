#!/usr/bin/env node
/**
 * Backfill our_probability on historical opportunities using fixed normalCDF.
 *
 * Bug context:
 * - Old normalCDF used exp(-x²/2) with A&S erfc coefficients (designed for exp(-z²))
 * - Fix: z = |x|/√2, then exp(-z*z)
 * - Old empirical CDF used per-source errors (inflated 1.5-2x); now uses ensemble_corrected
 * - Old cityStdDevs used per-source data instead of ensemble
 *
 * This script recalculates our_probability, edge_pct, kelly_fraction,
 * expected_value, corrected_probability, and analysis flags for all
 * model_valid=false opportunities using the fixed formula.
 */

const { Pool } = require('pg');
require('dotenv').config();

const KELLY_FRACTION = 0.5;
const BATCH_SIZE = 5000;

// ── Fixed normalCDF (Abramowitz & Stegun 7.1.26) ──
function normalCDF(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

function fahrenheitToCelsius(f) { return (f - 32) * 5 / 9; }

function calculateProbability(forecastTemp, stdDevC, rangeMin, rangeMax, unit) {
  // Convert to Celsius
  const meanC = unit === 'F' ? fahrenheitToCelsius(forecastTemp) : forecastTemp;
  const minC = rangeMin == null ? -Infinity : (unit === 'F' ? fahrenheitToCelsius(rangeMin) : rangeMin);
  const maxC = rangeMax == null ? Infinity : (unit === 'F' ? fahrenheitToCelsius(rangeMax) : rangeMax);

  if (minC === -Infinity && maxC === Infinity) return 1;
  if (minC === -Infinity) return normalCDF((maxC - meanC) / stdDevC);
  if (maxC === Infinity) return 1 - normalCDF((minC - meanC) / stdDevC);

  const p = normalCDF((maxC - meanC) / stdDevC) - normalCDF((minC - meanC) / stdDevC);
  return Math.min(1, Math.max(0, p));
}

function getEntryFee(platform, price) {
  if (platform === 'kalshi') {
    return 0.07 * price * (1 - price);
  }
  return 0;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Count total rows to process
    const { rows: [{ count: totalStr }] } = await pool.query(
      `SELECT count(*) FROM opportunities WHERE model_valid = false`
    );
    const total = parseInt(totalStr);
    console.log(`Backfilling ${total} opportunities...`);

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // Process in batches using cursor pattern
    let lastId = '00000000-0000-0000-0000-000000000000';

    while (true) {
      const { rows } = await pool.query(`
        SELECT id, city, platform, side, forecast_temp, ensemble_std_dev,
               range_min, range_max, range_unit, range_type, ask, bid,
               our_probability as old_probability, edge_pct as old_edge,
               correction_ratio as old_correction_ratio
        FROM opportunities
        WHERE model_valid = false AND id > $1
        ORDER BY id
        LIMIT $2
      `, [lastId, BATCH_SIZE]);

      if (rows.length === 0) break;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (const row of rows) {
          processed++;
          lastId = row.id;

          const { forecast_temp, ensemble_std_dev, range_min, range_max, range_unit, side, ask, bid, platform } = row;

          // Skip if missing critical data
          if (forecast_temp == null || ensemble_std_dev == null || ensemble_std_dev <= 0) {
            skipped++;
            continue;
          }

          try {
            // Calculate YES probability
            const yesProbability = calculateProbability(
              Number(forecast_temp), Number(ensemble_std_dev),
              range_min != null ? Number(range_min) : null,
              range_max != null ? Number(range_max) : null,
              range_unit
            );

            let ourProbability, edgePct, effectiveCost, kelly, ev;

            if (side === 'YES') {
              ourProbability = yesProbability;

              if (ask == null || Number(ask) <= 0 || Number(ask) >= 1) {
                skipped++;
                continue;
              }

              // No correction_ratio in backfill — set to 1.0 (model_calibration was contaminated)
              const correctedProbability = ourProbability;
              const correctionRatio = 1.0;

              const askN = Number(ask);
              edgePct = (correctedProbability - askN) * 100;

              const entryFee = getEntryFee(platform, askN);
              effectiveCost = askN + entryFee;
              const payout = 1.0;
              ev = correctedProbability * payout - effectiveCost;

              const netProfit = payout - effectiveCost;
              const kellyFull = correctedProbability > 0 && netProfit > 0
                ? ((netProfit / effectiveCost) * correctedProbability - (1 - correctedProbability)) / (netProfit / effectiveCost)
                : 0;
              kelly = Math.max(0, kellyFull * KELLY_FRACTION);

              await client.query(`
                UPDATE opportunities SET
                  our_probability = $1,
                  corrected_probability = $2,
                  correction_ratio = $3,
                  edge_pct = $4,
                  expected_value = $5,
                  kelly_fraction = $6,
                  would_pass_at_5pct = $7,
                  would_pass_at_8pct = $8,
                  would_pass_at_10pct = $9,
                  would_pass_at_15pct = $10,
                  model_valid = true
                WHERE id = $11
              `, [
                Math.round(ourProbability * 10000) / 10000,
                Math.round(correctedProbability * 10000) / 10000,
                correctionRatio,
                Math.round(edgePct * 100) / 100,
                Math.round(ev * 10000) / 10000,
                Math.round(kelly * 10000) / 10000,
                edgePct >= 5,
                edgePct >= 8,
                edgePct >= 10,
                edgePct >= 15,
                row.id
              ]);
            } else {
              // NO side
              ourProbability = Math.min(1, Math.max(0, 1 - yesProbability));

              if (bid == null || Number(bid) <= 0 || Number(bid) >= 1) {
                skipped++;
                continue;
              }

              const bidN = Number(bid);
              const noAsk = 1 - bidN;
              if (noAsk <= 0 || noAsk >= 1) {
                skipped++;
                continue;
              }

              edgePct = (ourProbability - noAsk) * 100;

              const entryFee = getEntryFee(platform, noAsk);
              effectiveCost = noAsk + entryFee;
              const payout = 1.0;
              ev = ourProbability * payout - effectiveCost;

              const netProfit = payout - effectiveCost;
              const kellyFull = ourProbability > 0 && netProfit > 0
                ? ((netProfit / effectiveCost) * ourProbability - (1 - ourProbability)) / (netProfit / effectiveCost)
                : 0;
              kelly = Math.max(0, kellyFull * KELLY_FRACTION);

              await client.query(`
                UPDATE opportunities SET
                  our_probability = $1,
                  edge_pct = $2,
                  expected_value = $3,
                  kelly_fraction = $4,
                  would_pass_at_5pct = $5,
                  would_pass_at_8pct = $6,
                  would_pass_at_10pct = $7,
                  would_pass_at_15pct = $8,
                  model_valid = true
                WHERE id = $9
              `, [
                Math.round(ourProbability * 10000) / 10000,
                Math.round(edgePct * 100) / 100,
                Math.round(ev * 10000) / 10000,
                Math.round(kelly * 10000) / 10000,
                edgePct >= 5,
                edgePct >= 8,
                edgePct >= 10,
                edgePct >= 15,
                row.id
              ]);
            }

            updated++;
          } catch (err) {
            errors++;
            if (errors <= 5) {
              console.error(`Error on row ${row.id}:`, err.message);
            }
          }
        }

        await client.query('COMMIT');
      } catch (commitErr) {
        await client.query('ROLLBACK');
        throw commitErr;
      } finally {
        client.release();
      }

      const pct = Math.round(processed / total * 100);
      process.stdout.write(`\r  ${processed}/${total} (${pct}%) — ${updated} updated, ${skipped} skipped, ${errors} errors`);
    }

    console.log(`\n\nDone! Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);

    // Verify: sample before/after
    console.log('\n── Sample verification (first 5 resolved YES opportunities) ──');
    const { rows: samples } = await pool.query(`
      SELECT city, range_unit, forecast_temp, ensemble_std_dev,
             range_min, range_max, side, ask, our_probability,
             edge_pct, would_have_won, model_valid
      FROM opportunities
      WHERE model_valid = true AND would_have_won IS NOT NULL AND side = 'YES'
      ORDER BY created_at DESC LIMIT 5
    `);
    for (const s of samples) {
      console.log(`  ${s.city} ${s.range_min}-${s.range_max}°${s.range_unit} ${s.side}: prob=${s.our_probability} edge=${s.edge_pct}% won=${s.would_have_won}`);
    }

    // Count remaining invalid
    const { rows: [{ count: remaining }] } = await pool.query(
      `SELECT count(*) FROM opportunities WHERE model_valid = false`
    );
    console.log(`\nRemaining model_valid=false: ${remaining}`);

  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
