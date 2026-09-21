const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'players.json');

// ---------------------------------------------------------------------------
// Tiny JSON-file datastore: everything lives in memory, flushed to disk on a
// debounce so a burst of autosaves doesn't hammer the filesystem.
// ---------------------------------------------------------------------------
let players = {};

function loadDb() {
  try {
    players = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    players = {};
  }
}

function flushToDisk() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(players));
  fs.renameSync(tmp, DB_FILE);
}

let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      flushToDisk();
    } catch (err) {
      console.error('flush failed:', err.message);
    }
  }, 2000);
}

loadDb();

// ---------------------------------------------------------------------------
// Production middleware: proxy awareness, security headers, rate limiting
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'",
  });
  next();
});

// Simple fixed-window rate limit per IP on the API — generous enough for the
// game's autosave cadence, tight enough to stop abuse.
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 300); // requests/minute
const rateBuckets = new Map();
setInterval(() => rateBuckets.clear(), 60000).unref();

app.use('/api', (req, res, next) => {
  const key = req.ip;
  const count = (rateBuckets.get(key) || 0) + 1;
  rateBuckets.set(key, count);
  if (count > RATE_LIMIT) {
    return res.status(429).json({ error: 'too many requests' });
  }
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const MAX_NAME_LEN = 20;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 100000);

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[^\w \-\.]/g, '').trim().slice(0, MAX_NAME_LEN);
  return name.length >= 1 ? name : null;
}

function cleanNumber(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function cleanState(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const buildings = {};
  if (typeof raw.buildings === 'object' && raw.buildings !== null) {
    for (const [k, v] of Object.entries(raw.buildings)) {
      if (/^[a-z0-9_]{1,32}$/.test(k)) {
        buildings[k] = Math.min(1e6, Math.floor(cleanNumber(v)));
      }
    }
  }
  return {
    cycles: cleanNumber(raw.cycles),
    totalCycles: cleanNumber(raw.totalCycles),
    clickLevel: Math.min(1000, Math.floor(cleanNumber(raw.clickLevel))),
    architectures: Math.min(1e6, Math.floor(cleanNumber(raw.architectures))),
    buildings,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Liveness probe for hosting platforms / load balancers.
app.get('/healthz', (req, res) => {
  res.json({ ok: true, players: Object.keys(players).length, uptime: process.uptime() });
});

// Register a new player, returns a secret id used for subsequent saves.
app.post('/api/players', (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });
  if (Object.keys(players).length >= MAX_PLAYERS) {
    return res.status(503).json({ error: 'player capacity reached' });
  }

  const id = crypto.randomBytes(16).toString('hex');
  players[id] = {
    name,
    state: cleanState({}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  scheduleFlush();
  res.json({ id, name });
});

// Save game state.
app.put('/api/players/:id', (req, res) => {
  const player = players[req.params.id];
  if (!player) return res.status(404).json({ error: 'unknown player' });

  const state = cleanState(req.body.state);
  if (!state) return res.status(400).json({ error: 'invalid state' });

  const name = cleanName(req.body.name);
  if (name) player.name = name;
  player.state = state;
  player.updatedAt = Date.now();
  scheduleFlush();
  res.json({ ok: true });
});

// Load game state.
app.get('/api/players/:id', (req, res) => {
  const player = players[req.params.id];
  if (!player) return res.status(404).json({ error: 'unknown player' });
  res.json({ name: player.name, state: player.state });
});

// Global leaderboard, ranked by lifetime chips mined.
app.get('/api/leaderboard', (req, res) => {
  const top = Object.values(players)
    .map((p) => ({
      name: p.name,
      totalCycles: p.state.totalCycles,
      architectures: p.state.architectures,
    }))
    .sort((a, b) => b.totalCycles - a.totalCycles)
    .slice(0, 10);
  res.json(top);
});

// JSON body parse errors and anything else thrown by handlers.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'bad request body' });
  }
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

// ---------------------------------------------------------------------------
// Startup + graceful shutdown (flush pending saves before exit)
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`CSTR — chip strategy, running at http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, flushing and shutting down…`);
  server.close(() => {
    try {
      if (flushTimer) clearTimeout(flushTimer);
      flushToDisk();
    } catch (err) {
      console.error('final flush failed:', err.message);
    }
    process.exit(0);
  });
  // Hard exit if connections refuse to drain.
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
