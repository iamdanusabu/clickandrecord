// Runs inside the extension's offscreen document. This is the only place
// that is allowed to hold getUserMedia/getDisplayMedia streams and a
// MediaRecorder in an MV3 extension (service workers can't do either).
//
// Pipeline: tab video+audio (chrome.tabCapture) + optional webcam + optional
// mic are composited live onto a <canvas> (screen frame + circular webcam
// bubble), captured back out as a stream, and recorded with MediaRecorder.
// The click-zoom effect is intentionally NOT baked in here — it's applied
// later, in the editor, as a post-process using the click timestamps logged
// by content.js. That keeps zoom fully editable/undoable after the fact.

let rec = {
  sessionId: null,
  tabStream: null,
  tabVideoEl: null,
  webcamStream: null,
  webcamVideoEl: null,
  webcamRecorder: null,
  webcamChunks: [],
  webcamStartedAt: 0,
  micStream: null,
  audioCtx: null,
  canvas: null,
  ctx: null,
  rafId: null,
  mediaRecorder: null,
  chunks: [],
  paused: false,
  startedAt: 0,
  pendingStart: null,
  // Crash-recovery durability: each chunk is also written to IndexedDB as it
  // arrives (see ondataavailable below), independently of the in-memory arrays
  // above which remain the fast path for a normal stop. chunkDbPromise is one
  // connection opened once per take and reused for every append.
  chunkSeq: 0,
  webcamChunkSeq: 0,
  chunkDbPromise: null,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Starting is two steps on purpose. PREPARE opens the streams and builds the
  // recorders; BEGIN is what actually rolls tape. Everything expensive therefore
  // happens *during* the popup's countdown, and the recorded file starts at the
  // moment the countdown ends rather than containing it.
  if (msg.type === 'OFFSCREEN_PREPARE') {
    rec.sessionId = msg.sessionId;
    prepareCapture(msg.streamId, msg.options)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_BEGIN') {
    // Responds immediately; the recorders start on their own at startAt. Waiting
    // for them would block the popup and the countdown would be over before it
    // could be drawn.
    sendResponse(beginCapture(msg.startAt));
    return false;
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stopCapture()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_SET_PAUSED') {
    rec.paused = !!msg.paused;
    // Both recorders pause together, or the webcam would drift out of step with
    // the screen for the rest of the take.
    [rec.mediaRecorder, rec.webcamRecorder].forEach((r) => {
      if (!r) return;
      if (rec.paused && r.state === 'recording') r.pause();
      if (!rec.paused && r.state === 'paused') r.resume();
    });
    sendResponse({ ok: true });
  }
});

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm';
}

// Raised from 1920: on a hi-DPI or larger-than-1080p display, the tab's viewport times
// its device pixel ratio easily exceeds 1920, and capping there threw away real detail
// before the encoder ever saw it. Text is what suffers first.
const MAX_CAPTURE_WIDTH = 2560;
const MAX_CAPTURE_HEIGHT = 1600;

// Screen content is not camera content. It's mostly flat colour with hard, high-contrast
// edges — text — and those edges are exactly what a low bitrate smears first. Camera
// footage looks fine around 0.1 bits per pixel; UI text needs roughly twice that before
// it stops looking soft. Scaled by pixel count rather than fixed, so a 2560-wide capture
// isn't starved at the same bitrate a 1280-wide one is comfortable at.
const BITS_PER_PIXEL = 0.32;
const CAPTURE_FPS = 30;

function videoBitrateFor(width, height) {
  const target = width * height * CAPTURE_FPS * BITS_PER_PIXEL;
  // Floor keeps small captures from looking worse than they used to; ceiling keeps a
  // large display from asking for a bitrate the encoder can't sustain in real time.
  return Math.round(Math.min(60_000_000, Math.max(8_000_000, target)));
}

// One entry point, two genuinely different mechanisms. A tab is captured from an id minted
// by `chrome.tabCapture` in the service worker (it has to be — Chrome ties that call to the
// click that opened the popup) and redeemed here through the legacy `chromeMediaSource`
// constraints, pinned to the tab's own viewport size. A window or screen is captured with
// the standard `getDisplayMedia()`, which shows its own picker and needs no id at all.
async function getSourceStream(streamId, options) {
  if (options.source === 'window' || options.source === 'screen') {
    return getDisplayStream(options.source);
  }
  return getTabStream(streamId, options.viewport);
}

