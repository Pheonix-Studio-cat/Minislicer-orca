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
import http from 'node:http';

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
  check(/Line Type/.test(stats) && /Model printing time\d+(h\d+m|m\d+s)/.test(stats) && /\d+\.\d+ g/.test(stats), `sliced: ${stats.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
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

  // 6. Preferences, user presets and the H2D on a tablet.
  const tab = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const t2 = await tab.newPage();
  t2.on('pageerror', (e) => errors.push(e.message));
  t2.on('dialog', (d) => d.accept());
  await t2.goto(`http://127.0.0.1:${port}/`);
  await t2.waitForFunction(() => document.getElementById('printer').options.length > 0);
  check(await t2.textContent('#slice .lbl-long') === 'Slice plate', 'English is the default language');
  await t2.click('#prefs');
  check(await t2.$$eval('#lang option', (o) => o.length) === 19, 'language list offers English and 18 translations');
  await t2.selectOption('#lang', 'de');
  await t2.waitForFunction(() => document.querySelector('#slice .lbl-long').textContent === 'Aktuelle Platte slicen');
  check(true, 'German UI uses OrcaSlicer\'s wording ("Aktuelle Platte slicen")');
  await t2.click('.accent[data-color="#1F8EEA"]');
  const accent = await t2.evaluate(() => getComputedStyle(document.querySelector('#dlg-prefs .btn.primary')).backgroundColor);
  check(accent === 'rgb(31, 142, 234)', `button colour follows the preference (${accent})`);
  if (shots) await t2.screenshot({ path: path.join(shots, 'tablet-prefs-de.png') });
  await t2.click('#dlg-prefs .dlg-actions .btn.primary');
  await t2.reload();
  await t2.waitForFunction(() => document.querySelector('#slice .lbl-long').textContent === 'Aktuelle Platte slicen');
  check(await t2.evaluate(() => getComputedStyle(document.querySelector('#dlg-prefs .btn.primary')).backgroundColor) === 'rgb(31, 142, 234)', 'language and colour survive a reload');

  // Long translations still fit the top bar of a 320 px phone: short labels, nothing cut off.
  const small = await browser.newContext({ ...devices['iPhone SE'] });
  await small.addInitScript(() => localStorage.setItem('ms.lang', JSON.stringify('ru')));
  const sp = await small.newPage();
  sp.on('pageerror', (e) => errors.push(e.message));
  await sp.goto(`http://127.0.0.1:${port}/`);
  await sp.waitForFunction(() => document.querySelector('#slice .lbl-short').textContent === 'Нарезать');
  const fit = await sp.evaluate(() => [...document.querySelectorAll('#slice, #print, #printmenu')].map((b) => {
    const label = b.id === 'printmenu' ? b : b.querySelector('.lbl-short');
    const r = document.createRange();
    r.selectNodeContents(label);
    const w = r.getBoundingClientRect().width;
    const cs = getComputedStyle(b);
    const room = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const longHidden = !b.querySelector('.lbl-long') || getComputedStyle(b.querySelector('.lbl-long')).display === 'none';
    return longHidden && w > 0 && w <= room + 0.5 && b.getBoundingClientRect().right <= innerWidth;
  }));
  check(fit.every(Boolean), `Russian top bar fits a 320 px phone (${fit})`);
  await small.close();

  await t2.selectOption('#printer', 'Bambu Lab H2D');
  await t2.setInputFiles('#file', model);
  await t2.waitForFunction(() => !document.getElementById('slice').disabled, null, { timeout: 10000 });
  // Save a process preset with three walls.
  await t2.click('.ptab[data-ptab="strength"]');
  await t2.fill('#p-wall_loops', '3');
  await t2.dispatchEvent('#p-wall_loops', 'change');
  await t2.click('#psave');
  await t2.fill('#savename', 'My strong process');
  await t2.click('#saveok');
  await t2.waitForFunction(() => document.getElementById('process').value === 'My strong process');
  check(await t2.$eval('#process', (el) => el.selectedOptions[0].parentElement.label) === 'Benutzerdefinierte Profile', 'saved process preset listed under user presets');
  check(await t2.isVisible('#pdel'), 'user preset can be deleted');
  // Create a filament preset with another nozzle temperature.
  await t2.click('#fedit');
  await t2.fill('#p-nozzle_temperature', '231');
  await t2.dispatchEvent('#p-nozzle_temperature', 'change');
  await t2.click('#fsave');
  await t2.fill('#savename', 'My PLA 231');
  await t2.click('#saveok');
  await t2.waitForFunction(() => document.getElementById('filament').value === 'My PLA 231');
  if (shots) await t2.screenshot({ path: path.join(shots, 'tablet-presets.png') });
  await t2.click('#slice');
  await t2.waitForSelector('#legend:not([hidden])', { timeout: 120000 });
  const used = await t2.evaluate(() => ({ walls: window.__ms.result.settings.wallLoops, temp: window.__ms.result.settings.filament.nozzleTemp, area: window.__ms.result.settings.area }));
  check(used.walls === 3 && used.temp === 231, `slice used both user presets (walls ${used.walls}, nozzle ${used.temp} °C)`);
  check(used.area.minX === 25 && used.area.maxX === 350, 'H2D slices inside the right nozzle\'s area');
  check(/M104 S231/.test(await t2.evaluate(() => window.__ms.result.gcode)), 'G-code heats the nozzle to the user preset temperature');
  if (shots) await t2.screenshot({ path: path.join(shots, 'tablet-h2d-preview.png') });
  // Export the presets.
  await t2.click('#prefs');
  const [pdl] = await Promise.all([t2.waitForEvent('download'), t2.click('#pexport')]);
  const exported = JSON.parse(fs.readFileSync(await pdl.path(), 'utf8'));
  check(exported.presets.length === 2 && exported.presets.some((p) => p.inherits === 'Bambu PLA Basic @BBL H2D' && p.nozzle_temperature[0] === '231'), 'exported presets keep inherits and the changed values');

  // 7. Support painting with a pen and the flexi cutter, on an iPad.
  const pad = await browser.newContext({ ...devices['iPad Pro 11'] });
  // Record what reaches the slicing worker: painted triangles and joint meshes.
  await pad.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, ...rest) {
      if (m && m.extra) window.__sent = { negatives: m.extra.negatives.length, enforcers: m.extra.enforcers.length, blockers: m.extra.blockers.length };
      return post.call(this, m, ...rest);
    };
  });
  const ip = await pad.newPage();
  ip.on('pageerror', (e) => errors.push(e.message));
  await ip.goto(`http://127.0.0.1:${port}/`);
  await ip.setInputFiles('#file', model);
  await ip.waitForFunction(() => !document.getElementById('slice').disabled, null, { timeout: 10000 });
  const weightOf = async () => {
    await ip.click('#slice');
    await ip.waitForFunction(() => window.__ms.result, null, { timeout: 120000 });
    const r = await ip.evaluate(() => ({ weight: window.__ms.result.stats.weight, sent: window.__sent }));
    await ip.click('#tab-prepare');
    return r;
  };
  const plain = await weightOf();

  await ip.click('#tool-paint');
  const cv = await ip.locator('#canvas').boundingBox();
  // Real pen input (as an Apple Pencil sends it), through Chrome's input pipeline.
  const cdp = await pad.newCDPSession(ip);
  const pen = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  const [px, py] = [cv.x + cv.width * 0.55, cv.y + cv.height * 0.62];
  await pen('mousePressed', px - 40, py);
  for (let k = 1; k <= 8; k++) await pen('mouseMoved', px - 40 + k * 10, py);
  await pen('mouseReleased', px + 40, py);
  const painted = await ip.evaluate(() => window.__ms.paint.reduce((n, v) => n + (v === 1), 0));
  check(painted > 50, `the pen paints support enforcers (${painted} triangles)`);
  check(await ip.evaluate(() => document.querySelector('#painthint').textContent.startsWith('Draw with the pen;')), 'after a pen stroke, fingers move the view');
  check(!(await ip.isHidden('#paintoff')), 'painting with support off says it needs support');
  await ip.click('#paintenable');
  check(await ip.isHidden('#paintoff'), '"Enable support" switches support on');
  if (shots) await ip.screenshot({ path: path.join(shots, 'ipad-paint.png') });
  await ip.click('#paintdone');

  await ip.click('#tool-flexi');
  await ip.click('#modules button[data-module="1"]');
  await ip.waitForFunction(() => document.querySelector('#jointedit') && !document.querySelector('#jointedit').hidden);
  // Tap the hull until the joint moves there (a tap through a window would hit nothing).
  const before = await ip.evaluate(() => JSON.stringify(window.__ms.cutters[0].pos));
  for (const fy of [0.62, 0.66, 0.58, 0.7]) {
    await ip.mouse.click(cv.x + cv.width * 0.6, cv.y + cv.height * fy);
    if (await ip.evaluate((b) => JSON.stringify(window.__ms.cutters[0].pos) !== b, before)) break;
  }
  check(await ip.evaluate((b) => JSON.stringify(window.__ms.cutters[0].pos) !== b, before), 'a tap places the joint in the model');
  // The joint turns with the model: after Z +90° its offset from the model centre turns by 90°.
  const offset = () => ip.evaluate(() => {
    const p = window.__ms.placed;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
    return [+document.getElementById('jx').value - (x0 + x1) / 2, +document.getElementById('jy').value - (y0 + y1) / 2];
  });
  const o1 = await offset();
  await ip.click('#tool-rotate');
  await ip.click('[data-rot="z"]');
  await ip.click('#tool-flexi');
  const o2 = await offset();
  check(Math.abs(o2[0] + o1[1]) < 0.05 && Math.abs(o2[1] - o1[0]) < 0.05 && Math.hypot(...o1) > 0.5,
    `the joint turns with the model (${o1.map((v) => v.toFixed(2))} -> ${o2.map((v) => v.toFixed(2))})`);
  if (shots) await ip.screenshot({ path: path.join(shots, 'ipad-flexi.png') });
  await ip.click('#flexidone');
  const cutTris = await ip.evaluate(async () => {
    const r = await fetch('flexi/Projectcutter_ver2_bigger.stl');
    return new DataView(await r.arrayBuffer()).getUint32(80, true);
  });
  const cut = await weightOf();
  check(cut.sent.negatives === cutTris * 9 && cut.sent.enforcers === painted * 9, `the slicer gets the joint (${cut.sent.negatives / 9} triangles) and the painted triangles (${cut.sent.enforcers / 9})`);
  check(plain.sent.negatives === 0 && plain.sent.enforcers === 0, 'without tools nothing extra is sent');
  // Same settings and paint, joint deleted: the joint is what removes material.
  await ip.click('#tool-flexi');
  await ip.click('#jdel');
  await ip.click('#tool-flexi');
  const whole = await weightOf();
  check(whole.sent.negatives === 0 && cut.weight < whole.weight - 0.05, `the joint removes material (${whole.weight.toFixed(2)} g -> ${cut.weight.toFixed(2)} g)`);
  await pad.close();

  // 8. On a static host such as Cloudflare Pages: no runner, content types by file extension with
  //    `nosniff` (module scripts must be JavaScript), unknown paths answered by 404.html with 404.
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
  const webDir = path.join(mobileDir, 'web');
  const missing = [];
  const host = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://host').pathname);
    let f = path.join(webDir, p.endsWith('/') ? p + 'index.html' : p);
    const found = f.startsWith(webDir + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile();
    if (!found) { missing.push(p); f = path.join(webDir, '404.html'); }
    res.writeHead(found ? 200 : 404, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${host.address().port}/`;
  try {
    const st = await browser.newContext({ ...devices['iPad Pro 11'], acceptDownloads: true });
    await st.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) {
        if (m && m.extra) window.__sent = { negatives: m.extra.negatives.length };
        return post.call(this, m, ...rest);
      };
    });
    const sp2 = await st.newPage();
    sp2.on('pageerror', (e) => errors.push(e.message));
    await sp2.goto(site);
    await sp2.waitForFunction(() => document.getElementById('runnertext').textContent === 'No runner - export only', null, { timeout: 10000 });
    check(true, 'static host: the app starts without a runner and says so');
    await sp2.click('#prefs');
    await sp2.selectOption('#lang', 'de');
    await sp2.waitForFunction(() => document.querySelector('#slice .lbl-long').textContent === 'Aktuelle Platte slicen');
    await sp2.selectOption('#lang', 'en');
    await sp2.click('#dlg-prefs .dlg-actions .btn.primary');
    await sp2.setInputFiles('#file', model);
    await sp2.waitForFunction(() => !document.getElementById('slice').disabled, null, { timeout: 10000 });
    await sp2.click('#tool-flexi');
    await sp2.click('#modules button[data-module="2"]');
    await sp2.click('#flexidone');
    await sp2.click('#slice');
    await sp2.waitForFunction(() => window.__ms.result, null, { timeout: 120000 });
    check(await sp2.evaluate(() => window.__sent.negatives > 0), 'static host: languages, slicing worker, the slicer modules and the flexi cutter load');
    await sp2.click('#printmenu');
    const [dl] = await Promise.all([sp2.waitForEvent('download'), sp2.click('#dl3mf')]);
    const file = path.join(tmp, dl.suggestedFilename());
    await dl.saveAs(file);
    check(file.endsWith('.gcode.3mf') && fs.readFileSync(file).subarray(0, 2).toString() === 'PK', `static host: the sliced file downloads (${path.basename(file)})`);
    const unexpected = missing.filter((p) => p !== '/api/status');
    check(missing.includes('/api/status') && unexpected.length === 0, `static host: only the runner's api/status is missing${unexpected.length ? ': ' + unexpected.join(', ') : ''}`);
    const nf = await sp2.goto(site + 'no/such/page');
    check(nf.status() === 404 && (await sp2.title()).startsWith('Not found'), 'static host: unknown paths get the 404 page');
    if (shots) await sp2.screenshot({ path: path.join(shots, 'static-404.png') });
    await st.close();
  } finally {
    host.close();
  }

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
} finally {
  runner.kill();
}
console.log('all end-to-end checks passed');
