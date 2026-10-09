// js/gl/forest.js — the forest. Sky, ridges, terrain, the standing wood and the tree that is
// growing right now. Written by the manager after the assigned hand stalled with no file.
//
// Layers used: 'sky' (gradient + sun + clouds), 'far' (ridge silhouettes),
// 'mid' (terrain, then the standing wood), 'near' (the growing specimen).
// Geometry is built once; per frame only uniforms are written, except the specimen's transform.

import { speciesFor } from '../content/species.js';
import {
  hsl2rgb, hash, terrainHeight, trunkMesh, blobMesh, coneMesh, strandMesh, clumpMesh,
  shadowQuadMesh, HABIT
} from './wood.js';

/* ------------------------------------------------------------------ shaders */

const SKY_VS = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform vec3 u_top;
uniform vec3 u_horizon;
uniform vec3 u_ground;
uniform vec3 u_sun;
uniform vec2 u_sunUV;
uniform float u_time;
uniform float u_amount;
void main() {
  float y = v_uv.y;
  float h = 0.44;
  float above = clamp((y - h) / max(0.001, 1.0 - h), 0.0, 1.0);
  vec3 sky = mix(u_horizon, u_top, pow(above, 0.7));
  vec3 col = mix(u_ground, sky, smoothstep(h - 0.006, h + 0.006, y));
  float d = distance(v_uv * vec2(1.0, 0.62), u_sunUV * vec2(1.0, 0.62));
  col += u_sun * exp(-pow(d * 3.2, 2.0)) * 0.5 * u_amount;
  float band = exp(-pow((y - h) * 6.5, 2.0));
  col += u_sun * band * 0.12 * u_amount;
  float drift = u_time * 0.004;
  float cl = sin(v_uv.x * 2.6 + drift) * 0.5 + 0.5;
  cl *= sin(v_uv.x * 7.3 - drift * 1.7 + 1.2) * 0.5 + 0.5;
  cl *= smoothstep(0.52, 0.95, y) * (1.0 - smoothstep(0.86, 1.0, y));
  col += vec3(0.055, 0.06, 0.068) * cl * u_amount;
  fragColor = vec4(col, 1.0);
}`;

const FLAT_VS = `#version 300 es
in vec3 a_position;
uniform mat4 u_viewProj;
uniform vec3 u_eye;
uniform float u_fogNear;
uniform float u_fogFar;
out float v_fog;
void main() {
  v_fog = smoothstep(u_fogNear, u_fogFar, length(a_position - u_eye));
  gl_Position = u_viewProj * vec4(a_position, 1.0);
}`;

const FLAT_FS = `#version 300 es
precision highp float;
in float v_fog;
out vec4 fragColor;
uniform vec3 u_color;
uniform vec3 u_fogColor;
uniform float u_alpha;
void main() { fragColor = vec4(mix(u_color, u_fogColor, v_fog), u_alpha); }`;

const LIT_VS = `#version 300 es
in vec3 a_position;
in vec3 a_normal;
uniform mat4 u_viewProj;
uniform vec3 u_eye;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_time;
out vec3 v_normal;
out vec3 v_world;
out float v_fog;
void main() {
  vec3 p = a_position;
  p.y += sin((p.x + p.z) * 0.5 + u_time * 0.25) * 0.012;
  v_normal = a_normal;
  v_world = p;
  v_fog = smoothstep(u_fogNear, u_fogFar, length(p - u_eye));
  gl_Position = u_viewProj * vec4(p, 1.0);
}`;

const LIT_FS = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_world;
in float v_fog;
out vec4 fragColor;
uniform vec3 u_sun;
uniform vec3 u_low;
uniform vec3 u_high;
uniform vec3 u_fogColor;
uniform float u_time;
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 n = normalize(v_normal);
  float diff = max(dot(n, normalize(u_sun)), 0.0);
  float slope = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 base = mix(u_low, u_high, slope);
  // Smooth, multi-scale variation. Quantised cells read as a placeholder checkerboard; the floor
  // only needs enough unevenness to stop being a flat plane.
  float m = 0.5 + 0.5 * sin(v_world.x * 0.23 + v_world.z * 0.19) * cos(v_world.z * 0.31 - v_world.x * 0.14);
  m = mix(m, 0.5 + 0.5 * sin(v_world.x * 0.71 - v_world.z * 0.63) * cos(v_world.x * 0.44 + v_world.z * 0.52), 0.4);
  float moon = clamp(n.y, 0.0, 1.0);
  vec3 col = base * (0.78 + 1.05 * diff) * (0.9 + 0.22 * m);
  col += vec3(0.05, 0.065, 0.085) * moon;
  // ground mist: the far field lifts toward the sky, which is what makes it recede
  float lift = smoothstep(0.1, 0.95, v_fog);
  col = mix(col, u_fogColor, v_fog * 0.82 + lift * 0.22);
  fragColor = vec4(col, 1.0);
}`;