// Window and screen capture goes through `getDisplayMedia()` — the standard web API —
// rather than `chrome.desktopCapture`.
//
// That is the fourth design of this, and the previous three each died on a different
// constraint. Written out because the failures were expensive and none of them said what
// was actually wrong:
//
//   1. `chooseDesktopMedia` from the **service worker** — a service worker has no
//      WebContents to host a dialog, so Chrome cancelled the request instantly and the
//      callback returned an *empty stream id*, which is byte-for-byte what pressing
//      Cancel looks like. Symptom: "No window or screen was picked", every time.
//   2. `chooseDesktopMedia` from a **separate visible window** — the dialog opened, but
//      the id was consumed by a *different* frame (this document) after the picker window
//      had closed. Symptom: "Error starting tab capture" — Chrome routes desktop ids
//      through the same legacy `chromeMediaSource` plumbing as tab capture, so a dead
//      desktop id reports itself as a *tab* failure and sends you to the wrong file.
//   3. `chooseDesktopMedia` from **this document** — offscreen documents are granted only
//      `chrome.runtime`; every other `chrome.*` namespace is undefined here. Symptom:
//      "chrome.desktopCapture is unavailable in the recorder document."
//
// `getDisplayMedia()` needs no extension API, so (3) can't apply, and it hands back a
// MediaStream directly instead of an id that has to be redeemed elsewhere — so (1) and (2)
// can't apply either. There is no handoff left to get wrong. `DISPLAY_MEDIA` is declared
// among this document's creation reasons for exactly this call.
async function getDisplayStream(source) {
  // displaySurface is a *hint*: Chrome still offers every surface in its picker, it just
  // opens on the matching tab. Deliberately not a hard constraint — refusing the user's
  // actual choice would be worse than recording what they picked.
  const video = {
    displaySurface: source === 'screen' ? 'monitor' : 'window',
    width: { max: MAX_CAPTURE_WIDTH },
    height: { max: MAX_CAPTURE_HEIGHT },
    frameRate: { max: CAPTURE_FPS },
  };

  // Only screen capture can offer system audio, and only if the user ticks the box. Asking
  // is what puts the checkbox there; whether a track arrives is checked after the fact.
  const audio = source === 'screen';

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video, audio });
  } catch (err) {
    // Distinguish the user declining from the call being refused outright, because they
    // need completely different responses and both surface as exceptions here.
    if (err.name === 'NotAllowedError' && /disallowed|permissions policy|activation/i.test(err.message || '')) {
      throw new Error(
        'Chrome refused the screen picker in the recorder document '
        + `(${err.name}: ${err.message}). This is a browser restriction, not a declined prompt.`
      );
    }
    if (err.name === 'NotAllowedError') throw new Error(`No ${source} was picked.`);
    throw new Error(`Could not start ${source} capture: ${err.name} — ${err.message}`);
  }

  if (audio && !stream.getAudioTracks().length) {
    // "Share audio" was left unticked. Not an error — narration still comes from the mic —
    // but worth saying out loud, because silent system audio looks like a bug later.
    console.info('[demo-recorder] no system audio: "Share audio" was not ticked');
  }

  return stream;
}

// Requests the stream at the tab's own aspect ratio so Chrome doesn't letterbox
// the content into a differently-shaped stream. min == max pins the size exactly;
// if the constraint can't be satisfied we retry unconstrained rather than fail
// the whole recording.
async function getTabStream(streamId, viewport) {
  const audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
  const baseVideo = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };

  if (viewport && viewport.w > 0 && viewport.h > 0) {
    const dpr = viewport.dpr || 1;
    const scale = Math.min(1, MAX_CAPTURE_WIDTH / (viewport.w * dpr));
    const width = Math.round(viewport.w * dpr * scale);
    const height = Math.round(viewport.h * dpr * scale);
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio,
        video: {
          mandatory: {
            ...baseVideo,
            minWidth: width,
            minHeight: height,
            maxWidth: width,
            maxHeight: height,
          },
        },
      });
    } catch (err) {
      console.warn('[demo-recorder] exact capture size rejected, falling back', err);
    }
  }

  return navigator.mediaDevices.getUserMedia({ audio, video: { mandatory: baseVideo } });
}

