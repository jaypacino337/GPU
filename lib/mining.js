/* Compute epochs: the ORE-style board, run by the server.
 *
 * Each epoch (60s, wall-clock aligned) players deploy free POWER onto any of
 * the 25 GPU racks. When it closes, the epoch is settled with a provably fair
 * value (lib/fairness.js: committed seed + the drand round published after
 * close):
 *   - winning rack = value word0 % 25
 *   - losing racks' power: 10% burned, 90% split pro-rata to the winning rack
 *     (winners also get their own deploy back; losers lose theirs)
 *   - +1 CHIP: 50/50 split pro-rata across the winning rack, or all to one
 *     "top miner" drawn by power weight in deploy order
 *   - motherlode: on a hit (1/500) the jackpot goes pro-rata to the winning
 *     rack; then +0.2 CHIP is added to it every epoch
 *   - nobody on the winning rack: losing power is burned, the CHIP goes to the motherlode
 *   - no beacon within voidAfterMs: the epoch is void and every deploy is refunded
 * CHIPs mined are the season score, which drives the fee-funded payouts.
 */
const { SQUARES, RULES, label, outcome } = require('../public/rules.js');
const { roundAfter, epochValue } = require('./fairness');
const engine = require('./engine');

const HISTORY = 500;
const MAX_CALLS = 20;

class Board {
  /**
   * state: persisted object ({} on first boot). chain: SeedChain. beacon: { get(round) }.
   * players: { get(id), byTag(tag) }. cfg: engine config (RULES + season settings).
   */
  constructor({ state, chain, beacon, players, cfg, now }) {
    this.s = state;
    this.s.motherlode ??= 0;
    this.s.epochs ??= {};
    this.s.history ??= [];
    this.s.hits ??= [];
    this.s.stats ??= { settled: 0, voided: 0, burned: 0, minted: 0, deployed: 0 };
    this.chain = chain;
    this.beacon = beacon;
    this.players = players;
    this.cfg = cfg;
    this.now = now;
    this.voidAfterMs = cfg.voidAfterMs ?? 5 * 60000;
    this.settling = false;
  }

  epochAt(t) {
    const id = Math.floor(t / this.cfg.epochMs);
    return { id, startsAt: id * this.cfg.epochMs, endsAt: (id + 1) * this.cfg.epochMs };
  }

  record(id) {
    let e = this.s.epochs[id];
    if (!e) {
      const endsAt = (id + 1) * this.cfg.epochMs;
      e = this.s.epochs[id] = { id, endsAt, round: roundAfter(endsAt), totals: Array(SQUARES).fill(0), deploys: {}, order: [], calls: {} };
    }
    return e;
  }

  /** POST /api/players/:id/deploy → { status, body }. */
  deploy(pid, p, input, now) {
    const cur = this.epochAt(now);
    const { epoch, squares, amount, reqId } = input || {};
    if (typeof reqId === 'string' && reqId.length <= 40) {
      p.recentReqs ??= [];
      if (p.recentReqs.includes(reqId)) return { status: 200, body: { duplicate: true } };
    }
    if (epoch !== cur.id) return { status: 409, body: { error: 'epoch closed', code: 'EPOCH', epoch: cur.id } };
    if (!Array.isArray(squares) || squares.length < 1 || squares.length > SQUARES) return { status: 400, body: { error: 'pick 1 to 25 racks' } };
    const set = new Set(squares);
    if (set.size !== squares.length || ![...set].every((q) => Number.isInteger(q) && q >= 0 && q < SQUARES)) {
      return { status: 400, body: { error: 'bad rack list' } };
    }
    if (!Number.isInteger(amount) || amount < this.cfg.minDeploy || amount > this.cfg.maxDeploy) {
      return { status: 400, body: { error: `deploy ${this.cfg.minDeploy}–${this.cfg.maxDeploy} ⚡ per rack` } };
    }
    engine.regen(p, now, this.cfg);
    const cost = amount * squares.length;
    if (cost > p.power) return { status: 400, body: { error: 'not enough power', power: p.power } };
    const e = this.record(cur.id);
    e.calls[pid] = (e.calls[pid] || 0) + 1;
    if (e.calls[pid] > MAX_CALLS) return { status: 429, body: { error: 'too many deploys this epoch' } };

    p.power -= cost;
    const mine = (e.deploys[pid] ??= Array(SQUARES).fill(0));
    for (const q of squares) {
      mine[q] += amount;
      e.totals[q] += amount;
      e.order.push([pid, q, amount]);
    }
    if (typeof reqId === 'string' && reqId.length <= 40) {
      p.recentReqs.push(reqId);
      if (p.recentReqs.length > 20) p.recentReqs.shift();
    }
    p.updatedAt = now;
    return { status: 200, body: { epoch: cur.id, deployed: mine, power: p.power } };
  }

