/**
 * Database utilities — PostgreSQL via node-postgres (pg)
 *
 * Exports:
 *   query(sql, params)    → { data: rows[], error, count }
 *   queryOne(sql, params) → { data: row|null, error }
 *   execSQL(sql)          → direct execution (DDL/DML)
 *   querySQL(sql)         → returns rows (raw SELECT)
 *   pool                  → raw pg Pool (for transactions if needed)
 */

const pg = require('pg');
const { Pool } = pg;
require('dotenv').config();

// Parse numeric (OID 1700) as JS float instead of string.
// node-postgres returns numeric as strings for arbitrary precision,
// but our values are normal floats and all code expects numbers.
pg.types.setTypeParser(1700, (val) => parseFloat(val));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL in .env');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err.message);
});

/**
 * Run a parameterized query. Returns { data, error, count }.
 * Matches the Supabase { data, error } pattern for easy migration.
 */
async function query(sql, params = []) {
  try {
    const result = await pool.query(sql, params);
    return { data: result.rows, error: null, count: result.rowCount };
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Run a query expecting a single row (e.g. INSERT ... RETURNING id).
 * Returns { data: row|null, error }.
 */
async function queryOne(sql, params = []) {
  try {
    const result = await pool.query(sql, params);
    return { data: result.rows[0] || null, error: null };
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Execute raw SQL (DDL/DML) — replaces Supabase exec_sql RPC.
 */
async function execSQL(sql) {
  try {
    await pool.query(sql);
    return { ok: true };
  } catch (err) {
    throw new Error(`execSQL failed: ${err.message}`);
  }
}

/**
 * Run raw SQL SELECT and return rows — replaces Supabase query_sql RPC.
 */
async function querySQL(sql) {
  try {
    const result = await pool.query(sql);
    return result.rows;
  } catch (err) {
    throw new Error(`querySQL failed: ${err.message}`);
  }
}

module.exports = { query, queryOne, execSQL, querySQL, pool };
