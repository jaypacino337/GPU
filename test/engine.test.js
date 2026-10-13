const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/engine');
const rules = require('../public/rules.js');

const T0 = Date.parse('2026-10-06T12:00:00Z'); // inside season 1
const cfg = { ...engine.DEFAULTS };

function started(at = T0) {
  const p = engine.newPlayer('tester', at);
  const { session } = engine.startSession(p, at, cfg);
  let seq = 0;
  return { p, send: (actions, t) => engine.sync(p, { session, seq: ++seq, actions }, t, cfg), session };
}

test('clicks are capped by real elapsed time (MAX_CPS token bucket)', () => {
  const { p, send } = started();
  // 5 seconds pass; client claims 1000 clicks in that window.
  const r = send([{ t: 'c', n: 1000 }], T0 + 5000);
  assert.equal(r.status, 200);
  assert.equal(r.body.clicks, 5 * cfg.maxCps);
  assert.equal(r.body.droppedClicks, 1000 - 5 * cfg.maxCps);
  assert.equal(p.game.totalCycles, 5 * cfg.maxCps); // 1 chip per click at level 0
  assert.equal(p.season.chips, p.game.totalCycles);
});

test('a forged huge click count is rejected outright', () => {
  const { send } = started();
  assert.equal(send([{ t: 'c', n: 1e9 }], T0 + 1000).status, 400);
  assert.equal(send([{ t: 'c', n: -5 }], T0 + 1000).status, 400);
  assert.equal(send([{ t: 'z' }], T0 + 1000).status, 400);
  assert.equal(send(Array(cfg.maxActions + 1).fill({ t: 'o' }), T0 + 1000).status, 400);
});

test('click burst after a long idle is capped at burstSec worth', () => {
  const { send } = started();
  const r = send([{ t: 'c', n: 1000 }], T0 + 3600 * 1000);
  assert.equal(r.body.clicks, cfg.maxCps * cfg.burstSec);
});

test('unaffordable purchases are refused server-side', () => {
  const { p, send } = started();
  const r = send([{ t: 'b', id: 'dc' }, { t: 'o' }, { t: 'p' }, { t: 'b', id: 'nope' }], T0 + 1000);
  assert.equal(r.status, 200);
  assert.equal(r.body.rejected, 4);
  assert.equal(p.game.buildings.dc, 0);
  assert.equal(p.game.clickLevel, 0);
  assert.equal(p.game.architectures, 0);
});

test('actions apply in order: clicks then a buy they paid for', () => {
  const { p, send } = started();
  const r = send([{ t: 'c', n: 15 }, { t: 'b', id: 'core' }], T0 + 1000);
  assert.equal(r.body.rejected, 0);
  assert.equal(p.game.buildings.core, 1);
  assert.equal(p.game.cycles, 0);
});

test('idle production uses server time, capped at 8h offline', () => {
  const { p, send } = started();
  p.game.buildings.core = 10; // 10 chips/sec
  send([], T0 + 10_000);
  assert.equal(p.game.totalCycles, 100);
  // Gone 3 days: only 8h are credited.
  send([], T0 + 10_000 + 3 * 86400_000);
  assert.equal(p.game.totalCycles, 100 + 10 * rules.OFFLINE_CAP_SEC);
});

test('client clock is irrelevant: no time passes, nothing is earned', () => {
  const { p, send } = started();
  p.game.buildings.dc = 100;
  send([], T0);
  assert.equal(p.game.totalCycles, 0);
});

test('a retried batch (same seq) is applied exactly once', () => {
  const { p, session } = started();
  const batch = { session, seq: 1, actions: [{ t: 'c', n: 10 }] };
  assert.equal(engine.sync(p, batch, T0 + 2000, cfg).status, 200);
  const again = engine.sync(p, batch, T0 + 3000, cfg);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(p.game.totalCycles, 10);
});

test('a second session (other tab) invalidates the first', () => {
  const { p, send } = started();
  engine.startSession(p, T0 + 1000, cfg);
  assert.equal(send([{ t: 'c', n: 1 }], T0 + 2000).status, 409);
  assert.equal(engine.sync(p, { session: 'forged', seq: 1, actions: [] }, T0 + 2000, cfg).status, 409);
});

test('sustained max-rate clicking flags the player (bot signature)', () => {
  const { p, send } = started();
  let t = T0;
  const minutes = cfg.botFlagSec / 60 + 1;
  for (let i = 0; i < minutes * 12; i++) {
    t += 5000;
    send([{ t: 'c', n: 5 * cfg.maxCps }], t);
  }
  assert.equal(p.integrity.flagged, true);
  assert.ok(p.integrity.reasons.includes('sustained max-rate clicking'));
});

test('a human pace (well under the cap) never flags', () => {
  const { p, send } = started();
  let t = T0;
  for (let i = 0; i < 12 * 60; i++) {
    t += 5000;
    send([{ t: 'c', n: 40 }], t); // 8 cps for an hour
  }
  assert.equal(p.integrity.flagged, false);
  assert.equal(p.integrity.botSec, 0);
});

test('a flood of over-limit clicks flags the player', () => {
  const { p, send } = started();
  let t = T0;
  for (let i = 0; i < 30; i++) {
    t += 1000;
    send([{ t: 'c', n: 1000 }], t);
  }
  assert.equal(p.integrity.flagged, true);
  assert.ok(p.integrity.reasons.includes('click flood above rate limit'));
});

test('season rollover archives the old score and starts at zero', () => {
  const { p, send } = started();
  send([{ t: 'c', n: 100 }], T0 + 10_000);
  const s1 = p.season.chips;
  assert.equal(p.season.id, 1);
  send([], T0 + cfg.seasonMs);
  assert.equal(p.season.id, 2);
  assert.equal(p.history[1], s1);
  assert.equal(engine.seasonScore(p, 1), s1);
});

test('legacy self-reported saves restart under server rules', () => {
  const legacy = { name: 'old', state: { cycles: 1e30, totalCycles: 1e30, buildings: { dc: 1e6 } }, createdAt: 5 };
  const p = engine.migrate(legacy, T0);
  assert.equal(p.v, 2);
  assert.equal(p.legacyTotal, 1e30);
  assert.equal(p.game.totalCycles, 0);
  assert.equal(p.game.buildings.dc, 0);
  assert.equal(p.season.chips, 0);
  assert.equal(engine.migrate(p, T0), p);
});

test('seasons: preseason before the start date, then fixed-length weeks', () => {
  assert.equal(engine.seasonAt(cfg.seasonStart - 1, cfg).id, 0);
  assert.equal(engine.seasonAt(cfg.seasonStart, cfg).id, 1);
  assert.equal(engine.seasonAt(cfg.seasonStart + cfg.seasonMs, cfg).id, 2);
});
