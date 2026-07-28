# Handoff — Demo Recorder

Written at the end of the session on **2026-07-27**. `README.md` describes what the
extension *is* and how each piece works; this file covers what a new session needs
to know that isn't obvious from the code: current state, what's unverified, the
traps already paid for, and what's worth doing next.

Read `README.md` first, then this. `WORKFLOW.md` is the practical companion — dev loop,
what needs reloading when, how to test each area, and the pre-flight checks.

---

## Next actions — session end 2026-07-28

The repo is live at **https://github.com/iamdanusabu/clickandrecord** (owner account
`iamdanusabu`; note the machine also holds a credential for a second account,
`danusabu25`, which caused one 403 before the owner signed in). In order:

1. **Vercel**: import the repo → **Root Directory = `site`** → Framework *Other*, no
   build command → Deploy → Domains → `clickandrecord.com` + `www`. Then sanity-check:
   `/` (Archivo loads), `/editor/editor.html` (drop zone), `/editor/editor.html?session=test`
   (must say "Recording not found" **without losing the query string**), and the
   Subtitles panel offering **Fast only** (the probe hiding the un-pushed Accurate model).
2. **After the deploy is live**: set `DEFAULT_EDITOR_BASE_URL = 'https://clickandrecord.com'`
   in `extension/background.js`, commit, push. Allowlists already permit the domain.
3. **Drive OAuth**: add redirect URI for the current dev extension ID (see Environment
   notes) in Google Cloud Console, or Save-to-Drive fails with `redirect_uri_mismatch`.
4. **Landing-page placeholders** still open: Chrome Web Store URL (both CTAs are
   `href="#"`), `og-image.png`, `favicon.svg`, `apple-touch-icon.png`, `logo.png`, the
   `sameAs` placeholder in the JSON-LD, real screenshots replacing the CSS mocks, and
   `/privacy` + `/terms` (the store requires a privacy policy anyway).
5. **Testing — explicitly deferred by the user this session.** Everything in "Verify
   these first" below still stands, plus: the light-theme site, relit popup, standalone
   editor (drop zone), theme toggle and scroll playhead were all shipped while browser
   automation was disconnected, so they are **code-verified but never seen rendered**.
   Two earlier bugs this session were only caught by screenshot — look before trusting.
6. **Accurate model on the web**: not available via GitHub→Vercel (GitHub blocks the
   157 MB file). Options, wired and documented in DEPLOY.md: Vercel Pro + CLI deploy,
   or an R2/S3 bucket via `MODEL_BASE_URL` in `site/editor/editor.js`.

## Where things stand

Everything below is implemented and loads without errors.

| Area | State |
| --- | --- |
| Screen + mic recording, click logging | Working, tested |
| Editor: timeline, trim, split, per-clip speed, delete | Working; time maths unit-tested |
| Click→zoom + manual zooms with draggable target | Working, tested |
| Stage look: gradient/image background, inset, corners, shadow, browser frames | Working, tested |
| Crop + output aspect (16:9, 9:16, 1:1, 4:5) | Implemented, lightly tested |
| Draggable playhead / scrubbing | Working, tested |
| Webcam as a separate track, composited in the editor | Implemented, **not tested with a real recording** |
| Subtitles (local Whisper) with styling + word highlight | Working; verified against a known clip |
| QA capture (network + console) with HAR export | Implemented, **never verified with real traffic** |
| Save to Google Drive | Implemented, blocked on OAuth config last time it was tried |
| **Export** | Implemented, **never verified end-to-end** |
| Editor UI (light theme, right rail, timeline under the preview) | Rebuilt 2026-07-28; verified in the browser against synthetic state |
| Hand-written subtitle cues (**+ Add cue**) | Working; logic verified in the browser (clamping, overlap refusal, live preview, sidecar exclusion of empty cues) |
| Window / screen recording | **Three** failed designs before this one — see the picker trap below. Fourth design (`getDisplayMedia()` in the offscreen document) is the current code and is **unrun**. |
| Click zoom on window / screen | Implemented; mapping unit-tested (11 cases incl. multi-monitor and a window moved mid-take), **never run against a real desktop capture** |
| Recording name / rename | Working, verified in the browser |
| Export format + quality dialog | Implemented; the plan maths verified, **the encode itself is unverified** — see below |
| Two-folder packaging (`extension/` + `site/`) | Done 2026-07-28; routes and wiring verified after the move. Hosted "Accurate" model is git-ignored (GitHub 100 MB limit) and the editor hides it when absent |

