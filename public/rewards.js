/* Payout audit page: renders /api/rewards as a table. */
(() => {
  'use strict';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const body = $('audit-body');
  const summary = $('audit-summary');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  let season = 'current';

  async function load() {
    try {
      const res = await fetch(`/api/rewards?season=${season}`);
      if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error('offline');
      const d = await res.json();
      const total = d.recipients.reduce((s, r) => s + r.weight, 0);
      summary.textContent = `Season ${d.season} · ${d.count} of top ${d.top} paid · weight: ${d.weight} · minimum ${fmt(d.minScore)} chips`;
      body.innerHTML = d.recipients.length
        ? d.recipients
            .map(
              (r) =>
                `<tr><td>${r.rank}</td><td>${esc(r.name)}</td><td class="mono">${esc(r.wallet)}</td>` +
                `<td class="num">${fmt(r.score)}</td><td class="num">${fmt(r.weight)}</td>` +
                `<td class="num">${total ? ((r.weight / total) * 100).toFixed(2) : '0.00'}%</td></tr>`
            )
            .join('')
        : '<tr><td colspan="6" class="muted">Nobody is eligible yet: link a wallet and mine.</td></tr>';
      if (!reduced) [...body.rows].forEach((tr, i) => tr.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 400, delay: i * 30, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'backwards' }));
    } catch {
      summary.textContent = 'The payout list needs the live game server. This copy is single-player.';
      body.innerHTML = '<tr><td colspan="6" class="muted">—</td></tr>';
    }
  }

  fetch('/api/config')
    .then((r) => r.json())
    .then((c) => {
      const v = { top: c.rewards.top, minScore: fmt(c.rewards.minScore) };
      document.querySelectorAll('[data-cfg]').forEach((n) => (n.textContent = v[n.dataset.cfg] ?? n.textContent));
    })
    .catch(() => {});

  document.querySelectorAll('[data-season]').forEach((b) =>
    b.addEventListener('click', () => {
      season = b.dataset.season;
      document.querySelectorAll('[data-season]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      load();
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

  load();
  setInterval(load, 30000);
})();
