const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { sha256, epochValue } = require('../lib/fairness');
const { outcome, CHIP } = require('../public/rules.js');
const { keypair } = require('./helpers');

const T0 = Date.parse('2026-10-06T12:00:00Z'); // a minute boundary
const EPOCH = 60000;

/** Deterministic stand-in for drand (real BLS verification is tested in fairness.test.js). */
const fakeBeacon = {
  info: { name: 'test beacon' },
  async get(round) {
    return { round, signature: 'aa'.repeat(48), randomness: sha256(Buffer.from(`r${round}`)).toString('hex') };
  },
};

async function boot(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cstr-test-'));
  const clock = { t: T0 };
  const { app, store, board, tick, close: closeApp } = createApp({ dataDir, now: () => clock.t, rewardsMinScore: 0, mint: '', autoTick: false, beacon: fakeBeacon, chainLength: 50000, ...extra });
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const close = () =>
    new Promise((r) => {
      closeApp();
      server.close(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
        r();
      });
    });
  /** Close the current epoch and settle it. */
  const settle = async () => {
    clock.t = (Math.floor(clock.t / EPOCH) + 1) * EPOCH + 5000;
    await tick();
  };
  return { call, clock, store, board, close, dataDir, settle };
}

const epochNow = (h) => Math.floor(h.clock.t / EPOCH);
const ALL = Array.from({ length: 25 }, (_, i) => i);

