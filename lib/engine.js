/* Players, seasons and the power (⚡) economy.
 *
 * Power is free and server-held: you start with RULES.startPower and regain
 * RULES.regenPerMin while you're online, up to RULES.regenCap. "Online" means
 * your client polled /api/players/:id recently: a gap longer than
 * PRESENCE_GRACE_MS only credits the grace window, so power can't pile up
 * while a tab is closed. All deploys and payouts live in lib/mining.js.
 *
 * Season score = CHIPs mined in the season (micro-chip integers). That's what
 * the rewards export ranks.
 */
const crypto = require('crypto');
const { RULES } = require('../public/rules.js');

const DEFAULTS = {
  historySeasons: 8,
  seasonMs: 7 * 86400000,
  seasonStart: Date.parse('2026-10-05T00:00:00Z'),
  presenceGraceMs: 120000,
  ...RULES,
};

const newId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

function seasonAt(now, cfg) {
  if (now < cfg.seasonStart) return { id: 0, startsAt: null, endsAt: cfg.seasonStart };
  const id = Math.floor((now - cfg.seasonStart) / cfg.seasonMs) + 1;
  const startsAt = cfg.seasonStart + (id - 1) * cfg.seasonMs;
  return { id, startsAt, endsAt: startsAt + cfg.seasonMs };
}

function newPlayer(name, now, cfg = DEFAULTS) {
  return {
    v: 3,
    name,
    tag: newId(4),
    createdAt: now,
    updatedAt: now,
    power: cfg.startPower,
    powerAt: now,
    wallet: null,
    challenge: null,
    season: { id: 0, chips: 0 },
    history: {},
    totals: { chips: 0, epochs: 0, wins: 0, motherlodes: 0 },
    lastResult: null,
    integrity: { flagged: false, reasons: [] },
  };
}

/**
 * v1 (self-reported clicker saves) and v2 (server-verified clicker) players
 * carry identity, wallet and flags forward. Clicker chips were a different
 * game, so they become a display-only `legacyTotal` and never count here.
 */
function migrate(p, now, cfg = DEFAULTS) {
  if (p && p.v === 3) return p;
  const m = newPlayer((p && p.name) || 'player', now, cfg);
  m.createdAt = (p && p.createdAt) || now;
  if (p && p.tag) m.tag = p.tag;
  const legacy = (p && (p.legacyTotal || 0)) + Number((p && ((p.game && p.game.totalCycles) || (p.state && p.state.totalCycles))) || 0);
  if (legacy > 0) m.legacyTotal = legacy;
  if (p && p.v === 2) {
    m.wallet = p.wallet || null;
    m.lastWallet = p.lastWallet;
    m.walletChangedAt = p.walletChangedAt;
    if (p.integrity && p.integrity.flagged) m.integrity = { flagged: true, reasons: [...(p.integrity.reasons || [])] };
  }
  return m;
}

function rollSeason(p, now, cfg) {
  const { id } = seasonAt(now, cfg);
  if (p.season.id === id) return;
  if (p.season.chips > 0) p.history[p.season.id] = p.season.chips;
  const keep = Object.keys(p.history).map(Number).sort((a, b) => b - a).slice(0, cfg.historySeasons);
  p.history = Object.fromEntries(keep.map((k) => [k, p.history[k]]));
  p.season = { id, chips: 0 };
}

const seasonScore = (p, sid) => (p.season.id === sid ? p.season.chips : p.history[sid] || 0);

/** Credit presence-gated regen up to now. Call on every authenticated request. */
function regen(p, now, cfg) {
  const perUnit = 60000 / cfg.regenPerMin;
  const gap = Math.max(0, now - (p.powerAt || now));
  if (p.power >= cfg.regenCap) {
    p.powerAt = now;
    return;
  }
  if (gap > cfg.presenceGraceMs) {
    // Away: only the grace window counts, so a closed tab doesn't bank power.
    p.power = Math.min(cfg.regenCap, p.power + Math.floor(cfg.presenceGraceMs / perUnit));
    p.powerAt = now;
    return;
  }
  const units = Math.floor(gap / perUnit);
  p.power = Math.min(cfg.regenCap, p.power + units);
  p.powerAt = p.power >= cfg.regenCap ? now : p.powerAt + units * perUnit; // keep the partial unit
}

function addChips(p, chips, now, cfg) {
  rollSeason(p, now, cfg);
  p.season.chips += chips;
  p.totals.chips += chips;
}

function flag(p, reason) {
  if (!p.integrity.reasons.includes(reason)) p.integrity.reasons.push(reason);
  p.integrity.flagged = true;
}

function selfView(p, now, cfg) {
  const season = seasonAt(now, cfg);
  return {
    name: p.name,
    tag: p.tag,
    power: p.power,
    serverTime: now,
    season: { ...season, score: seasonScore(p, season.id) },
    totals: p.totals,
    lastResult: p.lastResult,
    wallet: p.wallet ? p.wallet.address : null,
    flagged: p.integrity.flagged,
    legacyTotal: p.legacyTotal || 0,
  };
}

module.exports = { DEFAULTS, seasonAt, newPlayer, migrate, rollSeason, seasonScore, regen, addChips, flag, selfView };
