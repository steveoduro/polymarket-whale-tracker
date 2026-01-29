require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 30000;
const ALERT_MIN_SIZE = parseFloat(process.env.ALERT_MIN_SIZE) || 100;
const NODE_ENV = process.env.NODE_ENV || 'development';
const startTime = Date.now();

// =============================================================================
// STRUCTURED LOGGING
// =============================================================================

function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  if (NODE_ENV === 'production') {
    console.log(JSON.stringify(entry));
  } else {
    const prefix = { info: '[INFO]', warn: '[WARN]', error: '[ERROR]' }[level] || `[${level.toUpperCase()}]`;
    const extra = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
    console.log(`${prefix} ${message}${extra}`);
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Request logging in production
if (NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path === '/health' || req.path === '/api/health') return;
      log('info', `${req.method} ${req.path}`, { status: res.statusCode, ms: Date.now() - start });
    });
    next();
  });
}

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// =============================================================================
// POLYMARKET API CONSTANTS & POLLING STATE
// =============================================================================

const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// =============================================================================
// KNOWN WHALES (curated list — no public leaderboard API exists)
// =============================================================================

const KNOWN_WHALES = [
  {
    address: '0xe00740bce98a594e26861838885ab310ec3b548c',
    username: 'distinct-baguette',
    notes: 'High-frequency 15-min crypto arbitrage trader',
    tags: ['crypto', 'high-frequency'],
  },
  {
    address: '0x38cc1d1f95d12039324809d8bb6ca6da6cbef88e',
    username: 'NoonienSoong',
    notes: '92% win rate, weather markets specialist',
    tags: ['weather', 'high-win-rate'],
  },
  {
    address: '0x08cf0b0fec3d42d9920bb0dfbc49fde635088cbc',
    username: 'HondaCivic',
    notes: '67% win rate, weather markets',
    tags: ['weather'],
  },
  {
    address: '0x2ec681d5cbf2ba6d1e8f0e87b2e6026b0bc438c8',
    username: 'micro88so8z',
    notes: '100% win rate, BTC markets specialist',
    tags: ['crypto', 'btc', 'high-win-rate'],
  },
  {
    address: '0x1b1cbe20e69e29c475e5f57fbb0d8f19f7cc7878',
    username: 'Theo4',
    notes: 'Largest Polymarket trader, $60M+ portfolio, political + crypto markets',
    tags: ['politics', 'crypto', 'whale'],
  },
  {
    address: '0x76e7e5a5ba82b498e84632bebc1acf1e0d8bcc67',
    username: 'SilverRocket',
    notes: 'Top election market trader, $15M+ profit on 2024 elections',
    tags: ['politics', 'elections'],
  },
  {
    address: '0xd91efec39f13b39e97caee1eda5e3e871bdcab4a',
    username: 'kch123',
    notes: 'Sports market maker, $8.5M+ profit, high win rate',
    tags: ['sports', 'market-maker'],
  },
  {
    address: '0x02afc3a58f375d4a10ee6f8235c0e8277ddce6f6',
    username: 'PrincessCaro',
    notes: 'Large political and crypto trader, concentrated positions',
    tags: ['politics', 'crypto'],
  },
  {
    address: '0x4861bca7e8026df8b6e7a0b7e7105e59c3f27db6',
    username: 'LainInTheWired',
    notes: 'Active crypto markets trader, BTC/ETH predictions',
    tags: ['crypto'],
  },
  {
    address: '0x52d793fd846be0bca3b4a719b609fb18ea2b2dbc',
    username: 'JackSparrow',
    notes: 'Large volume trader across multiple categories',
    tags: ['politics', 'crypto', 'whale'],
  },
  {
    address: '0x3b82ae2dfc4a6002c2e1abd828f2e7e70ab0caff',
    username: 'Dbrody',
    notes: 'Political markets specialist, concentrated election bets',
    tags: ['politics', 'elections'],
  },
];

let pollingTimer = null;
let lastPollTimestamp = null;
let pollErrors = 0;
let currentBackoffMs = 0;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