  /** Settle or void every closed epoch we can. Returns the number of epochs finished. */
  async tick() {
    if (this.settling) return 0;
    this.settling = true;
    let done = 0;
    try {
      const now = this.now();
      for (const e of Object.values(this.s.epochs).sort((a, b) => a.id - b.id)) {
        if (now < e.endsAt) continue;
        if (!Object.keys(e.deploys).length) {
          delete this.s.epochs[e.id];
          continue;
        }
        let b = null;
        try {
          b = await this.beacon.get(e.round);
        } catch (err) {
          console.error(`epoch ${e.id}: beacon error: ${err.message}`);
        }
        if (b) {
          this.settle(e, b, this.now());
          done++;
        } else if (now - e.endsAt > this.voidAfterMs) {
          this.void(e, 'randomness beacon unavailable', now);
          done++;
        }
      }
    } finally {
      this.settling = false;
    }
    return done;
  }

  settle(e, beacon, now) {
    const seed = this.chain.seed(e.id);
    const commit = this.chain.commit(e.id);
    if (!seed) return this.void(e, 'outside the committed seed chain', now);
    const value = epochValue(e.id, seed, beacon.randomness);
    const total = e.totals.reduce((a, b) => a + b, 0);
    const pre = outcome(value, 0, this.cfg.motherlodeOdds);
    const w = pre.square;
    const onW = e.totals[w];
    const o = outcome(value, onW, this.cfg.motherlodeOdds);

    const losing = total - onW;
    const burnCut = Math.floor((losing * this.cfg.burnBps) / 10000);
    const pot = losing - burnCut;
    let burned = burnCut;
    let toMotherlode = 0;
    const winners = [];
    const winOrder = e.order.filter(([, q]) => q === w);

    // Top miner: walk deploys on the winning rack in order until the sample falls inside one.
    let top = null;
    if (onW > 0 && !o.split) {
      let acc = 0;
      for (const [pid, , amt] of winOrder) {
        acc += amt;
        if (o.sample < acc) {
          top = pid;
          break;
        }
      }
    }

    const jackpot = o.motherlode && onW > 0 ? this.s.motherlode : 0;
    if (onW > 0) {
      let paidPower = 0;
      let paidChips = 0;
      let paidJackpot = 0;
      for (const [pid, dep] of Object.entries(e.deploys)) {
        const d = dep[w];
        if (!d) continue;
        const share = (x) => Number((BigInt(x) * BigInt(d)) / BigInt(onW)); // exact, no float overflow
        const power = d + share(pot);
        const mined = o.split ? share(this.cfg.emission) : pid === top ? this.cfg.emission : 0;
        const jp = share(jackpot);
        const chips = mined + jp;
        paidPower += power - d;
        paidChips += mined;
        paidJackpot += jp;
        winners.push({ pid, deployed: d, power, chips });
      }
      burned += pot - paidPower; // rounding dust
      toMotherlode += this.cfg.emission - paidChips; // rounding dust stays in the game
      this.s.motherlode -= paidJackpot;
    } else {
      burned += pot;
      toMotherlode += this.cfg.emission; // nobody to pay: the CHIP rolls into the jackpot
    }
    this.s.motherlode += toMotherlode + this.cfg.motherlodePerEpoch;

    // Credit players and record their result.
    const byPid = new Map(winners.map((x) => [x.pid, x]));
    for (const [pid, dep] of Object.entries(e.deploys)) {
      const p = this.players.get(pid);
      if (!p) continue;
      const win = byPid.get(pid);
      if (win) {
        p.power += win.power;
        engine.addChips(p, win.chips, now, this.cfg);
        p.totals.wins++;
        if (jackpot) p.totals.motherlodes++;
      }
      p.totals.epochs++;
      p.lastResult = {
        epoch: e.id,
        square: w,
        deployed: dep,
        won: !!win,
        power: win ? win.power : 0,
        chips: win ? win.chips : 0,
        motherlode: !!(win && jackpot),
      };
    }

    const tagOf = (pid) => (this.players.get(pid) || {}).tag || '?';
    const nameOf = (pid) => (this.players.get(pid) || {}).name || '?';
    const summary = {
      epoch: e.id,
      endsAt: e.endsAt,
      settledAt: now,
      square: w,
      label: label(w),
      commit,
      seed,
      drand: { round: beacon.round, signature: beacon.signature, randomness: beacon.randomness },
      value,
      split: o.split,
      sample: onW > 0 && !o.split ? o.sample : null,
      topMiner: top ? tagOf(top) : null,
      motherlode: { hit: o.motherlode, paid: jackpot, pool: this.s.motherlode },
      totals: e.totals,
      totalPower: total,
      burned,
      players: Object.keys(e.deploys).length,
      winOrder: winOrder.map(([pid, , amt]) => [tagOf(pid), amt]),
      winners: winners
        .map((x) => ({ tag: tagOf(x.pid), name: nameOf(x.pid), deployed: x.deployed, power: x.power, chips: x.chips }))
        .sort((a, b) => b.chips - a.chips || b.deployed - a.deployed),
    };
    this.s.history.unshift(summary);
    if (this.s.history.length > HISTORY) this.s.history.length = HISTORY;
    if (jackpot) this.s.hits.unshift({ epoch: e.id, paid: jackpot, winners: winners.map((x) => ({ tag: tagOf(x.pid), weight: x.deployed })) });
    const st = this.s.stats;
    st.settled++;
    st.burned += burned;
    st.minted += this.cfg.emission + this.cfg.motherlodePerEpoch;
    st.deployed += total;
    delete this.s.epochs[e.id];
    return summary;
  }

