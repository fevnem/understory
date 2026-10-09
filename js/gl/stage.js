// js/gl/stage.js — the WebGL2 spine every GL hand builds on (api frozen in docs/CONTRACT.md §8).
// Deliberately small: context, column-major mat4, program/uniform/attribute helpers, meshes,
// instancing, a fixed layer draw order, and an optional offscreen pass for a post-processing hand.
// No hand writes raw GL state juggling; if something is missing here, ask the manager instead.

/* ---------------------------------------------------------------- mat4 (column-major) */

const mat4 = {
  create() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },

  identity(out) { out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); return out; },

  perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    out.set([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    return out;
  },

  lookAt(out, eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out.set([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1
    ]);
    return out;
  },

  mul(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    for (let i = 0; i < 4; i += 1) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
      out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    }
    return out;
  },

  translate(out, m, v) {
    if (out !== m) out.set(m);
    out[12] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
    out[13] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
    out[14] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
    out[15] = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
    return out;
  },

  scale(out, m, v) {
    out[0] = m[0] * v[0]; out[1] = m[1] * v[0]; out[2] = m[2] * v[0]; out[3] = m[3] * v[0];
    out[4] = m[4] * v[1]; out[5] = m[5] * v[1]; out[6] = m[6] * v[1]; out[7] = m[7] * v[1];
    out[8] = m[8] * v[2]; out[9] = m[9] * v[2]; out[10] = m[10] * v[2]; out[11] = m[11] * v[2];
    if (out !== m) { out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15]; }
    return out;
  },

  rotateY(out, m, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    if (out !== m) out.set(m);
    out[0] = a00 * c - a20 * s; out[1] = a01 * c - a21 * s; out[2] = a02 * c - a22 * s; out[3] = a03 * c - a23 * s;
    out[8] = a00 * s + a20 * c; out[9] = a01 * s + a21 * c; out[10] = a02 * s + a22 * c; out[11] = a03 * s + a23 * c;
    return out;
  },

  rotateX(out, m, rad) {
    const s = Math.sin(rad), c = Math.cos(rad);
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7], a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    if (out !== m) out.set(m);
    out[4] = a10 * c + a20 * s; out[5] = a11 * c + a21 * s; out[6] = a12 * c + a22 * s; out[7] = a13 * c + a23 * s;
    out[8] = a20 * c - a10 * s; out[9] = a21 * c - a11 * s; out[10] = a22 * c - a12 * s; out[11] = a23 * c - a13 * s;
    return out;
  },

  invert(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) { mat4.identity(out); return out; }
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  },

  transformPoint(out, m, p) {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
  }
};

/* ---------------------------------------------------------------- stage */

const LAYERS = ['sky', 'far', 'mid', 'near', 'rain', 'fx'];

const PRESENT_VS = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const PRESENT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
out vec4 fragColor;
void main() { fragColor = vec4(texture(u_scene, v_uv).rgb, 1.0); }`;

// Built-in fallback sky. Drawn only while nothing has claimed the 'sky' layer, so the app is
// never a black void: dark at the top, a lighter band at the horizon, a soft glow on it, and
// darker ground below. A real forest module simply takes the layer over and this stops drawing.
const SKY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform vec3 u_top;
uniform vec3 u_horizon;
uniform vec3 u_ground;
uniform vec3 u_glow;
uniform float u_amount;
uniform float u_h;
void main() {
  float y = v_uv.y;
  float above = clamp((y - u_h) / max(0.001, 1.0 - u_h), 0.0, 1.0);
  vec3 sky = mix(u_horizon, u_top, pow(above, 0.75));
  vec3 col = mix(u_ground, sky, smoothstep(u_h - 0.008, u_h + 0.008, y));
  col += u_glow * exp(-pow((y - u_h) * 11.0, 2.0)) * u_amount;
  fragColor = vec4(col, 1.0);
}`;

