const express = require('express');
const path = require('path');
const crypto = require('crypto');
const engine = require('./lib/engine');
const rewards = require('./lib/rewards');
const { Store } = require('./lib/store');
const { isWallet, verifyWalletSignature, linkMessage } = require('./lib/wallet');

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

/** Everything configurable lives here; tests pass overrides (incl. a fake clock). */
function configFromEnv() {
  return {
    dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
    rateLimit: num(env.RATE_LIMIT, 300),
    regLimit: num(env.REG_LIMIT, 20),
    maxPlayers: num(env.MAX_PLAYERS, 100000),
    mint: env.CSTR_MINT || '',
    buyUrl: env.CSTR_BUY_URL || '',
    rewardsTop: num(env.REWARDS_TOP, 25),
    rewardsWeight: rewards.WEIGHTS.includes(env.REWARDS_WEIGHT) ? env.REWARDS_WEIGHT : 'sqrt',
    rewardsMinScore: num(env.REWARDS_MIN_SCORE, 1e6),
    engine: {
      ...engine.DEFAULTS,
      maxCps: num(env.MAX_CPS, engine.DEFAULTS.maxCps),
      seasonMs: num(env.SEASON_DAYS, 7) * 86400000,
      seasonStart: env.SEASON_START ? Date.parse(env.SEASON_START) : engine.DEFAULTS.seasonStart,
    },
    now: () => Date.now(),
  };
}

const CHALLENGE_TTL = 10 * 60 * 1000;
const RELINK_COOLDOWN = 24 * 3600 * 1000;
const MAX_NAME_LEN = 20;

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[^\w \-.]/g, '').trim().slice(0, MAX_NAME_LEN);
  return name.length >= 1 ? name : null;
}

const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : null);

