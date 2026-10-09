# Understory — FROZEN CONTRACT (v1)

Read this whole file before writing a line. Everything here is frozen: if your file disagrees
with it, your file is wrong. If you find a place where this contract cannot work, implement the
sensible thing and **report the discrepancy in your summary** — do not silently diverge.

Project: `/home/playground/projects/understory` · served with
`python3 -m http.server 8150 --bind 127.0.0.1` (repo root) · gate: `node tools/verify.mjs`.

---

## 0. What this is, and the tone

A study forest. You do not set 25 minutes — you **plant a tree**. Focus grows it from seed to
canopy in real time; pausing lets it wilt; completing it adds a real tree to a forest that
accumulates across days. Ambience is rain, wind and light, rendered live.

**Tone, non-negotiable:** calm, quiet, precise, adult. No gamification language ("+10 XP",
"streak fire", "congrats!"), no emoji, no exclamation marks. Short declarative labels. The
interface should read at a glance from across a desk, and should feel like an instrument left
running in a dark room, not a dashboard. Prefer space over decoration; fewer words, better
spaced; one accent colour. Anything that would look at home in a productivity SaaS — donuts,
"Focus Mode ON!", toasts — is wrong.

---

## 1. Ownership (one file per hand — never touch a file you do not own)

| Owner | Files |
|---|---|
| **manager** | `index.html`, `js/main.js`, `js/gl/stage.js`, `js/core/{bus,store,timer}.js`, `js/content/species.js`, `css/shell.css`, `tools/verify.mjs`, `docs/CONTRACT.md`, `README.md` |
| hand **forest** | `js/gl/forest.js` |
| hand **weather** | `js/gl/weather.js` |
| hand **ambience** | `js/audio/ambience.js` |
| hand **instrument** | `js/ui/instrument.js`, `css/instrument.css` |
| hand **garden** | `js/ui/garden.js`, `css/garden.css` |

