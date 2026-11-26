// The two local speech-to-text engines, both running on sherpa-onnx.
//
//   zipformer  Streaming Zipformer (English). Words appear as you speak and a
//              line is finalized when the speaker pauses. Lowest delay.
//   parakeet   NVIDIA Parakeet TDT 0.6B v2 (English). Silero VAD cuts speech
//              into utterances and each one is transcribed whole; a draft is
//              re-transcribed about once a second while someone is talking.
//              Most accurate, with punctuation and capitals.
//
// Each engine loads its model once; createSource() makes an independent
// per-speaker state ("them" / "me") and calls emit(text, isFinal).
//
// Note: Electron does not allow native code to hand JavaScript "external"
// buffers, so every sherpa-onnx call that returns audio is passed
// enableExternalBuffer = false.
const fs = require('fs');
const path = require('path');
const sherpa = require('sherpa-onnx-node');

const SR = 16000;

const ENGINES = {
  zipformer: {
    dir: 'sherpa-onnx-streaming-zipformer-en-2023-06-26',
    files: {
      encoder: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      decoder: 'decoder-epoch-99-avg-1-chunk-16-left-128.onnx',
      joiner: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
      tokens: 'tokens.txt',
    },
    create: createZipformer,
  },
  parakeet: {
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
      vad: '../silero_vad.onnx',
    },
    create: createParakeet,
  },
};

function resolveFiles(name, modelsDir) {
  const spec = ENGINES[name];
  if (!spec) throw new Error(`Unknown speech engine "${name}".`);
  const files = {};
  for (const [k, f] of Object.entries(spec.files)) {
    files[k] = path.join(modelsDir, spec.dir, f);
    if (!fs.existsSync(files[k])) {
      throw new Error(
        `Speech model file missing: ${path.relative(modelsDir, files[k])}. Download the speech model in the app (or run "npm run models" in the project folder), then try again.`,
      );
    }
  }
  return files;
}

/** Throws with a readable message if the engine's model files aren't downloaded. */
function checkModels(name, modelsDir) {
  resolveFiles(name, modelsDir);
}

function createEngine(name, modelsDir) {
  const files = resolveFiles(name, modelsDir);
  return { name, createSource: ENGINES[name].create(files) };
}

// ---------- Streaming Zipformer ----------

// The model outputs UPPERCASE words with no punctuation.
function tidy(text) {
  const t = text.trim().toLowerCase().replace(/\bi\b/g, 'I').replace(/\bi'(m|ve|ll|d)\b/g, "I'$1");
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

function createZipformer(files) {
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4, // nothing recognized yet: give up after 2.4 s of silence
    rule2MinTrailingSilence: 0.8, // finalize a line after a 0.8 s pause
    rule3MinUtteranceLength: 20, // or after 20 s of continuous speech
  });

  return (emit) => {
    const stream = recognizer.createStream();
    let last = '';

    const decode = () => {
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      return tidy(recognizer.getResult(stream).text);
    };

    return {
      accept(samples) {
        stream.acceptWaveform({ samples, sampleRate: SR });
        const text = decode();
        if (recognizer.isEndpoint(stream)) {
          if (text) emit(text, true);
          recognizer.reset(stream);
          last = '';
        } else if (text !== last) {
          last = text;
          emit(text, false);
        }
      },
      flush() {
        // Pad with silence so the last words get decoded, then finalize.
        stream.acceptWaveform({ samples: new Float32Array(SR * 0.5), sampleRate: SR });
        stream.inputFinished();
        const text = decode();
        if (text) emit(text, true);
      },
    };
  };
}

// ---------- Parakeet TDT + Silero VAD ----------

const WINDOW = 512; // Silero VAD frame size at 16 kHz
const DRAFT_EVERY_MS = 1000;
const LEAD_IN_FRAMES = Math.ceil((0.5 * SR) / WINDOW);

function createParakeet(files) {
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      modelType: 'nemo_transducer',
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });

  const transcribe = (samples) => {
    const s = recognizer.createStream();
    s.acceptWaveform({ samples, sampleRate: SR });
    recognizer.decode(s);
    return recognizer.getResult(s).text.trim();
  };

  return (emit) => {
    const vad = new sherpa.Vad(
      {
        sileroVad: {
          model: files.vad,
          threshold: 0.5,
          minSilenceDuration: 0.5, // pause that ends an utterance
          minSpeechDuration: 0.25,
          maxSpeechDuration: 20, // force a cut in long monologues
          windowSize: WINDOW,
        },
        sampleRate: SR,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      60,
    );
    const buffer = new sherpa.CircularBuffer(30 * SR);
    let live = []; // frames of the utterance in progress, for drafts
    let liveLen = 0;
    let recent = []; // the last ~0.5 s before speech was detected
    let lastDraftAt = 0;

    const finishSegments = () => {
      while (!vad.isEmpty()) {
        const seg = vad.front(false);
        vad.pop();
        live = [];
        liveLen = 0;
        const text = transcribe(seg.samples);
        emit('', false);
        if (text) emit(text, true);
      }
    };

    return {
      accept(samples) {
        buffer.push(samples);
        while (buffer.size() >= WINDOW) {
          const frame = buffer.get(buffer.head(), WINDOW, false);
          buffer.pop(WINDOW);
          vad.acceptWaveform(frame);
          if (vad.isDetected()) {
            // The VAD only reports speech after ~0.25 s of it; start the
            // draft from the lead-in so the first words aren't cut off.
            if (!live.length) {
              live = recent;
              liveLen = recent.length * WINDOW;
              recent = [];
            }
            live.push(frame);
            liveLen += WINDOW;
          } else {
            recent.push(frame);
            if (recent.length > LEAD_IN_FRAMES) recent.shift();
          }
          finishSegments();
        }

        const now = Date.now();
        if (liveLen > SR * 0.6 && now - lastDraftAt > DRAFT_EVERY_MS) {
          lastDraftAt = now;
          const all = new Float32Array(liveLen);
          let off = 0;
          for (const f of live) {
            all.set(f, off);
            off += f.length;
          }
          const draft = transcribe(all);
          if (draft) emit(draft, false);
        }
      },
      flush() {
        vad.flush();
        finishSegments();
      },
    };
  };
}

module.exports = { createEngine, checkModels, ENGINES };
