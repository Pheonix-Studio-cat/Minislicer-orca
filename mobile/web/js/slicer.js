// The slicing core: triangle soup -> per-layer toolpaths.
//
// Coordinates are kept as Clipper integer points in micrometres (SCALE = 1000 per mm).
// Each layer produces extrusion paths tagged with an OrcaSlicer feature name so the G-code can
// carry "; FEATURE:" markers that Bambu firmware and G-code viewers understand.
//
// What it does: perimeters (outer + inner loops, aligned rear seam), top/bottom solid shells,
// rectilinear sparse infill, optional brim, optional "normal" support with denser interface
// layers, negative volumes (the flexi cutter) and painted support enforcers/blockers.
// What it does not do (yet): gap fill, bridges detection, arachne variable width, ironing,
// multi-material.

import ClipperLib from '../vendor/clipper.mjs';

export const SCALE = 1000;
const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree } = ClipperLib;

// ---------- Clipper helpers ----------

function boolean(type, subj, clip, fill = PolyFillType.pftNonZero) {
  const c = new Clipper();
  c.AddPaths(subj, PolyType.ptSubject, true);
  if (clip && clip.length) c.AddPaths(clip, PolyType.ptClip, true);
  const out = [];
  c.Execute(type, out, fill, fill);
  return out;
}
export const union = (a, b = []) => boolean(ClipType.ctUnion, a.concat(b));
export const diff = (a, b) => (a.length && b.length ? boolean(ClipType.ctDifference, a, b) : a.slice());
export const intersect = (a, b) => (a.length && b.length ? boolean(ClipType.ctIntersection, a, b) : []);

export function offset(paths, deltaMM, join = JoinType.jtMiter) {
  if (!paths.length) return [];
  const co = new ClipperOffset(2, 0.25 * SCALE / 10);
  co.AddPaths(paths, join, EndType.etClosedPolygon);
  const out = [];
  co.Execute(out, deltaMM * SCALE);
  return out;
}

// Shrink then grow: removes features narrower than 2*r.
const opening = (paths, r) => offset(offset(paths, -r), r);

const area = (path) => Clipper.Area(path);

