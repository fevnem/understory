// Tiny synchronous event bus. Frozen event names live in docs/CONTRACT.md §4.
// Nothing here knows about the DOM, WebGL or audio.

export function createBus() {
  const map = new Map();
  let depth = 0;

  function on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    let list = map.get(type);
    if (!list) { list = []; map.set(type, list); }
    list.push(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const list = map.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  function emit(type, payload) {
    const list = map.get(type);
    if (!list || !list.length) return;
    // copy so a handler that unsubscribes mid-emit cannot corrupt the walk
    const snapshot = list.slice();
    depth += 1;
    for (let i = 0; i < snapshot.length; i += 1) {
      try {
        snapshot[i](payload);
      } catch (err) {
        // A broken listener must never take the forest down with it.
        console.warn('[understory] listener failed for "' + type + '":', err && err.message);
      }
    }
    depth -= 1;
  }

  return {
    on, off, emit,
    get depth() { return depth; },
    count(type) { const l = map.get(type); return l ? l.length : 0; }
  };
}
