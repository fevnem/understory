// js/gl/shapes.js — the drawing vocabulary for the illustrated scene.
//
// Everything here is flat 2D geometry in a normalised screen space (x and y both -1..1, y up),
// built once on the CPU and drawn as silhouettes. There is no 3D: the scene is a stack of
// layered shapes with atmospheric haze, which is what gives it depth and what keeps it looking
// deliberate rather than like programmer art.
//
// All meshes are unindexed triangle lists in vec3 (z always 0) because stage.mesh() expects
// 3-component positions.

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function next() {
    h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  };
}

export function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; } else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

export function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/* ---------------------------------------------------------------- band profiles */

/** A soft rolling ridge: layered sines, deterministic per seed. */
export function ridgeProfile(seed, base, amp, roughness = 1) {
  const rnd = hash('ridge:' + seed);
  const p1 = rnd() * 6.28, p2 = rnd() * 6.28, p3 = rnd() * 6.28;
  return function profile(x) {
    return base
      + Math.sin(x * 1.15 + p1) * amp * 0.55
      + Math.sin(x * 2.9 + p2) * amp * 0.28 * roughness
      + Math.sin(x * 6.7 + p3) * amp * 0.12 * roughness;
  };
}

/**
 * A dense treeline: the ridge, plus a canopy of overlapping tree crowns so the top edge reads as
 * a mass of trees rather than a wave. Two octaves of different crown sizes stop it looking combed.
 */
export function treelineProfile(seed, base, amp) {
  const ridge = ridgeProfile(seed, base, amp, 0.7);
  const rnd = hash('trees:' + seed);
  const crowns = [];
  for (let i = 0; i < 140; i += 1) {
    crowns.push({ x: rnd() * 2.6 - 1.3, h: 0.02 + rnd() * 0.075, w: 0.012 + rnd() * 0.03 });
  }
  const big = [];
  for (let i = 0; i < 34; i += 1) {
    big.push({ x: rnd() * 2.6 - 1.3, h: 0.06 + rnd() * 0.14, w: 0.03 + rnd() * 0.06 });
  }
  return function profile(x) {
    let y = ridge(x);
    for (const c of crowns) {
      const d = Math.abs(x - c.x) / c.w;
      if (d < 1) y = Math.max(y, ridge(x) + c.h * Math.cos(d * 1.5708));
    }
    for (const c of big) {
      const d = Math.abs(x - c.x) / c.w;
      if (d < 1) y = Math.max(y, ridge(x) + c.h * Math.cos(d * 1.5708));
    }
    return y;
  };
}

/**
 * A silhouette band: a strip from `profile(x)` down past the bottom of the screen.
 * segs across x0..x1; returns unindexed triangles.
 */
export function bandMesh(profile, opts) {
  const o = opts || {};
  const x0 = o.x0 === undefined ? -1.35 : o.x0;
  const x1 = o.x1 === undefined ? 1.35 : o.x1;
  const segs = o.segs || 120;
  const bottom = o.bottom === undefined ? -1.5 : o.bottom;
  const out = [];
  let px = x0, py = profile(x0);
  for (let i = 1; i <= segs; i += 1) {
    const x = x0 + (x1 - x0) * (i / segs);
    const y = profile(x);
    out.push(px, py, 0, x, y, 0, px, bottom, 0);
    out.push(x, y, 0, x, bottom, 0, px, bottom, 0);
    px = x; py = y;
  }
  return { positions: new Float32Array(out) };
}

/* ---------------------------------------------------------------- shape primitives */

/** Circles/ellipses (with optional rotation) merged into one polygon soup — the canopy unit. */
export function blobMesh(list) {
  const out = [];
  for (const s of list) {
    const seg = s.seg || 16;
    const ry = s.ry === undefined ? s.r : s.ry;
    const rot = s.rot || 0;
    const c = Math.cos(rot), sn = Math.sin(rot);
    for (let i = 0; i < seg; i += 1) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = [[Math.cos(a0) * s.r, Math.sin(a0) * ry], [Math.cos(a1) * s.r, Math.sin(a1) * ry], [0, 0]];
      for (const [lx, ly] of p) {
        const rx = lx * c - ly * sn, ry2 = lx * sn + ly * c;
        out.push(s.x + rx, s.y + ry2, 0);
      }
    }
  }
  return { positions: new Float32Array(out) };
}

/** Tapered vertical shapes: trunks, stems, hanging strands. Each: {x, y0, y1, w0, w1, lean}. */
export function stemMesh(list) {
  const out = [];
  for (const s of list) {
    const lean = s.lean || 0;
    const dx = lean * (s.y1 - s.y0);
    out.push(
      s.x - s.w0 / 2, s.y0, 0, s.x + s.w0 / 2, s.y0, 0, s.x + dx - s.w1 / 2, s.y1, 0,
      s.x - s.w0 / 2, s.y0, 0, s.x + dx - s.w1 / 2, s.y1, 0, s.x + dx + s.w1 / 2, s.y1, 0
    );
  }
  return { positions: new Float32Array(out) };
}

/** A conifer crown: stacked tapering triangles. {x, y0, y1, w, tiers} */
export function coneMesh(list) {
  const out = [];
  for (const s of list) {
    const tiers = s.tiers || 3;
    for (let t = 0; t < tiers; t += 1) {
      const f = t / tiers;
      const yb = s.y0 + (s.y1 - s.y0) * f;
      const yt = s.y0 + (s.y1 - s.y0) * (f + 1 / tiers) * (t === tiers - 1 ? 1 : 0.94);
      const w = s.w * (1 - f * 0.62);
      out.push(
        s.x - w / 2, yb, 0, s.x + w / 2, yb, 0, s.x, yt, 0
      );
    }
  }
  return { positions: new Float32Array(out) };
}

