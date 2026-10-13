/* CSTR game rules: the single source of truth for prices, production and
 * what each action does. Loaded by the browser (window.CSTRRules) for the
 * optimistic local simulation AND required by the server (lib/engine.js),
 * which replays every action authoritatively. Pure functions only: no DOM,
 * no clock, no randomness, so client and server always agree.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSTRRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Ids are kept stable so existing saves keep working after renames.
  const BUILDINGS = [
    { id: 'core',    name: 'USB Miner',             cps: 1,     baseCost: 15 },
    { id: 'cache',   name: 'Mining Rig',            cps: 5,     baseCost: 100 },
    { id: 'threads', name: 'GPU Cluster',           cps: 25,    baseCost: 750 },
    { id: 'cooling', name: 'ASIC Miner',            cps: 100,   baseCost: 5000 },
    { id: 'vrm',     name: 'AI Inference Rack',     cps: 500,   baseCost: 30000 },
    { id: 'rack',    name: 'Chip Fab',              cps: 2500,  baseCost: 200000 },
    { id: 'quantum', name: 'Frontier Training Run', cps: 12000, baseCost: 1500000 },
    { id: 'dc',      name: 'Superintelligence Lab', cps: 60000, baseCost: 10000000 },
  ];
  const BY_ID = Object.fromEntries(BUILDINGS.map((b) => [b.id, b]));
  const COST_GROWTH = 1.15;      // building price multiplier per purchase
  const OC_BASE_COST = 50;       // overclock (click power) base cost
  const OC_GROWTH = 6;           // overclock cost multiplier per level
  const MAX_OC_LEVEL = 60;       // 2^60 per click is far past any sane run
  const PRESTIGE_REQ = 1e7;      // lifetime chips per generation point
  const OFFLINE_CAP_SEC = 8 * 3600;

  const fresh = () => ({
    cycles: 0,
    totalCycles: 0,
    clickLevel: 0,
    architectures: 0,
    buildings: Object.fromEntries(BUILDINGS.map((b) => [b.id, 0])),
  });

  const prestigeMult = (s) => 1 + s.architectures * 0.1;
  const clickPower = (s) => Math.pow(2, s.clickLevel) * prestigeMult(s);
  const cps = (s) => BUILDINGS.reduce((sum, b) => sum + b.cps * (s.buildings[b.id] || 0), 0) * prestigeMult(s);
  const buildingCost = (s, id) => Math.ceil(BY_ID[id].baseCost * Math.pow(COST_GROWTH, s.buildings[id] || 0));
  const overclockCost = (s) => Math.ceil(OC_BASE_COST * Math.pow(OC_GROWTH, s.clickLevel));
  const pendingGen = (s) => Math.max(0, Math.floor(s.totalCycles / PRESTIGE_REQ) - s.architectures);

  function earn(s, n) {
    if (!(n > 0)) return 0;
    s.cycles += n;
    s.totalCycles += n;
    return n;
  }

  /** Idle production for `sec` seconds. Returns chips earned. */
  function tick(s, sec) {
    if (!(sec > 0)) return 0;
    return earn(s, cps(s) * Math.min(sec, OFFLINE_CAP_SEC));
  }

  /**
   * Apply one action. Mutates `s`, returns { ok, earned, err }.
   *   { t: 'c', n }  n clicks        { t: 'b', id }  buy one building
   *   { t: 'o' }     overclock        { t: 'p' }      prestige (next-gen chip)
   * Click counts are trusted here; the server's engine caps them before calling.
   */
  function apply(s, a) {
    if (!a || typeof a !== 'object') return { ok: false, earned: 0, err: 'bad action' };
    switch (a.t) {
      case 'c': {
        const n = Math.floor(a.n);
        if (!(n > 0)) return { ok: false, earned: 0, err: 'bad click count' };
        return { ok: true, earned: earn(s, clickPower(s) * n) };
      }
      case 'b': {
        if (!BY_ID[a.id]) return { ok: false, earned: 0, err: 'unknown building' };
        const cost = buildingCost(s, a.id);
        if (s.cycles < cost) return { ok: false, earned: 0, err: 'cannot afford' };
        s.cycles -= cost;
        s.buildings[a.id] = (s.buildings[a.id] || 0) + 1;
        return { ok: true, earned: 0 };
      }
      case 'o': {
        if (s.clickLevel >= MAX_OC_LEVEL) return { ok: false, earned: 0, err: 'max level' };
        const cost = overclockCost(s);
        if (s.cycles < cost) return { ok: false, earned: 0, err: 'cannot afford' };
        s.cycles -= cost;
        s.clickLevel++;
        return { ok: true, earned: 0 };
      }
      case 'p': {
        const gain = pendingGen(s);
        if (gain <= 0) return { ok: false, earned: 0, err: 'not eligible' };
        s.architectures += gain;
        s.cycles = 0;
        s.clickLevel = 0;
        for (const b of BUILDINGS) s.buildings[b.id] = 0;
        return { ok: true, earned: 0 };
      }
      default:
        return { ok: false, earned: 0, err: 'unknown action' };
    }
  }

  return {
    BUILDINGS, COST_GROWTH, OC_BASE_COST, OC_GROWTH, MAX_OC_LEVEL, PRESTIGE_REQ, OFFLINE_CAP_SEC,
    fresh, prestigeMult, clickPower, cps, buildingCost, overclockCost, pendingGen, tick, apply,
  };
});
