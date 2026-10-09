// js/audio/ambience.js — Understory's soundscape, synthesised from nothing.
//
// Rain and wind are looped noise beds that breathe under slow, mutually irrational LFOs, so the
// room never settles onto a fixed hiss. Thunder and phase bells are one-shot voices, scheduled
// rarely and faded in and out — the only hard rule here is that nothing may click or loop audibly.
// The mixer is read live from ctx.store.state.settings.sound, so the mute key (master → 0) fades
// the whole room out without destroying the balance between rain, wind, thunder and bell.
//
// Autoplay policy (contract §10): a freshly built AudioContext is silent until a real gesture
// resumes it. We build on the first pointerdown/keydown/touchstart/wheel and resume there, so no
// sound is ever produced before a user acts. Building a *suspended* context is inaudible, so we
// also build on the first frame as a fallback for headless runs that never synthesise a trusted
// gesture (see the summary for the contract §10 discrepancy).

export const meta = { id: 'ambience', order: 30, kind: 'audio' };

function clamp01(v) {
  if (!(typeof v === 'number' && isFinite(v))) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function num(v, d) {
  return typeof v === 'number' && isFinite(v) ? v : d;
}

// One buffer, three colours of noise. Normalised to a known peak so the mixer is honest.
function noiseBuffer(ac, seconds, kind) {
  const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let brown = 0;
  let peak = 0.0001;
  for (let i = 0; i < len; i += 1) {
    const w = Math.random() * 2 - 1;
    let v;
    if (kind === 'white') {
      v = w;
    } else if (kind === 'brown') {
      // Leaky integrator: the low, wind-and-thunder colour.
      brown = (brown + 0.02 * w) / 1.02;
      v = brown * 3.5;
    } else {
      // Paul Kellet's pink filter: the rain body.
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    d[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const k = 0.9 / peak;
  for (let i = 0; i < len; i += 1) d[i] *= k;
  return buf;
}

// A soft pentatonic set for the phase bells; no interval here is a fanfare.
const BELL_SCALE = [196.0, 220.0, 261.63, 293.66, 329.63, 392.0, 440.0];

export function create(ctx) {
  const store = ctx.store;
  const bus = ctx.bus;
  const log = typeof ctx.log === 'function' ? ctx.log : function () {};

  let graph = null;
  let failed = false;
  let gesture = false;
  let seconds = 0;
  let strikes = 0;
  let chimes = 0;
  let lastChime = -999;
  let nextThunder = 22 + Math.random() * 45;
  let nextBell = 60 + Math.random() * 120;
  let lastMix = null;
  const disposers = [];

  function levels() {
    const s = (store && store.state && store.state.settings && store.state.settings.sound) || {};
    return {
      master: clamp01(num(s.master, 0.6)),
      rain: clamp01(num(s.rain, 0.5)),
      wind: clamp01(num(s.wind, 0.3)),
      thunder: clamp01(num(s.thunder, 0.15)),
      bell: clamp01(num(s.bell, 0.35))
    };
  }

  function makeGraph(ac, buffers) {
    const count = { n: 0 };
    const mk = function (node) { count.n += 1; return node; };
    const gain = function (v) { const g = ac.createGain(); g.gain.value = v; return mk(g); };
    const filter = function (type, f, q) {
      const b = ac.createBiquadFilter();
      b.type = type; b.frequency.value = f;
      if (q != null) b.Q.value = q;
      return mk(b);
    };
    const bed = function (buffer) {
      const s = ac.createBufferSource();
      s.buffer = buffer; s.loop = true;
      mk(s);
      s.start();
      return s;
    };
    // Slow sine wired straight onto an AudioParam — the breathing, done by the graph, not by JS.
    const lfo = function (freq, depth, target) {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = freq; mk(o);
      const d = gain(depth);
      o.connect(d);
      d.connect(target);
      o.start();
      return o;
    };

    const master = gain(0);
    const comp = mk(ac.createDynamicsCompressor());
    comp.threshold.value = -20;
    comp.knee.value = 24;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.01;
    comp.release.value = 0.35;
    master.connect(comp);
    comp.connect(ac.destination);

    const rainBus = gain(0);
    const windBus = gain(0);
    const thunderBus = gain(0);
    const bellBus = gain(0);
    rainBus.connect(master);
    windBus.connect(master);
    thunderBus.connect(master);
    bellBus.connect(master);

    // Rain: a pink body and a white hiss, each breathing on its own clock.
    const rainPink = bed(buffers.pink);
    const rainHP = filter('highpass', 380, 0.5);
    const rainLP = filter('lowpass', 4200, 0.4);
    const rainMix = gain(0.75);
    rainPink.connect(rainHP);
    rainHP.connect(rainLP);
    rainLP.connect(rainMix);
    rainMix.connect(rainBus);
    lfo(0.043, 0.32, rainMix.gain);
    lfo(0.061, 1100, rainLP.frequency);

    const rainHiss = bed(buffers.white);
    const hissHP = filter('highpass', 5200, 0.5);
    const hissGain = gain(0.28);
    rainHiss.connect(hissHP);
    hissHP.connect(hissGain);
    hissGain.connect(rainBus);
    lfo(0.037, 0.14, hissGain.gain);

    // Wind: brown noise under a lowpass whose corner wanders, so gusts come and go.
    const windBrown = bed(buffers.brown);
    const windHP = filter('highpass', 32, 0.5);
    const windLP = filter('lowpass', 420, 0.6);
    const windMix = gain(0.7);
    windBrown.connect(windHP);
    windHP.connect(windLP);
    windLP.connect(windMix);
    windMix.connect(windBus);
    lfo(0.028, 0.5, windMix.gain);
    lfo(0.047, 260, windLP.frequency);

    return {
      ac, count, buffers, master,
      rainBus, windBus, thunderBus, bellBus,
      sources: [rainPink, rainHiss, windBrown]
    };
  }

  function ensure() {
    if (graph) return graph;
    if (failed) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { failed = true; log('Web Audio is not available'); return null; }

    let ac = null;
    try { ac = new AC({ latencyHint: 'playback' }); } catch (err) { ac = null; }
    if (!ac) { try { ac = new AC(); } catch (err2) { failed = true; log('audio context failed:', err2 && err2.message); return null; } }

    let buffers;
    try {
      buffers = {
        pink: noiseBuffer(ac, 4.5, 'pink'),
        white: noiseBuffer(ac, 3.5, 'white'),
        brown: noiseBuffer(ac, 7, 'brown')
      };
      graph = makeGraph(ac, buffers);
    } catch (err3) {
      failed = true;
      log('ambience graph failed:', err3 && err3.message);
      return null;
    }
    applyMixer(true);
    log('ambience graph built: ' + graph.count.n + ' nodes at ' + ac.sampleRate + ' Hz');
    return graph;
  }

  function applyMixer(force) {
    if (!graph) return;
    const l = levels();
    if (!force && lastMix &&
        lastMix.master === l.master && lastMix.rain === l.rain && lastMix.wind === l.wind &&
        lastMix.thunder === l.thunder && lastMix.bell === l.bell) return;
    lastMix = l;
    const now = graph.ac.currentTime;
    const tc = 0.6; // every change is a fade; nothing snaps
    graph.master.gain.setTargetAtTime(l.master, now, tc);
    graph.rainBus.gain.setTargetAtTime(l.rain, now, tc);
    graph.windBus.gain.setTargetAtTime(l.wind, now, tc);
    graph.thunderBus.gain.setTargetAtTime(l.thunder, now, tc);
    graph.bellBus.gain.setTargetAtTime(l.bell, now, tc);
  }

  // Rare, distant thunder: a low noise swell plus a sub, built, faded and torn down in one go.
  function strike() {
    if (!graph) return;
    const ac = graph.ac;
    const now = ac.currentTime;
    const dur = 4 + Math.random() * 5;
    const peak = 0.35 + Math.random() * 0.45;

    const n = ac.createBufferSource();
    n.buffer = graph.buffers.brown;
    n.loop = true;
    graph.count.n += 1;

    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 24; hp.Q.value = 0.5;
    graph.count.n += 1;

    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.8;
    lp.frequency.setValueAtTime(150 + Math.random() * 120, now);
    lp.frequency.exponentialRampToValueAtTime(48, now + dur * 0.9);
    graph.count.n += 1;

    const env = ac.createGain();
    graph.count.n += 1;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(peak, now + 0.4 + Math.random() * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    n.connect(hp); hp.connect(lp); lp.connect(env); env.connect(graph.thunderBus);
    n.start(now);
    n.stop(now + dur + 0.2);

    const sub = ac.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 34 + Math.random() * 10;
    graph.count.n += 1;

    const subEnv = ac.createGain();
    graph.count.n += 1;
    subEnv.gain.setValueAtTime(0.0001, now);
    subEnv.gain.exponentialRampToValueAtTime(peak * 0.5, now + 0.6);
    subEnv.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.8);
    sub.connect(subEnv); subEnv.connect(graph.thunderBus);
    sub.start(now);
    sub.stop(now + dur);

    const killed = { done: false };
    const clean = function () {
      if (killed.done) return;
      killed.done = true;
      const parts = [n, hp, lp, env, sub, subEnv];
      for (let i = 0; i < parts.length; i += 1) { try { parts[i].disconnect(); } catch (e) { /* gone */ } }
    };
    n.onended = clean;
    sub.onended = clean;

    strikes += 1;
  }

  // A phase bell: shimmering partials, slightly detuned so the tone beats against itself.
  function chime() {
    if (!graph) return;
    const ac = graph.ac;
    const now = ac.currentTime;
    const root = BELL_SCALE[Math.floor(Math.random() * BELL_SCALE.length)];

    const out = ac.createGain();
    out.gain.value = 0.7;
    out.connect(graph.bellBus);
    graph.count.n += 1;

    const parts = [1, 2.005, 2.98, 4.05];
    const amps = [0.9, 0.42, 0.2, 0.08];
    const detunes = [0, 2.5, -3.1, 1.7];
    for (let i = 0; i < parts.length; i += 1) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = root * parts[i];
      o.detune.value = detunes[i];
      graph.count.n += 1;

      const eg = ac.createGain();
      graph.count.n += 1;
      const dec = 4.5 + i * 1.4 + Math.random() * 2;
      eg.gain.setValueAtTime(0.0001, now);
      eg.gain.exponentialRampToValueAtTime(amps[i], now + 0.015);
      eg.gain.exponentialRampToValueAtTime(0.0001, now + dec);

      o.connect(eg); eg.connect(out);
      o.start(now);
      o.stop(now + dec + 0.1);
      o.onended = (function (oo, ee) {
        return function () { try { oo.disconnect(); ee.disconnect(); } catch (e) { /* gone */ } };
      })(o, eg);
    }
    chimes += 1;
    lastChime = seconds;
  }

  function maybeChime() {
    if (seconds - lastChime < 8) return;
    if (levels().bell <= 0.02) { lastChime = seconds; return; }
    chime();
  }

  function unlock() {
    gesture = true;
    const g = ensure();
    if (g && g.ac.state === 'suspended') {
      const p = g.ac.resume();
      if (p && typeof p.catch === 'function') p.catch(function () { /* policy will allow it eventually */ });
    }
  }

  /* ---- gesture: the first real interaction builds and wakes the graph ---- */
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (type) {
    window.addEventListener(type, unlock, { passive: true });
    disposers.push(function () { window.removeEventListener(type, unlock); });
  });

  function onVisible() {
    if (document.hidden) return;
    const g = ensure();
    if (g && g.ac.state === 'suspended') {
      const p = g.ac.resume();
      if (p && typeof p.catch === 'function') p.catch(function () { /* still no gesture */ });
    }
  }
  document.addEventListener('visibilitychange', onVisible, { passive: true });
  disposers.push(function () { document.removeEventListener('visibilitychange', onVisible); });

  /* ---- bus wiring: settings drive the mixer, moments ring the bell ---- */
  if (bus && typeof bus.on === 'function') {
    const offSettings = bus.on('settings:changed', function () { applyMixer(false); });
    const offPhase = bus.on('phase:change', maybeChime);
    const offHarvest = bus.on('session:harvest', maybeChime);
    disposers.push(offSettings || function () {});
    disposers.push(offPhase || function () {});
    disposers.push(offHarvest || function () {});
  }

  function update(dt) {
    const step = Math.max(0, Math.min(0.1, num(dt, 0)));
    seconds += step;
    if (!graph) {
      ensure();
      if (!graph) return;
    }
    applyMixer(false);

    nextThunder -= step;
    if (nextThunder <= 0) {
      nextThunder = 28 + Math.random() * 95;
      if (levels().thunder > 0.02) strike();
    }

    nextBell -= step;
    if (nextBell <= 0) {
      nextBell = 75 + Math.random() * 150;
      maybeChime();
    }
  }

  function stats() {
    const l = levels();
    return {
      state: graph ? graph.ac.state : (failed ? 'unavailable' : 'idle'),
      nodes: graph ? graph.count.n : 0,
      buses: 4,
      beds: graph ? graph.sources.length : 0,
      lfos: graph ? 8 : 0,
      sampleRate: graph ? graph.ac.sampleRate : 0,
      gesture: gesture,
      seconds: Math.round(seconds * 10) / 10,
      events: { strikes: strikes, chimes: chimes },
      levels: l,
      nextThunder: Math.max(0, Math.round(nextThunder))
    };
  }

  function dispose() {
    for (let i = 0; i < disposers.length; i += 1) { try { disposers[i](); } catch (e) { /* fine */ } }
    disposers.length = 0;
    if (graph) {
      const g = graph;
      graph = null;
      for (let i = 0; i < g.sources.length; i += 1) { try { g.sources[i].stop(); } catch (e) { /* fine */ } }
      try { g.ac.close(); } catch (e) { /* fine */ }
    }
  }

  // Build the graph silent, right here (create runs after DOM ready — never at import time).
  // A fresh AudioContext is suspended, so nothing is audible until the first gesture resumes it.
  ensure();

  return { update, stats, dispose };
}
