# CSTR — Chip Strategy

An arcade idle clicker with a **server-verified** global leaderboard. Each
weekly season, the top players with linked wallets split $CSTR fees.

- **Play:** click the chip to mine chips. Buy hardware (8 tiers, +15% price
  each) for idle income, overclock to double each click, and tape out a
  next-gen chip (prestige) for a permanent +10% per generation. Idle income
  keeps accruing while you're away, up to 8h.
- **Compete:** a weekly season score counts every chip the server verified.
  The game itself keeps going between seasons.
- **Earn:** link a Solana wallet with one Phantom signature. The top N linked
  players are exported as `(wallet, weight)` for the memcoinz airdrop. See
  [`docs/REWARDS.md`](docs/REWARDS.md).

## Anti-cheat model

The browser never reports a score. It sends **inputs**, and the server replays
them with the same rules module (`public/rules.js`) on its own clock
(`lib/engine.js`):

| attack | what stops it |
|---|---|
| Edit localStorage / PUT a fake save | No such endpoint any more (`PUT` → 410). State only changes by replaying actions. |
| Forge `"clicks: 1e9"` | Per-action max of 1000. Clicks come from a token bucket that refills at `MAX_CPS` (20) per real second and holds at most 15s worth. Excess clicks are dropped and counted. |
| Autoclicker / bot | Clicks are capped as above. Sustained clicking at ≥85% of the cap for 15 min, or 20k dropped clicks, **flags** the account. Flagged players can still play but are left off the payout list until `npm run admin -- unflag <id>`. |
| Fake idle time / client clock | Idle income uses the **server** time between syncs, capped at 8h offline. |
| Buy what you can't afford | Purchases, overclock and prestige are checked against the server state. Refused actions are counted. |
| Replay / double-submit / two tabs | One live session per player. Each batch has a sequence number, so a retried batch applies exactly once. A second tab takes over the session and the old one gets a 409. |
| Steal someone's wallet / replay a signature | The link message carries a server-issued single-use nonce, an expiry (10 min), the player's name and tag. One wallet ↔ one player. Switching to a different wallet is allowed once per 24h, so top scores can't be rented out. |
| Sign-up spam | Per-IP registration limit (`REG_LIMIT`/hour) on top of the general API limit. |

Remaining risk: **multi-accounting**. One person can run several honest-pace
accounts, each with its own wallet. The click cap and the bot flag make that
slow, and idle income only grows with real time, but it can't be fully stopped
off-chain. Mitigations: a meaningful `REWARDS_MIN_SCORE`, a per-wallet
`--cap-bps`, reviewing `admin flagged` before each payout, and the
holders ∩ players pot, which makes every extra account also buy $CSTR.

Saves from before this version were self-reported. On first boot they migrate
to v2: the run restarts under server rules and the old lifetime total is kept
as display-only `legacyTotal`.

## Wallet linking

`POST /api/players/:id/wallet/challenge` returns a message. Phantom signs it
(`signMessage`, which is free and sends no transaction). `POST
/api/players/:id/wallet {wallet, signature}` then verifies the ed25519
signature with `node:crypto`. A Solana address *is* the 32-byte public key;
this is the same approach as memcoinz `seats-core.ts`. There are no private keys
in the UI or on the server. On mobile without the extension, the button
deep-links into Phantom's in-app browser.

## API

| | |
|---|---|
| `POST /api/players {name}` | register → secret id (kept in localStorage) |
| `POST /api/players/:id/session` | start/take over the live session, credits offline income |
| `POST /api/players/:id/sync {session, seq, actions}` | replay a batch: `{t:'c',n}` clicks, `{t:'b',id}` buy, `{t:'o'}` overclock, `{t:'p'}` prestige |
| `GET /api/players/:id` | your verified state |
| `POST /api/players/:id/wallet/challenge`, `POST`/`DELETE /api/players/:id/wallet` | wallet link |
| `GET /api/leaderboard?season=` | top 20 (wallets truncated, `rewarded` flag) |
| `GET /api/rewards?season=&top=&weight=&min=&format=json\|csv\|snapshot` | payout list |
| `GET /api/seats?mint=`, `POST /api/seats/sweep` | memcoinz guest-list protocol |
| `GET /api/config`, `GET /api/stats`, `GET /healthz` | meta |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | listen address |
| `DATA_DIR` | `./data` | datastore (`players.json`); **mount a volume here** |
| `CSTR_MINT` | — | token mint: shown on the site, enforced on `/api/seats` |
| `CSTR_BUY_URL` | — | "Buy $CSTR" button target |
| `REWARDS_TOP` | `25` | paid seats per season |
| `REWARDS_WEIGHT` | `sqrt` | `sqrt` / `linear` / `rank` / `equal` |
| `REWARDS_MIN_SCORE` | `1000000` | minimum season chips to be paid |
| `SEASON_DAYS` / `SEASON_START` | `7` / `2026-10-05T00:00:00Z` | season length and start |
| `MAX_CPS` | `20` | click rate cap |
| `RATE_LIMIT` / `REG_LIMIT` | `300`/min / `20`/h | per-IP API / sign-up limits |
| `MAX_PLAYERS` | `100000` | registration cap |

## Run

```bash
npm install
npm test          # signature, anti-cheat engine, rewards export, HTTP end-to-end
npm start         # http://localhost:3000
```

## Deploy (Railway: Docker + volume)

`railway.json` builds the `Dockerfile` and health-checks `/healthz`.

1. Railway → New service → this repo. The config-as-code file `railway.json` is picked up automatically.
2. Add a **Volume** mounted at `/data` (the image sets `DATA_DIR=/data`).
3. Variables: `RAILWAY_RUN_UID=0` (Railway volumes mount as root and the image
   runs as `node`), plus `CSTR_MINT` / `CSTR_BUY_URL` / `REWARDS_*` once the
   token exists.
4. Saves are written atomically (tmp + rename) about 2s after each change and
   flushed on SIGTERM, so redeploys don't lose progress. Back up with
   `npm run admin -- backup` (or snapshot the Railway volume).

The datastore is a single JSON file held in memory. That's fine for tens of
thousands of players on one instance. **Don't scale to more than one replica**:
sessions and the click bucket live in that process. Past that, move `lib/store.js`
to Supabase (jsonb + `version` column, as in memcoinz `/deploy`).

A static copy still deploys to Vercel (`vercel.json`), but there it runs
**single-player** only: no leaderboard, wallet or rewards.

## Admin

```bash
npm run admin -- stats | top 20 | find <name|wallet> | flagged | unflag <id> | flag <id> [why] | remove <id> | backup
npm run export-rewards -- --url https://<domain> --season last     # → rewards/season-<n>.json for mc airdrop
```

Write commands edit the file directly, so stop the server first, or restart it after.
