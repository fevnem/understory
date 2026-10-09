// Persistence. One localStorage key, one schema (v1 — frozen in docs/CONTRACT.md §6).
// The store never mutates the timer's decision; it only records what the timer reports.

const KEY = 'understory/state/v1';

export function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function freshState() {
  return {
    v: 1,
    settings: {
      focus: 25,
      short: 5,
      long: 15,
      perLong: 4,
      grace: 90,
      sound: { master: 0.6, rain: 0.5, wind: 0.3, thunder: 0.15, bell: 0.35 },
      view: 'forest',
      quality: 'auto',
      theme: 'auto',
      seeded: false
    },
    forest: [],
    days: {},
    tasks: [],
    current: null
  };
}

function num(value, fallback, lo, hi) {
  const n = typeof value === 'number' && isFinite(value) ? value : fallback;
  return Math.min(hi, Math.max(lo, n));
}

// A state file from a future version, or a hand-edited one, must not brick the app.
function sanitise(raw) {
  const base = freshState();
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return base;
  const out = base;

  if (raw.settings && typeof raw.settings === 'object') {
    const s = raw.settings;
    out.settings.focus = num(s.focus, 25, 1, 180);
    out.settings.short = num(s.short, 5, 1, 60);
    out.settings.long = num(s.long, 15, 1, 120);
    out.settings.perLong = num(s.perLong, 4, 2, 8);
    out.settings.grace = num(s.grace, 90, 0, 600);
    if (s.sound && typeof s.sound === 'object') {
      const keys = ['master', 'rain', 'wind', 'thunder', 'bell'];
      for (const k of keys) out.settings.sound[k] = num(s.sound[k], base.settings.sound[k], 0, 1);
    }
    if (s.view === 'garden' || s.view === 'forest') out.settings.view = s.view;
    if (s.quality === 'high' || s.quality === 'low' || s.quality === 'auto') out.settings.quality = s.quality;
    if (s.theme === 'auto' || s.theme === 'dusk' || s.theme === 'night' || s.theme === 'dawn') out.settings.theme = s.theme;
    out.settings.seeded = s.seeded === true;
  }

  if (Array.isArray(raw.forest)) {
    out.forest = raw.forest.filter(function (t) {
      return t && typeof t === 'object' && typeof t.id === 'string' && typeof t.species === 'string';
    }).slice(-4000).map(function (t) {
      return {
        id: String(t.id),
        species: String(t.species),
        plantedAt: num(t.plantedAt, Date.now(), 0, 4102444800000),
        kind: t.kind === 'break' ? 'break' : 'focus',
        minutes: num(t.minutes, 0, 0, 600),
        outcome: ['harvested', 'wilted', 'wild', 'distracted', 'growing'].indexOf(t.outcome) !== -1 ? t.outcome : 'harvested',
        grewAt: num(t.grewAt, t.plantedAt || Date.now(), 0, 4102444800000)
      };
    });
  }

  if (raw.days && typeof raw.days === 'object') {
    for (const k of Object.keys(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const d = raw.days[k] || {};
      out.days[k] = {
        focusMinutes: num(d.focusMinutes, 0, 0, 100000),
        sessions: num(d.sessions, 0, 0, 10000),
        harvested: num(d.harvested, 0, 0, 10000),
        wilted: num(d.wilted, 0, 0, 10000)
      };
    }
  }

  if (Array.isArray(raw.tasks)) {
    out.tasks = raw.tasks.filter(function (t) { return t && typeof t.text === 'string'; })
      .slice(-200)
      .map(function (t) {
        return { id: String(t.id || Math.random().toString(36).slice(2)), text: String(t.text).slice(0, 200), done: t.done === true, createdAt: num(t.createdAt, Date.now(), 0, 4102444800000) };
      });
  }

  if (raw.current && typeof raw.current === 'object' && typeof raw.current.startedAt === 'number') {
    out.current = {
      startedAt: num(raw.current.startedAt, Date.now(), 0, 4102444800000),
      kind: raw.current.kind === 'break' ? 'break' : 'focus',
      species: typeof raw.current.species === 'string' ? raw.current.species : null,
      id: typeof raw.current.id === 'string' ? raw.current.id : null,
      visibleAt: num(raw.current.visibleAt, 0, 0, 4102444800000),
      hiddenMs: num(raw.current.hiddenMs, 0, 0, 86400000)
    };
  }

  return out;
}

export function createStore() {
  const store = {
    state: freshState(),
    available: true,
    lastError: null
  };

  store.load = function load() {
    let raw = null;
    try {
      const text = localStorage.getItem(KEY);
      if (text) raw = JSON.parse(text);
    } catch (err) {
      store.available = false;
      store.lastError = err && err.message;
      raw = null;
    }
    store.state = sanitise(raw);
    return store.state;
  };

  store.save = function save() {
    if (!store.available) return false;
    try {
      localStorage.setItem(KEY, JSON.stringify(store.state));
      return true;
    } catch (err) {
      // Private mode, quota, a hostile browser — the forest keeps running in memory.
      store.lastError = err && err.message;
      return false;
    }
  };

  store.reset = function reset() {
    store.state = freshState();
    store.save();
    return store.state;
  };

  // Everything the UI and the forest need, computed once (docs/CONTRACT.md §6).
  store.derived = function derived() {
    const s = store.state;
    const today = dayKey(Date.now());
    const day = s.days[today] || { focusMinutes: 0, sessions: 0, harvested: 0, wilted: 0 };
    const all = Object.keys(s.days).map(function (k) { return s.days[k]; });
    const allMinutes = all.reduce(function (a, d) { return a + d.focusMinutes; }, 0);
    const allTrees = s.forest.filter(function (t) { return t.outcome !== 'growing'; }).length;

    const speciesCounts = {};
    for (const t of s.forest) {
      if (t.outcome === 'growing') continue;
      speciesCounts[t.species] = (speciesCounts[t.species] || 0) + 1;
    }

    // Streak: consecutive days with real focus time, ending today or yesterday.
    let streak = 0;
    const cursor = new Date(Date.now());
    for (let i = 0; i < 400; i += 1) {
      const k = dayKey(cursor.getTime());
      const d = s.days[k];
      if (d && d.focusMinutes > 0) streak += 1;
      else if (i > 0) break;
      else if (!(s.days[dayKey(cursor.getTime() - 86400000)])) break;
      cursor.setDate(cursor.getDate() - 1);
      if (streak > 0 && !(s.days[dayKey(cursor.getTime())]) && dayKey(cursor.getTime()) !== today) break;
    }

    return {
      today: { date: today, focusMinutes: day.focusMinutes, sessions: day.sessions, harvested: day.harvested, wilted: day.wilted },
      days: s.days,
      allMinutes: Math.round(allMinutes),
      allTrees: allTrees,
      streak: streak,
      speciesCounts: speciesCounts
    };
  };

  return store;
}