  void(e, reason, now) {
    for (const [pid, dep] of Object.entries(e.deploys)) {
      const p = this.players.get(pid);
      if (!p) continue;
      const back = dep.reduce((a, b) => a + b, 0);
      p.power += back;
      p.lastResult = { epoch: e.id, void: true, reason, deployed: dep, power: back, chips: 0 };
    }
    this.s.history.unshift({ epoch: e.id, endsAt: e.endsAt, settledAt: now, void: true, reason, commit: this.chain.commit(e.id), drand: { round: e.round }, totals: e.totals, players: Object.keys(e.deploys).length });
    if (this.s.history.length > HISTORY) this.s.history.length = HISTORY;
    this.s.stats.voided++;
    delete this.s.epochs[e.id];
    return null;
  }

  /** What everyone sees for the live epoch. */
  view(now) {
    const cur = this.epochAt(now);
    const e = this.s.epochs[cur.id];
    const last = this.s.history[0] || null;
    const pending = Object.values(this.s.epochs).filter((x) => x.endsAt <= now && Object.keys(x.deploys).length).map((x) => ({ epoch: x.id, round: x.round }));
    return {
      serverTime: now,
      epoch: { ...cur, commit: this.chain.commit(cur.id), round: roundAfter(cur.endsAt) },
      totals: e ? e.totals : Array(SQUARES).fill(0),
      players: e ? Object.keys(e.deploys).length : 0,
      motherlode: this.s.motherlode,
      pending,
      last: last && { ...last, winOrder: undefined },
      recent: this.s.history.slice(0, 16).map((h) => ({ epoch: h.epoch, square: h.void ? null : h.square, void: !!h.void, motherlode: !!(h.motherlode && h.motherlode.paid) })),
    };
  }

  /** The caller's deploys in the live epoch. */
  mine(pid, now) {
    const e = this.s.epochs[this.epochAt(now).id];
    return (e && e.deploys[pid]) || Array(SQUARES).fill(0);
  }
}

module.exports = { Board, HISTORY, MAX_CALLS, RULES };