Rules for hands: **do not modify any other file** (not `main.js`, not `index.html`, not
`css/shell.css`, not another hand's file), **do not run any git command**, do not create extra
files (no README, no test file, no assets). If you need the shell to change, put the exact
request in your final summary; the manager does the wiring sweep.

---

## 2. The module interface (frozen — every hand file exports exactly this)

```js
export const meta = { id: 'forest', order: 10, kind: 'gl' }; // id MUST equal your registry id
export function create(ctx) {                                // called once, after DOM + stage ready
  return {
    update(dt, now) {},   // optional: called every animation frame (dt in SECONDS, capped at 0.05)
    resize(w, h, dpr) {}, // optional: called on boot and on every resize
    stats() { return {}; },// REQUIRED: live numbers proving your module is doing work
    dispose() {}          // optional
  };
}
```

* `create(ctx)` must **not** throw when `ctx.gl === null` (no-WebGL2 devices). GL modules then
  return `{ update(){}, stats(){ return { degraded: true }; } }` and add nothing.
* `stats()` is how the manager grades you. It must return real, live values read from your own
  state (counts of trees/drops/nodes, sizes, flags). An empty object fails the gate.
* The registry in `js/main.js` lists every id/path. A missing file is skipped with a warning, so
  landing your file alone is enough to be picked up — **you never edit the registry**.

---

## 3. `ctx` (what `create()` receives)

```js
ctx = {
  canvas,            // <canvas id="gl">
  gl,                // WebGL2RenderingContext or null
  stage,             // js/gl/stage.js instance, or null when gl === null
  timer,             // js/core/timer.js engine (see §5)
  store,             // persistence (see §6); mutate ctx.store.state, then ctx.save()
  bus,               // event emitter (see §4)
  dom: { root, instrument, garden, atmos },   // element handles
  species,           // js/content/species.js list (see §7)
  quality,           // 'high' | 'low'  (low when the device is weak or reduced motion)
  reducedMotion,     // boolean
  viewport: { w, h, dpr },
  save(),            // flush store to localStorage
  log(...args)       // console.info with an '[understory]' prefix — use this, not console.log
}
```

## 4. Bus (frozen event names — nothing else may be emitted)

`ctx.bus.on(type, fn)` / `.off(type, fn)` / `.emit(type, payload)`

| event | payload | emitted by |
|---|---|---|
| `boot` | `{ quality }` | main |
| `session:plant` | `{ tree }` | timer |
| `session:tick` | `{ progress, remaining, phase }` | timer (≈1/s, plus on demand) |
| `session:pause` / `session:resume` | `{ progress }` | timer |
| `session:wilt` | `{ tree, progress }` | timer |
| `session:harvest` | `{ tree, minutes, outcome }` | timer |
| `phase:change` | `{ from, to }` | timer |
| `forest:changed` | `{}` | timer/store after a tree is added or finished |
| `settings:changed` | `{ key, value }` | main |
| `view:changed` | `{ view }` | main (`'forest' | 'garden'`) |
| `pointer` | `{ x, y, nx, ny }` | main (normalised −1..1) |

---

## 5. Timer engine API (`ctx.timer`) — read-only for hands

```js
timer.state        // 'idle' | 'growing' | 'paused' | 'wilted' | 'break'
timer.phase        // 'focus' | 'short' | 'long'
timer.progress     // 0..1 of the current focus/break phase
timer.remaining    // ms left in the phase
timer.duration     // ms of the phase
timer.tree         // current tree or null: { id, species, plantedAt, kind, minutes }
timer.totals       // { todayMinutes, todayTrees, streak, allMinutes, allTrees }
timer.graceLeft    // ms of pause left before the tree wilts (state === 'paused')
```

Hands never mutate the timer. Hands that need to *act* (buttons, keys) call `ctx.timer.start()`,
`.pause()`, `.resume()`, `.abandon()`, `.skip()`. The timer is the only thing that decides
whether a session is harvested or wilted.

## 6. Persistence (`ctx.store`)

```js
store.state = {
  v: 1,
  settings: { focus: 25, short: 5, long: 15, perLong: 4, grace: 90,
              sound: { master: .6, rain: .5, wind: .3, thunder: .15, bell: .35 },
              view: 'forest', quality: 'auto', theme: 'auto', seeded: false },
  forest: [ { id, species, plantedAt, kind, minutes, outcome, grewAt } ], // outcome: harvested|wilted|wild|distracted|growing
  days:   { 'YYYY-MM-DD': { focusMinutes, sessions, harvested, wilted } },
  tasks:  [ { id, text, done, createdAt } ],
  current: null | { tree, startedAt, kind }   // an in-flight session, restored on reload
}
```
`store.derived()` → `{ today, days, streak, allMinutes, allTrees, speciesCounts }` (already
computed; use it instead of recomputing). Mutate `ctx.store.state`, then `ctx.save()`.

## 7. Species (`ctx.species`, from `js/content/species.js`)

```js
{ id: 'birch', name: 'Birch', latin: 'Betula pendula', habit: 'slender',
  hue: 42, height: 1.0, seedShape: 'winged', note: 'Grows fast, bends in wind.' }
```
`hue` is a base hue in degrees; `habit` ∈ `slender | broad | conifer | weeping | columnar |
clumping`; `height` is a relative scale (0.6–1.4). The **forest** hand renders these habits
parametrically; the **garden** hand may use `hue`/`name`/`seedShape` for the collection view.
Species is chosen by the timer (deterministic per tree id) — hands never choose it.

## 8. Stage API (`ctx.stage`, from `js/gl/stage.js`) — frozen

```js
stage.gl, stage.width, stage.height, stage.dpr
stage.camera                  // { pos:[x,y,z], target:[x,y,z], fov, up, view(), proj() }
                              // helpers: stage.camera.orbit(azimuth, elevation, radius, target)
stage.mat4                    // column-major: identity, perspective, lookAt, mul, translate,
                              // rotateX/Y/Z, scale, invert, transformPoint
stage.program(vsSrc, fsSrc)   // -> { prog, use(), u(name, value), a(name, buffer, opts) } cached
stage.quad()                  // fullscreen triangle: { draw(prog) }  (positions in clip space)
stage.buffer(data, opts)      // -> { buf, count, mode }  (Float32Array | Uint16Array)
stage.mesh({ positions, indices })  // -> { vao, count, indexCount, draw(prog) } (static geometry)
stage.instances(mesh, attrs, count) // -> { vao, draw(prog) } attrs: [{ name, data, size, stride, offset }]
stage.layer(name)             // -> { add(obj) } ; obj = { order, draw(frame), visible }
stage.layers                  // ['sky','far','mid','near','rain','fx'] — fixed draw order
stage.onPresent(fn)           // fn(sceneTexture, frame) — final pass; only weather may call this
stage.framebuffer()           // { tex, fbo, w, h } scene target (null when post is disabled)
stage.time                    // seconds since boot
stage.quality                 // 'high' | 'low'
```

**Draw order is fixed and shared.** Put your draw calls in the layer that matches your job:

| layer | contents | owner |
|---|---|---|
| `sky` | gradient sky, sun/moon disc, distant ridges | forest |
| `far` | far tree band, fog banks, light shafts | forest / weather |
| `mid` | main tree rows (instanced), terrain | forest |
| `near` | foreground silhouette, near grass | forest |
| `rain` | rain streaks, splashes, snow/particles | weather |
| `fx` | additive motes, glints (weather's post pass runs after all layers) | weather |

The manager's frame loop: `for layer in stage.layers: sort by order; draw` → then
`present` (weather's post pass if registered, else direct).

**Only the weather hand may call `stage.onPresent`.** If nobody calls it, the stage presents the
scene directly — so absence must not break the page.

## 9. DOM contract (ids/classes are frozen; hands mount INSIDE their own node)

```html
<canvas id="gl" aria-hidden="true">
<div id="atmos" aria-hidden="true">        <!-- CSS-only fallback ambience (manager) -->
<header class="masthead"> … </header>
<main id="ui">
  <section id="instrument" class="panel"></section>   <!-- hand instrument writes here -->
  <aside id="garden" class="panel" hidden></aside>    <!-- hand garden writes here -->
</main>
```

Reserved ids/classes your markup must use, so `css/shell.css` and the harness work:

* instrument: `#instrument`, a single root `.panes`; the ring is `[data-role="ring"]` (inline SVG
  with `<circle class="ring-track">` and `<circle class="ring-fill">`), the readout is
  `[data-role="readout"]` (mm:ss text), the phase label `[data-role="phase"]`, and the controls
  are `<button data-act="sow|pause|resume|abandon|skip|durations|sound|view">`. **The shell
  (`js/main.js`) owns the global hotkeys** — `space` sow / pause-resume (and sow again after a
  wilt), `a` abandon, `s` skip, `g` garden, `m` mute — so your buttons must call the same
  timer methods and must work without any key being pressed. Your controls still get
  `data-act`, and the harness clicks them.
* garden: `#garden`, root `.garden-grid`; each day is `[data-role="day"][data-date="YYYY-MM-DD"]`,
  each tree `[data-role="tree"][data-species="id"]`, totals in `[data-role="total"]`.
* Never use `innerHTML` with anything but strings you built yourself; author/user text (task
  text, notes) goes through `textContent` or `ctx.renderText` — see §10.

## 10. Safety, always

* **Escape-then-tag.** Any text a user can type (task names) is inserted with `textContent`,
  never concatenated into HTML.
* No `eval`, no `new Function`, no remote code, no external requests of any kind: **zero
  off-origin requests** — no CDN, no Google Fonts, no analytics, no images from the network.
  All textures are generated procedurally or inline SVG/data URIs you build yourself.
* No `document.write`. No `alert`. No blocking loops; nothing longer than 4 ms in a frame.
* Audio only after a real user gesture (browser autoplay policy): create/resume `AudioContext`
  in the first `pointerdown`/`keydown` handler, never at import time.

## 11. Aesthetic tokens (declared in `css/shell.css`, use these, never raw hex)

```
--ink, --ink-dim, --paper, --paper-2, --rule, --accent, --accent-dim, --glow,
--font-ui, --font-num, --step-0..--step-5, --space-1..--space-6, --radius,
--dur-fast, --dur-slow, --ease
```
Both themes exist (`html[data-theme="dusk"|"night"|"dawn"]`), and the app must be legible in
all three. Use `color-mix()` for tints; do not invent palette values.

## 12. Budgets (hard failures in the gate)

| Budget | Limit |
|---|---|
| any single `.js` file | ≤ 32 KB |
| `index.html` | ≤ 8 KB |
| all CSS (`css/*.css`) | ≤ 32 KB |
| off-origin requests | 0 |
| `package.json` | must not exist |
| console errors / uncaught exceptions | 0 |
| horizontal overflow at 1440 / 1024 / 900 / 390 | none |
| frame budget (median frame, high quality, idle) | ≤ 24 ms measured over 60 frames |

## 13. Your gate (paste the real output in your summary — the manager re-runs it)

```
node --check <your file>                       # first thing after writing it
node tools/verify.mjs --only <your id>         # your module's check
```

`--only <id>` runs the page checks plus your module's own check (`stats()` non-empty, no console
errors, DOM/audio evidence). Failures naming **another** id are not yours — another hand is
mid-write. Wait 20 s and re-run, up to 5 times; only failures in your own file are yours to fix.

**Write a COMPLETE, working version of your file within your first three tool calls**, then
verify and refine. A killed owner must never leave an empty file.

**Apostrophes:** inside single-quoted JS strings write `’` (U+2019), never `'`. In your prose
strings (`note:`, labels, comments) prefer `’` and en/em dashes over ASCII quotes — the site
reads better and `node --check` stays happy.

## 14. Definition of done for a hand

1. `node --check` clean. 2. `node tools/verify.mjs --only <your id>` → `all checks passed`.
3. `stats()` returns live, honest numbers. 4. No file other than your own touched.
5. Your summary: what you built, the gate output, anything in this contract that was wrong,
   and anything the manager must wire.
