const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/engine');
const { Board } = require('../lib/mining');
const { SeedChain, epochValue, sha256 } = require('../lib/fairness');
const { outcome, CHIP, SQUARES } = require('../public/rules.js');

const cfg = { ...engine.DEFAULTS };
const T0 = Date.parse('2026-10-13T12:00:00Z'); // epoch-aligned (60s)
const E0 = T0 / cfg.epochMs;

function setup() {
  const players = {};
  const chain = new SeedChain({ x0: '11'.repeat(32), length: 5000, genesisEpoch: E0 - 10 });
  const beacon = { info: { name: 'test' }, next: null, async get(round) { return this.next && { round, signature: 'aa'.repeat(48), randomness: this.next }; } };
  let t = T0;
  const board = new Board({ state: {}, chain, beacon, players: { get: (pid) => players[pid] }, cfg, now: () => t });
  const add = (pid, power = 1000) => {
    const p = engine.newPlayer(pid, T0, cfg);
    p.power = power;
    players[pid] = p;
    return p;
  };
  const deploy = (pid, squares, amount) => board.deploy(pid, players[pid], { epoch: board.epochAt(t).id, squares, amount }, t);
  return { board, chain, beacon, players, add, deploy, clock: { set: (v) => (t = v), get: () => t } };
}

/** Find beacon randomness that makes this epoch's outcome satisfy `want`. */
function rig(chain, epoch, onRack, want) {
  const seed = chain.seed(epoch);
  for (let i = 0; i < 200000; i++) {
    const r = sha256(Buffer.from(String(i))).toString('hex');
    const v = epochValue(epoch, seed, r);
    const pre = outcome(v, 0);
    if (want(outcome(v, onRack(pre.square)))) return r;
  }
  throw new Error('no randomness found');
}

test('deploy validation: open epoch only, real racks, real power', () => {
  const { add, deploy, board, players, clock } = setup();
  add('a', 100);
  assert.equal(deploy('a', [0, 1], 50).status, 200);
  assert.equal(players.a.power, 0);
  assert.equal(deploy('a', [2], 1).body.error, 'not enough power');
  add('b', 100);
  assert.equal(deploy('b', [25], 1).status, 400);
  assert.equal(deploy('b', [1, 1], 1).status, 400);
  assert.equal(deploy('b', [], 1).status, 400);
  assert.equal(deploy('b', [0], 0).status, 400);
  assert.equal(deploy('b', [0], 1.5).status, 400);
  assert.equal(deploy('b', [0], cfg.maxDeploy + 1).status, 400);
  // Deploying into a past epoch is refused.
  const r = board.deploy('b', players.b, { epoch: board.epochAt(clock.get()).id - 1, squares: [0], amount: 1 }, clock.get());
  assert.equal(r.status, 409);
});

test('a retried deploy (same reqId) is applied once', () => {
  const { add, board, players, clock } = setup();
  add('a', 100);
  const req = { epoch: board.epochAt(clock.get()).id, squares: [3], amount: 10, reqId: 'r1' };
  board.deploy('a', players.a, req, clock.get());
  assert.equal(board.deploy('a', players.a, req, clock.get()).body.duplicate, true);
  assert.equal(players.a.power, 90);
});

test('settlement: losers fund winners pro-rata minus a 10% burn; split CHIP', async () => {
  const { add, deploy, board, chain, beacon, players, clock } = setup();
  add('a');
  add('b');
  add('c');
  deploy('a', [0], 300);
  deploy('b', [0], 100);
  deploy('c', [1, 2], 200); // c spreads 400 over two racks
  const e = board.epochAt(clock.get()).id;
  beacon.next = rig(chain, e, (sq) => (sq === 0 ? 400 : 0), (o) => o.square === 0 && o.split && !o.motherlode);
  clock.set(T0 + cfg.epochMs + 5000);
  assert.equal(await board.tick(), 1);
  const s = board.s.history[0];
  assert.equal(s.square, 0);
  assert.equal(s.burned, 40); // 10% of the 400 losing power
  // pot 360 split 3:1 → a +270, b +90 (plus their own deploys back)
  assert.equal(players.a.power, 700 + 300 + 270);
  assert.equal(players.b.power, 900 + 100 + 90);
  assert.equal(players.c.power, 600);
  assert.equal(players.a.season.chips, 0.75 * CHIP);
  assert.equal(players.b.season.chips, 0.25 * CHIP);
  assert.equal(players.c.season.chips, 0);
  assert.equal(players.c.lastResult.won, false);
  assert.equal(board.s.motherlode, cfg.motherlodePerEpoch);
  // Power is conserved apart from the burn.
  const total = Object.values(players).reduce((a, p) => a + p.power, 0);
  assert.equal(total, 3000 - 40);
});

test('top-miner epochs send the whole CHIP to one deployer, weighted by deploy order', async () => {
  const { add, deploy, board, chain, beacon, players, clock } = setup();
  add('a');
  add('b');
  deploy('a', [4], 30);
  deploy('b', [4], 70);
  const e = board.epochAt(clock.get()).id;
  // sample < 30 → a (first 30 units); 30..99 → b
  beacon.next = rig(chain, e, (sq) => (sq === 4 ? 100 : 0), (o) => o.square === 4 && !o.split && !o.motherlode && o.sample >= 30);
  clock.set(T0 + cfg.epochMs + 5000);
  await board.tick();
  assert.equal(players.b.season.chips, CHIP);
  assert.equal(players.a.season.chips, 0);
  assert.equal(board.s.history[0].topMiner, players.b.tag);
});