export function createStage(opts) {
  const canvas = opts.canvas;
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: opts.antialias !== false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance'
  });
  if (!gl) return null;

  let dpr = Math.min(opts.dprCap || 2, Math.max(1, window.devicePixelRatio || 1));
  if (opts.quality === 'low') dpr = 1;

  const floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  const clear = opts.clearColor || [0.05, 0.06, 0.07, 1];
  const programs = new Map();
  const layerMap = new Map();
  for (const name of LAYERS) layerMap.set(name, { name, objects: [], add(obj) { this.objects.push(obj); return obj; } });

  let presentHook = null;
  let frameCount = 0;
  let lost = false;

  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); lost = true; }, false);
  canvas.addEventListener('webglcontextrestored', function () { lost = false; programs.clear(); }, false);

  /* ---- programs ---- */

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || 'unknown shader error';
      gl.deleteShader(sh);
      throw new Error('shader: ' + log);
    }
    return sh;
  }

  function program(vsSrc, fsSrc) {
    const key = vsSrc + '\u0000' + fsSrc;
    const hit = programs.get(key);
    if (hit) return hit;
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + (gl.getProgramInfoLog(prog) || 'unknown'));
    }
    const uLoc = new Map(), aLoc = new Map();

    const api = {
      prog,
      use() { gl.useProgram(prog); return api; },
      /** u('u_name', 1.0 | [3] | Float32Array(16) | { texture } ) */
      u(name, value) {
        let loc = uLoc.get(name);
        if (loc === undefined) { loc = gl.getUniformLocation(prog, name); uLoc.set(name, loc); }
        if (loc === null || loc === undefined) return api;
        if (typeof value === 'number') gl.uniform1f(loc, value);
        else if (typeof value === 'boolean') gl.uniform1i(loc, value ? 1 : 0);
        else if (value && value.texture) { gl.activeTexture(gl.TEXTURE0 + (value.unit || 0)); gl.bindTexture(gl.TEXTURE_2D, value.texture); gl.uniform1i(loc, value.unit || 0); }
        else if (value && value.length === 16) gl.uniformMatrix4fv(loc, false, value);
        else if (value && value.length === 9) gl.uniformMatrix3fv(loc, false, value);
        else if (value && value.length === 4) gl.uniform4fv(loc, value);
        else if (value && value.length === 3) gl.uniform3fv(loc, value);
        else if (value && value.length === 2) gl.uniform2fv(loc, value);
        else if (value && value.length) gl.uniform1fv(loc, value);
        return api;
      },
      /** a('a_position', bufferHandle|WebGLBuffer, { size, type, normalized, stride, offset, divisor }) */
      a(name, buf, o) {
        const spec = o || {};
        let loc = aLoc.get(name);
        if (loc === undefined) { loc = gl.getAttribLocation(prog, name); aLoc.set(name, loc); }
        if (loc < 0) return api;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf && buf.buf ? buf.buf : buf);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, spec.size || 3, spec.type || gl.FLOAT, !!spec.normalized, spec.stride || 0, spec.offset || 0);
        gl.vertexAttribDivisor(loc, spec.divisor || 0);
        return api;
      }
    };
    programs.set(key, api);
    return api;
  }

  /* ---- buffers, meshes, instancing ---- */

  function buffer(data, o) {
    const spec = o || {};
    const target = spec.target || gl.ARRAY_BUFFER;
    const buf = gl.createBuffer();
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, spec.usage || gl.STATIC_DRAW);
    return { buf, count: spec.count || (data.length / (spec.size || 1)), mode: spec.mode || gl.TRIANGLES, target };
  }

  function mesh(geometry) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const parts = {};
    parts.positions = buffer(geometry.positions, { size: 3 });
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (geometry.normals) {
      parts.normals = buffer(geometry.normals, { size: 3 });
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    }
    if (geometry.uvs) {
      parts.uvs = buffer(geometry.uvs, { size: 2 });
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    }
    let indexBuf = null, indexCount = 0;
    if (geometry.indices) {
      indexBuf = buffer(geometry.indices, { target: gl.ELEMENT_ARRAY_BUFFER, size: 1 });
      indexCount = geometry.indices.length;
      parts.indices = indexBuf;
    }
    gl.bindVertexArray(null);
    return {
      vao, parts, count: geometry.positions.length / 3, indexCount,
      vertexCount: indexCount || geometry.positions.length / 3,
      mode: geometry.mode || gl.TRIANGLES,
      draw(p) {
        if (p) p.use();
        gl.bindVertexArray(vao);
        if (indexBuf) gl.drawElements(this.mode, indexCount, gl.UNSIGNED_SHORT, 0);
        else gl.drawArrays(this.mode, 0, this.count);
        gl.bindVertexArray(null);
      }
    };
  }

  /** Instanced draw: attrs = [{ name, data, size, stride, offset }] with divisor 1. */
  function instances(meshHandle, attrs, count) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    // re-bind the mesh's own buffers into this vao
    const base = meshHandle.parts;
    gl.bindBuffer(gl.ARRAY_BUFFER, base.positions.buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (base.normals) { gl.bindBuffer(gl.ARRAY_BUFFER, base.normals.buf); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0); }
    if (base.uvs) { gl.bindBuffer(gl.ARRAY_BUFFER, base.uvs.buf); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0); }
    // The element array binding is part of VAO state: an instanced VAO that never binds it
    // draws nothing at all (silently — the draw call still "happens").
    if (base.indices) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, base.indices.buf);
    const list = attrs || [];
    const store = new Map();
    for (const at of list) {
      const loc = at.location !== undefined ? at.location : null;
      const p = at.program || null;
      const attrLoc = p ? p.locationOf(at.name) : loc;
      if (attrLoc === null || attrLoc === undefined || attrLoc < 0) continue;
      const b = buffer(at.data, { size: at.size || 1, usage: gl.DYNAMIC_DRAW });
      store.set(at.name, { buf: b.buf, size: at.size || 1 });
      gl.enableVertexAttribArray(attrLoc);
      gl.vertexAttribPointer(attrLoc, at.size || 1, at.type || gl.FLOAT, !!at.normalized, at.stride || 0, at.offset || 0);
      gl.vertexAttribDivisor(attrLoc, 1);
    }
    gl.bindVertexArray(null);
    return {
      vao, count,
      /** Rewrite one instance attribute in place (no new buffers — safe to call every frame). */
      update(name, data) {
        const slot = store.get(name);
        if (!slot) return false;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, slot.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
        gl.bindVertexArray(null);
        return true;
      },
      /** Free the GPU buffers — call before rebuilding a dynamically sized instanced mesh. */
      release() {
        for (const slot of store.values()) gl.deleteBuffer(slot.buf);
        gl.deleteVertexArray(vao);
        store.clear();
      },
      draw(p) {
        if (p) p.use();
        // divisor attributes must be re-pointed per program only if locations differ;
        // the manager's convention is one shader per instanced mesh, so the vao holds them.
        gl.bindVertexArray(vao);
        if (meshHandle.indexCount) gl.drawElementsInstanced(meshHandle.mode, meshHandle.indexCount, gl.UNSIGNED_SHORT, 0, count);
        else gl.drawArraysInstanced(meshHandle.mode, 0, meshHandle.count, count);
        gl.bindVertexArray(null);
      }
    };
  }

  /** Fullscreen triangle in clip space — the post pass and any full-screen work uses this. */
  function quad() {
    const b = buffer(new Float32Array([-1, -1, 3, -1, -1, 3]), { size: 2 });
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return {
      vao,
      draw(p) {
        if (p) p.use();
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
      }
    };
  }

  function texture(source, o) {
    const spec = o || {};
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const data = typeof source === 'function' ? source(spec.width || 256, spec.height || 256) : source;
    gl.texImage2D(gl.TEXTURE_2D, 0, spec.internal || gl.RGBA, spec.width || 256, spec.height || 256, 0,
      spec.format || gl.RGBA, spec.type || gl.UNSIGNED_BYTE, data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, spec.wrap || gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, spec.wrap || gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, spec.filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, spec.filter || gl.LINEAR);
    if (spec.mips) gl.generateMipmap(gl.TEXTURE_2D);
    if (aniso && spec.aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, spec.aniso));
    return { texture: tex, unit: 0, bind(unit) { this.unit = unit || 0; gl.activeTexture(gl.TEXTURE0 + this.unit); gl.bindTexture(gl.TEXTURE_2D, tex); return this; } };
  }

  /* ---- camera ---- */

  const camera = {
    pos: [0, 2.2, 9],
    target: [0, 1.6, 0],
    up: [0, 1, 0],
    fov: Math.PI / 3.2,
    near: 0.1,
    far: 220,
    _view: mat4.create(),
    _proj: mat4.create(),
    view() { return mat4.lookAt(this._view, this.pos, this.target, this.up); },
    proj(aspect) { return mat4.perspective(this._proj, this.fov, aspect || 1, this.near, this.far); },
    orbit(azimuth, elevation, radius, target) {
      const t = target || [0, 1.6, 0];
      const ce = Math.cos(elevation);
      this.pos = [t[0] + Math.sin(azimuth) * radius * ce, t[1] + Math.sin(elevation) * radius, t[2] + Math.cos(azimuth) * radius * ce];
      this.target = t;
      return this;
    },
    look(at) { this.target = at; return this; }
  };

  /* ---- offscreen target for a post pass ---- */

  let fb = null;
  function makeFramebuffer(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, floatTargets ? gl.RGBA16F : gl.RGBA, w, h, 0, gl.RGBA, floatTargets ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, depth, w, h, complete: ok, bind() { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); } };
  }

  function framebuffer() {
    if (!fb) fb = makeFramebuffer(canvas.width, canvas.height);
    return fb.complete ? fb : null;
  }

  const presentProg = program(PRESENT_VS, PRESENT_FS);
  const fullQuad = quad();

  /* ---- fallback sky (see SKY_FS) ---- */

  function tokenRGB(name, fallback) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const m = raw.match(/^#([0-9a-f]{6})$/i);
    if (!m) return fallback;
    const v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  const skyProg = program(PRESENT_VS, SKY_FS);
  const skyColors = {
    base: tokenRGB('--sky-base', [0.043, 0.067, 0.078]),
    accent: tokenRGB('--accent', [0.56, 0.72, 0.60])
  };
  function skyPalette() {
    const b = skyColors.base;
    const a = skyColors.accent;
    return {
      top: [b[0] * 0.72, b[1] * 0.78, b[2] * 0.9],
      horizon: [b[0] * 1.9 + a[0] * 0.22, b[1] * 1.85 + a[1] * 0.2, b[2] * 1.8 + a[2] * 0.16],
      ground: [b[0] * 0.42, b[1] * 0.44, b[2] * 0.48],
      glow: [a[0] * 0.3, a[1] * 0.28, a[2] * 0.24]
    };
  }

  /** Re-read the theme tokens (call after the theme changes). */
  function refreshSky() {
    skyColors.base = tokenRGB('--sky-base', skyColors.base);
    skyColors.accent = tokenRGB('--accent', skyColors.accent);
  }

  /* ---- frame ---- */

  const stage = {
    gl, canvas, mat4, camera, quality: opts.quality || 'high',
    time: 0, frameCount: 0, layers: LAYERS.slice(), LAYER_NAMES: LAYERS,
    width: 1, height: 1, dpr,
    get contextLost() { return lost; },
    program, buffer, mesh, instances, quad, texture, framebuffer,
    refreshSky,
    layer(name) { return layerMap.get(name) || null; },
    onPresent(fn) { presentHook = fn; return true; },
    uniform(api, name, value) { return api.u(name, value); },

    resize(w, h, nextDpr) {
      dpr = nextDpr || dpr;
      const pw = Math.max(1, Math.round(w * dpr));
      const ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw; canvas.height = ph;
      }
      this.width = pw; this.height = ph; this.dpr = dpr;
      camera.aspect = pw / ph;
      if (fb && (fb.w !== pw || fb.h !== ph)) {
        gl.deleteTexture(fb.tex); gl.deleteFramebuffer(fb.fbo); gl.deleteRenderbuffer(fb.depth);
        fb = null;
      }
      return this;
    },

    clear(rgba) {
      gl.clearColor(rgba ? rgba[0] : clear[0], rgba ? rgba[1] : clear[1], rgba ? rgba[2] : clear[2], rgba ? rgba[3] : clear[3]);
      gl.clearDepth(1);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },

    /** Draw every layer in the frozen order, then present (post pass if one is registered). */
    frame(dt) {
      this.time += dt;
      this.frameCount += 1;
      frameCount = this.frameCount;
      const f = { stage: this, time: this.time, dt, w: this.width, h: this.height, camera, mat4, aspect: this.width / this.height, quality: this.quality };

      const usePost = !!presentHook && !!floatTargetsAllowPost();
      const target = usePost ? framebuffer() : null;

      if (target) { target.bind(); this.clear(); }
      else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.width, this.height); this.clear(); }

      // Nothing has claimed the 'sky' layer (no forest module, or it has not loaded): draw the
      // built-in gradient so the scene still reads as a sky over ground rather than black.
      const skyBucket = layerMap.get('sky');
      if (this.skyFallback !== false && skyBucket && skyBucket.objects.length === 0) {
        const p = skyPalette();
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        skyProg.use();
        skyProg.u('u_top', p.top);
        skyProg.u('u_horizon', p.horizon);
        skyProg.u('u_ground', p.ground);
        skyProg.u('u_glow', p.glow);
        skyProg.u('u_amount', 1);
        skyProg.u('u_h', 0.42);
        fullQuad.draw(skyProg);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
      }

      for (const name of LAYERS) {
        const bucket = layerMap.get(name);
        if (!bucket || !bucket.objects.length) continue;
        const ordered = bucket.objects.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
        for (const obj of ordered) {
          if (obj.visible === false || typeof obj.draw !== 'function') continue;
          try { obj.draw(f); } catch (err) { onceDrawError(obj, err); }
        }
      }

      if (target) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        gl.disable(gl.DEPTH_TEST);
        if (!presentHook) this.defaultPresent(target);
        else {
          try { presentHook(target.tex, f); }
          catch (err) { onceDrawError({ label: 'present' }, err); this.defaultPresent(target); }
        }
      }
      return f;
    },

    defaultPresent(target) {
      presentProg.use();
      presentProg.u('u_scene', target.tex, 0);
      fullQuad.draw(presentProg);
    }
  };

  let drawErrors = 0;
  function onceDrawError(obj, err) {
    drawErrors += 1;
    if (drawErrors < 6) console.warn('[understory] draw failed' + (obj && obj.label ? ' (' + obj.label + ')' : '') + ':', err && err.message);
  }
  function floatTargetsAllowPost() { return true; }

  stage.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, dpr);

  return stage;
}
