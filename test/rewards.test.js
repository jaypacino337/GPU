const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/engine');
const rewards = require('../lib/rewards');

const W = (i) => `${'A'.repeat(43)}${'BCDEFGHJKLMNPQRSTUVWXYZ'[i]}`;

function player(i, score, { wallet = true, flagged = false } = {}) {
  const p = engine.newPlayer(`p${i}`, i);
  p.season = { id: 1, chips: score };
  if (wallet) p.wallet = { address: W(i), linkedAt: 0 };
  p.integrity.flagged = flagged;
  return p;
}

test('only linked, unflagged players above the minimum are paid, best first', () => {
  const players = [
    player(0, 400),
    player(1, 900, { wallet: false }),
    player(2, 100),
    player(3, 10_000, { flagged: true }),
    player(4, 50),
  ];
  const list = rewards.rewardsList(players, { sid: 1, top: 10, minScore: 100 });
  assert.deepEqual(list.map((r) => r.wallet), [W(0), W(2)]);
  assert.deepEqual(list.map((r) => r.rank), [1, 2]);
});

test('top N truncates after eligibility filtering', () => {
  const players = Array.from({ length: 8 }, (_, i) => player(i, (i + 1) * 100));
  const list = rewards.rewardsList(players, { sid: 1, top: 3 });
  assert.equal(list.length, 3);
  assert.equal(list[0].score, 800);
});

test('weight modes', () => {
  assert.equal(rewards.weightOf(1e6, 1, 5, 'sqrt'), 1000);
  assert.equal(rewards.weightOf(1e6, 1, 5, 'linear'), 1e6);
  assert.equal(rewards.weightOf(1e6, 2, 5, 'rank'), 4);
  assert.equal(rewards.weightOf(1e6, 2, 5, 'equal'), 1);
  assert.equal(rewards.weightOf(0.2, 1, 1, 'sqrt'), 1); // never 0: a listed player always gets a share
});

test('snapshot export matches the memcoinz Snapshot shape', () => {
  const list = rewards.rewardsList([player(0, 1e6), player(1, 4e6)], { sid: 1 });
  const s = rewards.toSnapshot(list, { mint: 'MINT', sid: 1, weight: 'sqrt', at: 0 });
  assert.equal(s.slot, 1);
  assert.equal(s.holderCount, 2);
  assert.deepEqual(s.holders.map((h) => [h.owner, h.balanceRaw]), [[W(1), '2000'], [W(0), '1000']]);
  assert.equal(s.eligibleRaw, '3000');
  for (const h of s.holders) assert.equal(typeof h.balanceRaw, 'string');
});

test('seats view exposes exactly the payable wallets', () => {
  const list = rewards.rewardsList([player(0, 5), player(1, 9, { flagged: true })], { sid: 1 });
  const v = rewards.seatsView(list, { mint: 'M', sid: 1, at: 0 });
  assert.deepEqual(v.seats.map((s) => s.wallet), [W(0)]);
});

test('csv export', () => {
  const list = rewards.rewardsList([player(0, 100)], { sid: 1 });
  assert.equal(rewards.toCsv(list), `rank,wallet,weight,score,name\n1,${W(0)},10,100,"p0"\n`);
});
