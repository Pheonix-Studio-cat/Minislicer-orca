// Model loading: STL (binary and ASCII), OBJ and 3MF (including Bambu/Orca projects whose
// meshes live in 3D/Objects/*.model). Every loader returns a triangle soup as a Float32Array
// of xyz triples, 9 floats per triangle, in millimetres.

import { readZip } from './zip.js';

export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  if (bytes.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) {
      const out = new Float32Array(n * 9);
      for (let t = 0; t < n; t++) {
        const base = 84 + t * 50 + 12;
        for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(base + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(bytes);
  if (!/^\s*solid/.test(text) || !/vertex/.test(text)) throw new Error('not a valid STL file');
  const nums = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m;
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3]);
  if (nums.length % 9) throw new Error('ASCII STL has an incomplete facet');
  return new Float32Array(nums);
}

export function parseOBJ(text) {
  const v = [];
  const out = [];
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') v.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'f') {
      const idx = p.slice(1).map((s) => {
        const i = parseInt(s.split('/')[0], 10);
        return i < 0 ? v.length + i : i - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const i of [idx[0], idx[k], idx[k + 1]]) {
          if (!v[i]) throw new Error('OBJ face references a missing vertex');
          out.push(...v[i]);
        }
      }
    }
  }
  if (!out.length) throw new Error('OBJ file has no faces');
  return new Float32Array(out);
}

// 3MF transforms are 12 numbers "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row vectors).
function parseTransform(s) {
  if (!s) return null;
  const a = s.trim().split(/\s+/).map(Number);
  return a.length === 12 ? a : null;
}
function compose(outer, inner) {
  // apply inner first, then outer
  if (!outer) return inner;
  if (!inner) return outer;
  const r = new Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let v = row === 3 ? outer[9 + col] : 0;
      for (let k = 0; k < 3; k++) v += inner[row * 3 + k] * outer[k * 3 + col];
      r[row * 3 + col] = v;
    }
  }
  return r;
}
const attr = (tag, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

function parseModelXML(xml) {
  const objects = new Map();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const id = attr(m[1], 'id');
    const body = m[2];
    const obj = { vertices: null, triangles: null, components: [] };
    const meshM = /<mesh\b[\s\S]*?<\/mesh>/.exec(body);
    if (meshM) {
      const vs = [];
      const vRe = /<vertex\b([^>]*)\/?>/g;
      let v;
      while ((v = vRe.exec(meshM[0]))) vs.push(+attr(v[1], 'x'), +attr(v[1], 'y'), +attr(v[1], 'z'));
      const ts = [];
      const tRe = /<triangle\b([^>]*)\/?>/g;
      while ((v = tRe.exec(meshM[0]))) ts.push(+attr(v[1], 'v1'), +attr(v[1], 'v2'), +attr(v[1], 'v3'));
      obj.vertices = vs;
      obj.triangles = ts;
    }
    const cRe = /<component\b([^>]*)\/?>/g;
    let c;
    while ((c = cRe.exec(body))) {
      obj.components.push({ id: attr(c[1], 'objectid'), path: attr(c[1], 'p:path'), transform: parseTransform(attr(c[1], 'transform')) });
    }
    objects.set(id, obj);
  }
  const items = [];
  const buildM = /<build\b[\s\S]*?<\/build>/.exec(xml);
  if (buildM) {
    const iRe = /<item\b([^>]*)\/?>/g;
    while ((m = iRe.exec(buildM[0]))) {
      if (attr(m[1], 'printable') === '0') continue;
      items.push({ id: attr(m[1], 'objectid'), path: attr(m[1], 'p:path'), transform: parseTransform(attr(m[1], 'transform')) });
    }
  }
  return { objects, items };
}

export async function parse3MF(buffer) {
  const zip = readZip(new Uint8Array(buffer));
  const dec = new TextDecoder();
  const models = new Map();
  for (const [name, read] of zip) {
    if (/\.model$/i.test(name)) models.set('/' + name.replace(/^\//, ''), parseModelXML(dec.decode(await read())));
  }
  const root = models.get('/3D/3dmodel.model') || [...models.values()][0];
  if (!root) throw new Error('3MF has no model file');
  const out = [];
  const emit = (path, id, transform, depth) => {
    if (depth > 16) throw new Error('3MF component nesting too deep');
    const model = models.get(path) || root;
    const obj = model.objects.get(id);
    if (!obj) return;
    if (obj.vertices) {
      const vs = obj.vertices;
      for (const vi of obj.triangles) {
        const x = vs[vi * 3], y = vs[vi * 3 + 1], z = vs[vi * 3 + 2];
        if (transform) {
          const t = transform;
          out.push(x * t[0] + y * t[3] + z * t[6] + t[9], x * t[1] + y * t[4] + z * t[7] + t[10], x * t[2] + y * t[5] + z * t[8] + t[11]);
        } else out.push(x, y, z);
      }
    }
    for (const c of obj.components) emit(c.path || path, c.id, compose(transform, c.transform), depth + 1);
  };
  for (const it of root.items) emit(it.path || '/3D/3dmodel.model', it.id, it.transform, 0);
  if (!out.length) throw new Error('3MF contains no printable mesh');
  return new Float32Array(out);
}

export async function loadModel(name, buffer) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'stl') return parseSTL(buffer);
  if (ext === 'obj') return parseOBJ(new TextDecoder().decode(buffer));
  if (ext === '3mf') return parse3MF(buffer);
  throw new Error(`unsupported file type ".${ext}" (use STL, 3MF or OBJ)`);
}

export function bounds(tris) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max, size: max.map((v, k) => v - min[k]) };
}

// Applies scale (uniform), rotation about Z (degrees) and X/Y rotation in 90° steps, then drops
// the part onto the bed and centres it at (cx, cy). Returns a new array.
export function placeOnBed(tris, { scale = 1, rotX = 0, rotY = 0, rotZ = 0, cx, cy }) {
  const out = new Float32Array(tris.length);
  const rad = (d) => (d * Math.PI) / 180;
  const [sx, cxr] = [Math.sin(rad(rotX)), Math.cos(rad(rotX))];
  const [sy, cyr] = [Math.sin(rad(rotY)), Math.cos(rad(rotY))];
  const [sz, czr] = [Math.sin(rad(rotZ)), Math.cos(rad(rotZ))];
  for (let i = 0; i < tris.length; i += 3) {
    let x = tris[i] * scale, y = tris[i + 1] * scale, z = tris[i + 2] * scale;
    [y, z] = [y * cxr - z * sx, y * sx + z * cxr];
    [x, z] = [x * cyr + z * sy, -x * sy + z * cyr];
    [x, y] = [x * czr - y * sz, x * sz + y * czr];
    out[i] = x; out[i + 1] = y; out[i + 2] = z;
  }
  const b = bounds(out);
  const dx = cx - (b.min[0] + b.max[0]) / 2;
  const dy = cy - (b.min[1] + b.max[1]) / 2;
  const dz = -b.min[2];
  for (let i = 0; i < out.length; i += 3) { out[i] += dx; out[i + 1] += dy; out[i + 2] += dz; }
  return out;
}

export function volumeMM3(tris) {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.subarray(i, i + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}