// Diagnostic only, for now: a track can go silently "muted" — the driver stops
// delivering frames without ever firing 'ended' or any MediaRecorder error — which
// would explain a webcam recording that looks fine, then freezes mid-take with no
// visible failure anywhere in the pipeline. There's no confirmed fix yet because
// there's no confirmed cause; this logs what actually happens to the track so the
// next repro shows it instead of us guessing again. Check it via chrome://extensions
// → Click & Record → "Inspect views: offscreen.html" → Console.
function logTrackHealth(track, label) {
  if (!track) return;
  const since = () => (rec.startedAt ? `${Date.now() - rec.startedAt}ms into the take` : 'before roll');
  console.info(`[demo-recorder] ${label} track ready, muted=${track.muted}`);
  track.addEventListener('mute', () => console.warn(`[demo-recorder] ${label} track MUTED ${since()} — driver stopped delivering frames`));
  track.addEventListener('unmute', () => console.info(`[demo-recorder] ${label} track unmuted ${since()}`));
  track.addEventListener('ended', () => console.warn(`[demo-recorder] ${label} track ENDED ${since()}`));
}

// requestVideoFrameCallback, not requestAnimationFrame: rAF is tied to compositing and
// is throttled/never fires in a hidden offscreen document (see drawLoop() below), but
// rVFC is driven by the media pipeline itself and fires regardless of visibility — which
// is exactly why it's the right tool to keep something continuously pulling frames here.
// Self-reschedules until videoEl.srcObject is cleared (teardownStreams does that), so it
// naturally stops once the take ends without needing its own cancellation handle.
function pumpVideoFrames(videoEl, label) {
  if (!videoEl.requestVideoFrameCallback) {
    console.warn(`[demo-recorder] requestVideoFrameCallback unavailable, ${label} pipeline may go idle unattended`);
    return;
  }
  const tick = () => {
    if (!videoEl.srcObject) return;
    videoEl.requestVideoFrameCallback(tick);
  };
  videoEl.requestVideoFrameCallback(tick);
}

async function prepareCapture(streamId, options) {
  try {
    return await prepareCaptureInner(streamId, options);
  } catch (err) {
    // Anything opened before the failure has to be handed back. Without this, a throw
    // partway through (a refused audio track, video metadata never arriving) leaves the
    // display stream or the camera held open by this document — which keeps Chrome's
    // sharing indicator and the camera light on for a recording that never started.
    teardownStreams();
    rec = {
      paused: false, chunks: [], pendingStart: null, sessionId: rec.sessionId,
      chunkSeq: 0, webcamChunkSeq: 0, chunkDbPromise: null,
    };
    throw err;
  }
}

