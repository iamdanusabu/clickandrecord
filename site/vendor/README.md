# Vendored dependencies

Everything here is committed deliberately rather than fetched at runtime, for two
reasons:

1. **MV3 forbids remote scripts.** An extension page can't `import` from a CDN, so
   the library has to ship with the extension.
2. **Nothing should phone home.** The whole premise of this recorder is that
   recordings never leave the machine. Downloading model weights on first use would
   have meant a request to huggingface.co and no subtitles while offline, so the
   models are vendored too — at the cost of the ~355 MB below.

Subtitle transcription therefore runs entirely on-device. Verify that by
disconnecting the network and generating subtitles: it still works.

## Contents

| Path | Source | Version | Licence | Size |
| --- | --- | --- | --- | --- |
| `transformers/transformers.min.js` | [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (`dist/transformers.min.js`) | 3.8.1 | Apache-2.0 (`transformers/LICENSE`) | 0.9 MB |
| `transformers/ort-wasm-simd-threaded.jsep.{mjs,wasm}` | same package — the onnxruntime-web build it ships with | 3.8.1 | MIT (ONNX Runtime) | 22 MB |
| `models/whisper-base.en-timestamped/` | [`onnx-community/whisper-base.en_timestamped`](https://huggingface.co/onnx-community/whisper-base.en_timestamped) | `main` @ 2026-07 | Apache-2.0 (Whisper) | 80 MB |
| `models/whisper-small.en-timestamped/` | [`onnx-community/whisper-small.en_timestamped`](https://huggingface.co/onnx-community/whisper-small.en_timestamped) | `main` @ 2026-07 | Apache-2.0 (Whisper) | 252 MB |

### Two file choices that are easy to get wrong

**`transformers.min.js`, not `transformers.web.min.js`.** Despite the name, the
`.web` build is the *unbundled* one intended for bundlers: it contains bare
specifiers (`onnxruntime-common`, `onnxruntime-web`) that a browser can't resolve.
Importing it in a worker fails at load with no useful message — the worker just
emits an `error` event. `transformers.min.js` is self-contained.

**The `_timestamped` model export, not plain `whisper-base`.** Word-level
timestamps are derived from the decoder's cross-attentions, and the standard export
omits them; asking for `return_timestamps: 'word'` against it fails with *"Model
outputs must contain cross attentions to extract timestamps"*. The `_timestamped`
export is the same size and otherwise identical. (`transcribe.worker.js` still falls
back to segment-level timings if word timings ever fail, so subtitles degrade
rather than break.)

**A `_timestamped` export is necessary but not sufficient — check the alignment heads
against the decoder depth.** Word timings are read from specific cross-attention heads,
named in `generation_config.json` as `alignment_heads` pairs of `[decoder_layer, head]`.
If any of those layers doesn't exist in the model, `return_timestamps: 'word'` throws
and `transcribe.worker.js` silently falls back to phrase-level timings — subtitles still
appear, but the karaoke highlight is gone and cues become whole sentences.

This is exactly how the **distil-whisper** exports fail. They inherit `alignment_heads`
from the teacher they were distilled from without recomputing them:

| Export | decoder layers | max layer in `alignment_heads` | word timings |
| --- | --- | --- | --- |
| `whisper-base.en_timestamped` | 6 | 5 | works |
| `whisper-small.en_timestamped` | 12 | 11 | works |
| `whisper-large-v3-turbo_timestamped` | 4 | 3 | works (but a ~600 MB encoder) |
| `distil-small.en_timestamped` | **4** | **11** | **fails** |
| `distil-medium.en_timestamped` | **2** | none at all | **fails** |

`distil-small.en` was tried and rejected for this reason: its text output was good — a
touch better punctuation than base.en on the reference clip — but it cannot produce word
timings, and no amount of vendoring fixes a config that points at layers the model
doesn't have. Inventing replacement heads is not an option either: they're empirically
chosen for monotonic audio alignment, and guessing yields plausible-but-wrong word times,
the same failure class as the WebGPU bug above.

So before vendoring any new model, run this:

```sh
python -c "
import json
cfg=json.load(open('config.json')); gen=json.load(open('generation_config.json'))
h=gen.get('alignment_heads') or []
print('viable:', bool(h) and max(l for l,_ in h) < cfg['decoder_layers'])"
```

**The `.en` variant.** English-only, and markedly more accurate on English speech
than multilingual base at identical size — the multilingual model spends capacity on
98 other languages. Because it's English-only, `transcribe.worker.js` must **not**
pass `language`/`task`: those emit multilingual control tokens the model wasn't
trained with. Add a multilingual export to the `MODELS` registry (and vendor the
matching folder) for other languages.

The ONNX weights are the **quantised** variants (`*_quantized.onnx`) — 23 MB + 54 MB for
base, 92 MB + 157 MB for small, versus several hundred MB each for fp32. Accuracy loss is
minor for speech, and the cues are editable anyway.

## The two models, measured

Both are offered in the editor's Subtitles panel ("Fast" and "Accurate"); the choice is
remembered in `localStorage`. `whisper-small.en` is the default — a wrong word costs more
to fix by hand than the extra wait costs to sit through — but a long recording on a slow
machine is exactly when the cheap one earns its keep.

Measured on the same reference clip ([`jfk.wav`](https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav),
11 s of speech), one machine, WASM:

| | vendored | cold, incl. model load | warm | word timings |
| --- | --- | --- | --- | --- |
| `whisper-base.en` ("Fast") | 80 MB | 30.3 s | 13.0 s | 20 words |
| `whisper-small.en` ("Accurate") | 252 MB | 99.4 s | 70.5 s | 20 words |

So budget roughly **5× the inference time** for Accurate, and about 30 s of one-off model
load on top of the first run in an editor session. Both transcribed the clip verbatim;
small.en also got the comma in "And so, my fellow Americans" that base.en misses. A clip
this clean can't show the real gap — that appears on product names and jargon, which is
what the model choice is actually for.

Switching models in the panel disposes the loaded pipeline before loading the other, so
only one model's weights are resident at a time.

## How it's wired up

`editor/transcribe.worker.js` sets:

```js
env.allowRemoteModels = false;                       // never fetch weights
env.localModelPath = '<...>/vendor/models/';         // look here instead
env.backends.onnx.wasm.wasmPaths = '<...>/vendor/transformers/';
```

`allowRemoteModels = false` is what makes an accidental network fetch fail loudly
rather than silently working in development and breaking offline.

WebAssembly also requires `'wasm-unsafe-eval'` in the manifest's
`content_security_policy.extension_pages` — without it the runtime won't start at
all in an extension page.

## Updating

Re-run, from the repo root:

```sh
cd vendor && npm pack @huggingface/transformers@3
tar -xzf huggingface-transformers-*.tgz --strip-components=2 -C transformers \
  package/dist/transformers.min.js \
  package/dist/ort-wasm-simd-threaded.jsep.mjs \
  package/dist/ort-wasm-simd-threaded.jsep.wasm
```

Model files come from the HuggingFace repo above: the five JSON files at the root,
plus `onnx/encoder_model_quantized.onnx` and
`onnx/decoder_model_merged_quantized.onnx`. Keep the directory layout —
transformers.js resolves `<localModelPath>/<model-id>/onnx/<file>`, so each folder name
must match a `path` in the `MODELS` registry in `editor/transcribe.worker.js`. Note the
folder names here use `.en-timestamped` where the HuggingFace repo uses `.en_timestamped`
— a hyphen, not an underscore; the registry is what decides, but stay consistent.

The other `*_quantized.onnx` files in those repos (`decoder_model_quantized.onnx`,
`decoder_with_past_model_quantized.onnx`) are **not** needed: the *merged* decoder covers
both the first pass and the with-past passes, and vendoring the others would add ~200 MB
that never gets read.

## Backend: WASM, not WebGPU

`transcribe.worker.js` deliberately runs on **WASM**. These are int8-quantised
weights, and q8 on the WebGPU (JSEP) backend returns numerically wrong results:
the model emits fluent-looking **gibberish** rather than erroring, which is
expensive to diagnose because it looks like a bad model or bad audio.

Measured on the same 11-second reference clip
([`jfk.wav`](https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav)):

| Backend | Result | Time (incl. model load) |
| --- | --- | --- |
| WASM | *"And so my fellow Americans, ask not what your country can do for you…"* — exact | ~27 s |
| WebGPU | gibberish | ~180 s |

WASM was both correct **and** faster here, so there's no trade-off to weigh.
`?asr=webgpu` on the editor URL forces the WebGPU path if you want to retest it
after a transformers.js/ORT upgrade — worth rechecking with a known clip rather than
your own voice, since you can then tell wrong from merely inaccurate.

If you ever swap in fp16/fp32 weights, WebGPU becomes viable again; the pairing to
avoid is specifically q8 + WebGPU.
