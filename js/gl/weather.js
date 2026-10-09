// js/gl/weather.js — Understory’s atmosphere and the final screen pass.
// Rain (instanced streaks), fog banks, light shafts, floating motes, then a single-pass post
// (bloom, vignette, grain, warm accent). This module owns stage.onPresent — docs/CONTRACT.md §8.
// Layers touched: far (fog, shafts), rain (streaks), fx (motes). Present falls back to a plain
// blit if the graded pass cannot run, and to the stage’s own present if shaders fail entirely —
// the page is never left black.

export const meta = { id: 'weather', order: 20, kind: 'gl' };

/* ------------------------------------------------------------------ shaders */

const RAIN_VS = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_seed;
layout(location = 2) in vec2 a_var;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform vec3 u_cam;
uniform vec3 u_center;
uniform vec3 u_vol;
uniform vec3 u_fall;
uniform float u_time;
uniform float u_len;
uniform float u_wid;
out float v_alpha;
out float v_soft;
out float v_side;
out float v_t;
void main() {
  float speed = mix(7.0, 20.0, a_seed.z);
  float span = 2.0 * u_vol.y;
  float y = mod(a_seed.w * span - u_time * speed, span) - u_vol.y;
  float drift = u_time * speed * 0.30;
  float x = mod((a_seed.x * 2.0 - 1.0) * u_vol.x + drift * u_fall.x, 2.0 * u_vol.x) - u_vol.x;
  float z = mod((a_seed.y * 2.0 - 1.0) * u_vol.z + drift * u_fall.z, 2.0 * u_vol.z) - u_vol.z;
  vec3 world = u_center + vec3(x, y, z);
  float dist = distance(world, u_cam);
  vec3 dir = normalize(u_fall);
  vec4 vp = u_view * vec4(world, 1.0);
  vec3 dirv = normalize((u_view * vec4(dir, 0.0)).xyz);
  vec3 rgt = cross(vec3(0.0, 0.0, 1.0), dirv);
  float rl = length(rgt);
  rgt = rl > 0.0001 ? rgt / rl : vec3(1.0, 0.0, 0.0);
  float near = max(0.6, -vp.z);
  float len = u_len * mix(0.55, 1.7, a_var.x) * mix(0.75, 1.25, a_seed.w);
  float wid = u_wid * mix(0.6, 1.5, a_seed.x) * (1.0 + 6.0 / near);
  vec3 off = rgt * (a_position.x * wid) - dirv * (a_position.y * len);
  gl_Position = u_proj * vec4(vp.xyz + off, 1.0);
  float nearness = clamp(1.0 - (dist - 4.0) / 22.0, 0.0, 1.0);
  // Depth-graded: near drops are wide, soft and faint; far ones thin and fainter. Uniform
  // hard-edged streaks read as scratches on the lens rather than rain.
  v_alpha = a_var.y * mix(0.09, 0.72, nearness);
  v_soft = mix(0.5, 0.97, nearness);
  v_side = a_position.x;
  v_t = a_position.y;
}`;

const RAIN_FS = `#version 300 es
precision highp float;
in float v_alpha;
in float v_soft;
in float v_side;
in float v_t;
uniform vec3 u_color;
out vec4 fragColor;
void main() {
  float edge = smoothstep(1.0, 1.0 - clamp(v_soft, 0.06, 0.97), abs(v_side));
  float tail = smoothstep(1.0, 0.30, v_t);
  float a = edge * tail * v_alpha;
  if (a <= 0.002) discard;
  fragColor = vec4(u_color, a);
}`;

const SOFT_VS = `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_pos;
layout(location = 2) in vec4 a_seed;
layout(location = 3) in vec2 a_size;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform float u_time;
uniform float u_wind;
uniform float u_slant;
out vec2 v_uv;
out float v_seed;
void main() {
  vec3 c = a_pos;
  c.x += sin(u_time * 0.05 + a_seed.w * 6.2831) * 0.6 + u_time * 0.05 * u_wind;
  c.y += sin(u_time * 0.07 + a_seed.w * 6.2831) * 0.25;
  vec3 rgt = u_view[0].xyz;
  vec3 up = u_view[1].xyz;
  v_uv = a_position.xy;
  v_seed = a_seed.z;
  vec2 q = a_position.xy;
  q.x += q.y * (u_slant + (a_seed.x * 2.0 - 1.0) * 0.45);
  vec3 world = c + rgt * (q.x * a_size.x) + up * (q.y * a_size.y);
  gl_Position = u_proj * u_view * vec4(world, 1.0);
}`;

const SOFT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_seed;
uniform vec3 u_tint;
uniform float u_opacity;
uniform float u_soft;
uniform float u_kind;
uniform float u_noise;
uniform float u_time;
out vec4 fragColor;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  float a;
  if (u_kind > 0.5) {
    float d = length(v_uv);
    a = smoothstep(1.0, 0.0, d);
    a *= a;
  } else {
    float sides = 1.0 - abs(v_uv.x);
    float band = 1.0 - abs(v_uv.y);
    a = smoothstep(0.0, u_soft, sides) * smoothstep(0.0, 0.9, band);
  }
  float n = vnoise(v_uv * u_noise + vec2(u_time * 0.02, -u_time * 0.03) + v_seed * 7.0);
  a *= mix(0.5, 1.0, n) * u_opacity;
  if (a <= 0.002) discard;
  fragColor = vec4(u_tint, a);
}`;

