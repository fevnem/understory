// js/main.js — the manager's file: boot order, the module registry, the frame loop, global keys,
// theme, view switching and the harness probe surface. Hands never edit this file.

import { createBus } from './core/bus.js';
import { createStore } from './core/store.js';
import { createTimer } from './core/timer.js';
import { createStage } from './gl/stage.js';
import { SPECIES } from './content/species.js';

/* Registry — frozen ids/paths from docs/CONTRACT.md §2. A missing file is skipped with a
   warning so hands can land one at a time. `probeOnly` entries mount only with ?probe=1. */
const MODULES = [
  { id: 'forest',     path: './gl/forest.js',      order: 10 },
  { id: 'weather',    path: './gl/weather.js',     order: 20 },
  { id: 'ambience',   path: './audio/ambience.js', order: 30 },
  { id: 'instrument', path: './ui/instrument.js',  order: 40 },
  { id: 'garden',     path: './ui/garden.js',      order: 50 }
];

const root = document.documentElement;
const params = new URLSearchParams(location.search);
const probe = params.get('probe') === '1';

function cssNumber(name, fallback) {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return isFinite(n) ? n : fallback;
}
function cssColor(name, fallback) {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const v = parseInt(hex[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
  }
  const rgb = raw.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(',').map(function (s) { return parseFloat(s); });
    return [(parts[0] || 0) / 255, (parts[1] || 0) / 255, (parts[2] || 0) / 255, parts.length > 3 ? parts[3] : 1];
  }
  return fallback;
}

function themeFor(now) {
  const h = now.getHours();
  if (h >= 5 && h < 9) return 'dawn';
  if (h >= 9 && h < 17) return 'dusk';
  return 'night';
}

