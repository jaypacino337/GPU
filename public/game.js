/* CSTR — chip strategy. Vanilla JS incremental clicker.
 *
 * Runs fully in the browser: progress lives in localStorage. When the page is
 * served by the bundled Node server (Docker / `npm start`) an optional global
 * leaderboard is enabled; on static hosting (e.g. Vercel) it is switched off
 * and the game is single-player.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Config
  // ------------------------------------------------------------------
  // Ids are kept stable so existing saves keep working after renames.
  const BUILDINGS = [
    { id: 'core',    name: 'USB Miner',              cps: 1,     baseCost: 15 },
    { id: 'cache',   name: 'Mining Rig',             cps: 5,     baseCost: 100 },
    { id: 'threads', name: 'GPU Cluster',            cps: 25,    baseCost: 750 },
    { id: 'cooling', name: 'ASIC Miner',             cps: 100,   baseCost: 5000 },
    { id: 'vrm',     name: 'AI Inference Rack',      cps: 500,   baseCost: 30000 },
    { id: 'rack',    name: 'Chip Fab',               cps: 2500,  baseCost: 200000 },
    { id: 'quantum', name: 'Frontier Training Run',  cps: 12000, baseCost: 1500000 },
    { id: 'dc',      name: 'Superintelligence Lab',  cps: 60000, baseCost: 10000000 },
  ];
  const COST_GROWTH = 1.15;          // shop item cost multiplier per purchase
  const OC_BASE_COST = 50;           // overclock (click power) base cost
  const OC_GROWTH = 6;               // overclock cost multiplier per level
  const PRESTIGE_REQ = 1e7;          // lifetime chips needed per generation point
  const LOCAL_SAVE_INTERVAL = 5000;  // ms between localStorage saves
  const SERVER_SAVE_INTERVAL = 15000;// ms between server saves (leaderboard mode)
  const LB_INTERVAL = 20000;         // ms between leaderboard refreshes
  const OFFLINE_CAP_SEC = 8 * 3600;  // max idle earnings credited while away
  const SAVE_KEY = 'cstr.save';

  // ------------------------------------------------------------------
  // Storage helpers (localStorage can throw in private mode / blocked)
  // ------------------------------------------------------------------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const freshState = () => ({
    cycles: 0,
    totalCycles: 0,
    clickLevel: 0,
    architectures: 0,
    buildings: Object.fromEntries(BUILDINGS.map((b) => [b.id, 0])),
    savedAt: Date.now(),
  });
  const state = freshState();

  // Coerce any loaded save (local or server) into a valid state object so a
  // missing or corrupted field can never turn the counters into NaN.
  const num = (v, max = Number.MAX_VALUE) => {
    v = Number(v);
    return Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0;
  };
  function normalize(raw) {
    const s = freshState();
    if (!raw || typeof raw !== 'object') return s;
    s.cycles = num(raw.cycles);
    s.totalCycles = Math.max(num(raw.totalCycles), s.cycles);
    s.clickLevel = Math.floor(num(raw.clickLevel, 1000));
    s.architectures = Math.floor(num(raw.architectures));
    const b = raw.buildings && typeof raw.buildings === 'object' ? raw.buildings : {};
    for (const def of BUILDINGS) s.buildings[def.id] = Math.floor(num(b[def.id], 1e6));
    s.savedAt = num(raw.savedAt) || 0;
    return s;
  }
  function parseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  let mode = 'local';                         // 'local' | 'online'
  let playerId = store.get('cstr.playerId');
  let playerName = store.get('cstr.playerName');

  // ------------------------------------------------------------------
  // Derived values
  // ------------------------------------------------------------------
  const prestigeMult = () => 1 + state.architectures * 0.1;
  const clickPower = () => Math.pow(2, state.clickLevel) * prestigeMult();
  const cps = () =>
    BUILDINGS.reduce((sum, b) => sum + b.cps * state.buildings[b.id], 0) * prestigeMult();
  const buildingCost = (b) =>
    Math.ceil(b.baseCost * Math.pow(COST_GROWTH, state.buildings[b.id]));
  const overclockCost = () => Math.ceil(OC_BASE_COST * Math.pow(OC_GROWTH, state.clickLevel));
  const pendingArchPoints = () =>
    Math.max(0, Math.floor(state.totalCycles / PRESTIGE_REQ) - state.architectures);

  // ------------------------------------------------------------------
  // Formatting — suffixes up to decillions, scientific notation beyond.
  // ------------------------------------------------------------------
  const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  function fmt(n) {
    if (!Number.isFinite(n)) return n > 0 ? '∞' : '0';
    if (n < 1000) return String(Math.floor(n));
    const tier = Math.floor(Math.log10(n) / 3);
    if (tier >= SUFFIXES.length) return n.toExponential(2).replace('+', '');
    const scaled = n / Math.pow(10, tier * 3);
    const text = scaled.toFixed(scaled < 100 ? 1 : 0);
    // Guard against 999.95 rounding up to "1000K".
    if (Number(text) >= 1000) {
      return tier + 1 < SUFFIXES.length
        ? (scaled / 1000).toFixed(1) + SUFFIXES[tier + 1]
        : n.toExponential(2).replace('+', '');
    }
    return text + SUFFIXES[tier];
  }
  function fmtDuration(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m` : `${Math.floor(sec)}s`;
  }

  // ------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    cycles: $('cycles'), cps: $('cps'), chip: $('chip'), chipGhz: $('chip-ghz'),
    shop: $('shop'), ocBtn: $('overclock-btn'), ocLevel: $('oc-level'), ocCost: $('oc-cost'),
    prestigeBtn: $('prestige-btn'), prestigeInfo: $('prestige-info'), lbNote: $('lb-note'),
    leaderboard: $('leaderboard'), statTotal: $('stat-total'), statClick: $('stat-click'),
    statArch: $('stat-arch'), statMult: $('stat-mult'), saveStatus: $('save-status'),
    floatLayer: $('float-layer'), modal: $('name-modal'), nameInput: $('name-input'),
    nameSubmit: $('name-submit'), nameSkip: $('name-skip'), nameError: $('name-error'),
    toast: $('toast'), resetBtn: $('reset-btn'),
  };

  // Build the shop once; update numbers on render.
  const shopEls = {};
  for (const b of BUILDINGS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shop-item';
    btn.innerHTML =
      `<span class="item-name">${b.name}</span>` +
      `<span class="item-count"></span>` +
      `<span class="item-cost"></span>` +
      `<span class="item-effect">+${fmt(b.cps)} chips/sec</span>`;
    btn.addEventListener('click', () => {
      const cost = buildingCost(b);
      if (state.cycles < cost) return;
      state.cycles -= cost;
      state.buildings[b.id]++;
      render();
    });
    el.shop.appendChild(btn);
    shopEls[b.id] = {
      btn,
      cost: btn.querySelector('.item-cost'),
      count: btn.querySelector('.item-count'),
    };
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  function addCycles(n) {
    if (!(n > 0)) return;
    state.cycles += n;
    state.totalCycles += n;
  }

  el.chip.addEventListener('click', (ev) => {
    const gain = clickPower();
    addCycles(gain);
    // Keyboard activation reports (0,0) — float from the chip centre instead.
    let { clientX: x, clientY: y } = ev;
    if (!x && !y) {
      const r = el.chip.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    spawnFloat(x, y, '+' + fmt(gain));
    render();
  });

  el.ocBtn.addEventListener('click', () => {
    const cost = overclockCost();
    if (state.cycles < cost) return;
    state.cycles -= cost;
    state.clickLevel++;
    render();
  });

  el.prestigeBtn.addEventListener('click', () => {
    const gain = pendingArchPoints();
    if (gain <= 0) return;
    if (!confirm(`Retire this chip and tape out the next generation?\n\nYou gain +${fmt(gain)} generation point(s) (+${fmt(gain * 10)}% permanent boost) but lose all chips and hardware.`)) {
      return;
    }
    state.architectures += gain;
    state.cycles = 0;
    state.clickLevel = 0;
    for (const b of BUILDINGS) state.buildings[b.id] = 0;
    render();
    saveAll();
  });

  el.resetBtn.addEventListener('click', () => {
    if (!confirm('Wipe ALL progress in this browser, including chip generations? This cannot be undone.')) return;
    Object.assign(state, freshState());
    saveAll();
    render();
    showToast('Progress reset.');
  });

  let floats = 0;
  function spawnFloat(x, y, text) {
    if (floats > 40) return; // cap DOM churn on autoclickers
    floats++;
    const span = document.createElement('span');
    span.className = 'float-num';
    span.textContent = text;
    span.style.left = x - 10 + Math.random() * 20 + 'px';
    span.style.top = y - 30 + 'px';
    el.floatLayer.appendChild(span);
    setTimeout(() => { span.remove(); floats--; }, 900);
  }

  let toastTimer = null;
  function showToast(text) {
    el.toast.textContent = text;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 5000);
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function render() {
    el.cycles.textContent = fmt(state.cycles);
    el.cps.textContent = fmt(cps()) + ' chips/sec';
    el.chipGhz.textContent = (1 + state.clickLevel * 0.5).toFixed(1) + ' GHz';

    el.ocLevel.textContent = 'Lv.' + (state.clickLevel + 1);
    el.ocCost.textContent = fmt(overclockCost());
    el.ocBtn.disabled = state.cycles < overclockCost();

    for (const b of BUILDINGS) {
      const ui = shopEls[b.id];
      const cost = buildingCost(b);
      ui.cost.textContent = fmt(cost);
      ui.count.textContent = state.buildings[b.id] ? '×' + state.buildings[b.id] : '';
      ui.btn.disabled = state.cycles < cost;
    }

    const pending = pendingArchPoints();
    el.prestigeBtn.disabled = pending <= 0;
    el.prestigeBtn.textContent = pending > 0 ? `Next-Gen Chip (+${fmt(pending)})` : 'Next-Gen Chip';
    el.prestigeInfo.textContent =
      pending > 0
        ? `Reset now for +${fmt(pending * 10)}% permanent output.`
        : `Reach ${fmt((state.architectures + 1) * PRESTIGE_REQ)} lifetime chips to unlock.`;

    el.statTotal.textContent = fmt(state.totalCycles);
    el.statClick.textContent = fmt(clickPower());
    el.statArch.textContent = fmt(state.architectures);
    el.statMult.textContent = '×' + (prestigeMult() < 1000 ? prestigeMult().toFixed(1) : fmt(prestigeMult()));
  }

  // ------------------------------------------------------------------
  // Game loop — idle income at 10 ticks/sec. dt is wall-clock based, so a
  // throttled background tab catches up when it becomes visible again.
  // ------------------------------------------------------------------
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, OFFLINE_CAP_SEC);
    last = now;
    const rate = cps();
    if (rate > 0) {
      addCycles(rate * dt);
      render();
    }
  }, 100);

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  function saveLocal() {
    state.savedAt = Date.now();
    store.set(SAVE_KEY, JSON.stringify(state));
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function saveServer(retried) {
    if (mode !== 'online' || !playerId) return;
    try {
      await api(`/api/players/${playerId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: playerName, state }),
      });
      el.saveStatus.textContent = 'synced to leaderboard ' + new Date().toLocaleTimeString();
    } catch (err) {
      if (err.status === 404 && playerName && !retried) {
        // Server lost this player (e.g. datastore wiped): re-register quietly.
        try {
          await register(playerName);
          return saveServer(true);
        } catch { /* fall through */ }
      }
      el.saveStatus.textContent = 'leaderboard sync failed — progress is still saved in this browser';
    }
  }

  function saveAll() {
    saveLocal();
    saveServer();
  }

  async function load() {
    let best = normalize(parseJson(store.get(SAVE_KEY)));
    if (mode === 'online' && playerId) {
      try {
        const data = await api(`/api/players/${playerId}`);
        const remote = normalize(data.state);
        // Keep whichever copy has made more progress.
        if (remote.architectures > best.architectures ||
            (remote.architectures === best.architectures && remote.totalCycles > best.totalCycles)) {
          best = remote;
        }
        if (data.name) playerName = data.name;
      } catch { /* use local copy */ }
    }
    Object.assign(state, best);

    // Offline earnings: credit idle production for the time away (capped).
    if (state.savedAt) {
      const away = Math.min(Math.max(0, (Date.now() - state.savedAt) / 1000), OFFLINE_CAP_SEC);
      const earned = cps() * away;
      if (away > 60 && earned >= 1) {
        addCycles(earned);
        showToast(`Welcome back — your rig mined ${fmt(earned)} chips while you were away (${fmtDuration(away)}).`);
      }
    }
  }

  async function refreshLeaderboard() {
    if (mode !== 'online') return;
    try {
      const top = await api('/api/leaderboard');
      el.leaderboard.innerHTML = top.length
        ? top
            .map(
              (p, i) =>
                `<li><span class="lb-rank">${i + 1}.</span>` +
                `<span class="lb-name">${escapeHtml(p.name)}</span>` +
                `<span class="lb-score">${fmt(p.totalCycles)}</span></li>`
            )
            .join('')
        : '<li class="dim">no players yet — be first</li>';
    } catch {
      el.leaderboard.innerHTML = '<li class="dim">leaderboard offline</li>';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  // ------------------------------------------------------------------
  // Optional leaderboard sign-up (only when the server API is present)
  // ------------------------------------------------------------------
  async function register(name) {
    const data = await api('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    playerId = data.id;
    playerName = data.name;
    store.set('cstr.playerId', playerId);
    store.set('cstr.playerName', playerName);
  }

  async function submitName() {
    const name = el.nameInput.value.trim();
    if (!/^[\w \-.]{1,20}$/.test(name)) {
      el.nameError.textContent = 'Name must be 1–20 letters, numbers, spaces or -_.';
      el.nameError.classList.remove('hidden');
      return;
    }
    el.nameSubmit.disabled = true;
    try {
      await register(name);
      el.modal.classList.add('hidden');
      await saveServer();
      refreshLeaderboard();
    } catch {
      el.nameError.textContent = 'Server unreachable — playing offline.';
      el.nameError.classList.remove('hidden');
      setTimeout(() => el.modal.classList.add('hidden'), 1200);
    } finally {
      el.nameSubmit.disabled = false;
    }
  }
  el.nameSubmit.addEventListener('click', submitName);
  el.nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && submitName());
  el.nameSkip.addEventListener('click', () => {
    store.set('cstr.skipName', '1');
    el.modal.classList.add('hidden');
  });

  // Is the leaderboard API available? (Absent on static hosts like Vercel.)
  async function detectServer() {
    try {
      const res = await fetch('/api/leaderboard', { headers: { Accept: 'application/json' } });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return false;
      return Array.isArray(await res.json());
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  (async () => {
    render();
    mode = (await detectServer()) ? 'online' : 'local';
    await load();
    render();
    el.saveStatus.textContent = 'progress autosaves in this browser';

    if (mode === 'online') {
      el.lbNote.textContent = 'Scores are self-reported by each player’s browser and not verified.';
      if (!playerId && !store.get('cstr.skipName')) el.modal.classList.remove('hidden');
      refreshLeaderboard();
      setInterval(saveServer, SERVER_SAVE_INTERVAL);
      setInterval(refreshLeaderboard, LB_INTERVAL);
    } else {
      el.leaderboard.innerHTML =
        '<li class="dim">Not enabled on this deployment — single-player mode.</li>';
      el.lbNote.textContent = '';
    }

    setInterval(saveLocal, LOCAL_SAVE_INTERVAL);
    // pagehide/visibilitychange fire reliably on mobile; beforeunload does not.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveAll();
    });
    window.addEventListener('pagehide', saveLocal);
  })();
})();
