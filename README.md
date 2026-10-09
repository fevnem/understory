# Understory

**Plant a tree, not a timer.**

A study forest. You do not set twenty-five minutes — you sow a tree. It grows in real time
while you work, wilts if you walk away, and takes its place in a forest that accumulates across
days. Rain, wind and light are rendered live, in the page, from nothing.

No build step. No dependencies. No accounts, no tracking, no network requests. Everything runs
in the browser and stays there.

## Running it

```sh
python3 -m http.server 8150
# open http://127.0.0.1:8150/
```

That is the whole install. Any static server works — this is a folder of files.

## The idea

A pomodoro timer asks you to obey a clock. Understory asks you to keep something alive.

| | |
|---|---|
| **Sow** | `space` starts a focus phase and plants a tree of a species chosen from the tree's own id |
| **Pause** | holds the tree; a paused session that stays paused past the grace period wilts it |
| **Abandon** | `a` wilts the tree honestly — the record keeps it, the forest shows the dead one |
| **Harvest** | finishing the phase writes the tree into the forest and the day's minutes into the ledger |
| **Break** | after each focus phase, a short break; every fourth, a long one |
| **Unattended** | a session that ran with the tab hidden is still recorded — marked `wild` or `distracted`, not `harvested` |

Species, days and totals are real state in `localStorage`; the timer is the only thing that
decides whether a tree grew.

## Layout

```
index.html                 shell: canvas, masthead, the two panels, colophon
css/  shell.css            tokens, layout, the CSS-only fallback ambience
      instrument.css       the session instrument            (hand: instrument)
      garden.css           the forest and ledger view        (hand: garden)
js/   main.js              registry, frame loop, keys, theme, view switching
      core/  bus.js        tiny event bus
             store.js      persistence (one schema, sanitised on load)
             timer.js      the pomodoro engine — sow / wilt / harvest / breaks / restore
      gl/    stage.js      WebGL2 spine: mat4, programs, meshes, instancing, layer order, post slot
             forest.js     the wood: terrain, tree rows, the growing tree   (hand: forest)
             weather.js    rain, fog, light shafts, bloom/vignette/grain   (hand: weather)
      audio/ ambience.js   generative soundscape, Web Audio, no audio files (hand: ambience)
      ui/    instrument.js the timer instrument                        (hand: instrument)
             garden.js     days, trees, totals                         (hand: garden)
      content/species.js   the twelve species (frozen vocabulary)
tools/verify.mjs           the gate: real headless Chromium over raw CDP, page + per-module
docs/CONTRACT.md           the frozen interface every module implements
```

## Verifying it

```sh
python3 -m http.server 8150      # in one shell
node tools/verify.mjs            # all checks
node tools/verify.mjs --only weather
```

The gate drives a real headless Chromium and grades the contract, not the source: the pomodoro
engine's phases and outcomes, session restore across a reload, hotkeys, reduced-motion honesty,
zero off-origin requests, byte budgets, no horizontal overflow at four widths, the frame budget,
and each module's own evidence from its live `stats()`.

## Design rules

Zero dependencies, zero build, zero off-origin requests. Escape-then-tag for any text a user
types. Audio only after a real gesture. Reduced motion is honoured rather than overridden. The
interface is quiet on purpose: one accent colour, no gamification, no confetti — the forest is
the feedback.

## Licence

MIT © 2026 Rakib Hasan
