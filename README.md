# CSTR — chip strategy

Microchips are the new gold. Mine chips by clicking the die, spend them on
mining hardware that generates chips automatically, overclock your click
power, and eventually tape out a **next-gen chip** for a permanent output
bonus. A global leaderboard ranks players by lifetime chips mined.

## How it works

- **Click the chip** → mine chips (starts at 1 per click).
- **Mining hardware** → 8 buildings from USB Miner (+1/sec) to Mega
  Datacenter (+60K/sec). Each purchase raises that building's next price
  by 15%.
- **Overclock** → doubles chips per click each level, cost grows 6× per level.
- **Next-Gen Chip (prestige)** → every 10M lifetime chips earns one
  generation point. Resetting grants +10% permanent output per point.
- **Leaderboard** → top 10 players by lifetime chips, refreshed live.
- Progress autosaves to the server every 15s (and to localStorage as a
  fallback, so it works offline too).

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

## Run in production

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
