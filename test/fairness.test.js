const test = require('node:test');
const assert = require('node:assert/strict');
const { SeedChain, verifyBeacon, roundAfter, roundTime, epochValue, seedMatches, QUICKNET, sha256 } = require('../lib/fairness');
const { outcome, SQUARES } = require('../public/rules.js');

// A real drand quicknet round (fetched 2026-10-13), checked offline against the League of Entropy key.
const REAL = { round: 33032607, signature: '803ae8baa69a4be6c88848d2fc5dd3aba06c316f30b4456e8f11b2d1a92258bba99d890649fc500032d50080087afec8' };

test('a real drand quicknet beacon verifies; randomness = sha256(signature)', () => {
  const r = verifyBeacon(REAL);
  assert.equal(r, sha256(Buffer.from(REAL.signature, 'hex')).toString('hex'));
});

test('forged or mismatched beacons are rejected', () => {
  assert.throws(() => verifyBeacon({ ...REAL, round: REAL.round + 1 }), /bad signature/);
  const flipped = (REAL.signature[0] === 'a' ? 'b' : 'a') + REAL.signature.slice(1);
  assert.throws(() => verifyBeacon({ ...REAL, signature: flipped }));
  assert.throws(() => verifyBeacon({ round: 1, signature: 'zz' }), /malformed/);
});

test('the sampled drand round is always published after the epoch closes', () => {
  for (const endsAt of [1791900000000, 1791900060000, 1791900061234]) {
    const r = roundAfter(endsAt);
    assert.ok(roundTime(r) > endsAt, 'round must come strictly after close');
    assert.ok(roundTime(r) - endsAt <= 2 * QUICKNET.period * 1000);
  }
});

test('seed chain: commits are fixed in advance and each seed hashes to its commit', () => {
  const chain = new SeedChain({ x0: 'ab'.repeat(32), length: 3000, genesisEpoch: 100 });
  assert.equal(chain.commit(100), chain.anchor); // first epoch's commit is the published anchor
  for (const e of [100, 101, 1500, 3098]) {
    assert.ok(seedMatches(chain.seed(e), chain.commit(e)));
    assert.equal(chain.commit(e + 1), chain.seed(e)); // next commit = this seed
  }
  // Any later seed hashes forward to the anchor.
  assert.ok(seedMatches(chain.seed(2000), chain.anchor, 2000 - 100 + 1));
  assert.equal(chain.seed(99), null);
  assert.equal(chain.seed(3099), 'ab'.repeat(32)); // the last epoch reveals x0 itself
  assert.equal(chain.seed(3100), null);
  // Same secret → same chain (persisted secret survives restarts).
  assert.equal(new SeedChain({ x0: 'ab'.repeat(32), length: 3000, genesisEpoch: 100 }).anchor, chain.anchor);
});

test('epoch value + outcome are deterministic and cover all 25 racks evenly', () => {
  const v = epochValue(42, 'cd'.repeat(32), 'ef'.repeat(32));
  assert.equal(v, epochValue(42, 'cd'.repeat(32), 'ef'.repeat(32)));
  assert.notEqual(v, epochValue(43, 'cd'.repeat(32), 'ef'.repeat(32)));
  const counts = Array(SQUARES).fill(0);
  let splits = 0;
  let hits = 0;
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const o = outcome(epochValue(i, 'cd'.repeat(32), 'ef'.repeat(32)), 100, 500);
    counts[o.square]++;
    if (o.split) splits++;
    if (o.motherlode) hits++;
    assert.ok(o.sample >= 0 && o.sample < 100);
  }
  for (const c of counts) assert.ok(Math.abs(c - N / 25) < N / 25 * 0.1, `rack count ${c} out of range`);
  assert.ok(Math.abs(splits / N - 0.5) < 0.02);
  assert.ok(hits > 50 && hits < 160, `motherlode hits ${hits} (expect ~100)`);
});
