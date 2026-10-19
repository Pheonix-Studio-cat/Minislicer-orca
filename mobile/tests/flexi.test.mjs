import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ClipperLib from '../web/vendor/clipper.js';
import { parseSTL, bounds } from '../web/js/mesh.js';
import { slice, intersect } from '../web/js/slicer.js';
import { resolveSettings } from '../web/js/gcode.js';
import { box, join } from './shapes.mjs';

const web = new URL('../web/', import.meta.url);
const profiles = JSON.parse(fs.readFileSync(new URL('profiles.json', web), 'utf8'));
const settingsFor = (name, o = {}) => {
  const p = profiles.printers.find((x) => x.name === name);
  return resolveSettings(p, p.processes.find((x) => x.name.startsWith('0.20mm Standard')), p.filaments[0], o);
};
const MODULES = ['Projectcutter_ver1_bigger.stl', 'Projectcutter_ver2_bigger.stl', 'Projectcutter_ver3_flat.stl'];

// A cutter module from the app's assets, centred on (cx, cy, cz).
function cutterAt(file, cx, cy, cz) {
  const t = parseSTL(fs.readFileSync(new URL(`flexi/${file}`, web)).buffer);
  const b = bounds(t);
  const d = [cx - (b.min[0] + b.max[0]) / 2, cy - (b.min[1] + b.max[1]) / 2, cz - (b.min[2] + b.max[2]) / 2];
  for (let i = 0; i < t.length; i++) t[i] += d[i % 3];
  return t;
}

// Parts that print separately: islands (with their holes) joined when they overlap the island of
// the next layer. A flexi joint must leave at least two parts that never touch.
function parts(regions) {
  const { Clipper, ClipType, PolyType, PolyFillType, PolyTree } = ClipperLib;
  const islands = regions.map((region) => {
    const c = new Clipper();
    c.AddPaths(region, PolyType.ptSubject, true);
    const tree = new PolyTree();
    c.Execute(ClipType.ctUnion, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
    const out = [];
    const walk = (node) => {
      for (const ch of node.Childs()) {
        if (!ch.IsHole()) out.push([ch.Contour(), ...ch.Childs().map((h) => h.Contour())]);
        walk(ch);
      }
    };
    walk(tree);
    return out;
  });
  const parent = [];
  const ids = islands.map((l) => l.map(() => parent.push(parent.length) - 1));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 1; i < islands.length; i++) {
    islands[i].forEach((a, ia) => islands[i - 1].forEach((b, ib) => {
      if (intersect(a, b).some((p) => Math.abs(Clipper.Area(p)) > 1)) parent[find(ids[i][ia])] = find(ids[i - 1][ib]);
    }));
  }
  return new Set(parent.map((_, k) => find(k))).size;
}

test('a negative volume is removed from the model, layer by layer', () => {
  const s = settingsFor('Bambu Lab A1');
  const bar = box(60, 95, 0, 140, 105, 10);
  assert.equal(parts(slice(bar, s).regions), 1);
  const cut = slice(bar, s, () => {}, { negatives: box(99.5, 90, -1, 100.5, 110, 11) });
  assert.equal(parts(cut.regions), 2, 'a 1 mm slab through the bar leaves two parts');
  const outer = cut.layers[10].paths.filter((p) => p.feature === 'Outer wall');
  assert.equal(outer.length, 2, 'each half gets its own outer wall');
});

test('each flexi cutter module splits a bar into two parts along a curved joint', () => {
  const s = settingsFor('Bambu Lab A1');
  // A bar lying along X, 20 x 16 mm in section: the oval flange of the smallest module (about
  // 30 x 24 mm) still reaches past its corners, so the module cuts it through.
  const bar = box(40, 90, 0, 160, 110, 16);
  for (const file of MODULES) {
    const r = slice(bar, s, () => {}, { negatives: cutterAt(file, 100, 100, 8) });
    assert.equal(parts(r.regions), 2, `${file}: the joint separates the bar into two parts`);
    // Along the bar's centre line the cut is curved (ball and socket), not a flat 1 mm slab.
    let xMin = Infinity, xMax = -Infinity;
    for (const region of r.regions) for (const p of region) for (const q of p) {
      if (q.Y > 99000 && q.Y < 101000 && Math.abs(q.X - 100000) < 10000) { xMin = Math.min(xMin, q.X); xMax = Math.max(xMax, q.X); }
    }
    assert.ok(xMax - xMin > 2000, `${file}: the cut is not a flat plane (${((xMax - xMin) / 1000).toFixed(1)} mm deep)`);
  }
});

// A table: post and top plate at z 10..12. Its downward-facing plate triangles at z = 10 are the
// faces a user paints.
const post = box(88, 88, 0, 92, 92, 10);
const plate = (x0, x1) => box(x0, x0, 10, x1, x1, 12);
const bottomOf = (tris) => {
  const out = [];
  for (let i = 0; i < tris.length; i += 9) {
    if (tris[i + 2] === 10 && tris[i + 5] === 10 && tris[i + 8] === 10) out.push(...tris.subarray(i, i + 9));
  }
  return new Float32Array(out);
};
const supportLines = (r) => r.layers.reduce((n, L) => n + L.paths.filter((p) => p.feature.startsWith('Support')).length, 0);

test('painted enforcers add support where the angle threshold adds none', () => {
  const s = settingsFor('Bambu Lab A1 mini', { support: true });
  s.support.angle = 1; // a layer may reach out ~11 mm before it counts as an overhang
  const p = plate(84, 96);
  const table = join(post, p);
  assert.equal(supportLines(slice(table, s)), 0, 'no automatic support at this threshold');
  const r = slice(table, s, () => {}, { enforcers: bottomOf(p) });
  assert.ok(supportLines(r) > 30, `enforced support under the plate (${supportLines(r)} lines)`);
  // As in OrcaSlicer, painted support needs support to be enabled.
  assert.equal(supportLines(slice(table, settingsFor('Bambu Lab A1 mini'), () => {}, { enforcers: bottomOf(p) })), 0);
});

test('painted blockers remove the automatic support under them', () => {
  const s = settingsFor('Bambu Lab A1 mini', { support: true });
  const p = plate(75, 105);
  const table = join(post, p);
  assert.ok(supportLines(slice(table, s)) > 30, 'automatic support under the plate');
  assert.equal(supportLines(slice(table, s, () => {}, { blockers: bottomOf(p) })), 0, 'blocked everywhere it was painted');
});
