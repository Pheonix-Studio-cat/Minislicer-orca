// UI: model loading, placement, settings, 3D view and preview, hand-off to the runner.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { loadModel, placeOnBed, bounds } from './mesh.js';
import { resolveSettings, checkPlacement, BED_TYPES, VERSION } from './gcode.js';
import { buildGcode3mf } from './gcode3mf.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('ms.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ms.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  profiles: null,
  source: null, // { name, tris }
  rot: { x: 0, y: 0, z: 0 },
  placed: null,
  result: null, // { gcode, stats, settings, bytes3mf }
  runner: null, // { version, bambuConnect } when served by the runner
  token: null,
};

// ---------- runner ----------

function takeToken() {
  const url = new URL(location.href);
  const t = url.searchParams.get('token');
  if (t) {
    store.set('token', t);
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return store.get('token', null);
}

async function detectRunner() {
  const chip = $('runner');
  try {
    const r = await fetch('api/status', { cache: 'no-store', headers: state.token ? { 'X-Runner-Token': state.token } : {} });
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    if (s.app !== 'minislicer-runner') throw new Error('not the runner');
    state.runner = s;
    if (!s.paired) {
      chip.textContent = 'Runner found - scan its QR code to pair';
      chip.className = 'chip';
    } else {
      chip.textContent = s.bambuConnect === false ? 'Runner paired - Bambu Connect not found' : `Runner on ${s.host || 'computer'}`;
      chip.className = 'chip ok';
    }
  } catch {
    state.runner = null;
    chip.textContent = 'No runner - download only';
    chip.className = 'chip';
  }
  updateButtons();
}

// ---------- 3D view ----------

const canvas = $('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-150, -250, 400);
scene.add(sun);
const bedGroup = new THREE.Group();
scene.add(bedGroup);
let modelMesh = null;
let previewLines = null;

const FEATURE_COLORS = {
  'Outer wall': 0xff8a1e, 'Inner wall': 0xffd23f, 'Sparse infill': 0xb4384f, 'Internal solid infill': 0x9c4fd6,
  'Top surface': 0xf2486e, 'Bottom surface': 0x6f8cff, Support: 0x3fb950, 'Support interface': 0x23d3c4, Brim: 0x8fd9ff,
};

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  return { view: cs.getPropertyValue('--view').trim() || '#e9edf1', line: cs.getPropertyValue('--line').trim() || '#d9dee4' };
}

function buildBed(s) {
  bedGroup.clear();
  const w = s.bed.maxX - s.bed.minX, d = s.bed.maxY - s.bed.minY;
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.9 }));
  plate.position.set(s.bed.minX + w / 2, s.bed.minY + d / 2, -0.01);
  bedGroup.add(plate);
  const grid = [];
  for (let x = s.bed.minX; x <= s.bed.maxX + 0.1; x += 10) grid.push(x, s.bed.minY, 0, x, s.bed.maxY, 0);
  for (let y = s.bed.minY; y <= s.bed.maxY + 0.1; y += 10) grid.push(s.bed.minX, y, 0, s.bed.maxX, y, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
  bedGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5a636c })));
  if (s.bedExclude) {
    const e = s.bedExclude;
    const ex = new THREE.Mesh(new THREE.PlaneGeometry(e.maxX - e.minX, e.maxY - e.minY), new THREE.MeshBasicMaterial({ color: 0x7a2e2e }));
    ex.position.set((e.minX + e.maxX) / 2, (e.minY + e.maxY) / 2, 0.01);
    bedGroup.add(ex);
  }
  controls.target.set(s.bed.minX + w / 2, s.bed.minY + d / 2, 10);
  camera.position.set(s.bed.minX + w / 2, s.bed.minY - d * 1.15, Math.max(w, d) * 0.95);
  camera.far = Math.max(w, d) * 20;
  camera.updateProjectionMatrix();
  scene.background = new THREE.Color(themeColors().view);
}

