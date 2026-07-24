# CPU — the game

An incremental idle game about silicon. Click the chip to earn **cycles**, spend
them on hardware that generates cycles automatically, overclock your click
power, and eventually retire the whole chip for a permanent **architecture**
bonus. A global leaderboard ranks players by lifetime cycles.

## How it works

- **Click the CPU** → earn cycles (starts at 1 per click).
- **Hardware shop** → 8 buildings from Extra Core (+1/sec) to Datacenter
  (+60K/sec). Each purchase raises that building's next price by 15%.
- **Overclock** → doubles click power each level, cost grows 6× per level.
- **New Architecture (prestige)** → every 10M lifetime cycles earns one
  architecture point. Resetting grants +10% permanent output per point.
- **Leaderboard** → top 10 players by lifetime cycles, refreshed live.
- Progress autosaves to the server every 15s (and to localStorage as a
  fallback, so it works offline too).

## Stack

- **Backend**: Node.js + Express (`server.js`). REST API with a JSON-file
  datastore (`data/players.json`, written with debounced atomic writes).
  - `POST /api/players` — register, returns a secret player id
  - `PUT /api/players/:id` — save game state (server-side validated)
  - `GET /api/players/:id` — load game state
  - `GET /api/leaderboard` — top 10 by lifetime cycles
- **Frontend**: vanilla HTML/CSS/JS single page (`public/`), no build step.

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

`PORT` env var overrides the default port.
