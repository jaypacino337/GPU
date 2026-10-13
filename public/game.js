/* CSTR: chip strategy. Arcade front end.
 *
 * Online (served by server.js): the server is the source of truth. Every
 * click / purchase is applied locally for instant feedback AND queued; batches
 * go to /api/players/:id/sync every few seconds, and the server's replayed
 * state replaces ours, with any not-yet-sent actions re-applied on top.
 *
 * Offline (static hosting, or "play offline"): same rules, saved in
 * localStorage, no leaderboard and no rewards.
 */
(() => {
  'use strict';

  const R = window.CSTRRules;
  const SAVE_KEY = 'cstr.save';
  const SYNC_MS = 3000;
  const IDLE_SYNC_MS = 15000;
  const LB_MS = 15000;
  const BURST_SEC = 15;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ------------------------------------------------------------------ state
  let state = R.fresh();
  let mode = 'local';            // 'online' when the API answers
  let cfg = null;                // /api/config
  let playerId = store.get('cstr.playerId');
  let playerName = store.get('cstr.playerName');
  let playerTag = null;
  let wallet = null;
  let flagged = false;
  let session = null;
  let seq = 0;
  let queue = [];
  let inflight = null;
  let syncing = false;
  let lastSyncAt = 0;
  let season = null;             // { id, startsAt, endsAt, score }
  let seasonDelta = 0;           // chips earned locally since the last server view
  let serverOffset = 0;          // server clock - local clock
  let maxCps = 20;
  let bucket = 0;
  let bucketAt = performance.now();
  let sfxOn = store.get('cstr.sfx') !== '0';

  const online = () => mode === 'online' && !!playerId && !!session;

  // ------------------------------------------------------------- formatting
  const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  function fmt(n) {
    if (!Number.isFinite(n)) return n > 0 ? '∞' : '0';
    if (n < 1000) return String(Math.floor(n));
    const tier = Math.floor(Math.log10(n) / 3);
    if (tier >= SUFFIXES.length) return n.toExponential(2).replace('+', '');
    const scaled = n / Math.pow(10, tier * 3);
    const text = scaled.toFixed(scaled < 100 ? 1 : 0);
    if (Number(text) >= 1000) {
      return tier + 1 < SUFFIXES.length ? (scaled / 1000).toFixed(1) + SUFFIXES[tier + 1] : n.toExponential(2).replace('+', '');
    }
    return text + SUFFIXES[tier];
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d) return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
    cycles: $('cycles'), cps: $('cps'), chip: $('chip'), chipGhz: $('chip-ghz'), combo: $('combo'), fx: $('fx-layer'),
    shop: $('shop'), ocBtn: $('overclock-btn'), ocLevel: $('oc-level'), ocCost: $('oc-cost'),
    prestigeBtn: $('prestige-btn'), prestigeName: $('prestige-name'), prestigeInfo: $('prestige-info'),
    statTotal: $('stat-total'), statClick: $('stat-click'), statArch: $('stat-arch'), statMult: $('stat-mult'),
    seasonScore: $('season-score'), myRank: $('my-rank'), seasonLabel: $('season-label'), countdown: $('season-countdown'),
    saveStatus: $('save-status'), leaderboard: $('leaderboard'), floatLayer: $('float-layer'), toast: $('toast'),
    nameModal: $('name-modal'), nameInput: $('name-input'), nameSubmit: $('name-submit'), nameSkip: $('name-skip'), nameError: $('name-error'),
    walletModal: $('wallet-modal'), walletGo: $('wallet-go'), walletUnlink: $('wallet-unlink'), walletClose: $('wallet-close'),
    walletError: $('wallet-error'), walletCurrent: $('wallet-current'), walletCopy: $('wallet-copy'),
    walletBtn: $('wallet-btn'), linkCta: $('link-cta'), linkState: $('link-state'), sfxBtn: $('sfx-btn'),
    tabModal: $('tab-modal'), tabResume: $('tab-resume'), nav: $('nav'), progress: $('progress'),
    tokenStatus: $('token-status'), tokenCa: $('token-ca'), copyCa: $('copy-ca'), buyLink: $('buy-link'), ticker: $('ticker'),
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

  // ------------------------------------------------------------------- shop
  const shopEls = {};
  R.BUILDINGS.forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shop-item';
    btn.innerHTML =
      `<span class="item-name">${b.name}</span><span class="item-count"></span>` +
      `<span class="item-effect">+${fmt(b.cps)} chips/sec</span><span class="item-cost"></span>`;
    btn.addEventListener('click', () => {
      if (!act({ t: 'b', id: b.id }).ok) return;
      btn.classList.remove('bought');
      void btn.offsetWidth;
      btn.classList.add('bought');
      arp([523, 659, 784]);
      render();
    });
    el.shop.appendChild(btn);
    shopEls[b.id] = { btn, cost: btn.querySelector('.item-cost'), count: btn.querySelector('.item-count') };
  });

  // ---------------------------------------------------------------- actions
  function enqueue(a) {
    const last = queue[queue.length - 1];
    if (a.t === 'c' && last && last.t === 'c' && last.n + a.n <= 1000) last.n += a.n;
    else queue.push({ ...a });
  }

  /** Apply locally (instant feedback) and queue for the server when online. */
  function act(a) {
    const r = R.apply(state, a);
    if (!r.ok) return r;
    seasonDelta += r.earned;
    if (online()) enqueue(a);
    return r;
  }

  function refillBucket() {
    const now = performance.now();
    bucket = Math.min(maxCps * BURST_SEC, bucket + ((now - bucketAt) / 1000) * maxCps);
    bucketAt = now;
  }

  let combo = 0;
  let lastClick = 0;
  let comboTimer = null;
  el.chip.addEventListener('click', (ev) => {
    let { clientX: x, clientY: y } = ev;
    if (!x && !y) {
      const r = el.chip.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    if (online()) {
      refillBucket();
      if (bucket < 1) {
        showCombo('MAX RATE', true);
        blip(110, 0.08, 'sawtooth', 0.03);
        return;
      }
      bucket -= 1;
    }
    const { earned } = act({ t: 'c', n: 1 });
    const now = performance.now();
    combo = now - lastClick < 450 ? combo + 1 : 1;
    lastClick = now;
    if (combo >= 5) showCombo(`×${combo} COMBO`);
    blip(330 + Math.min(combo, 30) * 18, 0.05);
    hitFx(x, y, earned);
    render();
  });

  function showCombo(text, bad) {
    el.combo.textContent = text;
    el.combo.classList.toggle('throttled', !!bad);
    el.combo.classList.add('on');
    clearTimeout(comboTimer);
    comboTimer = setTimeout(() => el.combo.classList.remove('on'), 700);
  }

  let fxCount = 0;
  function hitFx(x, y, earned) {
    el.chip.classList.remove('hit');
    void el.chip.offsetWidth;
    el.chip.classList.add('hit');
    el.cycles.classList.remove('bump');
    void el.cycles.offsetWidth;
    el.cycles.classList.add('bump');
    if (fxCount > 70) return; // autoclickers: cap DOM churn
    const f = document.createElement('span');
    f.className = 'float-num' + (combo % 2 ? '' : ' alt');
    f.textContent = '+' + fmt(earned);
    f.style.left = x - 12 + Math.random() * 24 + 'px';
    f.style.top = y - 34 + 'px';
    el.floatLayer.appendChild(f);
    fxCount++;
    setTimeout(() => { f.remove(); fxCount--; }, 900);
    if (reduced) return;
    const ring = document.createElement('span');
    ring.className = 'ring';
    el.fx.appendChild(ring);
    fxCount++;
    setTimeout(() => { ring.remove(); fxCount--; }, 520);
    const box = el.fx.getBoundingClientRect();
    for (let i = 0; i < 6; i++) {
      const p = document.createElement('span');
      const ang = (Math.PI * 2 * i) / 6 + Math.random() * 0.6;
      const dist = 50 + Math.random() * 60;
      p.className = 'px';
      p.style.left = x - box.left + 'px';
      p.style.top = y - box.top + 'px';
      p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
      p.style.setProperty('--c', i % 2 ? 'var(--color-accent)' : 'var(--color-brand)');
      el.fx.appendChild(p);
      fxCount++;
      setTimeout(() => { p.remove(); fxCount--; }, 620);
    }
  }

  el.ocBtn.addEventListener('click', () => {
    if (!act({ t: 'o' }).ok) return;
    arp([392, 523, 659, 1046], 0.04);
    render();
  });

  el.prestigeBtn.addEventListener('click', () => {
    const gain = R.pendingGen(state);
    if (gain <= 0) return;
    if (!confirm(`Tape out the next-gen chip?\n\n+${fmt(gain)} generation (+${fmt(gain * 10)}% permanent output), but chips, overclock and hardware reset.`)) return;
    if (!act({ t: 'p' }).ok) return;
    blip(180, 0.5, 'sawtooth', 0.04, 1400);
    if (!reduced) {
      document.body.classList.remove('shake');
      void document.body.offsetWidth;
      document.body.classList.add('shake');
    }
    render();
    flush();
  });

  // ----------------------------------------------------------------- render
  function render() {
    el.cycles.textContent = fmt(state.cycles);
    el.cps.textContent = fmt(R.cps(state));
    el.chipGhz.textContent = (1 + state.clickLevel * 0.5).toFixed(1) + ' GHz';

    el.ocLevel.textContent = 'Lv.' + (state.clickLevel + 1);
    el.ocCost.textContent = fmt(R.overclockCost(state));
    el.ocBtn.disabled = state.cycles < R.overclockCost(state) || state.clickLevel >= R.MAX_OC_LEVEL;

    R.BUILDINGS.forEach((b, i) => {
      const ui = shopEls[b.id];
      const cost = R.buildingCost(state, b.id);
      const n = state.buildings[b.id];
      ui.cost.textContent = fmt(cost);
      ui.count.textContent = n ? '×' + n : '';
      ui.btn.disabled = state.cycles < cost;
      ui.btn.classList.toggle('locked', i > 0 && !n && !state.buildings[R.BUILDINGS[i - 1].id] && state.totalCycles < cost);
    });

    const pending = R.pendingGen(state);
    el.prestigeBtn.disabled = pending <= 0;
    el.prestigeName.textContent = pending > 0 ? `Next-Gen +${fmt(pending)}` : 'Next-Gen Chip';
    el.prestigeInfo.textContent = pending > 0 ? `reset for +${fmt(pending * 10)}% forever` : `at ${fmt((state.architectures + 1) * R.PRESTIGE_REQ)} lifetime`;

    el.statTotal.textContent = fmt(state.totalCycles);
    el.statClick.textContent = fmt(R.clickPower(state));
    el.statArch.textContent = fmt(state.architectures);
    const m = R.prestigeMult(state);
    el.statMult.textContent = '×' + (m < 1000 ? m.toFixed(1) : fmt(m));
    el.seasonScore.textContent = online() && season ? fmt(season.score + seasonDelta) : '—';
  }

  // Idle income, wall-clock based so a throttled background tab catches up.
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    seasonDelta += R.tick(state, dt);
    render();
  }, 100);

  // ------------------------------------------------------------ networking
  async function api(path, { method = 'GET', body, keepalive } = {}) {
    const res = await fetch(path, {
      method,
      keepalive,
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

  /** Adopt the server's replayed state, then re-apply anything not yet sent. */
  function adopt(view) {
    state = view.state;
    for (const a of queue) R.apply(state, a);
    season = view.season;
    seasonDelta = 0;
    serverOffset = view.serverTime - Date.now();
    playerTag = view.tag;
    playerName = view.name;
    wallet = view.wallet;
    flagged = view.flagged;
    last = performance.now();
    renderWallet();
    render();
  }

  async function startSession() {
    const res = await api(`/api/players/${playerId}/session`, { method: 'POST' });
    session = res.session;
    seq = 0;
    queue = [];
    inflight = null;
    bucket = 0;
    bucketAt = performance.now();
    adopt(res);
    lastSyncAt = Date.now();
    status('verified by server · live', 'ok');
    if (res.offline >= 1 && res.offlineSec > 60) {
      showToast(`Welcome back. Your rig mined ${fmt(res.offline)} chips while you were away (${fmtDuration(res.offlineSec)}).`);
    }
    if (res.legacyTotal > 0 && !store.get('cstr.legacySeen')) {
      store.set('cstr.legacySeen', '1');
      showToast(`Seasons are live and scores are now server-verified. Your legacy total of ${fmt(res.legacyTotal)} is kept as a badge.`);
    }
  }

  async function flush(keepalive = false) {
    if (!online() || syncing) return;
    if (!inflight) {
      if (!queue.length && Date.now() - lastSyncAt < IDLE_SYNC_MS) return;
      inflight = { seq: ++seq, actions: queue.splice(0, 400) };
    }
    syncing = true;
    try {
      const res = await api(`/api/players/${playerId}/sync`, {
        method: 'POST',
        keepalive,
        body: { session, seq: inflight.seq, actions: inflight.actions },
      });
      inflight = null;
      lastSyncAt = Date.now();
      adopt(res);
      if (Date.now() - lastBoardAt > 5000) refreshLeaderboard();
      status(flagged ? 'flagged for review · not eligible for rewards' : 'verified by server · synced ' + new Date().toLocaleTimeString(), flagged ? 'warn' : 'ok');
    } catch (err) {
      if (err.status === 409) {
        session = null;
        el.tabModal.classList.remove('hidden');
      } else if (err.status === 404) {
        forgetPlayer();
      } else if (err.status === 400) {
        inflight = null; // malformed (shouldn't happen): drop it and resync from the server's truth
        startSession().catch(() => {});
      } else {
        status('connection lost · retrying', 'warn');
      }
    } finally {
      syncing = false;
    }
  }

  function forgetPlayer() {
    store.del('cstr.playerId');
    playerId = null;
    session = null;
    el.nameModal.classList.remove('hidden');
  }

  el.tabResume.addEventListener('click', async () => {
    el.tabModal.classList.add('hidden');
    try { await startSession(); } catch { status('connection lost · retrying', 'warn'); }
  });

  // ------------------------------------------------------------ local saves
  function saveLocal() {
    if (online()) return;
    store.set(SAVE_KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
  }
  function loadLocal() {
    let raw = null;
    try { raw = JSON.parse(store.get(SAVE_KEY)); } catch { raw = null; }
    if (!raw || typeof raw !== 'object') return;
    const s = R.fresh();
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    s.cycles = num(raw.cycles);
    s.totalCycles = Math.max(num(raw.totalCycles), s.cycles);
    s.clickLevel = Math.min(R.MAX_OC_LEVEL, Math.floor(num(raw.clickLevel)));
    s.architectures = Math.floor(num(raw.architectures));
    for (const b of R.BUILDINGS) s.buildings[b.id] = Math.floor(num(raw.buildings && raw.buildings[b.id]));
    state = s;
    const away = Math.min(Math.max(0, (Date.now() - num(raw.savedAt)) / 1000), R.OFFLINE_CAP_SEC);
    const earned = raw.savedAt ? R.tick(state, away) : 0;
    if (away > 60 && earned >= 1) showToast(`Welcome back. Your rig mined ${fmt(earned)} chips while you were away (${fmtDuration(away)}).`);
  }

  // ------------------------------------------------------------ leaderboard
  const rows = new Map();
  let lastBoardAt = 0;
  async function refreshLeaderboard() {
    if (mode !== 'online') return;
    lastBoardAt = Date.now();
    let data;
    try {
      data = await api('/api/leaderboard');
    } catch {
      return;
    }
    if (!data.top.length) {
      rows.clear();
      el.leaderboard.innerHTML = '<li class="lb-empty">No scores yet this season. Be the first on the board.</li>';
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
      const isNew = !li;
      if (isNew) {
        li = document.createElement('li');
        li.className = 'lb-row';
        rows.set(r.tag, li);
      }
      const prevScore = li.dataset.score;
      li.classList.toggle('me', r.tag === playerTag);
      li.innerHTML =
        `<span class="lb-rank">${r.rank}</span>` +
        `<span class="lb-name">${escapeHtml(r.name)}</span>` +
        `<span class="lb-meta">${r.gen ? `gen ${r.gen}` : 'gen 0'}${r.wallet ? ` · ${escapeHtml(r.wallet)}` : ' · no wallet'}` +
        `${r.rewarded ? ' <span class="tag tag-pay">PAID</span>' : ''}${r.flagged ? ' <span class="tag tag-flag">REVIEW</span>' : ''}</span>` +
        `<span class="lb-score">${fmt(r.score)}</span>`;
      li.dataset.score = r.score;
      el.leaderboard.appendChild(li); // re-appending in order = reorder
      if (!reduced && prevScore && prevScore !== String(r.score)) {
        li.classList.remove('flash');
        void li.offsetWidth;
        li.classList.add('flash');
      }
    });
    rows.forEach((li, tag) => {
      if (!seen.has(tag)) { li.remove(); rows.delete(tag); }
    });
    // FLIP: slide rows from their old position to the new one.
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
    const me = data.top.find((r) => r.tag === playerTag);
    el.myRank.textContent = me ? '#' + me.rank : online() ? '>' + data.top.length : '—';
  }

  async function refreshStats() {
    if (mode !== 'online') return;
    try {
      const s = await api('/api/stats');
      const vals = { players: s.players, linked: s.linked, active: s.active, seasonChips: s.seasonChips, top: cfg.rewards.top, maxCps: cfg.maxCps };
      el.ticker.querySelectorAll('[data-stat]').forEach((b) => {
        const v = vals[b.dataset.stat];
        if (v !== undefined) countTo(b, v);
      });
    } catch { /* keep last */ }
  }

  function countTo(node, target) {
    const from = Number(node.dataset.v || 0);
    node.dataset.v = target;
    if (reduced || from === target) { node.textContent = fmt(target); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 900);
      node.textContent = fmt(from + (target - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- season
  function tickCountdown() {
    if (!season) return;
    const now = Date.now() + serverOffset;
    if (season.id === 0) {
      el.seasonLabel.textContent = 'Preseason';
      el.countdown.textContent = `season 1 starts in ${fmtDuration((season.endsAt - now) / 1000)}`;
    } else {
      el.seasonLabel.textContent = `Season ${season.id}`;
      el.countdown.textContent = `${fmtDuration((season.endsAt - now) / 1000)} left`;
    }
    if (now >= season.endsAt && online()) flush(); // roll into the new season
  }
  setInterval(tickCountdown, 1000);

  // ---------------------------------------------------------------- wallet
  const shortW = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : '');
  function renderWallet() {
    el.walletBtn.textContent = wallet ? shortW(wallet) : 'Link wallet';
    el.walletBtn.classList.toggle('linked', !!wallet);
    el.linkCta.textContent = wallet ? 'Wallet linked ✓' : 'Link wallet';
    el.linkState.textContent = wallet
      ? `Paying to ${wallet}${flagged ? ' · account flagged for review, not eligible until cleared' : ''}`
      : mode === 'online' ? 'No wallet linked. You can still play, but you won\'t be paid.' : 'Rewards need the live server.';
  }

  function openWallet() {
    if (mode !== 'online') return showToast('Wallet linking needs the live game server. This copy is single-player.');
    if (!playerId) {
      el.nameModal.classList.remove('hidden');
      return showToast('Pick a handle first, then link your wallet.');
    }
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
      wallet = address;
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
      wallet = null;
      renderWallet();
      el.walletModal.classList.add('hidden');
      showToast('Wallet unlinked. You won\'t be paid until you link one again.');
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
      playerName = data.name;
      store.set('cstr.playerId', playerId);
      store.set('cstr.playerName', playerName);
      store.del('cstr.skipName');
      el.nameModal.classList.add('hidden');
      await startSession();
      arp([262, 330, 392, 523]);
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
    status('offline mode · saved in this browser · not on the leaderboard');
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
  // Split the hero title into letters for a staggered rise.
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

  // Reveal on scroll (children of .reveal-group stagger).
  document.querySelectorAll('.reveal-group').forEach((g) => [...g.children].forEach((c, i) => c.style.setProperty('--d', i * 90 + 'ms')));
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.reveal').forEach((n) => io.observe(n));
    // Pause the ticker when it's off-screen.
    const tio = new IntersectionObserver(([e]) => el.ticker.parentElement.classList.toggle('paused', !e.isIntersecting));
    tio.observe(el.ticker.parentElement);
  } else {
    document.querySelectorAll('.reveal').forEach((n) => n.classList.add('in'));
  }

  // Seamless marquee: duplicate the ticker content once.
  [...el.ticker.children].forEach((c) => {
    const d = c.cloneNode(true);
    d.setAttribute('aria-hidden', 'true');
    el.ticker.appendChild(d);
  });

  // Cursor spotlight on cards and shop rows.
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('.spot, .shop-item');
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', e.clientX - r.left + 'px');
    t.style.setProperty('--my', e.clientY - r.top + 'px');
  }, { passive: true });

  // Nav blur + scroll progress.
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
    const vals = { top: r.top, maxCps: cfg.maxCps, minScore: fmt(r.minScore), weight: r.weight === 'sqrt' ? 'the square root' : r.weight === 'linear' ? 'all' : r.weight === 'rank' ? 'the rank' : 'none' };
    document.querySelectorAll('[data-cfg]').forEach((n) => {
      if (vals[n.dataset.cfg] !== undefined) n.textContent = vals[n.dataset.cfg];
    });
    maxCps = cfg.maxCps;
    season = { ...cfg.season, score: 0 };
    serverOffset = 0;
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
    render();
    try {
      cfg = await api('/api/config');
      if (cfg && cfg.online) mode = 'online';
    } catch {
      mode = 'local';
    }

    if (mode === 'online') {
      applyConfig();
      tickCountdown();
      if (playerId) {
        try {
          await startSession();
        } catch (err) {
          if (err.status === 404) forgetPlayer();
          else status('server unreachable · retrying', 'warn');
        }
      } else {
        loadLocal();
        if (!store.get('cstr.skipName')) el.nameModal.classList.remove('hidden');
        else status('offline mode · saved in this browser · not on the leaderboard');
      }
      refreshLeaderboard();
      refreshStats();
      setInterval(refreshLeaderboard, LB_MS);
      setInterval(refreshStats, 30000);
      setInterval(() => {
        if (playerId && !session && el.tabModal.classList.contains('hidden')) startSession().catch(() => {});
        else flush();
      }, SYNC_MS);
    } else {
      loadLocal();
      el.leaderboard.innerHTML = '<li class="lb-empty">Single-player build: the leaderboard and rewards need the live game server.</li>';
      el.seasonLabel.textContent = 'Single-player';
      el.countdown.textContent = 'offline';
      status('single-player · saved in this browser');
    }
    renderWallet();
    render();

    setInterval(saveLocal, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { saveLocal(); flush(true); }
    });
    window.addEventListener('pagehide', () => { saveLocal(); flush(true); });
  })();
})();
