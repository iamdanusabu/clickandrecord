// Speech-to-text for subtitles, running entirely on this machine.
//
// A module worker, so a multi-minute transcription doesn't freeze the editor. It
// lives in a worker rather than the service worker because that has no DOM, no WASM
// threads and no WebGPU.
//
// Everything is loaded from vendor/ — see vendor/README.md for why the model is
// committed rather than downloaded.

// transformers.min.js, NOT transformers.web.min.js — despite the name, the ".web"
// build is the *unbundled* one for bundlers and contains bare specifiers
// ("onnxruntime-common") that a browser can't resolve, which fails the worker at
// load with no useful error. This one is self-contained.
import { pipeline, env } from '../vendor/transformers/transformers.min.js';

// Fail loudly rather than quietly reaching for the network: if a file is missing
// from vendor/, this surfaces it in development instead of "working" here and
// breaking for anyone offline.
env.allowRemoteModels = false;
env.allowLocalModels = true;
// The default; a TRANSCRIBE message may carry `modelBase` to fetch weights from a
// separate host instead (see MODEL_BASE_URL in editor.js). allowRemoteModels stays
// false either way — it governs reaching for the HuggingFace hub, not this path.
const DEFAULT_MODEL_PATH = new URL('../vendor/models/', import.meta.url).href;
env.localModelPath = DEFAULT_MODEL_PATH;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;

// Both entries are "_timestamped" exports, not the plain ones. Word-level timestamps
// are derived from the decoder's cross-attentions, and a standard export omits them —
// asking for `return_timestamps: 'word'` against one fails with "Model outputs must
// contain cross attentions to extract timestamps". Check `alignment_heads` is present
// in a candidate's generation_config.json before vendoring it.
//
// Both are English-only ".en" variants, markedly more accurate on English speech than
// the multilingual exports at the same size — a multilingual model spends capacity on
// 98 other languages. Add a multilingual export here if you need them.
//
// Every model offered here must support *word-level* timestamps, or picking it would
// silently disable the karaoke highlight. That rules out the distil-whisper exports:
// they inherit `alignment_heads` from the teacher they were distilled from without
// recomputing them, so distil-small.en asks for heads in decoder layers up to 11 while
// having only 4 — and distil-medium.en ships none at all. The check before vendoring
// anything new is `max(layer for layer, head in alignment_heads) < decoder_layers`.
const MODELS = {
  accurate: { path: 'whisper-small.en-timestamped', name: 'whisper-small.en' },
  base: { path: 'whisper-base.en-timestamped', name: 'whisper-base.en' },
};
const DEFAULT_MODEL = 'accurate';

let transcriber = null;
let device = null;
let loadedModel = null;

function post(type, payload) {
  self.postMessage({ type, ...payload });
}

// Whisper hears speech in silence. These filters drop the usual artefacts: empty
// text, and the stock hallucinations it emits for near-silent audio.
const HALLUCINATIONS = [
  'thank you', 'thanks for watching', 'you', 'bye', 'subscribe',
  'thank you for watching', 'okay', 'mm', 'mm-hmm',
];

function isJunk(text, durationMs) {
  const clean = text.trim().toLowerCase().replace(/[.,!?…]/g, '');
  if (!clean) return true;
  if (durationMs < 80) return true;
  return HALLUCINATIONS.includes(clean);
}

