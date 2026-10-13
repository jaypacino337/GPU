/* Server-authoritative progression (the anti-cheat core).
 *
 * The browser never reports a score. It sends the *inputs* it saw (clicks,
 * purchases, overclocks, prestige) in small ordered batches; the server
 * replays them against its own copy of the game using the shared rules in
 * public/rules.js and its own clock:
 *
 *   - idle production is computed from server time since the last sync
 *     (capped at 8h offline, same as the client UI promises),
 *   - clicks are drawn from a token bucket that refills at MAX_CPS per real
 *     second (burst-capped), so an autoclicker or a forged "n: 1e9" gains at
 *     most MAX_CPS clicks/sec. Excess clicks are dropped and counted,
 *   - purchases/prestige are only applied if the server state can afford them,
 *   - each player has one live session; batches carry a sequence number so a
 *     retried batch is applied exactly once and a second tab can't double-run,
 *   - sustained near-cap clicking (a bot signature) or a flood of rejected
 *     clicks flags the player: still playable, but excluded from rewards
 *     until an admin clears it (`npm run admin -- unflag <id>`).
 *
 * Every chip earned is attributed to the current season's score, which is
 * what the rewards export ranks.
 */
const crypto = require('crypto');
const rules = require('../public/rules.js');

const DEFAULTS = {
  maxCps: 20,             // human ceiling; sustained 20 cps is already autoclicker territory
  burstSec: 15,           // click bucket holds at most maxCps * burstSec
  botRatio: 0.85,         // windows at >= 85% of the cap count as "bot-like"
  botFlagSec: 15 * 60,    // 15 min of bot-like clicking => flagged
  floodFlagClicks: 20000, // cumulative rejected clicks => flagged
  maxActions: 400,        // per sync batch
  maxClickBatch: 1000,    // per click action
  historySeasons: 8,
  seasonMs: 7 * 86400000,
  seasonStart: Date.parse('2026-10-05T00:00:00Z'),
};

const newId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');

/** Season 1 starts at seasonStart; anything before is season 0 ("preseason"). */
function seasonAt(now, cfg) {
  if (now < cfg.seasonStart) return { id: 0, startsAt: null, endsAt: cfg.seasonStart };
  const id = Math.floor((now - cfg.seasonStart) / cfg.seasonMs) + 1;
  const startsAt = cfg.seasonStart + (id - 1) * cfg.seasonMs;
  return { id, startsAt, endsAt: startsAt + cfg.seasonMs };
}

function newPlayer(name, now) {
  return {
    v: 2,
    name,
    tag: newId(4),
    createdAt: now,
    updatedAt: now,
    game: rules.fresh(),
    lastTick: now,
    clickBudget: 0,
    session: null,
    wallet: null,
    challenge: null,
    season: { id: 0, chips: 0 },
    history: {},
    integrity: { clicks: 0, rejectedClicks: 0, rejectedActions: 0, botSec: 0, flagged: false, reasons: [] },
  };
}

/**
 * Bring a v1 (self-reported) save forward. Its numbers were never verified, so
 * the run restarts under server rules; the old lifetime total is kept as a
 * display-only `legacyTotal` and never counts toward any season.
 */