/**
 * A whole tree as one flat silhouette, base at y=0, about 1.5 units tall. Habit decides the crown.
 * Overlapping opaque shapes with one colour merge into a single readable silhouette.
 */
export function treeMesh(habit, seed) {
  const rnd = hash('tree:' + habit + ':' + (seed || 0));
  const j = () => 0.9 + rnd() * 0.25;
  switch (habit) {
    case 'conifer':
      return {
        positions: concat(
          stemMesh([{ x: 0, y0: 0, y1: 0.5, w0: 0.05, w1: 0.03 }]),
          coneMesh([{ x: 0, y0: 0.42, y1: 1.5, w: 0.62, tiers: 4 }])
        )
      };
    case 'weeping':
      return {
        positions: concat(
          stemMesh([{ x: 0, y0: 0, y1: 1.15, w0: 0.055, w1: 0.03 }]),
          blobMesh([{ x: 0, y: 1.15, r: 0.5 * j(), ry: 0.4 }]),
          blobMesh([
            { x: -0.3, y: 0.85, r: 0.1, ry: 0.42 },
            { x: -0.12, y: 0.78, r: 0.09, ry: 0.5 },
            { x: 0.1, y: 0.8, r: 0.09, ry: 0.48 },
            { x: 0.3, y: 0.88, r: 0.1, ry: 0.4 }
          ])
        )
      };
    case 'columnar':
      return {
        positions: concat(
          stemMesh([{ x: 0, y0: 0, y1: 0.7, w0: 0.05, w1: 0.03 }]),
          blobMesh([{ x: 0, y: 1.0, r: 0.26 * j(), ry: 0.62 }, { x: 0, y: 1.34, r: 0.19 * j(), ry: 0.4 }])
        )
      };
    case 'clumping':
      return {
        positions: concat(
          stemMesh([
            { x: -0.09, y0: 0, y1: 0.72, w0: 0.035, w1: 0.022, lean: -0.1 },
            { x: 0.08, y0: 0, y1: 0.78, w0: 0.035, w1: 0.022, lean: 0.12 },
            { x: 0, y0: 0, y1: 0.68, w0: 0.035, w1: 0.022 }
          ]),
          blobMesh([
            { x: -0.16, y: 0.9, r: 0.26 * j() },
            { x: 0.18, y: 0.95, r: 0.24 * j() },
            { x: 0, y: 1.12, r: 0.3 * j() }
          ])
        )
      };
    case 'slender':
      return {
        positions: concat(
          stemMesh([{ x: 0, y0: 0, y1: 0.95, w0: 0.04, w1: 0.026 }]),
          blobMesh([
            { x: 0, y: 1.1, r: 0.24 * j(), ry: 0.3 },
            { x: 0.1, y: 1.3, r: 0.17 * j(), ry: 0.22 },
            { x: -0.08, y: 1.24, r: 0.15 * j(), ry: 0.2 }
          ])
        )
      };
    default: // broad
      return {
        positions: concat(
          stemMesh([{ x: 0, y0: 0, y1: 0.78, w0: 0.06, w1: 0.035 }]),
          blobMesh([
            { x: -0.3, y: 1.0, r: 0.3 * j() },
            { x: 0.32, y: 0.98, r: 0.3 * j() },
            { x: 0, y: 1.28, r: 0.34 * j() },
            { x: 0, y: 0.95, r: 0.38 * j() }
          ])
        )
      };
  }
}

function concat(a, b) {
  const out = new Float32Array(a.positions.length + b.positions.length);
  out.set(a.positions, 0);
  out.set(b.positions, a.positions.length);
  return out;
}

/** A sprout: what the growing tree looks like at the very start. */
export function sproutMesh() {
  return {
    positions: concat(
      stemMesh([{ x: 0, y0: 0, y1: 0.5, w0: 0.03, w1: 0.02 }]),
      blobMesh([
        { x: -0.09, y: 0.52, r: 0.1, ry: 0.06, rot: 0.5 },
        { x: 0.09, y: 0.54, r: 0.1, ry: 0.06, rot: -0.5 }
      ])
    )
  };
}

/** Corner foliage that frames the shot and reads as "we are standing in the wood".
 *  Deliberately small and low: large corner shapes swallow the whole landscape and the horizon
 *  glow never gets to be seen. */
export function frameMesh(seed, side) {
  const rnd = hash('frame:' + seed + ':' + side);
  const s = side < 0 ? -1 : 1;
  const blobs = [];
  const stems = [];
  const n = 4;
  for (let i = 0; i < n; i += 1) {
    const f = i / (n - 1);
    blobs.push({
      x: s * (0.94 + rnd() * 0.28),
      y: -0.95 + f * 0.62 + rnd() * 0.08,
      r: 0.19 + rnd() * 0.13,
      ry: 0.2 + rnd() * 0.16,
      rot: s * (0.25 + rnd() * 0.5)
    });
  }
  stems.push({ x: s * 1.06, y0: -1.25, y1: -0.16, w0: 0.11, w1: 0.05, lean: -s * 0.08 });
  return { positions: concat(blobMesh(blobs), stemMesh(stems)) };
}
