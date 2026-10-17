// RuneScape player count tracker.
// Polls the official Jagex endpoints, appends samples to data/samples.jsonl,
// and serves a dashboard + JSON API. No dependencies; Node 18+.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const SAMPLES_FILE = path.join(DATA_DIR, 'samples.jsonl');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 3320;
// Neither Jagex endpoint documents a rate limit; 2 minutes keeps us polite.
const POLL_MS = Math.max(15_000, Number(process.env.POLL_MS) || 120_000);
const MAX_POINTS = 720;

// Combined RS3 + OSRS online count (JSONP). The endpoint 404s unless the
// callback name looks like a real jQuery one.
const TOTAL_URL =
  'https://www.runescape.com/player_count.js?varname=iPlayerCount&callback=jQuery000000000000000_0000000000';
// OSRS world list, the same binary feed the game client uses.
const WORLDS_URL = 'https://www.runescape.com/g=oldscape/slr.ws?order=LPWM';

// Concurrent players launched through Steam (a subset of each game's total).
const STEAM_APPS = { steamRs3: 1343400, steamOsrs: 1343370 };
const STEAM_URL = 'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=';

// Numeric fields of a sample; any but total/osrs may be null.
const FIELDS = ['total', 'osrs', 'rs3', ...Object.keys(STEAM_APPS)];

const HEADERS ={ 'User-Agent': 'rs-tracker/1.0 (personal player count tracker)' };

// World location codes as sent in slr.ws.
const REGIONS = { 0: 'United States', 1: 'United Kingdom', 3: 'Australia', 7: 'Germany' };

// World type flag bits.
const FLAGS = {
  MEMBERS: 1 << 0,
  PVP: 1 << 2,
  BOUNTY: 1 << 5,
  SKILL_TOTAL: 1 << 7,
  HIGH_RISK: 1 << 10,
  LMS: 1 << 14,
  BETA: 1 << 16,
  FRESH_START: 1 << 25,
  DEADMAN: 1 << 29,
};

/** @type {{t:number,total:number,osrs:number,rs3:number|null,steamRs3?:number|null,steamOsrs?:number|null}[]} */
let samples = [];
let worlds = { t: 0, list: [] };
let lastError = null;

function loadSamples() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SAMPLES_FILE)) return;
  for (const line of fs.readFileSync(SAMPLES_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      samples.push(JSON.parse(line));
    } catch {
      // Skip a partially written line.
    }
  }
  samples.sort((a, b) => a.t - b.t);
  console.log(`Loaded ${samples.length} samples from ${path.relative(ROOT, SAMPLES_FILE)}`);
}

