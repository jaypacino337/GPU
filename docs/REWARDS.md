# $CSTR rewards runbook

How leaderboard scores become payouts. Everything here is a **dry run until you
add `--send` / `LIVE=true` yourself**. Keys live in env vars or local files and
are never committed.

## 1. What the game exports

The server publishes the payout list (public, so anyone can audit it):

| URL | What |
|---|---|
| `/rewards` | Human-readable audit page |
| `/api/rewards?season=last` | `{ recipients: [{ rank, wallet, weight, score, name }] }` |
| `/api/rewards?season=last&format=csv` | Same as CSV |
| `/api/rewards?season=last&format=snapshot` | **memcoinz snapshot JSON**: feed it to `mc airdrop --snapshot` |
| `/api/seats?mint=<CSTR_MINT>` | memcoinz guest-list shape, for `seats.url` in a flywheel config |

Query params: `season=current|last|<n>`, `top=25`, `weight=sqrt|linear|rank|equal`,
`min=<chips>`. The defaults come from the server env (`REWARDS_TOP`,
`REWARDS_WEIGHT`, `REWARDS_MIN_SCORE`).

**Eligible** means a wallet linked by an ed25519 signature, no anti-cheat flag,
and at least `REWARDS_MIN_SCORE` server-verified chips in that season. The top N
eligible players are listed.

**Weight.** Chip counts grow exponentially, so `linear` hands almost the whole
pot to #1. The default `sqrt` keeps the order but spreads the pot. You can also
cap any single wallet with the airdrop's `--cap-bps`.

Seasons are weekly (UTC), starting `SEASON_START` (default 2026-10-05, a Monday).
Before that is season 0, "preseason". Pay `season=last` once a week ends.

## 2. Players-only pot (weekly script)

Pay a SOL (or SPL) pot to the top players, from a dedicated **rewards wallet**:

```bash
# 1. export last week's list (writes rewards/season-<n>.json)
npm run export-rewards -- --url https://<your-cstr-domain> --season last

# 2. dry run: check the recipients, the amounts and the SOL needed
~/memcoinz/bin/mc airdrop --snapshot rewards/season-<n>.json \
  --pot 2 --mode prorata --cap-bps 1500 --payer ~/keys/cstr-rewards.json

#    or a weighted lottery: the seed is the season number, so anyone can re-derive the winners
~/memcoinz/bin/mc airdrop --snapshot rewards/season-<n>.json \
  --pot 2 --mode lottery --winners 5 --payer ~/keys/cstr-rewards.json

# 3. after reviewing it, re-run the SAME command with --send
```

Pay in $CSTR instead of SOL with `--reward <CSTR_MINT>` (missing ATAs are created
and their rent is shown in the dry run). The airdrop freezes its plan to
`ledgers/airdrop-<mint>-<season>-…plan.json`, so re-running the same command
for the same season **resumes** and never pays anyone twice. Keep the `ledgers/`
folder.

`export-rewards` can also read the datastore directly on the server box:
`npm run export-rewards -- --data-dir /data --season last`.

## 3. Holders ∩ players (shared flywheel worker)

The same top-N list doubles as a memcoinz **guest list**. Point a flywheel at
it with `seats.url`. Each cycle, the worker snapshots $CSTR holders and keeps
**only wallets that are also top-N verified players**, then pays them pro-rata
by **token balance**.

Railway → memcoinz repo → new service → config path `deploy/worker/railway.json`
→ volume at `/data` → variables:

```
MEMCOIN_CONFIG_JSON = {
  "mint": "<CSTR_MINT>",
  "wallets": { "creator": "CREATOR_KEYPAIR" },
  "route": { "airdrop": 40, "treasury": 40, "buyback": 10, "creator": 10 },
  "payTo": { "treasury": "<CSTR rewards wallet pubkey>", "creator": "<your wallet>" },
  "snapshot": { "minBalance": 100000 },
  "airdrop": { "mode": "prorata", "capBps": 1500 },
  "seats": { "url": "https://<your-cstr-domain>" },
  "intervalMinutes": 15
}
CREATOR_KEYPAIR  = <sealed variable>
SOLANA_RPC_URL   = https://mainnet.helius-rpc.com/?api-key=…
RAILWAY_RUN_UID  = 0
LIVE             = (unset for a dry-run week, then "true")
```

memcoinz reads `GET <seats.url>/api/seats?mint=<mint>` (the game rejects any
other mint once `CSTR_MINT` is set). If that request fails, the snapshot
**refuses to pay** rather than paying every holder. It also POSTs
`/api/seats/sweep` first. The game recomputes the list on every read, so that
call is a no-op.

### How the two pots fit together (the route above)

| bucket | goes to | paid how |
|---|---|---|
| `airdrop` 40% | holders who are also top players | every 15 min by the worker, weighted by $CSTR balance |
| `treasury` 40% | the CSTR rewards wallet | weekly players-only drop (section 2), weighted by score |
| `buyback` 10% | market-buy + burn | worker |
| `creator` 10% | you | worker |

Holding $CSTR is **not** required to win the weekly players pot. It is required
for the per-cycle holder pot. Change the split in `route` (it must total 100),
and the worker re-reads it each cycle.

## 4. Before going live

- Recurring payouts funded by trading fees can look like a security in some
  jurisdictions. Get that checked before `LIVE=true` / `--send`.
- Run a dry-run week and compare the worker logs with `/rewards`.
- Review `npm run admin -- flagged` before each weekly payout.