export async function boot() {
  const bus = createBus();
  const store = createStore();
  store.load();

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = document.getElementById('gl');
  const dom = {
    root: document.getElementById('ui'),
    instrument: document.getElementById('instrument'),
    garden: document.getElementById('garden'),
    atmos: document.getElementById('atmos'),
    masthead: document.querySelector('.masthead'),
    totals: document.querySelector('[data-role="totals"]'),
    degraded: document.querySelector('[data-role="degraded"]')
  };

  // Theme: his setting, or honest local time.
  const wantTheme = store.state.settings.theme;
  const theme = wantTheme === 'auto' ? themeFor(new Date()) : wantTheme;
  root.setAttribute('data-theme', theme);

  const stage = createStage({
    canvas,
    quality: store.state.settings.quality === 'low' || reducedMotion ? 'low' : 'high',
    dprCap: 2,
    antialias: !reducedMotion,
    clearColor: cssColor('--sky-base', [0.05, 0.06, 0.07, 1])
  });
  const hasGL = !!stage;
  if (!hasGL) document.body.classList.add('no-gl');
  if (reducedMotion) document.body.classList.add('reduced');
  if (dom.degraded) dom.degraded.hidden = hasGL;

  const quality = stage ? stage.quality : 'low';
  const timer = createTimer({ store, bus, species: SPECIES, now: function () { return Date.now(); } });

  const ctx = {
    canvas, gl: stage ? stage.gl : null, stage, timer, store, bus, dom, species: SPECIES,
    quality, reducedMotion, hasGL,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: Math.min(2, window.devicePixelRatio || 1) },
    save: function () { return store.save(); },
    log: function () {
      const args = Array.prototype.slice.call(arguments);
      console.info.apply(console, ['[understory]'].concat(args));
    },
    renderText: function (node, text) { if (node) node.textContent = String(text == null ? '' : text); return node; }
  };

  const modules = {};
  const handles = [];
  const skipped = [];

  for (const spec of MODULES) {
    if (spec.probeOnly && !probe) continue;
    try {
      const mod = await import(spec.path);
      if (typeof mod.create !== 'function') throw new Error('missing create(ctx) export');
      const handle = mod.create(ctx);
      const label = (mod.meta && mod.meta.id) || spec.id;
      modules[label] = { spec, mod, handle: handle || {} };
      handles.push({ id: label, order: spec.order, handle: handle || {}, spec });
    } catch (err) {
      const missing = /Failed to fetch|Cannot find module|404|Importing a module script failed|error loading/i.test(String(err && err.message));
      if (missing) { skipped.push(spec.id); console.warn('[understory] module not written yet: ' + spec.id); }
      else console.warn('[understory] module failed (' + spec.id + '): ' + (err && err.message));
    }
  }
  handles.sort(function (a, b) { return a.order - b.order; });

  /* ---------------- layout ---------------- */

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = quality === 'low' ? 1 : Math.min(2, window.devicePixelRatio || 1);
    ctx.viewport = { w, h, dpr };
    if (stage) stage.resize(w, h, dpr);
    for (const item of handles) {
      if (typeof item.handle.resize === 'function') {
        try { item.handle.resize(stage ? stage.width : w, stage ? stage.height : h, dpr); }
        catch (err) { console.warn('[understory] resize failed (' + item.id + '): ' + (err && err.message)); }
      }
    }
  }
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('orientationchange', resize, { passive: true });

  /* ---------------- view ---------------- */

  function setView(view, silent) {
    const v = view === 'garden' ? 'garden' : 'forest';
    store.state.settings.view = v;
    document.body.setAttribute('data-view', v);
    if (dom.garden) dom.garden.hidden = v !== 'garden';
    if (dom.instrument) dom.instrument.hidden = v === 'garden';
    if (!silent) { store.save(); bus.emit('view:changed', { view: v }); }
    return v;
  }

  /* ---------------- totals in the masthead ---------------- */

  function paintTotals() {
    if (!dom.totals) return;
    const d = store.derived();
    const parts = [];
    parts.push(d.today.focusMinutes > 0 ? d.today.focusMinutes + ' min today' : 'nothing planted today');
    if (d.allTrees) parts.push(d.allTrees + (d.allTrees === 1 ? ' tree' : ' trees') + ' in all');
    if (d.streak > 1) parts.push(d.streak + ' days running');
    dom.totals.textContent = parts.join(' · ');
  }

  /* ---------------- sound master (global mute, m) ---------------- */

  let mutedFrom = null;
  function toggleMute() {
    const s = store.state.settings.sound;
    if (s.master > 0) { mutedFrom = s.master; s.master = 0; }
    else { s.master = mutedFrom || 0.6; }
    store.save();
    bus.emit('settings:changed', { key: 'sound.master', value: s.master });
    return s.master;
  }

  /* ---------------- global keys (contract §9) ---------------- */

  function typing(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }

  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing(e)) return;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      if (timer.state === 'idle' || timer.state === 'wilted') timer.beginFocus();
      else if (timer.state === 'paused') timer.resume();
      else if (timer.state === 'growing') timer.pause();
      else if (timer.state === 'break' && timer.progress >= 1) timer.abandon();
    } else if (k === 'a' || k === 'A') { timer.abandon(); }
    else if (k === 's' || k === 'S') { timer.skip(); }
    else if (k === 'g' || k === 'G') { setView(store.state.settings.view === 'garden' ? 'forest' : 'garden'); }
    else if (k === 'm' || k === 'M') { toggleMute(); }
    else return;
    paintTotals();
  }, { passive: false });

  /* ---------------- visibility honesty ---------------- */

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt) { timer.noteHidden(Date.now() - hiddenAt); hiddenAt = 0; }
  }, { passive: true });

  /* ---------------- pointer ---------------- */

  let pointerQueued = null;
  window.addEventListener('pointermove', function (e) {
    pointerQueued = {
      x: e.clientX, y: e.clientY,
      nx: (e.clientX / window.innerWidth) * 2 - 1,
      ny: -((e.clientY / window.innerHeight) * 2 - 1)
    };
  }, { passive: true });

  /* ---------------- frame loop ---------------- */

  let last = performance.now();
  let lastFrameAt = 0;
  const frameGaps = [];
  const frameWork = [];
  let frames = 0;
  let running = true;

  function loop(now) {
    if (!running) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    frames += 1;

    if (pointerQueued) { bus.emit('pointer', pointerQueued); pointerQueued = null; }
    timer.update();
    if (stage) stage.frame(dt);

    for (const item of handles) {
      if (typeof item.handle.update === 'function') {
        try { item.handle.update(dt, now / 1000); }
        catch (err) { console.warn('[understory] update failed (' + item.id + '): ' + (err && err.message)); }
      }
    }

    // Two honest numbers: the gap between frames (what the eye feels) and the work done
    // inside the callback (what this code costs). WebGL calls are async, so the gap is the
    // real frame budget; the work number tells you when JS itself is the problem.
    if (lastFrameAt) frameGaps.push(now - lastFrameAt);
    lastFrameAt = now;
    frameWork.push(performance.now() - now);
    if (frameGaps.length > 300) frameGaps.shift();
    if (frameWork.length > 300) frameWork.shift();

    window.__understory.frames = frames;
    requestAnimationFrame(loop);
  }

  bus.on('session:harvest', paintTotals);
  bus.on('session:wilt', paintTotals);
  bus.on('forest:changed', paintTotals);

  resize();
  setView(store.state.settings.view || 'forest', true);
  timer.restore();
  paintTotals();

  /* ---------------- the harness's probe surface ---------------- */

  function median(list) {
    if (!list.length) return 0;
    const sorted = list.slice().sort(function (a, b) { return a - b; });
    return Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100;
  }
  function medianFrameMs() { return median(frameGaps); }

  const glInfo = (function rendererName() {
    if (!stage) return 'none';
    const ext = stage.gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(stage.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  })();

  window.__understory = {
    boot: { at: Date.now(), quality, hasGL, reducedMotion, theme, probe, skipped, renderer: glInfo },
    version: 1,
    bus, store, timer, stage, ctx,
    modules,
    ids: function () { return Object.keys(modules); },
    handle: function (id) { return modules[id] ? modules[id].handle : null; },
    stats: function () {
      const out = { quality, hasGL, renderer: glInfo, views: {}, errors: 0 };
      for (const id of Object.keys(modules)) {
        const h = modules[id].handle;
        try { out.views[id] = typeof h.stats === 'function' ? h.stats() : { noStats: true }; }
        catch (err) { out.views[id] = { error: err && err.message }; }
      }
      out.frameMs = medianFrameMs();
      out.workMs = median(frameWork);
      out.frames = frames;
      return out;
    },
    frameMs: medianFrameMs,
    workMs: function () { return median(frameWork); },
    renderer: glInfo,
    setView, toggleMute,
    act: function (what) {
      if (what === 'sow') return timer.beginFocus();
      if (what === 'pause') return timer.pause();
      if (what === 'resume') return timer.resume();
      if (what === 'abandon') return timer.abandon();
      if (what === 'skip') return timer.skip();
      if (what === 'garden') return setView('garden');
      if (what === 'forest') return setView('forest');
      return false;
    }
  };

  bus.emit('boot', { quality });
  running = true;
  requestAnimationFrame(loop);
  return window.__understory;
}

boot().catch(function (err) {
  console.error('[understory] boot failed:', err);
  const warn = document.querySelector('[data-role="degraded"]');
  if (warn) { warn.hidden = false; warn.textContent = 'The page could not start: ' + (err && err.message); }
});