async function fetchWithTimeout(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

async function fetchTotal() {
  const text = await (await fetchWithTimeout(TOTAL_URL)).text();
  const m = text.match(/\((\d+)\)/);
  if (!m) throw new Error(`Unexpected player_count.js response: ${text.slice(0, 80)}`);
  return Number(m[1]);
}

function parseWorlds(buf) {
  let o = 4; // int32 payload length
  const count = buf.readUInt16BE(o);
  o += 2;
  const str = () => {
    const end = buf.indexOf(0, o);
    const s = buf.toString('latin1', o, end);
    o = end + 1;
    return s;
  };
  const list = [];
  for (let i = 0; i < count; i++) {
    const id = buf.readUInt16BE(o);
    const flags = buf.readInt32BE(o + 2);
    o += 6;
    str(); // hostname
    const activity = str();
    const location = buf.readUInt8(o);
    const players = buf.readInt16BE(o + 1);
    o += 3;
    list.push({
      world: id > 300 ? id - 300 : id,
      players: Math.max(players, 0), // -1 means offline
      members: Boolean(flags & FLAGS.MEMBERS),
      // Newer location codes (8, 9, 10, 12, ...) aren't publicly documented.
      region: REGIONS[location] ?? `Other (code ${location})`,
      activity: activity === '-' ? '' : activity,
      tags: Object.entries(FLAGS)
        .filter(([k, bit]) => k !== 'MEMBERS' && flags & bit)
        .map(([k]) => k),
    });
  }
  return list;
}

async function fetchWorlds() {
  const buf = Buffer.from(await (await fetchWithTimeout(WORLDS_URL)).arrayBuffer());
  return parseWorlds(buf);
}

async function fetchSteam(appId) {
  const body = await (await fetchWithTimeout(STEAM_URL + appId)).json();
  if (body?.response?.result !== 1) throw new Error(`Steam app ${appId}: unexpected response`);
  return body.response.player_count;
}

async function poll() {
  const steamKeys = Object.keys(STEAM_APPS);
  const [totalRes, worldsRes, ...steamRes] = await Promise.allSettled([
    fetchTotal(),
    fetchWorlds(),
    ...steamKeys.map((k) => fetchSteam(STEAM_APPS[k])),
  ]);
  const t = Date.now();

  if (worldsRes.status === 'fulfilled') worlds = { t, list: worldsRes.value };
  const errors = [totalRes, worldsRes, ...steamRes].filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  lastError = errors.length ? { t, message: errors.join('; ') } : null;
  if (errors.length) console.warn(new Date(t).toISOString(), 'poll error:', lastError.message);

  if (totalRes.status !== 'fulfilled' || worldsRes.status !== 'fulfilled') return;

  const total = totalRes.value;
  const osrs = worldsRes.value.reduce((s, w) => s + w.players, 0);
  // The two feeds update independently, so guard against a nonsensical difference.
  const rs3 = total >= osrs ? total - osrs : null;
  const sample = { t, total, osrs, rs3 };
  // Steam is a nice-to-have: record null rather than dropping the sample.
  steamKeys.forEach((k, i) => (sample[k] = steamRes[i].status === 'fulfilled' ? steamRes[i].value : null));
  samples.push(sample);
  fs.appendFile(SAMPLES_FILE, JSON.stringify(sample) + '\n', (err) => {
    if (err) console.error('Failed to write sample:', err.message);
  });
}

function inRange(rangeMs) {
  if (!rangeMs) return samples;
  const from = Date.now() - rangeMs;
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t < from) lo = mid + 1;
    else hi = mid;
  }
  return samples.slice(lo);
}

// Average samples into at most MAX_POINTS time buckets.
function downsample(rows) {
  if (rows.length <= MAX_POINTS) return rows;
  const t0 = rows[0].t;
  const span = rows.at(-1).t - t0 || 1;
  const buckets = new Map();
  for (const r of rows) {
    const k = Math.min(MAX_POINTS - 1, Math.floor(((r.t - t0) / span) * MAX_POINTS));
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { n: 0, t: 0, sum: {}, cnt: {} }));
    b.n++;
    b.t += r.t;
    for (const f of FIELDS) {
      if (r[f] == null) continue;
      b.sum[f] = (b.sum[f] ?? 0) + r[f];
      b.cnt[f] = (b.cnt[f] ?? 0) + 1;
    }
  }
  return [...buckets.values()].map((b) => {
    const p = { t: Math.round(b.t / b.n) };
    for (const f of FIELDS) p[f] = b.cnt[f] ? Math.round(b.sum[f] / b.cnt[f]) : null;
    return p;
  });
}

function extremes(rows, key) {
  let max = null;
  let min = null;
  for (const r of rows) {
    if (r[key] == null) continue;
    if (!max || r[key] > max[key]) max = r;
    if (!min || r[key] < min[key]) min = r;
  }
  return {
    peak: max && { value: max[key], t: max.t },
    low: min && { value: min[key], t: min.t },
  };
}

function history(rangeMs) {
  const rows = inRange(rangeMs);
  return {
    pollMs: POLL_MS,
    sampleCount: rows.length,
    latest: samples.at(-1) ?? null,
    lastError,
    stats: Object.fromEntries(FIELDS.map((f) => [f, extremes(rows, f)])),
    points: downsample(rows),
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/history') {
    return sendJson(res, history(Number(url.searchParams.get('range')) || 0));
  }
  if (url.pathname === '/api/worlds') {
    return sendJson(res, worlds);
  }

  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

loadSamples();
await poll();
setInterval(poll, POLL_MS);
server.listen(PORT, () => {
  console.log(`RuneScape tracker on http://localhost:${PORT} (polling every ${POLL_MS / 1000}s)`);
});
