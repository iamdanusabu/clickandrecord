# Demo Recorder

A Chrome extension for recording clean product demos: screen (current tab) +
webcam bubble + microphone, with automatic click logging that becomes
click-triggered zoom-ins, and a built-in editor to trim, split, re-time, style,
subtitle and export.

The repo is split into the two things that ship — **`extension/`** (zip its contents
for the Chrome Web Store) and **`site/`** (push to GitHub for hosting; contains the
landing page, the editor and the speech models). Each is self-contained. The docs at
the root ship nowhere. `DEPLOY.md` has the packaging detail.

> **Picking this up after a break?** Read **[HANDOFF.md](HANDOFF.md)** — current
> state, what's still unverified, and the platform traps already paid for.
> About to change something? **[WORKFLOW.md](WORKFLOW.md)** covers the dev loop, what
> needs reloading when, how to test without re-recording, and the invariants that break
> silently. Hosting the editor on your own domain? See **[DEPLOY.md](DEPLOY.md)**.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the **`extension/`** folder.
4. Pin the extension from the toolbar puzzle-piece icon so it's easy to reach.

## Using it

1. Open what you want to demo, click the extension icon, and pick a source:
   **Tab**, **Window** or **Screen**.

   **Click zoom-ins work on all three.** Each click is mapped into whichever frame is
   being recorded — the viewport for a tab, the window's own screen rect for a window,
   the display for a screen — and clicks landing outside the recorded surface are
   dropped. The one real limit is coverage: an extension only sees clicks inside web
   pages, so on a window or screen recording, clicks in other applications, in Chrome's
   own toolbar, or on the desktop produce no zoom. During a window or screen recording,
   clicks are followed across tabs as you switch between them.

   **QA capture stays tab-only.** `chrome.webRequest` is filtered to a single tab, so
   attaching one tab's network log to a whole-desktop recording would read as evidence
   about everything on screen. It switches off visibly, with the reason shown.

   Window and Screen go through Chrome's own "choose what to share" dialog, which opens
   straight from the recorder — no intermediate window. **Window** records any app, not
   just Chrome, and has no audio on any platform, so narration comes from the mic.
   **Screen** can include system sound if you tick "Share audio"; if you don't, it records
   video only rather than failing. The count-in starts once you've chosen. Chrome's dialog takes focus, which closes the popup, so the count-in isn't drawn
   for these two — the toolbar badge still shows **REC**, and reopening the popup rejoins
   the count. If the window you were recording closes, the take finishes and saves rather
   than filming a frozen frame.
2. The first time you use webcam or mic, the popup shows **Allow camera & mic** —
   click it and choose Allow in Chrome's prompt. This can't be deferred until
   recording starts: the recorder runs in an offscreen document, which Chrome
   won't let display a permission prompt. Once granted, the popup shows a **live
   self-view** so you can check framing before you start.
