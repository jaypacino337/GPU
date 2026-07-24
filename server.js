const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
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

let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(players));
    fs.renameSync(tmp, DB_FILE);
  }, 2000);
}

loadDb();

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const MAX_NAME_LEN = 20;

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

// Register a new player, returns a secret id used for subsequent saves.
app.post('/api/players', (req, res) => {
  const name = cleanName(req.body.name);
  if (!name) return res.status(400).json({ error: 'invalid name' });

  const id = crypto.randomBytes(16).toString('hex');
  players[id] = {
    name,
    state: cleanState({}) ,
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

// Global leaderboard, ranked by lifetime cycles.
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

app.listen(PORT, () => {
  console.log(`CPU — the game, running at http://localhost:${PORT}`);
});
