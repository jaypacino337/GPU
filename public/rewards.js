/* Payout + fairness audit page.
 *  - season payout list from /api/rewards
 *  - motherlode hits from /api/motherlodes (each with its own export)
 *  - recent epochs from /api/epochs, each re-verifiable in the browser: the
 *    drand round is fetched from drand itself, never from this server.
 */
(() => {
  'use strict';
  const { CHIP, label, outcome } = window.CSTRRules;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const body = $('audit-body');
  const summary = $('audit-summary');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const chip = (micro) => (Number(micro) / CHIP).toLocaleString('en-US', { maximumFractionDigits: 3 });
  let season = 'current';
  let beacon = null;

  const animateRows = (tbody) => {
    if (!reduced) [...tbody.rows].forEach((tr, i) => tr.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 400, delay: i * 25, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'backwards' }));
  };

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error('offline');
    return res.json();
  }

  async function loadPayouts() {
    try {
      const d = await getJson(`/api/rewards?season=${season}`);
      const total = d.recipients.reduce((s, r) => s + r.weight, 0);
      summary.textContent = `Season ${d.season} · ${d.count} of top ${d.top} paid · weight: ${d.weight} · minimum ${chip(d.minScore)} CHIP`;
      body.innerHTML = d.recipients.length
        ? d.recipients
            .map(
              (r) =>
                `<tr><td>${r.rank}</td><td>${esc(r.name)}</td><td class="mono">${esc(r.wallet)}</td>` +
                `<td class="num">${chip(r.score)}</td><td class="num">${fmt(r.weight)}</td>` +
                `<td class="num">${total ? ((r.weight / total) * 100).toFixed(2) : '0.00'}%</td></tr>`
            )
            .join('')
        : '<tr><td colspan="6" class="muted">Nobody is eligible yet: link a wallet and mine.</td></tr>';
      animateRows(body);
    } catch {
      summary.textContent = 'The payout list needs the live game server. This copy is offline.';
      body.innerHTML = '<tr><td colspan="6" class="muted">—</td></tr>';
    }
  }

  async function loadMotherlodes() {
    const list = $('ml-list');
    try {
      const hits = await getJson('/api/motherlodes');
      list.innerHTML = hits.length
        ? hits
            .map(
              (h) =>
                `<li class="lb-row"><span class="lb-rank">★</span><span class="lb-name">${chip(h.paid)} CHIP · epoch <a href="#e${h.epoch}">#${h.epoch}</a></span>` +
                `<span class="lb-meta">${h.winners.length} miner${h.winners.length === 1 ? '' : 's'} on the rack</span>` +
                `<span class="lb-score"><button class="pill" type="button" data-ml="${h.epoch}">Payout list</button></span></li>`
            )
            .join('')
        : '<li class="lb-empty">No motherlode yet. It hits 1 in 500 epochs.</li>';
    } catch {
      list.innerHTML = '<li class="lb-empty">—</li>';
    }
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-ml]');
    if (b) location.href = `/api/rewards?pot=motherlode&epoch=${b.dataset.ml}&format=snapshot`;
  });

  // ------------------------------------------------------------- fairness
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
  const sha = async (...parts) => {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const all = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return hex(await crypto.subtle.digest('SHA-256', all));
  };

  const epochs = new Map();
  async function loadEpochs() {
    const tbody = $('epoch-body');
    try {
      const [cfg, d] = await Promise.all([getJson('/api/config'), getJson('/api/epochs?limit=40')]);
      beacon = cfg.fairness.beacon;
      $('f-anchor').textContent = d.chain.anchor;
      $('f-genesis').textContent = '#' + d.chain.genesisEpoch;
      $('f-beacon').textContent = `${beacon.name || 'drand quicknet'} · chain ${String(beacon.chainHash || '').slice(0, 16)}… · ${beacon.period || 3}s rounds`;
      d.epochs.forEach((e) => epochs.set(e.epoch, e));
      tbody.innerHTML = d.epochs.length
        ? d.epochs
            .map((e) =>
              e.void
                ? `<tr id="e${e.epoch}"><td>#${e.epoch}</td><td>VOID</td><td>${e.drand.round}</td><td class="num">${e.players}</td><td class="num">${fmt(e.totals.reduce((a, b) => a + b, 0))}</td><td class="muted">refunded: ${esc(e.reason)}</td></tr>`
                : `<tr id="e${e.epoch}"><td>#${e.epoch}</td><td><b>${label(e.square)}</b>${e.motherlode.paid ? ' <span class="tag tag-pay">ML</span>' : ''}</td><td>${e.drand.round}</td>` +
                  `<td class="num">${e.players}</td><td class="num">${fmt(e.totalPower)}</td>` +
                  `<td><button class="pill" type="button" data-verify="${e.epoch}">Verify</button></td></tr>`
            )
            .join('')
        : '<tr><td colspan="6" class="muted">No epochs settled yet.</td></tr>';
      animateRows(tbody);
      if (location.hash.startsWith('#e')) {
        const row = document.getElementById(location.hash.slice(1));
        if (row) {
          row.classList.add('target');
          row.scrollIntoView({ block: 'center' });
        }
      }
    } catch {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">The fairness log needs the live game server.</td></tr>';
    }
  }

  async function verify(id, cell) {
    const e = epochs.get(id);
    cell.textContent = 'checking…';
    try {
      // 1. The seed must hash to the commitment published before the epoch.
      const seedOk = (await sha(unhex(e.seed))) === e.commit;
      // 2. Fetch the round from drand directly, not from this server.
      const api = (beacon && beacon.api) || 'https://api.drand.sh/v2/beacons/quicknet/rounds/';
      const res = await fetch(api + e.drand.round);
      if (!res.ok) throw new Error('drand HTTP ' + res.status);
      const b = await res.json();
      const sigOk = b.signature === e.drand.signature;
      const randomness = await sha(unhex(b.signature));
      // 3. Recompute the value and the outcome with the same public rules.
      const value = await sha(new TextEncoder().encode(`CSTR-epoch:${id}`), unhex(e.seed), unhex(randomness));
      const o = outcome(value, e.totals[e.square]);
      const ok = seedOk && sigOk && value === e.value && o.square === e.square && o.split === e.split && o.motherlode === e.motherlode.hit;
      cell.innerHTML = ok
        ? `<span class="ok">✔ ${label(o.square)} verified</span>`
        : `<span class="bad">✖ mismatch${seedOk ? '' : ' (seed)'}${sigOk ? '' : ' (drand)'}</span>`;
    } catch (err) {
      cell.innerHTML = `<span class="bad">✖ ${esc(err.message)}</span>`;
    }
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-verify]');
    if (b) verify(Number(b.dataset.verify), b.parentElement);
  });

  getJson('/api/config')
    .then((c) => {
      const v = { top: c.rewards.top, minScore: chip(c.rewards.minScore) };
      document.querySelectorAll('[data-cfg]').forEach((n) => (n.textContent = v[n.dataset.cfg] ?? n.textContent));
    })
    .catch(() => {});

  document.querySelectorAll('[data-season]').forEach((b) =>
    b.addEventListener('click', () => {
      season = b.dataset.season;
      document.querySelectorAll('[data-season]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      loadPayouts();
    })
  );
  document.querySelectorAll('[data-dl]').forEach((b) =>
    b.addEventListener('click', () => {
      location.href = `/api/rewards?season=${season}&format=${b.dataset.dl}`;
    })
  );

  // Title split + reveals (same motion language as the game page).
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
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))))
    : null;
  document.querySelectorAll('.reveal').forEach((n) => (io ? io.observe(n) : n.classList.add('in')));
  document.addEventListener('pointermove', (e) => {
    const t = e.target.closest && e.target.closest('.spot');
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty('--mx', e.clientX - r.left + 'px');
    t.style.setProperty('--my', e.clientY - r.top + 'px');
  }, { passive: true });
  window.addEventListener('scroll', () => $('nav').classList.toggle('scrolled', window.scrollY > 10), { passive: true });

  loadPayouts();
  loadMotherlodes();
  loadEpochs();
  setInterval(loadPayouts, 30000);
})();
