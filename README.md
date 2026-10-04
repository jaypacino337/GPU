# CSTR — Chip Strategy

Compute is the new gold. Mine chips by clicking the die, spend them on
mining hardware that generates chips automatically, overclock your click
power, and eventually tape out a **next-gen chip** for a permanent output
bonus. A global leaderboard ranks players by lifetime chips mined.

## How it works

- **Click the chip** → mine chips (starts at 1 per click).
- **Compute hardware** → 8 buildings from USB Miner (+1/sec) to
  Superintelligence Lab (+60K/sec). Each purchase raises that building's next price
  by 15%.
- **Overclock** → doubles chips per click each level, cost grows 6× per level.
- **Next-Gen Chip (prestige)** → every 10M lifetime chips earns one
  generation point. Resetting grants +10% permanent output per point.
- **Offline earnings** → idle production is credited for time away (max 8h).
- **Progress** lives in the browser (localStorage, saved every 5s and when the
  tab is hidden). Nothing is real: no token, no wallet, no actual mining.
- **Leaderboard (optional)** → only when served by the bundled Node server
  (Docker / `npm start`). Scores are self-reported by each browser and are
  labelled as unverified in the UI. On static hosting (Vercel) the game
  detects that `/api` is missing and runs single-player.

## Deploy to Vercel (static, zero setup)

`public/` is a complete static site. `vercel.json` pins Vercel to serve it
as-is (no framework, no build, no install) and adds security headers;
`.vercelignore` keeps `server.js` out so Vercel never turns it into a
serverless function (its JSON-file datastore would not persist there).

```bash
npm i -g vercel
vercel          # first run: link/create the project, accept the defaults
vercel --prod
```

Or in the dashboard: **Add New → Project → import the repo**, pick this
branch, leave Framework Preset / Build / Output on their defaults (they are
overridden by `vercel.json`) and **Deploy**. After the first deploy, set the
`og:image` / `twitter:image` tags in `public/index.html` to the absolute URL
(`https://<your-domain>/og.png`) so link previews render everywhere.

## Stack

- **Backend**: Node.js + Express (`server.js`). REST API with a JSON-file
  datastore (`data/players.json`, debounced atomic writes, flushed on
  shutdown).
  - `POST /api/players` — register, returns a secret player id
  - `PUT /api/players/:id` — save game state (server-side validated)
  - `GET /api/players/:id` — load game state
  - `GET /api/leaderboard` — top 10 by lifetime chips
  - `GET /healthz` — liveness probe for hosting platforms
- **Frontend**: vanilla HTML/CSS/JS single page (`public/`), no build step.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Run in production (with leaderboard)

The server is production-hardened out of the box: security headers + CSP,
per-IP API rate limiting, request size limits, `trust proxy` for hosts
behind a load balancer, a `/healthz` endpoint, and graceful shutdown that
flushes pending saves.

Configuration (all optional, via environment variables):

| Variable      | Default        | Purpose                              |
| ------------- | -------------- | ------------------------------------ |
| `PORT`        | `3000`         | listen port                          |
| `HOST`        | `0.0.0.0`      | bind address                         |
| `DATA_DIR`    | `./data`       | where player saves are stored        |
| `RATE_LIMIT`  | `300`          | API requests per minute per IP       |
| `MAX_PLAYERS` | `100000`       | registration cap                     |

### Docker

```bash
docker build -t cstr .
docker run -p 3000:3000 -v cstr-data:/data cstr
```

The volume keeps player saves across deploys. Any platform that runs a
Docker image or a Node app (Fly.io, Railway, Render, a plain VPS behind
nginx/Caddy for TLS) works — point it at `npm start` and persist `DATA_DIR`.

## Admin utility

`scripts/admin.js` manages the live datastore:

```bash
npm run admin -- stats          # player counts, total chips mined
npm run admin -- top 20         # leaderboard with last-seen times
npm run admin -- find alice     # look up players by name
npm run admin -- remove <id>    # delete a player (restart server after)
npm run admin -- backup         # timestamped datastore backup
```

Set `DATA_DIR` to match the server when it runs somewhere custom.
