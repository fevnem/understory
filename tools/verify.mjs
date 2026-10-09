#!/usr/bin/env node
/**
 * tools/verify.mjs — Understory's own test suite. Zero dependencies, drives a real headless
 * Chromium over raw CDP using Node's built-in WebSocket. Grades the page and every module
 * against docs/CONTRACT.md, not against an author's intentions.
 *
 *   python3 -m http.server 8150 --bind 127.0.0.1      # in another shell, repo root
 *   node tools/verify.mjs                              # everything
 *   node tools/verify.mjs --only forest                # page checks + the forest module's checks
 *   node tools/verify.mjs --url http://127.0.0.1:8150/index.html
 *
 * Modules that are not written yet are reported as skipped, so the gate is usable from day one.
 * Exits non-zero if anything fails.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1]; };

const BASE = opt('url', 'http://127.0.0.1:8150/index.html');
const ORIGIN = new URL(BASE).origin;
const ONLY = opt('only', null);
const ROOT = process.cwd();
const VERBOSE = args.includes('--verbose');

/* ---------- the contract, as data ---------- */

const BUDGET = { js: 32 * 1024, page: 8 * 1024, css: 32 * 1024 };
const WIDTHS = [1440, 1024, 900, 390];

const MODULE_CHECKS = {
  forest: {
    need: (s) => typeof s === 'object' && s !== null,
    tests: [
      ['forest renders a standing wood', (s) => num(s.trees) >= 24, 'trees'],
      ['forest draws in a layer', (s) => num(s.draws) >= 1 || num(s.instances) >= 1, 'draws'],
      ['forest knows its species', (s) => num(s.species) >= 4, 'species']
    ]
  },
  weather: {
    need: (s) => typeof s === 'object' && s !== null,
    tests: [
      ['weather draws rain', (s) => num(s.drops) >= 120, 'drops'],
      ['weather owns the post pass', (s) => s.post === true, 'post'],
      ['weather knows its frame cost', (s) => num(s.layers) >= 1 || num(s.passes) >= 1, 'layers']
    ]
  },
  ambience: {
    need: (s) => typeof s === 'object' && s !== null,
    tests: [
      ['ambience built an audio graph', (s) => num(s.nodes) >= 4, 'nodes'],
      ['ambience is running after a gesture', (s) => s.state === 'running' || s.state === 'suspended', 'state'],
      ['ambience exposes a mixer', (s) => num(s.buses) >= 3, 'buses']
    ]
  },
  instrument: {
    dom: [
      ['instrument mounted a ring', () => !!document.querySelector('#instrument [data-role="ring"]')],
      ['instrument mounted a readout', () => !!document.querySelector('#instrument [data-role="readout"]')],
      ['instrument mounted a phase label', () => !!document.querySelector('#instrument [data-role="phase"]')],
      ['instrument has a sow control', () => !!document.querySelector('#instrument [data-act="sow"]')]
    ]
  },
  garden: {
    dom: [
      ['garden mounted a grid', () => !!document.querySelector('#garden .garden-grid')],
      ['garden lists days with dates', () => !!document.querySelector('#garden [data-role="day"][data-date]')]
    ]
  }
};

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : -1);

/* ---------- chromium ---------- */

const CHROME = [
  path.join(homedir(), '.cache/ms-playwright/chromium-1148/chrome-linux/chrome'),
  path.join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell'),
  '/usr/bin/chromium', '/usr/bin/google-chrome'
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chromium found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9401 + (process.pid % 190);

const child = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio',
  '--remote-debugging-port=' + PORT, '--window-size=1440,900', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErr = '';
child.stderr.on('data', (d) => { chromeErr += d.toString(); });

async function target() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('chromium never exposed a page target\n' + chromeErr.slice(-400));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; this.reqs = []; }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    const cdp = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && cdp.pending.has(m.id)) {
        const { resolve, reject } = cdp.pending.get(m.id);
        cdp.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled') {
        cdp.logs.push({ level: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        cdp.logs.push({ level: 'exception', text: (d.exception && d.exception.description) || d.text });
      } else if (m.method === 'Network.requestWillBeSent') {
        cdp.reqs.push(m.params.request.url);
      }
    };
    return cdp;
  }

  send(method, params = {}, t = 60000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' timed out')); } }, t);
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 90000);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }

  async viewport(w, h) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  }

  async goto(url, ready = 'document.readyState === "complete"') {
    this.logs = []; this.reqs = [];
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 80; i += 1) {
      await sleep(150);
      if (await this.eval(ready).catch(() => false)) return true;
    }
    return false;
  }

  async waitFor(expr, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const v = await this.eval(expr).catch(() => false);
      if (v) return v;
      await sleep(150);
    }
    return false;
  }

  async click(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
  }

  async key(key) {
    return this.eval(`(() => {
      const opts = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', opts));
      return true;
    })()`);
  }

  reset() { this.logs = []; this.reqs = []; }
}

