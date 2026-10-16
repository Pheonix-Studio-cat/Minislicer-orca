import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { render, evaluate } from '../web/js/template.js';
import { crc32, md5Hex, writeZip, readZip } from '../web/js/zip.js';
import { parseSTL, parse3MF, placeOnBed, bounds, volumeMM3 } from '../web/js/mesh.js';
import { slice, SCALE } from '../web/js/slicer.js';
import { resolveSettings, generateGcode, checkPlacement } from '../web/js/gcode.js';
import { buildGcode3mf } from '../web/js/gcode3mf.js';
import { box, tube, join, flip, binarySTL, overhangRamp } from './shapes.mjs';

const web = new URL('../web/', import.meta.url);
const profiles = JSON.parse(fs.readFileSync(new URL('profiles.json', web), 'utf8'));
const printer = (name) => profiles.printers.find((p) => p.name === name);
const standard = (p) => p.processes.find((x) => x.name.startsWith('0.20mm'));
const settingsFor = (name, o = {}) => { const p = printer(name); return resolveSettings(p, standard(p), p.filaments[0], o); };

// ---------- template ----------

test('template: expressions, vectors, conditionals', () => {
  const vars = { a: [3, 4], t: ['PLA'], d: [0.4], z: 1.25, on: true, i: 0 };
  assert.equal(evaluate('a[1]*2-1', vars), 7);
  assert.equal(evaluate('(t[i] == "PLA") && (d != 0.2)', vars), true);
  assert.equal(evaluate('!on || z > 1', vars), true);
  assert.equal(render('Z{z + 0.5} [i] [unknown]', vars), 'Z1.75 0 [unknown]');
  const tpl = 'A\n{if t[0]=="PETG"}\nB\n{elsif z < 2}\nC\n{if on}\nD\n{endif}\n{else}\nE\n{endif}\nF';
  assert.equal(render(tpl, vars), 'A\nC\nD\nF');
  assert.throws(() => render('{nope + 1}', vars), /unknown variable/);
  assert.throws(() => render('{if on}x', vars), /missing \{endif\}/);
});

test('template: every bundled printer template renders completely', () => {
  for (const p of profiles.printers) {
    const s = resolveSettings(p, standard(p), p.filaments[0]);
    const g = generateGcode(slice(box(80, 80, 0, 100, 100, 4), s), s).gcode;
    const leftovers = g.split('\n').filter((l) => !l.startsWith(';') && /\{|\}|\[[a-z_]+\]/.test(l));
    assert.deepEqual(leftovers, [], `${p.name} has unrendered placeholders`);
  }
});

// ---------- zip / md5 / crc ----------

test('crc32 and md5 match the reference vectors', () => {
  const enc = new TextEncoder();
  assert.equal(crc32(enc.encode('123456789')).toString(16), 'cbf43926');
  assert.equal(md5Hex(enc.encode('')), 'D41D8CD98F00B204E9800998ECF8427E');
  assert.equal(md5Hex(enc.encode('abc')), '900150983CD24FB0D6963F7D28E17F72');
  assert.equal(md5Hex(enc.encode('a'.repeat(1000))), 'CABE45DCC9AE5B66BA86600CCA6B8BA8');
});

test('zip round trip, and Python reads our archive', async () => {
  const big = 'G1 X1 Y2 E0.1\n'.repeat(5000);
  const z = await writeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.gcode', data: big }]);
  const files = readZip(z);
  assert.equal(new TextDecoder().decode(await files.get('a.txt')()), 'hello');
  assert.equal(new TextDecoder().decode(await files.get('dir/b.gcode')()), big);
  const tmp = path.join(os.tmpdir(), `ms-${process.pid}.zip`);
  fs.writeFileSync(tmp, z);
  const out = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.read("dir/b.gcode")))', tmp]).toString().trim();
  fs.unlinkSync(tmp);
  assert.equal(+out, big.length);
});

// ---------- mesh ----------