async function fetchWalletActivity(address, sinceTimestamp) {
  const params = new URLSearchParams({
    user: address,
    type: 'TRADE',
    limit: '100',
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  });
  if (sinceTimestamp) {
    params.set('start', String(sinceTimestamp));
  }
  const url = `${POLYMARKET_DATA_API}/activity?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    log('warn', 'Polymarket API error', { status: resp.status, address });
    throw new Error(`Polymarket API ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

// --- Alert Queue (rate-limited: max 1 message per 10 seconds) ---
const alertQueue = [];
let alertQueueTimer = null;
const ALERT_RATE_LIMIT_MS = 10000;
let lastAlertSentAt = 0;

function formatTradeAlert(trade, wallet) {
  const label = wallet.nickname || wallet.username || wallet.address.slice(0, 10);
  const sizeUsd = parseFloat(trade.size) || 0;
  const priceCents = (parseFloat(trade.price) * 100).toFixed(1);
  const time = new Date(trade.timestamp).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
  });
  const slug = trade.market_slug || '';
  const polymarketLink = slug
    ? `[View on Polymarket](https://polymarket.com/event/${slug})`
    : '';

  return [
    `🐋 *WHALE ALERT: ${label}*`,
    `📊 Market: ${trade.market_question}`,
    `💰 Action: ${trade.side} ${trade.outcome}`,
    `📈 Size: $${sizeUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} @ ${priceCents}¢`,
    `⏰ Time: ${time} ET`,
    polymarketLink,
  ].filter(Boolean).join('\n');
}

async function sendTelegramMessage(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      log('error', 'Telegram API error', { status: resp.status, body });
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    log('error', 'Telegram send failed', { error: err.message });
    return 'failed';
  }
}

function enqueueAlert(trade, wallet, tradeDbId) {
  alertQueue.push({ trade, wallet, tradeDbId });
  if (!alertQueueTimer) {
    scheduleAlertFlush();
  }
}

function scheduleAlertFlush() {
  const elapsed = Date.now() - lastAlertSentAt;
  const delay = Math.max(ALERT_RATE_LIMIT_MS - elapsed, 0);
  alertQueueTimer = setTimeout(flushNextAlert, delay);
}

async function flushNextAlert() {
  alertQueueTimer = null;
  if (alertQueue.length === 0) return;

  const { trade, wallet, tradeDbId } = alertQueue.shift();
  log('info', 'Sending alert', { size: trade.size, market: trade.market_question?.slice(0, 50), remaining: alertQueue.length });

  const text = formatTradeAlert(trade, wallet);
  const status = await sendTelegramMessage(text);
  lastAlertSentAt = Date.now();
  if (status) {
    await logAlert(tradeDbId, status, status === 'failed' ? 'Telegram API error' : null);
  }

  // Schedule next if queue has more
  if (alertQueue.length > 0) {
    scheduleAlertFlush();
  }
}

async function flushAlertQueue() {
  // Drain remaining queue (used during shutdown)
  while (alertQueue.length > 0) {
    const { trade, wallet, tradeDbId } = alertQueue.shift();
    const text = formatTradeAlert(trade, wallet);
    const status = await sendTelegramMessage(text);
    if (status) {
      await logAlert(tradeDbId, status, status === 'failed' ? 'Telegram API error' : null);
    }
  }
}

async function logAlert(tradeId, status, errorMessage) {
  try {
    await supabase.from('alerts_log').insert({
      trade_id: tradeId,
      alert_type: 'telegram',
      status,
      error_message: errorMessage || null,
    });
  } catch (err) {
    log('error', 'Failed to log alert', { error: err.message });
  }
}

// =============================================================================
// CORE POLLING FUNCTIONS
// =============================================================================