## Verify these first — they are the real unknowns

1. **Export.** The single biggest gap. `renderComposition()` in `editor/editor.js`
   replays the whole composition through a *separate* path from the preview, and
   nothing has confirmed the output file matches what you see. Test with the works:
   split a clip, set one piece to 4×, delete another, add a webcam bubble, turn on
   subtitles, then export and compare duration, pacing, bubble position and caption
   timing. If duration is wrong, the segment-advance logic in that loop is where to
   look.
2. **Webcam end-to-end.** Record with the webcam on and confirm the bubble appears
   in the editor *and* that switching **Show** off removes it — that's what proves
   it's composited rather than burned in. Then check sync while playing through a
   4× segment.
3. **Subtitles on real speech.** Accuracy was verified with a reference clip, not a
   human voice. Both vendored models (`whisper-small.en` as "Accurate", the default, and
   `whisper-base.en` as "Fast") transcribe `jfk.wav` verbatim with word-level timings —
   which proves the plumbing, not the accuracy on your voice saying your product's names.
   If Accurate still comes out rough, the next rung up that can do word timings is
   `whisper-medium.en` (~24 decoder layers, several hundred MB); the distil-whisper
   models cannot, see `vendor/README.md`.
4. **QA capture.** Record with the toggle on, on a page that makes API calls, and
   confirm the Network/Console panel populates and the HAR imports into DevTools.
5. **Window and screen capture.** Untested end to end, and now on its *fourth* picker
   design (see the trap below) — so start here. Check, in order: Chrome's "choose what to
   share" dialog opens with **no intermediate extension window**; picking a source yields a
   stream rather than an error; the canvas takes the source's own dimensions rather than a
   letterboxed version; a screen recording with "Share audio" ticked produces an audio track
   and one without it still records; cancelling leaves nothing running (no REC badge, no
   camera light, no sharing indicator); and closing the recorded window finishes the take
   instead of freezing it.

   If it fails, **reopen the popup** — start failures are now stashed and shown there,
   because choosing a source closes the popup and the error used to reach nobody but the
   service worker console.

## Traps already paid for — don't rediscover these

Each of these cost real time. They're in the code comments too, but they're the
things most likely to be "fixed" back into bugs.

- **An offscreen document cannot show a permission prompt.** `getUserMedia` there
  rejects instantly, and the original code swallowed it — producing videos with no
  webcam or narration, silently. `permission.html` obtains the grant from a visible
  page first; after that the offscreen document opens the devices fine.
- **`navigator.permissions.query` lies for extension origins** — reports `prompt`
  when access plainly works. Detect via `enumerateDevices()`: labels are only
  populated once permission exists.
- **MediaRecorder's WebM has no duration in its header**, so `video.duration` is
  `Infinity`. See `resolveDurationMs()`. This also once caused an infinite `for`
  loop that froze the page and made DevTools unresponsive.
- **`requestAnimationFrame` never fires in an offscreen document** (no compositor
  surface). `offscreen.js` drives its canvas loop with `setInterval`; switching it
  back yields 0-byte recordings.
- **q8 weights + WebGPU = fluent gibberish, not an error.** Transcription runs on
  WASM deliberately, and was *faster* too. Measurements in `vendor/README.md`.
- **A `_timestamped` export isn't enough for word timings — check `alignment_heads`
  against `decoder_layers`.** Word timings come from named cross-attention heads
  `[layer, head]`; if a layer doesn't exist, `return_timestamps: 'word'` throws and the
  worker quietly degrades to phrase-level cues (no karaoke highlight, sentence-long
  cues). The distil-whisper exports all fail this: they inherit the teacher's heads
  without recomputing them, so `distil-small.en` has 4 decoder layers and asks for layer
  11. It was downloaded, tested and discarded for exactly this — the text was good, the
  timings impossible. One-line check before vendoring anything:
  `max(l for l, _ in alignment_heads) < decoder_layers`.
