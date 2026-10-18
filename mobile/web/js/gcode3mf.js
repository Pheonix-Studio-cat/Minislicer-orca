// Packs a sliced plate as a Bambu ".gcode.3mf", the format Bambu Connect imports.
// The layout follows OrcaSlicer's "export plate sliced file" (bbs_3mf.cpp with
// SaveStrategy::SkipModel | WithGcode): no meshes, one plate, G-code with its MD5,
// slice_info.config, model_settings.config, project_settings.config and a plate thumbnail.

import { writeZip, md5Hex } from './zip.js';
import { VERSION } from './gcode.js';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function contentTypes() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>
`;
}

function rels(hasThumb) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
${hasThumb ? ' <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n' : ''}</Relationships>
`;
}

function model(title, date) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">Minislicer Mobile-${VERSION}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="CreationDate">${date}</metadata>
 <metadata name="Title">${xml(title)}</metadata>
 <resources>
 </resources>
 <build/>
</model>
`;
}

function sliceInfo(s, stats, objectName) {
  const f = s.filament;
  const ext = s.extruders;
  // One entry per extruder, space-separated, like OrcaSlicer's add_vector(); 0 = Direct Drive / Standard.
  const perExtruder = (v) => Array(ext.count).fill(v).join(' ');
  const nozzleGroup = ext.master; // filament_maps[0] - 1
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.00.00.00"/>
    <header_item key="Minislicer-Mobile-Version" value="${VERSION}"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="extruder_type" value="${perExtruder(0)}"/>
    <metadata key="nozzle_volume_type" value="${perExtruder(0)}"/>
    <metadata key="printer_model_id" value="${xml(s.modelId)}"/>
    <metadata key="nozzle_diameters" value="${ext.nozzle_diameters.join(',')}"/>
    <metadata key="timelapse_type" value="0"/>
    <metadata key="prediction" value="${Math.round(stats.time)}"/>
    <metadata key="weight" value="${stats.weight.toFixed(2)}"/>
    <metadata key="first_layer_time" value="${stats.firstLayerTime.toFixed(2)}"/>
    <metadata key="outside" value="false"/>
    <metadata key="support_used" value="${s.support.enabled}"/>
    <metadata key="label_object_enabled" value="false"/>
    <metadata key="enable_filament_dynamic_map" value="false"/>
    <metadata key="has_filament_switcher" value="false"/>
    <metadata key="filament_maps" value="${ext.master + 1}"/>
    <object identify_id="1" name="${xml(objectName)}" skipped="false" />
    <filament id="1" tray_info_idx="${xml(f.trayInfoIdx)}" type="${xml(f.type)}" color="${xml(f.color)}" used_m="${(stats.filamentMM / 1000).toFixed(2)}" used_g="${stats.weight.toFixed(2)}" group_id="${nozzleGroup}" nozzle_diameter="${s.nozzle}" volume_type="Standard" used_for_object="true" used_for_support="${s.support.enabled}"/>
    <nozzle id="${nozzleGroup}" extruder_id="${ext.master + 1}" nozzle_diameter="${s.nozzle}" volume_type="Standard"/>
  </plate>
</config>
`;
}

function modelSettings(hasThumb) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>
${hasThumb ? '    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>\n' : ''}  </plate>
</config>
`;
}

function projectSettings(s) {
  const f = s.filament;
  const str = (v) => String(v);
  return JSON.stringify({
    from: 'project',
    name: 'project_settings',
    version: '02.00.00.00',
    printer_model: s.printerModel,
    printer_settings_id: `${s.printerName} 0.4 nozzle`,
    print_settings_id: s.processName,
    filament_settings_id: [s.filamentName],
    curr_bed_type: s.bedType,
    nozzle_diameter: s.extruders.nozzle_diameters.map(str),
    printable_area: [`${s.bed.minX}x${s.bed.minY}`, `${s.bed.maxX}x${s.bed.minY}`, `${s.bed.maxX}x${s.bed.maxY}`, `${s.bed.minX}x${s.bed.maxY}`],
    printable_height: str(s.maxHeight),
    layer_height: str(s.layerHeight),
    initial_layer_print_height: str(s.firstLayerHeight),
    wall_loops: str(s.wallLoops),
    sparse_infill_density: `${Math.round(s.infillDensity * 100)}%`,
    enable_support: s.support.enabled ? '1' : '0',
    filament_type: [f.type],
    filament_colour: [f.color],
    filament_ids: [f.trayInfoIdx],
    filament_vendor: [f.vendor],
    filament_diameter: [str(f.diameter)],
    filament_density: [str(f.density)],
    nozzle_temperature: [str(f.nozzleTemp)],
    nozzle_temperature_initial_layer: [str(f.nozzleTempFirst)],
    timelapse_type: '0',
    print_sequence: 'by layer',
    spiral_mode: '0',
  }, null, 4) + '\n';
}

/**
 * Returns the .gcode.3mf as a Uint8Array.
 * thumbnailPNG: optional Uint8Array of a square PNG of the plate.
 */
export async function buildGcode3mf({ gcode, stats, settings, title, thumbnailPNG, date = new Date() }) {
  const gcodeBytes = new TextEncoder().encode(gcode);
  const hasThumb = Boolean(thumbnailPNG && thumbnailPNG.length);
  const day = date.toISOString().slice(0, 10);
  const entries = [
    { name: '[Content_Types].xml', data: contentTypes() },
    { name: '_rels/.rels', data: rels(hasThumb) },
    { name: '3D/3dmodel.model', data: model(title, day) },
    { name: 'Metadata/plate_1.gcode', data: gcodeBytes },
    { name: 'Metadata/plate_1.gcode.md5', data: md5Hex(gcodeBytes) },
    { name: 'Metadata/model_settings.config', data: modelSettings(hasThumb) },
    { name: 'Metadata/slice_info.config', data: sliceInfo(settings, stats, title) },
    { name: 'Metadata/project_settings.config', data: projectSettings(settings) },
  ];
  if (hasThumb) entries.push({ name: 'Metadata/plate_1.png', data: thumbnailPNG });
  return writeZip(entries);
}