function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// Looks at the part from the front, close enough that it fills about half the view.
function frame(b) {
  const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.size[2] / 2);
  const r = Math.max(20, Math.hypot(...b.size) / 2);
  const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.4;
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0, -0.82, 0.57).multiplyScalar(dist));
  camera.updateProjectionMatrix();
}

function showModel(tris, color) {
  if (modelMesh) { scene.remove(modelMesh); modelMesh.geometry.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  g.computeVertexNormals();
  modelMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 }));
  scene.add(modelMesh);
}

function clearPreview() {
  if (previewLines) { scene.remove(previewLines); previewLines.geometry.dispose(); previewLines = null; }
  $('layerbar').hidden = true;
  $('legend').hidden = true;
  if (modelMesh) modelMesh.visible = true;
}

function showPreview(pv) {
  clearPreview();
  const n = pv.feat.length;
  const colors = new Float32Array(n * 6);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.setHex(FEATURE_COLORS[pv.features[pv.feat[i]]] || 0xffffff);
    colors.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pv.pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  previewLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(previewLines);
  if (modelMesh) modelMesh.visible = false;
  const slider = $('layer');
  slider.max = String(pv.z.length);
  slider.value = String(pv.z.length);
  const setLayer = () => {
    const k = +slider.value;
    g.setDrawRange(0, pv.layerStart[k] * 2);
    $('layerlabel').textContent = `${k} / ${pv.z.length} · ${pv.z[k - 1].toFixed(2)} mm`;
  };
  slider.oninput = setLayer;
  setLayer();
  $('layerbar').hidden = false;
  const used = new Set(pv.feat);
  $('legend').innerHTML = [...used].map((i) => {
    const name = pv.features[i];
    return `<span><i style="background:#${(FEATURE_COLORS[name] || 0xffffff).toString(16).padStart(6, '0')}"></i>${name}</span>`;
  }).join('');
  $('legend').hidden = false;
}

async function thumbnail() {
  if (!modelMesh) return null;
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const r = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
  try {
    const s = new THREE.Scene();
    s.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.4));
    const l = sun.clone();
    s.add(l);
    const m = new THREE.Mesh(modelMesh.geometry, modelMesh.material);
    s.add(m);
    const b = new THREE.Box3().setFromObject(m);
    const center = b.getCenter(new THREE.Vector3());
    const radius = b.getSize(new THREE.Vector3()).length() / 2;
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, radius * 20);
    cam.up.set(0, 0, 1);
    const dist = radius / Math.sin((15 * Math.PI) / 180);
    cam.position.copy(center).add(new THREE.Vector3(0, -0.8, 0.6).normalize().multiplyScalar(dist));
    cam.lookAt(center);
    r.render(s, cam);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    r.dispose();
    r.forceContextLoss();
  }
}

// ---------- settings ----------

const sel = {
  printer: $('printer'), bed: $('bed'), filament: $('filament'), process: $('process'),
  walls: $('walls'), infill: $('infill'), support: $('support'), brim: $('brim'), color: $('color'), scale: $('scale'),
};

function fillSelect(el, items, value) {
  el.innerHTML = '';
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.value;
    o.textContent = it.label;
    el.append(o);
  }
  if (items.some((i) => i.value === value)) el.value = value;
}

const short = (name) => name.replace(/ @BBL.*$/, '');

function currentPrinter() {
  return state.profiles.printers.find((p) => p.name === sel.printer.value) || state.profiles.printers[0];
}

function onPrinterChange() {
  const p = currentPrinter();
  fillSelect(sel.process, p.processes.map((x) => ({ value: x.name, label: short(x.name) })), store.get('process:' + p.name, p.processes.find((x) => x.name.startsWith('0.20mm'))?.name));
  fillSelect(sel.filament, p.filaments.map((x) => ({ value: x.name, label: short(x.name) })), store.get('filament:' + p.name, p.filaments[0].name));
  fillSelect(sel.bed, BED_TYPES.map((b) => ({ value: b.name, label: b.name })), store.get('bed:' + p.name, p.default_bed_type));
  onProcessChange();
  buildBed(settings());
  replace();
}