test('motherlode: accrues +0.2 per epoch and pays the winning rack pro-rata on a hit', async () => {
  const { add, deploy, board, chain, beacon, players, clock } = setup();
  add('a');
  add('b');
  board.s.motherlode = 50 * CHIP;
  deploy('a', [7], 100);
  deploy('b', [7], 300);
  const e = board.epochAt(clock.get()).id;
  beacon.next = rig(chain, e, (sq) => (sq === 7 ? 400 : 0), (o) => o.square === 7 && o.split && o.motherlode);
  clock.set(T0 + cfg.epochMs + 5000);
  await board.tick();
  assert.equal(players.a.season.chips, 0.25 * CHIP + 12.5 * CHIP);
  assert.equal(players.b.season.chips, 0.75 * CHIP + 37.5 * CHIP);
  assert.equal(board.s.motherlode, cfg.motherlodePerEpoch);
  assert.equal(board.s.hits[0].epoch, e);
  assert.equal(players.a.totals.motherlodes, 1);
});

test('nobody on the winning rack: losing power burns, the CHIP rolls into the motherlode', async () => {
  const { add, deploy, board, chain, beacon, players, clock } = setup();
  add('a');
  deploy('a', [0], 100);
  const e = board.epochAt(clock.get()).id;
  beacon.next = rig(chain, e, () => 0, (o) => o.square !== 0 && !o.motherlode);
  clock.set(T0 + cfg.epochMs + 5000);
  await board.tick();
  assert.equal(players.a.power, 900);
  assert.equal(board.s.history[0].burned, 100);
  assert.equal(board.s.motherlode, cfg.emission + cfg.motherlodePerEpoch);
});

test('no beacon within the void window → epoch void, every deploy refunded', async () => {
  const { add, deploy, board, players, clock } = setup();
  add('a');
  deploy('a', [0, 1, 2], 100);
  clock.set(T0 + cfg.epochMs + 30000);
  assert.equal(await board.tick(), 0); // still waiting for the beacon
  assert.equal(players.a.power, 700);
  clock.set(T0 + cfg.epochMs + 6 * 60000);
  assert.equal(await board.tick(), 1);
  assert.equal(players.a.power, 1000);
  assert.equal(board.s.history[0].void, true);
  assert.equal(players.a.lastResult.void, true);
});

test('settled epochs publish everything needed to verify them', async () => {
  const { add, deploy, board, chain, beacon, clock } = setup();
  add('a');
  deploy('a', [9], 10);
  const e = board.epochAt(clock.get()).id;
  const commitBefore = board.view(clock.get()).epoch.commit;
  beacon.next = 'cd'.repeat(32);
  clock.set(T0 + cfg.epochMs + 5000);
  await board.tick();
  const s = board.s.history[0];
  assert.equal(s.commit, commitBefore);
  assert.equal(sha256(Buffer.from(s.seed, 'hex')).toString('hex'), s.commit);
  assert.equal(s.value, epochValue(e, s.seed, s.drand.randomness));
  assert.equal(outcome(s.value, 0).square, s.square);
  assert.ok(!JSON.stringify(s).includes('"pid"'), 'secret player ids never leak');
  assert.equal(s.seed, chain.seed(e));
});

test('the live view never reveals the current seed', () => {
  const { board, chain, clock } = setup();
  const v = board.view(clock.get());
  assert.equal(v.epoch.commit, chain.commit(v.epoch.id));
  assert.ok(!JSON.stringify(v).includes(chain.seed(v.epoch.id)));
  assert.equal(v.totals.length, SQUARES);
});

test('power regen only accrues while online, up to the cap', () => {
  const p = engine.newPlayer('x', T0, cfg);
  p.power = 0;
  p.powerAt = T0;
  engine.regen(p, T0 + 60000, cfg); // 1 min online
  assert.equal(p.power, cfg.regenPerMin);
  engine.regen(p, T0 + 60000 + 3 * 3600000, cfg); // away 3h: only the grace window counts
  assert.equal(p.power, cfg.regenPerMin + Math.floor((cfg.presenceGraceMs / 60000) * cfg.regenPerMin));
  p.power = cfg.regenCap - 1;
  engine.regen(p, p.powerAt + 60000, cfg);
  assert.equal(p.power, cfg.regenCap);
});

test('v1/v2 clicker saves migrate: identity + wallet + flags kept, clicker chips → legacy', () => {
  const v2 = { v: 2, name: 'vet', tag: 'deadbeef', game: { totalCycles: 5e9 }, legacyTotal: 10, wallet: { address: 'W', linkedAt: 1 }, integrity: { flagged: true, reasons: ['x'] }, createdAt: 3 };
  const m = engine.migrate(v2, T0, cfg);
  assert.equal(m.v, 3);
  assert.equal(m.tag, 'deadbeef');
  assert.equal(m.wallet.address, 'W');
  assert.equal(m.integrity.flagged, true);
  assert.equal(m.legacyTotal, 5e9 + 10);
  assert.equal(m.power, cfg.startPower);
  assert.equal(m.season.chips, 0);
  const v1 = engine.migrate({ name: 'old', state: { totalCycles: 7 } }, T0, cfg);
  assert.equal(v1.legacyTotal, 7);
  assert.equal(v1.wallet, null);
});
