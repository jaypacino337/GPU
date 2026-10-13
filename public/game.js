/* CSTR: compute epochs. Arcade front end for the ORE-style board.
 *
 * The server owns everything: power, deploys, settlement. This page polls
 * /api/board (live epoch, totals, last result) every second and
 * /api/players/:id every few seconds (power + presence heartbeat), sends
 * deploys, and plays the reveal when an epoch it watched settles.
 * Static hosting (no API) shows the board idle in single-page "offline" mode.
 */
(() => {
  'use strict';

  const { SQUARES, CHIP, label } = window.CSTRRules;
  const BOARD_MS = 1000;
  const ME_MS = 3000;
  const LB_MS = 15000;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ------------------------------------------------------------------ state
  let mode = 'local';
  let cfg = null;
  let playerId = store.get('cstr.playerId');
  let me = null;               // /api/players/:id
  let board = null;            // /api/board
  let serverOffset = 0;
  let selected = new Set();
  let watching = null;         // epoch id we deployed in / saw deploys in, awaiting its reveal
  let lastShown = null;        // last settled epoch we animated
  let deploying = false;
  let sfxOn = store.get('cstr.sfx') !== '0';

  // ------------------------------------------------------------- formatting
  function fmt(n) {
    n = Number(n) || 0;
    if (Math.abs(n) < 1000) return String(Math.floor(n));
    const s = ['', 'K', 'M', 'B', 'T'];
    const tier = Math.min(s.length - 1, Math.floor(Math.log10(Math.abs(n)) / 3));
    return (n / Math.pow(10, tier * 3)).toFixed(1).replace(/\.0$/, '') + s[tier];
  }
  const chip = (micro) => {
    const v = (Number(micro) || 0) / CHIP;
    return v >= 1000 ? fmt(v) : v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 3 : 2 });
  };
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d) return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const now = () => Date.now() + serverOffset;

  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58(bytes) {
    let n = 0n;
    for (const b of bytes) n = n * 256n + BigInt(b);
    let out = '';
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
    return out;
  }

  // -------------------------------------------------------------------- DOM
  const $ = (id) => document.getElementById(id);
  const el = {
    grid: $('grid'), overlay: $('grid-overlay'), overlayText: $('overlay-text'),
    epochId: $('epoch-id'), timer: $('epoch-timer'), timerFill: $('timer-fill'), total: $('epoch-total'), miners: $('epoch-miners'),
    amount: $('amount'), deployBtn: $('deploy-btn'), pickAll: $('pick-all'), pickNone: $('pick-none'), pickMax: $('pick-max'),
    power: $('power'), powerFill: $('power-fill'), powerNote: $('power-note'), motherlode: $('motherlode'),
    resultText: $('result-text'), result: $('result'), recent: $('recent'),
    seasonScore: $('season-score'), myRank: $('my-rank'), statEpochs: $('stat-epochs'), statWins: $('stat-wins'),
    seasonLabel: $('season-label'), countdown: $('season-countdown'), saveStatus: $('save-status'),
    leaderboard: $('leaderboard'), toast: $('toast'), ticker: $('ticker'), nav: $('nav'), progress: $('progress'),
    nameModal: $('name-modal'), nameInput: $('name-input'), nameSubmit: $('name-submit'), nameSkip: $('name-skip'), nameError: $('name-error'),
    walletModal: $('wallet-modal'), walletGo: $('wallet-go'), walletUnlink: $('wallet-unlink'), walletClose: $('wallet-close'),
    walletError: $('wallet-error'), walletCurrent: $('wallet-current'),
    walletBtn: $('wallet-btn'), linkCta: $('link-cta'), linkState: $('link-state'), sfxBtn: $('sfx-btn'),
    tokenStatus: $('token-status'), tokenCa: $('token-ca'), copyCa: $('copy-ca'), buyLink: $('buy-link'),
  };

  // ------------------------------------------------------------------ sound
  let audio = null;
  function blip(freq, dur = 0.06, type = 'square', vol = 0.035, slide = 0) {
    if (!sfxOn) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime;
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + dur + 0.01);
    } catch { /* no audio */ }
  }
  const arp = (notes, step = 0.05) => notes.forEach((f, i) => setTimeout(() => blip(f, 0.07, 'square', 0.03), i * step * 1000));
  function renderSfx() {
    el.sfxBtn.textContent = sfxOn ? 'SFX ON' : 'SFX OFF';
    el.sfxBtn.setAttribute('aria-pressed', String(sfxOn));
  }
  el.sfxBtn.addEventListener('click', () => {
    sfxOn = !sfxOn;
    store.set('cstr.sfx', sfxOn ? '1' : '0');
    renderSfx();
    blip(660, 0.08);
  });

  // ------------------------------------------------------------------- grid
  const tiles = [];
  for (let i = 0; i < SQUARES; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rack';
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<span class="rack-label">${label(i)}</span><span class="rack-die" aria-hidden="true"></span><span class="rack-total">0</span><span class="rack-mine"></span>`;
    b.addEventListener('click', () => {
      if (selected.has(i)) selected.delete(i);
      else selected.add(i);
      blip(selected.has(i) ? 520 : 300, 0.04);
      renderGrid();
      renderDeploy();
    });
    el.grid.appendChild(b);
    tiles.push({ b, total: b.querySelector('.rack-total'), mine: b.querySelector('.rack-mine') });
  }

  function renderGrid() {
    const totals = board ? board.totals : Array(SQUARES).fill(0);
    const max = Math.max(1, ...totals);
    const mine = (me && me.deployed) || [];
    tiles.forEach((t, i) => {
      t.total.textContent = totals[i] ? fmt(totals[i]) + ' ⚡' : '—';
      t.mine.textContent = mine[i] ? 'you ' + fmt(mine[i]) : '';
      t.b.style.setProperty('--heat', (totals[i] / max).toFixed(3));
      t.b.classList.toggle('selected', selected.has(i));
      t.b.classList.toggle('has-mine', !!mine[i]);
      t.b.setAttribute('aria-pressed', String(selected.has(i)));
      t.b.setAttribute('aria-label', `Rack ${label(i)}: ${totals[i] || 0} power deployed${mine[i] ? `, ${mine[i]} yours` : ''}`);
    });
  }

  const amount = () => Math.max(1, Math.min(cfg ? cfg.rules.maxDeploy : 1000, Math.floor(Number(el.amount.value) || 0)));
  function renderDeploy() {
    const n = selected.size;
    const cost = n * amount();
    const power = me ? me.power : 0;
    if (mode !== 'online') {
      el.deployBtn.textContent = 'Offline';
      el.deployBtn.disabled = true;
    } else if (!playerId) {
      el.deployBtn.textContent = 'Press start';
      el.deployBtn.disabled = false;
    } else if (!n) {
      el.deployBtn.textContent = 'Pick racks';
      el.deployBtn.disabled = true;
    } else if (cost > power) {
      el.deployBtn.textContent = `Need ${fmt(cost)} ⚡`;
      el.deployBtn.disabled = true;
    } else {
      el.deployBtn.textContent = `Deploy ${fmt(cost)} ⚡ → ${n} rack${n > 1 ? 's' : ''}`;
      el.deployBtn.disabled = deploying;
    }
  }

  document.querySelectorAll('.step').forEach((b) =>
    b.addEventListener('click', () => {
      el.amount.value = String(Math.max(1, amount() + Number(b.dataset.step)));
      renderDeploy();
    })
  );
  el.amount.addEventListener('input', renderDeploy);
  el.pickAll.addEventListener('click', () => {
    selected = new Set(Array.from({ length: SQUARES }, (_, i) => i));
    renderGrid();
    renderDeploy();
  });
  el.pickNone.addEventListener('click', () => {
    selected.clear();
    renderGrid();
    renderDeploy();
  });
  el.pickMax.addEventListener('click', () => {
    if (!me || !selected.size) return showToast('Pick racks first, then Max splits your power across them.');
    el.amount.value = String(Math.max(1, Math.min(cfg.rules.maxDeploy, Math.floor(me.power / selected.size))));
    renderDeploy();
  });

  el.deployBtn.addEventListener('click', async () => {
    if (!playerId) return el.nameModal.classList.remove('hidden');
    if (!selected.size || !board) return;
    deploying = true;
    renderDeploy();
    const squares = [...selected].sort((a, b) => a - b);
    try {
      const r = await api(`/api/players/${playerId}/deploy`, {
        method: 'POST',
        body: { epoch: board.epoch.id, squares, amount: amount(), reqId: Math.random().toString(36).slice(2) },
      });
      if (!r.duplicate) {
        me.power = r.power;
        me.deployed = r.deployed;
        squares.forEach((q) => (board.totals[q] += amount()));
        watching = board.epoch.id;
        arp([392, 523, 659], 0.04);
        if (!reduced) squares.forEach((q, k) => setTimeout(() => pulse(tiles[q].b, 'deployed'), k * 25));
        selected.clear();
      }
      renderAll();
    } catch (err) {
      showToast(err.status === 409 ? 'That epoch just closed. Deploy into the new one.' : err.message);
      blip(110, 0.12, 'sawtooth');
      refreshMe();
    } finally {
      deploying = false;
      renderDeploy();
    }
  });

  function pulse(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  // ------------------------------------------------------------- epoch HUD
  function tickHud() {
    if (!board) return;
    const left = Math.max(0, board.epoch.endsAt - now());
    const span = board.epoch.endsAt - board.epoch.startsAt;
    el.epochId.textContent = '#' + board.epoch.id;
    el.timer.textContent = left > 0 ? `${Math.floor(left / 1000)}.${Math.floor((left % 1000) / 100)}s` : 'closing';
    el.timer.classList.toggle('hot', left < 10000);
    el.timerFill.style.transform = `scaleX(${(left / span).toFixed(4)})`;
    if (left === 0) refreshBoard();
    tickSeason();
  }

  function renderBoardMeta() {
    if (!board) return;
    const total = board.totals.reduce((a, b) => a + b, 0);
    el.total.textContent = fmt(total) + ' ⚡';
    el.miners.textContent = String(board.players);
    countTo(el.motherlode, board.motherlode, (v) => chip(v) + ' CHIP');
    el.recent.innerHTML = board.recent
      .map((r) => `<li><a class="recent-chip${r.void ? ' void' : ''}${r.motherlode ? ' ml' : ''}" href="/rewards#e${r.epoch}" title="Epoch ${r.epoch}">${r.void ? 'VOID' : label(r.square)}</a></li>`)
      .join('') || '<li class="muted small">no epochs settled yet</li>';
    // Overlay while an epoch we watched waits for its drand round.
    const pend = board.pending.find((p) => p.epoch === watching);
    el.overlay.classList.toggle('hidden', !pend);
    if (pend) el.overlayText.textContent = `epoch #${pend.epoch} · drand round ${pend.round}`;
  }

  // Reveal: sweep the racks, land on the winner, then report the result.
  function reveal(last) {
    if (!last || last.epoch === lastShown) return;
    const mineEpoch = last.epoch === watching;
    lastShown = last.epoch;
    if (!mineEpoch) {
      if (last.void) return;
      flashWinner(last.square);
      return;
    }
    watching = null;
    if (last.void) {
      el.resultText.textContent = `Epoch #${last.epoch} was void (${last.reason}). Your power was refunded.`;
      return;
    }
    const finish = () => {
      flashWinner(last.square);
      refreshMe().then(() => describeResult(last));
    };
    if (reduced) return finish();
    let k = 0;
    const steps = 18 + last.square;
    const sweep = () => {
      tiles.forEach((t) => t.b.classList.remove('scan'));
      tiles[k % SQUARES].b.classList.add('scan');
      blip(220 + (k % SQUARES) * 22, 0.03, 'square', 0.02);
      if (++k <= steps) setTimeout(sweep, 30 + k * 3);
      else {
        tiles.forEach((t) => t.b.classList.remove('scan'));
        finish();
      }
    };
    sweep();
  }

  function flashWinner(sq) {
    tiles.forEach((t, i) => {
      t.b.classList.toggle('dim', i !== sq);
      t.b.classList.toggle('win', i === sq);
    });
    setTimeout(() => tiles.forEach((t) => t.b.classList.remove('dim', 'win')), 2600);
  }

  function describeResult(last) {
    const r = me && me.lastResult;
    if (!r || r.epoch !== last.epoch) return;
    el.result.classList.remove('won', 'lost');
    if (r.won) {
      el.result.classList.add('won');
      el.resultText.innerHTML = `Rack <b>${label(last.square)}</b> won. You got <b>+${fmt(r.power)} ⚡</b> and mined <b>+${chip(r.chips)} CHIP</b>.` +
        (r.motherlode ? ' <span class="tag tag-pay">MOTHERLODE</span>' : '') +
        (last.topMiner && last.topMiner === me.tag ? ' <span class="tag tag-pay">TOP MINER</span>' : '');
      arp(r.motherlode ? [523, 659, 784, 1046, 1318, 1568, 2093] : [523, 659, 784, 1046], 0.07);
      if (r.motherlode) showToast(`MOTHERLODE! You mined ${chip(r.chips)} CHIP this epoch.`);
    } else {
      el.result.classList.add('lost');
      el.resultText.innerHTML = `Rack <b>${label(last.square)}</b> won. Your racks missed this time.`;
      blip(160, 0.25, 'sawtooth', 0.03, -80);
    }
    pulse(el.result, 'pop');
  }

  // ----------------------------------------------------------------- render
  function renderMe() {
    if (!me) {
      el.power.textContent = mode === 'online' ? '—' : 'offline';
      el.powerFill.style.transform = 'scaleX(0)';
      return;
    }
    el.power.textContent = fmt(me.power) + ' ⚡';
    const cap = cfg.rules.regenCap;
    el.powerFill.style.transform = `scaleX(${Math.min(1, me.power / cap).toFixed(3)})`;
    el.powerNote.textContent = me.power >= cap
      ? `Above the ${cap} ⚡ regen cap: deploy to put it to work`
      : `+${cfg.rules.regenPerMin} ⚡/min while you're online, up to ${cap}`;
    el.seasonScore.textContent = chip(me.season.score) + ' CHIP';
    el.statEpochs.textContent = fmt(me.totals.epochs);
    el.statWins.textContent = fmt(me.totals.wins);
  }

  function renderAll() {
    renderGrid();
    renderDeploy();
    renderBoardMeta();
    renderMe();
  }

  // ------------------------------------------------------------ networking
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((json && json.error) || 'HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  function status(text, kind) {
    el.saveStatus.textContent = text;
    el.saveStatus.className = 'status-line' + (kind ? ' ' + kind : '');
  }

  let boardBusy = false;
  let boardAt = 0;
  async function refreshBoard() {
    if (mode !== 'online' || boardBusy || Date.now() - boardAt < 400) return;
    boardBusy = true;
    boardAt = Date.now();
    try {
      const b = await api('/api/board');
      serverOffset = b.serverTime - Date.now();
      const rolled = board && board.epoch.id !== b.epoch.id;
      if (rolled && board.players > 0 && watching === null) watching = board.epoch.id; // watch any epoch with miners
      board = b;
      if (rolled && me) me.deployed = Array(SQUARES).fill(0);
      renderBoardMeta();
      renderGrid();
      reveal(b.last);
      status(me ? (me.flagged ? 'flagged for review · not eligible for rewards' : 'live · server-settled, drand-verified') : 'watching · press start to mine', me && me.flagged ? 'warn' : 'ok');
    } catch {
      status('connection lost · retrying', 'warn');
    } finally {
      boardBusy = false;
    }
  }

  async function refreshMe() {
    if (mode !== 'online' || !playerId) return;
    try {
      const m = await api(`/api/players/${playerId}`);
      me = m;
      renderMe();
      renderGrid();
      renderDeploy();
      renderWallet();
    } catch (err) {
      if (err.status === 404) forgetPlayer();
    }
  }

  function forgetPlayer() {
    store.del('cstr.playerId');
    playerId = null;
    me = null;
    el.nameModal.classList.remove('hidden');
  }

  // ------------------------------------------------------------ leaderboard
  const rows = new Map();
  async function refreshLeaderboard() {
    if (mode !== 'online') return;
    let data;
    try {
      data = await api('/api/leaderboard');
    } catch {
      return;
    }
    if (!data.top.length) {
      rows.clear();
      el.leaderboard.innerHTML = '<li class="lb-empty">No CHIPs mined this season yet. Deploy and be first on the board.</li>';
      el.myRank.textContent = '—';
      return;
    }
    const before = new Map();
    rows.forEach((li, tag) => before.set(tag, li.getBoundingClientRect().top));
    const empty = el.leaderboard.querySelector('.lb-empty');
    if (empty) empty.remove();
    const seen = new Set();
    data.top.forEach((r) => {
      seen.add(r.tag);
      let li = rows.get(r.tag);
      if (!li) {
        li = document.createElement('li');
        li.className = 'lb-row';
        rows.set(r.tag, li);
      }
      const prevScore = li.dataset.score;
      li.classList.toggle('me', !!me && r.tag === me.tag);
      li.innerHTML =
        `<span class="lb-rank">${r.rank}</span>` +
        `<span class="lb-name">${escapeHtml(r.name)}</span>` +
        `<span class="lb-meta">${r.wins} wins${r.motherlodes ? ` · ${r.motherlodes} motherlode` : ''}${r.wallet ? ` · ${escapeHtml(r.wallet)}` : ' · no wallet'}` +
        `${r.rewarded ? ' <span class="tag tag-pay">PAID</span>' : ''}${r.flagged ? ' <span class="tag tag-flag">REVIEW</span>' : ''}</span>` +
        `<span class="lb-score">${chip(r.score)}</span>`;
      li.dataset.score = r.score;
      el.leaderboard.appendChild(li);
      if (!reduced && prevScore && prevScore !== String(r.score)) pulse(li, 'flash');
    });
    rows.forEach((li, tag) => {
      if (!seen.has(tag)) { li.remove(); rows.delete(tag); }
    });
    if (!reduced) {
      rows.forEach((li, tag) => {
        const old = before.get(tag);
        if (old === undefined) {
          li.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'cubic-bezier(0.22,1,0.36,1)' });
          return;
        }
        const dy = old - li.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 600, easing: 'cubic-bezier(0.22,1,0.36,1)' });
      });
    }
    const mine = me && data.top.find((r) => r.tag === me.tag);
    el.myRank.textContent = mine ? '#' + mine.rank : me ? '>' + data.top.length : '—';
  }

  async function refreshStats() {
    if (mode !== 'online') return;
    try {
      const s = await api('/api/stats');
      const vals = { players: s.players, linked: s.linked, settled: s.settled, burned: s.burned, seasonChips: s.seasonChips / CHIP, top: cfg.rewards.top };
      el.ticker.querySelectorAll('[data-stat]').forEach((b) => {
        const v = vals[b.dataset.stat];
        if (v !== undefined) countTo(b, v);
      });
    } catch { /* keep last */ }
  }

  function countTo(node, target, format = fmt) {
    const from = Number(node.dataset.v || 0);
    node.dataset.v = target;
    if (reduced || from === target) { node.textContent = format(target); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 900);
      node.textContent = format(from + (target - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- season
  function tickSeason() {
    const s = cfg && cfg.season;
    if (!s) return;
    const t = now();
    if (s.id === 0) {
      el.seasonLabel.textContent = 'Preseason';
      el.countdown.textContent = `season 1 starts in ${fmtDuration((s.endsAt - t) / 1000)}`;
    } else {
      el.seasonLabel.textContent = `Season ${s.id}`;
      el.countdown.textContent = `${fmtDuration((s.endsAt - t) / 1000)} left`;
    }
    if (t >= s.endsAt) api('/api/config').then((c) => (cfg.season = c.season)).catch(() => {});
  }

  // ---------------------------------------------------------------- wallet
  const shortW = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '');
  function renderWallet() {
    const wallet = me && me.wallet;
    el.walletBtn.textContent = wallet ? shortW(wallet) : 'Link wallet';
    el.walletBtn.classList.toggle('linked', !!wallet);
    el.linkCta.textContent = wallet ? 'Wallet linked ✓' : 'Link wallet';
    el.linkState.textContent = wallet
      ? `Paying to ${wallet}${me.flagged ? ' · account flagged for review, not eligible until cleared' : ''}`
      : mode === 'online' ? "No wallet linked. You can still mine, but you won't be paid." : 'Rewards need the live server.';
  }

  function openWallet() {
    if (mode !== 'online') return showToast('Wallet linking needs the live game server.');
    if (!playerId) {
      el.nameModal.classList.remove('hidden');
      return showToast('Pick a handle first, then link your wallet.');
    }
    const wallet = me && me.wallet;
    el.walletError.classList.add('hidden');
    el.walletCurrent.classList.toggle('hidden', !wallet);
    el.walletCurrent.textContent = wallet || '';
    el.walletUnlink.classList.toggle('hidden', !wallet);
    el.walletGo.textContent = wallet ? 'Switch wallet' : 'Connect Phantom';
    el.walletModal.classList.remove('hidden');
  }
  el.walletBtn.addEventListener('click', openWallet);
  el.linkCta.addEventListener('click', openWallet);
  el.walletClose.addEventListener('click', () => el.walletModal.classList.add('hidden'));

  function walletErr(text) {
    el.walletError.textContent = text;
    el.walletError.classList.remove('hidden');
  }

  el.walletGo.addEventListener('click', async () => {
    const provider = (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null);
    if (!provider) {
      if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        location.href = `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
      } else {
        walletErr('Phantom not found. Install it from phantom.app, then reload this page.');
        window.open('https://phantom.app/download', '_blank', 'noopener');
      }
      return;
    }
    el.walletGo.disabled = true;
    try {
      const { publicKey } = await provider.connect();
      const address = publicKey.toString();
      const ch = await api(`/api/players/${playerId}/wallet/challenge`, { method: 'POST' });
      const signed = await provider.signMessage(new TextEncoder().encode(ch.message), 'utf8');
      const sig = signed && signed.signature ? signed.signature : signed;
      await api(`/api/players/${playerId}/wallet`, { method: 'POST', body: { wallet: address, signature: base58(sig) } });
      if (me) me.wallet = address;
      renderWallet();
      el.walletModal.classList.add('hidden');
      arp([523, 659, 784, 1046, 1318], 0.06);
      showToast(`Wallet ${shortW(address)} linked. Finish the season in the top ${cfg.rewards.top} to get paid.`);
      refreshLeaderboard();
    } catch (err) {
      walletErr(err && err.code === 4001 ? 'Request cancelled in Phantom.' : (err && err.message) || 'Linking failed.');
    } finally {
      el.walletGo.disabled = false;
    }
  });

  el.walletUnlink.addEventListener('click', async () => {
    try {
      await api(`/api/players/${playerId}/wallet`, { method: 'DELETE' });
      if (me) me.wallet = null;
      renderWallet();
      el.walletModal.classList.add('hidden');
      showToast("Wallet unlinked. You won't be paid until you link one again.");
    } catch (err) {
      walletErr(err.message);
    }
  });

  // ---------------------------------------------------------------- name gate
  async function submitName() {
    const name = el.nameInput.value.trim();
    if (!/^[\w \-.]{1,20}$/.test(name)) {
      el.nameError.textContent = 'Use 1 to 20 letters, numbers, spaces, - _ or .';
      el.nameError.classList.remove('hidden');
      return;
    }
    el.nameSubmit.disabled = true;
    try {
      const data = await api('/api/players', { method: 'POST', body: { name } });
      playerId = data.id;
      store.set('cstr.playerId', playerId);
      store.del('cstr.skipName');
      el.nameModal.classList.add('hidden');
      await refreshMe();
      arp([262, 330, 392, 523]);
      showToast(`Welcome, ${data.name}. You have ${me ? me.power : 300} ⚡. Pick racks and deploy.`);
      refreshLeaderboard();
    } catch (err) {
      el.nameError.textContent = err.message || 'Server unreachable.';
      el.nameError.classList.remove('hidden');
    } finally {
      el.nameSubmit.disabled = false;
    }
  }
  el.nameSubmit.addEventListener('click', submitName);
  el.nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && submitName());
  el.nameSkip.addEventListener('click', () => {
    store.set('cstr.skipName', '1');
    el.nameModal.classList.add('hidden');
    renderDeploy();
  });

  // ------------------------------------------------------------------ toast
  let toastTimer = null;
  function showToast(text) {
    el.toast.textContent = text;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 6000);
  }

  // ----------------------------------------------------------- page motion
  document.querySelectorAll('[data-split]').forEach((node, w) => {
    const text = node.textContent;
    node.textContent = '';
    [...text].forEach((c, i) => {
      const s = document.createElement('span');
      s.className = 'ch';
      s.textContent = c;
      s.style.setProperty('--i', i + w * 4);
      node.appendChild(s);
    });
  });
  document.querySelectorAll('.reveal-group').forEach((g) => [...g.children].forEach((c, i) => c.style.setProperty('--d', i * 90 + 'ms')));
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.reveal').forEach((n) => io.observe(n));
    const tio = new IntersectionObserver(([e]) => el.ticker.parentElement.classList.toggle('paused', !e.isIntersecting));
    tio.observe(el.ticker.parentElement);
  } else {
    document.querySelectorAll('.reveal').forEach((n) => n.classList.add('in'));
  }
  [...el.ticker.children].forEach((c) => {
    const d = c.cloneNode(true);
    d.setAttribute('aria-hidden', 'true');
    el.ticker.appendChild(d);
  });
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('.spot, .rack');
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', e.clientX - r.left + 'px');
    t.style.setProperty('--my', e.clientY - r.top + 'px');
  }, { passive: true });
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      el.progress.style.transform = `scaleX(${max > 0 ? h.scrollTop / max : 0})`;
      el.nav.classList.toggle('scrolled', h.scrollTop > 10);
      ticking = false;
    });
  }, { passive: true });

  // ------------------------------------------------------------------ config
  function applyConfig() {
    const r = cfg.rewards;
    const vals = { top: r.top, minScore: chip(r.minScore) };
    document.querySelectorAll('[data-cfg]').forEach((n) => {
      if (vals[n.dataset.cfg] !== undefined) n.textContent = vals[n.dataset.cfg];
    });
    el.amount.max = String(cfg.rules.maxDeploy);
    if (cfg.token.mint) {
      el.tokenStatus.textContent = 'Live. This is the only official contract address.';
      el.tokenCa.textContent = cfg.token.mint;
      el.copyCa.disabled = false;
      el.copyCa.addEventListener('click', () => {
        navigator.clipboard.writeText(cfg.token.mint).then(() => showToast('Contract address copied.'), () => showToast(cfg.token.mint));
      });
    }
    if (cfg.token.buyUrl) {
      el.buyLink.href = cfg.token.buyUrl;
      el.buyLink.classList.remove('hidden');
    }
  }

  // -------------------------------------------------------------------- boot
  (async () => {
    renderSfx();
    renderAll();
    try {
      cfg = await api('/api/config');
      if (cfg && cfg.online) mode = 'online';
    } catch {
      mode = 'local';
    }

    if (mode === 'online') {
      applyConfig();
      await refreshBoard();
      if (board && board.last) lastShown = board.last.epoch; // don't replay an old reveal on load
      if (playerId) await refreshMe();
      else if (!store.get('cstr.skipName')) el.nameModal.classList.remove('hidden');
      if (me && me.deployed && me.deployed.some(Boolean)) watching = board.epoch.id;
      if (me && me.legacyTotal > 0 && !store.get('cstr.legacySeen3')) {
        store.set('cstr.legacySeen3', '1');
        showToast(`CSTR is now compute epochs. Your clicker total (${fmt(me.legacyTotal)}) is kept as a legacy badge.`);
      }
      renderAll();
      refreshLeaderboard();
      refreshStats();
      setInterval(refreshBoard, BOARD_MS);
      setInterval(refreshMe, ME_MS);
      setInterval(refreshLeaderboard, LB_MS);
      setInterval(refreshStats, 30000);
      setInterval(tickHud, 100);
    } else {
      el.leaderboard.innerHTML = '<li class="lb-empty">Offline build: the live board, leaderboard and rewards need the game server.</li>';
      el.seasonLabel.textContent = 'Offline';
      el.countdown.textContent = 'live board needs the server';
      el.overlay.classList.remove('hidden');
      el.overlayText.textContent = 'the live board needs the game server';
      status('offline build · nothing to mine here');
    }
    renderWallet();
    renderDeploy();
  })();
})();