async function load(preferred, modelKey) {
  const choice = MODELS[modelKey] ? modelKey : DEFAULT_MODEL;
  if (transcriber && loadedModel === choice) return;

  // Switching models: let go of the old weights first. Holding both would mean ~250 MB
  // of tensors resident in the worker, and the WASM heap doesn't give that back.
  if (transcriber) {
    try {
      await transcriber.dispose();
    } catch (err) {
      console.warn('[transcribe] could not dispose the previous pipeline', err);
    }
    transcriber = null;
    loadedModel = null;
  }

  // WASM first, deliberately. These are int8-quantised weights, and q8 on the
  // WebGPU (JSEP) backend is known to return numerically wrong results — the
  // symptom is fluent-looking gibberish rather than an error, which is very
  // expensive to diagnose. WASM is slower but correct.
  //
  // Pass ?asr=webgpu on the editor URL to try the fast path.
  const candidates = preferred === 'webgpu' && typeof navigator !== 'undefined' && navigator.gpu
    ? ['webgpu', 'wasm']
    : ['wasm'];

  let lastErr = null;
  for (const candidate of candidates) {
    try {
      post('progress', { stage: 'model', message: `Loading model (${candidate})…`, ratio: 0 });

      // Aggregate across files rather than reporting each one's percentage: per-file
      // ratios reset to 0 seven times, which reads as the bar going backwards.
      const files = new Map();
      transcriber = await pipeline('automatic-speech-recognition', MODELS[choice].path, {
        device: candidate,
        dtype: 'q8', // matches the quantised weights vendored in
        progress_callback: (p) => {
          if (!p || !p.file) return;
          if (p.status === 'progress' && p.total) {
            files.set(p.file, { loaded: p.loaded, total: p.total });
          } else if (p.status === 'done') {
            const known = files.get(p.file);
            if (known) files.set(p.file, { loaded: known.total, total: known.total });
          }
          let loaded = 0;
          let total = 0;
          files.forEach((f) => { loaded += f.loaded; total += f.total; });
          post('progress', {
            stage: 'model',
            message: `Loading ${MODELS[choice].name} (${candidate})`,
            detail: `${(loaded / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`,
            ratio: total ? loaded / total : 0,
          });
        },
      });
      device = candidate;
      loadedModel = choice;
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[transcribe] ${candidate} backend unavailable`, err);
      transcriber = null;
    }
  }
  throw lastErr || new Error('no usable backend');
}

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'TRANSCRIBE') return;

  try {
    env.localModelPath = msg.modelBase || DEFAULT_MODEL_PATH;
    await load(msg.device, msg.model);
    // No ratio: transformers.js gives no progress during Whisper decoding, so the
    // UI shows an indeterminate bar rather than a fake percentage.
    const seconds = Math.round((msg.audio.length || 0) / 16000);
    post('progress', {
      stage: 'transcribe',
      message: 'Transcribing speech',
      detail: `${seconds}s of audio · ${MODELS[loadedModel].name} on ${device}`,
      ratio: null,
    });

    // chunk/stride let Whisper handle audio longer than its 30s window; the stride
    // overlap is what stops words being clipped at chunk seams.
    // No `language`/`task` here: this is an English-only model, and passing them
    // makes it emit the multilingual control tokens it wasn't trained with.
    const baseOptions = {
      chunk_length_s: 30,
      stride_length_s: 5,
    };

    let result;
    let wordLevel = true;
    try {
      result = await transcriber(msg.audio, { ...baseOptions, return_timestamps: 'word' });
    } catch (err) {
      // Segment-level timestamps work on any Whisper export. Falling back means
      // losing the word highlight rather than losing subtitles altogether.
      console.warn('[transcribe] word timestamps unavailable, falling back to segments', err);
      wordLevel = false;
      post('progress', {
        stage: 'transcribe',
        message: 'Retrying without word timings',
        detail: 'word-level timestamps unavailable',
        ratio: null,
      });
      result = await transcriber(msg.audio, { ...baseOptions, return_timestamps: true });
    }

    const words = (result.chunks || [])
      .filter((c) => Array.isArray(c.timestamp) && c.timestamp[0] != null)
      .map((c) => ({
        text: (c.text || '').trim(),
        // Whisper reports seconds; everything downstream works in ms.
        t: Math.round(c.timestamp[0] * 1000),
        // A trailing chunk can have a null end timestamp — give it a nominal length.
        endT: Math.round((c.timestamp[1] ?? c.timestamp[0] + 0.3) * 1000),
      }))
      .filter((w) => w.text && !isJunk(w.text, w.endT - w.t));

    const text = (result.text || '').trim();
    // Logged so a bad result can be compared against what was actually said without
    // digging through the cue list.
    const model = MODELS[loadedModel].name;
    console.info('[transcribe] result', { model, device, wordLevel, words: words.length, text });
    post('done', { words, wordLevel, text, device, model });
  } catch (err) {
    post('error', { error: `${err.name || 'Error'}: ${err.message || err}` });
  }
});