const POST_VS = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const POST_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform vec2 u_texel;
uniform vec2 u_res;
uniform vec3 u_accent;
uniform vec3 u_warm;
uniform float u_bloom;
uniform float u_vignette;
uniform float u_grain;
uniform float u_time;
uniform float u_pulse;
out vec4 fragColor;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
void main() {
  vec3 c = texture(u_scene, v_uv).rgb;
  vec2 r1 = u_texel * 2.6;
  vec3 b = texture(u_scene, v_uv + vec2( r1.x,  r1.y)).rgb;
  b += texture(u_scene, v_uv + vec2(-r1.x,  r1.y)).rgb;
  b += texture(u_scene, v_uv + vec2( r1.x, -r1.y)).rgb;
  b += texture(u_scene, v_uv + vec2(-r1.x, -r1.y)).rgb;
  b *= 0.25;
  b = max(b - 0.70, 0.0);
  b = b * b * 2.0;
  c += b * u_bloom * (1.0 + u_pulse * 0.8);
  c += b * u_warm * 4.0;
  c += u_accent * b * 0.25;
  vec2 q = (v_uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  float vg = smoothstep(1.10, 0.35, length(q));
  c *= mix(1.0, vg, u_vignette);
  float g = hash(v_uv * u_res + fract(u_time) * 137.0) - 0.5;
  c += g * u_grain;
  fragColor = vec4(max(c, 0.0), 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
out vec4 fragColor;
void main() { fragColor = vec4(texture(u_scene, v_uv).rgb, 1.0); }`;

/* ------------------------------------------------------------------ helpers */

function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseColor(raw, fallback) {
  if (!raw) return fallback;
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const v = parseInt(hex[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  const m = raw.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map(function (s) { return parseFloat(s); });
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255];
  }
  return fallback;
}

/* ------------------------------------------------------------------ create */

export function create(ctx) {
  const gl = ctx.gl;
  const stage = ctx.stage;
  if (!gl || !stage) {
    return { stats() { return { degraded: true, drops: 0, post: false, layers: 0, passes: 0 }; } };
  }

  const high = ctx.quality === 'high';
  const DROPS = high ? 1500 : 480;
  const FOG = high ? 10 : 5;
  const SHAFTS = high ? 3 : 2;
  const MOTES = high ? 96 : 40;

  let frames = 0;
  let passes = 0;
  let pulse = 0;
  let postErrors = 0;
  let layerCount = 0;

  function tryProgram(vs, fs) {
    try { return stage.program(vs, fs); }
    catch (err) { if (ctx.log) ctx.log('weather shader unavailable: ' + (err && err.message)); return null; }
  }
  const rainProg = tryProgram(RAIN_VS, RAIN_FS);
  const softProg = tryProgram(SOFT_VS, SOFT_FS);
  const postProg = tryProgram(POST_VS, POST_FS);
  const blitProg = tryProgram(POST_VS, BLIT_FS);

  const quad = stage.quad();

  // A NEAREST sampler keeps the offscreen pass cheap (16F LINEAR filtering is ruinous on
  // software rasterisers) without mutating the stage-owned scene texture's own parameters.
  let nearestSampler = null;
  try {
    nearestSampler = gl.createSampler();
    gl.samplerParameteri(nearestSampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(nearestSampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.samplerParameteri(nearestSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(nearestSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  } catch (err) { nearestSampler = null; }

  const rainMesh = rainProg ? stage.mesh({
    positions: new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 2, 1, 3])
  }) : null;
  const softMesh = softProg ? stage.mesh({
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 2, 1, 3])
  }) : null;

  /* --- rain: one static instanced batch, animated entirely in the vertex shader --- */
  let rainInst = null;
  if (rainProg) {
    const rnd = mulberry32(0x2f6a11);
    const seed = new Float32Array(DROPS * 4);
    const vari = new Float32Array(DROPS * 2);
    for (let i = 0; i < DROPS; i += 1) {
      seed[i * 4] = rnd(); seed[i * 4 + 1] = rnd(); seed[i * 4 + 2] = rnd(); seed[i * 4 + 3] = rnd();
      vari[i * 2] = rnd(); vari[i * 2 + 1] = 0.55 + rnd() * 0.6;
    }
    rainInst = stage.instances(rainMesh, [
      { name: 'a_seed', data: seed, size: 4, location: 1 },
      { name: 'a_var', data: vari, size: 2, location: 2 }
    ], DROPS);
  }

  /* --- soft planes: fog banks, light shafts, motes --- */
  function buildCloud(count, place, seedHex) {
    if (!softProg || count <= 0) return null;
    const rnd = mulberry32(seedHex);
    const pos = new Float32Array(count * 3);
    const sd = new Float32Array(count * 4);
    const size = new Float32Array(count * 2);
    for (let i = 0; i < count; i += 1) {
      const p = place(rnd);
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      sd[i * 4] = rnd(); sd[i * 4 + 1] = rnd(); sd[i * 4 + 2] = rnd(); sd[i * 4 + 3] = rnd();
      size[i * 2] = p[3]; size[i * 2 + 1] = p[4];
    }
    return stage.instances(softMesh, [
      { name: 'a_pos', data: pos, size: 3, location: 1 },
      { name: 'a_seed', data: sd, size: 4, location: 2 },
      { name: 'a_size', data: size, size: 2, location: 3 }
    ], count);
  }

  const fogInst = buildCloud(FOG, (r) =>
    [r() * 32 - 16, 1.5 + r() * 6, -22 - r() * 50, 16 + r() * 26, 2.2 + r() * 3.3], 0x11aa22);
  const shaftInst = buildCloud(SHAFTS, (r) =>
    [r() * 22 - 11, 11 + r() * 10, -22 - r() * 30, 1.1 + r() * 1.9, 9 + r() * 9], 0x33cc55);
  const moteInst = buildCloud(MOTES, (r) =>
    [r() * 18 - 9, 1 + r() * 8, -16 + r() * 22, 0.03 + r() * 0.06, 0.03 + r() * 0.06], 0x77ee99);

  /* --- palette, re-read now and then so theme changes are honest --- */
  let theme = document.documentElement.getAttribute('data-theme') || 'dusk';
  let accent = [0.56, 0.72, 0.60];
  function readPalette() {
    theme = document.documentElement.getAttribute('data-theme') || 'dusk';
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      accent = parseColor(raw, accent);
    } catch (err) { /* keep the last good accent */ }
  }
  readPalette();
  function palettes() {
    if (theme === 'dawn') {
      return { rain: [0.30, 0.37, 0.45], fog: [0.82, 0.83, 0.80], shaft: [1.0, 0.66, 0.40], mote: [1.0, 0.84, 0.58] };
    }
    if (theme === 'night') {
      return { rain: [0.62, 0.74, 0.92], fog: [0.28, 0.34, 0.43], shaft: [0.95, 0.60, 0.34], mote: [1.0, 0.78, 0.50] };
    }
    return { rain: [0.64, 0.73, 0.88], fog: [0.42, 0.48, 0.55], shaft: [1.0, 0.62, 0.34], mote: [1.0, 0.80, 0.52] };
  }
  let pal = palettes();

  /* --- shared motion state, computed once per update --- */
  const VOL = [18, 9, 18];
  const center = [0, 9, 0];
  const fall = [0, -1, 0];
  let wind = 0.3;
  const cam = stage.camera;
  const aspect = () => stage.width / Math.max(1, stage.height);

  /* --- draw calls --- */
  function rainDraw() {
    if (!rainProg || !rainInst) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    rainProg.use();
    rainProg.u('u_view', cam.view()).u('u_proj', cam.proj(aspect()))
      .u('u_cam', cam.pos).u('u_center', center).u('u_vol', VOL).u('u_fall', fall)
      .u('u_time', stage.time).u('u_len', 1.05).u('u_wid', 0.0145).u('u_color', pal.rain);
    rainInst.draw(rainProg);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  function softDraw(inst, o) {
    if (!softProg || !inst) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, o.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    softProg.use();
    softProg.u('u_view', cam.view()).u('u_proj', cam.proj(aspect()))
      .u('u_time', stage.time).u('u_wind', wind).u('u_slant', o.slant || 0)
      .u('u_tint', o.tint).u('u_opacity', o.opacity).u('u_soft', o.soft || 0.5)
      .u('u_kind', o.mote ? 1 : 0).u('u_noise', o.noise || 1.4);
    inst.draw(softProg);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  if (rainInst) {
    stage.layer('rain').add({ order: 10, label: 'weather-rain', draw: rainDraw });
    layerCount += 1;
  }
  if (shaftInst) {
    stage.layer('far').add({
      order: 4, label: 'weather-shafts',
      draw() { softDraw(shaftInst, { tint: pal.shaft, opacity: 0.038 * (1 + pulse * 1.2), soft: 0.9, noise: 0.7, slant: 0.35, additive: true }); }
    });
    layerCount += 1;
  }
  if (fogInst) {
    stage.layer('far').add({
      order: 8, label: 'weather-fog',
      draw() { softDraw(fogInst, { tint: pal.fog, opacity: 0.14, soft: 0.55, noise: 1.3 }); }
    });
  }
  if (moteInst) {
    stage.layer('fx').add({
      order: 10, label: 'weather-motes',
      draw() { softDraw(moteInst, { tint: pal.mote, opacity: 0.5 * (1 + pulse * 0.8), soft: 0.6, noise: 3.5, mote: true, additive: true }); }
    });
    layerCount += 1;
  }

  /* --- present: graded pass, with plain-blit and stage-fallback safety nets --- */
  function bindSampler(on) {
    if (!nearestSampler) return;
    gl.bindSampler(0, on ? nearestSampler : null);
  }

  function blit(tex) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, stage.width, stage.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    bindSampler(true);
    blitProg.use();
    blitProg.u('u_scene', { texture: tex, unit: 0 });
    quad.draw(blitProg);
    bindSampler(false);
  }

  function present(sceneTex) {
    passes += 1;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, stage.width, stage.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      bindSampler(true);
      if (postProg) {
        const w = stage.width, h = stage.height;
        postProg.use();
        postProg.u('u_scene', { texture: sceneTex, unit: 0 });
        postProg.u('u_texel', [1 / w, 1 / h]);
        postProg.u('u_res', [w, h]);
        postProg.u('u_accent', accent);
        postProg.u('u_warm', [0.16, 0.075, 0.015]);
        postProg.u('u_bloom', high ? 0.62 : 0.4);
        postProg.u('u_vignette', 0.34);
        postProg.u('u_grain', 0.026);
        postProg.u('u_time', stage.time);
        postProg.u('u_pulse', pulse);
        quad.draw(postProg);
      } else {
        blitProg.use();
        blitProg.u('u_scene', { texture: sceneTex, unit: 0 });
        quad.draw(blitProg);
      }
      bindSampler(false);
    } catch (err) {
      postErrors += 1;
      bindSampler(false);
      try { blit(sceneTex); } catch (e2) { /* keep whatever is on screen */ }
    }
  }

  const postOwned = !!(postProg || blitProg);
  if (postOwned) stage.onPresent(present);

  /* --- events --- */
  function onHarvest() { pulse = Math.min(1, pulse + 0.8); }
  function onWilt() { pulse = Math.min(1, pulse + 0.25); }
  if (ctx.bus) { ctx.bus.on('session:harvest', onHarvest); ctx.bus.on('session:wilt', onWilt); }

  let themeClock = 0;

  return {
    update(dt) {
      frames += 1;
      pulse *= Math.exp(-dt * 0.7);
      const t = stage.time;
      const wx = 0.34 + 0.20 * Math.sin(t * 0.11) + 0.06 * Math.sin(t * 0.37);
      const wz = 0.14 * Math.sin(t * 0.07 + 1.7);
      const inv = 1 / Math.hypot(wx, 1, wz);
      fall[0] = wx * inv; fall[1] = -inv; fall[2] = wz * inv;
      wind = wx;
      center[0] = cam.target[0]; center[1] = 9; center[2] = cam.target[2];
      themeClock += dt;
      if (themeClock > 2) { themeClock = 0; readPalette(); pal = palettes(); }
    },

    stats() {
      return {
        drops: DROPS,
        post: postOwned,
        layers: layerCount,
        passes,
        frames,
        fogBanks: FOG,
        shafts: SHAFTS,
        motes: MOTES,
        quality: high ? 'high' : 'low',
        time: Math.round(stage.time * 100) / 100,
        pulse: Math.round(pulse * 1000) / 1000,
        postErrors
      };
    },

    dispose() {
      if (ctx.bus) { ctx.bus.off('session:harvest', onHarvest); ctx.bus.off('session:wilt', onWilt); }
    }
  };
}