function clipLines(lines, region) {
  if (!lines.length || !region.length) return [];
  const c = new Clipper();
  c.AddPaths(lines, PolyType.ptSubject, false);
  c.AddPaths(region, PolyType.ptClip, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctIntersection, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return Clipper.OpenPathsFromPolyTree(tree);
}

// ---------- mesh -> slices ----------

function weld(tris) {
  const n = tris.length / 3;
  const index = new Uint32Array(n);
  const map = new Map();
  const verts = [];
  const f = new Float32Array(3);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < n; i++) {
    f[0] = tris[i * 3]; f[1] = tris[i * 3 + 1]; f[2] = tris[i * 3 + 2];
    const key = `${u[0]},${u[1]},${u[2]}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(key, id);
      verts.push(f[0], f[1], f[2]);
    }
    index[i] = id;
  }
  return { verts: new Float64Array(verts), faces: index };
}

// Cuts the welded mesh at height zc and returns closed loops in Clipper integer coordinates.
// A vertex exactly at zc counts as above the plane (symbolic perturbation), so every crossing
// lies strictly inside an edge, and loops are chained through shared edges.
function sliceAt(mesh, faceIds, zc) {
  const { verts: v, faces } = mesh;
  const nv = v.length / 3;
  const segs = new Map(); // start edge key -> { end edge key, point }
  const points = new Map(); // edge key -> [x, y]
  const edgePoint = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * nv + hi;
    if (!points.has(key)) {
      const za = v[lo * 3 + 2], zb = v[hi * 3 + 2];
      const t = (zc - za) / (zb - za);
      points.set(key, [Math.round((v[lo * 3] + (v[hi * 3] - v[lo * 3]) * t) * SCALE),
        Math.round((v[lo * 3 + 1] + (v[hi * 3 + 1] - v[lo * 3 + 1]) * t) * SCALE)]);
    }
    return key;
  };
  for (const fi of faceIds) {
    const ids = [faces[fi * 3], faces[fi * 3 + 1], faces[fi * 3 + 2]];
    const above = ids.map((id) => v[id * 3 + 2] >= zc);
    const nAbove = above[0] + above[1] + above[2];
    if (nAbove === 0 || nAbove === 3) continue;
    let down = -1, up = -1;
    for (let e = 0; e < 3; e++) {
      const a = above[e], b = above[(e + 1) % 3];
      if (a && !b) down = edgePoint(ids[e], ids[(e + 1) % 3]);
      else if (!a && b) up = edgePoint(ids[e], ids[(e + 1) % 3]);
    }
    // Outward normals make the outline counter-clockwise: walk from the edge that goes down
    // to the edge that goes up (in the triangle's own vertex order).
    segs.set(down, up);
  }
  const loops = [];
  for (const start of segs.keys()) {
    if (!segs.has(start)) continue;
    const loop = [];
    let key = start;
    while (segs.has(key)) {
      const next = segs.get(key);
      segs.delete(key);
      const [X, Y] = points.get(key);
      loop.push({ X, Y });
      key = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function sliceRegions(loops) {
  if (!loops.length) return [];
  let total = 0;
  for (const l of loops) total += area(l);
  if (total < 0) for (const l of loops) l.reverse(); // inside-out mesh
  const cleaned = Clipper.CleanPolygons(loops, 0.005 * SCALE);
  let region = boolean(ClipType.ctUnion, cleaned, null, PolyFillType.pftNonZero);
  if (!region.length) region = boolean(ClipType.ctUnion, cleaned, null, PolyFillType.pftEvenOdd);
  return Clipper.CleanPolygons(region, 0.01 * SCALE).filter((p) => p.length >= 3);
}

// Outline regions of a triangle soup at each of the given slice heights.
function sliceRegionsAt(tris, centers, progress = () => {}) {
  const mesh = weld(tris);
  const nf = mesh.faces.length / 3;
  // Bucket faces by layer index range to avoid testing every face against every plane.
  const buckets = centers.map(() => []);
  for (let f = 0; f < nf; f++) {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const z = mesh.verts[mesh.faces[f * 3 + k] * 3 + 2];
      lo = Math.min(lo, z); hi = Math.max(hi, z);
    }
    let a = 0, b = centers.length;
    while (a < b) { const m = (a + b) >> 1; if (centers[m] < lo) a = m + 1; else b = m; }
    for (let i = a; i < centers.length && centers[i] < hi; i++) buckets[i].push(f);
  }
  return centers.map((zc, i) => {
    if (i % 8 === 0) progress(i / centers.length);
    return sliceRegions(sliceAt(mesh, buckets[i], zc));
  });
}

// Painted support areas, the way OrcaSlicer projects them (PrintObject::project_and_append_custom_facets):
// the part of each downward-facing painted triangle between two slice planes is projected up onto
// the upper plane, so layer i gets what lies in (centers[i-1], centers[i]].
function projectPainted(tris, centers) {
  const out = centers.map(() => []);
  if (!tris || !tris.length) return out;
  const clipZ = (poly, z, keepAbove) => {
    const res = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      const ina = keepAbove ? a[2] >= z : a[2] <= z, inb = keepAbove ? b[2] >= z : b[2] <= z;
      if (ina) res.push(a);
      if (ina !== inb) {
        const t = (z - a[2]) / (b[2] - a[2]);
        res.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]);
      }
    }
    return res;
  };
  for (let f = 0; f < tris.length; f += 9) {
    const p = [[tris[f], tris[f + 1], tris[f + 2]], [tris[f + 3], tris[f + 4], tris[f + 5]], [tris[f + 6], tris[f + 7], tris[f + 8]]];
    const nz = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
    if (nz >= 0) continue; // only downward-facing triangles carry support
    const lo = Math.min(p[0][2], p[1][2], p[2][2]), hi = Math.max(p[0][2], p[1][2], p[2][2]);
    let i = 0;
    while (i < centers.length && centers[i] < lo) i++;
    for (; i < centers.length; i++) {
      const below = i ? centers[i - 1] : -Infinity;
      if (below >= hi) break;
      let poly = clipZ(clipZ(p, below, true), centers[i], false);
      if (poly.length < 3) continue;
      poly = poly.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
      if (area(poly) < 0) poly.reverse();
      out[i].push(poly);
    }
  }
  return out.map((polys) => (polys.length ? union(polys) : []));
}

// ---------- paths ----------

function islandsOf(region) {
  const c = new Clipper();
  c.AddPaths(region, PolyType.ptSubject, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  const islands = [];
  const walk = (node) => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        islands.push({ outer: child.Contour(), area: area(child.Contour()) });
      }
      walk(child);
    }
  };
  walk(tree);
  return islands;
}

// Rotates a closed loop so it starts at its rear-most (max Y, then min X) vertex.
function alignSeam(path) {
  let best = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i], b = path[best];
    if (p.Y > b.Y || (p.Y === b.Y && p.X < b.X)) best = i;
  }
  return path.slice(best).concat(path.slice(0, best));
}

function hatch(region, spacingMM, angleDeg, phaseMM = 0) {
  if (!region.length) return [];
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  // Rotate the region by -a, hatch horizontally, rotate the lines back by +a.
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const p of region) for (const q of p) {
    const x = q.X * cos + q.Y * sin, y = -q.X * sin + q.Y * cos;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
  }
  const s = spacingMM * SCALE;
  const phase = phaseMM * SCALE;
  const lines = [];
  for (let k = Math.ceil((minY - phase) / s); k * s + phase <= maxY; k++) {
    const y = k * s + phase;
    lines.push([[minX - s, y], [maxX + s, y]].map(([x, yy]) => ({ X: Math.round(x * cos - yy * sin), Y: Math.round(x * sin + yy * cos) })));
  }
  const clipped = clipLines(lines, region);
  // Order: by scanline, alternating direction, so neighbouring lines join with short travels.
  const key = (p) => -p.X * sin + p.Y * cos;
  const along = (p) => p.X * cos + p.Y * sin;
  const minLen = 0.3 * SCALE; // drop specks shorter than a line width
  const out = clipped.filter((l) => l.length >= 2 && Math.hypot(l[1].X - l[0].X, l[1].Y - l[0].Y) >= minLen)
    .map((l) => (along(l[0]) <= along(l[l.length - 1]) ? l : l.slice().reverse()));
  out.sort((p, q) => key(p[0]) - key(q[0]) || along(p[0]) - along(q[0]));
  let row = 0, lastKey = null;
  return out.map((l) => {
    const k = Math.round(key(l[0]) / s);
    if (k !== lastKey) { row++; lastKey = k; }
    return row % 2 ? l : l.slice().reverse();
  });
}

const spacingOf = (w, h) => w - h * (1 - Math.PI / 4);

// ---------- main entry ----------

/**
 * cfg: {
 *   firstLayerHeight, layerHeight, wallLoops, topLayers, bottomLayers, infillDensity (0..1),
 *   width: { outer, inner, sparse, solid, top, first, support },
 *   support: { enabled, angle, topGap, xyGap, spacing, interfaceSpacing },
 *   brimWidth,
 * }
 * extra: {
 *   negatives: triangle soup removed from the model, like OrcaSlicer's negative parts (flexi cutter),
 *   enforcers, blockers: painted triangles (soups) that add or block support where support is on,
 * }
 * Returns { layers: [{ z, h, paths: [{ feature, width, pts: [{X,Y}], closed }] }], maxZ, regions },
 * regions being the model's outline per layer (Clipper paths).
 */
export function slice(tris, cfg, progress = () => {}, extra = {}) {
  let maxZ = 0;
  for (let i = 2; i < tris.length; i += 3) maxZ = Math.max(maxZ, tris[i]);

  // Layer heights.
  const zs = [];
  for (let z = cfg.firstLayerHeight, h = cfg.firstLayerHeight; z - h / 2 < maxZ; h = cfg.layerHeight, z += cfg.layerHeight) {
    zs.push({ z: +z.toFixed(4), h });
  }

  const centers = zs.map((l) => l.z - l.h / 2);
  const regions = sliceRegionsAt(tris, centers, (p) => progress(0.4 * p, 'Slicing'));
  if (extra.negatives && extra.negatives.length) {
    const cut = sliceRegionsAt(extra.negatives, centers);
    for (let i = 0; i < regions.length; i++) {
      if (cut[i].length) regions[i] = diff(regions[i], cut[i]).filter((p) => Math.abs(area(p)) > 0.0025 * SCALE * SCALE);
    }
  }
  // Trailing empty layers (e.g. a sliver above the last real cut) carry nothing.
  while (zs.length && !regions[regions.length - 1].length) { zs.pop(); regions.pop(); }
  if (!zs.length) throw new Error('the model produced no layers - is it below the bed or flat?');

  const w = cfg.width;
  const layers = zs.map(({ z, h }) => ({ z, h, paths: [] }));
  const fill = []; // area to fill inside the walls, per layer
  const wallsPerLayer = [];

  for (let i = 0; i < zs.length; i++) {
    const h = zs[i].h;
    const first = i === 0;
    const wOuter = first ? w.first : w.outer;
    const wInner = first ? w.first : w.inner;
    const spOuter = spacingOf(wOuter, h), spInner = spacingOf(wInner, h);
    const loops = [];
    let inset = wOuter / 2;
    for (let k = 0; k < cfg.wallLoops; k++) {
      if (k === 1) inset += (spOuter + spInner) / 2;
      else if (k > 1) inset += spInner;
      const ring = Clipper.CleanPolygons(offset(regions[i], -inset), 0.01 * SCALE).filter((p) => p.length >= 3 && Math.abs(area(p)) > (wInner * SCALE) ** 2);
      if (!ring.length) break;
      loops.push({ k, ring, inset });
    }
    wallsPerLayer.push(loops);
    const lastInset = loops.length ? loops[loops.length - 1].inset : 0;
    const halfSp = loops.length ? (loops.length > 1 ? spInner : spOuter) / 2 : 0;
    fill.push(loops.length ? offset(regions[i], -(lastInset + halfSp)) : []);
    if (i % 8 === 0) progress(0.4 + 0.2 * (i / zs.length), 'Walls');
  }

  // Solid shells: what lies within bottomLayers of open space below, or topLayers above.
  const n = zs.length;
  const solid = [], sparse = [], topSurf = [];
  for (let i = 0; i < n; i++) {
    const F = fill[i];
    if (!F.length) { solid.push([]); sparse.push([]); topSurf.push([]); continue; }
    let below = i - cfg.bottomLayers < 0 ? [] : regions[i - 1];
    for (let j = 2; j <= cfg.bottomLayers && below.length; j++) below = intersect(below, regions[i - j]);
    let above = i + cfg.topLayers >= n ? [] : regions[i + 1];
    for (let j = 2; j <= cfg.topLayers && above.length; j++) above = intersect(above, regions[i + j]);
    const wSolid = w.solid;
    const shell = union(diff(F, below), diff(F, above));
    let sp = cfg.infillDensity > 0 ? diff(F, offset(shell, wSolid)) : [];
    sp = opening(sp, wSolid);
    const so = diff(F, sp);
    solid.push(so);
    sparse.push(sp);
    topSurf.push(i + 1 >= n ? so : intersect(so, offset(diff(F, regions[i + 1]), wSolid)));
    if (i % 8 === 0) progress(0.6 + 0.15 * (i / n), 'Shells');
  }

  // Support: columns hanging from overhangs, blocked by the model, with an XY and Z gap.
  const support = zs.map(() => ({ base: [], iface: [] }));
  if (cfg.support && cfg.support.enabled) {
    const s = cfg.support;
    const angle = s.angle > 0 ? s.angle : 30;
    const overhang = zs.map(({ h }, i) => {
      if (i === 0) return [];
      const allowed = Math.max(h / Math.tan((angle * Math.PI) / 180), w.outer / 2);
      // Where the layer reaches further out than `allowed`, support all of what is new on it, not
      // only the part beyond `allowed`: otherwise a gentle slope leaves a 0.35 mm gap between the
      // thin strips of consecutive layers and the support falls apart into threads.
      const beyond = diff(regions[i], offset(regions[i - 1], allowed));
      if (!beyond.length) return [];
      return intersect(diff(regions[i], regions[i - 1]), offset(beyond, allowed + 0.05))
        .filter((p) => Math.abs(area(p)) > 0.01 * SCALE * SCALE);
    });
    // Painted supports: blockers remove the automatic support under them, enforcers add support
    // under painted faces whatever their angle.
    const enforcers = projectPainted(extra.enforcers, centers);
    const blockers = projectPainted(extra.blockers, centers);
    for (let i = 0; i < n; i++) {
      const block = union(blockers[i], union(i ? blockers[i - 1] : [], i + 1 < n ? blockers[i + 1] : []));
      if (block.length && overhang[i].length) overhang[i] = diff(overhang[i], offset(block, w.support));
      if (enforcers[i].length) overhang[i] = union(overhang[i], enforcers[i]);
    }
    const gap = Math.max(1, Math.round(s.topGap / cfg.layerHeight));
    let column = [];
    for (let i = n - 1; i >= 0; i--) {
      const src = i + gap + 1 < n ? overhang[i + gap + 1] : [];
      if (src.length) column = union(column, src);
      if (!column.length) continue;
      column = diff(column, regions[i]);
      column = Clipper.CleanPolygons(column, 0.02 * SCALE).filter((p) => Math.abs(area(p)) > (w.support * SCALE) ** 2);
      const area_i = opening(diff(column, offset(regions[i], s.xyGap)), w.support / 2);
      const ifaceSrc = union(src, i + gap + 2 < n ? overhang[i + gap + 2] : []);
      const iface = intersect(area_i, offset(ifaceSrc, w.support));
      support[i] = { base: diff(area_i, iface), iface };
    }
  }

  // Assemble paths per layer.
  for (let i = 0; i < n; i++) {
    const L = layers[i];
    const first = i === 0;
    const islands = islandsOf(regions[i]).sort((a, b) => a.area - b.area);
    const islandOf = (pt) => {
      for (let k = 0; k < islands.length; k++) if (Clipper.PointInPolygon(pt, islands[k].outer) !== 0) return k;
      return islands.length;
    };
    const groups = Array.from({ length: islands.length + 1 }, () => []);
    const add = (feature, width, pts, closed) => groups[islandOf(pts[0])].push({ feature, width, pts, closed });

    // Walls: inner loops first, outer last (OrcaSlicer's default "inner/outer" order).
    for (const { k, ring } of wallsPerLayer[i].slice().reverse()) {
      for (const p of ring) {
        add(k === 0 ? 'Outer wall' : 'Inner wall', first ? w.first : (k === 0 ? w.outer : w.inner), alignSeam(p), true);
      }
    }
    const angle = i % 2 ? 135 : 45;
    const solidW = first ? w.first : w.solid;
    const lineRegion = (r, lw) => offset(r, -(lw / 2) + 0.15 * lw);
    const top = topSurf[i];
    const internal = diff(solid[i], top);
    for (const l of hatch(lineRegion(top, w.top), spacingOf(w.top, L.h), angle)) add(first ? 'Bottom surface' : 'Top surface', w.top, l, false);
    for (const l of hatch(lineRegion(internal, solidW), spacingOf(solidW, L.h), angle)) add(first ? 'Bottom surface' : 'Internal solid infill', solidW, l, false);
    if (cfg.infillDensity > 0) {
      const sw = w.sparse;
      for (const l of hatch(lineRegion(sparse[i], sw), spacingOf(sw, L.h) / cfg.infillDensity, angle)) add('Sparse infill', sw, l, false);
    }
    L.paths = groups.flat();

    // Support goes before the model on each layer.
    const sup = [];
    if (support[i].base.length) {
      for (const l of hatch(offset(support[i].base, -w.support / 2), cfg.support.spacing, 0)) sup.push({ feature: 'Support', width: w.support, pts: l, closed: false });
    }
    if (support[i].iface.length) {
      for (const l of hatch(offset(support[i].iface, -w.support / 2), cfg.support.interfaceSpacing, 90)) sup.push({ feature: 'Support interface', width: w.support, pts: l, closed: false });
    }
    L.paths = sup.concat(L.paths);

    if (first && cfg.brimWidth > 0) {
      const brim = [];
      const outline = islands.map((isl) => isl.outer);
      const sp = spacingOf(w.first, L.h);
      for (let d = w.first / 2; d < cfg.brimWidth; d += sp) {
        for (const p of offset(outline, d)) if (area(p) > 0) brim.push({ feature: 'Brim', width: w.first, pts: alignSeam(p), closed: true });
      }
      L.paths = brim.reverse().concat(L.paths);
    }
    if (i % 8 === 0) progress(0.75 + 0.25 * (i / n), 'Toolpaths');
  }
  progress(1, 'Toolpaths');
  return { layers, maxZ: zs[zs.length - 1].z, regions };
}
