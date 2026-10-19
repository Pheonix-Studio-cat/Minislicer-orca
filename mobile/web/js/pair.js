// Pairing page, served by the runner on this computer only.
import qrcode from '../vendor/qrcode.js';

const codes = document.getElementById('codes');
const info = document.getElementById('info');

function qrSVG(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

try {
  const r = await fetch('api/pairing', { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  const p = await r.json();
  if (!p.urls || !p.urls.length) {
    codes.textContent = 'No Wi-Fi or Ethernet address found. Connect this computer to the same network as your phone, then reload this page.';
  }
  for (const url of p.urls || []) {
    const div = document.createElement('div');
    div.className = 'code';
    div.innerHTML = qrSVG(url);
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url.replace(/\?token=.*/, '');
    div.append(a);
    codes.append(div);
  }
  info.textContent = `Received prints are saved in ${p.printsDir}. Keep this code private: anyone with it on your network can send prints to Bambu Connect.`;
  try { localStorage.setItem('ms.token', JSON.stringify(p.token)); } catch { /* ignore */ }
} catch (err) {
  codes.textContent = `This page only works on the computer running the Minislicer Runner (${err.message}).`;
}

document.getElementById('quit').onclick = async () => {
  await fetch('api/quit', { method: 'POST' }).catch(() => {});
  document.body.innerHTML = '<div class="pair"><h1>Runner stopped.</h1><p>You can close this tab.</p></div>';
};
