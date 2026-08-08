# Workflow — Demo Recorder

How to develop this extension: the dev loop, what needs reloading when, how to test each
area without re-recording every time, and the invariants that break silently if you don't
know about them.

The other three docs cover different questions, and this one deliberately doesn't repeat
them:

| Doc | Answers |
| --- | --- |
| [`README.md`](README.md) | What the extension is, how each file fits together, why the design is the way it is |
| [`HANDOFF.md`](HANDOFF.md) | What state it's in, what's unverified, and the platform traps already paid for |
| [`DEPLOY.md`](DEPLOY.md) | Hosting the editor on your own origin |
| **this file** | How to change it and know you didn't break anything |

---

## Setup

There is no build step and no `package.json`. The extension runs from source.

```sh
# 1. Serve the site folder (it contains the editor, the fonts and the models)
npx serve -l 3000 site

# 2. Load the extension
#    chrome://extensions → Developer mode → Load unpacked → select extension/

# 3. Point the extension at the local editor (service worker console)
chrome.storage.local.set({ editorBaseUrl: 'http://localhost:3000' })
```

Three things about that server:

- **Serve `site/`, not `site/editor/`.** `editor.css` loads Inter as `../fonts/…` and
  the worker loads `../vendor/…`. Serving the editor folder alone 404s both.
- **`serve.json` disables clean URLs on purpose.** The redirect drops the query string,
  which strips `?session=` and breaks the editor entirely. Any host you use must preserve
  query strings.
- **Serving over localhost is a deliberate choice, not a convenience.** `chrome-extension://`
  pages can't be driven by browser automation or inspected as easily, so hosting the editor
  on localhost is what makes it testable at all. Keep it that way while iterating. To fall
  back to the bundled copy: `chrome.storage.local.remove('editorBaseUrl')`.

---

## What to reload when you change what

Getting this wrong wastes more time than any other thing here, because a stale service
worker looks exactly like a broken change.

| You changed | What to do |
| --- | --- |
| `site/editor/*` | Refresh the editor tab. No extension reload. |
| `popup.*` | Close and reopen the popup. |
| `background.js`, `capture.js`, `db.js` | **Reload the extension** (`chrome://extensions` → ⟳). These load into the service worker via `importScripts`. |
| `offscreen.js/html` | Reload the extension. The document is recreated per recording, but the file is read from the package. |
| `content.js` | Reload the extension **and** refresh every page you're testing on. Content scripts are injected at page load. |
| `probe.js` | Reload the extension. It's injected per recording, so the next recording picks it up. |
| `permission.*` | Reload the extension. It opens fresh each time. |
| `manifest.json` | Reload the extension. |
| `vendor/`, `fonts/` | Nothing, unless paths changed. Redeploy if the editor is hosted. |

**Reloading the extension no longer destroys a recording in progress** — chunks are
now persisted incrementally to IndexedDB as they're captured (see README's
**Crash recovery** section), so the video up to the last flushed chunk survives a
reload and surfaces as a Recover/Discard banner in the popup the next time it
opens. What reloading still costs: it clears `chrome.storage.session`, and that's
where the click log (zooms) lives while recording — so a recovered session has the
video but **no yellow dots**, same gotcha as the paragraph below. `pageUrl`/
`pageTitle`/`source` come back regardless, from a small snapshot `background.js`
writes to `chrome.storage.local` at recording *start* for exactly this case.

Reloading mid-recording is still worth avoiding when you can — recovery is a
safety net for a real crash, not a substitute for a clean stop, and it always
costs the last ~1s of video and the whole zoom log. Finish or abandon a recording
before reloading if you have the choice.

Separately, `chrome.storage.session` being wiped by a reload also affects a
recording that already finished and was saved before you reloaded: the video
itself lives in IndexedDB and survives, but the click log, `pageUrl` and `source`
of that *already-saved* session live in session storage too — so re-opening that
editor URL after a reload silently has **no clicks and no zooms**. If a recording
suddenly has no yellow dots, check whether you reloaded the extension since
making it.

---

## Testing without recording every time

Recording a fresh take for every editor change is the slow path. Two techniques cover most
of it.

### Synthetic editor state

Push fake sources and segments and re-render. This is how the timeline maths, subtitle
timing, spacing and rail behaviour get exercised. Paste into the editor tab's console:

```js
const v = document.createElement('video'); v.muted = true;
canvas.width = 1920; canvas.height = 1080;
project.sources.push({ id: 99, kind: 'recording', name: 'Screen Recording',
  videoEl: v, url: '', blob: null, duration: 42000, crop: null, thumbs: null, peaks: null });
project.segments.push({ id: 991, sourceId: 99, in: 0, out: 42000, speed: 1 });
selectedSegmentId = 991;
baseOutputSize = { w: canvas.width, h: canvas.height };
playhead.segIndex = 0; playhead.localMs = 0;
project.clicks = [{ t: 700, x: 0.28, y: 0.38 }, { t: 1850, x: 0.72, y: 0.6 }];
project.captions = [{ id: 'cue-1', t: 300, endT: 1500, text: 'Example cue', words: [] }];
autoApplyZooms();
renderTimeline(); renderClipPanel(); renderCaptionList(); renderCaptionLane(); renderFrame();
```

Reveal the two conditional rail tabs the same way:

```js
document.getElementById('webcam-row').hidden = false; renderWebcamControls();
initDebugPanel({ network: [{ t: 420, method: 'GET', status: 200, url: 'https://api.example.com/x', type: 'fetch' }],
                 console: [{ t: 500, level: 'log', text: 'hello' }] });
```

The editor's globals are reachable from the console because `editor.js` is a classic
script, not a module. That's load-bearing for this workflow.

### Logic harnesses in Node

Anything that's arithmetic rather than DOM — the count-in epoch, click-to-frame mapping,
cue clamping, export bitrate planning — is worth a throwaway Node script over a browser
round-trip. Copy the function out, inject its globals, assert the property that matters.
Past examples proved: a click at video time *T* logs as *t ≈ T* under ±500 ms of recorder
drift; the popup renders "3‑2‑1" under a second of setup slop; a window moved mid-recording
still maps clicks correctly.

### What these can't test

**Anything that needs the tab to be visible.** A hidden or background tab has its timers
throttled to roughly 1/second and doesn't composite, so:

- `canvas.captureStream()` produces a **0-byte** recording, and
- `requestAnimationFrame` — which drives the *real-time* export render loop — doesn't
  fire at all.

Measured: a `setInterval(33ms)` draw loop fired **twice in 1.5 s** in a hidden tab. So
the real-time export path cannot be verified from a background tab or from automation
that backgrounds the page. That path has to be tested by hand, in a focused window,
watching it.

As of 2026-07-28 the real-time export loop pauses the recorder and the source video
together on `document.visibilitychange` and resumes both together, specifically so a
real user backgrounding the tab mid-export can no longer produce a truncated file (see
HANDOFF.md — this was the leading suspect for "exported video isn't full" reports). That
fix is **verified by two Node harnesses, not by a live browser** — this same limitation
is why. When automation is available, the priority test is: export something with a
non-contiguous cut, switch tabs mid-export (including right as a cut happens), come
back, and confirm the file is complete with no skipped or frozen stretch.

**Since 2026-08-05/06 this is the fallback path, not the default one.** Export now
prefers a WebCodecs pipeline (`renderCompositionWebCodecs` / `renderCompositionWebCodecsMp4`
in `editor.js`) that drives video via `requestVideoFrameCallback` instead of `rAF` —
`rVFC` is tied to the decode pipeline, not compositing, so it isn't throttled in a hidden
tab and needs no pause/resume dance. That path is itself unverified end to end (see
HANDOFF.md) — it just fails differently, so don't assume the hidden-tab caveats above
carry over to it untested.

---

## Before you call something done

Cheap gates first.

```sh
# Syntax across every source file
for f in extension/*.js site/editor/*.js; do node --check "$f" || echo "FAIL $f"; done

# Manifest still parses
python -c "import json; json.load(open('extension/manifest.json')); print('ok')"
```

Then the one that catches the most damage — **every id `*.js` looks up must exist in the
matching HTML**:

```sh
python - <<'EOF'
import re
for html, js in [('extension/popup.html','extension/popup.js'),
                 ('site/editor/editor.html','site/editor/editor.js'),
                 ('extension/permission.html','extension/permission.js')]:
    ids = set(re.findall(r'id="([a-z0-9-]+)"', open(html, encoding='utf-8').read()))
    used = set(re.findall(r"getElementById\('([a-z0-9-]+)'\)", open(js, encoding='utf-8').read()))
    missing = sorted(used - ids - {'zoom-settings', 'stage-padding-val', 'stage-radius-val'})
    print(f'{js:22} {missing or "ok"}')
EOF
```