- **`transformers.min.js`, not `transformers.web.min.js`** — the `.web` build is for
  bundlers and has bare specifiers a browser can't resolve; the worker fails at load
  with an empty error message.
- **Word timestamps need the `_timestamped` model export** (cross-attentions).
- **`chrome.tabCapture` letterboxes** if its stream aspect doesn't match the tab,
  baking black bars in. Capture is pinned to the tab's viewport size, and the editor
  also auto-detects and crops bars on older recordings.
- **Temporal dead zone bit three times.** All bootstrap calls live at the *bottom* of
  `editor/editor.js` for this reason: function declarations hoist, `const` doesn't,
  so calling a bootstrap function above its data throws and aborts the whole script —
  leaving the editor half-wired while everything still *looks* defined.
- **Getting a window/screen stream took four designs. Three of them are dead ends; read
  this before touching it.**
  1. **`chooseDesktopMedia` from the service worker** — no WebContents, so Chrome can't
     host the dialog. It cancels instantly and the callback returns an **empty stream id**,
     byte-for-byte identical to the user pressing Cancel. Symptom: "No window or screen was
     picked", every time.
  2. **`chooseDesktopMedia` from a separate visible window** (`picker.html`, deleted) — the
     dialog opened and returned an id, but the id was redeemed by a *different* frame (the
     offscreen document) after the picker window had closed. Symptom: **"Error starting tab
     capture"** — Chrome routes desktop ids through the same legacy `chromeMediaSource`
     plumbing as tab capture, so a dead *desktop* id reports itself as a *tab* failure and
     sends you hunting in the wrong file entirely.
  3. **`chooseDesktopMedia` from the offscreen document** — offscreen documents are granted
     **only `chrome.runtime`**; every other `chrome.*` namespace is `undefined` there.
     Symptom: "chrome.desktopCapture is unavailable in the recorder document." This is the
     one that rules out the whole `chrome.desktopCapture` approach, because (1) and (2) have
     already ruled out every other place to call it from.
  4. **`getDisplayMedia()` in the offscreen document** (current) — a standard web API, so no
     extension namespace is needed, and it returns a `MediaStream` directly rather than an
     id that must be redeemed elsewhere. The asker and the consumer are the same frame, so
     there is no handoff left to get wrong. `DISPLAY_MEDIA` is declared among the offscreen
     document's creation reasons for this call. `chrome.desktopCapture` has been dropped
     from the manifest — nothing uses it now.

  **If design 4 also fails**, the error will say so explicitly ("Chrome refused the screen
  picker in the recorder document … This is a browser restriction, not a declined prompt"),
  which distinguishes a browser refusal from the user cancelling. The remaining untried
  option is design 2 with the picker window **kept open for the whole recording** rather
  than closed on selection — that directly tests whether the id died because its frame went
  away. Don't re-try 1 or 3; they are settled.

  The rule underneath 1–3: **whichever context asks for a desktop stream id must be the one
  that redeems it and must still be alive when it does** — and no context satisfies that
  *and* has the API. Which is why design 4 stops using ids at all.
- **`chooseDesktopMedia`'s `targetTab` argument is a trap.** It reads like "which tab to
  anchor the picker to", but it *restricts the resulting stream to frames whose origin
  matches that tab's URL* — which would make the id unusable by the offscreen document that
  requests and consumes it. `offscreen.js` calls the two-argument form on purpose, so the
  stream belongs to the calling extension. If window/screen capture ever fails with a
  getUserMedia permission error while the tab path works, look here first.
- **The recording has one epoch, and it isn't the click.** Starting is deliberately
  two messages — `OFFSCREEN_PREPARE` (open devices, build both recorders, roll
  nothing) then `OFFSCREEN_BEGIN` (roll, at an absolute instant) — so the 3-2-1
  count-in is spent on setup and lands *outside* the file. Chrome still forces
  `getMediaStreamId` onto the popup's click gesture; that part can't move.
  The epoch that clicks, `capture.js`, `probe.js` and the popup timer all
  timestamp against is the instant `MediaRecorder` actually rolled — **not** the
  scheduled one. A hidden document's timers drift (measured ~220 ms in a hidden page),
  and that drift would put every zoom behind its click, so `offscreen.js` reports
  `RECORDER_ROLLING` and `adoptRecorderEpoch()` repoints all four clocks. If you ever
  "simplify" that round-trip away, zooms will land late by a machine-dependent amount
  — which looks like a zoom-tuning problem and isn't.
  Corollary: `probe.js` must keep re-reading `<html data-dr-start>` per entry instead
  of snapshotting it, or it won't hear the correction.
- **MV3 service workers unload when idle.** `background.js` mirrors recording state
  into `chrome.storage.session` and restores it on every message; without that,
  stopping a recording had no `sessionId` and IndexedDB failed with "key path yielded
  a value that is not a valid key".
- **Export monitoring has to be muted, not just tapped.** Each source's gain node is
  wired to the editor's speakers so you can hear the video while editing.
  `connectForExport` originally *added* the export destination without removing that, so an
  export played the whole video out loud while the user waited — narration talking over
  them for the length of the render. It now disconnects `editorAudioCtx.destination` for the
  duration and reconnects in `disconnectForExport`.
- **Anything drawn into the recorded tab is captured.** That's why there's no
  floating widget — control is the toolbar popup plus `Alt+Shift+S`.
- **The editor's markup is an API.** `editor.js` reaches for ~80 element ids, and
  builds clips, swatches, segmented options, subtitle rows and QA rows in JS with
  fixed class names (`clip-body`, `frame-option`, `swatch`, `sub-row`, `debug-*`,
  `zoom-bar`, `trim-handle`, …). Restyling means keeping every one of those; the
  2026-07-28 UI rebuild moved controls between panels without touching `editor.js`
  precisely because ids and generated class names were preserved. Two live
  couplings that are easy to miss: `renderZoomSettings()` inserts its panel with
  `document.querySelector('.timeline-panel').insertAdjacentElement('afterend', …)`,
  so a `.timeline-panel` element has to exist and its next sibling position has to
  be somewhere sensible; and the thumbnail, waveform, ruler and zoom-lane
  renderers all size themselves from `clientWidth`/`clientHeight` at render time,
  so a lane that is `display: none` when it renders comes out 1px wide. That's why
  the timeline lives in the always-visible centre column and never inside a tab.
- **`[hidden]` loses to an author `display` rule.** `editor.js` reveals
  `#webcam-row` and `#trim-bars-wrap` by clearing the `hidden` attribute, but both
  are flex containers — and the UA's `[hidden] { display: none }` is weaker than
  any author `display: flex`, so they showed even when "hidden". `editor.css` now
  carries an explicit `[hidden] { display: none !important; }`.

## Environment notes

- **The repo is two shippable folders** since 2026-07-28: `extension/` (load unpacked
  from here; zip its contents for the store) and `site/` (landing page + editor +
  vendor; push to GitHub, serve locally with `npx serve -l 3000 site`). Docs stay at
  the root and ship nowhere. Fonts are duplicated into both folders deliberately so
  each is self-contained.
- **The editor is served from `http://localhost:3000`**, set via
  `chrome.storage.local` (`editorBaseUrl`), with `DEFAULT_EDITOR_BASE_URL` in
  `background.js` as the fallback default. Start the server with `npx serve -l 3000 site`
  from the repo root. To use the extension's bundled copy instead:
  `chrome.storage.local.remove('editorBaseUrl')`.
  `serve.json` disables clean-URLs on purpose — the redirect drops the query string,
  which would strip `?session=` and break the editor. Any host you deploy to must
  preserve query strings.
- **`fonts/` holds Inter** (two variable woff2 subsets, 133 KB), committed for the
  same reason as `vendor/`. Three stylesheets declare the `@font-face` pair with
  paths relative to themselves — `editor/editor.css` uses `../fonts/`, `popup.css`
  and `permission.css` use `fonts/`. A new page needs its own copy of the pair.
  `fonts/README.md` has the update command; note that fetching the Google Fonts CSS
  with an old user-agent yields `.ttf` several times the size.
- **`vendor/` is ~98 MB** (transformers.js + ORT WASM + Whisper base.en). Committed
  deliberately so nothing is fetched at runtime; see `vendor/README.md`.
- **Google Drive**: client ID is in `drive.js`, overridable via
  `chrome.storage.local.driveClientId`. Last attempt hit `redirect_uri_mismatch`;
  the authorised redirect URI must be exactly
  `https://<extension-id>.chromiumapp.org/` (trailing slash, nothing after it) on a
  **Web application** client, and the account must be a Test user while the consent
  screen is in Testing.
- **Extension ID** is `gmajpidccchfoaeanfchepioojdkdehf` (since the 2026-07-28 move
  into `extension/` — unpacked IDs derive from the install path, so the old
  `mnegblmoojfcppbdiknecccahokcebma` died with the old path). Nothing in code carries
  the literal ID (runtime uses `chrome.runtime.id`), so the single consequence is
  **Drive OAuth**: the authorised redirect URI in Google Cloud Console must be exactly
  `https://gmajpidccchfoaeanfchepioojdkdehf.chromiumapp.org/` (trailing slash, Web
  application client) or sign-in fails with `redirect_uri_mismatch`. A store-published
  copy will have yet another, stable ID — the URI needs adding again then.
- Adding a new hosting origin means updating **three** places: `background.js`
  (`DEFAULT_EDITOR_BASE_URL` or storage), `manifest.json`
  (`web_accessible_resources` matches) and `bridge.js` (`ALLOWED_PARENT_ORIGINS`).
  The last two are the security boundary — any origin listed can read recordings out
  of the extension, so keep them narrow.

## Debugging notes

- **`chrome-extension://` pages can't be driven by browser automation.** That's why
  the editor is served over localhost: it makes the editor inspectable and testable
  directly. Keep it that way while iterating.
- The editor surfaces load failures in its **status text** (top-right) via
  `window.onerror`/`unhandledrejection`, which is usually faster than the console.
- For anything model-related, test with a **known** audio clip
  ([`jfk.wav`](https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav))
  rather than your own voice — otherwise you can't tell *wrong* from merely
  *inaccurate*. That distinction is what finally isolated the WebGPU bug.
- Synthetic state is the cheap way to exercise the editor without a recording: push
  fake `project.sources` / `project.segments` and call `renderTimeline()`. That's how
  the speed and subtitle-timing maths were checked.

## Known gaps and ideas

- **The count-in is not verified against a real recording.** The logic is covered by
  two throwaway harnesses (the recorder stays idle until the epoch, both recorders
  roll in one tick, the popup renders 3-2-1 under up to a second of setup slop,
  cancelling mid-count-in rolls nothing, and click offsets stay exact under ±500 ms of
  roll drift) — but nobody has yet recorded a real take and confirmed frame one is
  post-count-in. Do that before trusting it: record, then check the first frame and
  that a zoom lands *on* its click rather than just after.
- **Inset trades resolution**: padding shrinks the recording inside a fixed canvas,
  so a heavy inset softens the image. Rendering the export larger would fix it.
- **Webcam sync is seek-based**, drift-corrected past ~120 ms; a loaded machine may
  show brief slippage.
- **Export is real-time** (it replays the composition), so a 5-minute video takes
  5 minutes. A WebCodecs path would fix that and is the biggest performance win
  available — and would also remove the must-stay-visible constraint below.
- **The editor tab must stay visible during an export.** The render loop uses
  `requestAnimationFrame`, which Chrome stops in a hidden tab. Demonstrated while testing:
  in a hidden tab a `setInterval(33ms)` draw loop fired twice in 1.5 s and
  `canvas.captureStream` produced a **0-byte** recording. The export overlay now warns
  about it, but nothing enforces it — a `visibilitychange` handler that pauses and resumes
  the render, or warns on return, would be the honest fix.
- Whisper `base.en` only — no other languages vendored.
- Not tested outside Chrome on Windows 11.
