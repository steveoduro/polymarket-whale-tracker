/**
 * Database utilities — dual Supabase clients
 *
 * - `db` (anon): Normal operations (select, insert, update) — respects RLS
 * - `dbAdmin` (service_role): Schema changes, RPC, bypass RLS
 *
 * Usage:
 *   const { db, dbAdmin } = require('./lib/db');
 *
 *   // Normal queries
 *   const { data } = await db.from('weather_paper_trades').select('*');
 *
 *   // Schema changes (DDL via rpc)
 *   await dbAdmin.rpc('exec_sql', { query: 'ALTER TABLE ...' });
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
}

// Standard client (anon key, respects RLS)
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Admin client (service_role key, bypasses RLS, can call exec_sql RPC)
let dbAdmin = null;
if (SUPABASE_SERVICE_ROLE_KEY && SUPABASE_SERVICE_ROLE_KEY !== 'PASTE_YOUR_SERVICE_ROLE_KEY_HERE') {
  dbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/**
 * Run raw SQL via Supabase RPC (requires exec_sql function + service_role key)
 *
 * Before first use, create this function in Supabase SQL Editor:
 *
 *   CREATE OR REPLACE FUNCTION exec_sql(query text)
 *   RETURNS json
 *   LANGUAGE plpgsql
 *   SECURITY DEFINER
 *   AS $$
 *   DECLARE result json;
 *   BEGIN
 *     EXECUTE query;
 *     RETURN '{"ok": true}'::json;
 *   EXCEPTION WHEN OTHERS THEN
 *     RETURN json_build_object('error', SQLERRM);
 *   END;
 *   $$;
 *
 * @param {string} sql - Raw SQL to execute
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function execSQL(sql) {
  if (!dbAdmin) {
    throw new Error('dbAdmin not available — set SUPABASE_SERVICE_ROLE_KEY in .env');
  }
  const { data, error } = await dbAdmin.rpc('exec_sql', { query: sql });
  if (error) throw new Error(`execSQL failed: ${error.message}`);
  if (data?.error) throw new Error(`SQL error: ${data.error}`);
  return data;
}

/**
 * Run a SELECT query via RPC and return rows
 */
async function querySQL(sql) {
  if (!dbAdmin) {
    throw new Error('dbAdmin not available — set SUPABASE_SERVICE_ROLE_KEY in .env');
  }
  // Use a separate RPC for queries that return rows
  const { data, error } = await dbAdmin.rpc('query_sql', { query: sql });
  if (error) throw new Error(`querySQL failed: ${error.message}`);
  return data;
}

module.exports = { db, dbAdmin, execSQL, querySQL };
