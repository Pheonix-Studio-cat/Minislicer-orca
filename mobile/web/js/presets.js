// User presets: process and filament presets the user saves, stored in this browser.
// Like OrcaSlicer's user presets they keep the name of the system preset they are based on
// ("inherits") and only the values that differ, under OrcaSlicer's option keys.

const KEY = 'ms.userPresets';

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && Array.isArray(v.process) && Array.isArray(v.filament)) return v;
  } catch { /* private mode or damaged data */ }
  return { process: [], filament: [] };
}

function write(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

/** User presets of `kind` ('process' | 'filament') usable with `printer` (its system presets). */
export function userPresets(kind, printer) {
  const base = new Set((kind === 'process' ? printer.processes : printer.filaments).map((p) => p.name));
  return read()[kind].filter((p) => base.has(p.inherits));
}

export function allUserPresets() {
  return read();
}

/** The system preset a user preset is based on, with the user's values applied. */
export function resolve(kind, printer, name) {
  const list = kind === 'process' ? printer.processes : printer.filaments;
  const system = list.find((p) => p.name === name);
  if (system) return { preset: system, values: {}, user: false };
  const user = read()[kind].find((p) => p.name === name);
  if (!user) return null;
  const base = list.find((p) => p.name === user.inherits);
  if (!base) return null;
  return { preset: { ...base, ...user.values, name: user.name }, values: { ...user.values }, user: true, inherits: user.inherits };
}

/**
 * Checks a new name. Returns an English message (for t()) or null when the name is fine.
 * The rules follow OrcaSlicer's save-preset dialog.
 */
export function validateName(kind, printer, name, replacing = null) {
  const n = name.trim();
  if (!n) return 'The name may not be empty.';
  if (n.length > 100) return 'The name is too long.';
  const system = (kind === 'process' ? printer.processes : printer.filaments).some((p) => p.name === n);
  if (system) return 'The name cannot be the same as the system preset name.';
  if (n !== replacing && read()[kind].some((p) => p.name === n)) return 'The name is the same as another existing preset name';
  return null;
}

export function save(kind, preset) {
  const all = read();
  all[kind] = all[kind].filter((p) => p.name !== preset.name);
  all[kind].push({ name: preset.name.trim(), inherits: preset.inherits, values: preset.values });
  all[kind].sort((a, b) => a.name.localeCompare(b.name));
  return write(all);
}

export function remove(kind, name) {
  const all = read();
  all[kind] = all[kind].filter((p) => p.name !== name);
  return write(all);
}

/** All user presets as one JSON file, in OrcaSlicer's user-preset shape. */
export function exportJSON() {
  const all = read();
  const presets = [];
  for (const kind of ['process', 'filament']) {
    for (const p of all[kind]) {
      presets.push({ type: kind, name: p.name, inherits: p.inherits, from: 'User', instantiation: 'true', ...p.values });
    }
  }
  return JSON.stringify({ minislicer_presets: 1, presets }, null, 2) + '\n';
}

const META = new Set(['type', 'name', 'inherits', 'from', 'instantiation', 'version', 'setting_id', 'filament_id', 'base_id', 'is_custom_defined']);

/**
 * Imports presets from our export file or from a single OrcaSlicer user-preset JSON.
 * Presets whose name exists already are replaced. Returns the number imported.
 */
export function importJSON(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data.presets) ? data.presets : [data];
  const all = read();
  let n = 0;
  for (const p of list) {
    const kind = p.type === 'print' ? 'process' : p.type;
    if (!['process', 'filament'].includes(kind) || typeof p.name !== 'string' || typeof p.inherits !== 'string' || !p.name.trim()) continue;
    const values = {};
    for (const [k, v] of Object.entries(p)) {
      if (META.has(k)) continue;
      if (typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))) values[k] = v;
    }
    all[kind] = all[kind].filter((x) => x.name !== p.name);
    all[kind].push({ name: p.name.trim(), inherits: p.inherits, values });
    n++;
  }
  if (!n) throw new Error('no presets found in the file');
  write(all);
  return n;
}
