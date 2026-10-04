/* Leaderboard → payout list.
 *
 * Eligible = wallet linked (signature-verified) + not flagged by anti-cheat +
 * at least `minScore` verified chips in the season. The top N are exported as
 * (wallet, weight). Two output shapes plug straight into memcoinz:
 *
 *   toSnapshot()  memcoinz snapshot JSON → `mc airdrop --snapshot <file>`
 *                 (players-only: weight = balanceRaw, prorata or lottery)
 *   seatsView()   the /api/seats shape   → memcoin.config.json `seats.url`
 *                 (holders ∩ top players: the flywheel snapshots $CSTR holders
 *                 and keeps only these wallets, weighted by token balance)
 */
const { seasonScore } = require('./engine');

const WEIGHTS = ['sqrt', 'linear', 'rank', 'equal'];

/**
 * Score → integer weight. Chip counts grow exponentially, so `linear` hands
 * nearly the whole pot to #1. `sqrt` (default) keeps it skill-ordered but
 * spread; `rank` gives N..1; `equal` gives everyone 1.
 */
function weightOf(score, rank, n, mode) {
  switch (mode) {
    case 'linear': return Math.max(1, Math.floor(score));
    case 'rank': return n - rank + 1;
    case 'equal': return 1;
    default: return Math.max(1, Math.floor(Math.sqrt(score)));
  }
}

/** All players with a score this season, best first (ties: earliest account). */
function ranking(players, sid) {
  return players
    .map((p) => ({ p, score: seasonScore(p, sid) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.p.createdAt - b.p.createdAt);
}

function rewardsList(players, { sid, top = 25, weight = 'sqrt', minScore = 0 }) {
  const eligible = ranking(players, sid)
    .filter((r) => r.p.wallet && !r.p.integrity.flagged && r.score >= minScore)
    .slice(0, top);
  return eligible.map((r, i) => ({
    rank: i + 1,
    wallet: r.p.wallet.address,
    weight: weightOf(r.score, i + 1, eligible.length, weight),
    score: Math.floor(r.score),
    name: r.p.name,
    tag: r.p.tag,
  }));
}

/**
 * memcoinz Snapshot shape (see snapshot.ts). `slot` doubles as the airdrop's
 * plan id + lottery seed, so we use the season number: re-running the same
 * command for the same season resumes the same frozen plan instead of paying
 * twice, and anyone can re-derive lottery winners from the published list.
 */
function toSnapshot(list, { mint, sid, weight, at }) {
  const total = list.reduce((s, r) => s + BigInt(r.weight), 0n);
  return {
    mint,
    decimals: 0,
    tokenProgram: 'cstr-leaderboard',
    slot: sid,
    takenAt: new Date(at).toISOString(),
    settings: { minBalance: 0, exclude: [], includePdas: false, top: list.length, source: 'cstr-leaderboard', season: sid, weight },
    supplyRaw: total.toString(),
    eligibleRaw: total.toString(),
    holderCount: list.length,
    excludedCount: 0,
    holders: list.map((r) => ({
      owner: r.wallet,
      balanceRaw: String(r.weight),
      balance: String(r.weight),
      pctOfSupply: total > 0n ? Number((BigInt(r.weight) * 1_000_000n) / total) / 10_000 : 0,
    })),
  };
}

/** The guest-list shape memcoinz `seatedWallets()` reads: `{ seats: [{ wallet }] }`. */
function seatsView(list, { mint, sid, at }) {
  return {
    mint,
    source: 'cstr-leaderboard',
    season: sid,
    seatCap: list.length,
    seatsTaken: list.length,
    seats: list.map((r, i) => ({ index: i, label: `#${r.rank}`, wallet: r.wallet, score: r.score })),
    at,
  };
}

function toCsv(list) {
  return ['rank,wallet,weight,score,name', ...list.map((r) => `${r.rank},${r.wallet},${r.weight},${r.score},"${r.name.replace(/"/g, '""')}"`)].join('\n') + '\n';
}

module.exports = { WEIGHTS, weightOf, ranking, rewardsList, toSnapshot, seatsView, toCsv };
