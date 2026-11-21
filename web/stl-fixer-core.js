/*
 * stl-fixer-core.js
 * JavaScript port of stl_fixer.py. No dependencies, runs in a browser
 * (inside a Web Worker) or in Node for testing.
 */
'use strict';
(function (root) {

  // ------------------------------------------------------------------ I/O --
  function readSTL(buf) {
    const size = buf.byteLength;
    if (size >= 84) {
      const n = new DataView(buf).getUint32(80, true);
      if (84 + 50 * n === size) return { tri: readBinary(buf, n), note: '' };
    }
    const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(size, 512))).trimStart().toLowerCase();
    if (head.startsWith('solid')) {
      const tri = readAscii(buf);
      if (tri.length) return { tri, note: '' };
    }
    if (size >= 84) {
      const n = Math.floor((size - 84) / 50);
      return { tri: readBinary(buf, n), note: `file size does not match header, recovered ${n} triangles` };
    }
    throw new Error('not a valid STL file');
  }

  function readBinary(buf, n) {
    const dv = new DataView(buf);
    const out = new Float64Array(n * 9);
    for (let i = 0; i < n; i++) {
      const off = 84 + 50 * i + 12;
      for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(off + 4 * k, true);
    }
    return out;
  }

  function readAscii(buf) {
    const text = new TextDecoder().decode(buf);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
    const vals = [];
    let m;
    while ((m = re.exec(text)) !== null) vals.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    const usable = Math.floor(vals.length / 9) * 9;
    return Float64Array.from(vals.slice(0, usable));
  }

  function writeSTL(V, F) {
    const m = F.length / 3;
    const buf = new ArrayBuffer(84 + 50 * m);
    const dv = new DataView(buf);
    const head = 'Fixed by stl-fixer';
    for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
    for (let i = head.length; i < 80; i++) dv.setUint8(i, 32);
    dv.setUint32(80, m, true);
    let off = 84;
    for (let f = 0; f < m; f++) {
      const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
      const x0 = Math.fround(V[a]), y0 = Math.fround(V[a + 1]), z0 = Math.fround(V[a + 2]);
      const x1 = Math.fround(V[b]), y1 = Math.fround(V[b + 1]), z1 = Math.fround(V[b + 2]);
      const x2 = Math.fround(V[c]), y2 = Math.fround(V[c + 1]), z2 = Math.fround(V[c + 2]);
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0, vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(off, nx / l, true); dv.setFloat32(off + 4, ny / l, true); dv.setFloat32(off + 8, nz / l, true);
      const p = [x0, y0, z0, x1, y1, z1, x2, y2, z2];
      for (let k = 0; k < 9; k++) dv.setFloat32(off + 12 + 4 * k, p[k], true);
      dv.setUint16(off + 48, 0, true);
      off += 50;
    }
    return buf;
  }

  // ----------------------------------------------------------------- mesh --
  function dropNonFinite(tri) {
    const n = tri.length / 9;
    const out = new Float64Array(tri.length);
    let k = 0;
    for (let i = 0; i < n; i++) {
      let ok = true;
      for (let j = 0; j < 9; j++) if (!Number.isFinite(tri[i * 9 + j])) { ok = false; break; }
      if (ok) { out.set(tri.subarray(i * 9, i * 9 + 9), k * 9); k++; }
    }
    return out.slice(0, k * 9);
  }

  function weld(tri, tol) {
    const nv = tri.length / 3;
    const q = new Float64Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) q[i] = Math.round(tri[i] / tol);
    let size = 1;
    while (size < nv * 2) size <<= 1;
    const mask = size - 1;
    const table = new Int32Array(size).fill(-1);
    const first = new Int32Array(nv);
    const F = new Int32Array(nv);
    let u = 0;
    for (let i = 0; i < nv; i++) {
      const x = q[3 * i], y = q[3 * i + 1], z = q[3 * i + 2];
      let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791);
      h = (h ^ (h >>> 15)) & mask;
      for (;;) {
        const t = table[h];
        if (t === -1) { table[h] = u; first[u] = i; F[i] = u; u++; break; }
        const j = first[t];
        if (q[3 * j] === x && q[3 * j + 1] === y && q[3 * j + 2] === z) { F[i] = t; break; }
        h = (h + 1) & mask;
      }
    }
    const V = new Float64Array(u * 3);
    for (let k = 0; k < u; k++) {
      const i = first[k];
      V[3 * k] = tri[3 * i]; V[3 * k + 1] = tri[3 * i + 1]; V[3 * k + 2] = tri[3 * i + 2];
    }
    return { V, F };
  }

  function faceArea(V, F, f) {
    const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }

  /** Groups half-edges by undirected edge. */
  function buildEdges(F) {
    const m = F.length / 3, H = 3 * m;
    let size = 1;
    while (size < H * 2) size <<= 1;
    const mask = size - 1;
    const table = new Int32Array(size).fill(-1);
    const inv = new Int32Array(H);
    const ea = new Int32Array(H), eb = new Int32Array(H);
    const cnt = new Int32Array(H), ssum = new Int32Array(H);
    const h1 = new Int32Array(H), h2 = new Int32Array(H);
    let E = 0;
    for (let f = 0; f < m; f++) {
      for (let k = 0; k < 3; k++) {
        const h = 3 * f + k;
        const a = F[h], b = F[3 * f + (k + 1) % 3];
        const lo = a < b ? a : b, hi = a < b ? b : a;
        let p = Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA6B);
        p = (p ^ (p >>> 15)) & mask;
        let e;
        for (;;) {
          e = table[p];
          if (e === -1) {
            e = E++;
            table[p] = e; ea[e] = lo; eb[e] = hi; h1[e] = h;
            break;
          }
          if (ea[e] === lo && eb[e] === hi) break;
          p = (p + 1) & mask;
        }
        inv[h] = e;
        if (cnt[e] === 1) h2[e] = h;
        cnt[e]++;
        ssum[e] += a < b ? 1 : -1;
      }
    }
    return { E, inv, ea, eb, cnt, ssum, h1, h2 };
  }

  function edgeStats(F) {
    if (F.length === 0) return { open: 0, nonmanifold: 0, inconsistent: 0 };
    const { E, cnt, ssum } = buildEdges(F);
    let open = 0, nm = 0, inc = 0;
    for (let e = 0; e < E; e++) {
      if (cnt[e] === 1) open++;
      else if (cnt[e] > 2) nm++;
      else if (cnt[e] === 2 && Math.abs(ssum[e]) === 2) inc++;
    }
    return { open, nonmanifold: nm, inconsistent: inc };
  }

  function degenerateMask(V, F, eps) {
    const m = F.length / 3;
    const mask = new Uint8Array(m);
    let n = 0;
    for (let f = 0; f < m; f++) {
      const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
      if (a === b || b === c || a === c || faceArea(V, F, f) <= eps) { mask[f] = 1; n++; }
    }
    return { mask, count: n };
  }

  function duplicateMask(F) {
    const m = F.length / 3;
    const mask = new Uint8Array(m);
    const seen = new Set();
    let n = 0;
    for (let f = 0; f < m; f++) {
      let a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2], t;
      if (a > b) { t = a; a = b; b = t; }
      if (b > c) { t = b; b = c; c = t; }
      if (a > b) { t = a; a = b; b = t; }
      const key = a + ',' + b + ',' + c;
      if (seen.has(key)) { mask[f] = 1; n++; } else seen.add(key);
    }
    return { mask, count: n };
  }

  function dropFaces(F, dropMask) {
    const m = F.length / 3;
    let keep = 0;
    for (let f = 0; f < m; f++) if (!dropMask[f]) keep++;
    const out = new Int32Array(keep * 3);
    let k = 0;
    for (let f = 0; f < m; f++) {
      if (dropMask[f]) continue;
      out[k++] = F[3 * f]; out[k++] = F[3 * f + 1]; out[k++] = F[3 * f + 2];
    }
    return out;
  }

  function removeNonmanifold(V, F) {
    let removed = 0;
    for (let iter = 0; iter < 50; iter++) {
      const { E, inv, cnt } = buildEdges(F);
      let any = false;
      for (let e = 0; e < E; e++) if (cnt[e] > 2) { any = true; break; }
      if (!any) break;
      const perEdge = new Map();
      for (let h = 0; h < inv.length; h++) {
        const e = inv[h];
        if (cnt[e] > 2) {
          let l = perEdge.get(e);
          if (!l) perEdge.set(e, (l = []));
          l.push((h / 3) | 0);
        }
      }
      const drop = new Set();
      for (const faces0 of perEdge.values()) {
        const faces = faces0.filter((f) => !drop.has(f));
        if (faces.length <= 2) continue;
        faces.sort((x, y) => faceArea(V, F, y) - faceArea(V, F, x));
        for (let i = 2; i < faces.length; i++) drop.add(faces[i]);
      }
      if (!drop.size) break;
      const mask = new Uint8Array(F.length / 3);
      for (const f of drop) mask[f] = 1;
      removed += drop.size;
      F = dropFaces(F, mask);
    }
    return { F, removed };
  }

  /** Consistent winding per shell; optionally flips closed inside-out shells. */
  function orient(V, F0, fixVolume) {
    const m = F0.length / 3;
    if (m === 0) return { F: F0, flipped: 0, ncomp: 0, inverted: 0 };
    const F = F0.slice();
    const { E, inv, cnt, h1, h2 } = buildEdges(F);
    const dirSign = (h) => {
      const f = (h / 3) | 0, k = h % 3;
      return F[h] < F[3 * f + (k + 1) % 3] ? 1 : -1;
    };
    const deg = new Int32Array(m + 1);
    for (let e = 0; e < E; e++) if (cnt[e] === 2) { deg[((h1[e] / 3) | 0) + 1]++; deg[((h2[e] / 3) | 0) + 1]++; }
    for (let i = 0; i < m; i++) deg[i + 1] += deg[i];
    const fill = deg.slice(0, m);
    const dst = new Int32Array(deg[m]);
    const same = new Uint8Array(deg[m]);
    for (let e = 0; e < E; e++) {
      if (cnt[e] !== 2) continue;
      const f1 = (h1[e] / 3) | 0, f2 = (h2[e] / 3) | 0;
      const s = dirSign(h1[e]) === dirSign(h2[e]) ? 1 : 0;
      dst[fill[f1]] = f2; same[fill[f1]++] = s;
      dst[fill[f2]] = f1; same[fill[f2]++] = s;
    }
    const flip = new Uint8Array(m);
    const comp = new Int32Array(m).fill(-1);
    const queue = new Int32Array(m);
    let ncomp = 0;
    for (let seed = 0; seed < m; seed++) {
      if (comp[seed] !== -1) continue;
      comp[seed] = ncomp;
      let qh = 0, qt = 0;
      queue[qt++] = seed;
      while (qh < qt) {
        const f = queue[qh++];
        const ff = flip[f];
        for (let k = deg[f]; k < deg[f + 1]; k++) {
          const g = dst[k];
          if (comp[g] === -1) {
            comp[g] = ncomp;
            flip[g] = ff ^ same[k];
            queue[qt++] = g;
          }
        }
      }
      ncomp++;
    }
    let flipped = 0;
    const swap = (f) => { const t = F[3 * f]; F[3 * f] = F[3 * f + 2]; F[3 * f + 2] = t; };
    for (let f = 0; f < m; f++) if (flip[f]) { swap(f); flipped++; }

    let inverted = 0;
    if (fixVolume) {
      const open = new Uint8Array(ncomp);
      for (let h = 0; h < inv.length; h++) if (cnt[inv[h]] !== 2) open[comp[(h / 3) | 0]] = 1;
      const vol = new Float64Array(ncomp);
      for (let f = 0; f < m; f++) {
        const a = 3 * F[3 * f], b = 3 * F[3 * f + 1], c = 3 * F[3 * f + 2];
        const cx = V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1];
        const cy = V[b + 2] * V[c] - V[b] * V[c + 2];
        const cz = V[b] * V[c + 1] - V[b + 1] * V[c];
        vol[comp[f]] += (V[a] * cx + V[a + 1] * cy + V[a + 2] * cz) / 6;
      }
      const neg = new Uint8Array(ncomp);
      for (let c = 0; c < ncomp; c++) if (vol[c] < 0 && !open[c]) { neg[c] = 1; inverted++; }
      if (inverted) for (let f = 0; f < m; f++) if (neg[comp[f]]) { swap(f); flipped++; }
    }
    return { F, flipped, ncomp, inverted };
  }

  // -------------------------------------------------------- hole filling --
  function boundaryLoops(F, edges) {
    const { E, cnt, h1 } = edges;
    const nxt = new Map();
    for (let e = 0; e < E; e++) {
      if (cnt[e] !== 1) continue;
      const h = h1[e], f = (h / 3) | 0, k = h % 3;
      const a = F[h], b = F[3 * f + (k + 1) % 3];
      let l = nxt.get(b);
      if (!l) nxt.set(b, (l = []));
      l.push(a);
    }
    const loops = [];
    while (nxt.size) {
      const start = nxt.keys().next().value;
      const path = [start];
      const pos = new Map([[start, 0]]);
      while (path.length) {
        const cur = path[path.length - 1];
        const outs = nxt.get(cur);
        if (!outs || !outs.length) break;
        const v = outs.pop();
        if (!outs.length) nxt.delete(cur);
        if (pos.has(v)) {
          const i = pos.get(v);
          loops.push(path.slice(i));
          for (let j = i + 1; j < path.length; j++) pos.delete(path[j]);
          path.length = i + 1;
          if (path.length === 1 && !nxt.has(path[0])) break;
        } else {
          pos.set(v, path.length);
          path.push(v);
        }
      }
      nxt.delete(start);
      for (const x of path) { const o = nxt.get(x); if (o && !o.length) nxt.delete(x); }
    }
    return loops;
  }

  function earClip(px, py, idx, existing, nV) {
    const n = idx.length;
    const verts = [];
    for (let i = 0; i < n; i++) verts.push(i);
    const tris = [];
    const cross = (o, a, b) => (px[a] - px[o]) * (py[b] - py[o]) - (py[a] - py[o]) * (px[b] - px[o]);
    let guard = 0;
    while (verts.length > 3 && guard < 10 * n) {
      guard++;
      let found = false;
      const L = verts.length;
      for (let i = 0; i < L; i++) {
        const a = verts[(i - 1 + L) % L], b = verts[i], c = verts[(i + 1) % L];
        if (cross(a, b, c) <= 1e-18) continue;
        let ok = true;
        for (let k = 0; k < L; k++) {
          const p = verts[k];
          if (p === a || p === b || p === c) continue;
          if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) { ok = false; break; }
        }
        const lo = Math.min(idx[a], idx[c]), hi = Math.max(idx[a], idx[c]);
        const dk = lo * nV + hi;
        if (ok && existing.has(dk)) ok = false;
        if (ok) {
          existing.add(dk);
          tris.push([idx[a], idx[b], idx[c]]);
          verts.splice(i, 1);
          found = true;
          break;
        }
      }
      if (!found) return null;
    }
    if (verts.length === 3) tris.push([idx[verts[0]], idx[verts[1]], idx[verts[2]]]);
    return tris;
  }

  function fillHoles(V, F) {
    const edges = buildEdges(F);
    const loops = boundaryLoops(F, edges);
    if (!loops.length) return { V, F, filled: 0, skipped: 0 };
    const nV = V.length / 3;
    const existing = new Set();
    for (let e = 0; e < edges.E; e++) existing.add(edges.ea[e] * nV + edges.eb[e]);
    const newFaces = [];
    const newVerts = [];
    let filled = 0, skipped = 0;
    for (const loop of loops) {
      const n = loop.length;
      if (n < 3) { skipped++; continue; }
      const P = loop.map((i) => [V[3 * i], V[3 * i + 1], V[3 * i + 2]]);
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const nl = Math.hypot(nx, ny, nz);
      let tris = null;
      if (n === 3) {
        tris = [[loop[0], loop[1], loop[2]]];
      } else if (nl > 1e-18 && n <= 200) {
        nx /= nl; ny /= nl; nz /= nl;
        const ref = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        let ux = ny * ref[2] - nz * ref[1], uy = nz * ref[0] - nx * ref[2], uz = nx * ref[1] - ny * ref[0];
        const ul = Math.hypot(ux, uy, uz);
        ux /= ul; uy /= ul; uz /= ul;
        const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
        const px = P.map((p) => p[0] * ux + p[1] * uy + p[2] * uz);
        const py = P.map((p) => p[0] * vx + p[1] * vy + p[2] * vz);
        tris = earClip(px, py, loop, existing, nV);
      }
      if (!tris) {
        const c = [0, 0, 0];
        for (const p of P) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
        newVerts.push([c[0] / n, c[1] / n, c[2] / n]);
        const ci = nV + newVerts.length - 1;
        tris = [];
        for (let i = 0; i < n; i++) tris.push([loop[i], loop[(i + 1) % n], ci]);
      }
      for (const t of tris) newFaces.push(t);
      filled++;
    }
    if (newVerts.length) {
      const V2 = new Float64Array(V.length + newVerts.length * 3);
      V2.set(V);
      newVerts.forEach((p, i) => V2.set(p, V.length + 3 * i));
      V = V2;
    }
    if (newFaces.length) {
      const F2 = new Int32Array(F.length + newFaces.length * 3);
      F2.set(F);
      newFaces.forEach((t, i) => F2.set(t, F.length + 3 * i));
      F = F2;
    }
    return { V, F, filled, skipped };
  }

  function compact(V, F) {
    const nV = V.length / 3;
    const remap = new Int32Array(nV).fill(-1);
    for (let i = 0; i < F.length; i++) remap[F[i]] = 0;
    let k = 0;
    for (let i = 0; i < nV; i++) if (remap[i] === 0) remap[i] = k++;
    const V2 = new Float64Array(k * 3);
    for (let i = 0; i < nV; i++) {
      const r = remap[i];
      if (r >= 0) { V2[3 * r] = V[3 * i]; V2[3 * r + 1] = V[3 * i + 1]; V2[3 * r + 2] = V[3 * i + 2]; }
    }
    const F2 = new Int32Array(F.length);
    for (let i = 0; i < F.length; i++) F2[i] = remap[F[i]];
    return { V: V2, F: F2 };
  }

  // ------------------------------------------------------------- pipeline --
  const KEYS = ['degenerate', 'duplicate', 'nonmanifold', 'open', 'inconsistent', 'inverted'];
  const countIssues = (r) => KEYS.reduce((s, k) => s + (r[k] || 0), 0);
  const fmt = (n) => n.toLocaleString('en-US');
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function analyse(V, F, eps) {
    const r = { degenerate: degenerateMask(V, F, eps).count, duplicate: duplicateMask(F).count };
    Object.assign(r, edgeStats(F));
    r.inverted = 0;
    return r;
  }

  /**
   * Repairs an STL given as ArrayBuffer.
   * rep = { start(label), done(label, text, level, ms), detail(text) }
   */
  function fixMesh(buffer, rep) {
    rep = rep || { start() {}, done() {}, detail() {} };
    const step = (label, fn) => {
      rep.start(label);
      const t0 = now();
      const r = fn();
      rep.done(label, r.text, r.level || 'ok', now() - t0);
      return r.value;
    };

    const read = step('Reading', () => {
      const { tri, note } = readSTL(buffer);
      const clean = dropNonFinite(tri);
      if (clean.length === 0) throw new Error('no triangles found');
      return { value: clean, text: `${fmt(clean.length / 9)} triangles` + (note ? '  ' + note : ''), level: note ? 'warn' : 'ok' };
    });
    const tri = read;

    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tri.length; i += 3) for (let k = 0; k < 3; k++) {
      if (tri[i + k] < lo[k]) lo[k] = tri[i + k];
      if (tri[i + k] > hi[k]) hi[k] = tri[i + k];
    }
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    const tol = Math.max(diag * 1e-7, 1e-9);
    const eps = diag * diag * 1e-12;

    let { V, F } = step('Welding vertices', () => {
      const w = weld(tri, tol);
      return { value: w, text: `${fmt(tri.length / 3)} → ${fmt(w.V.length / 3)} vertices` };
    });
    const facesIn = F.length / 3;

    const before = step('Analysing', () => {
      const b = analyse(V, F, eps);
      b.inverted = orient(V, F, true).inverted;
      const n = countIssues(b);
      return { value: b, text: n ? `${fmt(n)} findings` : 'no issues found', level: n ? 'warn' : 'ok' };
    });
    const nBefore = countIssues(before);
    if (nBefore) {
      rep.detail(KEYS.filter((k) => before[k]).map((k) => `${fmt(before[k])} ${k}`).join(', '));
    }

    step('Removing degenerate / duplicate', () => {
      const d = degenerateMask(V, F, eps);
      F = dropFaces(F, d.mask);
      const u = duplicateMask(F);
      F = dropFaces(F, u.mask);
      return { text: `${fmt(d.count)} degenerate, ${fmt(u.count)} duplicate removed` };
    });

    for (let p = 1; p <= 6; p++) {
      let done = false;
      step(`Repair pass ${p}`, () => {
        const parts = [];
        if (p > 1) {
          const { inv, cnt } = buildEdges(F);
          const badv = new Uint8Array(V.length / 3);
          for (let h = 0; h < inv.length; h++) {
            if (cnt[inv[h]] !== 2) {
              const f = (h / 3) | 0, k = h % 3;
              badv[F[h]] = 1; badv[F[3 * f + (k + 1) % 3]] = 1;
            }
          }
          const hit = new Uint8Array(F.length / 3);
          let n = 0;
          for (let f = 0; f < hit.length; f++) {
            if (badv[F[3 * f]] || badv[F[3 * f + 1]] || badv[F[3 * f + 2]]) { hit[f] = 1; n++; }
          }
          F = dropFaces(F, hit);
          parts.push(`cut ${fmt(n)} tris around bad spots`);
        }
        F = dropFaces(F, degenerateMask(V, F, eps).mask);
        F = dropFaces(F, duplicateMask(F).mask);
        const nm = removeNonmanifold(V, F);
        F = nm.F;
        if (nm.removed) parts.push(`${fmt(nm.removed)} non-manifold tris dropped`);
        const o1 = orient(V, F, false);
        F = o1.F;
        if (o1.flipped) parts.push(`${fmt(o1.flipped)} flipped`);
        const fh = fillHoles(V, F);
        V = fh.V; F = fh.F;
        if (fh.filled) parts.push(`${fmt(fh.filled)} hole(s) filled`);
        const o2 = orient(V, F, true);
        F = o2.F;
        if (o2.inverted) parts.push(`${fmt(o2.inverted)} inside-out shell(s) flipped`);
        ({ V, F } = compact(V, F));
        const es = edgeStats(F);
        const left = es.open + es.nonmanifold + es.inconsistent;
        const res = parts.join(', ') || 'nothing to do';
        if (left) return { text: `${res}  → ${left} edge problem(s) left`, level: 'warn' };
        done = true;
        return { text: res };
      });
      if (done) break;
    }

    const out = step('Writing', () => {
      const buf = writeSTL(V, F);
      return { value: buf, text: `${fmt(F.length / 3)} triangles` };
    });

    const after = step('Verifying result', () => {
      const t2 = readSTL(out).tri;
      const w2 = weld(t2, tol);
      const a = analyse(w2.V, w2.F, eps);
      const n = countIssues(a);
      return {
        value: a,
        text: n ? KEYS.filter((k) => a[k]).map((k) => `${a[k]} ${k}`).join(', ') : 'no issues left',
        level: n ? 'warn' : 'ok',
      };
    });

    return { before, after, nBefore, nAfter: countIssues(after), facesIn, facesOut: F.length / 3, buffer: out };
  }

  const api = { fixMesh, readSTL, writeSTL, weld, countIssues, KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StlFixer = api;
})(typeof self !== 'undefined' ? self : globalThis);