async function prepareCaptureInner(streamId, options) {
  rec.paused = false;

  rec.tabStream = await getSourceStream(streamId, options);

  // A window or screen the user picked can vanish mid-take (they close it). Without
  // this the canvas keeps drawing the last frame forever and the file looks frozen
  // rather than finished.
  const [videoTrack] = rec.tabStream.getVideoTracks();
  if (videoTrack) {
    logTrackHealth(videoTrack, 'tab/display');
    videoTrack.addEventListener('ended', () => {
      chrome.runtime.sendMessage({ type: 'SOURCE_ENDED' }).catch(() => {});
    });
  }

  // The webcam is captured here but recorded to its **own** file rather than being
  // drawn onto the screen canvas, which is what lets the editor reposition, resize
  // and restyle the bubble afterwards.
  //
  // This works only because permission is obtained up front by permission.html: an
  // offscreen document has no UI, so Chrome will not show a permission prompt from
  // one and getUserMedia rejects outright. With the grant already in place it opens
  // the device silently.
  if (options.webcam) {
    try {
      rec.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false, // mic is captured below and mixed into the screen recording
      });
      logTrackHealth(rec.webcamStream.getVideoTracks()[0], 'webcam');

      // MediaRecorder below records this stream directly — nothing else ever plays or
      // reads its frames, unlike the tab video (drawn to canvas every tick) or a normal
      // camera use case like a video call (which keeps a live self-view painting the
      // whole time). A track with no active consumer, in a hidden offscreen document, is
      // suspected of letting Chrome's camera pipeline go idle mid-take even though that
      // never shows up as a 'mute' or 'ended' event on the track itself. Keep something
      // actively pulling frames off it purely for the pipeline's own sake.
      rec.webcamVideoEl = document.createElement('video');
      rec.webcamVideoEl.srcObject = rec.webcamStream;
      rec.webcamVideoEl.muted = true;
      // Not awaited: play() settling is not required before pumpVideoFrames() below —
      // its rVFC loop just starts whenever the first frame actually arrives, whenever
      // that is. Awaiting here previously meant a slow-to-settle (or, worse, a never-
      // settling) play() in this hidden document stalled prepareCaptureInner entirely,
      // which stalled OFFSCREEN_PREPARE's response, which left background.js's
      // startRecording() hung and state.phase stuck non-idle forever — so every later
      // "Start Recording" failed with "A recording is already in progress." even though
      // nothing was actually recording. The webcam pump is a best-effort nicety; it must
      // never be able to block the recording it's trying to help.
      rec.webcamVideoEl.play().catch((err) => {
        console.warn('[demo-recorder] webcam warm-up play() failed, continuing anyway', err);
      });
      pumpVideoFrames(rec.webcamVideoEl, 'webcam');
    } catch (err) {
      console.warn('[demo-recorder] webcam unavailable, continuing without it', err);
      rec.webcamStream = null;
      rec.webcamError = `${err.name}: ${err.message}`;
    }
  }

  if (options.mic) {
    try {
      rec.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch (err) {
      console.warn('[demo-recorder] mic unavailable, continuing without it', err);
      rec.micStream = null;
      rec.micError = `${err.name}: ${err.message}`;
    }
  }

  const tabVideoEl = document.createElement('video');
  tabVideoEl.srcObject = rec.tabStream;
  tabVideoEl.muted = true;
  await tabVideoEl.play();
  await waitForVideoMetadata(tabVideoEl);
  rec.tabVideoEl = tabVideoEl;

  const width = tabVideoEl.videoWidth || 1280;
  const height = tabVideoEl.videoHeight || 720;
  rec.canvas = document.createElement('canvas');
  rec.canvas.width = width;
  rec.canvas.height = height;
  rec.ctx = rec.canvas.getContext('2d', { alpha: false });

  drawLoop(tabVideoEl);

  // Audio graph: mix tab audio + mic, and echo tab audio back out so the
  // user doesn't lose sound from their own tab while recording.
  rec.audioCtx = new AudioContext();
  const dest = rec.audioCtx.createMediaStreamDestination();
  let hasAudio = false;

  if (rec.tabStream.getAudioTracks().length) {
    const tabSrc = rec.audioCtx.createMediaStreamSource(
      new MediaStream(rec.tabStream.getAudioTracks())
    );
    tabSrc.connect(dest);
    tabSrc.connect(rec.audioCtx.destination);
    hasAudio = true;
  }
  if (rec.micStream && rec.micStream.getAudioTracks().length) {
    const micSrc = rec.audioCtx.createMediaStreamSource(rec.micStream);
    micSrc.connect(dest);
    hasAudio = true;
  }

  const canvasStream = rec.canvas.captureStream(CAPTURE_FPS);
  const outTracks = [...canvasStream.getVideoTracks()];
  if (hasAudio) outTracks.push(...dest.stream.getAudioTracks());
  const outStream = new MediaStream(outTracks);

  rec.chunks = [];
  rec.mediaRecorder = new MediaRecorder(outStream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: videoBitrateFor(width, height),
    audioBitsPerSecond: 128_000,
  });
  rec.mediaRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    rec.chunks.push(e.data);
    // seq is captured synchronously here (this handler fires as a normal,
    // in-order DOM event) even though the write it kicks off is async and can
    // land late — that's what keeps chunks reassemblable in order regardless.
    const seq = rec.chunkSeq++;
    rec.chunkDbPromise
      ?.then((db) => drAppendChunk(rec.sessionId, 'screen', seq, e.data, db))
      .catch((err) => console.warn('[demo-recorder] chunk append failed', err));
  };
  rec.mediaRecorder.onerror = (e) => {
    console.error('[demo-recorder] screen MediaRecorder error', e.error || e);
  };

  // Second, independent recorder for the webcam — same session, separate file.
  if (rec.webcamStream) {
    rec.webcamRecorder = new MediaRecorder(rec.webcamStream, {
      mimeType: pickMimeType(),
      videoBitsPerSecond: 5_000_000,
    });
    rec.webcamChunks = [];
    rec.webcamRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      rec.webcamChunks.push(e.data);
      const seq = rec.webcamChunkSeq++;
      rec.chunkDbPromise
        ?.then((db) => drAppendChunk(rec.sessionId, 'webcam', seq, e.data, db))
        .catch((err) => console.warn('[demo-recorder] webcam chunk append failed', err));
    };
    rec.webcamRecorder.onerror = (e) => {
      console.error('[demo-recorder] webcam MediaRecorder error', e.error || e);
    };
  }

  // Report what was actually captured. Silently recording without the webcam or
  // mic the user asked for is worse than telling them. Reported from PREPARE, so
  // the popup can warn before the countdown rather than after the take.
  return {
    ok: true,
    gotWebcam: !!rec.webcamStream,
    gotMic: !!rec.micStream,
    webcamError: rec.webcamError || null,
    micError: rec.micError || null,
  };
}

