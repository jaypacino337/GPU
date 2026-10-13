/* Provably fair epoch randomness: an off-chain port of ORE's Entropy design
 * (regolith-labs/entropy: hash-chain commit-reveal + slot-hash sampling).
 *
 *  1. Commit: at chain creation the server draws a secret x0 and publishes the
 *     anchor x_N = sha256^N(x0). Epoch j uses seed_j = x_(N-j), so every seed is
 *     fixed in advance and each revealed seed hashes to the previous one: the
 *     server is locked in and cannot pick a seed per epoch.
 *  2. Sample: the seed is mixed with the drand "quicknet" beacon round that is
 *     published *after* the epoch closes (BLS-signed by the League of Entropy,
 *     verifiable by anyone). The server cannot know it while deploys are open,
 *     and drand never sees the seed. Like ORE using a future slot hash, but
 *     with a beacon that needs no RPC and carries a signature we verify.
 *  3. Reveal: after settlement the seed is published with the drand round and
 *     signature, so anyone can recompute the winning rack (see /rewards).
 *
 *  value = sha256("CSTR-epoch:" + epoch | seed | sha256(drand signature))
 *  The rack, top-miner sample and motherlode roll are read from `value` by
 *  public/rules.js `outcome()`, which the browser also runs to verify.
 */
const crypto = require('crypto');
const { bls12_381 } = require('@noble/curves/bls12-381');

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

// drand quicknet (League of Entropy mainnet, 3s rounds, unchained G1 sigs).
const QUICKNET = {
  name: 'drand quicknet',
  chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  publicKey:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesis: 1692803367,
  period: 3,
  api: 'https://api.drand.sh/v2/beacons/quicknet/rounds/',
};
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';

/** First drand round published strictly after `ms` (so it can't be known before then). */
function roundAfter(ms, info = QUICKNET) {
  return Math.floor((ms / 1000 - info.genesis) / info.period) + 2;
}
const roundTime = (round, info = QUICKNET) => (info.genesis + (round - 1) * info.period) * 1000;

/** Verify a quicknet beacon: BLS sig over sha256(round as u64 BE). Returns randomness hex. */
function verifyBeacon({ round, signature }, info = QUICKNET) {
  if (!Number.isInteger(round) || round < 1 || typeof signature !== 'string' || !/^[0-9a-f]{96}$/.test(signature)) {
    throw new Error('malformed beacon');
  }
  const msg = sha256(Buffer.from(BigInt(round).toString(16).padStart(16, '0'), 'hex'));
  const ok = bls12_381.shortSignatures.verify(signature, bls12_381.shortSignatures.hash(msg, DST), info.publicKey);
  if (!ok) throw new Error(`drand round ${round}: bad signature`);
  return sha256(Buffer.from(signature, 'hex')).toString('hex');
}

/** Live beacon client. get(round) → verified { round, signature, randomness } or null if not out yet. */
function drandBeacon(info = QUICKNET) {
  return {
    info,
    async get(round) {
      if (Date.now() < roundTime(round, info)) return null;
      const res = await fetch(info.api + round, { signal: AbortSignal.timeout(5000) });
      if (res.status === 404 || res.status === 425) return null;
      if (!res.ok) throw new Error(`drand HTTP ${res.status}`);
      const b = await res.json();
      if (b.round !== round) throw new Error('drand returned the wrong round');
      return { round, signature: b.signature, randomness: verifyBeacon(b, info) };
    },
  };
}

/**
 * Hash chain of seeds. Only x0 is secret; checkpoints every 1024 links keep
 * any seed one ≤1024-hash walk away without holding the whole chain in memory.
 */
class SeedChain {
  constructor({ x0, length, genesisEpoch }) {
    this.length = length;
    this.genesisEpoch = genesisEpoch;
    this.cp = [];
    let x = Buffer.from(x0, 'hex');
    for (let i = 0; i <= length; i++) {
      if (i % 1024 === 0) this.cp.push(x);
      if (i < length) x = sha256(x);
    }
    this.anchor = x.toString('hex');
  }
  static create(genesisEpoch, length = 1 << 20) {
    return { x0: crypto.randomBytes(32).toString('hex'), length, genesisEpoch };
  }
  link(i) {
    let x = this.cp[Math.floor(i / 1024)];
    for (let k = i % 1024; k > 0; k--) x = sha256(x);
    return x;
  }
  /** Index of an epoch in the chain (1-based), or null if outside it. */
  index(epoch) {
    const j = epoch - this.genesisEpoch + 1;
    return j >= 1 && j <= this.length ? j : null;
  }
  /** Public commitment for an epoch = sha256(seed) = previous seed (or the anchor). */
  commit(epoch) {
    const j = this.index(epoch);
    return j === null ? null : this.link(this.length - j + 1).toString('hex');
  }
  /** The secret seed. Only call once the epoch is closed and its beacon is known. */
  seed(epoch) {
    const j = this.index(epoch);
    return j === null ? null : this.link(this.length - j).toString('hex');
  }
  publicInfo() {
    return { anchor: this.anchor, genesisEpoch: this.genesisEpoch, length: this.length };
  }
}

function epochValue(epoch, seedHex, randomnessHex) {
  return sha256(Buffer.from(`CSTR-epoch:${epoch}`), Buffer.from(seedHex, 'hex'), Buffer.from(randomnessHex, 'hex')).toString('hex');
}

/** Check a revealed seed against a commitment (hash forward over any gap). */
function seedMatches(seedHex, commitHex, steps = 1) {
  let x = Buffer.from(seedHex, 'hex');
  for (let i = 0; i < steps; i++) x = sha256(x);
  return x.toString('hex') === commitHex;
}

module.exports = { QUICKNET, roundAfter, roundTime, verifyBeacon, drandBeacon, SeedChain, epochValue, seedMatches, sha256 };
