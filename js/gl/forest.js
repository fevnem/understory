// js/gl/forest.js — the scene: an illustrated, layered silhouette landscape rather than 3D.
// A gradient sky, two hazy ridges, a dense treeline, the hill we stand on, the wood, a framing
// foreground, and the tree that is growing right now.
//
// Layers: 'sky' (gradient + light + stars), 'far' (ridges, treeline), 'mid' (hill, then the wood),
// 'near' (framing foliage, then the specimen).
//
// Everything is flat 2D geometry in normalised space (x, y in -1..1, y up). Depth comes from
// stacking: each layer sits a little lower, darker and crisper than the one behind it, and the
// haze mix on each band is what makes it recede.

import { speciesFor } from '../content/species.js';
import {
  hash, hsl2rgb, mix3, ridgeProfile, treelineProfile, bandMesh, treeMesh, sproutMesh, frameMesh
} from './shapes.js';

/* ------------------------------------------------------------------ shaders */

const SKY_VS = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform vec3 u_top, u_horizon, u_ground, u_glow;
uniform vec2 u_sun;
uniform float u_aspect, u_stars, u_time;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float y = v_uv.y;
  // the horizon sits at the ridge line, so the bright band is in the sky rather than buried
  // behind the hills where nothing can see it
  float hz = 0.62;
  vec3 sky = mix(u_horizon, u_top, pow(clamp((y - hz) / (1.0 - hz), 0.0, 1.0), 0.55));
  // below the horizon, a quick fall to the dark ground tone
  vec3 col = mix(u_ground, sky, smoothstep(hz - 0.10, hz + 0.01, y));

  // the light everything else is a silhouette against
  vec2 d = (v_uv - u_sun) * vec2(u_aspect * 0.85, 1.0);
  col += u_glow * exp(-pow(length(d) * 1.9, 2.0)) * 0.5;
  col += u_glow * exp(-pow(length(d) * 0.9, 2.0)) * 0.16;

  // stars, night only, and never inside the glow
  vec2 g = floor(v_uv * vec2(240.0 * u_aspect, 240.0));
  float s = h21(g);
  float twinkle = 0.6 + 0.4 * sin(u_time * 1.3 + s * 40.0);
  col += vec3(0.72, 0.78, 0.92) * step(0.9962, s) * twinkle * u_stars
    * smoothstep(hz + 0.02, 0.8, y) * (1.0 - exp(-pow(length(d) * 2.4, 2.0)));

  // two very soft cloud bands so the sky is not a bare gradient
  float band = smoothstep(0.5, 0.95, sin(v_uv.x * 2.1 + u_time * 0.01) * 0.5 + 0.5);
  col += u_glow * band * smoothstep(hz + 0.08, hz + 0.3, y) * (1.0 - smoothstep(hz + 0.34, hz + 0.6, y)) * 0.05;

  fragColor = vec4(col, 1.0);
}`;

const BAND_VS = `#version 300 es
layout(location = 0) in vec3 a_position;
uniform float u_aspect;
uniform vec2 u_drift;
out float v_y;
void main() {
  vec2 p = a_position.xy;
  p.x *= u_aspect / 1.7778;
  p += u_drift;
  v_y = p.y;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const BAND_FS = `#version 300 es
precision highp float;
in float v_y;
out vec4 fragColor;
uniform vec3 u_top, u_bottom;
uniform float u_yTop, u_yBottom, u_lines;
void main() {
  float t = clamp((v_y - u_yBottom) / max(0.001, u_yTop - u_yBottom), 0.0, 1.0);
  vec3 col = mix(u_bottom, u_top, t);
  // A ground plane is only a plane if it shows perspective: contour lines that compress as they
  // recede do more for depth than any amount of flat gradient.
  if (u_lines > 0.0) {
    float f = 16.0 + 150.0 * pow(t, 2.2);
    col *= 1.0 + 0.10 * sin(v_y * f) * (0.35 + 0.65 * t);
  }
  fragColor = vec4(col, 1.0);
}`;

const TREE_VS = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 3) in vec2 a_iPos;
layout(location = 4) in vec2 a_iScale;
layout(location = 5) in float a_iRot;
layout(location = 6) in vec3 a_iColor;
layout(location = 7) in float a_iSway;
uniform float u_aspect, u_time, u_wind;
out vec3 v_color;
out float v_shade;
void main() {
  vec2 local = a_position.xy * a_iScale;
  // only the top moves; the base stays planted
  local.x += sin(u_time * 0.55 + a_iPos.x * 4.1 + a_iPos.y * 2.7) * a_iSway * a_position.y * (0.014 + u_wind * 0.02);
  float c = cos(a_iRot), s = sin(a_iRot);
  vec2 r = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 world = a_iPos + r;
  world.x *= u_aspect / 1.7778;
  v_color = a_iColor;
  // which side of the shape faces the light — one flat colour per tree reads as clipart
  v_shade = clamp(a_position.x * 2.2, -1.0, 1.0);
  gl_Position = vec4(world, 0.0, 1.0);
}`;

const TREE_FS = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_shade;
out vec4 fragColor;
void main() { fragColor = vec4(v_color * (1.0 + 0.18 * max(v_shade, -0.6)), 1.0); }`;

