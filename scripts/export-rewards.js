#!/usr/bin/env node
/*
 * Export the leaderboard payout list as a memcoinz snapshot file, ready for
 * `mc airdrop --snapshot <file>` (dry run by default; nothing is sent here).
 *
 *   node scripts/export-rewards.js --url https://cstr.example        # live server
 *   node scripts/export-rewards.js --data-dir ./data                 # read the datastore directly
 *
 * Flags: --season last|current|<n> (default last = the week that just ended)
 *        --top 25  --weight sqrt|linear|rank|equal  --min 1000000
 *        --out rewards/season-<n>.json
 */
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const { values: a } = parseArgs({
  options: {
    url: { type: 'string' },
    'data-dir': { type: 'string' },
    season: { type: 'string', default: 'last' },
    top: { type: 'string' },
    weight: { type: 'string' },
    min: { type: 'string' },
    out: { type: 'string' },
  },
});

async function fromUrl() {
  const u = new URL('/api/rewards', a.url);
  u.searchParams.set('format', 'snapshot');
  u.searchParams.set('season', a.season);
  if (a.top) u.searchParams.set('top', a.top);
  if (a.weight) u.searchParams.set('weight', a.weight);
  if (a.min) u.searchParams.set('min', a.min);
  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${u} → HTTP ${res.status}`);
  return res.json();
}

function fromDisk() {
  process.env.DATA_DIR = a['data-dir'];
  const engine = require('../lib/engine');
  const rewards = require('../lib/rewards');
  const { Store } = require('../lib/store');
  const { configFromEnv } = require('../server');
  const cfg = configFromEnv();
  const store = new Store(cfg.dataDir);
  const cur = engine.seasonAt(Date.now(), cfg.engine).id;
  const sid = a.season === 'current' ? cur : a.season === 'last' ? Math.max(0, cur - 1) : Number(a.season);
  const weight = a.weight || cfg.rewardsWeight;
  const list = rewards.rewardsList(store.all(), {
    sid,
    top: Number(a.top || cfg.rewardsTop),
    weight,
    minScore: Number(a.min ?? cfg.rewardsMinScore),
  });
  return rewards.toSnapshot(list, { mint: cfg.mint || 'CSTR-leaderboard', sid, weight, at: Date.now() });
}

(async () => {
  if (!a.url && !a['data-dir']) {
    console.error('usage: export-rewards.js (--url <server> | --data-dir <dir>) [--season last] [--top 25] [--weight sqrt] [--min N] [--out file]');
    process.exit(1);
  }
  const snap = a.url ? await fromUrl() : fromDisk();
  const out = a.out || path.join('rewards', `season-${snap.slot}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap, null, 2));

  console.log(`season ${snap.slot} · ${snap.holderCount} recipients · weight ${snap.settings.weight} · total weight ${snap.eligibleRaw}`);
  for (const h of snap.holders.slice(0, 10)) console.log(`  ${h.owner}  w=${h.balanceRaw}  (${h.pctOfSupply}%)`);
  if (snap.holderCount > 10) console.log(`  … ${snap.holderCount - 10} more`);
  console.log(`\nwrote ${out}`);
  if (!snap.holderCount) return console.log('nobody eligible: nothing to pay.');
  console.log('\nnext (DRY RUN, review it, then add --send yourself):');
  console.log(`  ~/memcoinz/bin/mc airdrop --snapshot ${out} --pot <SOL> --mode prorata --cap-bps 1500 --payer <rewards-keypair.json>`);
  console.log(`  ~/memcoinz/bin/mc airdrop --snapshot ${out} --pot <SOL> --mode lottery --winners 5 --payer <rewards-keypair.json>`);
})().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
