// Settings resolution and G-code generation for Bambu Lab printers.
//
// The start, end and layer-change G-code are the printer's own templates from
// resources/profiles/BBL (via profiles.json), rendered with the same variables OrcaSlicer
// sets (see GCode.cpp, _do_export). Comments and markers follow OrcaSlicer's output so the
// printer reads the layer count, progress and time the same way.

import { render } from './template.js';
import { SCALE } from './slicer.js';

export const VERSION = '0.1.0';

export const BED_TYPES = [
  { name: 'Textured PEI Plate', key: 'textured_plate_temp' },
  { name: 'Cool Plate', key: 'cool_plate_temp' },
  { name: 'Engineering Plate', key: 'eng_plate_temp' },
  { name: 'High Temp Plate', key: 'hot_plate_temp' },
];

const num = (v) => {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === null || s === 'nil' ? undefined : parseFloat(s);
};
const pct = (v, of) => {
  const s = String(Array.isArray(v) ? v[0] : v);
  return s.endsWith('%') ? (parseFloat(s) / 100) * of : parseFloat(s);
};

export function parseArea(area) {
  const pts = area.map((s) => s.split('x').map(Number));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Turns the profile strings into numbers; `o` holds the user's overrides from the UI. */
export function resolveSettings(printer, process, filament, o = {}) {
  const m = printer.machine;
  const bedType = o.bedType || printer.default_bed_type;
  const bedKey = (BED_TYPES.find((b) => b.name === bedType) || BED_TYPES[0]).key;
  const lw = num(process.line_width);
  const width = (k) => pct(process[k] ?? process.line_width, num(m.nozzle_diameter)) || lw;
  const accel = (k) => {
    const d = num(process.default_acceleration);
    const v = process[k] === undefined ? 0 : pct(process[k], d);
    return v > 0 ? v : d;
  };
  const filamentRetract = num(filament.filament_retraction_length);
  const s = {
    printerName: printer.name,
    printerModel: m.printer_model,
    modelId: printer.model_id,
    processName: process.name,
    filamentName: filament.name,
    bed: parseArea(m.printable_area),
    bedExclude: m.bed_exclude_area && m.bed_exclude_area.length ? parseArea(m.bed_exclude_area) : null,
    maxHeight: num(m.printable_height),
    nozzle: num(m.nozzle_diameter),
    bedType,
    layerHeight: o.layerHeight ?? num(process.layer_height),
    firstLayerHeight: num(process.initial_layer_print_height),
    wallLoops: o.wallLoops ?? num(process.wall_loops),
    topLayers: num(process.top_shell_layers),
    bottomLayers: num(process.bottom_shell_layers),
    infillDensity: o.infillDensity ?? pct(process.sparse_infill_density, 1),
    width: {
      outer: width('outer_wall_line_width'),
      inner: width('inner_wall_line_width'),
      sparse: width('sparse_infill_line_width'),
      solid: width('internal_solid_infill_line_width'),
      top: width('top_surface_line_width'),
      first: width('initial_layer_line_width'),
      support: width('support_line_width'),
    },
    speed: {
      'Outer wall': num(process.outer_wall_speed),
      'Inner wall': num(process.inner_wall_speed),
      'Sparse infill': num(process.sparse_infill_speed),
      'Internal solid infill': num(process.internal_solid_infill_speed),
      'Top surface': num(process.top_surface_speed),
      'Bottom surface': num(process.initial_layer_infill_speed),
      Support: num(process.support_speed),
      'Support interface': num(process.support_speed),
      Brim: num(process.initial_layer_speed),
      firstWalls: num(process.initial_layer_speed),
      firstInfill: num(process.initial_layer_infill_speed),
      travel: Math.min(num(process.travel_speed), num(m.machine_max_speed_x) || Infinity),
    },
    accel: {
      default: num(process.default_acceleration),
      'Outer wall': accel('outer_wall_acceleration'),
      'Inner wall': accel('inner_wall_acceleration'),
      'Sparse infill': accel('sparse_infill_acceleration'),
      'Top surface': accel('top_surface_acceleration'),
      first: accel('initial_layer_acceleration'),
      travel: accel('travel_acceleration'),
      max: num(m.machine_max_acceleration_extruding),
    },
    support: {
      enabled: Boolean(o.support),
      angle: num(process.support_threshold_angle),
      topGap: num(process.support_top_z_distance),
      xyGap: num(process.support_object_xy_distance),
      spacing: num(process.support_base_pattern_spacing),
      interfaceSpacing: 0.5,
    },
    brimWidth: o.brim ? num(process.brim_width) || 5 : 0,
    retract: {
      length: filamentRetract ?? num(m.retraction_length),
      speed: num(m.retraction_speed),
      deretractSpeed: num(m.deretraction_speed) || num(m.retraction_speed),
      minTravel: num(m.retraction_minimum_travel) ?? 1,
      zHop: num(m.z_hop),
      liftBelow: num(m.retract_lift_below) || Infinity,
    },
    filament: {
      type: filament.filament_type[0],
      trayInfoIdx: filament.tray_info_idx,
      vendor: filament.filament_vendor ? filament.filament_vendor[0] : '',
      color: o.color || (filament.default_filament_colour && filament.default_filament_colour[0]) || '#00AE42',
      diameter: num(filament.filament_diameter),
      density: num(filament.filament_density),
      flowRatio: num(filament.filament_flow_ratio) || 1,
      maxVolumetric: num(filament.filament_max_volumetric_speed),
      nozzleTemp: num(filament.nozzle_temperature),
      nozzleTempFirst: num(filament.nozzle_temperature_initial_layer),
      nozzleTempHigh: num(filament.nozzle_temperature_range_high),
      bedTemp: num(filament[bedKey]),
      bedTempFirst: num(filament[bedKey + '_initial_layer']),
      fanMin: num(filament.fan_min_speed),
      fanMax: num(filament.fan_max_speed),
      fanOffLayers: num(filament.close_fan_the_first_x_layers),
      slowDownTime: num(filament.slow_down_layer_time),
      slowDownMinSpeed: num(filament.slow_down_min_speed),
      flushTemp: num(filament.filament_flush_temp),
      flushVolumetric: num(filament.filament_flush_volumetric_speed),
      vitrification: num(filament.temperature_vitrification),
    },
    scanFirstLayer: m.scan_first_layer === '1',
    gcode: printer.gcode,
  };
  if (o.color && !/^#[0-9a-fA-F]{6}$/.test(o.color)) throw new Error('colour must be #RRGGBB');
  return s;
}

/** Problems that make a plate unprintable, in plain words. */
export function checkPlacement(s, b) {
  const problems = [];
  const eps = 0.01;
  if (b.min[0] < s.bed.minX - eps || b.min[1] < s.bed.minY - eps || b.max[0] > s.bed.maxX + eps || b.max[1] > s.bed.maxY + eps) {
    problems.push(`The model (${b.size[0].toFixed(1)} x ${b.size[1].toFixed(1)} mm) does not fit on the ${s.bed.maxX - s.bed.minX} x ${s.bed.maxY - s.bed.minY} mm bed.`);
  }
  if (b.max[2] > s.maxHeight + eps) problems.push(`The model is ${b.max[2].toFixed(1)} mm tall; the printer allows ${s.maxHeight} mm.`);
  if (s.bedExclude && b.min[0] < s.bedExclude.maxX && b.min[1] < s.bedExclude.maxY) {
    problems.push('The model overlaps the excluded corner of the bed (front left).');
  }
  if (s.filament.bedTemp === 0) problems.push(`${s.filament.type} is not recommended on the ${s.bedType}.`);
  return problems;
}

function dhms(sec) {
  sec = Math.round(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${h}h ${m}m ${s}s`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const f3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
const f5 = (v) => (Math.round(v * 1e5) / 1e5).toFixed(5).replace(/\.?0+$/, '') || '0';

function moveTime(len, v, a) {
  if (len <= 0 || v <= 0) return 0;
  if (!(a > 0)) return len / v;
  const accelDist = (v * v) / a; // accelerate + decelerate
  return len >= accelDist ? len / v + v / a : 2 * Math.sqrt(len / a);
}

/**
 * Builds the G-code. Returns { gcode, stats } where stats carries what slice_info.config needs.
 */
export function generateGcode(sliced, s, { modelName = 'model', date = new Date() } = {}) {
  const f = s.filament;
  const filArea = Math.PI * (f.diameter / 2) ** 2;
  const layers = sliced.layers;
  const total = layers.length;
  const mm = (p) => [p.X / SCALE, p.Y / SCALE];

  // First-layer bounding box (for the Bambu bed-mesh and purge templates).
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const p of layers[0].paths) for (const q of p.pts) {
    const [x, y] = mm(q);
    bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
  }
  const lw = s.width.outer, lh = s.layerHeight;
  const outerWallVolumetric = Math.min(s.speed['Outer wall'] * ((lw - lh) * lh + Math.PI * (lh / 2) ** 2), f.maxVolumetric);
  const bedTemps = (key) => [key === 'first' ? f.bedTempFirst : f.bedTemp];
  const vars = {
    initial_extruder: 0,
    initial_no_support_extruder: 0,
    bed_temperature: bedTemps('normal'),
    bed_temperature_initial_layer: bedTemps('first'),
    bed_temperature_initial_layer_single: f.bedTempFirst,
    curr_bed_type: s.bedType,
    default_acceleration: s.accel.default,
    outer_wall_acceleration: s.accel['Outer wall'],
    initial_layer_acceleration: s.accel.first,
    initial_layer_print_height: s.firstLayerHeight,
    filament_type: [f.type],
    nozzle_temperature: [f.nozzleTemp],
    nozzle_temperature_initial_layer: [f.nozzleTempFirst],
    nozzle_diameter: [s.nozzle],
    retraction_length: [s.retract.length],
    flush_temperatures: [f.flushTemp || f.nozzleTempHigh],
    flush_volumetric_speeds: [f.flushVolumetric || f.maxVolumetric],
    outer_wall_volumetric_speed: outerWallVolumetric,
    first_layer_print_min: [bx0, by0],
    first_layer_print_size: [bx1 - bx0, by1 - by0],
    first_layer_center_no_wipe_tower: [(bx0 + bx1) / 2, (by0 + by1) / 2],
    max_layer_z: sliced.maxZ,
    total_layer_count: total,
    print_sequence: 'by layer',
    spiral_mode: false,
    scan_first_layer: s.scanFirstLayer,
    timelapse_type: 0,
    layer_num: 0,
    layer_z: 0,
  };

  // ---- body (layers) first, so the header can carry the time estimate ----
  const body = [];
  let x = 0, y = 0, z = 0, retracted = false, accelNow = 0, fanNow = -1;
  let time = 0, extruded = 0, firstLayerTime = 0;
  const layerTimes = [];
  const emitAccel = (a) => {
    a = Math.min(a, s.accel.max || a);
    if (a !== accelNow) { body.push(`M204 S${Math.round(a)}`); accelNow = a; }
  };
  const flow = (w, h) => (w - h) * h + Math.PI * (h / 2) ** 2;

  for (let li = 0; li < total; li++) {
    const L = layers[li];
    const first = li === 0;
    // Plan the layer's speeds so a too-short layer can be slowed down as a whole.
    const plan = L.paths.map((p) => {
      let v = first ? (p.feature.includes('wall') || p.feature === 'Brim' ? s.speed.firstWalls : s.speed.firstInfill) : s.speed[p.feature];
      v = Math.min(v, f.maxVolumetric / flow(p.width, L.h));
      let len = 0;
      const n = p.pts.length;
      for (let k = 1; k < n + (p.closed ? 1 : 0); k++) {
        const a = p.pts[k - 1], b = p.pts[k % n];
        len += Math.hypot(b.X - a.X, b.Y - a.Y) / SCALE;
      }
      return { v, len };
    });
    const estimate = plan.reduce((t, q) => t + q.len / q.v, 0);
    let slow = 1;
    if (f.slowDownTime > 0 && estimate > 0 && estimate < f.slowDownTime) slow = estimate / f.slowDownTime;

    body.push('; CHANGE_LAYER', `; Z_HEIGHT: ${f3(L.z)}`, `; LAYER_HEIGHT: ${f3(L.h)}`);
    body.push(render(s.gcode.layer_change_gcode, { ...vars, layer_num: li, layer_z: L.z, max_layer_z: L.z }).trimEnd());
    body.push(`M73 P{{P${li}}} R{{R${li}}}`); // filled in once the total time is known

    if (li === 1) {
      if (f.nozzleTemp !== f.nozzleTempFirst) body.push(`M104 S${f.nozzleTemp}`);
      if (f.bedTemp !== f.bedTempFirst) body.push(`M140 S${f.bedTemp}`);
    }
    const fan = li < f.fanOffLayers ? 0 : Math.round((255 * (slow < 1 ? f.fanMax : f.fanMin)) / 100);
    if (fan !== fanNow) { body.push(fan ? `M106 S${fan}` : 'M106 S0'); fanNow = fan; }

    // Layer change: lift to the new Z.
    if (!retracted && s.retract.length > 0) {
      body.push(`G1 E-${f5(s.retract.length)} F${Math.round(s.retract.speed * 60)}`);
      retracted = true;
    }
    z = L.z;
    body.push(`G1 Z${f3(z)} F${Math.round(s.speed.travel * 60 / 2)}`);
    const layerStart = time;
    let featureNow = '';
    let widthNow = 0;

    L.paths.forEach((p, pi) => {
      const pts = p.pts.map(mm);
      if (p.closed) pts.push(pts[0]);
      // travel
      const [sx, sy] = pts[0];
      const dist = Math.hypot(sx - x, sy - y);
      if (dist > 1e-4) {
        const needRetract = dist > s.retract.minTravel;
        if (needRetract && !retracted && s.retract.length > 0) {
          body.push(`G1 E-${f5(s.retract.length)} F${Math.round(s.retract.speed * 60)}`);
          retracted = true;
          time += s.retract.length / s.retract.speed;
        }
        const hop = retracted && s.retract.zHop > 0 && z < s.retract.liftBelow && dist > 2;
        emitAccel(s.accel.travel);
        if (hop) body.push(`G1 Z${f3(z + s.retract.zHop)} F${Math.round(s.speed.travel * 60 / 2)}`);
        body.push(`G1 X${f3(sx)} Y${f3(sy)} F${Math.round(s.speed.travel * 60)}`);
        if (hop) body.push(`G1 Z${f3(z)}`);
        time += moveTime(dist, s.speed.travel, s.accel.travel) + (hop ? 2 * s.retract.zHop / (s.speed.travel / 2) : 0);
        x = sx; y = sy;
      }
      if (retracted) {
        body.push(`G1 E${f5(s.retract.length)} F${Math.round(s.retract.deretractSpeed * 60)}`);
        time += s.retract.length / s.retract.deretractSpeed;
        retracted = false;
      }
      if (p.feature !== featureNow) { body.push(`; FEATURE: ${p.feature}`); featureNow = p.feature; }
      if (p.width !== widthNow) { body.push(`; LINE_WIDTH: ${f3(p.width)}`); widthNow = p.width; }
      emitAccel(first ? s.accel.first : (s.accel[p.feature] || s.accel.default));
      const v = Math.max(plan[pi].v * slow, Math.min(plan[pi].v, f.slowDownMinSpeed || 0));
      const ePerMm = (flow(p.width, L.h) / filArea) * f.flowRatio;
      let fSet = false;
      for (let k = 1; k < pts.length; k++) {
        const [nx, ny] = pts[k];
        const len = Math.hypot(nx - x, ny - y);
        if (len < 1e-4) continue;
        const e = len * ePerMm;
        body.push(`G1 X${f3(nx)} Y${f3(ny)} E${f5(e)}${fSet ? '' : ` F${Math.round(v * 60)}`}`);
        fSet = true;
        extruded += e;
        time += moveTime(len, v, accelNow);
        x = nx; y = ny;
      }
    });
    layerTimes.push(time - layerStart);
    if (first) firstLayerTime = time;
  }

  // Progress lines need the total time; fill the placeholders now.
  const totalTime = time;
  let elapsed = 0;
  const progress = layerTimes.map((t) => {
    const before = elapsed;
    elapsed += t;
    return { p: Math.min(99, Math.floor((100 * before) / Math.max(totalTime, 1))), r: Math.round((totalTime - before) / 60) };
  });
  const bodyText = body.join('\n').replace(/M73 P\{\{P(\d+)\}\} R\{\{R\d+\}\}/g, (_, i) => `M73 P${progress[i].p} R${progress[i].r}`);

  const usedMM = extruded;
  const weight = (usedMM * filArea / 1000) * f.density;
  const endVars = { ...vars, max_layer_z: sliced.maxZ, layer_num: total - 1, layer_z: sliced.maxZ };
  const stamp = date.toISOString().replace('T', ' at ').replace(/\.\d+Z$/, ' UTC');

  const header = [
    '; HEADER_BLOCK_START',
    `; generated by Minislicer Mobile ${VERSION} on ${stamp}`,
    `; model printing time: ${dhms(totalTime)}; total estimated time: ${dhms(totalTime)}`,
    `; total layer number: ${total}`,
    `; filament_density: ${f.density}`,
    `; filament_diameter: ${f.diameter}`,
    `; max_z_height: ${sliced.maxZ.toFixed(2)}`,
    `; total filament length [mm] : ${usedMM.toFixed(2)}`,
    `; total filament weight [g] : ${weight.toFixed(2)}`,
    '; HEADER_BLOCK_END',
    '',
    '; CONFIG_BLOCK_START',
    `; printer_model = ${s.printerModel}`,
    `; printer_settings_id = ${s.printerName} 0.4 nozzle`,
    `; print_settings_id = ${s.processName}`,
    `; filament_settings_id = "${s.filamentName}"`,
    `; curr_bed_type = ${s.bedType}`,
    `; nozzle_diameter = ${s.nozzle}`,
    `; layer_height = ${s.layerHeight}`,
    `; initial_layer_print_height = ${s.firstLayerHeight}`,
    `; wall_loops = ${s.wallLoops}`,
    `; sparse_infill_density = ${Math.round(s.infillDensity * 100)}%`,
    `; enable_support = ${s.support.enabled ? 1 : 0}`,
    `; filament_type = ${f.type}`,
    `; filament_colour = ${f.color}`,
    `; nozzle_temperature = ${f.nozzleTemp}`,
    `; nozzle_temperature_initial_layer = ${f.nozzleTempFirst}`,
    `; model_name = ${modelName.replace(/[\r\n]/g, ' ')}`,
    '; CONFIG_BLOCK_END',
    '',
  ];
  const start = render(s.gcode.machine_start_gcode, vars);
  const end = render(s.gcode.machine_end_gcode, endVars);
  const gcode = [
    ...header,
    '; EXECUTABLE_BLOCK_START',
    `M73 P0 R${Math.round(totalTime / 60)}`,
    start.trimEnd(),
    '; MACHINE_START_GCODE_END',
    'G90',
    'M83 ; use relative distances for extrusion',
    bodyText,
    '; filament end gcode',
    'M106 S0',
    end.trimEnd(),
    'M73 P100 R0',
    '; EXECUTABLE_BLOCK_END',
    '',
  ].join('\n');

  return {
    gcode,
    stats: {
      time: totalTime,
      firstLayerTime,
      layers: total,
      filamentMM: usedMM,
      weight,
      maxZ: sliced.maxZ,
      firstLayerBox: [bx0, by0, bx1, by1],
    },
  };
}
