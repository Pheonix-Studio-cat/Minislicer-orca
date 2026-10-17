// Runs slicing and G-code generation off the UI thread.
import { slice, SCALE } from './slicer.js';
import { generateGcode } from './gcode.js';

const FEATURES = ['Outer wall', 'Inner wall', 'Sparse infill', 'Internal solid infill', 'Top surface',
  'Bottom surface', 'Support', 'Support interface', 'Brim'];

// Preview: one line segment list for the whole print, layer by layer, with a feature index
// per segment, plus the segment offset where each layer starts.
function preview(sliced) {
  let count = 0;
  for (const L of sliced.layers) for (const p of L.paths) count += p.pts.length - (p.closed ? 0 : 1);
  const pos = new Float32Array(count * 6);
  const feat = new Uint8Array(count);
  const layerStart = new Uint32Array(sliced.layers.length + 1);
  let n = 0;
  sliced.layers.forEach((L, li) => {
    layerStart[li] = n;
    for (const p of L.paths) {
      const fi = Math.max(0, FEATURES.indexOf(p.feature));
      const m = p.pts.length;
      for (let k = 1; k < m + (p.closed ? 1 : 0); k++) {
        const a = p.pts[k - 1], b = p.pts[k % m];
        pos.set([a.X / SCALE, a.Y / SCALE, L.z, b.X / SCALE, b.Y / SCALE, L.z], n * 6);
        feat[n++] = fi;
      }
    }
  });
  layerStart[sliced.layers.length] = n;
  return { pos, feat, layerStart, z: Float32Array.from(sliced.layers.map((L) => L.z)), features: FEATURES };
}

self.onmessage = (ev) => {
  const { tris, settings, modelName, extra } = ev.data;
  try {
    const t0 = performance.now();
    const sliced = slice(tris, settings, (p, stage) => self.postMessage({ type: 'progress', p, stage }), extra);
    const { gcode, stats } = generateGcode(sliced, settings, { modelName });
    const pv = preview(sliced);
    stats.sliceMs = performance.now() - t0;
    self.postMessage({ type: 'done', gcode, stats, preview: pv }, [pv.pos.buffer, pv.feat.buffer, pv.layerStart.buffer, pv.z.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