function migrate(p, now) {
  if (p && p.v === 2) return p;
  const fresh = newPlayer(p && p.name ? p.name : 'player', now);
  fresh.createdAt = (p && p.createdAt) || now;
  fresh.legacyTotal = Number((p && p.state && p.state.totalCycles) || 0) || 0;
  return fresh;
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

function flag(p, reason) {
  if (!p.integrity.reasons.includes(reason)) p.integrity.reasons.push(reason);
  p.integrity.flagged = true;
}

/** Start (or take over) the player's single live session. */
function startSession(p, now, cfg) {
  rollSeason(p, now, cfg);
  // Credit idle production up to now, so the session starts from a clean tick.
  const awaySec = Math.max(0, (now - p.lastTick) / 1000);
  const offline = rules.tick(p.game, awaySec);
  p.season.chips += offline;
  p.lastTick = now;
  p.clickBudget = 0;
  p.session = { id: newId(), seq: 0, startedAt: now };
  p.updatedAt = now;
  return { session: p.session.id, offline, offlineSec: Math.min(awaySec, rules.OFFLINE_CAP_SEC) };
}

function cleanActions(raw, cfg) {
  if (!Array.isArray(raw) || raw.length > cfg.maxActions) return null;
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') return null;
    if (a.t === 'c') {
      const n = Math.floor(Number(a.n));
      if (!(n >= 1 && n <= cfg.maxClickBatch)) return null;
      out.push({ t: 'c', n });
    } else if (a.t === 'b') {
      if (typeof a.id !== 'string') return null;
      out.push({ t: 'b', id: a.id });
    } else if (a.t === 'o' || a.t === 'p') {
      out.push({ t: a.t });
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Apply one batch. Returns { status, body }:
 *   200 applied (or an already-applied retry: body.duplicate = true)
 *   400 malformed batch   409 session replaced by another tab / never started
 */
function sync(p, input, now, cfg) {
  if (!p.session || !input || input.session !== p.session.id) {
    return { status: 409, body: { error: 'session replaced', code: 'SESSION' } };
  }
  const seq = Math.floor(Number(input.seq));
  if (!(seq >= 1)) return { status: 400, body: { error: 'bad seq' } };
  if (seq <= p.session.seq) return { status: 200, body: { duplicate: true } };
  const actions = cleanActions(input.actions, cfg);
  if (!actions) return { status: 400, body: { error: 'bad actions' } };

  rollSeason(p, now, cfg);
  const elapsedSec = Math.max(0, (now - p.lastTick) / 1000);
  p.lastTick = now;
  let earned = rules.tick(p.game, elapsedSec);

  // Refill the click bucket by real time, burst-capped.
  const cap = cfg.maxCps * cfg.burstSec;
  p.clickBudget = Math.min(cap, p.clickBudget + elapsedSec * cfg.maxCps);

  let clicks = 0;
  let droppedClicks = 0;
  let rejected = 0;
  for (const a of actions) {
    if (a.t === 'c') {
      const allowed = Math.min(a.n, Math.floor(p.clickBudget));
      p.clickBudget -= allowed;
      droppedClicks += a.n - allowed;
      clicks += allowed;
      if (allowed > 0) earned += rules.apply(p.game, { t: 'c', n: allowed }).earned;
      continue;
    }
    const r = rules.apply(p.game, a);
    if (!r.ok) rejected++;
  }

  const it = p.integrity;
  it.clicks += clicks;
  it.rejectedClicks += droppedClicks;
  it.rejectedActions += rejected;
  // Bot signature: clicking at (nearly) the hard cap for a long time. Short
  // honest bursts decay away; only sustained windows accumulate.
  if (elapsedSec >= 2 && elapsedSec <= 120) {
    if (clicks / elapsedSec >= cfg.botRatio * cfg.maxCps) it.botSec += elapsedSec;
    else it.botSec = Math.max(0, it.botSec - elapsedSec);
    if (it.botSec >= cfg.botFlagSec) flag(p, 'sustained max-rate clicking');
  }
  if (it.rejectedClicks >= cfg.floodFlagClicks) flag(p, 'click flood above rate limit');

  p.season.chips += earned;
  p.session.seq = seq;
  p.updatedAt = now;
  return { status: 200, body: { applied: actions.length, clicks, droppedClicks, rejected } };
}

/** The view a player gets of themselves (never includes another player's data). */
function selfView(p, now, cfg) {
  const season = seasonAt(now, cfg);
  return {
    name: p.name,
    tag: p.tag,
    state: p.game,
    serverTime: now,
    lastTick: p.lastTick,
    season: { ...season, score: seasonScore(p, season.id) },
    wallet: p.wallet ? p.wallet.address : null,
    flagged: p.integrity.flagged,
    legacyTotal: p.legacyTotal || 0,
  };
}

module.exports = { DEFAULTS, seasonAt, newPlayer, migrate, rollSeason, seasonScore, startSession, sync, selfView, flag };