// A quality preset brings its own wall count and infill; the user can change both afterwards.
function onProcessChange() {
  const proc = currentPrinter().processes.find((x) => x.name === sel.process.value);
  sel.walls.value = parseInt(proc.wall_loops, 10);
  sel.infill.value = parseInt(proc.sparse_infill_density, 10);
  $('infillout').textContent = `${sel.infill.value}%`;
}

function settings() {
  const p = currentPrinter();
  return resolveSettings(p, p.processes.find((x) => x.name === sel.process.value), p.filaments.find((x) => x.name === sel.filament.value), {
    bedType: sel.bed.value,
    wallLoops: Math.max(1, Math.min(10, parseInt(sel.walls.value, 10) || 2)),
    infillDensity: (+sel.infill.value) / 100,
    support: sel.support.checked,
    brim: sel.brim.checked,
    color: sel.color.value.toUpperCase(),
  });
}

function saveSettings() {
  const p = currentPrinter();
  store.set('printer', p.name);
  store.set('process:' + p.name, sel.process.value);
  store.set('filament:' + p.name, sel.filament.value);
  store.set('bed:' + p.name, sel.bed.value);
  store.set('support', sel.support.checked);
  store.set('brim', sel.brim.checked);
  store.set('color', sel.color.value);
}

// ---------- model ----------

function replace() {
  invalidate();
  if (!state.source) return;
  const s = settings();
  const scale = Math.max(0.01, (+sel.scale.value || 100) / 100);
  state.placed = placeOnBed(state.source.tris, {
    scale, rotX: state.rot.x, rotY: state.rot.y, rotZ: state.rot.z,
    cx: (s.bed.minX + s.bed.maxX) / 2, cy: (s.bed.minY + s.bed.maxY) / 2,
  });
  const b = bounds(state.placed);
  $('modelsize').textContent = `${b.size[0].toFixed(1)} × ${b.size[1].toFixed(1)} × ${b.size[2].toFixed(1)} mm · ${(state.placed.length / 9).toLocaleString('en')} triangles`;
  showModel(state.placed, sel.color.value);
  frame(b);
  showProblems(checkPlacement(s, b));
}

