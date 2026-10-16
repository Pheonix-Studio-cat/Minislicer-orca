// UI in the style of OrcaSlicer's main window: Prepare/Preview tabs, Slice plate/Print plate,
// a sidebar with Printer, Filament and Process (Quality, Strength, Speed, Support, Others),
// the 3D plate with a toolbar, and the preview with OrcaSlicer's line-type colours and sliders.
// Preferences (language, button colour) and user presets (process and filament) as in OrcaSlicer.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { loadModel, placeOnBed, bounds, parseSTL } from './mesh.js';
import { resolveSettings, checkPlacement, formatMessage, BED_TYPES, VERSION } from './gcode.js';
import { buildGcode3mf } from './gcode3mf.js';
import { t, setLanguage, applyI18n, LANGUAGES, language } from './i18n.js';
import * as presets from './presets.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('ms.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ms.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = {
  profiles: null,
  source: null, // { name, tris }
  rot: { x: 0, y: 0, z: 0 },
  scale: 1,
  placed: null,
  overrides: {}, // edited process values by OrcaSlicer key, on top of the selected process preset
  result: null, // { gcode, stats, settings, bytes3mf, preview }
  runner: null,
  runnerStatus: ['Checking…'],
  token: null,
  tab: 'prepare',
  ptab: 'quality',
  problems: [],
  note: null, // [text, ...args]
};

// OrcaSlicer's process page, reduced to what this slicer implements. Keys, labels and group
// titles are OrcaSlicer's (PrintConfig.cpp, Tab.cpp), and so are the group icons.
const PARAM_TABS = [
  { key: 'quality', label: 'Quality', icon: 'custom-gcode_quality', groups: [
    { title: 'Layer height', icon: 'param_layer_height', params: [
      { key: 'layer_height', label: 'Layer height', unit: 'mm', step: 0.01, min: 0.04, max: 0.6 },
      { key: 'initial_layer_print_height', label: 'First layer height', unit: 'mm', step: 0.01, min: 0.04, max: 0.6 },
    ] },
  ] },
  { key: 'strength', label: 'Strength', icon: 'custom-gcode_strength', groups: [
    { title: 'Walls', icon: 'param_wall', params: [{ key: 'wall_loops', label: 'Wall loops', step: 1, min: 1, max: 20 }] },
    { title: 'Top/bottom shells', icon: 'param_shell', params: [
      { key: 'top_shell_layers', label: 'Top shell layers', step: 1, min: 0, max: 50 },
      { key: 'bottom_shell_layers', label: 'Bottom shell layers', step: 1, min: 0, max: 50 },
    ] },
    { title: 'Sparse infill', icon: 'param_infill', params: [{ key: 'sparse_infill_density', label: 'Sparse infill density', unit: '%', step: 5, min: 0, max: 100, percent: true }] },
  ] },
  { key: 'speed', label: 'Speed', icon: 'custom-gcode_speed', groups: [
    { title: 'First layer speed', icon: 'param_speed_first', params: [
      { key: 'initial_layer_speed', label: 'First layer', unit: 'mm/s', step: 1, min: 1, max: 500 },
      { key: 'initial_layer_infill_speed', label: 'First layer infill', unit: 'mm/s', step: 1, min: 1, max: 500 },
    ] },
    { title: 'Other layers speed', icon: 'param_speed', params: [
      { key: 'outer_wall_speed', label: 'Outer wall', unit: 'mm/s', step: 1, min: 1, max: 1000 },
      { key: 'inner_wall_speed', label: 'Inner wall', unit: 'mm/s', step: 1, min: 1, max: 1000 },
      { key: 'sparse_infill_speed', label: 'Sparse infill', unit: 'mm/s', step: 1, min: 1, max: 1000 },
      { key: 'internal_solid_infill_speed', label: 'Internal solid infill', unit: 'mm/s', step: 1, min: 1, max: 1000 },
      { key: 'top_surface_speed', label: 'Top surface', unit: 'mm/s', step: 1, min: 1, max: 1000 },
    ] },
    { title: 'Travel speed', icon: 'param_travel_speed', params: [{ key: 'travel_speed', label: 'Travel', unit: 'mm/s', step: 10, min: 10, max: 1000 }] },
  ] },
  { key: 'support', label: 'Support', icon: 'custom-gcode_support', groups: [
    { title: 'Support', icon: 'param_support', params: [
      { key: 'enable_support', label: 'Enable support', type: 'bool' },
      { key: 'support_threshold_angle', label: 'Threshold angle', unit: '°', step: 1, min: 0, max: 90 },
    ] },
  ] },
  { key: 'others', label: 'Others', icon: 'custom-gcode_other', groups: [
    { title: 'Bed adhesion', icon: 'param_adhension', params: [
      { key: 'brim_type', label: 'Brim type', type: 'enum', options: [['no_brim', 'No-brim'], ['outer_only', 'Outer brim only']] },
      { key: 'brim_width', label: 'Brim width', unit: 'mm', step: 0.5, min: 0, max: 50 },
    ] },
  ] },
];
const UI_ONLY = { enable_support: '0', brim_type: 'no_brim' }; // defaults of the keys the presets here do not set

