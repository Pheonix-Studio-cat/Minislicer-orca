import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LANGUAGES } from '../web/js/i18n.js';

const web = new URL('../web/', import.meta.url);
const catalog = (code) => JSON.parse(fs.readFileSync(new URL(`i18n/${code}.json`, web), 'utf8'));
const others = LANGUAGES.filter((l) => l.code !== 'en');

test('every offered language has a catalog with the same strings', () => {
  const keys = Object.keys(catalog('de').strings).sort();
  assert.ok(keys.length > 100);
  for (const { code } of others) {
    const c = catalog(code);
    assert.equal(c._meta.language, code);
    assert.deepEqual(Object.keys(c.strings).sort(), keys, code);
    for (const [en, tr] of Object.entries(c.strings)) assert.ok(tr.trim(), `${code}: empty translation of "${en}"`);
  }
  const html = fs.readFileSync(new URL('index.html', web), 'utf8');
  for (const [, s] of html.matchAll(/data-i18n(?:-title|-aria)?="([^"]+)"/g)) assert.ok(keys.includes(s), `"${s}" has no translation`);
});

test('translations keep the placeholders and line breaks of the English text', () => {
  const marks = (s) => [...s.matchAll(/%\d+%|\n/g)].map((m) => m[0]).sort();
  for (const { code } of others) {
    for (const [en, tr] of Object.entries(catalog(code).strings)) assert.deepEqual(marks(tr), marks(en), `${code}: "${en}" -> "${tr}"`);
  }
});

test('machine translations are listed, and languages without an OrcaSlicer catalog are all machine-translated', () => {
  for (const { code } of others) {
    const { _meta, strings } = catalog(code);
    assert.equal(_meta.from_orcaslicer + _meta.machine_translated.length, Object.keys(strings).length, code);
    if (!_meta.orca_catalog) assert.equal(_meta.from_orcaslicer, 0, code);
  }
  // The print button is a verb; OrcaSlicer's Czech catalog has the noun ("print plate").
  assert.equal(catalog('cs').strings['Print plate'], 'Tisknout desku');
  assert.equal(catalog('de').strings['Print plate'], 'Aktuelle Platte drucken');
});
