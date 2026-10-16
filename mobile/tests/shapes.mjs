// Test meshes as triangle soups (Float32Array, 9 floats per triangle), outward normals.

export function box(x0, y0, z0, x1, y1, z1) {
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(f.flatMap((q) => q.flatMap((i) => c[i])));
}

export const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export function flip(tris) {
  const out = tris.slice();
  for (let i = 0; i < out.length; i += 9) for (let k = 0; k < 3; k++) [out[i + 3 + k], out[i + 6 + k]] = [out[i + 6 + k], out[i + 3 + k]];
  return out;
}

// A tube: outer radius R, inner radius r, height h, n segments, centred at (cx, cy).
export function tube(cx, cy, R, r, h, n = 48) {
  const t = [];
  const p = (rad, a, z) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a), z];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, b = (2 * Math.PI * (i + 1)) / n;
    const o0 = p(R, a, 0), o1 = p(R, b, 0), O0 = p(R, a, h), O1 = p(R, b, h);
    const i0 = p(r, a, 0), i1 = p(r, b, 0), I0 = p(r, a, h), I1 = p(r, b, h);
    t.push(o0, o1, O1, o0, O1, O0); // outer wall, facing out
    t.push(i0, I1, i1, i0, I0, I1); // inner wall, facing the axis
    t.push(O0, O1, I1, O0, I1, I0); // top
    t.push(o0, i1, o1, o0, i0, i1); // bottom
  }
  return new Float32Array(t.flat());
}

export function binarySTL(tris) {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + i * 50 + 12 + k * 4, tris[i * 9 + k], true);
  return buf;
}

// Extrudes a polygon given in the XZ plane (counter-clockwise seen from -Y) from y0 to y1.
export function prismXZ(poly, y0, y1) {
  const t = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % n];
    t.push([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y0, az], [bx, y1, bz], [ax, y1, az]);
  }
  // Caps (fan triangulation; the polygon must be convex).
  for (let i = 1; i + 1 < n; i++) {
    const [p, q, r] = [poly[0], poly[i], poly[i + 1]];
    t.push([p[0], y0, p[1]], [r[0], y0, r[1]], [q[0], y0, q[1]]);
    t.push([p[0], y1, p[1]], [q[0], y1, q[1]], [r[0], y1, r[1]]);
  }
  return new Float32Array(t.flat());
}

// A block whose right face overhangs outward at `deg` degrees from horizontal.
export function overhangRamp(deg, x0 = 80, y0 = 80, h = 10) {
  const run = h / Math.tan((deg * Math.PI) / 180);
  return prismXZ([[x0, 0], [x0 + 10, 0], [x0 + 10 + run, h], [x0, h]], y0, y0 + 10);
}
