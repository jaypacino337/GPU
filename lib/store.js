/* JSON-file datastore. Everything lives in memory and is flushed to DATA_DIR
 * on a debounce (atomic tmp + rename) and on shutdown. On Railway DATA_DIR is a
 * mounted volume, so it survives redeploys.
 *
 *   players.json        players (secret ids → records)
 *   board.json          epochs in flight, settled history, motherlode, stats
 *   seed-secret.json    the seed chain's secret x0. NEVER publish or commit it;
 *                       losing it only means starting a new chain (new anchor).
 */
const fs = require('fs');
const path = require('path');
const { migrate } = require('./engine');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dataDir, now = Date.now(), cfg) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'players.json');
    this.boardFile = path.join(dataDir, 'board.json');
    this.secretFile = path.join(dataDir, 'seed-secret.json');
    this.players = {};
    this.wallets = new Map(); // address -> player id (one wallet <-> one player)
    this.tags = new Map(); // public tag -> player id
    this.timer = null;
    let migrated = 0;
    for (const [id, p] of Object.entries(readJson(this.file, {}))) {
      const m = migrate(p, now, cfg);
      if (m !== p) migrated++;
      this.players[id] = m;
      if (m.wallet) this.wallets.set(m.wallet.address, id);
      this.tags.set(m.tag, id);
    }
    this.board = readJson(this.boardFile, {});
    if (migrated) {
      console.log(`migrated ${migrated} player record(s) to v3 (compute epochs)`);
      this.flush();
    }
  }

  get(id) {
    return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? this.players[id] : undefined;
  }

  byTag(tag) {
    const id = this.tags.get(tag);
    return id ? this.players[id] : undefined;
  }

  add(id, p) {
    this.players[id] = p;
    this.tags.set(p.tag, id);
  }

  all() {
    return Object.values(this.players);
  }

  count() {
    return Object.keys(this.players).length;
  }

  /** The seed chain's secret, created once on first boot. */
  seedSecret(create) {
    let s = readJson(this.secretFile, null);
    if (!s) {
      s = create();
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeJson(this.secretFile, s, 0o600);
    }
    return s;
  }

  flush() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    writeJson(this.file, this.players);
    writeJson(this.boardFile, this.board);
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (err) {
        console.error('flush failed:', err.message);
      }
    }, 2000);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }
}

module.exports = { Store };