// OrcaSlicer's filament settings (Tab.cpp, TabFilament): the Filament and Cooling pages.
// `plate: true` keys are stored per plate type (textured_plate_temp, hot_plate_temp, …).
const FILAMENT_TYPES = ['PLA', 'PLA-CF', 'PETG', 'PETG-CF', 'PET', 'ABS', 'ASA', 'TPU', 'PA', 'PA-CF', 'PC', 'PVA', 'HIPS'];
const FILAMENT_TABS = [
  { key: 'filament', label: 'Filament', icon: 'custom-gcode_filament', groups: [
    { title: 'Basic information', icon: 'param_information', params: [
      { key: 'filament_type', label: 'Type', type: 'enum', options: FILAMENT_TYPES.map((x) => [x, x]) },
      { key: 'filament_density', label: 'Density', unit: 'g/cm³', step: 0.01, min: 0.5, max: 5 },
      { key: 'filament_diameter', label: 'Diameter', unit: 'mm', step: 0.01, min: 1, max: 3 },
      { key: 'filament_flow_ratio', label: 'Flow ratio', step: 0.01, min: 0.5, max: 1.5 },
    ] },
    { title: 'Print temperature', icon: 'param_extruder_temp', params: [
      { key: 'nozzle_temperature_initial_layer', label: 'First layer nozzle temperature', unit: '°C', step: 1, min: 150, max: 350 },
      { key: 'nozzle_temperature', label: 'Nozzle temperature', unit: '°C', step: 1, min: 150, max: 350 },
    ] },
    { title: 'Bed temperature', icon: 'param_bed_temp', params: [
      { key: '_initial_layer', label: 'First layer bed temperature', unit: '°C', step: 1, min: 0, max: 120, plate: true },
      { key: '', label: 'Bed temperature', unit: '°C', step: 1, min: 0, max: 120, plate: true },
    ] },
    { title: 'Volumetric speed limitation', icon: 'param_volumetric_speed', params: [
      { key: 'filament_max_volumetric_speed', label: 'Max volumetric speed', unit: 'mm³/s', step: 0.5, min: 1, max: 100 },
    ] },
  ] },
  { key: 'cooling', label: 'Cooling', icon: 'custom-gcode_cooling_fan', groups: [
    { title: 'Cooling for specific layer', icon: 'param_cooling_specific_layer', params: [
      { key: 'close_fan_the_first_x_layers', label: 'No cooling for the first', unit: 'layers', step: 1, min: 0, max: 20 },
    ] },
    { title: 'Part cooling fan', icon: 'param_cooling_part_fan', params: [
      { key: 'fan_min_speed', label: 'Min fan speed', unit: '%', step: 5, min: 0, max: 100 },
      { key: 'fan_max_speed', label: 'Max fan speed', unit: '%', step: 5, min: 0, max: 100 },
      { key: 'slow_down_layer_time', label: 'Layer time', unit: 's', step: 1, min: 0, max: 60 },
      { key: 'slow_down_min_speed', label: 'Min print speed', unit: 'mm/s', step: 1, min: 1, max: 100 },
    ] },
  ] },
];

// Button colours offered in Preferences: OrcaSlicer's own palette (StateColor.cpp) plus Bambu green.
const ACCENTS = [
  { name: 'OrcaSlicer', light: '#009688', dark: '#00675B' },
  { name: 'Bambu', light: '#00AE42', dark: '#00873A' },
  { name: 'Blue', light: '#1F8EEA', dark: '#2778D2' },
  { name: 'Orange', light: '#FF6F00', dark: '#D15B00' },
  { name: 'Red', light: '#D01B1B', dark: '#BB2A3A' },
  { name: 'Purple', light: '#8E5CD9', dark: '#6F45B5' },
];

// OrcaSlicer's line-type colours (src/libvgcode/src/ViewerImpl.cpp, DEFAULT_EXTRUSION_ROLES_COLORS).
const FEATURE_COLORS = {
  'Inner wall': 0xFFE64D, 'Outer wall': 0xFF7D38, 'Sparse infill': 0xB03029, 'Internal solid infill': 0x9654CC,
  'Top surface': 0xF04040, 'Bottom surface': 0x665CC7, Support: 0x00FF00, 'Support interface': 0x008000, Brim: 0x003B6E,
};

const dark = matchMedia('(prefers-color-scheme: dark)');
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------- runner ----------

