const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { keypair } = require('./helpers');

const T0 = Date.parse('2026-10-06T12:00:00Z');

async function boot(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cstr-test-'));
  const clock = { t: T0 };
  const { app, store } = createApp({ dataDir, now: () => clock.t, rewardsMinScore: 0, mint: '', ...extra });
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
      store.close();
      server.close(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
        r();
      });
    });
  return { call, clock, store, close, dataDir };
}

async function playerWithScore(h, name, clicks) {
  const { json: reg } = await h.call('POST', '/api/players', { name });
  const { json: ses } = await h.call('POST', `/api/players/${reg.id}/session`);
  // The click bucket holds 15s worth, so spread the clicks like a real player would.
  for (let seq = 1, left = clicks; left > 0; seq++, left -= 300) {
    h.clock.t += 15_000;
    await h.call('POST', `/api/players/${reg.id}/sync`, { session: ses.session, seq, actions: [{ t: 'c', n: Math.min(300, left) }] });
  }
  return reg;
}

async function link(h, id, kp) {
  const { json: ch } = await h.call('POST', `/api/players/${id}/wallet/challenge`);
  return h.call('POST', `/api/players/${id}/wallet`, { wallet: kp.address, signature: kp.sign(ch.message) });
}

test('register → session → sync is server-authoritative', async () => {
  const h = await boot();
  try {
    const { status, json: reg } = await h.call('POST', '/api/players', { name: 'Neo<script>' });
    assert.equal(status, 200);
    assert.equal(reg.name, 'Neoscript');
    const { json: ses } = await h.call('POST', `/api/players/${reg.id}/session`);
    h.clock.t += 2000;
    const r = await h.call('POST', `/api/players/${reg.id}/sync`, {
      session: ses.session,
      seq: 1,
      actions: [{ t: 'c', n: 500 }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.clicks, 40); // 2s * 20 cps
    assert.equal(r.json.state.totalCycles, 40);
    assert.equal(r.json.season.score, 40);

    // The old "PUT my whole state" endpoint is gone.
    const put = await h.call('PUT', `/api/players/${reg.id}`, { state: { totalCycles: 1e99 } });
    assert.equal(put.status, 410);
    const me = await h.call('GET', `/api/players/${reg.id}`);
    assert.equal(me.json.state.totalCycles, 40);
  } finally {
    await h.close();
  }
});

test('wallet linking: valid signature links, replay/forgery/duplicates rejected', async () => {
  const h = await boot();
  try {
    const a = await playerWithScore(h, 'alice', 100);
    const b = await playerWithScore(h, 'bob', 100);
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
    const big = await playerWithScore(h, 'big', 1000);
    const mid = await playerWithScore(h, 'mid', 400);
    const unlinked = await playerWithScore(h, 'nowallet', 1200);
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

test('saves persist to DATA_DIR and legacy saves migrate on boot', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cstr-legacy-'));
  const id = 'a'.repeat(32);
  fs.writeFileSync(
    path.join(dataDir, 'players.json'),
    JSON.stringify({ [id]: { name: 'vet', state: { totalCycles: 5e12, cycles: 1, buildings: { dc: 9999 } }, createdAt: 1, updatedAt: 1 } })
  );
  const { store } = createApp({ dataDir, now: () => T0 });
  const p = store.get(id);
  assert.equal(p.v, 2);
  assert.equal(p.legacyTotal, 5e12);
  assert.equal(p.game.buildings.dc, 0);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'players.json'), 'utf8'));
  assert.equal(onDisk[id].v, 2);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('security headers + unknown API routes', async () => {
  const h = await boot();
  try {
    const r = await h.call('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await h.call('GET', '/healthz')).json.ok, true);
    assert.equal((await h.call('GET', '/api/players/zzz')).status, 404);
  } finally {
    await h.close();
  }
});
