import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
const presets = await import('../web/js/presets.js');

const profiles = JSON.parse(fs.readFileSync(new URL('../web/profiles.json', import.meta.url), 'utf8'));
const a1 = profiles.printers.find((p) => p.name === 'Bambu Lab A1');
const h2d = profiles.printers.find((p) => p.name === 'Bambu Lab H2D');
const proc = a1.processes.find((p) => p.name.startsWith('0.20mm Standard'));

beforeEach(() => store.clear());

test('a saved process preset keeps its base and only the changed values', () => {
  assert.ok(presets.save('process', { name: 'Strong', inherits: proc.name, values: { wall_loops: '4' } }));
  const r = presets.resolve('process', a1, 'Strong');
  assert.equal(r.user, true);
  assert.equal(r.inherits, proc.name);
  assert.equal(r.preset.wall_loops, '4');
  assert.equal(r.preset.layer_height, proc.layer_height);
  assert.deepEqual(presets.userPresets('process', a1).map((p) => p.name), ['Strong']);
  // Another printer has no system preset of that name, so the preset is not offered there.
  assert.ok(!h2d.processes.some((p) => p.name === proc.name));
  assert.deepEqual(presets.userPresets('process', h2d), []);
  assert.equal(presets.resolve('process', h2d, 'Strong'), null);
  presets.remove('process', 'Strong');
  assert.equal(presets.resolve('process', a1, 'Strong'), null);
});

test('names follow OrcaSlicer\'s save dialog rules', () => {
  presets.save('filament', { name: 'My PLA', inherits: a1.filaments[0].name, values: {} });
  assert.equal(presets.validateName('filament', a1, '  '), 'The name may not be empty.');
  assert.equal(presets.validateName('filament', a1, 'x'.repeat(101)), 'The name is too long.');
  assert.equal(presets.validateName('filament', a1, a1.filaments[0].name), 'The name cannot be the same as the system preset name.');
  assert.equal(presets.validateName('filament', a1, 'My PLA'), 'The name is the same as another existing preset name');
  assert.equal(presets.validateName('filament', a1, 'My PLA', 'My PLA'), null);
  assert.equal(presets.validateName('filament', a1, 'Other PLA'), null);
});

test('export and import round trip; a single OrcaSlicer user preset imports too', () => {
  presets.save('process', { name: 'Strong', inherits: proc.name, values: { wall_loops: '4' } });
  presets.save('filament', { name: 'Hot PLA', inherits: a1.filaments[0].name, values: { nozzle_temperature: ['231'] } });
  const file = presets.exportJSON();
  store.clear();
  assert.equal(presets.importJSON(file), 2);
  assert.equal(presets.resolve('process', a1, 'Strong').preset.wall_loops, '4');
  assert.deepEqual(presets.resolve('filament', a1, 'Hot PLA').preset.nozzle_temperature, ['231']);

  const orca = { type: 'print', name: 'From Orca', inherits: proc.name, from: 'User', version: '2.3.0', sparse_infill_density: '25%', bogus: { x: 1 } };
  assert.equal(presets.importJSON(JSON.stringify(orca)), 1);
  const r = presets.resolve('process', a1, 'From Orca');
  assert.deepEqual(r.values, { sparse_infill_density: '25%' });
  assert.throws(() => presets.importJSON('{"type":"machine","name":"x","inherits":"y"}'), /no presets/);
});

test('damaged storage reads as no presets', () => {
  store.set('ms.userPresets', '{not json');
  assert.deepEqual(presets.allUserPresets(), { process: [], filament: [] });
  assert.ok(presets.save('process', { name: 'Fresh', inherits: proc.name, values: {} }));
  assert.equal(presets.allUserPresets().process.length, 1);
});