// Instanced trees: the same primitive mesh, one transform per tree.
const TREE_VS = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 3) in vec3 a_iPos;
layout(location = 4) in vec3 a_iScale;
layout(location = 5) in float a_iRot;
layout(location = 6) in vec3 a_iColor;
layout(location = 7) in float a_iDead;
uniform mat4 u_viewProj;
uniform vec3 u_eye;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_time;
uniform float u_wind;
out vec3 v_normal;
out vec3 v_color;
out float v_fog;
out float v_dead;
void main() {
  float c = cos(a_iRot), s = sin(a_iRot);
  vec3 p = a_position * a_iScale;
  vec3 rp = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  float h = clamp(rp.y / max(0.001, a_iScale.y), 0.0, 1.0);
  float sway = sin(u_time * 0.55 + a_iRot * 7.0 + a_iPos.x * 0.3) * u_wind * h * h;
  vec3 world = a_iPos + rp + vec3(sway, 0.0, sway * 0.4);
  v_normal = normalize(vec3(a_normal.x * c - a_normal.z * s, a_normal.y, a_normal.x * s + a_normal.z * c));
  v_color = a_iColor;
  v_dead = a_iDead;
  v_fog = smoothstep(u_fogNear, u_fogFar, length(world - u_eye));
  gl_Position = u_viewProj * vec4(world, 1.0);
}`;

const TREE_FS = `#version 300 es
precision highp float;
in vec3 v_normal;
in vec3 v_color;
in float v_fog;
in float v_dead;
out vec4 fragColor;
uniform vec3 u_sun;
uniform vec3 u_fogColor;
void main() {
  vec3 n = normalize(v_normal);
  float diff = max(dot(n, normalize(u_sun)), 0.0);
  // Two-tone: lit crown, dark underside. Flat single-colour canopies read as paper cut-outs.
  float up = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = v_color * (0.18 + 1.1 * diff) * (0.62 + 0.62 * up);
  float rim = pow(1.0 - up, 1.6) * 0.5;
  col += v_color * rim * 0.35;
  float grey = dot(col, vec3(0.34, 0.5, 0.16));
  col = mix(col, vec3(grey) * 0.9, v_dead * 0.85);
  col = mix(col, u_fogColor, v_fog * 0.9);
  fragColor = vec4(col, 1.0);
}`;

// Contact shadows. Without something under the trunks the whole wood reads as pasted onto a
// backdrop; one soft blob each is enough to plant them.
const SHADOW_VS = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 3) in vec3 a_iPos;
layout(location = 4) in vec3 a_iScale;
layout(location = 5) in float a_iRot;
layout(location = 6) in vec3 a_iColor;
layout(location = 7) in float a_iDead;
uniform mat4 u_viewProj;
out vec2 v_local;
void main() {
  v_local = a_position.xz;
  float c = cos(a_iRot), s = sin(a_iRot);
  vec2 xz = a_position.xz * vec2(a_iScale.x, a_iScale.z);
  vec2 r = vec2(xz.x * c - xz.y * s, xz.x * s + xz.y * c);
  vec3 world = a_iPos + vec3(r.x, 0.0, r.y);
  gl_Position = u_viewProj * vec4(world, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 v_local;
out vec4 fragColor;
uniform vec3 u_color;
uniform float u_strength;
void main() {
  float r = length(v_local);
  float a = smoothstep(1.0, 0.08, r) * u_strength;
  a += smoothstep(0.45, 0.0, r) * u_strength * 0.5;
  if (a <= 0.004) discard;
  fragColor = vec4(u_color, a);
}`;

/* shapes + habit vocabulary live in wood.js */


/* ------------------------------------------------------------------ module */

