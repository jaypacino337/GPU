/* CPU — the game. Vanilla JS incremental clicker. */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Config
  // ------------------------------------------------------------------
  const BUILDINGS = [
    { id: 'core',    name: 'Extra Core',           cps: 1,      baseCost: 15 },
    { id: 'cache',   name: 'L1 Cache',             cps: 5,      baseCost: 100 },
    { id: 'threads', name: 'Hyperthreading',       cps: 25,     baseCost: 750 },
    { id: 'cooling', name: 'Liquid Cooling',       cps: 100,    baseCost: 5000 },
    { id: 'vrm',     name: 'Overclock Module',     cps: 500,    baseCost: 30000 },
    { id: 'rack',    name: 'Server Rack',          cps: 2500,   baseCost: 200000 },
    { id: 'quantum', name: 'Quantum Co-Processor', cps: 12000,  baseCost: 1500000 },
    { id: 'dc',      name: 'Datacenter',           cps: 60000,  baseCost: 10000000 },
  ];
  const COST_GROWTH = 1.15;          // shop item cost multiplier per purchase
  const OC_BASE_COST = 50;           // overclock (click power) base cost
  const OC_GROWTH = 6;               // overclock cost multiplier per level
  const PRESTIGE_REQ = 1e7;          // lifetime cycles needed per architecture point
  const SAVE_INTERVAL = 15000;       // ms between server autosaves
  const LB_INTERVAL = 20000;         // ms between leaderboard refreshes

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    cycles: 0,
    totalCycles: 0,
    clickLevel: 0,
    architectures: 0,
    buildings: Object.fromEntries(BUILDINGS.map((b) => [b.id, 0])),
  };
  let playerId = localStorage.getItem('cpu.playerId');
  let playerName = localStorage.getItem('cpu.playerName');

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
  // Formatting
  // ------------------------------------------------------------------
  const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp'];
  function fmt(n) {
    if (n < 1000) return String(Math.floor(n));
    let tier = Math.min(SUFFIXES.length - 1, Math.floor(Math.log10(n) / 3));
    const scaled = n / Math.pow(10, tier * 3);
    return scaled.toFixed(scaled < 100 ? 1 : 0) + SUFFIXES[tier];
  }

  // ------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    cycles: $('cycles'), cps: $('cps'), chip: $('chip'), chipGhz: $('chip-ghz'),
    shop: $('shop'), ocBtn: $('overclock-btn'), ocLevel: $('oc-level'), ocCost: $('oc-cost'),
    prestigeBtn: $('prestige-btn'), prestigeInfo: $('prestige-info'),
    leaderboard: $('leaderboard'), statTotal: $('stat-total'), statClick: $('stat-click'),
    statArch: $('stat-arch'), statMult: $('stat-mult'), saveStatus: $('save-status'),
    floatLayer: $('float-layer'), modal: $('name-modal'), nameInput: $('name-input'),
    nameSubmit: $('name-submit'), nameError: $('name-error'),
  };

  // Build the shop once; update numbers each frame.
  const shopEls = {};
  for (const b of BUILDINGS) {
    const btn = document.createElement('button');
    btn.className = 'shop-item';
    btn.innerHTML =
      `<span class="item-name">${b.name}</span>` +
      `<span class="item-cost"></span>` +
      `<span class="item-count"></span>` +
      `<span class="item-effect">+${fmt(b.cps)} cycles/sec</span>`;
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
    state.cycles += n;
    state.totalCycles += n;
  }

  el.chip.addEventListener('click', (ev) => {
    const gain = clickPower();
    addCycles(gain);
    spawnFloat(ev.clientX, ev.clientY, '+' + fmt(gain));
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
    if (!confirm(`Retire this chip and design a new architecture?\n\nYou gain +${gain} architecture point(s) (+${gain * 10}% permanent boost) but lose all cycles and hardware.`)) {
      return;
    }
    state.architectures += gain;
    state.cycles = 0;
    state.clickLevel = 0;
    for (const b of BUILDINGS) state.buildings[b.id] = 0;
    render();
    save();
  });

  function spawnFloat(x, y, text) {
    const span = document.createElement('span');
    span.className = 'float-num';
    span.textContent = text;
    span.style.left = x - 10 + Math.random() * 20 + 'px';
    span.style.top = y - 30 + 'px';
    el.floatLayer.appendChild(span);
    setTimeout(() => span.remove(), 900);
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function render() {
    el.cycles.textContent = fmt(state.cycles);
    el.cps.textContent = fmt(cps()) + ' cycles/sec';
    el.chipGhz.textContent = (1 + state.clickLevel * 0.5).toFixed(1) + ' GHz';

    el.ocLevel.textContent = 'Lv.' + (state.clickLevel + 1);
    el.ocCost.textContent = fmt(overclockCost());
    el.ocBtn.disabled = state.cycles < overclockCost();

    for (const b of BUILDINGS) {
      const ui = shopEls[b.id];
      ui.cost.textContent = fmt(buildingCost(b));
      ui.count.textContent = state.buildings[b.id] || '';
      ui.btn.disabled = state.cycles < buildingCost(b);
    }

    const pending = pendingArchPoints();
    el.prestigeBtn.disabled = pending <= 0;
    el.prestigeBtn.textContent = pending > 0 ? `New Architecture (+${pending})` : 'New Architecture';
    el.prestigeInfo.textContent =
      pending > 0
        ? `Reset now for +${pending * 10}% permanent output.`
        : `Reach ${fmt((state.architectures + 1) * PRESTIGE_REQ)} lifetime cycles to unlock.`;

    el.statTotal.textContent = fmt(state.totalCycles);
    el.statClick.textContent = fmt(clickPower());
    el.statArch.textContent = state.architectures;
    el.statMult.textContent = '×' + prestigeMult().toFixed(1);
  }

  // ------------------------------------------------------------------
  // Game loop — idle income at 10 ticks/sec
  // ------------------------------------------------------------------
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    const rate = cps();
    if (rate > 0) {
      addCycles(rate * dt);
      render();
    }
  }, 100);

  // ------------------------------------------------------------------
  // Backend: register / save / load / leaderboard
  // ------------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function save() {
    if (!playerId) return;
    try {
      await api(`/api/players/${playerId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: playerName, state }),
      });
      el.saveStatus.textContent = 'saved ' + new Date().toLocaleTimeString();
    } catch {
      el.saveStatus.textContent = 'save failed — retrying later';
    }
    localStorage.setItem('cpu.save', JSON.stringify(state));
  }

  async function load() {
    // Prefer server state; fall back to the local copy.
    if (playerId) {
      try {
        const data = await api(`/api/players/${playerId}`);
        Object.assign(state, data.state);
        playerName = data.name;
        return;
      } catch { /* fall through */ }
    }
    try {
      const local = JSON.parse(localStorage.getItem('cpu.save'));
      if (local) Object.assign(state, local);
    } catch { /* fresh start */ }
  }

  async function refreshLeaderboard() {
    try {
      const top = await api('/api/leaderboard');
      el.leaderboard.innerHTML = top.length
        ? top
            .map(
              (p) =>
                `<li><span class="lb-name">${escapeHtml(p.name)}</span>` +
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
  // First-run name gate
  // ------------------------------------------------------------------
  async function registerName() {
    const name = el.nameInput.value.trim();
    if (!/^[\w \-\.]{1,20}$/.test(name)) {
      el.nameError.classList.remove('hidden');
      return;
    }
    try {
      const data = await api('/api/players', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      playerId = data.id;
      playerName = data.name;
      localStorage.setItem('cpu.playerId', playerId);
      localStorage.setItem('cpu.playerName', playerName);
      el.modal.classList.add('hidden');
      save();
    } catch {
      el.nameError.textContent = 'server unreachable — playing offline';
      el.nameError.classList.remove('hidden');
      setTimeout(() => el.modal.classList.add('hidden'), 1200);
    }
  }
  el.nameSubmit.addEventListener('click', registerName);
  el.nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && registerName());

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  (async () => {
    await load();
    if (!playerId) el.modal.classList.remove('hidden');
    render();
    refreshLeaderboard();
    setInterval(save, SAVE_INTERVAL);
    setInterval(refreshLeaderboard, LB_INTERVAL);
    window.addEventListener('beforeunload', () => {
      localStorage.setItem('cpu.save', JSON.stringify(state));
    });
  })();
})();
