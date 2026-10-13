/* Tiny JSON-file datastore: everything lives in memory and is flushed to
 * DATA_DIR/players.json on a debounce (atomic tmp + rename), and on shutdown.
 * On Railway, DATA_DIR is a mounted volume, so saves survive redeploys.
 */
const fs = require('fs');
const path = require('path');
const { migrate } = require('./engine');

class Store {
  constructor(dataDir, now = Date.now()) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'players.json');
    this.players = {};
    this.wallets = new Map(); // address -> player id (one wallet <-> one player)
    this.timer = null;
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      raw = {};
    }
    let migrated = 0;
    for (const [id, p] of Object.entries(raw)) {
      const m = migrate(p, now);
      if (m !== p) migrated++;
      this.players[id] = m;
      if (m.wallet) this.wallets.set(m.wallet.address, id);
    }
    if (migrated) {
      console.log(`migrated ${migrated} legacy (self-reported) saves to server-verified v2`);
      this.flush();
    }
  }

  get(id) {
    return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? this.players[id] : undefined;
  }

  all() {
    return Object.values(this.players);
  }

  count() {
    return Object.keys(this.players).length;
  }

  flush() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.players));
    fs.renameSync(tmp, this.file);
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
