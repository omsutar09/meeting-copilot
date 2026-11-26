// Local speech-to-text, run in an Electron utility process so model decoding
// never blocks the main process or the window.
//
// Messages in:  { type: 'start', engine, modelsDir, sources: ['them', 'me'] }
//               { type: 'audio', source, pcm }   // 16 kHz mono 16-bit PCM bytes
//               { type: 'stop' }
// Messages out: { type: 'ready' } | { type: 'start-error', error }
//               { type: 'transcript', source, text, isFinal }
//               { type: 'error', source, error }
const { createEngine } = require('./engines');

let engine = null; // { name, createSource(emit) }
let sources = {}; // label -> { accept(Float32Array), flush() }

const post = (m) => process.parentPort.postMessage(m);

function toFloat32(bytes) {
  // Copy first: the incoming view may not be 2-byte aligned.
  const copy = new Uint8Array(bytes);
  const pcm = new Int16Array(copy.buffer, 0, copy.byteLength >> 1);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

function flushAll() {
  for (const s of Object.values(sources)) {
    try {
      s.flush();
    } catch {}
  }
  sources = {};
}

process.parentPort.on('message', ({ data: m }) => {
  if (m.type === 'start') {
    try {
      flushAll();
      if (!engine || engine.name !== m.engine) {
        engine = null; // let the old model be garbage-collected first
        engine = createEngine(m.engine, m.modelsDir);
      }
      for (const label of m.sources) {
        sources[label] = engine.createSource((text, isFinal) =>
          post({ type: 'transcript', source: label, text, isFinal }),
        );
      }
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'start-error', error: err.message || String(err) });
    }
  } else if (m.type === 'audio') {
    const src = sources[m.source];
    if (!src) return;
    try {
      src.accept(toFloat32(m.pcm));
    } catch (err) {
      post({ type: 'error', source: m.source, error: err.message || String(err) });
    }
  } else if (m.type === 'stop') {
    flushAll();
  }
});
