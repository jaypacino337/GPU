#!/usr/bin/env node
/*
 * CSTR admin utility — inspect and manage the player datastore.
 *
 *   node scripts/admin.js stats             overall numbers
 *   node scripts/admin.js top [n]           leaderboard (default 10)
 *   node scripts/admin.js find <name>       look up players by name
 *   node scripts/admin.js remove <id>       delete one player by id
 *   node scripts/admin.js backup [dir]      timestamped copy of the datastore
 *
 * Writes go directly to the JSON file, so run `remove` while the server is
 * stopped (or restart it after) to avoid the server's in-memory copy
 * overwriting the change.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'players.json');

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveDb(players) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(players));
  fs.renameSync(tmp, DB_FILE);
}

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtDate = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '-');

const [cmd, arg] = process.argv.slice(2);
const players = loadDb();
const entries = Object.entries(players);

switch (cmd) {
  case 'stats': {
    const totals = entries.reduce(
      (acc, [, p]) => {
        acc.chips += p.state.totalCycles || 0;
        acc.gens += p.state.architectures || 0;
        return acc;
      },
      { chips: 0, gens: 0 }
    );
    const active = entries.filter(([, p]) => Date.now() - p.updatedAt < 86400000).length;
    console.log(`players:            ${entries.length}`);
    console.log(`active last 24h:    ${active}`);
    console.log(`chips mined (all):  ${fmtNum(totals.chips)}`);
    console.log(`chip generations:   ${fmtNum(totals.gens)}`);
    console.log(`datastore:          ${DB_FILE}`);
    break;
  }

  case 'top': {
    const n = Math.max(1, parseInt(arg, 10) || 10);
    const top = entries
      .sort(([, a], [, b]) => (b.state.totalCycles || 0) - (a.state.totalCycles || 0))
      .slice(0, n);
    for (const [i, [, p]] of top.entries()) {
      console.log(
        `${String(i + 1).padStart(2)}. ${p.name.padEnd(20)} ` +
          `${fmtNum(p.state.totalCycles).padStart(16)} chips   ` +
          `gen ${p.state.architectures || 0}   last seen ${fmtDate(p.updatedAt)}`
      );
    }
    if (!top.length) console.log('no players yet');
    break;
  }

  case 'find': {
    if (!arg) exitUsage();
    const needle = arg.toLowerCase();
    const hits = entries.filter(([, p]) => p.name.toLowerCase().includes(needle));
    for (const [id, p] of hits) {
      console.log(`${id}  ${p.name.padEnd(20)} ${fmtNum(p.state.totalCycles).padStart(16)} chips   joined ${fmtDate(p.createdAt)}`);
    }
    if (!hits.length) console.log('no match');
    break;
  }

  case 'remove': {
    if (!arg) exitUsage();
    if (!players[arg]) {
      console.error('no player with that id');
      process.exit(1);
    }
    const { name } = players[arg];
    delete players[arg];
    saveDb(players);
    console.log(`removed ${name} (${arg}) — restart the server to pick this up`);
    break;
  }

  case 'backup': {
    const dir = arg || DATA_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `players-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(DB_FILE, dest);
    console.log(`backed up ${entries.length} players to ${dest}`);
    break;
  }

  default:
    exitUsage();
}

function exitUsage() {
  console.error('usage: admin.js <stats | top [n] | find <name> | remove <id> | backup [dir]>');
  process.exit(1);
}