function takeToken() {
  const url = new URL(location.href);
  const tok = url.searchParams.get('token');
  if (tok) {
    store.set('token', tok);
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return store.get('token', null);
}

function renderRunner() {
  const text = t(...state.runnerStatus);
  $('runnertext').textContent = text;
  $('runner').title = text;
  $('runner').className = paired() ? 'runner ok' : 'runner';
}

async function detectRunner() {
  try {
    const r = await fetch('api/status', { cache: 'no-store', headers: state.token ? { 'X-Runner-Token': state.token } : {} });
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    if (s.app !== 'minislicer-runner') throw new Error('not the runner');
    state.runner = s;
    if (!s.paired) state.runnerStatus = ['Runner found - scan its QR code to pair'];
    else if (s.bambuConnect === false) state.runnerStatus = ['Bambu Connect not found'];
    else state.runnerStatus = ['Runner on %1%', s.host || 'computer'];
  } catch {
    state.runner = null;
    state.runnerStatus = ['No runner - export only'];
  }
  renderRunner();
  updateButtons();
}

const paired = () => Boolean(state.runner && state.runner.paired);

// ---------- preferences: language and button colour ----------

function applyAccent(choice) {
  const root = document.documentElement.style;
  let light = choice, darkVariant = choice;
  const preset = ACCENTS.find((a) => a.light.toLowerCase() === String(choice).toLowerCase());
  if (preset) { light = preset.light; darkVariant = preset.dark; }
  else {
    // A custom colour: darken it for dark mode the way OrcaSlicer maps #009688 to #00675B (×0.69).
    const n = parseInt(String(choice).slice(1), 16);
    darkVariant = '#' + [16, 8, 0].map((sh) => Math.round(((n >> sh) & 255) * 0.69).toString(16).padStart(2, '0')).join('');
  }
  root.setProperty('--accent', light);
  root.setProperty('--accent-dark', darkVariant);
  for (const b of document.querySelectorAll('.accent')) b.setAttribute('aria-checked', String(b.dataset.color.toLowerCase() === light.toLowerCase()));
  $('accentcustom').value = light;
}

function renderPrefs() {
  const lang = $('lang');
  lang.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}"${l.code === language() ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
  $('accents').innerHTML = ACCENTS.map((a) => `<button type="button" class="accent" role="radio" data-color="${a.light}" title="${esc(a.name)}" aria-label="${esc(a.name)}" style="background:${a.light}"></button>`).join('');
  for (const b of $('accents').querySelectorAll('.accent')) b.onclick = () => { store.set('accent', b.dataset.color); applyAccent(b.dataset.color); };
  applyAccent(store.get('accent', ACCENTS[0].light));
  const note = $('langnote');
  note.hidden = language() === 'en';
  note.textContent = t('Translations come from OrcaSlicer where it has the same text; the rest is machine-translated.');
}

async function changeLanguage(code) {
  await setLanguage(code);
  store.set('lang', code);
  retranslate();
}

// Everything built in JavaScript is rebuilt in the new language.
function retranslate() {
  applyI18n(document);
  renderRunner();
  renderPrefs();
  fillBedSelect(currentPrinter());
  renderNozzleInfo();
  renderPtabs();
  renderParams();
  fillPresetSelects(currentPrinter(), sel.process.value, sel.filament.value);
  showProblems(state.problems);
  renderNote();
  $('licence').textContent = t('Minislicer Mobile %1% is free software under the', VERSION);
  if (state.result && previewLines) renderLegend();
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
const bedModels = new Map(); // path -> Promise<Float32Array|null>

function loadBedModel(path) {
  if (!bedModels.has(path)) {
    bedModels.set(path, fetch(path).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? parseSTL(b) : null)).catch(() => null));
  }
  return bedModels.get(path);
}

// The printer's own bed model from OrcaSlicer's profile, OrcaSlicer's bed and grid colours.
async function buildBed(printer, s) {
  const isDark = dark.matches;
  const w = s.bed.maxX - s.bed.minX, d = s.bed.maxY - s.bed.minY;
  const bedColor = isDark ? 0x414148 : 0x535656; // Bed3D::DEFAULT_MODEL_COLOR(_DARK)
  const tris = printer.bed_model ? await loadBedModel(printer.bed_model) : null;
  bedGroup.clear();
  if (tris) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    g.computeVertexNormals();
    bedGroup.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: bedColor, roughness: 0.95 })));
  } else {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: bedColor, roughness: 0.95 }));
    plate.position.set(s.bed.minX + w / 2, s.bed.minY + d / 2, -0.01);
    bedGroup.add(plate);
  }
  const grid = [];
  for (let x = s.bed.minX; x <= s.bed.maxX + 0.1; x += 10) grid.push(x, s.bed.minY, 0.02, x, s.bed.maxY, 0.02);
  for (let y = s.bed.minY; y <= s.bed.maxY + 0.1; y += 10) grid.push(s.bed.minX, y, 0.02, s.bed.maxX, y, 0.02);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
  bedGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xe6e6e6, transparent: true, opacity: 0.35 })));
  const shade = (x0, y0, x1, y1, color, opacity) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), new THREE.MeshBasicMaterial({ color, transparent: true, opacity }));
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.03);
    bedGroup.add(m);
  };
  if (s.bedExclude) shade(s.bedExclude.minX, s.bedExclude.minY, s.bedExclude.maxX, s.bedExclude.maxY, 0x8a3a3a, 1);
  // Dual-nozzle printers: the strips the printing nozzle cannot reach.
  if (s.area.minX > s.bed.minX) shade(s.bed.minX, s.bed.minY, s.area.minX, s.bed.maxY, 0x000000, 0.35);
  if (s.area.maxX < s.bed.maxX) shade(s.area.maxX, s.bed.minY, s.bed.maxX, s.bed.maxY, 0x000000, 0.35);
  scene.background = new THREE.Color(cssVar('--canvas') || '#E7E7E7');
  if (!state.placed) frameBed(s);
}

function frameBed(s) {
  const w = s.bed.maxX - s.bed.minX, d = s.bed.maxY - s.bed.minY;
  controls.target.set(s.bed.minX + w / 2, s.bed.minY + d / 2, 0);
  camera.position.set(s.bed.minX + w / 2, s.bed.minY - d * 0.95, Math.max(w, d) * 1.05);
  camera.far = Math.max(w, d) * 20;
  camera.updateProjectionMatrix();
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
  const r = Math.max(25, Math.hypot(...b.size) / 2);
  const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.5;
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
  modelMesh.visible = state.tab === 'prepare' || !previewLines;
  scene.add(modelMesh);
}

