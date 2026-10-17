'use strict';

const SERIES = [
  { key: 'osrs', name: 'Old School', color: 'var(--series-1)' },
  { key: 'rs3', name: 'RuneScape 3', color: 'var(--series-2)' },
];
// Same entities, same colors: Steam is a subset of each game's players.
const STEAM_SERIES = [
  { key: 'steamOsrs', name: 'Old School', color: 'var(--series-1)' },
  { key: 'steamRs3', name: 'RuneScape 3', color: 'var(--series-2)' },
];
const CHARTS = [
  { id: 'chart', tooltipId: 'tooltip', label: 'Players online over time, Old School and RuneScape 3', series: SERIES, showTotal: true },
  { id: 'steam-chart', tooltipId: 'steam-tooltip', label: 'Players on Steam over time, Old School and RuneScape 3', series: STEAM_SERIES, showTotal: false },
];
const RANGE_KEY ='rs-tracker:range';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN = 60_000;
const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((n) => n * MIN);

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

let range = 86_400_000;
let data = null;
let worlds = null;
let sort = { key: 'players', dir: -1 };

try {
  const saved = localStorage.getItem(RANGE_KEY);
  if (saved !== null) range = Number(saved);
} catch {}

// ---------- helpers ----------

function el(tag, attrs = {}, text) {
  const node = tag.startsWith('svg:') ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function timeLabel(t, withDate) {
  const d = new Date(t);
  return withDate
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function niceStep(span, target) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

// ---------- data loading ----------

async function loadHistory() {
  const charts = CHARTS.map((c) => $(c.id));
  if (data) charts.forEach((c) => (c.style.opacity = '0.6'));
  try {
    const res = await fetch(`/api/history?range=${range}`);
    data = await res.json();
    renderFigures();
    renderCharts();
    renderHistoryTable();
    renderStatus();
  } catch (err) {
    $('status').textContent = `Can't reach the tracker server (${err.message})`;
    $('status').className = 'status error';
  } finally {
    charts.forEach((c) => (c.style.opacity = ''));
  }
}

async function loadWorlds() {
  try {
    worlds = await (await fetch('/api/worlds')).json();
    renderBreakdowns();
    renderWorlds();
  } catch {}
}

// ---------- status & figures ----------

function renderStatus() {
  const s = $('status');
  s.replaceChildren();
  s.className = data.lastError ? 'status error' : 'status';
  s.append(el('span', { class: 'dot', 'aria-hidden': 'true' }));
  if (data.lastError) {
    s.append(`Last poll failed: ${data.lastError.message}`);
  } else if (data.latest) {
    s.append(`Updated ${ago(data.latest.t)} · polling every ${data.pollMs / 1000}s`);
  } else {
    s.append('Waiting for the first sample…');
  }
}

function renderFigures() {
  const l = data.latest;
  if (!l) return;
  $('total-value').textContent = fmt.format(l.total);
  const tp = data.stats.total.peak;
  $('total-sub').textContent = tp ? `Peak in range ${fmt.format(tp.value)} at ${timeLabel(tp.t, range > 86_400_000 || range === 0)}` : '';

  for (const s of SERIES) {
    const v = l[s.key];
    $(`${s.key}-value`).textContent = v == null ? '–' : fmt.format(v);
    const share = v == null ? '' : `${((v / l.total) * 100).toFixed(1)}% of players`;
    const st = data.stats[s.key];
    const spread = st.peak ? ` · range ${compact.format(st.low.value)}–${compact.format(st.peak.value)}` : '';
    $(`${s.key}-sub`).textContent = share + spread;
  }

  for (const [game, key] of [['osrs', 'steamOsrs'], ['rs3', 'steamRs3']]) {
    const v = l[key];
    const pct = v != null && l[game] ? ` (${((v / l[game]) * 100).toFixed(1)}%)` : '';
    $(`${game}-steam`).textContent = v == null ? 'On Steam: –' : `On Steam: ${fmt.format(v)}${pct}`;
  }
}

// ---------- line chart ----------

function renderCharts() {
  const pts = data.points;
  $('chart-sub').textContent = pts.length
    ? `${fmt.format(data.sampleCount)} samples${pts.length < data.sampleCount ? ', averaged for display' : ''}`
    : '';
  for (const cfg of CHARTS) renderChart(cfg);
}

function renderChart({ id, tooltipId, label, series, showTotal }) {
  const chart = $(id);
  const tooltip = $(tooltipId);
  chart.querySelector('svg')?.remove();
  tooltip.hidden = true;

  const W = chart.clientWidth;
  const H = chart.clientHeight;
  const m = { top: 12, right: 64, bottom: 26, left: 44 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = el('svg:svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  chart.prepend(svg);

  // All charts share the same time axis; a series may be null where it wasn't recorded.
  const pts = data.points;
  const filled = pts.filter((p) => series.some((s) => p[s.key] != null)).length;
  if (filled < 2) {
    svg.append(el('svg:text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty' },
      filled ? 'Collecting data — the chart fills in as samples arrive.' : 'No samples in this range yet.'));
    return;
  }

  const t0 = pts[0].t;
  const t1 = pts.at(-1).t;
  const yMaxRaw = Math.max(...pts.flatMap((p) => series.map((s) => p[s.key] ?? 0)));
  const yStep = niceStep(yMaxRaw, 4);
  const yMax = Math.ceil((yMaxRaw * 1.05) / yStep) * yStep;
  const x = (t) => m.left + ((t - t0) / (t1 - t0 || 1)) * iw;
  const y = (v) => m.top + ih - (v / yMax) * ih;
  const withDate = t1 - t0 > 20 * 3600_000;

  // Gridlines + y ticks
  for (let v = 0; v <= yMax; v += yStep) {
    svg.append(el('svg:line', { x1: m.left, x2: m.left + iw, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
    svg.append(el('svg:text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end' }, compact.format(v)));
  }

  // X ticks at round local-time intervals
  const maxTicks = Math.max(2, Math.floor(iw / 110));
  const step = TIME_STEPS.find((s) => (t1 - t0) / s <= maxTicks) ?? TIME_STEPS.at(-1);
  const offset = new Date(t0).getTimezoneOffset() * 60_000;
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) {
    const px = x(t);
    const anchor = px - m.left < 30 ? 'start' : m.left + iw - px < 30 ? 'end' : 'middle';
    const label = step >= 1440 * MIN
      ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : timeLabel(t, withDate);
    svg.append(el('svg:text', { x: px, y: H - 6, 'text-anchor': anchor }, label));
  }

  // Lines; break where samples are missing for a while (tracker was offline).
  const gap = Math.max(data.pollMs * 3, ((t1 - t0) / pts.length) * 3);
  for (const s of series) {
    let d = '';
    let prev = null;
    for (const p of pts) {
      if (p[s.key] == null) { prev = null; continue; }
      d += `${prev && p.t - prev.t <= gap ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[s.key]).toFixed(1)}`;
      prev = p;
    }
    svg.append(el('svg:path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    const last = [...pts].reverse().find((p) => p[s.key] != null);
    if (last) {
      svg.append(el('svg:circle', { cx: x(last.t), cy: y(last[s.key]), r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      svg.append(el('svg:text', { x: x(last.t) + 10, y: y(last[s.key]) + 4, class: 'end-label' }, compact.format(last[s.key])));
    }
  }

  // Crosshair + tooltip
  const cross = el('svg:line', { y1: m.top, y2: m.top + ih, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  const dots = series.map((s) => el('svg:circle', { r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }));
  svg.append(cross, ...dots);
  const hit = el('svg:rect', { x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent', tabindex: 0 });
  svg.append(hit);

  let focusIdx = pts.length - 1;
  const show = (i) => {
    focusIdx = i;
    const p = pts[i];
    const px = x(p.t);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    series.forEach((s, k) => {
      const v = p[s.key];
      dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { dots[k].setAttribute('cx', px); dots[k].setAttribute('cy', y(v)); }
    });

    tooltip.replaceChildren(el('div', { class: 'when' }, timeLabel(p.t, true)));
    for (const s of series) {
      const row = el('div', { class: 'row' });
      row.append(el('span', { class: 'line-key', style: `--c: ${s.color}` }), el('span', {}, s.name), el('strong', {}, p[s.key] == null ? '–' : fmt.format(p[s.key])));
      tooltip.append(row);
    }
    if (showTotal) {
      const totalRow = el('div', { class: 'row' });
      totalRow.append(el('span', {}, 'Total'), el('strong', {}, fmt.format(p.total)));
      tooltip.append(totalRow);
    }
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth;
    tooltip.style.left = `${px + 12 + tw > W ? px - tw - 12 : px + 12}px`;
    tooltip.style.top = `${m.top}px`;
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    tooltip.hidden = true;
  };
  const nearest = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const t = t0 + ((clientX - rect.left - m.left) / iw) * (t1 - t0);
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo > 0 && t - pts[lo - 1].t < pts[lo].t - t ? lo - 1 : lo;
  };
  hit.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(focusIdx));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(Math.max(0, focusIdx - 1));
    else if (e.key === 'ArrowRight') show(Math.min(pts.length - 1, focusIdx + 1));
    else return;
    e.preventDefault();
  });
}

function renderHistoryTable() {
  const body = $('history-table').tBodies[0];
  body.replaceChildren();
  for (const p of [...data.points].reverse()) {
    const tr = el('tr');
    tr.append(
      el('td', {}, timeLabel(p.t, true)),
      el('td', { class: 'num' }, fmt.format(p.osrs)),
      el('td', { class: 'num' }, p.rs3 == null ? '–' : fmt.format(p.rs3)),
      el('td', { class: 'num' }, fmt.format(p.total)),
      el('td', { class: 'num' }, p.steamOsrs == null ? '–' : fmt.format(p.steamOsrs)),
      el('td', { class: 'num' }, p.steamRs3 == null ? '–' : fmt.format(p.steamRs3)),
    );
    body.append(tr);
  }
}

// ---------- OSRS breakdowns ----------

function renderBars(container, rows) {
  container.replaceChildren();
  const max = Math.max(...rows.map((r) => r.value), 1);
  for (const r of rows) {
    const row = el('div', { class: 'bar-row', title: `${r.name}: ${fmt.format(r.value)} players` });
    const track = el('div', { class: 'track' });
    const fill = el('div', { class: 'fill' });
    fill.style.width = `${(r.value / max) * 100}%`;
    track.append(fill);
    row.append(el('span', { class: 'name' }, r.name), track, el('span', { class: 'val' }, fmt.format(r.value)));
    container.append(row);
  }
}

function renderBreakdowns() {
  const byRegion = new Map();
  let members = 0, f2p = 0;
  for (const w of worlds.list) {
    byRegion.set(w.region, (byRegion.get(w.region) ?? 0) + w.players);
    if (w.members) members += w.players; else f2p += w.players;
  }
  renderBars($('regions'), [...byRegion].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value));
  renderBars($('types'), [{ name: 'Members', value: members }, { name: 'Free-to-play', value: f2p }]);
}

// ---------- worlds table ----------

const TAG_LABELS = {
  PVP: 'PvP', BOUNTY: 'Bounty', SKILL_TOTAL: 'Skill total', HIGH_RISK: 'High risk',
  LMS: 'LMS', BETA: 'Beta', FRESH_START: 'Fresh start', DEADMAN: 'Deadman',
};

function renderWorlds() {
  if (!worlds) return;
  const q = $('world-search').value.trim().toLowerCase();
  const type = $('world-type').value;
  const rows = worlds.list.filter((w) => {
    if (type === 'members' && !w.members) return false;
    if (type === 'f2p' && w.members) return false;
    return !q || String(w.world).includes(q) || w.activity.toLowerCase().includes(q) || w.region.toLowerCase().includes(q);
  });
  rows.sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return c * sort.dir || a.world - b.world;
  });

  const online = worlds.list.filter((w) => w.players > 0).length;
  $('worlds-sub').textContent = `${online} worlds online · showing ${rows.length} · fetched ${ago(worlds.t)}`;

  for (const btn of document.querySelectorAll('#worlds-table th button')) {
    if (btn.dataset.sort === sort.key) btn.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
    else btn.removeAttribute('aria-sort');
  }

  const body = $('worlds-table').tBodies[0];
  body.replaceChildren();
  for (const w of rows) {
    const tr = el('tr');
    const act = el('td', { class: 'activity' }, w.activity || '—');
    for (const t of w.tags) if (TAG_LABELS[t]) act.append(el('span', { class: 'tag' }, TAG_LABELS[t]));
    tr.append(
      el('td', {}, `W${w.world}`),
      el('td', { class: 'num' }, fmt.format(w.players)),
      el('td', {}, w.members ? 'Members' : 'Free'),
      el('td', {}, w.region),
      act,
    );
    body.append(tr);
  }
}

// ---------- wiring ----------

function syncRangeButtons() {
  for (const b of document.querySelectorAll('#ranges button')) {
    b.setAttribute('aria-checked', String(Number(b.dataset.range) === range));
  }
}

$('ranges').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  range = Number(b.dataset.range);
  try { localStorage.setItem(RANGE_KEY, String(range)); } catch {}
  syncRangeButtons();
  loadHistory();
});

function syncThemeToggle() {
  const light = document.documentElement.dataset.theme === 'light';
  const btn = $('theme-toggle');
  btn.textContent = light ? '☾' : '☀';
  const label = light ? 'Switch to dark theme' : 'Switch to light theme';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

$('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const light = root.dataset.theme !== 'light';
  if (light) root.dataset.theme = 'light';
  else delete root.dataset.theme;
  try { localStorage.setItem('rs-tracker:theme', light ? 'light' : 'dark'); } catch {}
  syncThemeToggle();
});
syncThemeToggle();

document.querySelector('#worlds-table thead').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const key = b.dataset.sort;
  sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === 'players' ? -1 : 1 };
  renderWorlds();
});
$('world-search').addEventListener('input', renderWorlds);
$('world-type').addEventListener('change', renderWorlds);

let resizeTimer;
const resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => data && renderCharts(), 100);
});
CHARTS.forEach((c) => resizeObserver.observe($(c.id)));

syncRangeButtons();
loadHistory();
loadWorlds();
setInterval(loadHistory, 30_000);
setInterval(loadWorlds, 60_000);
setInterval(() => data && renderStatus(), 5_000);