(The three exclusions are created at runtime or looked up by `name + "-val"` suffix.)

Then, per area:

| Touched | Check |
| --- | --- |
| Editor UI | Load with synthetic state; click through **all six** rail tabs; confirm Camera and Inspect are disabled without a webcam track or logs, and enable when you reveal them |
| Timeline | Trim, split, delete, change speed, drag the playhead — then confirm zoom dots and caption bars still line up |
| Recording | Record a real take. Check the **first frame is after** the count-in and a zoom lands *on* its click, not after it |
| Export | Real take, focused window, watch it through. Compare duration, pacing, bubble position and caption timing against the preview |
| Subtitles | Run against [`jfk.wav`](https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav), not your own voice — with a known clip you can tell *wrong* from merely *inaccurate*. Expect verbatim text and 20 word timings |
| Any message type | Confirm both a sender and a handler exist: `grep -rn 'YOUR_MESSAGE' *.js` |
| Crash recovery | Record ~15s with clicks on, then kill the offscreen document (`chrome://extensions` → Inspect views: offscreen.html → run `window.close()` in its console) rather than stopping normally. Reopen the popup: expect the Recover/Discard banner. Recover → editor opens with video up to the last flushed chunk and the clicks logged before the kill. Then repeat with several **normal** start/stop cycles in a row and confirm the banner never appears for those, and that the `chunks`/`chunkMeta` IndexedDB stores are empty right after each clean stop (DevTools → Application → IndexedDB, on the offscreen document) |

`HANDOFF.md` tracks what is still unverified. Add to it rather than quietly assuming
something works — a row saying "implemented, never run" is worth more than an optimistic
tick.

---

## Invariants that break silently

These don't produce errors. They produce a half-working editor or a subtly wrong video.

**The editor's markup is an API.** `editor.js` looks up ~90 element ids and builds clips,
swatches, segmented options, subtitle rows and QA rows in JS with fixed class names
(`clip-body`, `frame-option`, `swatch`, `sub-row`, `debug-*`, `zoom-bar`, `trim-handle`).
Restyling means keeping every one. Two live couplings are easy to miss:

- `renderZoomSettings()` inserts its panel with
  `document.querySelector('.timeline-panel').insertAdjacentElement('afterend', …)`, so a
  `.timeline-panel` element must exist with a sensible next-sibling position.
- The thumbnail, waveform, ruler and zoom-lane renderers all size themselves from
  `clientWidth`/`clientHeight` **at render time**. A lane that is `display: none` when it
  renders comes out 1px wide. That's why the timeline lives in the always-visible centre
  column and never inside a tab.

**Bootstrap calls go at the bottom of `editor.js`.** Function declarations hoist; `const`
doesn't. Calling a bootstrap function above the data it reads throws
"Cannot access X before initialization" and aborts the whole script — leaving the editor
half-wired while everything still *looks* defined. This has bitten three times.

**One epoch per recording.** Clicks, the QA capture, the probe and the popup timer all
timestamp against the instant `MediaRecorder` actually rolled — reported back by
`offscreen.js`, not the instant it was scheduled for. Removing that round-trip puts every
zoom behind its click by a machine-dependent amount.

**A service worker cannot raise UI, and an offscreen document has almost no `chrome.*`.**
The service worker has no WebContents, so it can show neither a permission prompt nor a
source picker — both fail in a way that looks like the user cancelling. An offscreen
document is granted only `chrome.runtime`; every other namespace is `undefined` there. So
the camera prompt lives in `permission.html` (a visible window), and window/screen capture
uses `getDisplayMedia()` — a standard web API needing no extension namespace — from the
offscreen document. `HANDOFF.md` records all four designs and why three failed; don't
re-try the dead ones.

**A start failure after the popup closes is invisible unless it's stashed.** Choosing a
window or screen closes the popup, so anything that fails afterwards has no one to report
to. `background.js` writes the message to `chrome.storage.session` and the popup shows it
on next open. If you add a new failure path in `startRecording`, it inherits this — but if
you add one *outside* it, remember the port may already be dead.