async function pollWalletTrades(wallet) {
  // Get the most recent trade timestamp for this wallet
  const { data: latestTrade } = await supabase
    .from('trades')
    .select('timestamp')
    .eq('wallet_id', wallet.id)
    .order('timestamp', { ascending: false })
    .limit(1)
    .single();

  const sinceTimestamp = latestTrade
    ? Math.floor(new Date(latestTrade.timestamp).getTime() / 1000)
    : null;

  const activities = await fetchWalletActivity(wallet.address, sinceTimestamp);
  if (!Array.isArray(activities) || activities.length === 0) return 0;

  let newCount = 0;

  for (const act of activities) {
    const tradeId = `${act.transactionHash}-${act.conditionId || ''}-${act.outcomeIndex ?? ''}`;
    const tradeRecord = {
      wallet_id: wallet.id,
      polymarket_trade_id: tradeId,
      market_slug: act.slug || null,
      market_question: act.title || null,
      outcome: act.outcome || null,
      side: act.side || null,
      price: act.price != null ? parseFloat(act.price) : null,
      size: act.usdcSize != null ? parseFloat(act.usdcSize) : null,
      timestamp: new Date(act.timestamp * 1000).toISOString(),
      raw_data: act,
    };

    const { data: inserted, error } = await supabase
      .from('trades')
      .upsert(tradeRecord, { onConflict: 'polymarket_trade_id', ignoreDuplicates: true })
      .select('id')
      .maybeSingle();

    if (error) {
      // Duplicate or conflict — skip silently
      if (error.code === '23505') continue;
      log('warn', 'Trade insert error', { tradeId, error: error.message });
      continue;
    }

    if (inserted) {
      newCount++;
      const usdcSize = parseFloat(act.usdcSize) || 0;
      if (usdcSize >= ALERT_MIN_SIZE) {
        enqueueAlert(tradeRecord, wallet, inserted.id);
      }
    }
  }

  return newCount;
}

async function runPollCycle() {
  log('info', 'Poll cycle starting');

  try {
    const { data: wallets, error } = await supabase
      .from('tracked_wallets')
      .select('*')
      .eq('is_active', true);

    if (error) throw error;
    if (!wallets || wallets.length === 0) {
      log('info', 'No active wallets to poll');
      lastPollTimestamp = new Date().toISOString();
      return;
    }

    let totalNew = 0;
    for (const wallet of wallets) {
      try {
        const count = await pollWalletTrades(wallet);
        if (count > 0) {
          log('info', 'New trades found', { wallet: wallet.nickname || wallet.address, count });
        }
        totalNew += count;
      } catch (err) {
        log('error', 'Wallet poll error', { wallet: wallet.nickname || wallet.address, error: err.message });
      }
    }

    // Cycle succeeded (individual wallet errors don't count)
    pollErrors = 0;
    currentBackoffMs = 0;
    lastPollTimestamp = new Date().toISOString();
    log('info', 'Poll cycle complete', { newTrades: totalNew, wallets: wallets.length });
  } catch (err) {
    pollErrors++;
    currentBackoffMs = Math.min(1000 * Math.pow(2, pollErrors), 300000);
    log('error', 'Poll cycle failed', { errorCount: pollErrors, backoffMs: currentBackoffMs, error: err.message });
  }
}

function startPolling() {
  if (pollingTimer) {
    log('info', 'Polling already running');
    return;
  }
  log('info', 'Starting poller', { intervalMs: POLL_INTERVAL_MS, alertMinSize: ALERT_MIN_SIZE });
  runPollCycle();
  pollingTimer = setInterval(async () => {
    if (currentBackoffMs > 0) {
      log('warn', 'Backing off before poll', { backoffMs: currentBackoffMs });
      await new Promise(r => setTimeout(r, currentBackoffMs));
    }
    runPollCycle();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    log('info', 'Polling stopped');
  }
}

// =============================================================================
// DAILY CLEANUP (Supabase free tier: 500MB)
// =============================================================================

const TRADE_RETENTION_DAYS = parseInt(process.env.TRADE_RETENTION_DAYS) || 7;
let cleanupTimer = null;

async function runCleanup() {
  const cutoff = new Date(Date.now() - TRADE_RETENTION_DAYS * 86400000).toISOString();
  try {
    // Delete old alerts first (FK reference)
    const { count: alertCount } = await supabase
      .from('alerts_log')
      .delete()
      .lt('sent_at', cutoff)
      .select('*', { count: 'exact', head: true });

    // Delete old trades
    const { count: tradeCount } = await supabase
      .from('trades')
      .delete()
      .lt('timestamp', cutoff)
      .select('*', { count: 'exact', head: true });

    log('info', 'Daily cleanup complete', { cutoff, deletedTrades: tradeCount || 0, deletedAlerts: alertCount || 0 });
  } catch (err) {
    log('error', 'Cleanup failed', { error: err.message });
  }
}

function startCleanupSchedule() {
  // Run once on startup, then every 24 hours
  runCleanup();
  cleanupTimer = setInterval(runCleanup, 24 * 60 * 60 * 1000);
}

function stopCleanupSchedule() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

app.get('/api/health', async (req, res) => {
  let walletCount = 0;
  try {
    const { count } = await supabase
      .from('tracked_wallets')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);
    walletCount = count || 0;
  } catch { /* ignore */ }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    polling: {
      running: pollingTimer !== null,
      lastPoll: lastPollTimestamp,
      consecutiveErrors: pollErrors,
      currentBackoffMs,
    },
    trackedWallets: walletCount,
  });
});