// Rolls tape at the wall-clock instant `startAt`, which background.js has already
// handed to content.js, the QA capture and the popup as the recording's epoch. One
// shared instant is what keeps click timestamps, network entries and the video's
// own clock on the same origin — deriving it separately in each context is how
// zooms end up landing a couple of seconds off.
function beginCapture(startAt) {
  if (!rec.mediaRecorder) return { ok: false, error: 'Nothing is prepared.' };
  if (rec.startedAt) return { ok: true, startedAt: rec.startedAt }; // already rolling

  const roll = () => {
    rec.pendingStart = null;
    if (!rec.mediaRecorder) return; // cancelled while we were waiting
    // Both recorders start in the same tick, so startOffsetMs stays near zero and
    // the editor's webcam alignment has almost nothing to correct for.
    rec.startedAt = Date.now();
    rec.mediaRecorder.start(1000);
    if (rec.webcamRecorder) {
      rec.webcamStartedAt = Date.now();
      rec.webcamRecorder.start(1000);
    }

    // Open the durability connection now and record what a crash-recovery pass
    // would need to reassemble this take, without ever calling stopCapture().
    // Neither is awaited — roll() has to stay synchronous — but the connection
    // promise is stashed so the first ondataavailable (~1s away) has something
    // to chain off rather than racing its own open().
    rec.chunkDbPromise = drOpenDb();
    drSaveChunkMeta(rec.sessionId, {
      width: rec.canvas.width,
      height: rec.canvas.height,
      mimeType: rec.mediaRecorder.mimeType,
      startedAt: rec.startedAt,
      hasWebcam: !!rec.webcamRecorder,
      webcamMimeType: rec.webcamRecorder ? rec.webcamRecorder.mimeType : null,
      webcamStartedAt: rec.webcamRecorder ? rec.webcamStartedAt : null,
    }).catch((err) => console.error('[demo-recorder] chunkMeta write failed', err));

    // Report when tape *actually* started, rather than letting everyone assume it was
    // startAt. A hidden document's timers can fire a couple of hundred milliseconds
    // late, and that difference would show up as every zoom landing behind its click.
    chrome.runtime.sendMessage({ type: 'RECORDER_ROLLING', startedAt: rec.startedAt })
      .catch(() => {});
  };

  const wait = Math.max(0, (startAt || 0) - Date.now());
  if (wait === 0) roll();
  else rec.pendingStart = setTimeout(roll, wait);
  return { ok: true, startAt };
}

function waitForVideoMetadata(videoEl) {
  if (videoEl.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    videoEl.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

// Just the tab now — the webcam bubble is composited in the editor, not here.
//
// Offscreen documents have no visible compositor surface, so requestAnimationFrame
// is throttled/never fires here — and requestVideoFrameCallback rides the same
// compositor pipeline, so it doesn't reliably fire either despite being driven by
// the media pipeline in a normal (visible) document. A version of this loop tried
// rVFC on the theory that it fires "regardless of visibility"; in practice the canvas
// never got drawn to and captureStream() fed MediaRecorder nothing, producing a
// 0-byte recording. setInterval is what actually ticks in this document — use it.
function drawLoop(tabVideoEl) {
  const { ctx, canvas } = rec;

  function frame() {
    if (!rec.paused) ctx.drawImage(tabVideoEl, 0, 0, canvas.width, canvas.height);
  }
  rec.rafId = setInterval(frame, 1000 / CAPTURE_FPS);
}

function waitForRecorderStop(recorder) {
  if (!recorder || recorder.state === 'inactive') return Promise.resolve();
  return new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.stop();
  });
}

