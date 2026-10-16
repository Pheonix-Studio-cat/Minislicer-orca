// End-to-end check: the real runner binary serves the web app, a phone-sized browser pairs,
// slices a model and sends it; a stand-in for the OS URL handler records what would have
// opened Bambu Connect.
//
//   node mobile/tests/e2e.mjs <model.stl> [screenshot-dir]
//
// Needs Go, Playwright with Chromium, and python3. Linux only (it fakes xdg-open).

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const model = process.argv[2];
const shots = process.argv[3];
if (!model) throw new Error('usage: node e2e.mjs <model.stl> [screenshot-dir]');
const mobileDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-e2e-'));
const bin = path.join(tmp, 'runner');
execFileSync('go', ['build', '-o', bin, './runner'], { cwd: mobileDir, stdio: 'inherit' });

// Fake URL handler: records the link instead of opening anything.
const fakeBin = path.join(tmp, 'bin');
fs.mkdirSync(fakeBin);
const opened = path.join(tmp, 'opened.txt');
fs.writeFileSync(path.join(fakeBin, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${opened}"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, 'xdg-mime'), '#!/bin/sh\necho bambu-connect.desktop\n', { mode: 0o755 });

const port = 18787 + Math.floor(Math.random() * 1000);
const runner = spawn(bin, ['-port', String(port), '-prints', path.join(tmp, 'prints')], {
  env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(tmp, 'cfg'), HOME: tmp },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let out = '';
runner.stdout.on('data', (d) => { out += d; });

const fail = (msg) => { throw new Error(msg); };
const check = (cond, msg) => { if (!cond) fail(msg); console.log(`ok - ${msg}`); };

try {
  for (let i = 0; i < 50 && !out.includes('Pairing page'); i++) await new Promise((r) => setTimeout(r, 100));
  check(out.includes('Pairing page'), 'runner started');
  const browser = await chromium.launch();

  // 1. Pairing page on the computer (loopback) shows a QR code with the token.
  const desk = await browser.newPage();
  await desk.goto(`http://127.0.0.1:${port}/pair.html`);
  await desk.waitForSelector('.code svg', { timeout: 5000 }).catch(() => {});
  const pairLinks = await desk.$$eval('.code a', (as) => as.map((a) => a.href));
  const token = fs.readFileSync(path.join(tmp, 'cfg', 'minislicer-runner', 'token'), 'utf8').trim();
  // Containers may have no private LAN address; the token itself must still be on the page's API.
  const pairing = await desk.evaluate(async () => (await fetch('api/pairing')).json());
  check(pairing.token === token, 'pairing API hands out the stored token on loopback');
  if (pairLinks.length) check(pairLinks.every((h) => h.includes(`token=${token}`)), 'QR links carry the token');
  const pairText = await desk.textContent('#codes');
  check(pairLinks.length > 0 || pairText.startsWith('No Wi-Fi'), `pairing page shows QR codes or the no-network hint (${pairLinks.length} codes)`);
  check(!/only works|Cannot|undefined|null/.test(pairText), 'pairing page shows no error');
  if (shots) await desk.screenshot({ path: path.join(shots, 'pair.png') });

  // 2. A phone opens the slicer with the token (as from the QR code).
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await phone.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?token=${token}`);
  await page.waitForFunction(() => document.getElementById('runner').classList.contains('ok'), null, { timeout: 5000 });
  check(!page.url().includes('token='), 'token removed from the address bar');
  check((await page.textContent('#runnertext')).startsWith('Runner on'), 'phone is paired with the runner');
  if (shots) await page.screenshot({ path: path.join(shots, 'phone-empty.png') });

  await page.setInputFiles('#file', model);
  await page.waitForFunction(() => !document.getElementById('slice').disabled, null, { timeout: 10000 });
  check(/mm/.test(await page.textContent('#modelsize')), 'model loaded and measured');
  await page.selectOption('#printer', 'Bambu Lab A1');
  // Brim lives on the Others page of the process settings, as in OrcaSlicer.
  await page.click('.ptab[data-ptab="others"]');
  await page.selectOption('#p-brim_type', 'outer_only');
  check(await page.$eval('#p-brim_type', (el) => el.closest('.prow').classList.contains('changed')), 'edited setting is marked as changed');
  await page.click('.ptab[data-ptab="strength"]');
  await page.fill('#p-wall_loops', '3');
  await page.dispatchEvent('#p-wall_loops', 'change');
  check(await page.evaluate(() => window.__ms.overrides.wall_loops === '3'), 'wall loops override recorded');
  if (shots) await page.screenshot({ path: path.join(shots, 'phone-model.png') });
  await page.click('#slice');
  await page.waitForSelector('#legend:not([hidden])', { timeout: 120000 });
  check(await page.$eval('#tab-preview', (el) => el.classList.contains('active')), 'switched to Preview after slicing');
  check(await page.evaluate(() => window.__ms.result.settings.wallLoops === 3 && window.__ms.result.settings.brimWidth > 0), 'slice used the edited settings');
  const stats = await page.textContent('#legend');
  check(/Line Type/.test(stats) && /Model printing time\*\d+(h\d+m|m\d+s)/.test(stats) && /\d+\.\d+ g/.test(stats), `sliced: ${stats.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  check(await page.isVisible('#vslider') && await page.isVisible('#hslider'), 'layer and move sliders shown');
  await page.fill('#layer', '40');
  await page.dispatchEvent('#layer', 'input');
  if (shots) await page.screenshot({ path: path.join(shots, 'phone-preview.png') });

  // 3. Download works.
  await page.click('#printmenu');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl3mf')]);
  const dlPath = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(dlPath);
  check(dl.suggestedFilename().endsWith('.gcode.3mf'), `download named ${dl.suggestedFilename()}`);

  // 4. Send to the runner -> Bambu Connect link.
  await page.click('#print');
  await page.waitForFunction(() => /Bambu Connect|Could not/.test(document.getElementById('sendmsg').textContent), null, { timeout: 15000 });
  const msg = await page.textContent('#sendmsg');
  check(msg.startsWith('Opened in Bambu Connect'), `send result: ${msg}`);
  for (let i = 0; i < 20 && !fs.existsSync(opened); i++) await new Promise((r) => setTimeout(r, 100));
  const links = fs.readFileSync(opened, 'utf8').trim().split('\n').filter((l) => l.startsWith('bambu-connect://'));
  check(links.length === 1, 'exactly one bambu-connect link opened');
  const u = new URL(links[0]);
  const filePath = u.searchParams.get('path');
  check(u.host === 'import-file' && u.searchParams.get('version') === '1.0.0', `link: ${links[0].slice(0, 90)}…`);
  check(fs.existsSync(filePath) && filePath.startsWith(path.join(tmp, 'prints')), 'file saved in the prints folder');
  check(Buffer.compare(fs.readFileSync(filePath), fs.readFileSync(dlPath)) === 0, 'sent file equals the downloaded one');
  const listing = execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', filePath]).toString();
  check(listing.includes('Metadata/plate_1.gcode') && listing.includes('Metadata/plate_1.png'), 'sliced 3MF with G-code and thumbnail');
  if (shots) {
    execFileSync('python3', ['-I', '-c', 'import sys,zipfile; open(sys.argv[2],"wb").write(zipfile.ZipFile(sys.argv[1]).read("Metadata/plate_1.png"))', filePath, path.join(shots, 'thumbnail.png')]);
  }

  // 5. Without the token the runner refuses.
  const anon = await browser.newContext({ ...devices['Pixel 7'] });
  const p2 = await anon.newPage();
  await p2.goto(`http://127.0.0.1:${port}/`);
  await p2.waitForFunction(() => !document.getElementById('runnertext').textContent.startsWith('Checking'), null, { timeout: 5000 });
  check((await p2.textContent('#runnertext')).includes('pair'), 'unpaired phone is told to pair');
  const status = await p2.evaluate(async () => (await fetch('api/print', { method: 'POST', body: 'x' })).status);
  check(status === 401, 'runner rejects prints without the token');

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
} finally {
  runner.kill();
}
console.log('all end-to-end checks passed');
