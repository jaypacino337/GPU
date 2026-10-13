# CSTR — Chip Strategy

An ORE-style mining game with a retro arcade skin. Every **60-second compute
epoch**, players deploy free **power (⚡)** onto a 5×5 board of GPU racks. A
**provably fair** draw picks one rack, and its miners take the round. **CHIPs**
mined each weekly season decide who shares the **$CSTR fee pot**.

- Modelled on ORE (ore.supply, `regolith-labs/ore`): 25 squares, 60s rounds,
  winner-takes-the-losers pro-rata, +1 per round split or to a "top miner",
  and a motherlode jackpot (+0.2 per round, 1 in 500).
- **No real-money wagering.** Power is free, regenerates while you play, and
  can't be bought, sold or withdrawn. A real-SOL version is a separate
  decision: [`docs/REAL-SOL-DECISION.md`](docs/REAL-SOL-DECISION.md).

## An epoch

| | rule (`public/rules.js`, `lib/mining.js`) |
|---|---|
| Deploy | 1–1000 ⚡ per rack per call, any racks, until the epoch closes. Checked server-side against your real balance. |
| Draw | one winning rack from the epoch's verifiable value (below) |
| Power | losing racks' power: **10% burned**, 90% to the winning rack pro-rata. Winners also get their own deploy back. |
| CHIP | **+1 CHIP** per epoch: 50% of epochs split it pro-rata on the winning rack, the rest send it to one **top miner** drawn by power weight |
| Motherlode | +0.2 CHIP per epoch into a jackpot. On a hit (1/500) it goes to the winning rack pro-rata. |
| Edge cases | nobody on the winning rack: the losing power burns and the CHIP rolls into the motherlode. No randomness within 5 min: **void, everyone refunded**. |
| Power supply | 300 ⚡ to start; +10 ⚡/min **only while online** (presence heartbeat), until you reach 600 |

## Provably fair

Each epoch's seed comes from a **hash chain committed at launch**. Its commit
is shown before the epoch opens. The seed is mixed with the **drand quicknet**
round published *after* the epoch closes, whose BLS signature the server
verifies. Anyone can re-check an epoch, in the browser at `/rewards#fairness` or
with `npm run verify-epoch -- <site> <epoch>`. Details are in
[`docs/FAIRNESS.md`](docs/FAIRNESS.md).

## Abuse model

| attack | what stops it |
|---|---|
| Forged balance, double spend | Power lives on the server; every deploy is checked against it. A retried deploy (same `reqId`) applies once. |
| Late deploy / predicting the draw | Deploys into a closed epoch get a 409. The draw needs a drand round published after close, and the seed was committed in advance. |
| Server rigging | Not possible without breaking the hash chain or drand. Stalling only voids and refunds the epoch. Verify any epoch yourself. |
| Power farming with idle tabs | Regen only accrues while you poll (2-min grace) and stops at 600. |
| Spam | Per-IP API and sign-up limits; 20 deploy calls per player per epoch |
| Wallet renting / hopping | ed25519 wallet link with a single-use nonce. One wallet ↔ one player. Switching wallets is limited to once per 24h. |
| **Sybils** (many free accounts) | **The main residual risk.** Each account gets free power. Mitigations: linear weighting (splitting gains nothing), a minimum CHIP to be paid, the per-IP sign-up limit, `--cap-bps`, manual flags (`npm run admin -- flag`), and the optional holder pot (sybils must buy $CSTR). Real-SOL deploys would close it economically; see the decision doc. |

Older clicker saves (v1 self-reported, v2 server-verified) migrate on boot.
Handle, tag, wallet and flags carry over; the clicker total becomes a
display-only `legacyTotal`.

## Rewards

See [`docs/REWARDS.md`](docs/REWARDS.md). Proposed $CSTR fee split via the
shared memcoinz worker:
- **50%** to the miners wallet (weekly, by season CHIPs)
- **15%** to the motherlode wallet (paid on each hit)
- **25%** to buyback + burn
- **10%** to operations

Payout lists are public at `/rewards` and export straight to
`mc airdrop --snapshot`.

## API

| | |
|---|---|
| `GET /api/board` | live epoch (`id`, `endsAt`, `commit`), rack totals, motherlode, last result, recent racks |
| `GET /api/epochs?limit=` · `GET /api/epochs/:epoch` | settled epochs with seed, drand round + signature, value, winners |
| `GET /api/motherlodes` | motherlode hits |
| `POST /api/players {name}` | register → secret id (kept in localStorage) |
| `GET /api/players/:id` | your power, season, last result, deploys this epoch (also the presence heartbeat) |
| `POST /api/players/:id/deploy {epoch, squares, amount, reqId}` | deploy power |
| `POST /api/players/:id/wallet/challenge`, `POST`/`DELETE /api/players/:id/wallet` | wallet link |
| `GET /api/leaderboard?season=` | top 20 by CHIPs (wallets truncated, `rewarded` flag) |
| `GET /api/rewards?season=&top=&weight=&min=&format=json\|csv\|snapshot` | season payout list |
| `GET /api/rewards?pot=motherlode&epoch=&format=…` | a motherlode hit's payout list |
| `GET /api/seats?mint=`, `POST /api/seats/sweep` | memcoinz guest-list protocol (optional holder pot) |
| `GET /api/config`, `GET /api/stats`, `GET /healthz` | meta (`config.fairness` holds the chain anchor and beacon) |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | listen address |
| `DATA_DIR` | `./data` | `players.json`, `board.json`, `seed-secret.json`; **mount a volume** |
| `EPOCH_SECONDS` | `60` | epoch length |
| `CSTR_MINT` / `CSTR_BUY_URL` | — | token CA shown on the site (and enforced on `/api/seats`), buy button |
| `REWARDS_TOP` / `REWARDS_WEIGHT` / `REWARDS_MIN_SCORE` | `25` / `linear` / `1000000` (1 CHIP) | payout list |
| `SEASON_DAYS` / `SEASON_START` | `7` / `2026-10-05T00:00:00Z` | seasons |
| `SEED_CHAIN_LENGTH` | `1048576` | epochs per committed chain (~2 years) |
| `RATE_LIMIT` / `REG_LIMIT` / `MAX_PLAYERS` | `600`/min / `20`/h / `100000` | limits |

## Run

```bash
npm install
npm test                 # fairness (real drand BLS fixture), epoch settlement math, rewards, HTTP end-to-end
npm start                # http://localhost:3000 (needs outbound HTTPS to api.drand.sh)
```

## Deploy (Railway: Docker + volume)

`railway.json` builds the `Dockerfile` and health-checks `/healthz`.
1. New service → this repo. Add a **Volume** at `/data` and set `RAILWAY_RUN_UID=0`.
2. Allow outbound HTTPS to `api.drand.sh` (Railway allows it by default).
3. **Keep 1 replica.** Epoch settlement and power run in-process.
4. Back up `seed-secret.json` privately (`npm run admin -- backup` copies only
   `players.json`). If it's lost, a new chain and anchor start on the next boot;
   past epochs stay verifiable from their published seeds.

The static Vercel build (`vercel.json`) serves the pages only. The live board
needs the Node server.

## Admin

```bash
npm run admin -- stats | top 20 | find <name|wallet> | flagged | flag <id> [why] | unflag <id> | remove <id> | backup
npm run export-rewards -- --url https://<site> --season last
npm run export-rewards -- --url https://<site> --pot motherlode --epoch <epoch>
npm run verify-epoch -- https://<site> <epoch>
```
