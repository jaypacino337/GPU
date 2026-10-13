#!/usr/bin/env node
/*
 * CSTR admin utility: inspect and manage the player datastore.
 *
 *   node scripts/admin.js stats             overall numbers
 *   node scripts/admin.js top [n]           this season's leaderboard (default 10)
 *   node scripts/admin.js find <name>       look up players by name
 *   node scripts/admin.js flagged           players the anti-cheat excluded from rewards
 *   node scripts/admin.js unflag <id>       clear a flag after review
 *   node scripts/admin.js flag <id> [why]   exclude a player from rewards
 *   node scripts/admin.js remove <id>       delete one player by id
 *   node scripts/admin.js backup [dir]      timestamped copy of the datastore
 *
 * Writes go directly to the JSON file, so run write commands while the server
 * is stopped (or restart it after) or its in-memory copy will overwrite them.
 */
const fs = require('fs');
const path = require('path');
const engine = require('../lib/engine');
const { Store } = require('../lib/store');
const { configFromEnv } = require('../server');

const cfg = configFromEnv();
const store = new Store(cfg.dataDir);
const players = store.players;
const entries = Object.entries(players);
const sid = engine.seasonAt(Date.now(), cfg.engine).id;

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtDate = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '-');
const chips = (n) => (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 3 });
const line = (id, p) =>
  `${id}  ${p.name.padEnd(20)} ${chips(engine.seasonScore(p, sid)).padStart(12)} CHIP s${sid}  ` +
  `${p.wallet ? p.wallet.address : '(no wallet)'.padEnd(44)}  ${p.integrity.flagged ? 'FLAGGED: ' + p.integrity.reasons.join('; ') : ''}`;

function write(msg) {
  store.flush();
  console.log(`${msg} — restart the server to pick this up`);
}

const [cmd, arg, ...rest] = process.argv.slice(2);
const need = () => {
  if (!arg || !players[arg]) {
    console.error('no player with that id');
    process.exit(1);
  }
  return players[arg];
};

switch (cmd) {
  case 'stats': {
    const active = entries.filter(([, p]) => Date.now() - p.updatedAt < 86400000).length;
    const linked = entries.filter(([, p]) => p.wallet).length;
    const flagged = entries.filter(([, p]) => p.integrity.flagged).length;
    const total = entries.reduce((s, [, p]) => s + engine.seasonScore(p, sid), 0);
    console.log(`players:            ${entries.length}`);
    console.log(`active last 24h:    ${active}`);
    console.log(`wallets linked:     ${linked}`);
    console.log(`flagged:            ${flagged}`);
    console.log(`season ${sid} CHIP:     ${(total / 1e6).toFixed(3)}`);
    console.log(`motherlode:         ${((store.board.motherlode || 0) / 1e6).toFixed(3)} CHIP`);
    console.log(`epochs settled:     ${fmtNum((store.board.stats || {}).settled)} (void ${fmtNum((store.board.stats || {}).voided)})`);
    console.log(`datastore:          ${store.file}`);
    break;
  }
  case 'top': {
    const n = Math.max(1, parseInt(arg, 10) || 10);
    const top = entries.sort(([, a], [, b]) => engine.seasonScore(b, sid) - engine.seasonScore(a, sid)).slice(0, n);
    top.forEach(([id, p], i) => console.log(`${String(i + 1).padStart(3)}. ${line(id, p)}  last seen ${fmtDate(p.updatedAt)}`));
    if (!top.length) console.log('no players yet');
    break;
  }
  case 'find': {
    if (!arg) usage();
    const hits = entries.filter(([, p]) => p.name.toLowerCase().includes(arg.toLowerCase()) || (p.wallet && p.wallet.address === arg));
    hits.forEach(([id, p]) => console.log(line(id, p)));
    if (!hits.length) console.log('no match');
    break;
  }
  case 'flagged': {
    const hits = entries.filter(([, p]) => p.integrity.flagged);
    hits.forEach(([id, p]) => console.log(`${line(id, p)}\n      epochs ${p.totals.epochs} · wins ${p.totals.wins} · power ${p.power}`));
    if (!hits.length) console.log('nobody flagged');
    break;
  }
  case 'unflag': {
    const p = need();
    p.integrity = { flagged: false, reasons: [] };
    write(`cleared flag on ${p.name}`);
    break;
  }
  case 'flag': {
    const p = need();
    engine.flag(p, rest.join(' ') || 'manual review');
    write(`flagged ${p.name}`);
    break;
  }
  case 'remove': {
    const p = need();
    delete players[arg];
    write(`removed ${p.name} (${arg})`);
    break;
  }
  case 'backup': {
    const dir = arg || cfg.dataDir;
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `players-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(store.file, dest);
    console.log(`backed up ${entries.length} players to ${dest}`);
    break;
  }
  default:
    usage();
}

function usage() {
  console.error('usage: admin.js <stats | top [n] | find <name|wallet> | flagged | flag <id> [why] | unflag <id> | remove <id> | backup [dir]>');
  process.exit(1);
}