**Adding a hosting origin means changing three places**: `background.js`
(`DEFAULT_EDITOR_BASE_URL` or storage), `manifest.json` (`web_accessible_resources`
matches), and `bridge.js` (`ALLOWED_PARENT_ORIGINS`). The last two are the security
boundary — any origin listed can read recordings out of the extension, so keep both narrow.

**`checkForOrphanedRecording()` must never be gated on `state.phase === 'idle'`.**
It exists specifically to catch the case where `state.phase` is *lying* — an
offscreen-document-only crash leaves `state` (in memory, or restored from
`chrome.storage.session`) still saying `'recording'`, because nothing tells it
otherwise. Its own internal check (`hasOffscreenDocument()`, Chrome's own context
list, not `state.phase`) is what tells a stale `state` from a genuinely live one.
A caller that only invokes it `if (state.phase === 'idle')` silently disables the
one scenario it's for — this shipped broken once for exactly that reason before
being caught in review; see `GET_STATE`'s handler in `background.js` for the fixed
shape. It's always safe to call unconditionally: a truly live recording is never
mistaken for an orphan.

**A stale `state` has to be harvested before it's reset, not after.** `resetState()`
(via `clearPersistedState()`) wipes `chrome.storage.session`, which is the only
place a live take's click/typing log exists while recording. Any code path that
might discard `state` outside a clean stop — the `RECORDING_ERROR` handler,
`stopRecording()`'s failure branch, `checkForOrphanedRecording()`'s own
staleness check — has to copy what it wants to keep (see `harvestAndResetState()`)
in the same breath as detecting the problem, never in a later pass.

**`site/` is the whole public surface.** Deploys ship that folder as-is — there is no
ignore list to maintain, but it also means anything dropped into `site/` goes public.
The one standing exclusion is `site/.gitignore`'s rule for the 157 MB Accurate model,
which GitHub cannot accept; the editor probes and hides the option when it's absent.

---

## Common recipes

**A new control in the right rail** — add the markup to the right `<section class="rail-page">`
in `editor/editor.html` with a stable `id`, then read it in `editor.js`. Spacing is
gap-driven (`.rail-page` 24px between groups, `.field-group` 10px within), so don't add
margins. A control that should only appear conditionally goes inside an element toggled with
`hidden`, and `ui.js` will enable its tab via `MutationObserver` if you wire it into `link()`.

**A new option that affects the rendered frame** — put it in the relevant state object
(`stage`, `webcamStyle`, `captionStyle`), read it inside `renderInto()`, and express any
size as a **fraction of the canvas's smaller dimension**. Pixels break the promise that the
preview matches the export, and break the High export preset's inset compensation.

**A new message between contexts** — add the `case` to `handleMessage()` in `background.js`
and grep to confirm exactly one sender and one handler. Messages sent with
`chrome.runtime.sendMessage` reach every extension context *except* the sender, so the popup
sees offscreen traffic too; it ignores what it doesn't recognise.

**A new speech model** — see `vendor/README.md`. The check that matters before downloading
anything: `max(layer for layer, head in alignment_heads) < decoder_layers`. Fail it and word
timings silently degrade to phrase-level cues.

**Changing export quality or format** — `EXPORT_FORMATS` and `EXPORT_QUALITIES` in
`editor.js`. Formats are probed with `MediaRecorder.isTypeSupported`, so an unsupported one
just isn't offered. Keep the High preset's 8 Mbps floor: a purely per-pixel rate makes 720p
worse than the flat rate it replaced.

---

## Version control

**This project is not under version control.** No `.git`, no history, no way to see what a
change touched or to undo one.

That's worth fixing before the next substantial change. Note that `vendor/` (~355 MB of
model weights and WASM) and `fonts/` (133 KB) are committed *deliberately* — the whole
premise is that nothing is fetched at runtime — so a plain `git init` produces a large
repository. Either accept that, or put the two `.onnx` files behind Git LFS. What you should
not do is gitignore them: the extension cannot function without them, and the reasoning for
vendoring is documented in `vendor/README.md`.

A suggested `.gitignore`:

```
node_modules/
.vercel/
*.log
```

---

## Deploying

`DEPLOY.md` has the detail. The short version: `npx vercel --prod` from the repo root,
then point the extension at the deployed origin with
`chrome.storage.local.set({ editorBaseUrl: 'https://…' })`.

Two things to re-check after any deploy: that query strings survive (or `?session=` is
stripped and the editor loads nothing), and that the model files are actually reachable —
generating subtitles is the fastest proof.