export const meta = { id: 'forest', order: 10, kind: 'gl' };

export function create(ctx) {
  const stage = ctx.stage;
  const dead = function degraded(reason) {
    return { update: function () {}, stats: function () { return { degraded: true, reason, trees: 0, species: 0, draws: 0 }; } };
  };
  if (!ctx.gl || !stage) return degraded('no webgl2');

  const gl = ctx.gl;
  const quality = ctx.quality;
  const reduced = ctx.reducedMotion;
  const FOG_NEAR = 13, FOG_FAR = 72;

  // palette from the theme tokens so both themes read correctly
  function token(name, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const m = raw.match(/^#([0-9a-f]{6})$/i);
    if (!m) return fallback;
    const v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  let sky = token('--sky-base', [0.11, 0.15, 0.19]);
  let accent = token('--accent', [0.56, 0.72, 0.6]);

  function palette() {
    const h = [sky[0] * 2.05 + accent[0] * 0.2, sky[1] * 1.95 + accent[1] * 0.18, sky[2] * 1.85 + accent[2] * 0.14];
    return {
      top: [sky[0] * 0.5, sky[1] * 0.6, sky[2] * 0.78],
      horizon: h,
      // The floor is what everything stands on: it needs enough value to hold a silhouette
      // against it, or the wood reads as cut-outs floating in a void.
      ground: [sky[0] * 1.35 + 0.04, sky[1] * 1.3 + 0.045, sky[2] * 1.15 + 0.035],
      sun: [accent[0] * 0.9 + 0.25, accent[1] * 0.75 + 0.2, accent[2] * 0.55 + 0.12],
      fog: [h[0] * 0.92, h[1] * 0.94, h[2] * 0.98],
      sunDir: [0.55, 0.42, 0.72]
    };
  }

  const skyProg = stage.program(SKY_VS, SKY_FS);
  const flatProg = stage.program(FLAT_VS, FLAT_FS);
  const litProg = stage.program(LIT_VS, LIT_FS);
  const treeProg = stage.program(TREE_VS, TREE_FS);
  const fullQuad = stage.quad();

  const trunk = stage.mesh(trunkMesh());
  const canopies = {
    blob: stage.mesh(blobMesh()),
    cone: stage.mesh(coneMesh()),
    strand: stage.mesh(strandMesh()),
    clump: stage.mesh(clumpMesh())
  };
  const shadowProg = stage.program(SHADOW_VS, SHADOW_FS);
  const shadowQuad = stage.mesh(shadowQuadMesh());

  /** The instance-attribute layout shared by the tree and shadow shaders (locations 3..7). */
  function blankInstanceAttrs() {
    return [
      { location: 3, name: 'a_iPos', data: new Float32Array(3), size: 3 },
      { location: 4, name: 'a_iScale', data: new Float32Array(3), size: 3 },
      { location: 5, name: 'a_iRot', data: new Float32Array(1), size: 1 },
      { location: 6, name: 'a_iColor', data: new Float32Array(3), size: 3 },
      { location: 7, name: 'a_iDead', data: new Float32Array(1), size: 1 }
    ];
  }

  /* ---- terrain grid ---- */

  function buildTerrain(size = 60, segs = quality === 'low' ? 22 : 34) {
    const pos = [], nor = [], idx = [];
    for (let z = 0; z <= segs; z += 1) {
      for (let x = 0; x <= segs; x += 1) {
        const wx = (x / segs - 0.5) * size;
        const wz = (z / segs - 0.5) * size;
        const h = terrainHeight(wx, wz);
        pos.push(wx, h, wz);
        const e = 0.4;
        const dx = (terrainHeight(wx + e, wz) - terrainHeight(wx - e, wz)) / (2 * e);
        const dz = (terrainHeight(wx, wz + e) - terrainHeight(wx, wz - e)) / (2 * e);
        const len = Math.hypot(-dx, 1, -dz);
        nor.push(-dx / len, 1 / len, -dz / len);
      }
    }
    for (let z = 0; z < segs; z += 1) {
      for (let x = 0; x < segs; x += 1) {
        const a = z * (segs + 1) + x, b = a + segs + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return stage.mesh({ positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) });
  }
  const terrain = buildTerrain();

  /* ---- ridge silhouettes ---- */

  function ridgeMesh(depth, seed, jag) {
    const rnd = hash('ridge' + seed);
    const pos = [], idx = [];
    const n = 26;
    const width = 90;
    for (let i = 0; i <= n; i += 1) {
      const t = i / n;
      const x = (t - 0.5) * width;
      const y = 1.1 + Math.sin(t * 5.1 + seed) * 0.35 * jag + Math.sin(t * 17.3 + seed * 2.1) * 0.16 * jag + rnd() * 0.06;
      pos.push(x, y, depth);
      pos.push(x, -3, depth);
    }
    for (let i = 0; i < n; i += 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    return stage.mesh({ positions: new Float32Array(pos), indices: new Uint16Array(idx) });
  }

  /** A far treeline: a serrated band hugging the horizon. This single shape does more for
   *  "forest" than ten more individual trees — it is the mass the wood recedes into. */
  function treelineMesh(depth, seed) {
    const pos = [], idx = [];
    const n = 150;
    const width = 120;
    for (let i = 0; i <= n; i += 1) {
      const t = i / n;
      const x = (t - 0.5) * width;
      const serr = Math.abs(Math.sin(t * 46 + seed)) * 0.55
        + Math.abs(Math.sin(t * 19.5 + seed * 2.3)) * 0.5
        + Math.sin(t * 6.1 + seed) * 0.18;
      const y = 1.15 + serr;
      pos.push(x, y, depth);
      pos.push(x, -3, depth);
    }
    for (let i = 0; i < n; i += 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    return stage.mesh({ positions: new Float32Array(pos), indices: new Uint16Array(idx) });
  }

  const ridges = [
    { mesh: ridgeMesh(-46, 1.2, 1.5), color: [0.34, 0.39, 0.46], order: 0 },
    { mesh: ridgeMesh(-34, 3.7, 1.15), color: [0.24, 0.28, 0.34], order: 1 },
    { mesh: ridgeMesh(-24, 6.1, 0.8), color: [0.15, 0.18, 0.23], order: 2 },
    // The treeline has to be DARKER than the horizon glow, or it dissolves into the sky.
    { mesh: treelineMesh(-15, 2.4), color: [0.075, 0.09, 0.115], order: 4 }
  ];

  /* ---- the wood ---- */

  function buildWood() {
    const rnd = hash('wood');
    const mid = [], fg = [];
    const finished = ctx.store.state.forest.filter(function (t) { return t.outcome !== 'growing'; });

    // A wood clumps. Trees are placed in clusters with a few outliers, not on an even spiral —
    // even spacing is what makes a planted row read as fence posts.
    const clusters = quality === 'low' ? 7 : 11;
    const perCluster = quality === 'low' ? 3 : 4;
    for (let c = 0; c < clusters; c += 1) {
      const angle = (c / clusters) * Math.PI * 2 + rnd() * 0.4;
      const radius = 6.5 + rnd() * 13;
      const cx = Math.cos(angle) * radius;
      const cz = Math.sin(angle) * radius * 0.85 - 1.6;
      const n = 2 + Math.floor(rnd() * perCluster);
      for (let i = 0; i < n; i += 1) {
        const ox = (rnd() - 0.5) * 3.4, oz = (rnd() - 0.5) * 3.4;
        mid.push({
          species: ctx.species[Math.floor(rnd() * ctx.species.length)].id,
          x: cx + ox, z: cz + oz,
          scale: 1.05 + rnd() * 1.05,
          rot: rnd() * Math.PI * 2,
          dead: 0
        });
      }
    }
    // outliers, so the stand has edges rather than a ring
    for (let i = 0; i < 6; i += 1) {
      const angle = rnd() * Math.PI * 2, radius = 5 + rnd() * 18;
      mid.push({
        species: ctx.species[Math.floor(rnd() * ctx.species.length)].id,
        x: Math.cos(angle) * radius, z: Math.sin(angle) * radius - 1.6,
        scale: 0.9 + rnd() * 0.9, rot: rnd() * Math.PI * 2, dead: 0
      });
    }

    // Foreground silhouettes: large, dark, cropped by the frame. These are what give the scene
    // a near plane and make the wood behind them read as depth.
    const fgSpots = [[-9.4, 7.2], [9.8, 6.1]];
    fgSpots.forEach(function (spot, i) {
      fg.push({
        species: ctx.species[(i * 4 + 1) % ctx.species.length].id,
        x: spot[0], z: spot[1],
        scale: 1.5 + i * 0.15,
        rot: i * 1.1,
        dead: 0,
        fg: true
      });
    });

    // His own trees join the stand.
    finished.slice(-160).forEach(function (t, i) {
      const r = hash(t.id);
      const angle = (i + 1) * 1.7 + r() * 0.9;
      const radius = 5.5 + r() * 11;
      mid.push({
        species: t.species,
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius * 0.7 + 1.4,
        scale: 1.1 + r() * 0.6,
        rot: r() * Math.PI * 2,
        dead: t.outcome === 'wilted' ? 1 : 0
      });
    });

    for (const t of mid.concat(fg)) {
      const sp = speciesFor(t.species);
      t.y = terrainHeight(t.x, t.z);
      t.sp = sp;
      t.habit = HABIT[sp.habit] || HABIT.broad;
    }
    return { mid, fg, all: mid.concat(fg) };
  }

  let wood = buildWood();
  let trees = wood.all;
  const woodInstances = { trunk: null, canopies: {}, fgTrunk: null, fgCanopies: {} };

  function rebuildInstances() {
    const group = function (list) {
      const byCanopy = new Map();
      for (const t of list) {
        const key = t.habit.canopy;
        if (!byCanopy.has(key)) byCanopy.set(key, []);
        byCanopy.get(key).push(t);
      }
      const out = { trunk: list.length ? makeInstances(list, 'trunk') : null, canopies: {} };
      for (const [kind, sub] of byCanopy) out.canopies[kind] = makeInstances(sub, kind);
      return out;
    };
    const mid = group(wood.mid);
    const fg = group(wood.fg);
    woodInstances.trunk = mid.trunk;
    woodInstances.canopies = mid.canopies;
    woodInstances.fgTrunk = fg.trunk;
    woodInstances.fgCanopies = fg.canopies;
    if (woodInstances.shadow) woodInstances.shadow.release();
    woodInstances.shadow = shadowInstances(wood.mid.concat(wood.fg));
  }

  function makeInstances(list, kind) {
    const n = list.length;
    const pos = new Float32Array(n * 3), scale = new Float32Array(n * 3), rot = new Float32Array(n), col = new Float32Array(n * 3), deadArr = new Float32Array(n);
    list.forEach(function (t, i) {
      const base = kind === 'trunk' ? t.habit.trunk : t.habit.scale;
      const h = t.sp.height * t.scale;
      pos[i * 3] = t.x; pos[i * 3 + 1] = t.y; pos[i * 3 + 2] = t.z;
      scale[i * 3] = base[0] * t.scale; scale[i * 3 + 1] = base[1] * h; scale[i * 3 + 2] = base[2] * t.scale;
      rot[i] = t.rot;
      const c = kind === 'trunk'
        ? (t.fg ? hsl2rgb(26, 0.3, 0.11) : hsl2rgb(28, 0.28, 0.16 + t.scale * 0.03))
        : (t.fg ? hsl2rgb(t.sp.hue, 0.26, 0.18) : hsl2rgb(t.sp.hue, t.habit.sat, t.habit.lum));
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      deadArr[i] = t.dead;
    });
    return stage.instances(kind === 'trunk' ? trunk : canopies[kind], [
      { location: 3, name: 'a_iPos', data: pos, size: 3 },
      { location: 4, name: 'a_iScale', data: scale, size: 3 },
      { location: 5, name: 'a_iRot', data: rot, size: 1 },
      { location: 6, name: 'a_iColor', data: col, size: 3 },
      { location: 7, name: 'a_iDead', data: deadArr, size: 1 }
    ], n);
  }

  function shadowInstances(list) {
    if (!list.length) return null;
    const n = list.length;
    const pos = new Float32Array(n * 3), scale = new Float32Array(n * 3), rot = new Float32Array(n);
    const col = new Float32Array(n * 3), dead = new Float32Array(n);
    list.forEach(function (t, i) {
      const hab = t.habit || { canopy: 'blob', scale: [1, 1, 1] };
      const radius = (hab.canopy === 'cone' ? 0.92 : 1.15) * (t.scale || 1) * 0.62;
      pos[i * 3] = t.x; pos[i * 3 + 1] = (t.y || 0) + 0.035; pos[i * 3 + 2] = t.z;
      scale[i * 3] = radius; scale[i * 3 + 1] = 1; scale[i * 3 + 2] = radius;
      rot[i] = t.rot || 0;
      dead[i] = 0;
    });
    return stage.instances(shadowQuad, [
      { location: 3, name: 'a_iPos', data: pos, size: 3 },
      { location: 4, name: 'a_iScale', data: scale, size: 3 },
      { location: 5, name: 'a_iRot', data: rot, size: 1 },
      { location: 6, name: 'a_iColor', data: col, size: 3 },
      { location: 7, name: 'a_iDead', data: dead, size: 1 }
    ], n);
  }

  function releaseInstances() {
    const free = function (set) {
      if (set.trunk) set.trunk.release();
      for (const kind of Object.keys(set.canopies)) set.canopies[kind].release();
      set.canopies = {};
      set.trunk = null;
    };
    free(woodInstances);
    free({ trunk: woodInstances.fgTrunk, canopies: woodInstances.fgCanopies });
    woodInstances.fgTrunk = null;
    woodInstances.fgCanopies = {};
    if (woodInstances.shadow) { woodInstances.shadow.release(); woodInstances.shadow = null; }
  }

  rebuildInstances();

  /* ---- the specimen: the tree growing right now ---- */

  const specimen = {
    pos: [2.6, 0, 3.4], rot: 0.7, scale: 1, species: null, habit: null,
    alive: false, wilted: false, paused: false, progress: 0
  };

  // The specimen's instance buffers are built once and rewritten in place each frame, so a
  // session left open for hours allocates nothing.
  const specBuf = {
    pos: new Float32Array(3), scale: new Float32Array(3), rot: new Float32Array(1),
    color: new Float32Array(3), dead: new Float32Array(1)
  };
  const specInst = { key: '', trunk: null, canopy: null };
  const specShadowBuf = {
    pos: new Float32Array(3), scale: new Float32Array(3), rot: new Float32Array(1),
    color: new Float32Array(3), dead: new Float32Array(1)
  };
  const specShadow = stage.instances(shadowQuad, blankInstanceAttrs(), 1);

  function specimenInstances(habit) {
    if (specInst.key === habit.canopy && specInst.trunk) return specInst;
    if (specInst.trunk) { specInst.trunk.release(); specInst.canopy.release(); }
    const blank = function () {
      return [
        { location: 3, name: 'a_iPos', data: new Float32Array(3), size: 3 },
        { location: 4, name: 'a_iScale', data: new Float32Array(3), size: 3 },
        { location: 5, name: 'a_iRot', data: new Float32Array(1), size: 1 },
        { location: 6, name: 'a_iColor', data: new Float32Array(3), size: 3 },
        { location: 7, name: 'a_iDead', data: new Float32Array(1), size: 1 }
      ];
    };
    specInst = {
      key: habit.canopy,
      trunk: stage.instances(trunk, blank(), 1),
      canopy: stage.instances(canopies[habit.canopy], blank(), 1)
    };
    return specInst;
  }

  function specimenTransform() {
    const t = ctx.timer.tree;
    if (!t) return null;
    const sp = speciesFor(t.species);
    return { sp, habit: HABIT[sp.habit] || HABIT.broad, scale: 1.35 };
  }

  /* ---- layers ---- */

  let drawCount = 0;
  let drawFrameTime = -1;

  stage.layer('sky').add({
    order: 0,
    label: 'sky',
    draw: function (f) {
      // the sky is first in the frozen order, so this is where the per-frame tally resets
      if (f.time !== drawFrameTime) { drawFrameTime = f.time; drawCount = 0; }
      const p = palette();
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      skyProg.use();
      skyProg.u('u_top', p.top);
      skyProg.u('u_horizon', p.horizon);
      skyProg.u('u_ground', p.ground);
      skyProg.u('u_sun', p.sun);
      skyProg.u('u_sunUV', [0.68, 0.5]);
      skyProg.u('u_time', reduced ? 0 : f.time);
      skyProg.u('u_amount', 1);
      fullQuad.draw(skyProg);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      drawCount += 1;
    }
  });

  for (const r of ridges) {
    stage.layer('far').add({
      order: r.order,
      label: 'ridge',
      draw: function (f) {
        const p = palette();
        gl.disable(gl.BLEND);
        flatProg.use();
        flatProg.u('u_viewProj', mulViewProj(f));
        flatProg.u('u_eye', stage.camera.pos);
        flatProg.u('u_fogNear', 20);
        flatProg.u('u_fogFar', 90);
        flatProg.u('u_color', r.color);
        flatProg.u('u_fogColor', [p.fog[0] * 0.7, p.fog[1] * 0.72, p.fog[2] * 0.76]);
        flatProg.u('u_alpha', 1);
        r.mesh.draw(flatProg);
        drawCount += 1;
      }
    });
  }

  stage.layer('mid').add({
    order: 0,
    label: 'terrain',
    draw: function (f) {
      const p = palette();
      litProg.use();
      litProg.u('u_viewProj', mulViewProj(f));
      litProg.u('u_eye', stage.camera.pos);
      litProg.u('u_fogNear', FOG_NEAR);
      litProg.u('u_fogFar', FOG_FAR);
      litProg.u('u_time', reduced ? 0 : f.time);
      litProg.u('u_sun', p.sunDir);
      litProg.u('u_low', [p.ground[0] * 0.62, p.ground[1] * 0.68, p.ground[2] * 0.6]);
      litProg.u('u_high', [p.ground[0] * 1.05, p.ground[1] * 1.1, p.ground[2] * 0.95]);
      litProg.u('u_fogColor', p.fog);
      litProg.u('u_time', reduced ? 0 : f.time);
      terrain.draw(litProg);
      drawCount += 1;
    }
  });

  /* ---- contact shadows (mid layer, drawn after the terrain and before the wood) ---- */

  stage.layer('mid').add({
    order: 0.5,
    label: 'shadows',
    draw: function (f) {
      if (!woodInstances.shadow && !specShadow) return;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      shadowProg.use();
      shadowProg.u('u_viewProj', mulViewProj(f));
      shadowProg.u('u_color', [0.012, 0.016, 0.021]);
      shadowProg.u('u_strength', 0.62);
      if (woodInstances.shadow) { woodInstances.shadow.draw(shadowProg); drawCount += 1; }
      if (specShadow && ctx.timer.tree) { specShadow.draw(shadowProg); drawCount += 1; }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  });

  stage.layer('mid').add({
    order: 1,
    label: 'wood',
    draw: function (f) {
      if (!trees.length) return;
      const p = palette();
      const vp = mulViewProj(f);
      treeProg.use();
      treeProg.u('u_viewProj', vp);
      treeProg.u('u_eye', stage.camera.pos);
      treeProg.u('u_fogNear', FOG_NEAR);
      treeProg.u('u_fogFar', FOG_FAR);
      treeProg.u('u_time', reduced ? 0 : f.time);
      treeProg.u('u_wind', reduced ? 0 : 0.05);
      treeProg.u('u_sun', p.sunDir);
      treeProg.u('u_fogColor', p.fog);
      woodInstances.trunk.draw(treeProg);
      drawCount += 1;
      for (const kind of Object.keys(woodInstances.canopies)) {
        woodInstances.canopies[kind].draw(treeProg);
        drawCount += 1;
      }
    }
  });

  /* ---- foreground silhouettes (near plane: what makes the wood read as deep) ---- */

  stage.layer('near').add({
    order: -1,
    label: 'foreground',
    draw: function (f) {
      if (!woodInstances.fgTrunk) return;
      const p = palette();
      treeProg.use();
      treeProg.u('u_viewProj', mulViewProj(f));
      treeProg.u('u_eye', stage.camera.pos);
      treeProg.u('u_fogNear', FOG_NEAR);
      treeProg.u('u_fogFar', FOG_FAR);
      treeProg.u('u_time', reduced ? 0 : f.time);
      treeProg.u('u_wind', reduced ? 0 : 0.09);
      treeProg.u('u_sun', p.sunDir);
      treeProg.u('u_fogColor', p.fog);
      woodInstances.fgTrunk.draw(treeProg);
      drawCount += 1;
      for (const kind of Object.keys(woodInstances.fgCanopies)) {
        woodInstances.fgCanopies[kind].draw(treeProg);
        drawCount += 1;
      }
    }
  });

  stage.layer('near').add({
    order: 0,
    label: 'specimen',
    draw: function (f) {
      const t = ctx.timer.tree;
      specimen.alive = !!t;
      if (!t) return;
      const sp = speciesFor(t.species);
      const habit = HABIT[sp.habit] || HABIT.broad;
      const prog = Math.min(1, Math.max(0, ctx.timer.progress));
      const paused = ctx.timer.state === 'paused';
      const wilted = ctx.timer.state === 'wilted';

      const growth = 0.22 + Math.pow(prog, 0.62) * 0.78;
      const height = sp.height * 1.5 * growth;
      const thickening = 0.7 + growth * 0.5;
      const droop = paused ? 0.12 : (wilted ? 0.3 : 0);
      const p = palette();
      const vp = mulViewProj(f);

      const color = wilted
        ? [0.32, 0.3, 0.26]
        : hsl2rgb(sp.hue, habit.sat * (paused ? 0.5 : 1), habit.lum * (paused ? 0.75 : 1));

      treeProg.use();
      treeProg.u('u_viewProj', vp);
      treeProg.u('u_eye', stage.camera.pos);
      treeProg.u('u_fogNear', FOG_NEAR);
      treeProg.u('u_fogFar', FOG_FAR);
      treeProg.u('u_time', reduced ? 0 : f.time);
      treeProg.u('u_wind', reduced ? 0 : (paused ? 0.01 : 0.06));
      treeProg.u('u_sun', p.sunDir);
      treeProg.u('u_fogColor', p.fog);

      const baseY = terrainHeight(specimen.pos[0], specimen.pos[2]);
      const inst = specimenInstances(habit);
      const paint = function (h, base) {
        specBuf.pos.set([specimen.pos[0], baseY, specimen.pos[2]]);
        specBuf.scale.set([base[0] * thickening, base[1] * height, base[2] * thickening]);
        specBuf.rot[0] = specimen.rot;
        specBuf.color.set(color);
        specBuf.dead[0] = droop > 0.2 ? 1 : 0;
        h.update('a_iPos', specBuf.pos);
        h.update('a_iScale', specBuf.scale);
        h.update('a_iRot', specBuf.rot);
        h.update('a_iColor', specBuf.color);
        h.update('a_iDead', specBuf.dead);
        h.draw(treeProg);
        drawCount += 1;
      };
      paint(inst.trunk, habit.trunk);
      paint(inst.canopy, habit.scale);

      // the specimen's own contact shadow, so the tree he is growing right now is planted too
      const srad = (habit.canopy === 'cone' ? 0.92 : 1.15) * thickening * 0.62;
      specShadowBuf.pos.set([specimen.pos[0], baseY + 0.035, specimen.pos[2]]);
      specShadowBuf.scale.set([srad, 1, srad]);
      specShadowBuf.rot[0] = specimen.rot;
      specShadow.update('a_iPos', specShadowBuf.pos);
      specShadow.update('a_iScale', specShadowBuf.scale);
      specShadow.update('a_iRot', specShadowBuf.rot);
    }
  });

  /* ---- camera framing and drift ---- */

  let azimuth = 0.32;
  stage.camera.orbit(azimuth, 0.17, 15, [0, 1.5, 0]);
  stage.camera.fov = Math.PI / 3.1;

  function mulViewProj(f) {
    const view = stage.camera.view();
    const proj = stage.camera.proj(f.aspect);
    const out = stage.mat4.create();
    stage.mat4.mul(out, proj, view);
    return out;
  }

  ctx.bus.on('forest:changed', function () {
    releaseInstances();
    wood = buildWood();
    trees = wood.all;
    rebuildInstances();
  });
  ctx.bus.on('settings:changed', function () {
    sky = token('--sky-base', sky);
    accent = token('--accent', accent);
  });

  return {
    update: function (dt) {
      if (reduced) return;
      azimuth += dt * 0.006;
      stage.camera.orbit(azimuth, 0.17, 15, [0, 1.5, 0]);
    },
    resize: function () {},
    stats: function () {
      const counted = {};
      for (const t of trees) counted[t.species] = true;
      return {
        trees: trees.length,
        species: Object.keys(counted).length,
        draws: drawCount,
        habits: Object.keys(HABIT).length,
        growing: !!ctx.timer.tree,
        specimenProgress: Math.round(ctx.timer.progress * 1000) / 1000,
        wilted: trees.filter(function (t) { return t.dead === 1; }).length,
        quality
      };
    },
    dispose: function () {}
  };
}