async function stopCapture() {
  if (!rec.mediaRecorder) return { ok: false, error: 'Nothing is recording.' };

  // Stopped during the countdown, before the recorders rolled. There is no file to
  // save, so cancel the pending start and tear the streams down — otherwise the
  // camera light stays on and the next recording can't open the device.
  if (!rec.startedAt) {
    if (rec.pendingStart) clearTimeout(rec.pendingStart);
    teardownStreams();
    // roll() never ran, so no chunkMeta/chunks rows exist for this session —
    // nothing to clean up in IndexedDB.
    rec = { paused: false, chunks: [], pendingStart: null, chunkSeq: 0, webcamChunkSeq: 0, chunkDbPromise: null };
    return { ok: false, error: 'Cancelled before recording started — nothing was saved.' };
  }

  const duration = Date.now() - rec.startedAt;
  const width = rec.canvas.width;
  const height = rec.canvas.height;
  const mimeType = rec.mediaRecorder.mimeType;

  // A recorder can already be 'inactive' here without anyone having called stop() —
  // its input track can die mid-take (camera taken by another app, OS revokes access,
  // tab capture drops) and Chrome auto-stops the recorder, firing 'stop' once right
  // then. Attaching the listener unconditionally and waiting for that event would hang
  // forever in that case, since it already fired and won't again — so an
  // already-inactive recorder resolves immediately instead of waiting on it.
  const stopped = waitForRecorderStop(rec.mediaRecorder);

  // Stop the webcam recorder in parallel and save it under the same session id.
  const webcamStopped = waitForRecorderStop(rec.webcamRecorder);

  await Promise.all([stopped, webcamStopped]);

  if (rec.webcamRecorder) {
    const camBlob = new Blob(rec.webcamChunks, { type: rec.webcamRecorder.mimeType });
    if (camBlob.size) {
      try {
        await drSaveWebcam(rec.sessionId, camBlob, {
          mimeType: rec.webcamRecorder.mimeType,
          duration: Date.now() - rec.webcamStartedAt,
          // The two recorders can't start on the same millisecond; the editor needs
          // this delta to line the webcam up against the screen recording.
          startOffsetMs: Math.max(0, rec.webcamStartedAt - rec.startedAt),
        });
      } catch (err) {
        console.error('[demo-recorder] could not save webcam', err);
      }
    }
  }

  teardownStreams();

  const blob = new Blob(rec.chunks, { type: mimeType });
  const sessionId = rec.sessionId;
  const meta = { width, height, duration, mimeType };
  await drSaveRecording(sessionId, blob, meta);

  // The final blob is safely saved — the durable per-chunk copy that existed
  // purely for crash recovery is no longer needed. A failure here must not fail
  // the (already-successful) save; a leftover chunk set just self-heals on
  // background.js's next orphan scan (it'll see a finalized recording already
  // exists and sweep it up silently).
  try {
    const chunkDb = await rec.chunkDbPromise;
    await drDeleteChunks(sessionId);
    await drDeleteChunkMeta(sessionId);
    chunkDb?.close();
  } catch (err) {
    console.warn('[demo-recorder] chunk cleanup failed (self-heals later)', err);
  }

  rec = { paused: false, chunks: [], pendingStart: null, chunkSeq: 0, webcamChunkSeq: 0, chunkDbPromise: null };

  return { ok: true, sessionId, meta };
}

// Shared by the normal stop and the cancelled-during-countdown path: every stream
// released and the draw loop cleared, so no device is left held open.
function teardownStreams() {
  if (rec.rafId) clearInterval(rec.rafId);
  // Clears srcObject first so pumpVideoFrames's rVFC loop sees it and stops
  // rescheduling itself, rather than firing once more against a dead element.
  // drawLoop's own setInterval is already cleared above.
  if (rec.tabVideoEl) rec.tabVideoEl.srcObject = null;
  if (rec.webcamVideoEl) rec.webcamVideoEl.srcObject = null;
  [rec.tabStream, rec.webcamStream, rec.micStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
  if (rec.audioCtx) rec.audioCtx.close().catch(() => {});
}