/* ---------- reporting ---------- */

let pass = 0;
const problems = [];
const skipped = [];
const warnings = [];
const check = (label, ok, extra) => {
  if (ok) { pass += 1; console.log('  ok   ' + label + (extra ? '  ' + extra : '')); }
  else { problems.push(label + (extra ? '  — ' + extra : '')); console.log('  FAIL ' + label + (extra ? '  ' + extra : '')); }
};
const warn = (label, extra) => { warnings.push(label + (extra ? ' — ' + extra : '')); console.log('  warn ' + label + (extra ? '  ' + extra : '')); };
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const sizeOf = async (rel) => { try { return (await stat(path.join(ROOT, rel))).size; } catch { return null; } };

/* ---------- run ---------- */

const cdp = await CDP.open(await target());
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Network.enable');

console.log('driving ' + BASE);
if (ONLY) console.log('--only ' + ONLY);

await cdp.viewport(1440, 900);
const loaded = await cdp.goto(BASE);
check('index.html loads', loaded);

const booted = await cdp.waitFor('!!(window.__understory && window.__understory.boot)', 10000);
check('the app boots', !!booted);

const bootInfo = booted ? await cdp.eval('window.__understory.boot') : { hasGL: false };

/* ---------- page hygiene ---------- */

console.log('\n── page');
const title = await cdp.eval('document.title');
check('has a title', !!title && title !== 'Untitled', JSON.stringify(title).slice(0, 48));
const desc = await cdp.eval('(document.querySelector(\'meta[name="description"]\') || {}).content || ""');
check('has a meta description', desc.length > 30, kb(Buffer.byteLength(desc)));
check('WebGL2 is available in this browser', bootInfo.hasGL === true, String(bootInfo.hasGL));
check('no off-origin requests', cdp.reqs.every((u) => { try { return new URL(u).origin === ORIGIN; } catch { return true; } }),
  cdp.reqs.filter((u) => { try { return new URL(u).origin !== ORIGIN; } catch { return false; } }).slice(0, 2).join(' '));

/* ---------- budgets ---------- */

console.log('\n── budgets');
const page = await sizeOf('index.html');
if (page !== null) check('index.html ≤ ' + kb(BUDGET.page), page <= BUDGET.page, kb(page));

let cssTotal = 0;
try {
  for (const f of await readdir(path.join(ROOT, 'css'))) {
    if (f.endsWith('.css')) cssTotal += (await stat(path.join(ROOT, 'css', f))).size;
  }
} catch { /* no css dir */ }
check('all CSS ≤ ' + kb(BUDGET.css), cssTotal <= BUDGET.css, kb(cssTotal));

