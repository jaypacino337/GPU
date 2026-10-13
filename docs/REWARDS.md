# $CSTR rewards runbook (compute epochs)

Gameplay is free (power ⚡). **Real rewards come only from $CSTR trading fees**,
claimed and routed by the shared memcoinz flywheel worker. Everything here is a
**dry run until you add `--send` / `LIVE=true` yourself**. Keys live in env vars
or local files and are never committed.

## 1. Proposed fee split

The flywheel claims pump.fun creator fees every cycle and splits them by
`route`. Proposed for CSTR (ORE-shaped: winners, motherlode, buyback + burn):

| bucket (memcoinz `route` key) | % | goes to | paid how |
|---|---|---|---|
| `treasury` → **miners wallet** | **50** | top miners of the season | weekly, pro-rata by CHIPs mined (section 3) |
| `lp` → **motherlode wallet** | **15** | miners on the rack of each motherlode hit | when the in-game motherlode hits (section 4) |
| `buyback` | **25** | market-buy $CSTR and **burn** it | every cycle, by the worker (memcoinz `/buyback-burn`) |
| `creator` | **10** | operations (RPC, hosting, you) | every cycle |

Why: half the fees go to people who actually play. The motherlode gives players
a real jackpot to chase, mirroring ORE's in-game one. A quarter is permanent
buy pressure plus supply reduction (ORE sends its 10% protocol cut to
buybacks). The `lp` key is used only because memcoinz's route buckets are fixed
names: on a plain worker it's a SOL transfer to `payTo.lp`, with no liquidity
involved. Tune the numbers freely; they must total 100.

## 2. Worker config (Railway → memcoinz repo → `deploy/worker/railway.json`)

Volume at `/data`, then variables:

```
MEMCOIN_CONFIG_JSON = {
  "mint": "<CSTR_MINT>",
  "wallets": { "creator": "CREATOR_KEYPAIR" },
  "route": { "treasury": 50, "lp": 15, "buyback": 25, "creator": 10 },
  "payTo": { "treasury": "<MINERS wallet pubkey>", "lp": "<MOTHERLODE wallet pubkey>", "creator": "<your wallet>" },
  "intervalMinutes": 15
}
CREATOR_KEYPAIR  = <sealed variable>
SOLANA_RPC_URL   = https://mainnet.helius-rpc.com/?api-key=…
RAILWAY_RUN_UID  = 0
LIVE             = (unset for a dry-run week, then "true")
```

No `airdrop` bucket and no `seats.url` are needed. See section 5 for the
optional holder pot.

## 3. Weekly miners payout (season CHIPs)

Seasons are weekly (UTC) from `SEASON_START`. Eligible: linked wallet
(ed25519-verified), not flagged, and at least `REWARDS_MIN_SCORE` micro-CHIP
(default 1 CHIP). The top `REWARDS_TOP` (25) are exported, weighted **linearly
by CHIPs mined**. Linear is the only weighting where splitting play across
accounts gains nothing; cap whales with `--cap-bps` instead.

```bash
npm run admin -- flagged                                         # review first
npm run export-rewards -- --url https://<site> --season last     # → rewards/season-<n>.json
~/memcoinz/bin/mc airdrop --snapshot rewards/season-<n>.json \
  --pot balance --reserve 0.05 --mode prorata --cap-bps 1500 --payer ~/keys/cstr-miners.json   # dry run
# review it, then the SAME command + --send
```

The snapshot's `slot` is the season number, so re-running the same command
resumes the same frozen plan and never pays twice. Keep `ledgers/`.

## 4. Motherlode payout

When an epoch hits the motherlode (1/500, about every 8 hours at 60s epochs),
it appears at `/api/motherlodes` and on `/rewards#motherlodes`.

```bash
npm run export-rewards -- --url https://<site> --pot motherlode --epoch <epoch>   # → rewards/motherlode-<epoch>.json
~/memcoinz/bin/mc airdrop --snapshot rewards/motherlode-<epoch>.json \
  --pot <half the motherlode wallet balance> --mode prorata --payer ~/keys/cstr-motherlode.json   # dry run, then --send
```

Weights are the power each linked winner had on the winning rack, the same
split as the in-game jackpot. Paying out **half** the wallet each hit keeps a
visible jackpot for the next one; pay everything if you prefer bigger, rarer
hits. Unlinked or flagged winners are left out, and their share goes to the rest.

## 5. Optional: a holder pot (holders ∩ top miners)

`/api/seats?mint=<CSTR_MINT>` still implements the memcoinz guest-list
protocol. Add `"airdrop": N` to `route` and `"seats": { "url": "https://<site>" }`
to the config. The worker then pays **$CSTR holders who are also top miners
this season**, by token balance. If the site can't be reached, the snapshot
refuses to pay.

## 6. Before going live

- Fee-funded recurring payouts can look like a security in some
  jurisdictions, and a free game with prizes can be a sweepstakes under
  promotion law. Get both checked before `LIVE=true` / `--send`.
- Run a dry-run week and compare the worker logs with `/rewards`.
- **Real-SOL deploys are a separate decision:** see `docs/REAL-SOL-DECISION.md`.
