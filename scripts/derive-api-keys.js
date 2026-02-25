#!/usr/bin/env node
/**
 * derive-api-keys.js — One-shot script to derive Polymarket CLOB API credentials.
 *
 * Usage: node scripts/derive-api-keys.js
 *
 * Reads WALLET_PRIVATE_KEY from .env, derives API key/secret/passphrase,
 * and prints them for pasting into .env.
 */

require('dotenv').config();

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

async function main() {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: WALLET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const { ClobClient } = require('@polymarket/clob-client');
  const { Wallet } = require('ethers');

  const signer = new Wallet(privateKey);
  console.log(`Wallet address: ${signer.address}`);
  console.log('Deriving API credentials...\n');

  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();

  console.log('Add these to your .env file:\n');
  console.log(`POLY_API_KEY=${creds.key}`);
  console.log(`POLY_API_SECRET=${creds.secret}`);
  console.log(`POLY_API_PASSPHRASE=${creds.passphrase}`);
  console.log(`POLY_FUNDER_ADDRESS=0xFCa1550b3773270fdc6757495E09bda50522C1be`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