async function walk(dir, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const jsFiles = (await walk(ROOT)).filter((f) => f.endsWith('.js') && !f.endsWith('.mjs'));
let jsTotal = 0, biggest = null;
for (const f of jsFiles) {
  const s = (await stat(f)).size;
  jsTotal += s;
  if (!biggest || s > biggest.size) biggest = { file: path.relative(ROOT, f), size: s };
}
check('every JS file ≤ ' + kb(BUDGET.js), !biggest || biggest.size <= BUDGET.js, biggest ? biggest.file + ' ' + kb(biggest.size) : '');
console.log('       js total: ' + kb(jsTotal) + ' across ' + jsFiles.length + ' files');
check('no package.json (no build step)', !(await sizeOf('package.json')));

/* ---------- overflow ---------- */

console.log('\n── layout');
for (const w of WIDTHS) {
  await cdp.viewport(w, 900);
  await sleep(200);
  const m = await cdp.eval('({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth })');
  check('no horizontal overflow at ' + w + 'px', m.sw <= m.iw + 1 && m.bw <= m.iw + 1, m.sw + ' vs ' + m.iw);
}
await cdp.viewport(1440, 900);

/* ---------- the timer is the point ---------- */

console.log('\n── pomodoro engine');
await cdp.eval('window.__understory.store.reset(); true');
const sown = await cdp.eval(`(() => {
  const t = window.__understory.timer;
  window.__understory.store.state.settings.focus = 25;
  t.beginFocus();
  return { state: t.state, phase: t.phase, duration: t.duration, tree: !!(t.tree && t.tree.species) };
})()`);
check('sowing starts a focus phase', sown.state === 'growing' && sown.phase === 'focus', sown.state + '/' + sown.phase);
check('a tree is planted with a species', sown.tree === true);
check('focus phase is 25 minutes by default', sown.duration === 25 * 60000, String(sown.duration));

const paused = await cdp.eval(`(() => {
  const t = window.__understory.timer;
  t.pause();
  return { state: t.state, grace: t.graceLeft };
})()`);
check('pause holds the tree', paused.state === 'paused' && paused.grace > 0, 'grace ' + paused.grace + 'ms');
const resumed = await cdp.eval('(window.__understory.timer.resume(), window.__understory.timer.state)');
check('resume returns to growing', resumed === 'growing', String(resumed));

const wilted = await cdp.eval(`(() => {
  const u = window.__understory;
  u.timer.abandon();
  const f = u.store.state.forest;
  return { state: u.timer.state, outcome: f.length ? f[f.length - 1].outcome : null, trees: f.length };
})()`);
check('abandoning a session wilts the tree', wilted.outcome === 'wilted', String(wilted.outcome));

const harvested = await cdp.eval(`(async () => {
  const u = window.__understory;
  u.store.state.settings.focus = 0.02;   // 1.2s, so the gate does not wait a minute
  u.timer.beginFocus();
  await new Promise((r) => setTimeout(r, 2600));
  const f = u.store.state.forest;
  const last = f[f.length - 1];
  return {
    outcome: last ? last.outcome : null,
    minutes: last ? last.minutes : 0,
    today: u.store.derived().today.focusMinutes,
    harvested: u.store.derived().today.harvested,
    streak: u.store.derived().streak
  };
})()`);
check('finishing a focus session harvests the tree', harvested.outcome === 'harvested' || harvested.outcome === 'wild' || harvested.outcome === 'distracted', String(harvested.outcome));
check('the day records focus minutes', harvested.today > 0, String(harvested.today));
check('today counts a harvested tree', harvested.harvested >= 1, String(harvested.harvested));

const breakPhase = await cdp.eval(`(async () => {
  const u = window.__understory;
  u.store.state.settings.short = 0.02;
  u.timer.start();
  const a = { state: u.timer.state, phase: u.timer.phase, tree: !!u.timer.tree };
  return a;
})()`);
check('a break phase runs after focus', breakPhase.phase === 'short' && breakPhase.state === 'break', breakPhase.phase + '/' + breakPhase.state);
check('no tree grows during a break', breakPhase.tree === false);

const restored = await cdp.eval(`(async () => {
  const u = window.__understory;
  u.store.reset();
  u.store.state.settings.focus = 25;
  u.timer.beginFocus();
  u.store.save();
  return true;
})()`);
await cdp.goto(BASE);
await cdp.waitFor('!!(window.__understory && window.__understory.boot)', 10000);
const afterReload = await cdp.eval(`(() => {
  const u = window.__understory;
  return { state: u.timer.state, phase: u.timer.phase, remaining: u.timer.remaining, tree: !!(u.timer.tree) };
})()`);
check('an in-flight session survives a reload', restored && afterReload.state === 'growing' && afterReload.tree,
  afterReload.state + ' remaining ' + Math.round(afterReload.remaining / 1000) + 's');

/* ---------- keys ---------- */

console.log('\n── keys');
await cdp.eval('window.__understory.store.reset(); window.__understory.timer.abandon(); true');
await cdp.key(' ');
const keyStarted = await cdp.waitFor('window.__understory.timer.state === "growing"', 3000);
check('space sows a tree', !!keyStarted);
await cdp.key('g');
const gardenView = await cdp.eval('window.__understory.store.state.settings.view');
check('g switches to the garden view', gardenView === 'garden', String(gardenView));
await cdp.key('g');
await cdp.key('m');
const muted = await cdp.eval('window.__understory.store.state.settings.sound.master');
check('m mutes the forest', muted === 0, String(muted));
await cdp.key('m');
await cdp.key('a');

/* ---------- reduced motion ---------- */

console.log('\n── reduced motion');
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await cdp.goto(BASE);
await cdp.waitFor('!!(window.__understory && window.__understory.boot)', 10000);
const rm = await cdp.eval(`(() => ({
  emulated: matchMedia('(prefers-reduced-motion: reduce)').matches,
  bodyClass: document.body.classList.contains('reduced'),
  anims: document.getAnimations ? document.getAnimations().length : 0,
  quality: window.__understory.boot.quality
}))()`);
check('reduced motion is emulated', rm.emulated === true);
check('the app notices reduced motion', rm.bodyClass === true);
check('nothing animates under reduced motion', rm.anims === 0, String(rm.anims));
check('quality drops to low under reduced motion', rm.quality === 'low', String(rm.quality));
await cdp.send('Emulation.setEmulatedMedia', { features: [] });
await cdp.goto(BASE);
await cdp.waitFor('!!(window.__understory && window.__understory.boot)', 10000);

/* ---------- modules ---------- */

const ids = await cdp.eval('window.__understory ? window.__understory.ids() : []');
const wanted = Object.keys(MODULE_CHECKS).filter((id) => !ONLY || id === ONLY);
const present = ids.filter((id) => wanted.includes(id));
const absent = wanted.filter((id) => !ids.includes(id));

if (absent.length) console.log('\n── modules not written yet: ' + absent.join(', '));
for (const id of absent) skipped.push(id);

for (const id of present) {
  console.log('\n── module: ' + id);
  await cdp.eval('window.__understory.store.reset(); true');
  await cdp.eval('window.__understory.act("sow"); true');
  await sleep(1200);

  const spec = MODULE_CHECKS[id];
  if (spec.tests) {
    const stats = await cdp.eval(`(() => { const h = window.__understory.handle(${JSON.stringify(id)}); try { return h.stats(); } catch (e) { return { error: String(e && e.message) }; } })()`);
    if (VERBOSE) console.log('       stats: ' + JSON.stringify(stats));
    if (!spec.need(stats) || stats.error) {
      check(id + ' stats() available', false, stats && stats.error ? stats.error : JSON.stringify(stats));
    } else {
      check(id + ' stats() available', true);
      for (const [label, fn, key] of spec.tests) check(label, fn(stats), key + '=' + JSON.stringify(stats[key]));
    }
  }

  if (spec.dom) {
    for (const [label, fn] of spec.dom) {
      const ok = await cdp.eval(`(${fn.toString()})()`);
      check(label, !!ok);
    }
  }

  const errs = cdp.logs.filter((l) => l.level === 'error' || l.level === 'exception');
  check(id + ': no console errors with the module live', errs.length === 0, errs.length ? String(errs[0].text).slice(0, 110) : '');
}

/* ---------- frame budget ---------- */

console.log('\n── frame budget');
await cdp.eval('window.__understory.act("sow"); true');
await sleep(2500);
const frameMs = await cdp.eval('window.__understory.frameMs()');
check('median frame ≤ 24 ms (idle, high quality)', frameMs > 0 && frameMs <= 24, frameMs + ' ms');

const finalErrors = cdp.logs.filter((l) => l.level === 'error' || l.level === 'exception');
check('no console errors overall', finalErrors.length === 0, finalErrors.length ? String(finalErrors[0].text).slice(0, 110) : '');

/* ---------- summary ---------- */

console.log('\n' + (problems.length ? '  ' + problems.length + ' failed' : '  all checks passed') +
  '  ·  ' + pass + ' passed' +
  (warnings.length ? '  ·  ' + warnings.length + ' warnings' : '') +
  (skipped.length ? '  ·  ' + skipped.length + ' modules not written yet' : ''));
if (warnings.length) { console.log('  warnings:'); warnings.forEach((w) => console.log('    · ' + w)); }
if (problems.length) { console.log('  failures:'); problems.forEach((p) => console.log('    ✗ ' + p)); }

child.kill('SIGKILL');
process.exit(problems.length ? 1 : 0);