3. Choose whether to include webcam, mic, click zoom-ins and QA capture, then hit
   **Start Recording**. A 3-2-1 counts you in, and **the count-in is not in the
   video** — the first recorded frame is the one after it reaches zero, so there's
   nothing to trim off the front.

   Chrome does make the extension acquire the tab's stream on the click itself
   (`chrome.tabCapture` is tied to that user gesture and can't wait), so the camera
   and mic open during the count-in. The recorder is what's held back. Stopping
   mid-count-in cancels cleanly and saves nothing.
4. Recording runs with **no on-screen furniture** — the toolbar icon shows **REC**.
   To stop, reopen the popup and hit **Stop & Edit**, or press **Alt+Shift+S**
   (rebindable at `chrome://extensions/shortcuts`). There's deliberately no
   floating widget: anything drawn into the recorded tab would be baked into the
   video, and a separate window can't be kept on top by an extension, so it just
   hid behind the browser.
5. Click **Stop & Edit** when you're done. A new tab opens with the editor,
   pre-loaded with your recording.
6. The editor is laid out in three parts: the **preview** with its play control,
   the **timeline** directly beneath it, and a **right rail** of tabs — Style,
   Frame, Camera, Output, Subtitles, Inspect — holding everything that changes how
   the output looks. Camera and Inspect are greyed out unless the recording
   actually has a webcam track or captured traffic. Editing the video itself lives
   under the preview; styling it lives in the rail.

   Working on the timeline:
   - Drag the handles at either end of a clip to trim it; hover the
     timeline to scrub-preview.
   - **Split** (or press `S`) cuts a clip in two at the playhead. That's how you
     remove something from the middle: split either side of the mistake and
     delete the piece between. Any clip can be deleted (✕ on the clip, or the
     clip panel) as long as one remains.
   - Click a clip to select it; the clip panel below the timeline shows its
     in/out points and a **speed** control (0.5×–4×). Speed is per clip, so split
     out the dead time and run just that section at 4×.
   - **Add zoom** places a zoom at the playhead for things you never
     clicked. While a zoom is selected, drag the yellow crosshair on the
     preview to aim it — and its strength and hold appear in a panel under the
     timeline.
   - **Zoom-ins are applied automatically** to every click detected while
     recording (the amber dots). Click a dot to toggle its zoom off/on, or
     select one to fine-tune strength and hold time. **Zoom every click** /
     **Clear all** re-apply or remove them in bulk.
   - **Add clip** appends another video (e.g. an intro, outro, or a supplementary
     screen capture) to the end of the timeline; trim it the same way.

   In the right rail:
   - **Style** — pick a background gradient preset or upload your own image, and
     set how far the recording is inset, how round its corners are, and whether it
     casts a shadow.
   - **Frame** — wrap the recording in mock window chrome: a plain window, or a
     macOS/Windows browser with a URL bar, in light or dark. The URL bar is
     prefilled with the page you recorded and is editable, since an internal URL
     often isn't something you want in a published demo.
   - **Camera** — show/hide the bubble, snap it to a corner or centre, or
     **drag it anywhere on the frame** — it's positioned in canvas space and drawn
     outside the screen window's clip, so it can sit over the inset recording, out
     on the background, or straddling the edge between them. Set its size, pick
     circle or rounded, and toggle border/shadow/mirror. The clip panel has a
     per-clip **Webcam** checkbox, so you can show yourself during the intro and
     hide it while demoing — split the clip where you want the change.
   - **Output** — pick an aspect ratio (Source / 16:9 / 9:16 / 1:1 / 4:5 —
     9:16 for Shorts/Reels), and use **Crop** to drag the frame edges in.
     **Reset crop** returns to the auto letterbox trim rather than clearing it
     outright, so the black bars don't come back.
   - **Subtitles** and **Inspect** are covered in their own sections below.
7. Hit **Export** and pick a **format** and **quality** — the dialog states the exact
   resolution, bitrate and estimated file size before you commit. See
   [Export](#export) below.

The recording's **name** sits in the top bar; click it to rename. It's what the exported
video, the `.srt`/`.vtt` sidecars and any Drive upload are called, so naming it first
saves renaming files afterwards. It defaults to the recorded page's title, or to
"Screen recording 2026-07-28 14.32" style for window and screen captures.

## Editing a video you already have

The editor works without recording anything. Open the popup and choose
**Edit a video I already have**, or just visit the editor URL with no `?session` —
you get a drop zone instead of an error. Drop a file anywhere on the page, or pick one.

The file you open takes the place a capture would have, so everything behaves the same:
trim and split it, run sections at up to 4×, place zooms by hand, generate subtitles
on your machine, set a background and frame, crop to any aspect ratio, and export MP4 or
WebM. Dropping further videos appends them as extra clips.

The one thing an uploaded video cannot have is *automatic* click zoom. Those come from the
click log this extension writes while recording, and a file from elsewhere has none — so
zooms on an opened video are the ones you add yourself with **Add zoom**.

## Export

**Export** opens a dialog rather than starting immediately, because the two things it asks
are the ones you can't change afterwards.

**Format** — MP4 (H.264 + AAC) or WebM (VP9 + Opus). MP4 is the default: WebM is smaller
for the same quality but still gets refused by plenty of editors, phones and upload forms.
Both are probed with `MediaRecorder.isTypeSupported` at runtime, so a browser that can't
do one simply isn't offered it.

**Quality** — High, Balanced or Small. The dialog states the exact resolution, bitrate and
estimated size before you commit, so the trade-off is visible rather than implied.

Two things worth knowing about how quality is chosen:

- **Bitrate scales with pixel count.** It used to be a flat 8 Mbps whatever the
  resolution, which is generous at 720p and thin at 1080p — that second case is what made
  exports look soft on text. Screen content runs at roughly twice the bits-per-pixel you'd
  give camera footage, because hard text edges are the first thing a thin bitrate smears.
  High keeps 8 Mbps as a floor, so it is never worse than the old behaviour at any size.
- **High renders *larger* than the preview to undo the inset.** Insetting the recording
  shrinks it inside a fixed canvas, so its pixels get resampled down and text softens —
  a long-standing rough edge. High scales the export canvas up by the same proportion
  (capped at 1.5×, and at 2560 px wide) so the recording lands back at native resolution.
  This is safe because every stage measurement is a fraction of the canvas's smaller
  dimension, so a larger canvas scales the whole composition rather than shifting it.

Recording quality was raised too, on the same reasoning: capture is no longer capped at
1920 px wide (2560 now, which matters on hi-DPI displays where viewport × DPR exceeds
1920), and the recorder's bitrate scales with pixel count instead of sitting at a flat
8 Mbps.

Export prefers a **WebCodecs fast path** (`renderCompositionWebCodecs` for WebM,
`renderCompositionWebCodecsMp4` for MP4): it encodes frame-by-frame via `VideoEncoder`/
`AudioEncoder` instead of replaying the composition in real time, so it's no longer bound
to the recording's own duration. Video decodes at `EXPORT_DECODE_SPEEDUP` (4×, capped at
16× if a segment is also manually sped up) driven by `requestVideoFrameCallback`, and
audio is pre-rendered offline through an `OfflineAudioContext` rather than captured live —
so tab visibility, a sleeping display or heavy system load can't stall it the way they
used to. This is a code-level target, not a measured benchmark: actual throughput at 4K
depends on the browser's decode/encode capacity on the machine running it.

Not every browser/codec pairing supports this: WebM needs `VideoEncoder`/`AudioEncoder`
plus `WebMMuxer`; MP4 additionally needs its AAC/H.264 codec pair confirmed via an async
probe. Either falls back silently to the older **real-time** `MediaRecorder` path
(`renderCompositionRealtime`) — a 5-minute video takes 5 minutes there, driven by
`requestAnimationFrame`, which Chrome stops entirely in a hidden tab. **It's safe to
switch tabs anyway**: that fallback pauses the recorder and the source video together the
moment the tab is hidden, and resumes both together when it's visible again, so nothing
is skipped or lost — it just takes longer. The overlay shows a distinct paused state so
it's obvious nothing is stuck. The WebCodecs path doesn't need this: `rVFC` keeps firing
regardless of tab visibility, so it isn't throttled in the background to begin with.

## Subtitles

In the editor, **Generate subtitles** transcribes the recording's audio and turns it
into editable text. Style it as **Boxed**, **Outline** or **Shadow**, set size,
text and accent colours, put it at the top or bottom, and optionally turn on
**word highlight** — karaoke-style emphasis that follows the spoken word. Captions
burn into the exported video, and **Download .srt / .vtt** produces a sidecar file
for YouTube, Vimeo or any player.

You don't have to transcribe to get subtitles. **+ Add text** writes a line by hand at
the playhead — useful when there's no narration to transcribe at all, or when a
mumbled word is quicker to type than to re-record. It's stored in recording-source
time like any other line, so trimming and speed changes carry it correctly; it clamps
itself against the next line rather than overlapping; and a hand-written line
**survives a re-run** of transcription, which replaces everything Whisper produced. An
untyped line draws nothing and is left out of the `.srt`/`.vtt`.

Lines are listed below the panel and are **editable** — click a timestamp to jump
there, fix the text inline, or delete a line. Transcription is never perfect with
product names and jargon, so expect a pass. Corrections persist: text is saved to
IndexedDB, so reopening the editor doesn't lose your edits or force a re-run.

**Transcription runs entirely on this machine** — Whisper via transformers.js, with the
weights committed under `vendor/` rather than downloaded. Nothing is uploaded, and it
works with the network disconnected. See `vendor/README.md` for the size that buys
(~355 MB) and how to update it.

Two models are vendored, picked in the panel; the choice is remembered:

| | Model | Measured on an 11 s clip | Best for |
| --- | --- | --- | --- |
| **Accurate** (default) | `whisper-small.en` | 99 s first run, 71 s after | product names, jargon, accents |
| **Fast** | `whisper-base.en` | 30 s first run, 13 s after | long recordings, slower machines |

Both produce **word-level** timings, so the karaoke highlight works either way. The first
run of an editor session also loads the model (~30 s for Accurate); later runs reuse the
loaded pipeline, and switching models releases the previous one's weights first.

Inference runs on **WASM, not WebGPU** — with these int8-quantised weights the WebGPU
backend returns numerically wrong results, producing fluent gibberish instead of an error,
and it was *slower* too. `vendor/README.md` has the measurements, and the reason
distil-whisper models can't be used here despite being the obvious size/speed win.

Two things worth knowing:

- Line times are stored in **recording-source** time, like clicks and zooms, so
  trimming, splitting, deleting and speed changes never move a caption. The
  `.srt`/`.vtt` export converts to **output** time — lines inside footage you cut are
  dropped and the rest renumbered — otherwise the sidecar would drift against the
  video.
- Whisper invents text over silence, so empty and known-hallucination segments
  ("thanks for watching" and friends) are filtered out.

## QA capture: network & console (optional)

Turn on **Network & console** in the popup before recording. Everything is
timestamped against the video's clock, so the editor's **Inspect** tab can show
you what fired at any moment of playback: click a row to jump the video there, and
the row at the playhead is highlighted as it plays. **Download HAR** produces a standard
HAR 1.2 file you can import into DevTools' Network tab or Charles;
**Download console log** gives the console output as JSON. Expanding a request
also offers **Copy as cURL** (bash flavour, same as DevTools — pastes into a bug
report or imports into Postman/Insomnia) and **Copy URL**.

Off by default and never silent — it observes every request the page makes, so
it should be a deliberate choice.

**What it can and can't see.** Two sources are merged:

- `chrome.webRequest` (in `capture.js`) sees **every** request — documents,
  images, beacons, not just ones a script made — with method, URL, status,
  headers, request payloads, sizes and timings. MV3 gives it **no way to read
  response bodies**.
- `probe.js`, injected into the page's own JS world, wraps `fetch`/`XHR` and so
  does capture **response bodies** and payloads, plus real `console.*` output and
  uncaught errors — but only for requests the page's own JavaScript makes.

So: response bodies are available for API calls, not for images or documents.
The editor says so inline rather than showing a blank box. Pairing the two
sources is a heuristic (same method + URL, nearest timestamp), so concurrent
identical requests can mis-pair; an unpaired probe entry is kept as its own row
rather than dropped.

`chrome.debugger` would provide all of this in one place, and was deliberately
not used: it shows a "started debugging this browser" infobar and locks DevTools
out of the tab being recorded.

Capture is capped (5,000 requests, 2,000 console entries, 128 KB per body,
~50 MB total). On overflow the oldest entries go first and the editor states how
many were dropped — a truncated log that looked complete would be worse than
no log.

## Saving to Google Drive

**Save to Drive** renders the edited composition (trims, zooms, background — not
the raw capture) and uploads it. It only ever runs on an explicit click, since it
sends the recording off the machine.

A client ID is already baked into `drive.js`. Override it without editing code:

```js
chrome.storage.local.set({ driveClientId: 'xxx.apps.googleusercontent.com' })
```

Whichever client ID is used needs this configured in
[Google Cloud Console](https://console.cloud.google.com/):

1. Enable the **Google Drive API**.
2. The OAuth client must be of type **Web application**.
3. **Authorised redirect URIs** must include exactly
   `https://<extension-id>.chromiumapp.org/` — the extension ID is on
   `chrome://extensions`, and `chrome.identity.getRedirectURL()` prints the exact
   value. A mismatch here is what produces `redirect_uri_mismatch`.
4. While the OAuth consent screen is in **Testing**, every Google account that
   signs in must be listed under **Test users**, or consent fails with
   `access_denied`.

The scope requested is `drive.file` — the narrowest one that permits uploads,
meaning the extension can only ever see files it created itself, never the rest
of your Drive. Tokens come from the implicit flow, so they last about an hour and
you'll be re-prompted after that.

Note that an OAuth **client ID** is a public identifier, not a secret: it's sent
in the auth URL on every sign-in, and Chrome extensions conventionally ship it in
the manifest. Keeping it in source is fine. A client *secret* would not be — the
implicit flow used here never needs one, so there's none to leak.

## Serving the editor from your own domain (optional)

By default the editor opens as `chrome-extension://…/editor/editor.html`. It can
instead be served from your own origin — for branding — **without uploading the
video anywhere**. The page pulls the recording back out of the extension through
a hidden `bridge.html` iframe, so the bytes never leave the machine.

1. Serve the `site/` folder from your origin — it contains the editor, the fonts
   and the models it needs. For local development, from the repo root:

   ```
   npx serve -l 3000 site
   ```

   run from the repo root, which puts the editor at `http://localhost:3000/editor/editor.html`.

2. Point the extension at it — run this in the service worker console
   (`chrome://extensions` → **service worker** under Demo Recorder):

   ```js
   chrome.storage.local.set({ editorBaseUrl: 'http://localhost:3000' })
   ```

   To go back to the bundled editor:
   `chrome.storage.local.remove('editorBaseUrl')`

3. Add the origin to **both** the `web_accessible_resources` matches in
   `manifest.json` and `ALLOWED_PARENT_ORIGINS` in `bridge.js`. Keep both lists
   tight: any origin listed there can read recordings out of the extension.
   `localhost`, `127.0.0.1`, and `*.retailcloud.com` are allowed already.

Caveats: the hosted editor needs the network to load (the bundled one works
offline), and it needs the extension installed — it's a front-end for the
extension's data, not a standalone app.

## Architecture (for future changes)

- `background.js` — service worker; owns recording state, starts tab
  capture (`chrome.tabCapture.getMediaStreamId`), manages the offscreen
  document, and opens the editor tab when a recording finishes. It also owns
  `COUNTDOWN_MS` and the recording's **epoch** — see below. Also runs the
  crash-recovery orphan scan (`checkForOrphanedRecording()`) and the
  `RECOVER_SESSION`/`DISCARD_RECOVERY` handlers — see **Crash recovery** below.
- `offscreen.js` / `offscreen.html` — records the **screen** (tab video) and mixes
  tab + mic audio via Web Audio, plus the **webcam on a second, independent
  `MediaRecorder`** so it lands in its own file rather than being drawn onto the
  screen canvas — that separation is what lets the editor reposition and restyle
  the bubble afterwards. Saves both `Blob`s into IndexedDB (shared origin with
  `editor.html`) so they never pass through `chrome.runtime` messaging. Opening the
  camera here only works because `permission.html` obtains the grant first: an
  offscreen document has no UI, so Chrome refuses to *prompt* from one. Both
  recorders pause together, and the delta between their start times is stored as
  `startOffsetMs` for the editor to align them. Every chunk from both recorders is
  also written to IndexedDB as it arrives, independently of the final Blob saved
  at Stop — see **Crash recovery** below.
- **Where the window/screen picker runs** — inside the offscreen document, via the
  standard `navigator.mediaDevices.getDisplayMedia()`. Not `chrome.desktopCapture`: that
  API is unavailable in offscreen documents (they get only `chrome.runtime`), can't host a
  dialog from the service worker, and hands back a single-use stream id that dies if a
  different frame redeems it. `getDisplayMedia()` returns a `MediaStream` directly to the
  same frame that asked, so there is no id and no handoff. `HANDOFF.md` records all four
  designs and why three failed.
- `content.js` — injected into every page. Logs normalized click coordinates
  + timestamps while recording, and deliberately renders **nothing** into the
  page (anything it drew would be captured into the video). `background.js`
  also injects it on demand via `chrome.scripting`, since the manifest only
  covers pages loaded after the extension starts — without that, tabs that
  were already open log no clicks at all.
There is no recording widget or controls window. Anything drawn into the recorded
tab is captured by `tabCapture`, and a separate window can't be kept on top by an
extension — so control lives in the toolbar popup plus a `chrome.commands`
shortcut, with the **REC** badge as the persistent indicator. The pre-flight
self-view is in the popup, where checking your framing actually matters.
- `permission.html` / `permission.css` / `permission.js` — a visible window whose
  only job is to trigger Chrome's camera/mic prompt. **This has to exist:** an
  offscreen document has no UI, so Chrome refuses to show a permission prompt
  from one and `getUserMedia` rejects immediately — which meant the recorder
  silently produced videos with no webcam and no narration, and the user was
  never asked. Granting here stores the decision against the extension's origin,
  after which `offscreen.js` can open the same devices without a prompt.
- `capture.js` — QA capture: `chrome.webRequest` listeners scoped to the recorded
  tab, entry assembly by `requestId`, size caps, and the merge with probe data.
  Loaded into the service worker via `importScripts`.
- `probe.js` — injected into the page's **MAIN** world (not an isolated content
  script, which would get its own copies of `fetch`/`console` and see nothing).
  Wraps `fetch`/`XHR`/`console` and posts entries out for `content.js` to relay.
- `drive.js` — Drive OAuth (`launchWebAuthFlow`, `drive.file` scope) and
  resumable upload. Used by the editor on the extension origin and by
  `bridge.js` when the editor is hosted, since neither the service worker nor a
  hosted page is the right place to hold the rendered blob.
- `editor/transcribe.worker.js` — Whisper in a module worker, so a multi-minute
  transcription doesn't freeze the editor. Loads everything from `vendor/` with
  `env.allowRemoteModels = false`, so a missing file fails loudly instead of
  quietly reaching for the network. Returns **words** with timestamps; grouping them
  into readable cues is an editorial decision and happens in `editor.js`.
- `vendor/` — transformers.js, the ONNX Runtime WASM build, and the Whisper model,
  all committed. See `vendor/README.md`.
- `fonts/` — Inter (variable, 400–700, two woff2 subsets, 133 KB), committed rather
  than fetched from a CDN for the same reason `vendor/` is: nothing at runtime
  reaches for the network, and the UI looks identical on a machine that doesn't have
  Inter installed. Declared by `editor/editor.css`, `popup.css` and
  `permission.css`. See `fonts/README.md`.
- `db.js` — tiny IndexedDB wrapper shared by `offscreen.js`, `bridge.js`,
  `capture.js`'s persistence path, and `editor/editor.js`. Version 2 added a `logs`
  store for captures (far too large for `chrome.storage.session`); version 3 a
  `webcam` store; version 4 a `captions` store; version 5 added `chunkMeta` and
  `chunks` (see **Crash recovery** below). Each is separate rather than a field
  on the recording because different contexts write them, and sharing one record
  would mean writers racing on a read-modify-write.
- `bridge.html` / `bridge.js` — hidden iframe used only when the editor is
  served from another origin. It runs in the extension origin, so it can read
  the recording out of IndexedDB and `postMessage` the `Blob` to an
  allowlisted parent page (structured clone passes Blobs by reference, so
  large videos aren't copied through JS memory).
- `editor/ui.js` — the right rail's tab switching, and nothing else. It's a
  separate file, loaded *after* `editor.js`, so a mistake in the chrome can't stop
  the editor wiring itself up. It doesn't know what the tabs contain: the two
  conditional tabs (Camera, Inspect) watch `#webcam-row`'s `hidden` attribute and
  `#debug-panel`'s `hidden` class with a `MutationObserver` and enable themselves
  when `editor.js` reveals either — so availability lives in one place instead of
  two. Every control keeps the id `editor.js` looks it up by; moving one between
  tabs is a pure HTML change.
- `editor/` — the post-recording editor. Trim, click→zoom-in keyframes,
  inserting extra clips, and the stage look (background/inset/corners/shadow)
  are stored as plain state; **export re-plays the whole composition in real
  time onto an offscreen canvas** and records *that* with `MediaRecorder` —
  this avoids needing ffmpeg.wasm/WebCodecs, at the cost of export taking
  roughly as long as the final video's length.

`renderInto()` is the single compositing function used by **both** the preview
and the export — background layer, then the recording drawn into an inset
rounded-rect with a shadow, with the camera transform applied inside that
frame. All stage measurements are fractions of the canvas's smaller dimension
rather than pixels, so what you see in the preview is what the export
produces. Zoom keyframes are compiled into a continuous **camera track**
(`buildCameraTrack`) of (time, scale, centre) nodes interpolated with
smootherstep; consecutive zooms closer than `ZOOM_LINK_GAP_MS` are linked so
the camera pans between them at full magnification instead of zooming out and
back in.

The editor separates **sources** (the decoded videos) from **segments** (the
ordered pieces of the output timeline). Splitting a clip produces two segments
sharing one source, which is what makes per-range speed and mid-take deletion
fall out of per-segment properties instead of needing a time-remapping engine.
Clicks and zoom keyframes are stored in **source** time, so splitting, deleting
or changing speed never moves a zoom. Speed shows up as a divisor between source
spans and output spans (`segOutputMs`), and every time conversion has to respect
it — `currentOutputElapsedMs`, `segmentOffsetMs`, `recordingTimeToGlobal`, and
`seekToGlobalElapsed` (which multiplies back).

Click-triggered zoom is deliberately **not** baked in during recording —
it's applied as a post-process in the editor using the logged click
timestamps, so it stays adjustable/removable after the fact. The editor
applies it to every click on load (`autoApplyZooms`), which absorbs any click
landing inside a zoom already in flight into that same cluster rather than
dropping it: `makeClusterKeyframe` frames the **bounding box** of every click
in the burst, centred and scaled (padded, capped at the same `ZOOM_SCALE` a
lone click gets — a cluster should never zoom in *more* than a single click
would) to fit the whole box in frame. A cluster spread wide enough that
framing it wouldn't zoom in on anything in particular (`CLUSTER_MIN_SCALE`)
is left unzoomed rather than forced into a token zoom. A tight burst in one
spot still reduces to one clean zoom on that spot, same as before.

Two non-obvious things about MediaRecorder's WebM output, both of which
caused hangs before being handled: the file has **no duration in its header**
(so `video.duration` reads back as `Infinity` — see `resolveDurationMs`, which
falls back to the wall-clock duration in `meta.duration`), and an offscreen
document's `requestAnimationFrame` never fires, so `offscreen.js` drives its
compositing loop with `setInterval` instead.

## The count-in, and the recording's epoch

Two things have to be true at once: Chrome will only hand over a tab stream on the
click that opened the popup, and the 3-2-1 must not appear in the video. So starting
is split in two.

1. **On the click** — `getMediaStreamId` (spending the gesture), then
   `OFFSCREEN_PREPARE`: open the webcam and mic, size the canvas from the tab's video,
   build the audio graph, construct both `MediaRecorder`s. Nothing is rolling. This is
   the slow part, and it happens *during* the count-in, so the wait buys something.
2. **After `COUNTDOWN_MS`** — `OFFSCREEN_BEGIN` starts both recorders in the same
   tick. Frame one of the file is the moment the count-in ends.

The **epoch** is that moment, and it is the single origin for every clock that has to
line up with the video: click timestamps (`content.js`), the QA capture's
`chrome.webRequest` side (`capture.js`), its in-page probe (`probe.js`), and the
popup's elapsed timer. The editor stores clicks, zooms and subtitle cues in
recording-source time, so an epoch that disagrees with frame zero by even 200 ms puts
every zoom behind its click.

It can't simply be *predicted*, because the recorders live in an offscreen document
and a hidden document's timers can fire a couple of hundred milliseconds late. So the
predicted instant is used to arm everything, and then `offscreen.js` reports the
instant tape actually rolled (`RECORDER_ROLLING`) and `background.js` repoints all
four clocks at the truth (`adoptRecorderEpoch`). `probe.js` therefore re-reads
`<html data-dr-start>` on *every* entry rather than snapshotting it at injection.

Consequences worth knowing:

- Anything that happens during the count-in lands at a **negative** offset. Clicks
  there are dropped — a zoom into a frame the viewer never sees is worse than no zoom.
  QA entries are kept, because a request already in flight when recording starts is
  exactly what a QA log should show; `capture.js` floors their offsets at zero.
- Capture is armed at the *start* of the count-in, not at the epoch, for that same
  reason.
- Stopping during the count-in cancels: the pending start is cleared, every stream is
  released, and nothing is written.

## Crash recovery

A recording no longer lives only in memory until you hit Stop. Each `MediaRecorder`
chunk — screen and webcam, roughly once a second — is written durably to IndexedDB
(`chunkMeta` + `chunks` in `db.js`) as it arrives, in addition to the in-memory
arrays that still back the normal, fast Stop path. If the offscreen document
crashes, the browser force-quits, or the extension gets reloaded mid-take, the
video up to the last flushed chunk survives on disk.

`background.js` looks for a recording that never reached a clean stop — on every
service-worker (re)spawn, on `chrome.runtime.onStartup`, and whenever the popup
opens — using `hasOffscreenDocument()` (Chrome's own context list) rather than its
own `state.phase` to tell a genuinely live recording from a stale one, since an
offscreen-only crash leaves `state` claiming a recording is still in progress with
nothing left to back it up. When it finds one, the popup's idle view shows a
**Recover / Discard** banner; Recover reassembles the durable chunks into a normal
finalized recording and opens the editor exactly as a clean Stop would — the editor
itself has no idea the difference exists.

What does and doesn't come back:

- **Video**: recovered up to the last flushed `MediaRecorder` timeslice — worst
  case, about a second of tail loss.
- **Clicks, typing (zooms), page URL/title**: recovered if the crash was
  offscreen-document-only (the extension itself kept running) — harvested from
  `chrome.storage.session`/in-memory state at the moment the scan notices it's
  stale, before it's reset. **Lost** on a full browser crash, since
  `chrome.storage.session` doesn't survive that; the editor still opens with the
  right page URL/title (a small snapshot is written to `chrome.storage.local` at
  recording *start*, for exactly this case), just with an empty click/zoom log.

A clean Stop leaves no trace in either new store — cleanup runs immediately after
the final Blob is saved, and self-heals on the next scan if that cleanup itself
gets interrupted.

## Known limitations (MVP scope)

- **Click zoom-ins only see clicks inside web pages.** They work on all three sources,
  but an extension cannot observe clicks in other applications, in Chrome's own toolbar,
  or on the desktop — so a screen recording gets zooms for the web-page clicks and nothing
  for the rest. On a window recording the mapping also assumes the window being recorded
  is the one holding your tabs; clicks that fall outside the recorded rect are dropped
  rather than misplaced, so picking a different window degrades to "no zooms".
- **QA capture is tab-only.** `chrome.webRequest` is filtered to one tab, and pairing a
  window or desktop recording with one tab's network log is actively misleading in a bug
  hunt. Disabled for Window and Screen in the popup *and* in `background.js`, so a stale
  options object can't re-enable it.
- Export prefers a **WebCodecs** fast path (frame-by-frame, decoupled from real time —
  see the Export section above) and only falls back to the older **real-time**
  `MediaRecorder` path when the browser or codec pairing doesn't support it, where a
  5-minute video still takes 5 minutes. Switching tabs no longer risks the output either
  way — the real-time fallback pauses cleanly while hidden and resumes where it left off,
  and the WebCodecs path isn't throttled in the background to begin with — but on the
  fallback a backgrounded export takes however much longer you were away. The WebCodecs
  path's actual speedup hasn't been benchmarked end-to-end; see `HANDOFF.md`.
- The editor is single-track: one screen recording plus any number of
  appended clips, played back-to-back — no overlays/picture-in-picture
  beyond the baked-in webcam bubble, no titles/annotations yet.
- The webcam is a separate track composited at playback, so the screen and webcam
  are two videos kept in step by seeking rather than one muxed file. Drift is
  corrected past ~120 ms; a heavily loaded machine may show brief slippage.
- Recordings made before the webcam was split out still open, but have the bubble
  burned into the picture and no webcam controls.
- Chrome extensions can't create an always-on-top window, so the controls
  window can fall behind the browser window. The toolbar badge still shows
  **REC**, and the extension popup also has Pause/Stop as a fallback.

## Ideas for a v2

- Optional MP4 export via a WASM encoder.
- Draggable/resizable webcam bubble, repositionable in the editor instead
  of baked in.
- Text callouts, cursor-highlight ring, blur/redact regions.
- Multi-tab / full-desktop recording via `chrome.desktopCapture`.