/* ------------------------------------------------------------------ module */

export const meta = { id: 'forest', order: 10, kind: 'gl' };

export function create(ctx) {
  const stage = ctx.stage;
  if (!ctx.gl || !stage) {
    return { update() {}, stats() { return { degraded: true, trees: 0, species: 0, draws: 0 }; } };
  }
  const gl = ctx.gl;
  const reduced = ctx.reducedMotion;

  /* ---- palette ----
     A silhouette scene lives or dies on its tonal ladder: the sky has to be bright enough to
     hold a dark shape against it, and each layer has to step down cleanly in front of the last.
     These are chosen by hand per theme; deriving them from the CSS tokens produced a muddy,
     nearly all-black scene. */

  function readTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'night' || t === 'dawn' ? t : 'dusk';
  }

  const PALETTES = {
    dusk: {
      top: [0.07, 0.1, 0.18], horizon: [0.96, 0.72, 0.5], ground: [0.09, 0.09, 0.13],
      glow: [1, 0.78, 0.5], star: 0.1, sun: [0.68, 0.66],
      far: [0.3, 0.27, 0.29], mid: [0.21, 0.2, 0.22], line: [0.16, 0.16, 0.18], hill: [0.05, 0.055, 0.07],
      gtop: [0.4, 0.36, 0.34], gbot: [0.03, 0.035, 0.05]
    },
    night: {
      top: [0.03, 0.045, 0.09], horizon: [0.38, 0.46, 0.64], ground: [0.04, 0.05, 0.09],
      glow: [0.66, 0.76, 0.96], star: 0.9, sun: [0.74, 0.72],
      far: [0.2, 0.24, 0.32], mid: [0.13, 0.15, 0.21], line: [0.095, 0.11, 0.155], hill: [0.04, 0.05, 0.08],
      gtop: [0.21, 0.24, 0.31], gbot: [0.022, 0.03, 0.05]
    },
    dawn: {
      top: [0.6, 0.7, 0.82], horizon: [1, 0.9, 0.75], ground: [0.55, 0.57, 0.6],
      glow: [1, 0.93, 0.8], star: 0, sun: [0.66, 0.68],
      far: [0.62, 0.66, 0.72], mid: [0.47, 0.51, 0.58], line: [0.36, 0.4, 0.47], hill: [0.16, 0.18, 0.22],
      gtop: [0.62, 0.63, 0.66], gbot: [0.11, 0.13, 0.17]
    }
  };

  let theme = readTheme();
  const pal = function () { return PALETTES[theme] || PALETTES.dusk; };

  /**
   * The tonal ladder, back to front: sky brightest, then each layer a clear step darker, with the
   * hill we stand on the darkest thing in the frame. Silhouettes only read if that order holds —
   * a ridge lighter than the sky above it turns the whole scene to mush.
   */
  function ladder() {
    const p = pal();
    return {
      far: p.far, mid: p.mid, line: p.line, hill: p.hill,
      // the framing foliage is the nearest thing to the camera, but pure black reads as a hole in
      // the screen rather than as a plant — keep a trace of the layer behind it
      frame: mix3(p.line, [0, 0, 0], 0.5)
    };
  }

  /** A band's gradient: the ladder colour at the top edge, darker below, thinned by atmosphere. */
  function bandColor(base, hazeAmt) {
    const hz = pal().horizon;
    return {
      top: mix3(base, hz, hazeAmt),
      bottom: mix3(mix3(base, [0, 0, 0], 0.32), hz, hazeAmt * 0.5)
    };
  }

  /* ---- sky ---- */

  const skyProg = stage.program(SKY_VS, SKY_FS);
  const fullQuad = stage.quad();

  /* ---- the landscape ---- */

  const bandProg = stage.program(BAND_VS, BAND_FS);
  const hillProfile = ridgeProfile('hill', -0.2, 0.055, 0.7);

  // The ground line every tree is planted on, in one place so the hill and the wood agree.
  const groundAt = function (x) { return hillProfile(x); };

  const bands = [
    {
      layer: 'far', order: 0, role: 'far', hazeAmt: 0.3, yTop: 0.44, yBottom: -1.5, amp: 0.014, phase: 0.4,
      mesh: stage.mesh(bandMesh(ridgeProfile('far', 0.25, 0.13, 1.1), { segs: 90 }))
    },
    {
      layer: 'far', order: 1, role: 'mid', hazeAmt: 0.2, yTop: 0.34, yBottom: -1.5, amp: 0.011, phase: 1.9,
      mesh: stage.mesh(bandMesh(ridgeProfile('mid', 0.15, 0.11, 1.4), { segs: 100 }))
    },
    {
      layer: 'far', order: 2, role: 'line', hazeAmt: 0.1, yTop: 0.2, yBottom: -1.5, amp: 0.007, phase: 3.1,
      mesh: stage.mesh(bandMesh(treelineProfile('line', 0.02, 0.075), { segs: 190 }))
    },
    {
      layer: 'mid', order: 0, role: 'ground', hazeAmt: 0, yTop: -0.14, yBottom: -1.5, amp: 0.004, phase: 5.2,
      mesh: stage.mesh(bandMesh(groundAt, { segs: 110 }))
    }
  ];

  /* ---- the wood ---- */

  const treeProg = stage.program(TREE_VS, TREE_FS);
  const HABITS = ['broad', 'slender', 'conifer', 'weeping', 'columnar', 'clumping'];
  const KIND_MESH = {};
  HABITS.forEach(function (habit) { KIND_MESH[habit] = stage.mesh(treeMesh(habit, 7)); });
  const sprout = stage.mesh(sproutMesh());
  const frames = [stage.mesh(frameMesh('l', -1)), stage.mesh(frameMesh('r', 1))];

  // Three depth rows. Depth here is scale + how much atmosphere sits in front of it; every base
  // stays on the ground line so nothing floats.
  const ROWS = [
    { y: 0.0, scale: 0.155, haze: 0.3, lum: 0.13, count: 17 },
    { y: -0.035, scale: 0.25, haze: 0.14, lum: 0.1, count: 13 },
    { y: -0.075, scale: 0.36, haze: 0.03, lum: 0.08, count: 9 }
  ];

  function buildWood() {
    const rnd = hash('wood');
    const finished = ctx.store.state.forest.filter(function (t) { return t.outcome !== 'growing'; });
    const groups = [];
    ROWS.forEach(function (row, ri) {
      const list = [];
      const n = ctx.quality === 'low' ? Math.round(row.count * 0.6) : row.count;
      for (let i = 0; i < n; i += 1) {
        const x = -1.28 + (i + 0.15 + rnd() * 0.7) * (2.56 / n);
        const fromStore = finished.length ? finished[(ri * 5 + i) % finished.length] : null;
        const species = fromStore ? speciesFor(fromStore.species)
          : ctx.species[Math.floor(rnd() * ctx.species.length)];
        const habit = species.habit || 'broad';
        const dead = !!(fromStore && fromStore.outcome === 'wilted');
        const base = hsl2rgb(species.hue, dead ? 0.08 : 0.32, dead ? 0.2 : row.lum + rnd() * 0.03);
        list.push({
          species: species.id, habit, dead,
          x, y: groundAt(x) + row.y,
          scale: row.scale * (species.height || 1) * (0.86 + rnd() * 0.36),
          rot: 0,
          color: mix3(mix3(base, [0.34, 0.31, 0.28], dead ? 0.6 : 0), pal().horizon, dead ? row.haze * 0.5 : row.haze),
          sway: 0.5 + rnd() * 0.9
        });
      }
      groups.push({ row, list, order: ri });
    });
    return groups;
  }

  let wood = buildWood();

  /* ---- instance buffers ---- */

  const BLANK = function () {
    return [
      { location: 3, name: 'a_iPos', data: new Float32Array(2), size: 2 },
      { location: 4, name: 'a_iScale', data: new Float32Array(2), size: 2 },
      { location: 5, name: 'a_iRot', data: new Float32Array(1), size: 1 },
      { location: 6, name: 'a_iColor', data: new Float32Array(3), size: 3 },
      { location: 7, name: 'a_iSway', data: new Float32Array(1), size: 1 }
    ];
  };

  let woodIns = [];

  function rebuildWood() {
    woodIns.forEach(function (h) { h.release(); });
    woodIns = [];
    wood.forEach(function (group) {
      const list = group.list;
      if (!list.length) return;
      const n = list.length;
      const pos = new Float32Array(n * 2), scale = new Float32Array(n * 2), rot = new Float32Array(n);
      const col = new Float32Array(n * 3), sway = new Float32Array(n);
      list.forEach(function (t, i) {
        pos[i * 2] = t.x; pos[i * 2 + 1] = t.y;
        scale[i * 2] = t.scale; scale[i * 2 + 1] = t.scale * (t.dead ? 0.85 : 1);
        rot[i] = t.rot;
        col[i * 3] = t.color[0]; col[i * 3 + 1] = t.color[1]; col[i * 3 + 2] = t.color[2];
        sway[i] = t.dead ? 0.15 : t.sway;
      });
      const byHabit = {};
      list.forEach(function (t, i) {
        if (!byHabit[t.habit]) byHabit[t.habit] = [];
        byHabit[t.habit].push(i);
      });
      const handles = [];
      for (const habit of Object.keys(byHabit)) {
        const idx = byHabit[habit];
        const m = idx.length;
        const p2 = new Float32Array(m * 2), s2 = new Float32Array(m * 2), r2 = new Float32Array(m);
        const c2 = new Float32Array(m * 3), w2 = new Float32Array(m);
        idx.forEach(function (src, j) {
          p2[j * 2] = pos[src * 2]; p2[j * 2 + 1] = pos[src * 2 + 1];
          s2[j * 2] = scale[src * 2]; s2[j * 2 + 1] = scale[src * 2 + 1];
          r2[j] = rot[src]; w2[j] = sway[src];
          c2[j * 3] = col[src * 3]; c2[j * 3 + 1] = col[src * 3 + 1]; c2[j * 3 + 2] = col[src * 3 + 2];
        });
        const mesh = KIND_MESH[habit] || KIND_MESH.broad;
        handles.push(stage.instances(mesh, [
          { location: 3, name: 'a_iPos', data: p2, size: 2 },
          { location: 4, name: 'a_iScale', data: s2, size: 2 },
          { location: 5, name: 'a_iRot', data: r2, size: 1 },
          { location: 6, name: 'a_iColor', data: c2, size: 3 },
          { location: 7, name: 'a_iSway', data: w2, size: 1 }
        ], m));
      }
      woodIns.push({ order: group.order, handles });
    });
  }

  /* ---- the tree growing right now ---- */

  const specBuf = {
    pos: new Float32Array(2), scale: new Float32Array(2), rot: new Float32Array(1),
    color: new Float32Array(3), sway: new Float32Array(1)
  };
  const specIns = { key: '', tree: null, sprout: null };

  function specimenHandles(habit) {
    if (specIns.key !== habit) {
      if (specIns.tree) { specIns.tree.release(); specIns.sprout.release(); }
      specIns.tree = stage.instances(KIND_MESH[habit] || KIND_MESH.broad, BLANK(), 1);
      specIns.sprout = stage.instances(sprout, BLANK(), 1);
      specIns.key = habit;
    }
    return specIns;
  }

  function specimenState() {
    const t = ctx.timer.tree;
    if (!t) return null;
    const sp = speciesFor(t.species);
    const habit = sp.habit || 'broad';
    const progress = Math.max(0, Math.min(1, ctx.timer.progress || 0));
    const state = ctx.timer.state;
    const wilted = state === 'wilted';
    const holding = state === 'paused';
    // Standing in the open ground to the right of the card, so it is never hidden by the UI — and
    // it has to be the biggest living thing in the frame, or the promise ("plant a tree") is
    // carried by a timer ring instead of by a tree.
    const x = 0.44;
    const grow = wilted ? 0.7 : 0.34 + progress * 0.74;
    const height = grow * (sp.height || 1);
    let color = wilted
      ? mix3(hsl2rgb(32, 0.08, 0.26), [0.32, 0.3, 0.28], 0.55)
      : hsl2rgb(sp.hue, holding ? 0.18 : 0.34, holding ? 0.26 : 0.3);
    // the tree you are growing catches the light, so it reads as painted rather than as one more
    // silhouette — but only a little, or it floats off the scene
    color = mix3(color, pal().glow, wilted ? 0.06 : 0.15);
    return {
      habit, progress, wilted, holding, x,
      base: groundAt(x) - 0.02,
      scale: [height * (holding ? 0.92 : 1), height * (wilted ? 0.84 : 1)],
      rot: wilted ? 0.045 : holding ? 0.028 : 0,
      color, sway: wilted ? 0.1 : 0.9
    };
  }

  /* ---- layers ---- */

  let draws = 0;
  let frameTime = -1;

  const aspectOf = function (f) { return f && f.aspect ? f.aspect : (stage.width / Math.max(1, stage.height)); };

  stage.layer('sky').add({
    order: 0,
    label: 'sky',
    draw(f) {
      if (!f || f.time !== frameTime) { frameTime = f ? f.time : 0; draws = 0; }
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      theme = readTheme();
      const p = pal();
      skyProg.use();
      skyProg.u('u_top', p.top);
      skyProg.u('u_horizon', p.horizon);
      skyProg.u('u_ground', p.ground);
      skyProg.u('u_glow', p.glow);
      skyProg.u('u_sun', p.sun);
      skyProg.u('u_stars', p.star);
      skyProg.u('u_aspect', aspectOf(f));
      skyProg.u('u_time', reduced ? 0 : f.time);
      fullQuad.draw(skyProg);
      draws += 1;
    }
  });

  bands.forEach(function (band) {
    stage.layer(band.layer).add({
      order: band.order,
      label: 'band',
      draw(f) {
        const t = reduced ? 0 : f.time;
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        bandProg.use();
        bandProg.u('u_aspect', aspectOf(f));
        bandProg.u('u_drift', [
          Math.sin(t * 0.045 + band.phase) * band.amp,
          Math.sin(t * 0.03 + band.phase * 1.7) * band.amp * 0.5
        ]);
        // The ground is the one surface we stand on: it needs a gradient (light near the horizon,
        // dark underfoot) or the whole lower frame reads as one flat black mass.
        const col = band.role === 'ground'
          ? { top: pal().gtop, bottom: pal().gbot }
          : bandColor(ladder()[band.role], band.hazeAmt);
        bandProg.u('u_top', col.top);
        bandProg.u('u_bottom', col.bottom);
        bandProg.u('u_yTop', band.yTop);
        bandProg.u('u_yBottom', band.yBottom);
        bandProg.u('u_lines', band.role === 'ground' ? 1 : 0);
        band.mesh.draw(bandProg);
        draws += 1;
      }
    });
  });

  wood.forEach(function (group, gi) {
    stage.layer('mid').add({
      order: 1 + group.order * 0.1,
      label: 'wood',
      draw(f) {
        const h = woodIns[gi];
        if (!h) return;
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        treeProg.use();
        treeProg.u('u_aspect', aspectOf(f));
        treeProg.u('u_time', reduced ? 0 : f.time);
        treeProg.u('u_wind', reduced ? 0 : 1);
        h.handles.forEach(function (handle) { handle.draw(treeProg); draws += 1; });
      }
    });
  });

  stage.layer('near').add({
    order: -1,
    label: 'frame',
    draw(f) {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      bandProg.use();
      bandProg.u('u_aspect', aspectOf(f));
      bandProg.u('u_drift', [0, 0]);
      const L = ladder();
      bandProg.u('u_top', mix3(L.frame, pal().horizon, 0.06));
      bandProg.u('u_bottom', L.frame);
      bandProg.u('u_yTop', 0.85);
      bandProg.u('u_yBottom', -1.4);
      frames.forEach(function (m) { m.draw(bandProg); draws += 1; });
    }
  });

  stage.layer('near').add({
    order: 0,
    label: 'specimen',
    draw(f) {
      const s = specimenState();
      if (!s) return;
      const inst = specimenHandles(s.habit);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      treeProg.use();
      treeProg.u('u_aspect', aspectOf(f));
      treeProg.u('u_time', reduced ? 0 : f.time);
      treeProg.u('u_wind', reduced ? 0 : 1);

      const paint = function (handle, scale) {
        specBuf.pos.set([s.x, s.base]);
        specBuf.scale.set([scale[0], scale[1]]);
        specBuf.rot[0] = s.rot;
        specBuf.color.set([s.color[0], s.color[1], s.color[2]]);
        specBuf.sway[0] = s.sway;
        handle.update('a_iPos', specBuf.pos);
        handle.update('a_iScale', specBuf.scale);
        handle.update('a_iRot', specBuf.rot);
        handle.update('a_iColor', specBuf.color);
        handle.update('a_iSway', specBuf.sway);
        handle.draw(treeProg);
        draws += 1;
      };

      // a seed reads as a sprout, then becomes the tree it is going to be
      if (s.progress < 0.22) {
        const g = 0.55 + s.progress * 1.6;
        paint(inst.sprout, [g * 0.9, g]);
      }
      paint(inst.tree, s.scale);
    }
  });

  ctx.bus.on('forest:changed', function () {
    wood = buildWood();
    rebuildWood();
  });

  rebuildWood();

  return {
    update() {},
    stats() {
      const list = [];
      wood.forEach(function (g) { g.list.forEach(function (t) { list.push(t); }); });
      const habits = {};
      list.forEach(function (t) { habits[t.habit] = 1; });
      const spec = specimenState();
      return {
        trees: list.length + (spec ? 1 : 0),
        species: ctx.species.length,
        draws,
        habits: Object.keys(habits).length,
        growing: !!spec,
        specimenProgress: spec ? Number(spec.progress.toFixed(3)) : 0,
        wilted: spec && spec.wilted ? 1 : 0,
        quality: ctx.quality || 'high',
        mode: 'illustrated'
      };
    },
    dispose() { woodIns.forEach(function (h) { h.handles.forEach(function (x) { x.release(); }); }); }
  };
}
