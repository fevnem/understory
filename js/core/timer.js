// The pomodoro engine. It owns exactly one decision: did this session grow a tree or wilt one.
// Hands read timer.state/progress and act through start/pause/resume/abandon/skip.
// Events emitted are frozen in docs/CONTRACT.md §5.

import { dayKey } from './store.js';

const TICK_MS = 250;

function rand(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function next() {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  };
}

export function createTimer({ store, bus, species, now }) {
  const clock = typeof now === 'function' ? now : function () { return Date.now(); };

  const timer = {
    state: 'idle',
    phase: 'focus',
    progress: 0,
    remaining: 0,
    duration: 0,
    tree: null,
    graceLeft: 0,
    totals: null,
    completedFocus: 0,
    /** set true while the tab is hidden; a session that runs hidden is still honest, but flagged */
    hiddenMs: 0
  };

  let phaseEndsAt = 0;
  let phaseStartedAt = 0;
  let pausedAt = 0;
  let pausedTotal = 0;
  let lastTick = 0;
  let hiddenSince = 0;

  function settings() { return store.state.settings; }

  function phaseMs(phase) {
    const s = settings();
    if (phase === 'short') return s.short * 60000;
    if (phase === 'long') return s.long * 60000;
    return s.focus * 60000;
  }

  function pickSpecies(id) {
    const r = rand(id);
    const list = species && species.length ? species : [{ id: 'pine', height: 1, hue: 150 }];
    // Weighted lightly toward the shorter species so a young forest does not look uniform.
    const idx = Math.floor(r() * r() * list.length);
    return list[Math.min(list.length - 1, idx)].id;
  }

  function newId() {
    return 't' + clock().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
  }

  function today() {
    const k = dayKey(clock());
    const s = store.state.days;
    if (!s[k]) s[k] = { focusMinutes: 0, sessions: 0, harvested: 0, wilted: 0 };
    return s[k];
  }

  function totals() {
    const d = store.derived();
    timer.totals = {
      todayMinutes: d.today.focusMinutes,
      todayTrees: d.today.harvested,
      streak: d.streak,
      allMinutes: d.allMinutes,
      allTrees: d.allTrees
    };
    return timer.totals;
  }

  function persistCurrent() {
    if (timer.state === 'growing' || timer.state === 'paused') {
      store.state.current = {
        startedAt: phaseStartedAt,
        kind: timer.phase === 'focus' ? 'focus' : 'break',
        species: timer.tree ? timer.tree.species : null,
        id: timer.tree ? timer.tree.id : null,
        visibleAt: lastTick,
        hiddenMs: timer.hiddenMs
      };
    } else {
      store.state.current = null;
    }
  }

  function recordTree(tree, outcome, minutes) {
    const s = store.state;
    tree.outcome = outcome;
    tree.minutes = Math.round(minutes * 100) / 100;
    tree.grewAt = clock();
    const existing = s.forest.findIndex(function (t) { return t.id === tree.id; });
    if (existing !== -1) s.forest[existing] = tree; else s.forest.push(tree);

    const d = today();
    if (tree.kind === 'focus') {
      d.sessions += 1;
      if (outcome === 'harvested' || outcome === 'wild' || outcome === 'distracted') {
        d.focusMinutes = Math.round((d.focusMinutes + tree.minutes) * 100) / 100;
        d.harvested += 1;
      } else {
        d.wilted += 1;
      }
    }
    return tree;
  }

  function plant(kind) {
    const id = newId();
    timer.tree = {
      id,
      species: pickSpecies(id),
      plantedAt: clock(),
      kind,
      minutes: 0,
      outcome: 'growing',
      grewAt: 0
    };
    store.state.forest.push(timer.tree);
    bus.emit('session:plant', { tree: timer.tree });
    return timer.tree;
  }

  function enterPhase(phase) {
    const from = timer.phase;
    timer.phase = phase;
    timer.duration = phaseMs(phase);
    phaseStartedAt = clock();
    phaseEndsAt = phaseStartedAt + timer.duration;
    pausedTotal = 0;
    timer.hiddenMs = 0;
    timer.progress = 0;
    timer.remaining = timer.duration;
    if (phase === 'focus') {
      timer.state = 'growing';
      plant('focus');
    } else {
      timer.state = 'break';
      timer.tree = null;
    }
    if (from !== phase) bus.emit('phase:change', { from, to: phase });
    persistCurrent();
    bus.emit('session:tick', { progress: 0, remaining: timer.remaining, phase: timer.phase });
  }

  /** Sow a tree and begin a focus phase, or begin a break if the focus count says so. */
  timer.start = function start() {
    if (timer.state === 'growing' || timer.state === 'paused' || timer.state === 'break') return false;
    timer.completedFocus += 1;
    const s = settings();
    const long = s.perLong > 0 && timer.completedFocus % s.perLong === 0;
    enterPhase(long ? 'long' : 'short');
    return true;
  };

  timer.beginFocus = function beginFocus() {
    timer.state = 'idle';
    enterPhase('focus');
    return true;
  };

  timer.pause = function pause() {
    if (timer.state !== 'growing') return false;
    timer.state = 'paused';
    pausedAt = clock();
    // computed here too: the UI reads graceLeft the instant the tap lands
    timer.graceLeft = settings().grace * 1000;
    persistCurrent();
    bus.emit('session:pause', { progress: timer.progress });
    return true;
  };

  timer.resume = function resume() {
    if (timer.state !== 'paused') return false;
    const held = clock() - pausedAt;
    pausedTotal += held;
    phaseEndsAt += held;
    pausedAt = 0;
    timer.state = 'growing';
    persistCurrent();
    bus.emit('session:resume', { progress: timer.progress });
    return true;
  };

  /** Give up on the current phase. Focus wilts the tree; a break simply ends. */
  timer.abandon = function abandon() {
    if (timer.state === 'growing' || timer.state === 'paused') {
      timer.state = 'wilted';
      const tree = timer.tree;
      if (tree) recordTree(tree, 'wilted', elapsedFocusMinutes());
      timer.tree = null;
      store.state.current = null;
      bus.emit('session:wilt', { tree, progress: timer.progress });
      bus.emit('forest:changed', {});
      store.save();
      return true;
    }
    if (timer.state === 'break') {
      timer.state = 'idle';
      timer.progress = 0;
      timer.remaining = 0;
      timer.phase = 'focus';
      return true;
    }
    return false;
  };

  timer.skip = function skip() {
    if (timer.state === 'break') return timer.abandon();
    if (timer.state === 'growing' || timer.state === 'paused') {
      // Skipping a focus phase is abandoning it — honesty is the whole point.
      return timer.abandon();
    }
    return false;
  };

  function elapsedFocusMinutes() {
    if (timer.phase !== 'focus') return 0;
    const elapsed = Math.max(0, clock() - phaseStartedAt - pausedTotal);
    return Math.min(settings().focus, elapsed / 60000);
  }

  function completePhase() {
    if (timer.phase === 'focus') {
      const tree = timer.tree;
      const minutes = settings().focus;
      // Unattended growth is still growth, but it is not the same tree as a watched one.
      const outcome = timer.hiddenMs > 90000 ? 'distracted' : (timer.hiddenMs > 20000 ? 'wild' : 'harvested');
      if (tree) recordTree(tree, outcome, minutes);
      timer.state = 'idle';
      timer.tree = null;
      store.state.current = null;
      bus.emit('session:harvest', { tree, minutes, outcome });
      bus.emit('forest:changed', {});
      store.save();
    } else {
      const from = timer.phase;
      timer.phase = 'focus';
      timer.state = 'idle';
      bus.emit('phase:change', { from, to: 'focus' });
    }
    timer.progress = 1;
    timer.remaining = 0;
    totals();
    bus.emit('session:tick', { progress: 1, remaining: 0, phase: timer.phase });
    persistCurrent();
  }

  /** Called by the frame loop. Cheap: ticks four times a second, not sixty. */
  timer.update = function update() {
    const t = clock();
    if (t - lastTick < TICK_MS) return;
    lastTick = t;

    if (timer.state === 'paused') {
      const grace = settings().grace * 1000;
      timer.graceLeft = grace === 0 ? 0 : Math.max(0, grace - (t - pausedAt));
      if (grace > 0 && timer.graceLeft === 0) timer.abandon();
      return;
    }

    if (timer.state === 'growing' || timer.state === 'break') {
      const nowProgress = Math.min(1, Math.max(0, (t - phaseStartedAt - pausedTotal) / Math.max(1, timer.duration)));
      timer.progress = nowProgress;
      timer.remaining = Math.max(0, phaseEndsAt - t);
      if (timer.state === 'growing' && timer.tree) timer.tree.minutes = elapsedFocusMinutes();
      bus.emit('session:tick', { progress: nowProgress, remaining: timer.remaining, phase: timer.phase });
      if (nowProgress >= 1) completePhase();
    }
  };

  /** Hide/show honesty: time spent with the tab hidden during a session is remembered. */
  timer.noteHidden = function noteHidden(ms) {
    if (timer.state === 'growing') timer.hiddenMs += Math.max(0, ms);
  };

  /** Restore an in-flight session after a reload (docs/CONTRACT.md §6, store.state.current). */
  timer.restore = function restore() {
    const cur = store.state.current;
    if (!cur || !cur.startedAt) return false;
    const elapsed = clock() - cur.startedAt;
    const trees = store.state.forest;
    const tree = cur.id ? trees.find(function (x) { return x.id === cur.id; }) : null;

    if (elapsed >= phaseMs(cur.kind === 'break' ? 'short' : 'focus')) {
      // The session finished while the page was closed: record the tree honestly and stay idle.
      if (tree) { recordTree(tree, 'wild', settings().focus); bus.emit('session:harvest', { tree, minutes: settings().focus, outcome: 'wild' }); }
      store.state.current = null;
      store.save();
      totals();
      bus.emit('forest:changed', {});
      return false;
    }

    if (cur.kind === 'break') {
      timer.state = 'idle';
      timer.phase = 'focus';
      store.state.current = null;
      store.save();
      return false;
    }

    timer.phase = 'focus';
    timer.state = 'growing';
    phaseStartedAt = cur.startedAt;
    phaseEndsAt = cur.startedAt + phaseMs('focus');
    pausedTotal = 0;
    timer.tree = tree || plant('focus');
    timer.hiddenMs = cur.hiddenMs || 0;
    timer.duration = phaseMs('focus');
    const p = Math.min(1, elapsed / timer.duration);
    timer.progress = p;
    timer.remaining = Math.max(0, timer.duration - elapsed);
    bus.emit('session:tick', { progress: p, remaining: timer.remaining, phase: 'focus' });
    return true;
  };

  timer.setDurations = function setDurations(patch) {
    const s = settings();
    if (typeof patch.focus === 'number') s.focus = Math.min(180, Math.max(1, Math.round(patch.focus)));
    if (typeof patch.short === 'number') s.short = Math.min(60, Math.max(1, Math.round(patch.short)));
    if (typeof patch.long === 'number') s.long = Math.min(120, Math.max(1, Math.round(patch.long)));
    if (typeof patch.perLong === 'number') s.perLong = Math.min(8, Math.max(2, Math.round(patch.perLong)));
    store.save();
    bus.emit('settings:changed', { key: 'durations', value: s });
    if (timer.state === 'growing' || timer.state === 'break') {
      timer.duration = phaseMs(timer.phase);
      phaseEndsAt = phaseStartedAt + timer.duration + pausedTotal;
    } else if (timer.state === 'idle') {
      timer.duration = phaseMs('focus');
      timer.remaining = timer.duration;
      timer.progress = 0;
    }
    return true;
  };

  totals();
  return timer;
}