// =============================================================================
// TRACKED WALLETS
// =============================================================================

// Get all tracked wallets
app.get('/api/wallets', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tracked_wallets')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    log('error', 'Error fetching wallets', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Add a wallet
app.post('/api/wallets/add', async (req, res) => {
  try {
    const { address, username, nickname, notes } = req.body;

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    // Auto-fill username from Gamma API if not provided
    let resolvedUsername = username;
    if (!resolvedUsername) {
      try {
        const profileResp = await fetch(`${GAMMA_API}/public-profile?address=${address.toLowerCase()}`);
        if (profileResp.ok) {
          const profile = await profileResp.json();
          resolvedUsername = profile.name || profile.pseudonym || null;
        }
      } catch {
        // Gamma lookup failed — proceed without username
      }
    }

    const { data, error } = await supabase
      .from('tracked_wallets')
      .insert({
        address: address.toLowerCase(),
        username: resolvedUsername,
        nickname,
        notes
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Wallet already exists' });
      }
      throw error;
    }

    res.json(data);
  } catch (err) {
    log('error', 'Error adding wallet', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Update a wallet
app.patch('/api/wallets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username, nickname, notes, is_active } = req.body;

    const { data, error } = await supabase
      .from('tracked_wallets')
      .update({
        username,
        nickname,
        notes,
        is_active,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    log('error', 'Error updating wallet', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Delete a wallet
app.delete('/api/wallets/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('tracked_wallets')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    log('error', 'Error deleting wallet', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// TRADES
// =============================================================================

// Get recent trades (with optional wallet filter)
app.get('/api/trades', async (req, res) => {
  try {
    const { wallet_id, limit = 50 } = req.query;

    let query = supabase
      .from('trades')
      .select(`
        *,
        tracked_wallets (address, nickname, username)
      `)
      .order('timestamp', { ascending: false })
      .limit(parseInt(limit));

    if (wallet_id) {
      query = query.eq('wallet_id', wallet_id);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (err) {
    log('error', 'Error fetching trades', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// APP SETTINGS
// =============================================================================

// Get a setting
app.get('/api/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;

    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    res.json(data?.value || null);
  } catch (err) {
    log('error', 'Error fetching setting', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Update a setting
app.put('/api/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    const { data, error } = await supabase
      .from('app_settings')
      .upsert({
        key,
        value,
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    log('error', 'Error updating setting', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// WALLET DISCOVERY
// =============================================================================

// Get known whales with tracking status
app.get('/api/discover/top-traders', async (req, res) => {
  try {
    // Get already-tracked addresses
    const { data: tracked } = await supabase
      .from('tracked_wallets')
      .select('address');
    const trackedSet = new Set((tracked || []).map(w => w.address));

    // Enrich each known whale with Gamma profile data (cached in-memory)
    const results = await Promise.all(KNOWN_WHALES.map(async (whale) => {
      let profileData = {};
      try {
        const resp = await fetch(`${GAMMA_API}/public-profile?address=${whale.address}`);
        if (resp.ok) profileData = await resp.json();
      } catch { /* skip */ }

      return {
        address: whale.address,
        username: profileData.name || whale.username,
        pseudonym: profileData.pseudonym || null,
        notes: whale.notes,
        tags: whale.tags,
        isTracked: trackedSet.has(whale.address),
        profileCreated: profileData.createdAt || null,
      };
    }));

    res.json(results);
  } catch (err) {
    log('error', 'Error fetching top traders', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// WALLET STATS
// =============================================================================

app.get('/api/wallets/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify wallet exists
    const { data: wallet, error: wErr } = await supabase
      .from('tracked_wallets')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (wErr) throw wErr;
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    // Get all trades for this wallet
    const { data: trades, error: tErr } = await supabase
      .from('trades')
      .select('*')
      .eq('wallet_id', id)
      .order('timestamp', { ascending: false });
    if (tErr) throw tErr;

    if (!trades || trades.length === 0) {
      return res.json({
        wallet,
        totalTrades: 0,
        totalVolume: 0,
        avgTradeSize: 0,
        buyCount: 0,
        sellCount: 0,
        topMarkets: [],
        hourlyActivity: new Array(24).fill(0),
        recentTrades: [],
      });
    }

    const totalVolume = trades.reduce((s, t) => s + (parseFloat(t.size) || 0), 0);
    const buyTrades = trades.filter(t => t.side === 'BUY');
    const sellTrades = trades.filter(t => t.side === 'SELL');

    // Top markets by volume
    const marketVol = {};
    trades.forEach(t => {
      const q = t.market_question || 'Unknown';
      if (!marketVol[q]) marketVol[q] = { question: q, slug: t.market_slug, volume: 0, count: 0 };
      marketVol[q].volume += parseFloat(t.size) || 0;
      marketVol[q].count++;
    });
    const topMarkets = Object.values(marketVol)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10);

    // Hourly activity pattern (UTC hours)
    const hourlyActivity = new Array(24).fill(0);
    trades.forEach(t => {
      const hour = new Date(t.timestamp).getUTCHours();
      hourlyActivity[hour]++;
    });

    // Win rate estimate: BUY at <50c or SELL at >50c suggests a directional bet.
    // Trades where outcome price moved toward 100c (resolved YES) count as "wins".
    // This is a rough heuristic since we don't have resolution data.
    const highConfBuys = buyTrades.filter(t => parseFloat(t.price) >= 0.6).length;
    const lowConfSells = sellTrades.filter(t => parseFloat(t.price) <= 0.4).length;
    const directionalTrades = highConfBuys + lowConfSells;
    const winRateEstimate = trades.length > 0
      ? ((directionalTrades / trades.length) * 100).toFixed(1)
      : null;

    res.json({
      wallet,
      totalTrades: trades.length,
      totalVolume,
      avgTradeSize: totalVolume / trades.length,
      buyCount: buyTrades.length,
      sellCount: sellTrades.length,
      buyVolume: buyTrades.reduce((s, t) => s + (parseFloat(t.size) || 0), 0),
      sellVolume: sellTrades.reduce((s, t) => s + (parseFloat(t.size) || 0), 0),
      highConvictionPct: winRateEstimate,
      topMarkets,
      hourlyActivity,
      firstTrade: trades[trades.length - 1]?.timestamp,
      lastTrade: trades[0]?.timestamp,
      recentTrades: trades.slice(0, 10),
    });
  } catch (err) {
    log('error', 'Error fetching wallet stats', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// POLLING CONTROL
// =============================================================================

app.post('/api/polling/start', (req, res) => {
  startPolling();
  res.json({ status: 'polling started' });
});

app.post('/api/polling/stop', (req, res) => {
  stopPolling();
  res.json({ status: 'polling stopped' });
});

// =============================================================================
// ALERTS
// =============================================================================

// Send a test alert
app.post('/api/alerts/test', async (req, res) => {
  try {
    const testTrade = {
      side: 'BUY',
      outcome: 'Yes',
      price: 0.65,
      size: 500,
      market_question: 'Test Market — Will this alert work?',
      market_slug: '',
      timestamp: new Date().toISOString(),
    };
    const testWallet = { nickname: 'Test Whale', address: '0x0000000000' };

    const text = formatTradeAlert(testTrade, testWallet);
    const status = await sendTelegramMessage(text);

    if (status === 'sent') {
      res.json({ success: true, message: 'Test alert sent to Telegram' });
    } else if (status === null) {
      res.status(400).json({ error: 'Telegram not configured (missing BOT_TOKEN or CHAT_ID)' });
    } else {
      res.status(502).json({ error: 'Telegram API returned an error' });
    }
  } catch (err) {
    log('error', 'Error sending test alert', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get recent alerts (history)
app.get('/api/alerts/history', async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const { data, error } = await supabase
      .from('alerts_log')
      .select(`
        *,
        trades (market_question, outcome, side, size)
      `)
      .order('sent_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;
    res.json(data);
  } catch (err) {
    log('error', 'Error fetching alert history', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get recent alerts (legacy endpoint)
app.get('/api/alerts', async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const { data, error } = await supabase
      .from('alerts_log')
      .select(`
        *,
        trades (market_question, outcome, side, size)
      `)
      .order('sent_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;
    res.json(data);
  } catch (err) {
    log('error', 'Error fetching alerts', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// COPY TRADING STATS (Phase 2)
// =============================================================================

// Get per-whale performance
app.get('/api/copier/whale-performance', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('my_trades')
      .select('copied_from_whale, copied_from_address, pnl, size, status, created_at')
      .in('status', ['paper', 'filled', 'pending']);

    if (error) throw error;

    // Aggregate by whale
    const whaleStats = {};
    for (const trade of data || []) {
      const whale = trade.copied_from_whale || 'unknown';
      if (!whaleStats[whale]) {
        whaleStats[whale] = {
          whale,
          address: trade.copied_from_address,
          totalTrades: 0,
          wins: 0,
          losses: 0,
          pending: 0,
          totalVolume: 0,
          totalPnL: 0,
          firstTrade: trade.created_at,
          lastTrade: trade.created_at,
        };
      }
      const stats = whaleStats[whale];
      stats.totalTrades++;
      stats.totalVolume += parseFloat(trade.size) || 0;
      if (trade.pnl !== null) {
        stats.totalPnL += parseFloat(trade.pnl) || 0;
        if (trade.pnl > 0) stats.wins++;
        else if (trade.pnl < 0) stats.losses++;
      } else {
        stats.pending++;
      }
      if (trade.created_at < stats.firstTrade) stats.firstTrade = trade.created_at;
      if (trade.created_at > stats.lastTrade) stats.lastTrade = trade.created_at;
    }

    // Calculate win rates and format
    const results = Object.values(whaleStats).map(s => ({
      ...s,
      winRate: s.wins + s.losses > 0
        ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) + '%'
        : 'N/A',
      avgPnL: s.wins + s.losses > 0
        ? (s.totalPnL / (s.wins + s.losses)).toFixed(2)
        : 0,
    }));

    // Sort by P&L descending
    results.sort((a, b) => b.totalPnL - a.totalPnL);

    res.json(results);
  } catch (err) {
    log('error', 'Error fetching whale performance', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get recent copy trades
app.get('/api/copier/trades', async (req, res) => {
  try {
    const { limit = 50, whale } = req.query;

    let query = supabase
      .from('my_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (whale) {
      query = query.eq('copied_from_whale', whale);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (err) {
    log('error', 'Error fetching copy trades', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Get copy trading summary
app.get('/api/copier/summary', async (req, res) => {
  try {
    const { data: trades, error } = await supabase
      .from('my_trades')
      .select('pnl, size, status')
      .in('status', ['paper', 'filled', 'pending']);

    if (error) throw error;

    let totalTrades = 0, wins = 0, losses = 0, pending = 0;
    let totalVolume = 0, totalPnL = 0;

    for (const t of trades || []) {
      totalTrades++;
      totalVolume += parseFloat(t.size) || 0;
      if (t.pnl !== null) {
        totalPnL += parseFloat(t.pnl) || 0;
        if (t.pnl > 0) wins++;
        else if (t.pnl < 0) losses++;
      } else {
        pending++;
      }
    }

    res.json({
      totalTrades,
      wins,
      losses,
      pending,
      totalVolume,
      totalPnL,
      winRate: wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) + '%' : 'N/A',
      avgPnL: wins + losses > 0 ? (totalPnL / (wins + losses)).toFixed(2) : 0,
    });
  } catch (err) {
    log('error', 'Error fetching copier summary', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// RENDER HEALTH CHECK (simple, for uptime monitoring)
// =============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    env: NODE_ENV,
  });
});

// =============================================================================
// START SERVER
// =============================================================================

const server = app.listen(PORT, () => {
  log('info', 'Server started', { port: PORT, env: NODE_ENV, pollInterval: POLL_INTERVAL_MS, alertMinSize: ALERT_MIN_SIZE, retentionDays: TRADE_RETENTION_DAYS });
  startPolling();
  startCleanupSchedule();
});

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

async function shutdown(signal) {
  log('info', 'Shutdown initiated', { signal });

  // Stop accepting new requests
  server.close(() => {
    log('info', 'HTTP server closed');
  });

  // Stop polling and cleanup
  stopPolling();
  stopCleanupSchedule();

  // Flush any pending alerts
  if (alertQueue.length > 0) {
    log('info', 'Flushing pending alerts before shutdown', { count: alertQueue.length });
    await flushAlertQueue();
  }

  log('info', 'Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