test('STL and 3MF loading', async () => {
  const cube = box(0, 0, 0, 10, 20, 30);
  const stl = parseSTL(binarySTL(cube));
  assert.equal(stl.length, cube.length);
  assert.ok(Math.abs(volumeMM3(stl) - 6000) < 1e-6);
  const ascii = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
  assert.equal(parseSTL(new TextEncoder().encode(ascii).buffer).length, 9);
  // 3MF with a component and a build transform (translate by 5 in x).
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
    <object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
    <triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
    <object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 2"/></components></object>
    </resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></build></model>`;
  const z = await writeZip([{ name: '3D/3dmodel.model', data: model }]);
  const tris = await parse3MF(z.buffer);
  assert.deepEqual(Array.from(tris), [5, 0, 2, 6, 0, 2, 5, 1, 2]);
});

test('placement centres on the bed and flags what does not fit', () => {
  const s = settingsFor('Bambu Lab A1 mini');
  const placed = placeOnBed(box(-50, -50, 10, -30, -40, 20), { cx: 90, cy: 90 });
  const b = bounds(placed);
  assert.deepEqual(b.min.map((v) => +v.toFixed(3)), [80, 85, 0]);
  assert.deepEqual(checkPlacement(s, b), []);
  const tooBig = bounds(placeOnBed(box(0, 0, 0, 200, 10, 10), { cx: 90, cy: 90 }));
  assert.match(checkPlacement(s, tooBig)[0], /does not fit/);
  const tall = bounds(placeOnBed(box(0, 0, 0, 10, 10, 190), { cx: 90, cy: 90 }));
  assert.match(checkPlacement(s, tall).join(' '), /190\.0 mm tall/);
});

// ---------- slicing ----------

test('cube: layers, shells and walls inside the outline', () => {
  const s = settingsFor('Bambu Lab A1 mini');
  const r = slice(box(80, 80, 0, 100, 100, 20), s);
  assert.equal(r.layers.length, 100);
  assert.equal(r.maxZ, 20);
  const kinds = (i) => new Set(r.layers[i].paths.map((p) => p.feature));
  assert.ok(kinds(0).has('Bottom surface'));
  assert.ok(kinds(1).has('Internal solid infill'));
  assert.ok(kinds(50).has('Sparse infill') && !kinds(50).has('Internal solid infill'));
  assert.ok(kinds(99).has('Top surface'));
  for (const L of r.layers) {
    for (const p of L.paths) for (const q of p.pts) {
      assert.ok(q.X >= 80 * SCALE && q.X <= 100 * SCALE && q.Y >= 80 * SCALE && q.Y <= 100 * SCALE, `point outside the cube at z=${L.z}`);
    }
  }
  const outer = r.layers[50].paths.filter((p) => p.feature === 'Outer wall');
  assert.equal(outer.length, 1);
  // Centreline half a line width inside the face.
  assert.equal(Math.min(...outer[0].pts.map((q) => q.X)), Math.round((80 + s.width.outer / 2) * SCALE));
});

test('inside-out mesh slices the same as the correct one', () => {
  const s = settingsFor('Bambu Lab A1 mini');
  const a = slice(box(80, 80, 0, 100, 100, 5), s);
  const b = slice(flip(box(80, 80, 0, 100, 100, 5)), s);
  assert.equal(a.layers.length, b.layers.length);
  assert.equal(a.layers[10].paths.length, b.layers[10].paths.length);
});

test('tube: the hole gets its own walls and stays empty', () => {
  const s = settingsFor('Bambu Lab A1 mini');
  const r = slice(tube(90, 90, 15, 8, 10), s);
  const L = r.layers[25];
  const walls = L.paths.filter((p) => p.feature === 'Outer wall');
  assert.equal(walls.length, 2, 'outer contour and hole');
  for (const p of L.paths) for (const q of p.pts) {
    const d = Math.hypot(q.X / SCALE - 90, q.Y / SCALE - 90);
    assert.ok(d > 8 && d < 15, `path at radius ${d.toFixed(2)} is outside the tube wall`);
  }
});

test('support appears under an overhang only when enabled, and keeps its gaps', () => {
  // A table: a 4x4 mm post and a 30x30 mm top plate at z 10..12, plus a pebble under the plate
  // (x 95..97, y 88..92, 3 mm high) that the support must stand clear of sideways.
  const table = join(box(88, 88, 0, 92, 92, 10), box(75, 75, 10, 105, 105, 12), box(95, 88, 0, 97, 92, 3));
  const without = slice(table, settingsFor('Bambu Lab A1 mini'));
  assert.ok(!without.layers.some((L) => L.paths.some((p) => p.feature.startsWith('Support'))));
  const s = settingsFor('Bambu Lab A1 mini', { support: true });
  const r = slice(table, s);
  const sup = r.layers[20].paths.filter((p) => p.feature === 'Support');
  assert.ok(sup.length > 3, 'support lines under the plate');
  const top = r.layers.findLast((L) => L.paths.some((p) => p.feature.startsWith('Support')));
  assert.ok(top.z < 10 - s.support.topGap + 1e-6, `support reaches ${top.z}, must stop below the plate with a gap`);
  // Beside the pebble (layer 5, z = 1.2) the support keeps xyGap plus half a line width away.
  let nearest = Infinity;
  for (const p of r.layers[5].paths.filter((q) => q.feature === 'Support')) for (const q of p.pts) {
    const x = q.X / SCALE, y = q.Y / SCALE;
    const dx = Math.max(95 - x, 0, x - 97), dy = Math.max(88 - y, 0, y - 92);
    nearest = Math.min(nearest, Math.hypot(dx, dy));
  }
  assert.ok(nearest >= s.support.xyGap + s.width.support / 2 - 0.02, `support comes within ${nearest.toFixed(3)} mm of the pebble`);
  assert.ok(nearest < 1.5, `no support near the pebble at all (${nearest.toFixed(3)} mm) - the check proves nothing`);
});

test('support follows the overhang angle threshold', () => {
  const s = settingsFor('Bambu Lab A1 mini', { support: true });
  const supportLines = (deg) => slice(overhangRamp(deg), s).layers.reduce((n, L) => n + L.paths.filter((p) => p.feature.startsWith('Support')).length, 0);
  // Must be a closed mesh first: the ramp's own volume.
  assert.ok(supportLines(20) > 50, `a 20° overhang needs support (${supportLines(20)} lines)`);
  assert.equal(supportLines(60), 0, 'a 60° overhang prints without support');
});

// ---------- G-code ----------

function parseGcode(g) {
  let z = 0, e = 0, maxX = -Infinity, minX = Infinity, maxY = -Infinity, minY = Infinity, lastZ = -1, zDown = 0;
  let layers = 0;
  let inBody = false;
  for (const line of g.split('\n')) {
    if (line.startsWith('; MACHINE_START_GCODE_END')) inBody = true;
    if (line.startsWith('; filament end gcode')) inBody = false;
    if (!inBody) continue;
    if (line === '; CHANGE_LAYER') layers++;
    const m = /^G1 (.*)$/.exec(line);
    if (!m) continue;
    const w = Object.fromEntries(m[1].split(' ').map((t) => [t[0], parseFloat(t.slice(1))]));
    if ('Z' in w) z = w.Z;
    if ('E' in w) e += w.E;
    if ('X' in w && 'E' in w && w.E > 0) {
      maxX = Math.max(maxX, w.X); minX = Math.min(minX, w.X); maxY = Math.max(maxY, w.Y); minY = Math.min(minY, w.Y);
      if (z < lastZ - 1e-9) zDown++;
      lastZ = z;
    }
  }
  return { e, layers, minX, maxX, minY, maxY, zDown };
}

test('G-code: a solid cube extrudes about its own volume', () => {
  const s = settingsFor('Bambu Lab X1 Carbon', { infillDensity: 1 });
  const g = generateGcode(slice(box(118, 118, 0, 138, 138, 20), s), s);
  const p = parseGcode(g.gcode);
  const area = Math.PI * (s.filament.diameter / 2) ** 2;
  const plastic = (p.e * area) / s.filament.flowRatio;
  const ratio = plastic / 8000;
  assert.ok(ratio > 0.93 && ratio < 1.07, `extruded ${plastic.toFixed(0)} mm³ for an 8000 mm³ cube (ratio ${ratio.toFixed(3)})`);
  assert.equal(p.layers, 100);
  assert.equal(p.zDown, 0, 'Z never goes down while extruding');
  assert.ok(p.minX >= 118 && p.maxX <= 138 && p.minY >= 118 && p.maxY <= 138);
  assert.match(g.gcode, /^; total layer number: 100$/m);
  assert.match(g.gcode, /^M73 L100$/m);
  assert.match(g.gcode, /^M991 S0 P99 ;notify layer change$/m);
  assert.ok(Math.abs(g.stats.weight - 8 * s.filament.density * s.filament.flowRatio) < 0.6, `weight ${g.stats.weight}`);
});

test('G-code: sparse infill uses less plastic, and temperatures come from the filament', () => {
  const s = settingsFor('Bambu Lab A1');
  const g = generateGcode(slice(box(118, 118, 0, 138, 138, 20), s), s);
  const ratio = (parseGcode(g.gcode).e * Math.PI * 0.875 ** 2) / 8000;
  assert.ok(ratio > 0.25 && ratio < 0.6, `15% infill cube used ${ratio.toFixed(2)} of its volume`);
  assert.match(g.gcode, new RegExp(`^\\s*M109 S${s.filament.nozzleTempFirst}\\b`, 'm'));
  assert.match(g.gcode, new RegExp(`^\\s*M140 S${s.filament.bedTempFirst}\\b`, 'm'));
});

// ---------- .gcode.3mf ----------

test('.gcode.3mf has the files Bambu Connect reads, with a matching MD5', async () => {
  const s = settingsFor('Bambu Lab P1S');
  const { gcode, stats } = generateGcode(slice(box(118, 118, 0, 138, 138, 4), s), s);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const bytes = await buildGcode3mf({ gcode, stats, settings: s, title: 'Cube & <Co>', thumbnailPNG: png });
  const files = readZip(bytes);
  for (const f of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', 'Metadata/plate_1.gcode', 'Metadata/plate_1.gcode.md5',
    'Metadata/slice_info.config', 'Metadata/model_settings.config', 'Metadata/project_settings.config', 'Metadata/plate_1.png']) {
    assert.ok(files.has(f), `missing ${f}`);
  }
  const text = async (f) => new TextDecoder().decode(await files.get(f)());
  assert.equal(await text('Metadata/plate_1.gcode'), gcode);
  const tmp = path.join(os.tmpdir(), `ms-${process.pid}.gcode`);
  fs.writeFileSync(tmp, gcode);
  const md5 = execFileSync('md5sum', [tmp]).toString().split(' ')[0].toUpperCase();
  fs.unlinkSync(tmp);
  assert.equal(await text('Metadata/plate_1.gcode.md5'), md5);
  const info = await text('Metadata/slice_info.config');
  assert.match(info, /key="printer_model_id" value="C12"/);
  assert.match(info, /tray_info_idx="GFA00" type="PLA"/);
  assert.match(info, /name="Cube &amp; &lt;Co&gt;"/);
  assert.match(info, new RegExp(`key="prediction" value="${Math.round(stats.time)}"`));
  const project = JSON.parse(await text('Metadata/project_settings.config'));
  assert.equal(project.printer_model, 'Bambu Lab P1S');
  // Well-formed XML (python's parser is strict).
  for (const f of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', 'Metadata/slice_info.config', 'Metadata/model_settings.config']) {
    execFileSync('python3', ['-I', '-c', 'import sys,xml.dom.minidom as m; m.parseString(sys.stdin.buffer.read())'], { input: await text(f) });
  }
});