function setIcons() {
  for (const img of document.querySelectorAll('img[data-icon]')) {
    img.src = `assets/icons/${img.dataset.icon}${dark.matches ? '_dark' : ''}.svg`;
  }
}

// ---------- preview ----------

function clearPreview() {
  if (previewLines) { scene.remove(previewLines); previewLines.geometry.dispose(); previewLines = null; }
  $('vslider').hidden = true;
  $('hslider').hidden = true;
  $('legend').hidden = true;
  $('canvas').parentElement.classList.remove('previewing');
}

function fmtTime(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function buildPreview() {
  const pv = state.result.preview;
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

  const layer = $('layer');
  const move = $('move');
  layer.max = String(pv.z.length);
  layer.value = String(pv.z.length);
  move.value = move.max;
  $('vs-z0').textContent = pv.z[0].toFixed(2);
  const update = () => {
    const k = +layer.value;
    const a = pv.layerStart[k - 1], b = pv.layerStart[k];
    g.setDrawRange(0, Math.round(a + ((b - a) * +move.value) / +move.max) * 2);
    $('vs-layer').textContent = String(k);
    $('vs-z').textContent = pv.z[k - 1].toFixed(2);
  };
  layer.oninput = () => { move.value = move.max; update(); };
  move.oninput = update;
  update();
  // Starts folded on phones so it does not cover the model; tap the title to unfold.
  $('legend').classList.toggle('folded', canvas.clientWidth < 600);
  renderLegend();
}

// "Line Type" legend with time and percentage per feature, like OrcaSlicer's.
function renderLegend() {
  const pv = state.result.preview;
  const st = state.result.stats;
  const legend = $('legend');
  const rows = pv.features.filter((f) => st.featureTime[f] > 0);
  const total = rows.reduce((sum, f) => sum + st.featureTime[f], 0) || 1;
  legend.innerHTML = `<h4 role="button" tabindex="0">${esc(t('Line Type'))}</h4><table>${rows.map((f) => `<tr><td><i style="background:#${FEATURE_COLORS[f].toString(16).padStart(6, '0')}"></i>${esc(t(f))}</td>`
    + `<td class="n">${fmtTime(st.featureTime[f])}</td><td class="n">${((100 * st.featureTime[f]) / total).toFixed(1)}%</td></tr>`).join('')}</table>`
    + `<div class="sum"><span>${esc(t('Model printing time'))}</span><span>${fmtTime(st.time)}</span>`
    + `<span>${esc(t('Total Filament'))}</span><span>${(st.filamentMM / 1000).toFixed(2)} m / ${st.weight.toFixed(2)} g</span>`
    + `<span>${esc(t('Layers'))}</span><span>${st.layers}</span></div>`;
  legend.querySelector('h4').onclick = () => legend.classList.toggle('folded');
}

function showTab(tab) {
  state.tab = tab;
  for (const [id, name] of [['tab-prepare', 'prepare'], ['tab-preview', 'preview']]) {
    $(id).classList.toggle('active', name === tab);
    $(id).setAttribute('aria-selected', String(name === tab));
  }
  const preview = tab === 'preview' && state.result;
  if (preview && !previewLines) buildPreview();
  if (previewLines) previewLines.visible = Boolean(preview);
  if (modelMesh) modelMesh.visible = !preview;
  $('vslider').hidden = $('hslider').hidden = $('legend').hidden = !preview;
  $('canvas').parentElement.classList.toggle('previewing', Boolean(preview));
  $('cvtoolbar').hidden = tab === 'preview';
  closeGizmos();
  if (tab === 'preview' && !state.result && state.placed && !state.blocked && !state.slicing) slice();
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
    s.add(sun.clone());
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

const sel = { printer: $('printer'), bed: $('bed'), filament: $('filament'), process: $('process'), color: $('color'), scale: $('scale') };

function fillSelect(el, groups, value) {
  el.innerHTML = '';
  for (const g of groups) {
    if (!g.items.length) continue;
    const parent = g.label ? document.createElement('optgroup') : el;
    if (g.label) { parent.label = g.label; el.append(parent); }
    for (const it of g.items) {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      parent.append(o);
    }
  }
  if ([...el.options].some((o) => o.value === value)) el.value = value;
}

const currentPrinter = () => state.profiles.printers.find((p) => p.name === sel.printer.value) || state.profiles.printers[0];
const resolved = (kind) => presets.resolve(kind, currentPrinter(), (kind === 'process' ? sel.process : sel.filament).value)
  || presets.resolve(kind, currentPrinter(), (kind === 'process' ? currentPrinter().processes : currentPrinter().filaments)[0].name);
const currentProcess = () => resolved('process').preset;
const currentFilament = () => resolved('filament').preset;
const presetValue = (key) => {
  const v = currentProcess()[key] ?? UI_ONLY[key];
  return Array.isArray(v) ? v[0] : v;
};
const paramValue = (key) => state.overrides[key] ?? presetValue(key);

function fillPresetSelects(p, processName, filamentName) {
  const named = (list) => list.map((x) => ({ value: x.name, label: x.name }));
  fillSelect(sel.process, [
    { label: t('System presets'), items: named(p.processes) },
    { label: t('User presets'), items: named(presets.userPresets('process', p)) },
  ], processName);
  fillSelect(sel.filament, [
    { label: t('System presets'), items: named(p.filaments) },
    { label: t('User presets'), items: named(presets.userPresets('filament', p)) },
  ], filamentName);
  $('pdel').hidden = !resolved('process').user;
}

function fillBedSelect(p) {
  fillSelect(sel.bed, [{ items: BED_TYPES.map((b) => ({ value: b.name, label: t(b.label) })) }], sel.bed.value || store.get('bed:' + p.name, p.default_bed_type));
}

function renderNozzleInfo() {
  const p = currentPrinter();
  const ext = p.extruders || { count: 1, nozzle_diameters: [0.4], master: 0 };
  $('nozzleinfo').textContent = ext.count > 1
    ? t('Nozzle %1% mm, prints with the right nozzle', ext.nozzle_diameters[ext.master])
    : t('Nozzle %1% mm', ext.nozzle_diameters[0]);
}

function onPrinterChange() {
  const p = currentPrinter();
  fillPresetSelects(p, store.get('process:' + p.name, (p.processes.find((x) => x.name.startsWith('0.20mm Standard')) || p.processes[0]).name),
    store.get('filament:' + p.name, p.filaments[0].name));
  sel.bed.value = '';
  fillBedSelect(p);
  renderNozzleInfo();
  $('cover').src = p.cover || '';
  $('cover').hidden = !p.cover;
  state.overrides = keepUiOnly(state.overrides);
  applyFilamentColour();
  renderParams();
  buildBed(p, settings());
  replace(true);
}

// Support and brim are on/off choices of the user, not of a quality preset: keep them when the preset changes.
function keepUiOnly(o) {
  const kept = {};
  for (const k of Object.keys(UI_ONLY)) if (k in o) kept[k] = o[k];
  return kept;
}

function renderPtabs() {
  $('ptabs').innerHTML = PARAM_TABS.map((tb) => `<button class="ptab${tb.key === state.ptab ? ' on' : ''}" role="tab" data-ptab="${tb.key}" aria-selected="${tb.key === state.ptab}">`
    + `<img src="assets/icons/${tb.icon}.svg" alt="">${esc(t(tb.label))}</button>`).join('');
  for (const b of $('ptabs').querySelectorAll('.ptab')) b.onclick = () => { state.ptab = b.dataset.ptab; renderPtabs(); renderParams(); };
}

/**
 * Renders a page of OrcaSlicer-style option rows into `box`. `get(key)` gives the current value,
 * `base(key)` the preset's, `set(key, value)` stores an edit. Edited rows turn to the accent
 * colour and get OrcaSlicer's undo arrow to go back to the preset value.
 */
function renderOptions(box, page, { get, base, set, keyOf = (p) => p.key }) {
  box.innerHTML = '';
  for (const g of page.groups) {
    const h = document.createElement('div');
    h.className = 'pgroup';
    h.innerHTML = `${g.icon ? `<img src="assets/icons/${g.icon}.svg" alt="">` : ''}<span>${esc(t(g.title))}</span>`;
    box.append(h);
    for (const p of g.params) {
      const key = keyOf(p);
      const row = document.createElement('div');
      const raw = get(key);
      const changed = raw !== base(key);
      row.className = 'prow' + (changed ? ' changed' : '');
      const id = 'p-' + key;
      let input;
      if (p.type === 'bool') {
        input = `<input type="checkbox" id="${id}"${raw === '1' ? ' checked' : ''}>`;
      } else if (p.type === 'enum') {
        const opts = p.options.some(([v]) => v === raw) ? p.options : [[raw, raw], ...p.options];
        input = `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === raw ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}</select>`;
      } else {
        const v = parseFloat(raw);
        input = `<input type="number" id="${id}" inputmode="decimal" step="${p.step}" min="${p.min}" max="${p.max}" value="${Number.isFinite(v) ? v : ''}"><span class="unit">${esc(p.unit ? t(p.unit) : '')}</span>`;
      }
      const reset = changed ? `<button type="button" class="reset" title="${esc(t('Reset'))}" aria-label="${esc(t('Reset'))}"><img src="assets/icons/undo.svg" alt=""></button>` : '';
      row.innerHTML = `<label for="${id}">${esc(t(p.label))}</label>${reset}<span class="pin">${input}</span>`;
      box.append(row);
      const el = row.querySelector('#' + CSS.escape(id));
      el.onchange = () => {
        let v;
        if (p.type === 'bool') v = el.checked ? '1' : '0';
        else if (p.type === 'enum') v = el.value;
        else {
          let x = parseFloat(el.value);
          if (!Number.isFinite(x)) x = parseFloat(base(key));
          x = Math.min(p.max, Math.max(p.min, x));
          el.value = String(x);
          v = p.percent ? `${x}%` : String(x);
        }
        set(key, v, p);
      };
      if (reset) row.querySelector('.reset').onclick = () => set(key, base(key), p);
    }
  }
}

function renderParams() {
  const page = PARAM_TABS.find((tb) => tb.key === state.ptab);
  renderOptions($('params'), page, {
    get: paramValue,
    base: presetValue,
    set: (key, v) => {
      if (v === presetValue(key) && !(key in UI_ONLY)) delete state.overrides[key];
      else state.overrides[key] = v;
      if (key in UI_ONLY) store.set('param:' + key, v);
      renderParams();
      replace();
    },
  });
}

function settings() {
  const p = currentPrinter();
  const process = {};
  for (const [k, v] of Object.entries(state.overrides)) if (!(k in UI_ONLY)) process[k] = v;
  return resolveSettings(p, currentProcess(), currentFilament(), {
    bedType: sel.bed.value,
    process,
    support: paramValue('enable_support') === '1',
    brim: paramValue('brim_type') !== 'no_brim',
    color: sel.color.value.toUpperCase(),
  });
}

function saveSettings() {
  const p = currentPrinter();
  store.set('printer', p.name);
  store.set('process:' + p.name, sel.process.value);
  store.set('filament:' + p.name, sel.filament.value);
  store.set('bed:' + p.name, sel.bed.value);
}

// The colour swatch shows the filament preset's colour until the user picks another.
function applyFilamentColour() {
  const c = currentFilament().default_filament_colour;
  const own = store.get('color', null);
  sel.color.value = own || (Array.isArray(c) && /^#[0-9a-f]{6}$/i.test(c[0]) ? c[0] : '#00ae42');
  updateSwatch();
}

// ---------- user presets ----------

/** Asks for a preset name (OrcaSlicer's save dialog); resolves to the name or null. */
function askName(kind, suggested, replacing) {
  const dlg = $('dlg-save');
  const input = $('savename');
  const err = $('saveerr');
  input.value = suggested;
  err.hidden = true;
  return new Promise((resolve) => {
    const check = () => {
      const m = presets.validateName(kind, currentPrinter(), input.value, replacing);
      err.textContent = m ? t(m) : '';
      err.hidden = !m;
      $('saveok').disabled = Boolean(m);
      return !m;
    };
    input.oninput = check;
    check();
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && check() ? input.value.trim() : null);
    dlg.returnValue = '';
    dlg.showModal();
    input.select();
  });
}

const baseName = (name) => name.replace(/ @BBL.*$/, '');

async function saveProcessPreset() {
  const r = resolved('process');
  const values = { ...r.values };
  for (const [k, v] of Object.entries(state.overrides)) if (!(k in UI_ONLY)) values[k] = v;
  const name = await askName('process', r.user ? r.preset.name : `${baseName(r.preset.name)} - ${t('Custom')}`, r.user ? r.preset.name : null);
  if (!name) return;
  if (!presets.save('process', { name, inherits: r.user ? r.inherits : r.preset.name, values })) return note(['Could not save: the browser storage is full or disabled.']);
  state.overrides = keepUiOnly(state.overrides);
  fillPresetSelects(currentPrinter(), name, sel.filament.value);
  renderParams();
  replace();
  note(['Preset "%1%" saved.', name]);
}

function deleteProcessPreset() {
  const r = resolved('process');
  if (!r.user || !confirm(`${t('Delete preset')}: ${r.preset.name}?`)) return;
  presets.remove('process', r.preset.name);
  fillPresetSelects(currentPrinter(), r.inherits, sel.filament.value);
  state.overrides = keepUiOnly(state.overrides);
  renderParams();
  replace();
}

// Filament settings dialog: edits a copy of the selected filament preset; "Save as" stores it as
// a user preset (OrcaSlicer saves edited system presets the same way).
let fdraft = null;
function openFilamentEditor() {
  const r = resolved('filament');
  const bedKey = (BED_TYPES.find((b) => b.name === sel.bed.value) || BED_TYPES[0]).key;
  fdraft = { r, bedKey, values: {}, tab: 'filament' };
  $('fename').textContent = r.preset.name;
  renderFilamentEditor();
  const dlg = $('dlg-filament');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    const name = await askName('filament', r.user ? r.preset.name : `${baseName(r.preset.name)} - ${t('Custom')}`, r.user ? r.preset.name : null);
    if (!name) return;
    const values = { ...r.values, ...fdraft.values };
    if (!presets.save('filament', { name, inherits: r.user ? r.inherits : r.preset.name, values })) return note(['Could not save: the browser storage is full or disabled.']);
    fillPresetSelects(currentPrinter(), sel.process.value, name);
    applyFilamentColour();
    replace();
    note(['Preset "%1%" saved.', name]);
  };
  dlg.returnValue = '';
  dlg.showModal();
}

function renderFilamentEditor() {
  const d = fdraft;
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const keyOf = (p) => (p.plate ? d.bedKey + p.key : p.key);
  $('ftabs').innerHTML = FILAMENT_TABS.map((tb) => `<button type="button" class="ptab${tb.key === d.tab ? ' on' : ''}" data-ftab="${tb.key}">`
    + `<img src="assets/icons/${tb.icon}.svg" alt="">${esc(t(tb.label))}</button>`).join('');
  for (const b of $('ftabs').querySelectorAll('.ptab')) b.onclick = () => { d.tab = b.dataset.ftab; renderFilamentEditor(); };
  renderOptions($('fparams'), FILAMENT_TABS.find((tb) => tb.key === d.tab), {
    keyOf,
    get: (k) => first(d.values[k] ?? d.r.preset[k]) ?? '',
    base: (k) => first(d.r.preset[k]) ?? '',
    // Filament options are vectors in OrcaSlicer (one value per extruder variant).
    set: (k, v) => {
      if (v === first(d.r.preset[k])) delete d.values[k];
      else d.values[k] = [v];
      renderFilamentEditor();
    },
  });
}

function exportPresets() {
  download(new TextEncoder().encode(presets.exportJSON()), 'minislicer-user-presets.json', 'application/json');
}

async function importPresets(file) {
  const out = $('presetmsg');
  try {
    const n = presets.importJSON(await file.text());
    out.textContent = t('%1% presets imported.', n);
    fillPresetSelects(currentPrinter(), sel.process.value, sel.filament.value);
  } catch (err) {
    out.textContent = t('Could not import: %1%', err.message);
  }
}

// ---------- model ----------

function replace(reframe = false) {
  invalidate();
  updateSwatch();
  $('pdel').hidden = !resolved('process').user;
  if (!state.source) return;
  const s = settings();
  state.placed = placeOnBed(state.source.tris, {
    scale: state.scale, rotX: state.rot.x, rotY: state.rot.y, rotZ: state.rot.z,
    cx: (s.area.minX + s.area.maxX) / 2, cy: (s.area.minY + s.area.maxY) / 2,
  });
  const b = bounds(state.placed);
  $('modelsize').textContent = `${b.size[0].toFixed(1)} × ${b.size[1].toFixed(1)} × ${b.size[2].toFixed(1)} mm`;
  showModel(state.placed, sel.color.value);
  if (reframe) frame(b);
  showProblems(checkPlacement(s, b));
}

// Messages are { text, args } (English text with %1%…) so they can be re-translated.
function showProblems(list) {
  state.problems = list;
  const box = $('problems');
  box.innerHTML = list.map((m) => `<p>${esc(formatMessage(m, t))}</p>`).join('');
  box.hidden = !list.length;
  state.blocked = list.length > 0;
  updateButtons();
}

const msg = (text, ...args) => ({ text, args });

function note(parts) {
  state.note = parts && parts.length ? parts : null;
  renderNote();
}

function renderNote() {
  const n = $('sendmsg');
  n.textContent = state.note ? t(...state.note) : '';
  n.hidden = !state.note;
}

function invalidate() {
  state.result = null;
  note(null);
  clearPreview();
  if (modelMesh) modelMesh.visible = true;
  if (state.tab === 'preview') showTab('prepare');
}

function updateButtons() {
  const ready = Boolean(state.placed) && !state.blocked && !state.slicing;
  $('slice').disabled = !ready;
  $('print').disabled = !ready;
  $('printmenu').disabled = !ready;
  for (const id of ['arrange', 'tool-rotate', 'tool-scale']) $(id).disabled = !state.placed;
}

function updateSwatch() {
  const sw = document.querySelector('.swatch');
  const hex = sel.color.value;
  sw.style.background = hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  sw.style.color = r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#000' : '#fff';
}

async function openFile(file) {
  if (!file) return;
  try {
    const tris = await loadModel(file.name, await file.arrayBuffer());
    if (!tris.length) throw new Error('the file has no triangles');
    state.source = { name: file.name.replace(/\.(stl|3mf|obj)$/i, ''), tris };
    state.rot = { x: 0, y: 0, z: 0 };
    state.scale = 1;
    sel.scale.value = 100;
    $('empty').hidden = true;
    replace(true);
  } catch (err) {
    showProblems([msg('Could not open %1%: %2%', file.name, err.message)]);
  }
}

function closeGizmos(except) {
  for (const [btn, box] of [['tool-rotate', 'gizmo-rotate'], ['tool-scale', 'gizmo-scale']]) {
    const open = btn === except && $(box).hidden;
    $(box).hidden = !open;
    $(btn).classList.toggle('on', open);
  }
}

// ---------- slicing ----------

let worker = null;
let slicing = null; // Promise of the running slice
const STAGES = { Slicing: 'Slicing', Walls: 'Walls', Shells: 'Top/bottom shells', Toolpaths: 'Toolpaths' };

function slice() {
  if (!state.placed || state.blocked) return Promise.resolve(false);
  if (slicing) return slicing;
  const s = settings();
  saveSettings();
  invalidate();
  state.slicing = true;
  updateButtons();
  const bar = $('progress');
  bar.hidden = false;
  const setBar = (p, label) => { bar.querySelector('.note-bar div').style.width = `${Math.round(p * 100)}%`; bar.querySelector('.note-text').textContent = label; };
  setBar(0, t('Slicing'));
  if (worker) worker.terminate();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  slicing = new Promise((resolve) => {
    const finish = (ok) => {
      if (worker) worker.terminate();
      worker = null;
      state.slicing = false;
      slicing = null;
      bar.hidden = true;
      updateButtons();
      resolve(ok);
    };
    worker.onmessage = async (ev) => {
      const m = ev.data;
      if (m.type === 'progress') return setBar(m.p, `${t(STAGES[m.stage] || m.stage)}… ${Math.round(m.p * 100)}%`);
      if (m.type === 'error') { showProblems([msg('Slicing failed: %1%', m.message)]); return finish(false); }
      const thumb = await thumbnail().catch(() => null);
      const bytes3mf = await buildGcode3mf({ gcode: m.gcode, stats: m.stats, settings: s, title: state.source.name, thumbnailPNG: thumb });
      state.result = { gcode: m.gcode, stats: m.stats, settings: s, bytes3mf, preview: m.preview };
      finish(true);
      showTab('preview');
    };
    worker.onerror = (e) => { showProblems([msg('Slicing failed: %1%', e.message || 'worker error')]); finish(false); };
  });
  const tris = state.placed.slice(); // keep our copy for the view and the thumbnail
  worker.postMessage({ tris, settings: s, modelName: state.source.name }, [tris.buffer]);
  return slicing;
}

function fileBase() {
  const s = state.result.settings;
  return `${state.source.name}_${baseName(s.processName).replace(/\s+/g, '_')}_${s.filament.type}`.replace(/[^\w.-]+/g, '_');
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

async function ensureSliced() {
  return state.result ? true : slice();
}

async function printPlate() {
  if (!(await ensureSliced())) return;
  if (!paired()) {
    note(['No paired runner: use the arrow next to Print plate to export the file, or start the Minislicer Runner and scan its QR code.']);
    $('printdrop').hidden = false;
    return;
  }
  $('print').disabled = true;
  note(['Sending to Bambu Connect…']);
  try {
    const name = fileBase() + '.gcode.3mf';
    const r = await fetch(`api/print?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Runner-Token': state.token || '' },
      body: state.result.bytes3mf,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    note(['Opened in Bambu Connect on your computer. Choose the printer there and press Print.']);
  } catch (err) {
    note(['Could not send: %1%', err.message]);
  } finally {
    updateButtons();
  }
}

async function exportFile(kind) {
  $('printdrop').hidden = true;
  if (!(await ensureSliced())) return;
  if (kind === '3mf') download(state.result.bytes3mf, fileBase() + '.gcode.3mf', 'model/3mf');
  else download(new TextEncoder().encode(state.result.gcode), fileBase() + '.gcode', 'text/x.gcode');
}

// ---------- wiring ----------

async function main() {
  setIcons();
  state.token = takeToken();
  state.profiles = await (await fetch('profiles.json')).json();
  await setLanguage(store.get('lang', 'en')).catch(() => setLanguage('en'));
  renderPrefs();
  fillSelect(sel.printer, [{ items: state.profiles.printers.map((p) => ({ value: p.name, label: `${p.name} 0.4 nozzle` })) }], store.get('printer', 'Bambu Lab A1 mini'));
  for (const k of Object.keys(UI_ONLY)) {
    const v = store.get('param:' + k, null);
    if (v !== null) state.overrides[k] = v;
  }
  renderPtabs();
  onPrinterChange();
  retranslate();

  sel.printer.onchange = onPrinterChange;
  sel.process.onchange = () => {
    state.overrides = keepUiOnly(state.overrides);
    renderParams();
    replace();
  };
  sel.filament.onchange = () => { store.set('color', null); applyFilamentColour(); replace(); };
  sel.bed.onchange = () => replace();
  sel.color.oninput = () => { store.set('color', sel.color.value); updateSwatch(); if (modelMesh) modelMesh.material.color.set(sel.color.value); invalidate(); };
  sel.scale.onchange = () => {
    const v = Math.min(1000, Math.max(1, +sel.scale.value || 100));
    sel.scale.value = v;
    state.scale = v / 100;
    replace();
  };
  for (const b of document.querySelectorAll('[data-rot]')) {
    b.onclick = () => { state.rot[b.dataset.rot] = (state.rot[b.dataset.rot] + 90) % 360; replace(); };
  }
  $('tool-rotate').onclick = () => closeGizmos('tool-rotate');
  $('tool-scale').onclick = () => closeGizmos('tool-scale');
  $('arrange').onclick = () => replace(true);
  $('file').onchange = (e) => openFile(e.target.files[0]);
  $('file2').onchange = (e) => openFile(e.target.files[0]);
  $('tab-prepare').onclick = () => showTab('prepare');
  $('tab-preview').onclick = () => showTab('preview');
  $('slice').onclick = () => slice();
  $('print').onclick = printPlate;
  $('printmenu').onclick = (e) => { e.stopPropagation(); $('printdrop').hidden = !$('printdrop').hidden; };
  $('dl3mf').onclick = () => exportFile('3mf');
  $('dlgcode').onclick = () => exportFile('gcode');
  $('prefs').onclick = () => { renderPrefs(); $('presetmsg').textContent = ''; $('dlg-prefs').showModal(); };
  $('lang').onchange = () => changeLanguage($('lang').value);
  $('accentcustom').oninput = () => { store.set('accent', $('accentcustom').value); applyAccent($('accentcustom').value); };
  $('psave').onclick = saveProcessPreset;
  $('pdel').onclick = deleteProcessPreset;
  $('fedit').onclick = openFilamentEditor;
  $('pexport').onclick = exportPresets;
  $('pimport').onchange = (e) => { if (e.target.files[0]) importPresets(e.target.files[0]); e.target.value = ''; };
  document.addEventListener('click', (e) => { if (!e.target.closest('.split')) $('printdrop').hidden = true; });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });
  dark.addEventListener('change', () => { setIcons(); buildBed(currentPrinter(), settings()); });
  await detectRunner();
}

main().catch((err) => showProblems([msg('Start-up failed: %1%', err.message)]));
window.__ms = state; // for tests and debugging
