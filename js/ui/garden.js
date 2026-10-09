// js/ui/garden.js — the garden: the record of a forest, not a scoreboard.
// Totals, a calendar of working days, the species ledger with silhouettes, and every
// finished tree — the wilted ones shown plainly rather than swept away. Reads
// ctx.store.state.forest and ctx.store.derived(); writes only inside ctx.dom.garden.

export const meta = { id: 'garden', order: 50, kind: 'ui' };

const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HEAT_WEEKS = 20;
const MAX_ROWS = 80;

const TALLIES = [
  { key: 'trees', label: 'trees' },
  { key: 'minutes', label: 'minutes' },
  { key: 'species', label: 'species' },
  { key: 'days', label: 'days kept' },
  { key: 'running', label: 'days running' }
];

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

function svgNode(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

// A small parametric silhouette per habit — enough to tell a pine from a willow at a glance.
function silhouette(habit, className) {
  const s = svgNode('svg', { viewBox: '0 0 40 56', 'aria-hidden': 'true', focusable: 'false' });
  s.classList.add('garden-sil');
  if (className) s.classList.add(className);
  const trunk = (x, w, top, bottom) => s.appendChild(svgNode('rect', { x, y: top, width: w, height: bottom - top, rx: Math.min(1.4, w / 2) }));
  const poly = (points) => s.appendChild(svgNode('polygon', { points }));
  const ellipse = (cx, cy, rx, ry) => s.appendChild(svgNode('ellipse', { cx, cy, rx, ry }));
  const path = (d) => s.appendChild(svgNode('path', { d }));

  switch (habit) {
    case 'conifer':
      trunk(18.6, 2.8, 20, 50);
      poly('20,4 31.5,24 8.5,24');
      poly('20,15 33.5,34 6.5,34');
      poly('20,26 35.5,46 4.5,46');
      break;
    case 'broad':
      trunk(18.6, 3, 22, 50);
      ellipse(20, 19, 15, 12.5);
      ellipse(11.5, 27, 8.5, 7.5);
      ellipse(28.5, 27, 8.5, 7.5);
      break;
    case 'weeping':
      trunk(18.6, 2.8, 14, 50);
      path('M20 5 C5 8 3 27 5 47 C9 31 12 24 20 19 C28 24 31 31 35 47 C37 27 35 8 20 5 Z');
      break;
    case 'columnar':
      trunk(18.6, 2.8, 26, 50);
      ellipse(20, 19, 7.5, 18);
      break;
    case 'clumping':
      trunk(14.8, 2.4, 26, 50);
      trunk(22.6, 2.4, 30, 50);
      trunk(18.9, 2, 22, 50);
      ellipse(14.8, 22, 7.5, 7.5);
      ellipse(25.5, 25, 7, 7);
      ellipse(20.3, 14, 8.5, 8);
      break;
    default: // slender
      trunk(18.6, 2.5, 18, 50);
      ellipse(20, 15, 9, 13.5);
      ellipse(13.6, 22, 5.8, 6.8);
      ellipse(26.4, 22, 5.8, 6.8);
  }
  return s;
}

function keyOf(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function dayAndMonth(d) {
  return d.getDate() + ' ' + MONTHS[d.getMonth()];
}

function dateLabel(ms) {
  const d = new Date(typeof ms === 'number' && isFinite(ms) ? ms : Date.now());
  const y = new Date().getFullYear();
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== y ? ' ' + d.getFullYear() : '');
}

function minutesLabel(m) {
  const r = Math.round(typeof m === 'number' && isFinite(m) ? m : 0);
  return r <= 0 ? '—' : r + ' min';
}

function levelFor(minutes) {
  if (!(minutes > 0)) return 0;
  if (minutes >= 120) return 4;
  if (minutes >= 80) return 3;
  if (minutes >= 40) return 2;
  return 1;
}

function outcomeLabel(outcome) {
  if (outcome === 'wilted') return 'wilted';
  if (outcome === 'wild') return 'grown, away';
  if (outcome === 'distracted') return 'grown, mostly away';
  return 'grown';
}

// index.html belongs to the manager, so each UI hand guarantees its own stylesheet is present
// rather than assuming a <link> was wired. Idempotent: a static link makes this a no-op.
function ensureStyles() {
  try {
    if (!document.head) return;
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    for (let i = 0; i < links.length; i += 1) {
      if (((links[i].getAttribute('href') || '')).indexOf('garden.css') !== -1) return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/garden.css';
    document.head.append(link);
  } catch (err) { /* styling is progressive; the record still reads unstyled */ }
}

export function create(ctx) {
  const panel = ctx && ctx.dom ? ctx.dom.garden : null;
  const live = { days: 0, rows: 0, trees: 0, grown: 0, wilted: 0, species: 0 };
  if (!panel) return { stats() { return live; } };

  const byId = {};
  for (const sp of (ctx.species || [])) byId[sp.id] = sp;

  ensureStyles();

  /* ---------------- skeleton ---------------- */

  panel.textContent = '';
  const root = el('div', 'garden-grid');
  panel.appendChild(root);

  root.appendChild(el('h2', 'garden-title', 'The record'));

  const tallyBox = el('div', 'garden-tallies');
  const tallyNodes = [];
  for (const t of TALLIES) {
    const wrap = el('div', 'garden-tally');
    wrap.setAttribute('data-role', 'total');
    wrap.setAttribute('data-total', t.key);
    const value = el('span', 'garden-tally-value num', '0');
    wrap.appendChild(value);
    wrap.appendChild(el('span', 'garden-tally-label', t.label));
    tallyBox.appendChild(wrap);
    tallyNodes.push({ key: t.key, value });
  }
  root.appendChild(tallyBox);

  const daysBlock = el('section', 'garden-block garden-block--days');
  daysBlock.appendChild(el('h3', null, 'Days'));
  const heatCaption = el('p', 'garden-caption');
  daysBlock.appendChild(heatCaption);
  const heat = el('div', 'garden-heat');
  daysBlock.appendChild(heat);
  const legend = el('div', 'garden-legend');
  legend.appendChild(el('span', 'garden-legend-cap', 'fewer'));
  for (let lv = 0; lv < 5; lv += 1) {
    const sw = el('span', 'garden-swatch');
    sw.setAttribute('data-level', String(lv));
    legend.appendChild(sw);
  }
  legend.appendChild(el('span', 'garden-legend-cap', 'more'));
  daysBlock.appendChild(legend);
  root.appendChild(daysBlock);

  const ledgerBlock = el('section', 'garden-block garden-block--ledger');
  ledgerBlock.appendChild(el('h3', null, 'Species'));
  const ledger = el('div', 'garden-ledger');
  ledgerBlock.appendChild(ledger);
  root.appendChild(ledgerBlock);

  const treesBlock = el('section', 'garden-block garden-block--trees');
  treesBlock.appendChild(el('h3', null, 'Trees'));
  const treesSummary = el('p', 'garden-caption');
  treesBlock.appendChild(treesSummary);
  const trees = el('div', 'garden-trees');
  treesBlock.appendChild(trees);
  const emptyNote = el('p', 'garden-empty', 'Nothing planted yet. Finished trees wait here, the wilted ones included.');
  treesBlock.appendChild(emptyNote);
  const more = el('p', 'garden-more');
  more.hidden = true;
  treesBlock.appendChild(more);
  root.appendChild(treesBlock);

  /* ---------------- render ---------------- */

  function renderHeat() {
    heat.textContent = '';
    live.days = 0;
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const todayKey = keyOf(today);
    const start = new Date(today);
    start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (HEAT_WEEKS - 1) * 7);
    const days = ctx.store.state.days || {};

    for (let i = 0; i < HEAT_WEEKS * 7; i += 1) {
      const dt = new Date(start);
      dt.setDate(start.getDate() + i);
      if (dt.getTime() > today.getTime()) break;
      const key = keyOf(dt);
      const rec = days[key] || null;
      const minutes = rec ? rec.focusMinutes : 0;
      const cell = el('div', 'garden-day');
      cell.setAttribute('data-role', 'day');
      cell.setAttribute('data-date', key);
      cell.setAttribute('data-level', String(levelFor(minutes)));
      if (key === todayKey) cell.classList.add('garden-day--today');
      cell.setAttribute('aria-label', key + ': ' + Math.round(minutes) + ' min');
      heat.appendChild(cell);
      live.days += 1;
    }
    heatCaption.textContent = 'last ' + HEAT_WEEKS + ' weeks · ' + dayAndMonth(start) + ' to today · one square, one day';
  }

  function renderLedger(counts) {
    ledger.textContent = '';
    for (const sp of (ctx.species || [])) {
      const n = counts[sp.id] || 0;
      const card = el('div', n > 0 ? 'garden-species garden-species--present' : 'garden-species');
      card.setAttribute('data-species', sp.id);
      card.appendChild(silhouette(sp.habit, 'garden-sil--card'));
      const meta = el('div', 'garden-species-meta');
      meta.appendChild(el('span', 'garden-species-name', sp.name));
      meta.appendChild(el('span', 'garden-species-latin', sp.latin));
      meta.appendChild(el('span', 'garden-species-note', sp.note));
      card.appendChild(meta);
      card.appendChild(el('span', 'garden-species-count num', n > 0 ? String(n) : '0'));
      card.setAttribute('aria-label', sp.name + ': ' + n + ' grown');
      ledger.appendChild(card);
    }
  }

  function renderTrees(finished) {
    trees.textContent = '';
    const grown = finished.filter(function (t) { return t.outcome !== 'wilted'; }).length;
    const wilted = finished.length - grown;
    live.trees = finished.length;
    live.grown = grown;
    live.wilted = wilted;

    if (!finished.length) {
      treesSummary.textContent = '';
      emptyNote.hidden = false;
      more.hidden = true;
      live.rows = 0;
      return;
    }
    emptyNote.hidden = true;
    treesSummary.textContent = grown + ' grown · ' + wilted + ' wilted';

    const rows = finished.slice(-MAX_ROWS).reverse();
    for (const t of rows) {
      const sp = byId[t.species] || { name: t.species, habit: 'slender' };
      const row = el('div', 'garden-tree');
      row.setAttribute('data-role', 'tree');
      row.setAttribute('data-species', t.species);
      row.setAttribute('data-outcome', t.outcome || 'harvested');
      row.appendChild(silhouette(sp.habit, 'garden-sil--row'));
      const main = el('div', 'garden-tree-main');
      main.appendChild(el('span', 'garden-tree-name', sp.name));
      main.appendChild(el('span', 'garden-tree-when dim', dateLabel(t.grewAt || t.plantedAt)));
      row.appendChild(main);
      row.appendChild(el('span', 'garden-tree-min num dim', minutesLabel(t.minutes)));
      row.appendChild(el('span', 'garden-tree-outcome', outcomeLabel(t.outcome)));
      trees.appendChild(row);
    }
    live.rows = rows.length;
    const hidden = finished.length - rows.length;
    more.hidden = hidden <= 0;
    more.textContent = hidden > 0 ? hidden + ' earlier trees, held quietly in the store.' : '';
  }

  function render() {
    const d = ctx.store.derived();
    const forest = ctx.store.state.forest || [];
    const finished = forest.filter(function (t) { return t && t.outcome !== 'growing'; });
    const values = {
      trees: d.allTrees,
      minutes: Math.round(d.allMinutes),
      species: Object.keys(d.speciesCounts).length,
      days: Object.keys(d.days || {}).length,
      running: d.streak
    };
    for (const t of tallyNodes) t.value.textContent = String(values[t.key] == null ? 0 : values[t.key]);
    renderHeat();
    renderLedger(d.speciesCounts);
    renderTrees(finished);
    live.species = Object.keys(d.speciesCounts).length;
  }

  function rerender() {
    try { render(); } catch (err) { ctx.log('garden render failed: ' + (err && err.message)); }
  }

  render();

  const onForest = function () { rerender(); };
  ctx.bus.on('forest:changed', onForest);
  ctx.bus.on('session:harvest', onForest);
  ctx.bus.on('session:wilt', onForest);
  ctx.bus.on('session:plant', onForest);
  ctx.bus.on('view:changed', function (p) { if (!p || p.view === 'garden') rerender(); });

  return {
    update() {},
    stats() {
      const d = ctx.store.derived();
      return {
        days: live.days,
        rows: live.rows,
        trees: live.trees,
        grown: live.grown,
        wilted: live.wilted,
        species: live.species,
        ledger: (ctx.species || []).length,
        minutes: d.allMinutes,
        allTrees: d.allTrees
      };
    },
    dispose() {
      ctx.bus.off('forest:changed', onForest);
      ctx.bus.off('session:harvest', onForest);
      ctx.bus.off('session:wilt', onForest);
      ctx.bus.off('session:plant', onForest);
    }
  };
}