function showProblems(list) {
  const box = $('problems');
  box.innerHTML = list.map((t) => `<p>${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('');
  box.hidden = !list.length;
  state.blocked = list.length > 0;
  updateButtons();
}

function invalidate() {
  state.result = null;
  $('result').hidden = true;
  $('sendmsg').textContent = '';
  clearPreview();
}

function updateButtons() {
  $('slice').disabled = !state.placed || state.blocked || state.slicing;
  $('send').hidden = !(state.runner && state.runner.paired);
}

async function openFile(file) {
  if (!file) return;
  try {
    const tris = await loadModel(file.name, await file.arrayBuffer());
    if (!tris.length) throw new Error('the file has no triangles');
    state.source = { name: file.name.replace(/\.(stl|3mf|obj)$/i, ''), tris };
    state.rot = { x: 0, y: 0, z: 0 };
    sel.scale.value = 100;
    $('empty').hidden = true;
    $('modelrow').hidden = false;
    $('transform').hidden = false;
    $('modelname').textContent = file.name;
    replace();
  } catch (err) {
    showProblems([`Could not open ${file.name}: ${err.message}`]);
  }
}

// ---------- slicing ----------

let worker = null;
function slice() {
  if (!state.placed) return;
  const s = settings();
  saveSettings();
  invalidate();
  state.slicing = true;
  updateButtons();
  const bar = $('progress');
  bar.hidden = false;
  const setBar = (p, label) => { bar.firstElementChild.style.width = `${Math.round(p * 100)}%`; bar.lastElementChild.textContent = label; };
  setBar(0, 'Starting…');
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = async (ev) => {
    const m = ev.data;
    if (m.type === 'progress') return setBar(m.p, `${m.stage}… ${Math.round(m.p * 100)}%`);
    worker.terminate();
    worker = null;
    state.slicing = false;
    bar.hidden = true;
    updateButtons();
    if (m.type === 'error') return showProblems([`Slicing failed: ${m.message}`]);
    const thumb = await thumbnail().catch(() => null);
    const bytes3mf = await buildGcode3mf({ gcode: m.gcode, stats: m.stats, settings: s, title: state.source.name, thumbnailPNG: thumb });
    state.result = { gcode: m.gcode, stats: m.stats, settings: s, bytes3mf };
    showResult(m.stats);
    showPreview(m.preview);
  };
  worker.onerror = (e) => {
    state.slicing = false;
    bar.hidden = true;
    updateButtons();
    showProblems([`Slicing failed: ${e.message || 'worker error'}`]);
  };
  // Copy, so the placed mesh stays usable for the view and thumbnail.
  const tris = state.placed.slice();
  worker.postMessage({ tris, settings: s, modelName: state.source.name }, [tris.buffer]);
}

function hms(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function showResult(st) {
  $('stats').innerHTML = `
    <div><b>${hms(st.time)}</b><span>print time*</span></div>
    <div><b>${st.weight.toFixed(1)} g</b><span>${(st.filamentMM / 1000).toFixed(2)} m filament</span></div>
    <div><b>${st.layers}</b><span>layers</span></div>`;
  $('result').hidden = false;
  $('sendmsg').textContent = '*Estimate without the printer\'s start routine (homing, heating, calibration).';
  updateButtons();
}

function fileBase() {
  const s = state.result.settings;
  return `${state.source.name}_${short(s.processName).replace(/\s+/g, '_')}_${s.filament.type}`.replace(/[^\w.-]+/g, '_');
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function send() {
  const msg = $('sendmsg');
  const btn = $('send');
  btn.disabled = true;
  msg.textContent = 'Sending to the runner…';
  try {
    const name = fileBase() + '.gcode.3mf';
    const r = await fetch(`api/print?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Runner-Token': state.token || '' },
      body: state.result.bytes3mf,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    msg.textContent = 'Opened in Bambu Connect on your computer. Choose the printer there and press Print.';
  } catch (err) {
    msg.textContent = `Could not send: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- wiring ----------

async function main() {
  $('version').textContent = VERSION;
  state.token = takeToken();
  state.profiles = await (await fetch('profiles.json')).json();
  fillSelect(sel.printer, state.profiles.printers.map((p) => ({ value: p.name, label: p.name.replace('Bambu Lab ', '') })), store.get('printer', 'Bambu Lab A1 mini'));
  sel.support.checked = store.get('support', false);
  sel.brim.checked = store.get('brim', false);
  sel.color.value = store.get('color', '#00ae42');
  onPrinterChange();

  sel.printer.onchange = onPrinterChange;
  sel.process.onchange = () => { onProcessChange(); replace(); };
  sel.infill.oninput = () => { $('infillout').textContent = `${sel.infill.value}%`; invalidate(); };
  for (const el of [sel.filament, sel.bed, sel.walls, sel.support, sel.brim, sel.scale]) el.onchange = replace;
  sel.color.oninput = () => { if (modelMesh) modelMesh.material.color.set(sel.color.value); invalidate(); };
  for (const b of document.querySelectorAll('[data-rot]')) {
    b.onclick = () => { state.rot[b.dataset.rot] = (state.rot[b.dataset.rot] + 90) % 360; replace(); };
  }
  $('file').onchange = (e) => openFile(e.target.files[0]);
  $('file2').onchange = (e) => openFile(e.target.files[0]);
  $('slice').onclick = slice;
  $('send').onclick = send;
  $('dl3mf').onclick = () => download(state.result.bytes3mf, fileBase() + '.gcode.3mf', 'model/3mf');
  $('dlgcode').onclick = () => download(new TextEncoder().encode(state.result.gcode), fileBase() + '.gcode', 'text/x.gcode');
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { scene.background = new THREE.Color(themeColors().view); });
  await detectRunner();
}

main().catch((err) => showProblems([`Start-up failed: ${err.message}`]));
window.__ms = state; // for tests and debugging