/** Mine `epochs` epochs alone, covering every rack, so each one earns exactly 1 CHIP (+ any motherlode). */
async function playerWithScore(h, name, epochs) {
  const { json: reg } = await h.call('POST', '/api/players', { name });
  for (let i = 0; i < epochs; i++) {
    const r = await h.call('POST', `/api/players/${reg.id}/deploy`, { epoch: epochNow(h), squares: ALL, amount: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await h.settle();
  }
  return reg;
}

async function link(h, id, kp) {
  const { json: ch } = await h.call('POST', `/api/players/${id}/wallet/challenge`);
  return h.call('POST', `/api/players/${id}/wallet`, { wallet: kp.address, signature: kp.sign(ch.message) });
}

test('register → deploy → settle: server-held power, verifiable result', async () => {
  const h = await boot();
  try {
    const { status, json: reg } = await h.call('POST', '/api/players', { name: 'Neo<script>' });
    assert.equal(status, 200);
    assert.equal(reg.name, 'Neoscript');
    const me = (await h.call('GET', `/api/players/${reg.id}`)).json;
    assert.equal(me.power, 300);

    const board = (await h.call('GET', '/api/board')).json;
    assert.equal(board.epoch.id, epochNow(h));
    assert.match(board.epoch.commit, /^[0-9a-f]{64}$/);

    // Overspend, closed epoch, bad rack are all refused by the server.
    assert.equal((await h.call('POST', `/api/players/${reg.id}/deploy`, { epoch: epochNow(h), squares: [0], amount: 301 })).status, 400);
    assert.equal((await h.call('POST', `/api/players/${reg.id}/deploy`, { epoch: epochNow(h) - 1, squares: [0], amount: 1 })).status, 409);
    assert.equal((await h.call('POST', `/api/players/${reg.id}/deploy`, { epoch: epochNow(h), squares: [99], amount: 1 })).status, 400);

    const d = await h.call('POST', `/api/players/${reg.id}/deploy`, { epoch: epochNow(h), squares: [3, 4], amount: 50 });
    assert.equal(d.status, 200);
    assert.equal(d.json.power, 200);
    assert.equal((await h.call('GET', '/api/board')).json.totals[3], 50);

    const epoch = epochNow(h);
    await h.settle();
    const ep = (await h.call('GET', `/api/epochs/${epoch}`)).json;
    assert.equal(ep.epoch, epoch);
    assert.equal(ep.commit, board.epoch.commit);
    assert.equal(sha256(Buffer.from(ep.seed, 'hex')).toString('hex'), ep.commit);
    assert.equal(outcome(epochValue(epoch, ep.seed, ep.drand.randomness), 0).square, ep.square);

    const after = (await h.call('GET', `/api/players/${reg.id}`)).json;
    assert.equal(after.lastResult.epoch, epoch);
    const won = ep.square === 3 || ep.square === 4;
    assert.equal(after.lastResult.won, won);
    assert.equal(after.season.score, won ? CHIP : 0);
    assert.ok(!JSON.stringify(ep).includes(reg.id), 'secret ids never leak');

    // The clicker API is gone.
    assert.equal((await h.call('PUT', `/api/players/${reg.id}`, { state: {} })).status, 410);
    assert.equal((await h.call('POST', `/api/players/${reg.id}/sync`, {})).status, 410);
  } finally {
    await h.close();
  }
});

test('wallet linking: valid signature links, replay/forgery/duplicates rejected', async () => {
  const h = await boot();
  try {
    const a = await playerWithScore(h, 'alice', 1);
    const b = await playerWithScore(h, 'bob', 1);
    const alice = keypair();
    const mallory = keypair();

    // Forged: mallory signs alice's challenge but claims alice's wallet.
    const { json: ch } = await h.call('POST', `/api/players/${a.id}/wallet/challenge`);
    assert.match(ch.message, /"alice"/);
    const forged = await h.call('POST', `/api/players/${a.id}/wallet`, { wallet: alice.address, signature: mallory.sign(ch.message) });
    assert.equal(forged.status, 401);

    // The challenge was consumed by that attempt: a real signature over it now fails too.
    const reused = await h.call('POST', `/api/players/${a.id}/wallet`, { wallet: alice.address, signature: alice.sign(ch.message) });
    assert.equal(reused.status, 400);

    // Fresh challenge + correct signature links.
    const ok = await link(h, a.id, alice);
    assert.equal(ok.status, 200);
    assert.equal((await h.call('GET', `/api/players/${a.id}`)).json.wallet, alice.address);

    // Replaying alice's signed message for bob's player fails (message names alice + nonce).
    const { json: chB } = await h.call('POST', `/api/players/${b.id}/wallet/challenge`);
    const replay = await h.call('POST', `/api/players/${b.id}/wallet`, { wallet: alice.address, signature: alice.sign(ch.message) });
    assert.equal(replay.status, 401);

    // Bob can't link alice's wallet even with alice's valid signature on bob's challenge.
    const { json: chB2 } = await h.call('POST', `/api/players/${b.id}/wallet/challenge`);
    const dup = await h.call('POST', `/api/players/${b.id}/wallet`, { wallet: alice.address, signature: alice.sign(chB2.message) });
    assert.equal(dup.status, 409);
    assert.ok(chB);

    // Expired challenge.
    const { json: old } = await h.call('POST', `/api/players/${b.id}/wallet/challenge`);
    h.clock.t += 11 * 60_000;
    const late = await h.call('POST', `/api/players/${b.id}/wallet`, { wallet: mallory.address, signature: mallory.sign(old.message) });
    assert.equal(late.status, 400);

    // Wallet-hopping cooldown: alice can't switch to another wallet within 24h, even via unlink.
    await h.call('DELETE', `/api/players/${a.id}/wallet`);
    const hop = await link(h, a.id, keypair());
    assert.equal(hop.status, 429);
    assert.equal((await link(h, a.id, alice)).status, 200); // same wallet back is fine
    h.clock.t += 25 * 3600_000;
    assert.equal((await link(h, a.id, keypair())).status, 200);

    assert.equal((await h.call('POST', `/api/players/${a.id}/wallet`, { wallet: 'nope', signature: 'x' })).status, 400);
  } finally {
    await h.close();
  }
});

test('rewards export: top linked players as (wallet, weight), json/csv/snapshot/seats', async () => {
  const h = await boot();
  try {
    const kps = [keypair(), keypair(), keypair()];
    const big = await playerWithScore(h, 'big', 5);
    const mid = await playerWithScore(h, 'mid', 2);
    const unlinked = await playerWithScore(h, 'nowallet', 6);
    await link(h, big.id, kps[0]);
    await link(h, mid.id, kps[1]);
    assert.ok(unlinked.id);

    const r = await h.call('GET', '/api/rewards?top=10');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.recipients.map((x) => x.wallet), [kps[0].address, kps[1].address]);
    assert.ok(r.json.recipients[0].weight > r.json.recipients[1].weight);

    const top1 = await h.call('GET', '/api/rewards?top=1&weight=linear');
    assert.equal(top1.json.recipients.length, 1);
    assert.equal(top1.json.recipients[0].weight, top1.json.recipients[0].score);

    const csv = await h.call('GET', '/api/rewards?format=csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.equal(csv.text.trim().split('\n').length, 3);

    const snap = await h.call('GET', '/api/rewards?format=snapshot');
    assert.equal(snap.json.holderCount, 2);
    assert.equal(snap.json.slot, 1);
    assert.equal(snap.json.holders[0].owner, kps[0].address);

    const seats = await h.call('GET', '/api/seats?mint=anything');
    assert.deepEqual(seats.json.seats.map((s) => s.wallet), [kps[0].address, kps[1].address]);
    const sweep = await h.call('POST', '/api/seats/sweep', { mint: 'anything' });
    assert.equal(sweep.status, 200);

    // Leaderboard shows everyone, marks who is payable, never leaks full wallets.
    const lb = await h.call('GET', '/api/leaderboard');
    assert.equal(lb.json.top[0].name, 'nowallet');
    assert.equal(lb.json.top[0].rewarded, false);
    assert.equal(lb.json.top[1].rewarded, true);
    assert.ok(!JSON.stringify(lb.json).includes(kps[0].address));
    assert.equal(JSON.stringify(lb.json).includes(big.id), false); // secret ids never leak

    // Last season is empty now, and becomes the paid list once the week rolls.
    assert.equal((await h.call('GET', '/api/rewards?season=last')).json.count, 0);
    h.clock.t += 7 * 86400_000;
    assert.equal((await h.call('GET', '/api/rewards?season=last')).json.count, 2);
    assert.equal((await h.call('GET', '/api/rewards?season=99')).status, 400);

    // Motherlode pot: one hit's winners, weighted by power on the rack, linked wallets only.
    h.board.s.hits.unshift({ epoch: 123, paid: 5 * CHIP, winners: [{ tag: big.tag, weight: 30 }, { tag: unlinked.tag, weight: 10 }, { tag: mid.tag, weight: 20 }] });
    const ml = await h.call('GET', '/api/rewards?pot=motherlode&epoch=123');
    assert.deepEqual(ml.json.recipients.map((x) => [x.wallet, x.weight]), [[kps[0].address, 30], [kps[1].address, 20]]);
    assert.equal((await h.call('GET', '/api/rewards?pot=motherlode&epoch=123&format=snapshot')).json.slot, 123);
    assert.equal((await h.call('GET', '/api/rewards?pot=motherlode&epoch=1')).status, 404);
    assert.equal((await h.call('GET', '/api/motherlodes')).json[0].epoch, 123);
  } finally {
    await h.close();
  }
});

test('seats endpoint refuses a different mint when CSTR_MINT is set', async () => {
  const h = await boot({ mint: 'So11111111111111111111111111111111111111112' });
  try {
    assert.equal((await h.call('GET', '/api/seats?mint=Other')).status, 404);
    assert.equal((await h.call('GET', '/api/seats?mint=So11111111111111111111111111111111111111112')).status, 200);
  } finally {
    await h.close();
  }
});

test('registration is rate limited per IP', async () => {
  const h = await boot({ regLimit: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await h.call('POST', '/api/players', { name: `p${i}` })).status, 200);
    assert.equal((await h.call('POST', '/api/players', { name: 'p4' })).status, 429);
  } finally {
    await h.close();
  }
});

test('saves persist to DATA_DIR and clicker-era saves migrate on boot', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cstr-legacy-'));
  const id = 'a'.repeat(32);
  fs.writeFileSync(
    path.join(dataDir, 'players.json'),
    JSON.stringify({ [id]: { name: 'vet', state: { totalCycles: 5e12, cycles: 1, buildings: { dc: 9999 } }, createdAt: 1, updatedAt: 1 } })
  );
  const opts = { dataDir, now: () => T0, autoTick: false, beacon: fakeBeacon, chainLength: 5000 };
  const first = createApp(opts);
  const p = first.store.get(id);
  assert.equal(p.v, 3);
  assert.equal(p.legacyTotal, 5e12);
  assert.equal(p.power, 300);
  const anchor = first.chain.anchor;
  first.close();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'players.json'), 'utf8'));
  assert.equal(onDisk[id].v, 3);
  // The seed secret persists (0600), so a restart keeps the same committed chain.
  const secretFile = path.join(dataDir, 'seed-secret.json');
  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  const second = createApp(opts);
  assert.equal(second.chain.anchor, anchor);
  second.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('security headers + unknown API routes', async () => {
  const h = await boot();
  try {
    const r = await h.call('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(r.headers.get('content-security-policy'), /connect-src 'self' https:\/\/api\.drand\.sh/);
    assert.equal((await h.call('GET', '/healthz')).json.ok, true);
    assert.equal((await h.call('GET', '/api/players/zzz')).status, 404);
  } finally {
    await h.close();
  }
});