function createApp(overrides = {}) {
  const cfg = { ...configFromEnv(), ...overrides, engine: { ...configFromEnv().engine, ...(overrides.engine || {}) } };
  const now = cfg.now;
  const store = new Store(cfg.dataDir, now());
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  // Fixed-window per-IP limits: all API calls, and (tighter) registrations.
  const buckets = new Map();
  const regBuckets = new Map();
  const sweeper = setInterval(() => buckets.clear(), 60000);
  const regSweeper = setInterval(() => regBuckets.clear(), 3600000);
  sweeper.unref();
  regSweeper.unref();
  const hit = (map, key, limit) => {
    const n = (map.get(key) || 0) + 1;
    map.set(key, n);
    return n > limit;
  };

  app.use('/api', (req, res, next) => {
    if (hit(buckets, req.ip, cfg.rateLimit)) return res.status(429).json({ error: 'too many requests' });
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', extensions: ['html'] }));

  const season = () => engine.seasonAt(now(), cfg.engine);
  const player = (req, res) => {
    const p = store.get(req.params.id);
    if (!p) res.status(404).json({ error: 'unknown player' });
    return p;
  };
  const resolveSeason = (q) => {
    const cur = season().id;
    if (q === undefined || q === 'current') return cur;
    if (q === 'last') return Math.max(0, cur - 1);
    const n = Math.floor(Number(q));
    return Number.isFinite(n) && n >= 0 && n <= cur ? n : null;
  };

  // ------------------------------------------------------------------ meta
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, players: store.count(), uptime: process.uptime() });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      online: true,
      season: season(),
      maxCps: cfg.engine.maxCps,
      token: { symbol: 'CSTR', mint: cfg.mint || null, buyUrl: cfg.buyUrl || null },
      rewards: { top: cfg.rewardsTop, weight: cfg.rewardsWeight, minScore: cfg.rewardsMinScore },
    });
  });

  app.get('/api/stats', (req, res) => {
    const s = season();
    let linked = 0;
    let chips = 0;
    let active = 0;
    for (const p of store.all()) {
      if (p.wallet) linked++;
      const sc = engine.seasonScore(p, s.id);
      chips += sc;
      if (sc > 0) active++;
    }
    res.json({ players: store.count(), linked, active, seasonChips: chips, season: s });
  });

  // --------------------------------------------------------------- players
  app.post('/api/players', (req, res) => {
    const name = cleanName(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'invalid name' });
    if (store.count() >= cfg.maxPlayers) return res.status(503).json({ error: 'player capacity reached' });
    if (hit(regBuckets, req.ip, cfg.regLimit)) return res.status(429).json({ error: 'too many sign-ups from this network' });
    const id = crypto.randomBytes(16).toString('hex');
    const p = engine.newPlayer(name, now());
    engine.rollSeason(p, now(), cfg.engine);
    store.players[id] = p;
    store.schedule();
    res.json({ id, name, tag: p.tag });
  });

  app.get('/api/players/:id', (req, res) => {
    const p = player(req, res);
    if (p) res.json(engine.selfView(p, now(), cfg.engine));
  });

  // v1 clients PUT their whole state; that's exactly what can't be trusted.
  app.put('/api/players/:id', (req, res) => {
    res.status(410).json({ error: 'self-reported saves are no longer accepted; reload the page' });
  });

  app.post('/api/players/:id/session', (req, res) => {
    const p = player(req, res);
    if (!p) return;
    const r = engine.startSession(p, now(), cfg.engine);
    store.schedule();
    res.json({ ...r, ...engine.selfView(p, now(), cfg.engine) });
  });

  app.post('/api/players/:id/sync', (req, res) => {
    const p = player(req, res);
    if (!p) return;
    const r = engine.sync(p, req.body, now(), cfg.engine);
    if (r.status !== 200) return res.status(r.status).json(r.body);
    store.schedule();
    res.json({ ...r.body, ...engine.selfView(p, now(), cfg.engine) });
  });

  // ---------------------------------------------------------- wallet link
  app.post('/api/players/:id/wallet/challenge', (req, res) => {
    const p = player(req, res);
    if (!p) return;
    p.challenge = { nonce: crypto.randomBytes(16).toString('hex'), issuedAt: now() };
    res.json({ message: linkMessage({ name: p.name, tag: p.tag, ...p.challenge }), expiresAt: p.challenge.issuedAt + CHALLENGE_TTL });
  });

  app.post('/api/players/:id/wallet', (req, res) => {
    const p = player(req, res);
    if (!p) return;
    const { wallet, signature } = req.body || {};
    if (!isWallet(wallet)) return res.status(400).json({ error: 'not a valid Solana address' });
    const ch = p.challenge;
    if (!ch || now() - ch.issuedAt > CHALLENGE_TTL) return res.status(400).json({ error: 'challenge expired, try again' });
    p.challenge = null; // single use, pass or fail
    if (!verifyWalletSignature(wallet, linkMessage({ name: p.name, tag: p.tag, ...ch }), signature)) {
      return res.status(401).json({ error: 'signature does not match this wallet' });
    }
    const owner = store.wallets.get(wallet);
    if (owner && store.players[owner] !== p) return res.status(409).json({ error: 'wallet already linked to another player' });
    // Wallet-hopping guard: switching to a *different* wallet (even via unlink
    // + relink) is allowed once per 24h, so a top score can't be rented out.
    if (p.lastWallet && p.lastWallet !== wallet && now() - (p.walletChangedAt || 0) < RELINK_COOLDOWN) {
      return res.status(429).json({ error: 'you can change your linked wallet once every 24h' });
    }
    if (p.wallet) store.wallets.delete(p.wallet.address);
    if (p.lastWallet !== wallet) p.walletChangedAt = now();
    p.lastWallet = wallet;
    p.wallet = { address: wallet, linkedAt: now() };
    store.wallets.set(wallet, req.params.id);
    store.schedule();
    res.json({ ok: true, wallet });
  });

  app.delete('/api/players/:id/wallet', (req, res) => {
    const p = player(req, res);
    if (!p) return;
    // lastWallet/walletChangedAt stay, so unlink + relink can't dodge the cooldown.
    if (p.wallet) store.wallets.delete(p.wallet.address);
    p.wallet = null;
    store.schedule();
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ leaderboard
  app.get('/api/leaderboard', (req, res) => {
    const sid = resolveSeason(req.query.season);
    if (sid === null) return res.status(400).json({ error: 'bad season' });
    const ranked = rewards.ranking(store.all(), sid);
    const payable = new Set(
      rewards
        .rewardsList(store.all(), { sid, top: cfg.rewardsTop, weight: cfg.rewardsWeight, minScore: cfg.rewardsMinScore })
        .map((r) => r.tag)
    );
    res.json({
      season: { ...engine.seasonAt(now(), cfg.engine), id: sid },
      players: ranked.length,
      top: ranked.slice(0, 20).map((r, i) => ({
        rank: i + 1,
        name: r.p.name,
        tag: r.p.tag,
        score: Math.floor(r.score),
        gen: r.p.game.architectures,
        wallet: short(r.p.wallet && r.p.wallet.address),
        flagged: r.p.integrity.flagged,
        rewarded: payable.has(r.p.tag),
      })),
    });
  });

  // ---------------------------------------------------------------- rewards
  // Public on purpose: payouts should be auditable. Wallets are public on-chain anyway.
  function rewardsQuery(req, res) {
    const sid = resolveSeason(req.query.season);
    if (sid === null) {
      res.status(400).json({ error: 'bad season' });
      return null;
    }
    const top = Math.min(1000, Math.max(1, Math.floor(num(req.query.top, cfg.rewardsTop))));
    const weight = rewards.WEIGHTS.includes(req.query.weight) ? req.query.weight : cfg.rewardsWeight;
    const minScore = Math.max(0, num(req.query.min, cfg.rewardsMinScore));
    return { sid, top, weight, minScore, list: rewards.rewardsList(store.all(), { sid, top, weight, minScore }) };
  }

  app.get('/api/rewards', (req, res) => {
    const q = rewardsQuery(req, res);
    if (!q) return;
    const mint = cfg.mint || 'CSTR-leaderboard';
    if (req.query.format === 'csv') return res.type('text/csv').send(rewards.toCsv(q.list));
    if (req.query.format === 'snapshot') return res.json(rewards.toSnapshot(q.list, { mint, sid: q.sid, weight: q.weight, at: now() }));
    res.json({ season: q.sid, top: q.top, weight: q.weight, minScore: q.minScore, count: q.list.length, recipients: q.list });
  });

  // memcoinz guest-list protocol: `seats.url` in a flywheel config reads this.
  app.get('/api/seats', (req, res) => {
    if (cfg.mint && req.query.mint && req.query.mint !== cfg.mint) return res.status(404).json({ error: 'unknown mint' });
    const q = rewardsQuery(req, res);
    if (!q) return;
    res.json(rewards.seatsView(q.list, { mint: cfg.mint || req.query.mint || null, sid: q.sid, at: now() }));
  });
  // The flywheel POSTs a "sell it, lose it" sweep before paying; seats here are
  // recomputed from the live leaderboard on every read, so there is nothing to sweep.
  app.post('/api/seats/sweep', (req, res) => res.json({ skipped: false, freed: [], promoted: [] }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'bad request body' });
    }
    console.error('unhandled error:', err);
    res.status(500).json({ error: 'internal error' });
  });

  return { app, store, cfg };
}

module.exports = { createApp, configFromEnv };

if (require.main === module) {
  const PORT = env.PORT || 3000;
  const HOST = env.HOST || '0.0.0.0';
  const { app, store } = createApp();
  const server = app.listen(PORT, HOST, () => {
    console.log(`CSTR — chip strategy, running at http://${HOST}:${PORT}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, flushing and shutting down…`);
    server.close(() => {
      try {
        store.close();
      } catch (err) {
        console.error('final flush failed:', err.message);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
