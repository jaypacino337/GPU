#!/usr/bin/env node
/*
 * Independently verify a settled compute epoch against a live CSTR server.
 * Trusts nothing the server says without checking it:
 *
 *   node scripts/verify-epoch.js https://cstr.example 29342871
 *
 *  1. seed → commit: sha256(seed) must equal the commit shown before the epoch,
 *     and hashing the seed forward must reach the published chain anchor.
 *  2. drand: fetches the round straight from api.drand.sh and verifies its BLS
 *     signature against the League of Entropy quicknet key.
 *  3. outcome: recomputes value = sha256("CSTR-epoch:"+epoch | seed | randomness)
 *     and the winning rack / split / motherlode roll from public/rules.js.
 */
const { verifyBeacon, epochValue, seedMatches, QUICKNET } = require('../lib/fairness');
const { outcome, label } = require('../public/rules.js');

const [base, epochArg] = process.argv.slice(2);
if (!base || !epochArg) {
  console.error('usage: verify-epoch.js <server-url> <epoch>');
  process.exit(1);
}

const get = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
};

(async () => {
  const epoch = Number(epochArg);
  const [cfg, ep] = await Promise.all([get(new URL('/api/config', base)), get(new URL(`/api/epochs/${epoch}`, base))]);
  if (ep.pending) throw new Error('epoch not settled yet');
  if (ep.void) return console.log(`epoch ${epoch} was VOID (${ep.reason}): every deploy was refunded`);
  const checks = [];
  const check = (name, ok) => checks.push([name, ok]);

  const { anchor, genesisEpoch } = cfg.fairness.chain;
  check('seed hashes to the pre-published commit', seedMatches(ep.seed, ep.commit));
  check('seed chains back to the anchor', seedMatches(ep.seed, anchor, epoch - genesisEpoch + 1));

  const beacon = await get(QUICKNET.api + ep.drand.round);
  const randomness = verifyBeacon(beacon); // throws on a bad BLS signature
  check(`drand round ${ep.drand.round} BLS signature (fetched from drand directly)`, true);
  check('server used the same drand signature', beacon.signature === ep.drand.signature);
  check('drand round published after the epoch closed', (QUICKNET.genesis + (ep.drand.round - 1) * QUICKNET.period) * 1000 > ep.endsAt);

  const value = epochValue(epoch, ep.seed, randomness);
  const o = outcome(value, ep.totals[ep.square]);
  check('value matches', value === ep.value);
  check(`winning rack ${label(o.square)}`, o.square === ep.square);
  check(`CHIP ${o.split ? 'split pro-rata' : 'to one top miner'}`, o.split === ep.split);
  check(`motherlode ${o.motherlode ? 'HIT' : 'no hit'}`, o.motherlode === ep.motherlode.hit);

  for (const [name, ok] of checks) console.log(`${ok ? '✔' : '✖'} ${name}`);
  const pass = checks.every(([, ok]) => ok);
  console.log(pass ? `\nPASS: epoch ${epoch} is provably fair` : `\nFAIL: epoch ${epoch} does not verify`);
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
