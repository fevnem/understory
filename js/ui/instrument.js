// js/ui/instrument.js — the session instrument. The ring, the countdown, phase and species,
// the sow/hold/abandon controls, the durations and sound trays, and the task line.
// It reads `ctx.timer` and calls its methods; the timer alone decides whether a session grew
// a tree or wilted one. Global hotkeys and the masthead totals belong to js/main.js — not here.

export const meta = { id: 'instrument', order: 40, kind: 'ui' };

const NS = 'http://www.w3.org/2000/svg';
const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;

const DURATIONS = [
  { key: 'focus', label: 'Focus', min: 1, max: 180 },
  { key: 'short', label: 'Short', min: 1, max: 60 },
  { key: 'long', label: 'Long', min: 1, max: 120 },
  { key: 'perLong', label: 'Long every', min: 2, max: 8 }
];

const SOUND = [
  { key: 'master', label: 'Master' },
  { key: 'rain', label: 'Rain' },
  { key: 'wind', label: 'Wind' },
  { key: 'thunder', label: 'Thunder' },
  { key: 'bell', label: 'Bell' }
];

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function mks(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
  return n;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function clockText(ms) {
  const total = Math.max(0, Math.ceil((ms || 0) / 1000));
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function ensureStyles() {
  try {
    if (!document.head) return;
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    for (let i = 0; i < links.length; i += 1) {
      if (((links[i].getAttribute('href') || '')).indexOf('instrument.css') !== -1) return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/instrument.css';
    document.head.append(link);
  } catch (err) { /* styling is progressive; the instrument still works unstyled */ }
}

export function create(ctx) {
  const root = ctx.dom && ctx.dom.instrument;
  const timer = ctx.timer;
  const bus = ctx.bus;
  const store = ctx.store;

  if (!root || !timer || !bus || !store) {
    return { update() {}, stats() { return { mounted: 0 }; }, dispose() {} };
  }

  // index.html is the manager's file, so the instrument guarantees its own stylesheet is present
  // rather than assuming a <link> was wired. Idempotent: a static link makes this a no-op.
  ensureStyles();

  const speciesById = {};
  (ctx.species || []).forEach(function (s) { speciesById[s.id] = s; });

  let lastSig = '';
  let lastRing = -1;
  let paints = 0;
  let updates = 0;

  /* ---------------- markup (built once; only text/styles change after) ---------------- */

  const panes = mk('div', 'panes');

  const dial = mk('div', 'dial');
  const ring = mks('svg', { class: 'ring', viewBox: '0 0 120 120', 'aria-hidden': 'true', focusable: 'false' });
  ring.setAttribute('data-role', 'ring');
  const ringTrack = mks('circle', { class: 'ring-track', cx: 60, cy: 60, r: RING_R });
  const ringFill = mks('circle', { class: 'ring-fill', cx: 60, cy: 60, r: RING_R });
  ringFill.style.strokeDasharray = RING_C + ' ' + RING_C;
  ringFill.style.strokeDashoffset = String(RING_C);
  ring.append(ringTrack, ringFill);

  const mid = mk('div', 'dial-mid');
  const phaseEl = mk('p', 'phase', 'Focus');
  phaseEl.setAttribute('data-role', 'phase');
  const readoutEl = mk('p', 'readout', '25:00');
  readoutEl.setAttribute('data-role', 'readout');
  const speciesEl = mk('p', 'species', '');
  speciesEl.setAttribute('data-role', 'species');
  const graceEl = mk('p', 'grace', '');
  graceEl.setAttribute('data-role', 'grace');
  mid.append(phaseEl, readoutEl, speciesEl, graceEl);
  dial.append(ring, mid);

  function ctl(act, label) {
    const b = mk('button', 'ctl', label);
    b.setAttribute('type', 'button');
    b.setAttribute('data-act', act);
    return b;
  }

  const controls = mk('div', 'controls');
  const bSow = ctl('sow', 'Sow');
  const bHold = ctl('pause', 'Hold');
  const bResume = ctl('resume', 'Resume');
  const bAbandon = ctl('abandon', 'Abandon');
  const bSkip = ctl('skip', 'Skip');
  controls.append(bSow, bHold, bResume, bAbandon, bSkip);

  const taskline = mk('div', 'taskline');
  const taskCap = mk('label', 'task-cap', 'Task');
  const taskInput = mk('input', 'task-input');
  taskInput.id = 'instrument-task';
  taskInput.type = 'text';
  taskInput.setAttribute('data-role', 'task');
  taskInput.setAttribute('placeholder', 'What are you working on?');
  taskInput.setAttribute('maxlength', '200');
  taskInput.setAttribute('autocomplete', 'off');
  taskInput.setAttribute('spellcheck', 'false');
  taskCap.setAttribute('for', 'instrument-task');
  taskline.append(taskCap, taskInput);

  const trays = mk('div', 'trays');
  const bDur = ctl('durations', 'Durations');
  bDur.setAttribute('aria-expanded', 'false');
  const bSound = ctl('sound', 'Sound');
  bSound.setAttribute('aria-expanded', 'false');
  const bView = ctl('view', 'Garden');
  trays.append(bDur, bSound, bView);

  const durTray = mk('div', 'tray tray-durations');
  durTray.setAttribute('hidden', '');
  const durRow = mk('div', 'dur-row');
  const durFields = {};
  DURATIONS.forEach(function (d) {
    const field = mk('label', 'field');
    const cap = mk('span', null, d.label);
    const input = mk('input', null);
    input.type = 'number';
    input.min = String(d.min);
    input.max = String(d.max);
    input.step = '1';
    input.setAttribute('data-dur', d.key);
    field.append(cap, input);
    durRow.append(field);
    durFields[d.key] = input;
  });
  durTray.append(durRow);

  const sndTray = mk('div', 'tray tray-sound');
  sndTray.setAttribute('hidden', '');
  const soundFields = {};
  SOUND.forEach(function (s) {
    const row = mk('label', 'snd-row');
    const cap = mk('span', null, s.label);
    const input = mk('input', null);
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.setAttribute('data-snd', s.key);
    row.append(cap, input);
    sndTray.append(row);
    soundFields[s.key] = input;
  });

  panes.append(dial, controls, taskline, trays, durTray, sndTray);
  root.textContent = '';
  root.append(panes);

  /* ---------------- small DOM helpers ---------------- */

  function setText(el, s) { const v = s == null ? '' : String(s); if (el.textContent !== v) el.textContent = v; }
  function show(el, on) { if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); }

  /* ---------------- reading the timer ---------------- */

  function phaseDurationMs() {
    const s = store.state.settings;
    if (timer.phase === 'short') return s.short * 60000;
    if (timer.phase === 'long') return s.long * 60000;
    return s.focus * 60000;
  }

  function progressFor(st) {
    if (st === 'growing' || st === 'paused' || st === 'break') return clamp01(timer.progress || 0);
    return 0;
  }

  /* ---------------- painting ---------------- */

  function paintRing(p) {
    if (Math.abs(p - lastRing) < 0.0008) return;
    lastRing = p;
    ringFill.style.strokeDashoffset = String(RING_C * (1 - p));
  }

  function paintFace() {
    paints += 1;
    const st = timer.state;
    const ph = timer.phase;

    let label;
    if (st === 'growing') label = 'Growing';
    else if (st === 'paused') label = 'Held';
    else if (st === 'wilted') label = 'Wilted';
    else if (st === 'break') label = (ph === 'long' ? 'Long rest' : 'Short rest');
    else label = 'Focus';
    setText(phaseEl, label);
    if (phaseEl.getAttribute('data-state') !== st) phaseEl.setAttribute('data-state', st);

    let ms;
    if (st === 'growing' || st === 'paused' || st === 'break') ms = timer.remaining;
    else ms = phaseDurationMs();
    setText(readoutEl, clockText(ms));

    const tree = timer.tree;
    const sp = tree && speciesById[tree.species];
    if (sp) setText(speciesEl, sp.name + ' · ' + sp.latin);
    else if (st === 'break') setText(speciesEl, 'A rest — nothing grows');
    else setText(speciesEl, '');

    if (st === 'paused' && timer.graceLeft > 0) setText(graceEl, 'wilts in ' + clockText(timer.graceLeft));
    else setText(graceEl, '');

    show(bSow, st === 'idle' || st === 'wilted');
    setText(bSow, st === 'wilted' ? 'Sow again' : 'Sow');
    show(bHold, st === 'growing');
    show(bResume, st === 'paused');
    show(bAbandon, st === 'growing' || st === 'paused');
    show(bSkip, st === 'break');
  }

  /* ---------------- controls ---------------- */

  bSow.addEventListener('click', function () {
    if (timer.state === 'idle' || timer.state === 'wilted') timer.beginFocus();
  });
  bHold.addEventListener('click', function () { timer.pause(); });
  bResume.addEventListener('click', function () { timer.resume(); });
  bAbandon.addEventListener('click', function () { timer.abandon(); });
  bSkip.addEventListener('click', function () { timer.skip(); });

  // js/main.js owns view switching. The button borrows its public key behaviour rather than
  // reaching into the manager, so there is still exactly one owner of the view state.
  bView.addEventListener('click', function () {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: false, cancelable: true }));
  });

  function toggleTray(tray, btn) {
    const willOpen = tray.hasAttribute('hidden');
    durTray.setAttribute('hidden', '');
    sndTray.setAttribute('hidden', '');
    bDur.setAttribute('aria-expanded', 'false');
    bSound.setAttribute('aria-expanded', 'false');
    if (willOpen) {
      tray.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
    }
  }
  bDur.addEventListener('click', function () { toggleTray(durTray, bDur); });
  bSound.addEventListener('click', function () { toggleTray(sndTray, bSound); });

  /* ---------------- task line ---------------- */

  function newestOpenTask() {
    const tasks = store.state.tasks || [];
    for (let i = tasks.length - 1; i >= 0; i -= 1) if (!tasks[i].done) return tasks[i];
    return null;
  }

  function renderTask() {
    if (document.activeElement === taskInput) return;
    const t = newestOpenTask();
    const text = t ? t.text : '';
    if (taskInput.value !== text) taskInput.value = text;
  }

  function commitTask() {
    const val = taskInput.value.trim().slice(0, 200);
    if (!val) { renderTask(); return; }
    const t = newestOpenTask();
    if (t) { if (t.text !== val) { t.text = val; ctx.save(); } return; }
    store.state.tasks.push({ id: 'k' + Date.now().toString(36), text: val, done: false, createdAt: Date.now() });
    ctx.save();
  }

  taskInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); commitTask(); }
  });
  taskInput.addEventListener('blur', commitTask);

  /* ---------------- durations + sound ---------------- */

  function syncDurations() {
    const s = store.state.settings;
    DURATIONS.forEach(function (d) { if (durFields[d.key].value !== String(s[d.key])) durFields[d.key].value = String(s[d.key]); });
  }

  durRow.addEventListener('change', function () {
    const patch = {};
    DURATIONS.forEach(function (d) {
      const n = parseInt(durFields[d.key].value, 10);
      if (isFinite(n)) patch[d.key] = n;
    });
    timer.setDurations(patch);
    syncDurations();
  });

  function syncSound() {
    const s = store.state.settings.sound;
    SOUND.forEach(function (k) {
      const v = String(Math.round(clamp01(s[k.key]) * 100));
      if (soundFields[k.key].value !== v) soundFields[k.key].value = v;
    });
  }

  sndTray.addEventListener('input', function (e) {
    const el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-snd')) return;
    const key = el.getAttribute('data-snd');
    const value = clamp01(parseInt(el.value, 10) / 100);
    store.state.settings.sound[key] = value;
    ctx.save();
    bus.emit('settings:changed', { key: 'sound.' + key, value: value });
  });

  /* ---------------- bus ---------------- */

  function repaint() {
    paintRing(progressFor(timer.state));
    paintFace();
    lastSig = faceSignature();
  }

  // Bus handlers paint at once: a control click must show its result even if requestAnimationFrame
  // is throttled (a backgrounded tab), not only on the next frame.
  function dirty() { repaint(); }

  function onSettings(p) {
    dirty();
    if (!p) return;
    if (p.key === 'durations') syncDurations();
    else if (p.key && p.key.indexOf('sound') === 0) syncSound();
  }

  function syncView(p) {
    const v = (p && p.view) || store.state.settings.view;
    setText(bView, v === 'garden' ? 'Forest' : 'Garden');
  }

  const offs = [];
  function sub(type, fn) { const off = bus.on(type, fn); offs.push(typeof off === 'function' ? off : function () { bus.off(type, fn); }); }

  sub('session:tick', dirty);
  sub('session:pause', dirty);
  sub('session:resume', dirty);
  sub('session:wilt', dirty);
  sub('session:harvest', dirty);
  sub('phase:change', dirty);
  sub('forest:changed', dirty);
  sub('settings:changed', onSettings);
  sub('view:changed', syncView);

  /* ---------------- lifecycle ---------------- */

  syncDurations();
  syncSound();
  syncView(null);
  renderTask();
  lastRing = -1;
  paintRing(progressFor(timer.state));
  paintFace();
  lastSig = faceSignature();

  function faceSignature() {
    const st = timer.state;
    const secs = (st === 'growing' || st === 'paused' || st === 'break')
      ? Math.ceil((timer.remaining || 0) / 1000)
      : Math.round(phaseDurationMs() / 1000);
    const tree = timer.tree ? timer.tree.id + '/' + timer.tree.species : '-';
    const grace = st === 'paused' ? Math.ceil((timer.graceLeft || 0) / 1000) : 0;
    return st + '|' + timer.phase + '|' + secs + '|' + tree + '|' + grace;
  }

  return {
    update() {
      updates += 1;
      const st = timer.state;
      paintRing(progressFor(st));
      const sig = faceSignature();
      if (sig !== lastSig) { lastSig = sig; paintFace(); }
    },

    stats() {
      const st = timer.state;
      return {
        mounted: 1,
        state: st,
        phase: timer.phase,
        progress: Math.round(progressFor(st) * 1000) / 1000,
        remainingSec: Math.round((timer.remaining || 0) / 1000),
        durationSec: Math.round(phaseDurationMs() / 1000),
        controls: 5,
        durations: DURATIONS.length,
        sliders: SOUND.length,
        tasks: (store.state.tasks || []).length,
        ring: !!ringFill,
        paints: paints,
        updates: updates
      };
    },

    dispose() {
      for (let i = 0; i < offs.length; i += 1) { try { offs[i](); } catch (err) { /* already gone */ } }
      offs.length = 0;
      root.textContent = '';
    }
  };
}
