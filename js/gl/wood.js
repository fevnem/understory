// js/gl/wood.js — the geometry and habit vocabulary of the forest: every mesh builder, the
// habit table and the small maths helpers. Split out of forest.js so both files stay small and
// the renderer owns only the scene, not the shapes.

export function shadowQuadMesh() {
  const positions = new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2]);
  return { positions, indices };
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

/** Deterministic PRNG from a string, so the same forest is rebuilt on every load. */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return function next() {
    h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  };
}

/** The ground surface. Trees are placed on this, so the shape and the placement always agree. */
export function terrainHeight(x, z) {
  return Math.sin(x * 0.11) * Math.cos(z * 0.13) * 0.42
    + Math.sin(x * 0.29 + 1.7) * Math.sin(z * 0.23 - 0.4) * 0.22
    - 0.35;
}

/** Tapered prism trunk: 6 sides, radius 0.055 at the base to 0.032 at the top, height 1. */
export function trunkMesh() {
  const sides = 6, h = 1, r0 = 0.055, r1 = 0.032;
  const pos = [], nor = [], idx = [];
  for (let i = 0; i <= sides; i += 1) {
    const a = (i / sides) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    pos.push(cx * r0, 0, cz * r0, cx * r1, h, cz * r1);
    nor.push(cx, 0.25, cz, cx, 0.25, cz);
  }
  for (let i = 0; i < sides; i += 1) {
    const b = i * 2;
    idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/** A low-poly canopy blob (lat/long sphere), lying just above the trunk top. */
export function blobMesh(segLat = 7, segLon = 9, base = 1.0) {
  const pos = [], nor = [], idx = [];
  for (let y = 0; y <= segLat; y += 1) {
    const v = y / segLat, phi = v * Math.PI;
    for (let x = 0; x <= segLon; x += 1) {
      const u = x / segLon, theta = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(theta), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(theta);
      const wobble = 1 + Math.sin(u * 9.2 + v * 5.1) * 0.08;
      pos.push(nx * 0.52 * wobble, base + ny * 0.4 * wobble + 0.4, nz * 0.52 * wobble);
      nor.push(nx, ny, nz);
    }
  }
  for (let y = 0; y < segLat; y += 1) {
    for (let x = 0; x < segLon; x += 1) {
      const a = y * (segLon + 1) + x, b = a + segLon + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/** Stacked cones — the conifer crown. */
export function coneMesh() {
  const pos = [], nor = [], idx = [];
  const tiers = [[0.5, 0.34, 0.75], [0.72, 0.28, 1.15], [0.95, 0.2, 1.5]];
  for (const [y0, r, top] of tiers) {
    const sides = 8, start = pos.length / 3;
    for (let i = 0; i <= sides; i += 1) {
      const a = (i / sides) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y0, Math.sin(a) * r);
      nor.push(Math.cos(a) * 0.7, 0.4, Math.sin(a) * 0.7);
    }
    const apex = pos.length / 3;
    pos.push(0, top, 0); nor.push(0, 1, 0);
    for (let i = 0; i < sides; i += 1) {
      idx.push(start + i, apex, start + i + 1);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/** Hanging ribbons — the weeping habit. */
export function strandMesh() {
  const pos = [], nor = [], idx = [];
  const strands = 7;
  for (let s = 0; s < strands; s += 1) {
    const a = (s / strands) * Math.PI * 2;
    const x = Math.cos(a) * 0.32, z = Math.sin(a) * 0.32;
    const nx = Math.cos(a + Math.PI / 2), nz = Math.sin(a + Math.PI / 2);
    const drop = 0.9 + Math.sin(s * 2.1) * 0.16;
    const start = pos.length / 3;
    for (let i = 0; i <= 4; i += 1) {
      const t = i / 4;
      const wobble = 1 + Math.sin(t * 3.4 + s) * 0.35;
      const y = 1.12 - drop * t;
      const w = 0.055 * (1 - t * 0.45);
      pos.push(x * wobble + nx * w, y, z * wobble + nz * w);
      nor.push(nx, 0.15, nz);
      pos.push(x * wobble - nx * w, y, z * wobble - nz * w);
      nor.push(-nx, 0.15, -nz);
    }
    for (let i = 0; i < 4; i += 1) {
      const b = start + i * 2;
      idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/** Three slim trunks under one crown — the clumping habit. */
export function clumpMesh() {
  const pos = [], nor = [], idx = [];
  const offsets = [[0, 0], [0.14, 0.08], [-0.12, 0.11]];
  for (const [ox, oz] of offsets) {
    const sides = 5, start = pos.length / 3;
    for (let i = 0; i <= sides; i += 1) {
      const a = (i / sides) * Math.PI * 2;
      const cx = Math.cos(a) * 0.035, cz = Math.sin(a) * 0.035;
      pos.push(ox + cx, 0, oz + cz, ox + cx * 0.8, 0.8, oz + cz * 0.8);
      nor.push(cx * 20, 0.3, cz * 20, cx * 20, 0.3, cz * 20);
    }
    for (let i = 0; i < sides; i += 1) {
      const b = start + i * 2;
      idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/** Growth habit -> which canopy primitive to use and how to stretch it. */
export const HABIT = {
  slender: { canopy: 'blob', scale: [0.78, 1.02, 0.78], trunk: [0.9, 1.15, 0.9], sat: 0.3, lum: 0.38 },
  broad: { canopy: 'blob', scale: [1.3, 1.15, 1.3], trunk: [1.25, 1.05, 1.25], sat: 0.32, lum: 0.36 },
  conifer: { canopy: 'cone', scale: [0.95, 1.2, 0.95], trunk: [0.85, 1.2, 0.85], sat: 0.28, lum: 0.32 },
  weeping: { canopy: 'strand', scale: [1.0, 1.0, 1.0], trunk: [0.95, 1.15, 0.95], sat: 0.3, lum: 0.38 },
  columnar: { canopy: 'blob', scale: [0.6, 1.34, 0.6], trunk: [0.8, 1.25, 0.8], sat: 0.32, lum: 0.35 },
  clumping: { canopy: 'clump', scale: [1.0, 0.85, 1.0], trunk: [0.9, 0.9, 0.9], sat: 0.3, lum: 0.36 }
};
