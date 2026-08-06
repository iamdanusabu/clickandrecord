// Post-recording editor. Loads the raw composited recording (screen +
// webcam bubble, already baked in) from IndexedDB, lets the user trim it,
// turn logged clicks into zoom-in keyframes, and append extra video clips.
// Export re-plays the whole composition in real time onto an offscreen
// canvas and records that with MediaRecorder — no ffmpeg/WebCodecs needed.

const qs = new URLSearchParams(location.search);
const sessionId = qs.get('session');

// Flip to true once Drive is ready for outside users — the OAuth consent screen
// is still unverified during beta, so the button stays visible but inert.
const DRIVE_ENABLED = false;

const canvas = document.getElementById('preview-canvas');
const ctx = canvas.getContext('2d', { alpha: false });

// Sources are the decoded videos; segments are the ordered pieces of the output
// timeline. Splitting a clip makes two segments that share one source — which is
// why these are separate lists. Zoom keyframes and clicks live in *source* time,
// so splitting, reordering or changing speed never moves a zoom.
const project = {
  sources: [],  // { id, kind: 'recording'|'file', name, videoEl, url, blob, file,
                //   duration, crop, thumbs, peaks }
  segments: [], // { id, sourceId, in, out, speed, webcam }
  clicks: [],
  // Typing-burst intervals ({ start, end }, recording-source ms) — used only to
  // extend an auto-zoom's hold through a burst it overlaps. Never rendered, never
  // exported: this is timing metadata, not content.
  typing: [],
  zoomKeyframes: [],
  // Separate webcam track, composited here rather than burned into the recording:
  // { videoEl, url, duration, startOffsetMs }. Null for recordings made before the
  // webcam was split out, which have the bubble fixed in the pixels.
  webcam: null,
  // Subtitle cues in *recording-source* ms, like clicks and zooms, so trimming,
  // splitting and speed changes never move them:
  // { id, t, endT, text, words: [{ t, endT, text }] }
  captions: [],
};

// Subtitle styling. Fractions of canvas size, so preview and export match.
const captionStyle = {
  enabled: true,
  fontSize: 0.045,      // of canvas height
  color: '#ffffff',
  style: 'box',         // 'box' | 'outline' | 'shadow'
  boxColor: '#000000',
  boxOpacity: 0.72,
  // Centre of the caption block, freely draggable — like webcamStyle.x/y below.
  // Defaults approximate the old fixed 'bottom' position (a margin-from-edge
  // anchor) for a typical one-line cue.
  x: 0.5,
  y: 0.91,
  maxWidthFrac: 0.8,
  wordHighlight: false,
  highlightColor: '#ffd23f',
};

// Bubble layout. Fractions of the content rect (like `stage`), so the preview and
// the export agree.
const webcamStyle = {
  enabled: true,
  x: 0.86,
  y: 0.82,
  size: 0.22,      // of the content rect's smaller side, at rest (no zoom active)
  // The bubble's size during a full-strength zoom (see bubbleShrinkAmount below) — a
  // full-size bubble sitting over a zoomed-in screen reads as too large for the frame.
  // Setting this equal to size effectively turns the shrink off, so that's the "off"
  // state rather than a separate toggle.
  minSize: 0.14,
  shape: 'circle', // 'circle' | 'rounded'
  border: true,
  shadow: true,
  mirror: true,
};

// Solid bands over the top and/or bottom of the video content — for redacting a
// taskbar, notification area, or anything else that shouldn't be in frame.
// top/bottom are fractions of the content rect's height, like crop; 0 means off.
// feather is a fraction *of the band itself* (0-1), not of the content rect — at 0
// the band is a hard-edged block; at 1 the whole band is a gradient with no solid
// core at all. Default is well past halfway so a freshly-enabled mask already
// reads as a soft dissolve rather than a harder-edged block.
const maskStyle = {
  top: 0,
  bottom: 0,
  feather: 0.5,
  color: '#000000',
};

const playhead = { segIndex: 0, localMs: 0 };
let playing = false;
let rafId = null;
let selectedKeyframeId = null;
let selectedSegmentId = null;
let nextSourceId = 1;
let nextSegmentId = 1;
let nextKeyframeId = 1;

const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 4];
const MIN_SEGMENT_MS = 200;

// The recording's own dimensions, so "Source" can be restored after switching
// output aspect.
let baseOutputSize = { w: 1280, h: 720 };
let cropping = false;
let maskAdjusting = false;

const editorAudioCtx = new AudioContext();
const audioGainByVideo = new WeakMap();

const THUMB_COUNT = 14;
const THUMB_W = 96;
const THUMB_H = 54;
const PEAK_BUCKETS = 300;
const SNAP_PX = 8;

// Zoom defaults. A gentle scale reads better than a dramatic one — the point
// is to draw the eye to where the click happened, not to fill the frame.
// The zoom starts slightly *before* the click so the viewer is already
// looking at the right place when it lands.
const ZOOM_SCALE = 1.5;
// Ceiling of the per-keyframe zoom slider (see the .kf-scale range below) — also
// what the webcam bubble's shrink-on-zoom is normalized against, so "fully shrunk"
// lines up with "as zoomed in as a keyframe can go."
const KEYFRAME_MAX_ZOOM = 2.5;
// How long a new zoom holds at full scale before easing back out. Bumped up from
// 1200 — 1.2s read as too quick to actually take in what got zoomed into before it
// let go again. Per-zoom Hold slider (.kf-duration) still overrides this for anyone
// who wants a particular zoom shorter or longer, and durationForClick() below
// overrides it automatically when a typing burst follows the click.
const ZOOM_HOLD_MS = 1800;
// Ceiling of the per-keyframe Hold slider. Well above ZOOM_HOLD_MS because
// durationForClick() can push a click-derived zoom's duration past the default to
// cover an entire typing burst — this has to comfortably fit a long one.
const KEYFRAME_MAX_HOLD_MS = 20000;
const ZOOM_LEAD_IN_MS = 250;
const ZOOM_EASE_MS = 500;
// Two zooms link into a pan — camera slides between them while staying magnified —
// instead of resetting to full frame and zooming back in, when the gap between them
// is short enough to read as "still looking at roughly the same place" rather than
// two separate moments. 700 (the original value) was tuned for a fast double-click,
// not for how people actually click through a UI: clicking one button, registering
// what happened, then clicking the next one is routinely 1-2+ seconds even when the
// two things are right next to each other, so it almost never linked and every
// click read as its own zoom-out-then-in. Two clicks close together *in space* get
// a longer allowance, since a slow pan between neighbours still reads as one
// continuous look; two clicks far apart only link if they're genuinely rapid, since
// a fast pan clear across the frame reads as its own jarring moment, not a
// continuation.
const ZOOM_LINK_GAP_MS = 1500;
const ZOOM_LINK_NEAR_DIST = 0.2; // fraction of the frame's diagonal — "right next to it"
const ZOOM_LINK_NEAR_BONUS_MS = 1500;

// Whether zoom `a` (which ends first) should link into a pan with zoom `b`.
function zoomsShouldLink(a, b) {
  const gap = b.t - (a.t + a.duration);
  if (gap <= 0) return true; // already overlapping — nothing sane to reset between
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const allowance = ZOOM_LINK_GAP_MS + (dist < ZOOM_LINK_NEAR_DIST ? ZOOM_LINK_NEAR_BONUS_MS : 0);
  return gap < allowance;
}

let clipViews = [];
let dragging = null; // { view, side }

const BG_PRESETS = [
  { id: 'aurora', name: 'Aurora', stops: ['#4c1d95', '#2563eb', '#0891b2'] },
  { id: 'sunset', name: 'Sunset', stops: ['#f97316', '#db2777', '#7c3aed'] },
  { id: 'mint', name: 'Mint', stops: ['#065f46', '#0891b2'] },
  { id: 'dusk', name: 'Dusk', stops: ['#1e1b4b', '#831843'] },
  { id: 'slate', name: 'Slate', stops: ['#334155', '#0f172a'] },
  { id: 'black', name: 'Black', stops: ['#000000'] },
];

// Mock browser/window chrome drawn above the recording. `chrome` is the title-bar
// height as a fraction of the canvas's smaller dimension.
const FRAME_PRESETS = [
  { id: 'none', name: 'None', chrome: 0 },
  { id: 'window', name: 'Window', chrome: 0.034, lights: 'mac' },
  { id: 'browser-mac', name: 'Browser · macOS', chrome: 0.056, lights: 'mac', urlBar: true },
  { id: 'browser-win', name: 'Browser · Windows', chrome: 0.056, lights: 'win', urlBar: true },
];

// How the recording is framed on the canvas. Fractions of the canvas's smaller
// dimension rather than pixels, so preview and export render identically.
const stage = {
  presetId: 'aurora',
  image: null,
  imageUrl: null,
  padding: 0.05,
  radius: 0.018,
  shadow: true,
  frameId: 'none',
  frameLight: false,
  frameLabel: '',
  trimBars: true,
};

// ---------- undo / redo ----------
//
// One snapshot before each edit that changes something a person would want to take
// back: split, delete, trim, speed, zoom keyframes, captions, per-clip webcam
// visibility. Global style preferences (background, frame, webcam bubble look, mask,
// caption look) are deliberately not covered — those are settings being tuned, not
// content being lost, and covering every slider in the rail would be a much bigger
// feature than "let me undo a split."
//
// project.sources is the one field kept as a shallow copy rather than deep-cloned:
// its entries hold a live <video> element and Blob, which can't be cloned and don't
// need to be — undoing never needs a *different* video, only a different edit of it.

const UNDO_LIMIT = 100;
let undoStack = [];
let redoStack = [];
let restoringHistory = false; // true while undo()/redo() itself applies a snapshot

function snapshotState() {
  return {
    sources: [...project.sources],
    segments: structuredClone(project.segments),
    zoomKeyframes: structuredClone(project.zoomKeyframes),
    captions: structuredClone(project.captions),
    selectedSegmentId,
    selectedKeyframeId,
  };
}

function restoreSnapshot(snap) {
  project.sources = snap.sources;
  project.segments = snap.segments;
  project.zoomKeyframes = snap.zoomKeyframes;
  project.captions = snap.captions;
  selectedSegmentId = snap.selectedSegmentId;
  selectedKeyframeId = snap.selectedKeyframeId;

  invalidateCamera();
  pause();

  // Clamped *before* reading the segment at that index — project.segments may now be
  // shorter (undoing a split, say), and getCurrentSegment() on a stale, now-out-of-
  // bounds index returns null, silently skipping the resync below and leaving the
  // playhead pointing past the end of the restored timeline.
  playhead.segIndex = Math.min(playhead.segIndex, project.segments.length - 1);
  const cur = getCurrentSegment();
  if (cur) {
    playhead.localMs = Math.min(Math.max(playhead.localMs, cur.seg.in), cur.seg.out);
    seekTo(cur.src.videoEl, playhead.localMs / 1000).then(() => {
      resyncPlayheadToActualFrame(cur.src);
      renderFrame();
    });
  }

  layoutTimeline();
  renderTimeline();
  renderClipPanel();
  renderZoomSettings();
  renderCaptionList();
  renderCaptionLane();
  renderFrame();
}

// Call before any mutation that should be undoable — snapshots the state as it
// stood *before* the edit that's about to happen.
function pushHistory() {
  if (restoringHistory) return;
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = []; // a fresh edit abandons whatever branch redo would have reached
  updateUndoRedoButtons();
}

function undo() {
  if (!undoStack.length) { setStatus('Nothing to undo'); return; }
  redoStack.push(snapshotState());
  const snap = undoStack.pop();
  restoringHistory = true;
  restoreSnapshot(snap);
  restoringHistory = false;
  updateUndoRedoButtons();
  setStatus('Undid last edit');
}

function redo() {
  if (!redoStack.length) { setStatus('Nothing to redo'); return; }
  undoStack.push(snapshotState());
  const snap = redoStack.pop();
  restoringHistory = true;
  restoreSnapshot(snap);
  restoringHistory = false;
  updateUndoRedoButtons();
  setStatus('Redid edit');
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

window.addEventListener('error', (e) => setStatus(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => {
  setStatus(`Error: ${(e.reason && e.reason.message) || e.reason}`);
});

// init() is kicked off at the *bottom* of this file, not here: it calls
// loadSession() synchronously, which reads const bindings declared further down.
// Function declarations hoist; const declarations don't.

async function init() {
  if (!DRIVE_ENABLED) {
    const driveBtn = document.getElementById('btn-drive');
    driveBtn.disabled = true;
    driveBtn.title = 'Save to Drive is disabled during beta.';
  }

  // No session means the editor was opened on its own rather than from a capture.
  // That is a supported way in, not an error.
  if (!sessionId) return initStandalone();

  setStatus('Loading recording…');
  const rec = await loadSession(sessionId);
  if (!rec) return setStatus('Recording not found (it may have been cleared from storage).');
  if (!rec.blob || !rec.blob.size) return setStatus('Recording is empty (0 bytes) — the capture failed.');

  const clicks = rec.clicks;

  setStatus('Decoding video…');
  const url = URL.createObjectURL(rec.blob);
  const videoEl = document.createElement('video');
  videoEl.src = url;
  videoEl.preload = 'auto';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Video stalled — readyState=${videoEl.readyState} networkState=${videoEl.networkState} blobSize=${rec.blob.size}`));
    }, 6000);
    videoEl.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once: true });
    videoEl.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error(`Video decode failed: code=${videoEl.error && videoEl.error.code} ${videoEl.error && videoEl.error.message}`));
    }, { once: true });
  });
  attachAudioGraph(videoEl);

  canvas.width = rec.meta.width || videoEl.videoWidth || 1280;
  canvas.height = rec.meta.height || videoEl.videoHeight || 720;

  const durationMs = await resolveDurationMs(videoEl, rec.meta.duration || 0);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return setStatus('Could not determine the recording length.');
  }
  const source = {
    id: nextSourceId++,
    kind: 'recording',
    name: 'Screen Recording',
    videoEl,
    url,
    blob: rec.blob,
    duration: durationMs,
    crop: null,
    thumbs: null,
    peaks: null,
  };
  project.sources.push(source);
  project.segments.push({
    id: nextSegmentId++,
    sourceId: source.id,
    in: 0,
    out: durationMs,
    speed: 1,
  });
  project.clicks = clicks;
  // Set before autoApplyZooms() below — it reads project.typing to decide how long
  // each auto-generated zoom should hold.
  project.typing = rec.typing || [];
  selectedSegmentId = project.segments[0].id;

  baseOutputSize = { w: canvas.width, h: canvas.height };

  source.crop = await detectLetterbox(videoEl, durationMs);
  if (source.crop) {
    document.getElementById('trim-bars-wrap').hidden = false;
  }

  autoApplyZooms();

  // Prefill the mock URL bar with the page that was recorded. It's an editable
  // field precisely because an internal URL is often something you'd rather not
  // publish in a demo.
  stage.frameLabel = prettyUrl(rec.pageUrl);
  document.getElementById('frame-label').value = stage.frameLabel;

  initRecordingName(rec);

  await seekTo(videoEl, 0);
  renderTimeline();
  renderClipPanel();
  renderFrame();
  const zoomCount = project.zoomKeyframes.length;
  setStatus(clicks.length
    ? `${clicks.length} click${clicks.length === 1 ? '' : 's'} detected — ${zoomCount} zoom${zoomCount === 1 ? '' : 's'} applied`
    : 'Ready to edit — no clicks were detected in this recording');

  generateThumbnails(source).catch((err) => console.warn('[editor] thumbnails failed', err));
  generateWaveform(source).catch((err) => console.warn('[editor] waveform failed', err));

  // Restore any previously generated or hand-corrected subtitles.
  const savedCues = await loadCaptions(sessionId);
  if (savedCues && savedCues.length) {
    project.captions = savedCues;
    // Continue the manual-id sequence past anything already saved, or reopening the
    // editor and adding a cue would mint an id that collides with an existing row.
    savedCues.forEach((c) => {
      const n = /^cue-manual-(\d+)$/.exec(c.id || '');
      if (n) nextManualCueId = Math.max(nextManualCueId, Number(n[1]) + 1);
    });
    renderCaptionList();
    renderCaptionLane();
    renderFrame();
  } else {
    renderCaptionList();
  }

  // Both are optional extras — don't let either block the editor being usable.
  initWebcam(sessionId).catch((err) => console.warn('[editor] webcam failed', err));
  initDebugPanel(await loadLogs(sessionId));
}

function setStatus(text) {
  document.getElementById('status-text').textContent = text;
}

// ---------- recording name ----------
//
// Names the exported video, the .srt/.vtt sidecars and the Drive upload. Kept in
// localStorage keyed by session rather than in IndexedDB: the alternative was a schema
// version bump plus a bridge round-trip for one short string. The cost of that choice is
// that the name is per-origin, so a recording opened from the bundled editor and the same
// one opened from a hosted editor each remember their own — acceptable, since which
// editor opens is a fixed setting rather than something that varies take to take.

const NAME_KEY_PREFIX = 'demoRecorder.name.';
let recordingName = '';

const SOURCE_LABELS = {
  window: 'Window recording',
  screen: 'Screen recording',
  tab: 'Tab recording',
};

// "2026-07-28 14:32" — sorts correctly in a downloads folder, and reads as a time rather
// than as an id.
function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

function defaultRecordingName(rec) {
  // The page title is the most useful thing available for a tab recording — it's what the
  // demo is *of*. Trim Chrome's usual noise off it.
  const title = (rec.pageTitle || '').replace(/\s*[-–—|·]\s*(Google Chrome|Chrome)$/i, '').trim();
  if (rec.source === 'tab' && title) return title.slice(0, 80);
  return `${SOURCE_LABELS[rec.source] || SOURCE_LABELS.tab} ${stampNow()}`;
}

function initRecordingName(rec) {
  const input = document.getElementById('recording-name');
  let saved = null;
  try {
    if (sessionId) saved = localStorage.getItem(NAME_KEY_PREFIX + sessionId);
  } catch (_) {
    // storage blocked — fall through to the derived default
  }
  recordingName = saved || defaultRecordingName(rec);
  input.value = recordingName;

  const commit = () => {
    const next = input.value.trim();
    // Empty means "go back to the default" rather than a nameless file.
    recordingName = next || defaultRecordingName(rec);
    input.value = recordingName;
    try {
      if (sessionId) localStorage.setItem(NAME_KEY_PREFIX + sessionId, recordingName);
    } catch (_) {
      // storage blocked — the name still applies for this session
    }
  };

  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = recordingName; input.blur(); }
  });
}

// Turns the name into something every filesystem accepts, without mangling it beyond
// recognition. Windows is the strict one: <>:"/\|?* are forbidden outright, as are
// trailing dots and spaces.
function fileNameFor(extension) {
  const cleaned = (recordingName || 'recording')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 100);
  return `${cleaned || 'recording'}.${extension}`;
}

// ---------- loading the recording ----------
//
// The same page is served two ways: from chrome-extension:// (where it can read
// the extension's IndexedDB itself) and from the hosted origin (where it can't,
// and asks the extension's bridge iframe for the data instead). Everything
// downstream of here is identical either way.

const IS_EXTENSION_ORIGIN = location.protocol === 'chrome-extension:';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.addEventListener('load', resolve, { once: true });
    el.addEventListener('error', () => reject(new Error(`could not load ${src}`)), { once: true });
    document.head.appendChild(el);
  });
}

async function loadSession(id) {
  if (IS_EXTENSION_ORIGIN) {
    if (typeof drLoadRecording !== 'function') await loadScript('../db.js');
    const rec = await drLoadRecording(id);
    if (!rec) return null;
    const stored = await chrome.storage.session.get(`session:${id}`);
    const info = stored[`session:${id}`] || {};
    return {
      blob: rec.blob,
      meta: rec.meta || {},
      clicks: info.clicks || [],
      typing: info.typing || [],
      pageUrl: info.pageUrl || '',
      pageTitle: info.pageTitle || '',
      source: info.source || 'tab',
    };
  }
  return loadViaBridge(id);
}

function loadViaBridge(id) {
  return bridgeRequest({ type: 'DR_REQUEST_RECORDING', sessionId: id }, 'DR_RECORDING')
    .then((msg) => ({
      blob: msg.blob,
      meta: msg.meta || {},
      clicks: msg.clicks || [],
      typing: msg.typing || [],
      pageUrl: msg.pageUrl || '',
      pageTitle: msg.pageTitle || '',
      source: msg.source || 'tab',
    }));
}

// One round-trip to the extension's bridge iframe: spin one up, wait for it to
// announce itself, send `request`, resolve on `expectType`.
function bridgeRequest(request, expectType, timeoutMs = 20000) {
  const extId = qs.get('ext');
  if (!extId) {
    return Promise.reject(new Error('This page needs an ?ext= extension id to reach your recording.'));
  }
  const bridgeOrigin = `chrome-extension://${extId}`;

  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.src = `${bridgeOrigin}/bridge.html`;

    const settle = (err, value) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => settle(new Error(
      'The Click & Record extension did not respond. Is it installed, and is this origin in its allowlist?'
    )), timeoutMs);

    function onMessage(event) {
      if (event.origin !== bridgeOrigin || event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'DR_BRIDGE_READY') {
        iframe.contentWindow.postMessage(request, bridgeOrigin);
      } else if (msg.type === expectType) {
        settle(null, msg);
      } else if (msg.type === 'DR_ERROR') {
        settle(new Error(msg.error));
      }
    }

    window.addEventListener('message', onMessage);
    iframe.addEventListener('error', () => settle(new Error('Could not load the extension bridge.')), { once: true });
    document.body.appendChild(iframe);
  });
}

async function loadWebcam(id) {
  try {
    if (IS_EXTENSION_ORIGIN) {
      if (typeof drLoadWebcam !== 'function') await loadScript('../db.js');
      const rec = await drLoadWebcam(id);
      return rec ? { blob: rec.blob, meta: rec.meta || {} } : null;
    }
    const msg = await bridgeRequest({ type: 'DR_REQUEST_WEBCAM', sessionId: id }, 'DR_WEBCAM');
    return msg.blob ? { blob: msg.blob, meta: msg.meta || {} } : null;
  } catch (err) {
    console.warn('[editor] could not load webcam track', err);
    return null;
  }
}

// Builds the webcam video element. Kept out of `project.sources` on purpose: it's
// an overlay spanning the whole session, not a segment on the timeline.
async function initWebcam(id) {
  const rec = await loadWebcam(id);
  if (!rec || !rec.blob || !rec.blob.size) return;

  const url = URL.createObjectURL(rec.blob);
  const videoEl = document.createElement('video');
  videoEl.src = url;
  videoEl.preload = 'auto';
  videoEl.muted = true; // video-only capture, but be explicit
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('webcam video stalled')), 8000);
      videoEl.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
      videoEl.addEventListener('error', () => { clearTimeout(timer); reject(new Error('webcam decode failed')); }, { once: true });
    });
  } catch (err) {
    console.warn('[editor]', err);
    URL.revokeObjectURL(url);
    return;
  }

  project.webcam = {
    videoEl,
    url,
    duration: await resolveDurationMs(videoEl, rec.meta.duration || 0),
    startOffsetMs: rec.meta.startOffsetMs || 0,
  };
  await seekTo(videoEl, 0);
  document.getElementById('webcam-row').hidden = false;
  renderWebcamControls();
  renderClipPanel();
  renderFrame();
}

async function loadLogs(id) {
  try {
    if (IS_EXTENSION_ORIGIN) {
      if (typeof drLoadLogs !== 'function') await loadScript('../db.js');
      return await drLoadLogs(id);
    }
    const msg = await bridgeRequest({ type: 'DR_REQUEST_LOGS', sessionId: id }, 'DR_LOGS');
    return msg.logs || null;
  } catch (err) {
    console.warn('[editor] could not load capture', err);
    return null;
  }
}

// ---------- audio graph ----------

function attachAudioGraph(videoEl) {
  videoEl.muted = false;
  const src = editorAudioCtx.createMediaElementSource(videoEl);
  const gain = editorAudioCtx.createGain();
  src.connect(gain);
  gain.connect(editorAudioCtx.destination);
  audioGainByVideo.set(videoEl, gain);
}

// Export taps the audio graph *and* silences the speakers.
//
// Each source's gain node is wired to editorAudioCtx.destination so you can hear the
// video while editing. Adding the export destination without removing that left the
// recording audible during the render — a video the user isn't watching, talking over the
// top of them for the length of the export. The speaker connection has to come out for
// the duration and go back afterwards.
function connectForExport(videoEl, dest) {
  const gain = audioGainByVideo.get(videoEl);
  if (!gain) return;
  gain.connect(dest);
  try {
    gain.disconnect(editorAudioCtx.destination);
  } catch (_) {
    // never connected (a source with no audio track) — nothing to silence
  }
}

function disconnectForExport(videoEl, dest) {
  const gain = audioGainByVideo.get(videoEl);
  if (!gain) return;
  try { gain.disconnect(dest); } catch (_) {}
  // Duplicate connections are ignored by the Web Audio graph, so this is safe to call
  // even if monitoring was never removed.
  try { gain.connect(editorAudioCtx.destination); } catch (_) {}
}

// ---------- segment helpers ----------

function isLoaded() { return project.segments.length > 0; }

function sourceById(id) { return project.sources.find((s) => s.id === id) || null; }

function recordingSource() {
  return project.sources.find((s) => s.kind === 'recording') || null;
}

function segmentCount() { return project.segments.length; }

function getSegmentByIndex(i) {
  const seg = project.segments[i];
  if (!seg) return null;
  const src = sourceById(seg.sourceId);
  if (!src) return null;
  return { seg, src, type: src.kind, index: i };
}

function getCurrentSegment() { return getSegmentByIndex(playhead.segIndex); }

function getSelectedSegment() {
  const i = project.segments.findIndex((s) => s.id === selectedSegmentId);
  return i < 0 ? null : getSegmentByIndex(i);
}

function speedOf(seg) { return seg.speed || 1; }

// A segment's length in the *output*, which speed changes. Source-time spans and
// output-time spans differ by this factor everywhere below.
function segOutputMs(seg) { return (seg.out - seg.in) / speedOf(seg); }

function totalOutputDurationMs() {
  return project.segments.reduce((total, seg) => total + segOutputMs(seg), 0);
}

function segmentOffsetMs(index) {
  let offset = 0;
  for (let i = 0; i < index && i < project.segments.length; i += 1) {
    offset += segOutputMs(project.segments[i]);
  }
  return offset;
}

function currentOutputElapsedMs() {
  const cur = getCurrentSegment();
  if (!cur) return 0;
  const intoSegment = Math.max(0, playhead.localMs - cur.seg.in) / speedOf(cur.seg);
  return segmentOffsetMs(playhead.segIndex) + intoSegment;
}

// Source time within the recording -> position in the output timeline. Used to
// place click markers and to jump from a captured network/console row to the
// moment it happened. Returns null if that source time was trimmed away.
function recordingTimeToGlobal(sourceMs) {
  for (let i = 0; i < project.segments.length; i += 1) {
    const info = getSegmentByIndex(i);
    if (!info || info.type !== 'recording') continue;
    if (sourceMs >= info.seg.in && sourceMs <= info.seg.out) {
      return segmentOffsetMs(i) + (sourceMs - info.seg.in) / speedOf(info.seg);
    }
  }
  return null;
}

// MediaRecorder-produced WebM has no duration in its header, so
// videoEl.duration reads back as Infinity. Force Chrome to compute the real
// duration by seeking far past the end, and fall back to the wall-clock
// duration the recorder stored in meta if even that fails.
async function resolveDurationMs(videoEl, fallbackMs) {
  if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
    return videoEl.duration * 1000;
  }
  await new Promise((resolve) => {
    const done = () => { videoEl.removeEventListener('timeupdate', onTimeUpdate); resolve(); };
    const onTimeUpdate = () => { if (Number.isFinite(videoEl.duration)) done(); };
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    setTimeout(done, 3000);
    videoEl.currentTime = 1e7;
  });
  if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
    return videoEl.duration * 1000;
  }
  return fallbackMs;
}

function seekTo(videoEl, seconds) {
  return new Promise((resolve) => {
    const onSeeked = () => { videoEl.removeEventListener('seeked', onSeeked); resolve(); };
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = seconds;
  });
}

// Same as seekTo, but gives up rather than hanging forever — WebM without a
// duration header can refuse some seeks, and thumbnail generation must never
// stall on one frame.
function seekToOrGiveUp(videoEl, seconds, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      videoEl.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve(ok);
    };
    const onSeeked = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = seconds;
  });
}

// Which segment a position in the output timeline falls in, and where inside its
// source that lands. Shared by click-to-seek and by scrubbing.
function resolveGlobal(globalMs) {
  if (!isLoaded()) return null;
  const total = totalOutputDurationMs();
  let remaining = Math.min(Math.max(0, globalMs), total);
  for (let i = 0; i < project.segments.length; i += 1) {
    const info = getSegmentByIndex(i);
    const outSpan = segOutputMs(info.seg);
    if (remaining <= outSpan || i === project.segments.length - 1) {
      // Output time -> source time: multiply back by speed.
      const localMs = info.seg.in + Math.min(remaining, outSpan) * speedOf(info.seg);
      return { ...info, index: i, localMs };
    }
    remaining -= outSpan;
  }
  return null;
}

function seekToGlobalElapsed(globalMs) {
  const target = resolveGlobal(globalMs);
  if (!target) return;
  pause();
  playhead.segIndex = target.index;
  playhead.localMs = target.localMs;
  syncWebcamSeek(target.localMs);
  seekTo(target.src.videoEl, target.localMs / 1000).then(() => {
    resyncPlayheadToActualFrame(target.src);
    renderFrame();
  });
}

// ---------- camera ----------
//
// Zoom keyframes are compiled into a single continuous camera track: a list of
// (time, scale, centre) nodes that the renderer interpolates between. Doing it
// this way — rather than evaluating each keyframe in isolation — is what makes
// the motion smooth: consecutive zooms can be *linked* so the camera pans from
// one to the next while staying magnified, and every transition is eased, so
// scale and centre are continuous across the whole timeline.

let cameraTrack = null;

function invalidateCamera() { cameraTrack = null; }

// Smootherstep — zero first *and* second derivative at both ends, so moves
// start and stop without the visible "kick" plain ease-in-out leaves behind.
function smootherstep(p) {
  const c = Math.min(1, Math.max(0, p));
  return c * c * c * (c * (6 * c - 15) + 10);
}

function buildCameraTrack() {
  const kfs = [...project.zoomKeyframes].sort((a, b) => a.t - b.t);
  const nodes = [];

  kfs.forEach((kf, i) => {
    const ease = Math.min(ZOOM_EASE_MS, kf.duration / 2);
    const end = kf.t + kf.duration;
    const prev = kfs[i - 1];
    const next = kfs[i + 1];
    const linkedFromPrev = prev && zoomsShouldLink(prev, kf);
    const linkedToNext = next && zoomsShouldLink(kf, next);

    // Ramp in from full-frame, unless we're already magnified from the
    // previous zoom — then the gap becomes a pan instead.
    if (!linkedFromPrev) nodes.push({ t: kf.t, s: 1, x: kf.x, y: kf.y });
    nodes.push({ t: kf.t + ease, s: kf.scale, x: kf.x, y: kf.y });
    nodes.push({ t: Math.max(kf.t + ease, end - ease), s: kf.scale, x: kf.x, y: kf.y });
    if (!linkedToNext) nodes.push({ t: end, s: 1, x: kf.x, y: kf.y });
  });

  // Overlapping user-tuned durations can push a node before its predecessor;
  // interpolation needs times to be non-decreasing.
  for (let i = 1; i < nodes.length; i += 1) {
    if (nodes[i].t < nodes[i - 1].t) nodes[i].t = nodes[i - 1].t;
  }
  return nodes;
}

function getCamera(tMs) {
  if (!cameraTrack) cameraTrack = buildCameraTrack();
  const nodes = cameraTrack;
  if (nodes.length < 2) return null;
  if (tMs <= nodes[0].t || tMs >= nodes[nodes.length - 1].t) return null;

  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (tMs < a.t || tMs > b.t) continue;
    const span = b.t - a.t;
    const p = span > 0 ? smootherstep((tMs - a.t) / span) : 1;
    return {
      scale: a.s + (b.s - a.s) * p,
      x: a.x + (b.x - a.x) * p,
      y: a.y + (b.y - a.y) * p,
    };
  }
  return null;
}

// Fills w×h completely, cropping overflow — for backgrounds, where letterbox
// bars would defeat the point.
function drawCover(targetCtx, source, w, h) {
  const sw = source.naturalWidth || source.videoWidth || w;
  const sh = source.naturalHeight || source.videoHeight || h;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  targetCtx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function roundRectPath(targetCtx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  targetCtx.beginPath();
  if (targetCtx.roundRect) {
    targetCtx.roundRect(x, y, w, h, radius);
    return;
  }
  targetCtx.moveTo(x + radius, y);
  targetCtx.arcTo(x + w, y, x + w, y + h, radius);
  targetCtx.arcTo(x + w, y + h, x, y + h, radius);
  targetCtx.arcTo(x, y + h, x, y, radius);
  targetCtx.arcTo(x, y, x + w, y, radius);
  targetCtx.closePath();
}

function drawBackground(targetCtx, w, h) {
  if (stage.image) {
    drawCover(targetCtx, stage.image, w, h);
    return;
  }
  const preset = BG_PRESETS.find((p) => p.id === stage.presetId) || BG_PRESETS[0];
  if (preset.stops.length === 1) {
    targetCtx.fillStyle = preset.stops[0];
  } else {
    const grad = targetCtx.createLinearGradient(0, 0, w, h);
    preset.stops.forEach((color, i) => {
      grad.addColorStop(i / (preset.stops.length - 1), color);
    });
    targetCtx.fillStyle = grad;
  }
  targetCtx.fillRect(0, 0, w, h);
}

// ---------- letterbox detection ----------
//
// chrome.tabCapture can hand back a stream whose aspect ratio doesn't match the
// tab, in which case Chrome bakes black bars into the recording. Newer recordings
// request the tab's real size (see offscreen.js), but existing ones still have
// the bars, so find and crop them.
//
// Cropping also makes click-zoom targeting correct: click coordinates are
// normalised against the page viewport, so any black padding shifts every zoom
// target off by the height of the bars.

const LETTERBOX_LUMA = 18;      // 0-255; above this a row counts as content
const LETTERBOX_MAX_FRACTION = 0.4; // refuse implausible crops

async function detectLetterbox(videoEl, durationMs) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;

  const pw = Math.min(64, vw); // a few columns is plenty to classify a row
  const probe = document.createElement('canvas');
  probe.width = pw;
  probe.height = vh;
  const pctx = probe.getContext('2d', { willReadFrequently: true });

  let result = null;
  // Sample several frames and keep the *smallest* crop: a legitimately dark frame
  // would otherwise look like an enormous letterbox and eat real content.
  for (const frac of [0.25, 0.5, 0.75]) {
    const ok = await seekToOrGiveUp(videoEl, (durationMs * frac) / 1000);
    if (!ok) continue;
    pctx.drawImage(videoEl, 0, 0, pw, vh);
    const { data } = pctx.getImageData(0, 0, pw, vh);

    const rowIsDark = (y) => {
      for (let x = 0; x < pw; x += 1) {
        const i = (y * pw + x) * 4;
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (luma > LETTERBOX_LUMA) return false;
      }
      return true;
    };

    let top = 0;
    while (top < vh && rowIsDark(top)) top += 1;
    if (top >= vh) continue; // entirely black frame — tells us nothing
    let bottom = 0;
    while (bottom < vh - top && rowIsDark(vh - 1 - bottom)) bottom += 1;

    result = result
      ? { top: Math.min(result.top, top), bottom: Math.min(result.bottom, bottom) }
      : { top, bottom };
  }

  if (!result) return null;
  if (result.top + result.bottom < 2) return null;
  if (result.top + result.bottom > vh * LETTERBOX_MAX_FRACTION) return null;
  return { top: result.top / vh, bottom: result.bottom / vh, left: 0, right: 0 };
}

// The region of the source video actually drawn, after cropping.
function sourceRect(obj, videoEl) {
  const vw = videoEl.videoWidth || 0;
  const vh = videoEl.videoHeight || 0;
  const c = (stage.trimBars && obj && obj.crop) || null;
  if (!c) return { sx: 0, sy: 0, sw: vw, sh: vh };
  return {
    sx: c.left * vw,
    sy: c.top * vh,
    sw: vw * (1 - c.left - c.right),
    sh: vh * (1 - c.top - c.bottom),
  };
}

function currentFrame() {
  return FRAME_PRESETS.find((f) => f.id === stage.frameId) || FRAME_PRESETS[0];
}

// Geometry of the inset "window" the recording is drawn into. Derived from
// canvas size so the preview and the export match exactly. `chromeH` reserves
// room above the video for the mock title bar; the video keeps its aspect ratio
// and the title bar + video are centred together as one unit.
function contentRect(src, w, h, chromeH = 0) {
  const vw = src.sw || w;
  const vh = src.sh || h;
  const pad = stage.padding * Math.min(w, h);
  const availW = Math.max(1, w - pad * 2);
  const availH = Math.max(1, h - pad * 2 - chromeH);
  const fit = Math.min(availW / vw, availH / vh);
  const cw = vw * fit;
  const ch = vh * fit;
  const totalH = ch + chromeH;
  return { x: (w - cw) / 2, y: (h - totalH) / 2 + chromeH, w: cw, h: ch };
}

function frameColors() {
  return stage.frameLight
    ? { bar: '#e9e9ee', pill: '#ffffff', text: '#5f5f6b', line: 'rgba(0,0,0,0.10)', glyph: '#6b6b76' }
    : { bar: '#2c2c34', pill: '#1c1c22', text: '#a7a7b4', line: 'rgba(255,255,255,0.07)', glyph: '#a7a7b4' };
}

function drawMacLights(targetCtx, x, cy, size) {
  ['#ff5f57', '#febc2e', '#28c840'].forEach((color, i) => {
    targetCtx.beginPath();
    targetCtx.arc(x + i * size * 1.6, cy, size / 2, 0, Math.PI * 2);
    targetCtx.fillStyle = color;
    targetCtx.fill();
  });
}

function drawWinControls(targetCtx, right, cy, size, color) {
  targetCtx.strokeStyle = color;
  targetCtx.lineWidth = Math.max(1, size * 0.09);
  const gap = size * 2.2;
  // minimise
  targetCtx.beginPath();
  targetCtx.moveTo(right - gap * 2 - size / 2, cy);
  targetCtx.lineTo(right - gap * 2 + size / 2, cy);
  targetCtx.stroke();
  // maximise
  targetCtx.strokeRect(right - gap - size / 2, cy - size / 2, size, size);
  // close
  targetCtx.beginPath();
  targetCtx.moveTo(right - size / 2, cy - size / 2);
  targetCtx.lineTo(right + size / 2, cy + size / 2);
  targetCtx.moveTo(right + size / 2, cy - size / 2);
  targetCtx.lineTo(right - size / 2, cy + size / 2);
  targetCtx.stroke();
}

function fitText(targetCtx, text, maxWidth) {
  if (targetCtx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && targetCtx.measureText(`${truncated}…`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

// Draws the mock title bar into the top band of the window rect. Called after the
// video so it always sits on top, and inside the window's clip so its corners
// stay rounded.
function drawFrameChrome(targetCtx, win, chromeH, frame) {
  const c = frameColors();
  const cy = win.y + chromeH / 2;

  targetCtx.fillStyle = c.bar;
  targetCtx.fillRect(win.x, win.y, win.w, chromeH);

  // hairline between chrome and video
  targetCtx.fillStyle = c.line;
  targetCtx.fillRect(win.x, win.y + chromeH - 1, win.w, 1);

  const lightSize = chromeH * 0.26;
  let contentLeft = win.x + chromeH * 0.5;
  let contentRight = win.x + win.w - chromeH * 0.5;

  if (frame.lights === 'mac') {
    drawMacLights(targetCtx, contentLeft + lightSize / 2, cy, lightSize);
    contentLeft += lightSize * 1.6 * 3 + chromeH * 0.3;
  } else if (frame.lights === 'win') {
    drawWinControls(targetCtx, contentRight - lightSize / 2, cy, lightSize * 0.8, c.glyph);
    contentRight -= lightSize * 2.2 * 2 + lightSize;
  }

  if (!frame.urlBar) return;

  const pillH = chromeH * 0.56;
  const pillW = Math.max(0, contentRight - contentLeft);
  if (pillW < pillH) return;

  roundRectPath(targetCtx, contentLeft, cy - pillH / 2, pillW, pillH, pillH / 2);
  targetCtx.fillStyle = c.pill;
  targetCtx.fill();

  const label = stage.frameLabel;
  if (!label) return;
  targetCtx.fillStyle = c.text;
  targetCtx.font = `${Math.round(pillH * 0.52)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  targetCtx.textBaseline = 'middle';
  const padX = pillH * 0.6;
  targetCtx.fillText(fitText(targetCtx, label, pillW - padX * 2), contentLeft + padX, cy);
}

function renderInto(targetCtx, w, h) {
  drawBackground(targetCtx, w, h);

  const cur = getCurrentSegment();
  if (!cur) return; // background-only, e.g. before a recording loads
  const { videoEl } = cur.src;
  const frame = currentFrame();
  const chromeH = frame.chrome * Math.min(w, h);
  const src = sourceRect(cur.src, videoEl);
  const rect = contentRect(src, w, h, chromeH);
  // The mock window is the video plus the title bar above it; corners and shadow
  // apply to that whole unit, not to the video alone.
  const win = { x: rect.x, y: rect.y - chromeH, w: rect.w, h: rect.h + chromeH };
  const radius = stage.radius * Math.min(w, h);

  if (stage.shadow) {
    targetCtx.save();
    targetCtx.shadowColor = 'rgba(0,0,0,0.5)';
    targetCtx.shadowBlur = Math.min(w, h) * 0.04;
    targetCtx.shadowOffsetY = Math.min(w, h) * 0.014;
    targetCtx.fillStyle = '#000';
    roundRectPath(targetCtx, win.x, win.y, win.w, win.h, radius);
    targetCtx.fill();
    targetCtx.restore();
  }

  targetCtx.save();
  roundRectPath(targetCtx, win.x, win.y, win.w, win.h, radius);
  targetCtx.clip();

  const cam = cur.type === 'recording' ? getCamera(videoEl.currentTime * 1000) : null;
  if (cam && cam.scale > 1.0001) {
    const dw = rect.w * cam.scale;
    const dh = rect.h * cam.scale;
    // Keep the camera's normalized target point fixed on screen as we scale up.
    targetCtx.drawImage(
      videoEl,
      src.sx, src.sy, src.sw, src.sh,
      rect.x - cam.x * (dw - rect.w),
      rect.y - cam.y * (dh - rect.h),
      dw,
      dh
    );
  } else {
    targetCtx.drawImage(videoEl, src.sx, src.sy, src.sw, src.sh, rect.x, rect.y, rect.w, rect.h);
  }

  if (chromeH > 0) drawFrameChrome(targetCtx, win, chromeH, frame);
  targetCtx.restore();

  // Drawn *after* the window clip is released, and positioned in canvas space, so
  // the bubble can be placed anywhere on the frame — over the inset screen, over
  // the background, or straddling the edge between them.
  drawWebcamBubble(targetCtx, w, h, cur, cam ? cam.scale : 1);

  // After the webcam bubble, so a mask band also covers it if the bubble strays
  // into a redacted area, and before captions, which must stay legible on top of
  // whatever's masked underneath them.
  drawMasks(targetCtx, w, h);

  // Captions last, on top of everything — they're the one thing that must never be
  // obscured. Being part of renderInto means they burn into the export for free.
  drawCaptions(targetCtx, w, h, cur);
}

// ---------- captions ----------

function activeCue(sourceMs) {
  return project.captions.find((c) => sourceMs >= c.t && sourceMs <= c.endT) || null;
}

// A cue with no text yet — freshly added by hand, or emptied out — must not draw. Left
// unchecked it paints an empty caption box over the video, which reads as a rendering
// bug rather than as "nothing typed yet".
function cueHasText(cue) {
  return !!cue && typeof cue.text === 'string' && cue.text.trim().length > 0;
}

function captionsVisibleFor(cur) {
  if (!captionStyle.enabled || !project.captions.length) return false;
  // Cue times are recording-source time, which has no meaning inside an added clip.
  return !!cur && cur.type === 'recording';
}

// Greedy wrap against the real measured width, so it reflows correctly at any font
// size or canvas aspect (a 9:16 export wraps far sooner than 16:9).
function wrapWords(targetCtx, words, maxWidth) {
  const lines = [];
  let line = [];
  words.forEach((word) => {
    const candidate = [...line, word];
    const text = candidate.map((w) => w.text).join(' ');
    if (line.length && targetCtx.measureText(text).width > maxWidth) {
      lines.push(line);
      line = [word];
    } else {
      line = candidate;
    }
  });
  if (line.length) lines.push(line);
  return lines;
}

// The caption block's bounding box in canvas space, from the most recent draw —
// null whenever nothing was actually drawn (no active cue, captions off, etc).
// Used by the drag hit-test, so what you grab is exactly what's on screen; there's
// no equivalent geometry function computable ahead of time the way webcamRect() is,
// since the block's size depends on the current cue's wrapped text.
let captionHitRect = null;

function drawCaptions(targetCtx, w, h, cur) {
  captionHitRect = null;
  if (!captionsVisibleFor(cur)) return;
  const sourceMs = cur.src.videoEl.currentTime * 1000;
  const cue = activeCue(sourceMs);
  if (!cueHasText(cue)) return;

  const fontPx = Math.max(10, captionStyle.fontSize * h);
  targetCtx.save();
  targetCtx.font = `600 ${Math.round(fontPx)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  targetCtx.textBaseline = 'middle';
  targetCtx.textAlign = 'left'; // laid out per-word, so alignment is done by hand

  // Word-level data is what makes the karaoke highlight possible; fall back to the
  // whole cue as one "word" when a cue has none (hand-typed, or a model without it).
  const words = (captionStyle.wordHighlight && cue.words && cue.words.length)
    ? cue.words
    : cue.text.split(/\s+/).filter(Boolean).map((text) => ({ text, t: cue.t, endT: cue.endT }));

  const maxWidth = w * captionStyle.maxWidthFrac;
  const lines = wrapWords(targetCtx, words, maxWidth);
  const lineHeight = fontPx * 1.32;
  const padX = fontPx * 0.5;
  const padY = fontPx * 0.32;
  const blockH = lines.length * lineHeight;

  const lineTexts = lines.map((lineWords) => lineWords.map((word) => word.text).join(' '));
  const lineWidths = lineTexts.map((text) => targetCtx.measureText(text).width);
  const blockW = Math.max(0, ...lineWidths);

  // Free-dragged, like the webcam bubble: x/y are the block's centre. Clamped so
  // an extreme drag, or an unusually tall multi-line cue, can never push the text
  // fully off-canvas — captions are the one thing that must stay legible.
  const anchorX = captionStyle.x * w;
  const top = Math.min(Math.max(captionStyle.y * h - blockH / 2, 0), Math.max(0, h - blockH));

  captionHitRect = { x: anchorX - blockW / 2, y: top, w: blockW, h: blockH };

  const spaceW = targetCtx.measureText(' ').width;

  lines.forEach((lineWords, i) => {
    const lineText = lineTexts[i];
    const lineW = lineWidths[i];
    const x0 = anchorX - lineW / 2;
    const cy = top + i * lineHeight + lineHeight / 2;

    if (captionStyle.style === 'box') {
      targetCtx.globalAlpha = captionStyle.boxOpacity;
      targetCtx.fillStyle = captionStyle.boxColor;
      roundRectPath(
        targetCtx,
        x0 - padX,
        cy - lineHeight / 2 - padY / 2,
        lineW + padX * 2,
        lineHeight + padY,
        fontPx * 0.22
      );
      targetCtx.fill();
      targetCtx.globalAlpha = 1;
    }

    let x = x0;
    lineWords.forEach((word) => {
      const active = captionStyle.wordHighlight
        && sourceMs >= word.t && sourceMs <= word.endT;
      targetCtx.fillStyle = active ? captionStyle.highlightColor : captionStyle.color;

      if (captionStyle.style === 'outline') {
        // Stroke first, fill over it, so the outline sits outside the glyph.
        targetCtx.lineWidth = Math.max(2, fontPx * 0.14);
        targetCtx.strokeStyle = 'rgba(0,0,0,0.9)';
        targetCtx.lineJoin = 'round';
        targetCtx.miterLimit = 2;
        targetCtx.strokeText(word.text, x, cy);
      } else if (captionStyle.style === 'shadow') {
        targetCtx.shadowColor = 'rgba(0,0,0,0.85)';
        targetCtx.shadowBlur = fontPx * 0.3;
        targetCtx.shadowOffsetY = fontPx * 0.06;
      }

      targetCtx.fillText(word.text, x, cy);
      targetCtx.shadowColor = 'transparent';
      targetCtx.shadowBlur = 0;
      targetCtx.shadowOffsetY = 0;
      x += targetCtx.measureText(word.text).width + spaceW;
    });
  });

  targetCtx.restore();
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
}

// A linear (evenly-spaced) alpha ramp butting straight up against a flat, fully
// opaque fill has a kink in it — the *rate* of change jumps from zero (across the
// solid fill) to whatever the ramp's slope is, right at the seam. Vision is very
// sensitive to exactly that kind of discontinuity (the same mechanism behind Mach
// bands), so even a fairly long, gentle ramp reads as a distinct edge/line right
// at the point where the solid fill ends — a "soft-edged line" instead of an
// actual dissolve. Smoothstep has zero slope at both ends, so it meets the solid
// fill, and fades out to nothing, with no kink either way — several stops
// approximate the curve, since canvas gradients only interpolate linearly
// *between* stops.
function addSmoothstepStops(grad, r, g, b, alphaFrom, alphaTo) {
  const STEPS = 8;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const eased = t * t * (3 - 2 * t);
    grad.addColorStop(t, `rgba(${r},${g},${b},${alphaFrom + (alphaTo - alphaFrom) * eased})`);
  }
}

// Solid bands over the top and/or bottom of the *whole exported frame* — not just
// the inset video rect. A taskbar or notification to redact can sit anywhere in
// that band, including over the background/stage padding or a webcam bubble
// docked there, so the mask spans full canvas width and is sized against full
// canvas height, the same coordinate space webcamStyle/captionStyle already use
// (see clientToCanvasNorm) — not the content rect crop/aspect changes.
//
// Only the inner edge (the one facing the centre of the frame) feathers into a
// gradient; the outer edge stays a hard line flush with the frame's own edge,
// where there's nothing to dissolve into.
function drawMasks(targetCtx, w, h) {
  if (maskStyle.top <= 0 && maskStyle.bottom <= 0) return;
  const { r, g, b } = hexToRgb(maskStyle.color);
  targetCtx.save();

  if (maskStyle.top > 0) {
    const bandH = h * maskStyle.top;
    const featherH = bandH * maskStyle.feather;
    const solidH = bandH - featherH;
    targetCtx.fillStyle = maskStyle.color;
    if (solidH > 0) targetCtx.fillRect(0, 0, w, solidH);
    if (featherH > 0) {
      const grad = targetCtx.createLinearGradient(0, solidH, 0, bandH);
      addSmoothstepStops(grad, r, g, b, 1, 0); // opaque where it meets the solid fill, fading to nothing
      targetCtx.fillStyle = grad;
      targetCtx.fillRect(0, solidH, w, featherH);
    }
  }

  if (maskStyle.bottom > 0) {
    const bandH = h * maskStyle.bottom;
    const featherH = bandH * maskStyle.feather;
    const solidH = bandH - featherH;
    const bandTop = h - bandH;
    if (featherH > 0) {
      const grad = targetCtx.createLinearGradient(0, bandTop, 0, bandTop + featherH);
      addSmoothstepStops(grad, r, g, b, 0, 1); // nothing at the frame-centre-facing edge, opaque where the solid fill picks up
      targetCtx.fillStyle = grad;
      targetCtx.fillRect(0, bandTop, w, featherH);
    }
    if (solidH > 0) {
      targetCtx.fillStyle = maskStyle.color;
      targetCtx.fillRect(0, bandTop + featherH, w, solidH);
    }
  }

  targetCtx.restore();
}

// 0 at rest, 1 at the keyframe slider's max — how far into "zoomed" the bubble
// should read. Keyframe scale never drops below 1 (see the .kf-scale range), so
// this can't go negative; a null/undefined camScale (no zoom active) reads as 1.
function bubbleShrinkAmount(camScale) {
  if (!camScale || camScale <= 1) return 0;
  return Math.min(1, (camScale - 1) / (KEYFRAME_MAX_ZOOM - 1));
}

// Geometry of the bubble in canvas space. Also used by the drag hit-test, so what
// you grab is exactly what's drawn. camScale is the active zoom's current scale
// (1, or omitted, when no zoom is active) — the bubble shrinks toward minSize as
// it climbs toward KEYFRAME_MAX_ZOOM, and grows back once the zoom eases out,
// following the same eased timeline the screen zoom itself already uses.
function webcamRect(w, h, camScale = 1) {
  // minSize > size would grow the bubble on zoom instead of shrinking it — clamp
  // to a no-op (size stays constant) rather than let that read as a bug.
  const minD = Math.min(webcamStyle.minSize, webcamStyle.size);
  const sizeFrac = webcamStyle.size - (webcamStyle.size - minD) * bubbleShrinkAmount(camScale);
  const d = sizeFrac * Math.min(w, h);
  return {
    x: webcamStyle.x * w - d / 2,
    y: webcamStyle.y * h - d / 2,
    d,
  };
}

function webcamVisibleFor(cur) {
  if (!project.webcam || !webcamStyle.enabled) return false;
  // Webcam time only maps onto the screen recording; an added file clip has no
  // corresponding moment in it.
  if (!cur || cur.type !== 'recording') return false;
  return cur.seg.webcam !== false; // per-clip toggle
}

function drawWebcamBubble(targetCtx, w, h, cur, camScale = 1) {
  if (!webcamVisibleFor(cur)) return;
  const videoEl = project.webcam.videoEl;
  if (!videoEl.videoWidth) return;

  const { x, y, d } = webcamRect(w, h, camScale);
  const radius = webcamStyle.shape === 'circle' ? d / 2 : d * 0.18;

  targetCtx.save();
  if (webcamStyle.shadow) {
    targetCtx.shadowColor = 'rgba(0,0,0,0.45)';
    targetCtx.shadowBlur = d * 0.16;
    targetCtx.shadowOffsetY = d * 0.05;
    targetCtx.fillStyle = '#000';
    roundRectPath(targetCtx, x, y, d, d, radius);
    targetCtx.fill();
    targetCtx.shadowColor = 'transparent';
  }

  roundRectPath(targetCtx, x, y, d, d, radius);
  targetCtx.clip();

  // Centre-crop to a square so a 4:3 camera isn't squashed into the bubble.
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  if (webcamStyle.mirror) {
    // Mirrored to match how people expect to see themselves.
    targetCtx.translate(x + d, y);
    targetCtx.scale(-1, 1);
    targetCtx.drawImage(videoEl, sx, sy, side, side, 0, 0, d, d);
  } else {
    targetCtx.drawImage(videoEl, sx, sy, side, side, x, y, d, d);
  }
  targetCtx.restore();

  if (webcamStyle.border) {
    targetCtx.save();
    roundRectPath(targetCtx, x, y, d, d, radius);
    targetCtx.lineWidth = Math.max(2, d * 0.035);
    targetCtx.strokeStyle = 'rgba(255,255,255,0.92)';
    targetCtx.stroke();
    targetCtx.restore();
  }
}

function renderFrame() {
  renderInto(ctx, canvas.width, canvas.height);
  // The stage controls are live before a recording finishes loading, so the
  // timeline-dependent parts have to be skipped until then.
  if (!isLoaded()) return;
  updateTimeLabel();
  updatePlayhead();
  syncDebugToPlayhead();
  highlightActiveCue();
  updateZoomTarget();
  updateCropOverlay();
  updateMaskOverlay();
}

// ---------- transport ----------

function fmt(ms) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = (total - m * 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

function fmtShort(ms) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total - m * 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateTimeLabel() {
  document.getElementById('time-label').textContent =
    `${fmt(currentOutputElapsedMs())} / ${fmt(totalOutputDurationMs())}`;
}

function updatePlayhead() {
  const track = document.getElementById('timeline-track');
  const el = document.getElementById('playhead');
  if (!track || !el) return;
  const total = totalOutputDurationMs();
  const frac = total > 0 ? currentOutputElapsedMs() / total : 0;
  el.style.left = `${Math.min(1, Math.max(0, frac)) * track.clientWidth}px`;
  el.classList.toggle('visible', total > 0);
}

// ---------- webcam / screen sync ----------
//
// The webcam recording spans the whole session, so its time maps to *recording
// source* time, offset by however long after the screen recorder it started:
//   webcamTime = recordingSourceMs - startOffsetMs

// The webcam and the main recording are two independently-decoded <video> elements
// with no shared clock — small drift between them is normal. Below HARD_RESYNC, that
// drift is corrected by nudging playbackRate a few percent instead of seeking: a jump
// for a few frames of drift would be more noticeable than the drift itself, and a
// continuous small-rate correction converges just as fast without one. Only a drift
// bigger than that (a scrub, a segment change) gets a hard seek, since nudging could
// never catch up to a jump that size within a reasonable time anyway.
const WEBCAM_HARD_RESYNC_MS = 250;
// Drift below this is within normal frame-timing noise — nudging away noise that small
// would mean the rate never actually settles at 1x.
const WEBCAM_SOFT_CORRECT_MS = 15;
// Caps how aggressively the rate is pulled back into line, so the correction itself
// stays inaudible/invisible rather than becoming its own artifact.
const WEBCAM_MAX_RATE_NUDGE = 0.05;

function webcamTimeFor(sourceMs) {
  return Math.max(0, sourceMs - project.webcam.startOffsetMs);
}

// Used on seek/scrub, where an exact jump is wanted.
function syncWebcamSeek(sourceMs) {
  if (!project.webcam) return;
  const target = webcamTimeFor(sourceMs);
  if (target > project.webcam.duration) return;
  project.webcam.videoEl.currentTime = target / 1000;
}

// Used during playback: let it run, and only correct when it has actually drifted.
// rateMultiplier is 1 for normal playback/real-time export; the fast export paths
// pass EXPORT_DECODE_SPEEDUP so this tracks the main clip's cranked-up decode rate
// instead of reading it as a huge desync and hard-resync-seeking every frame.
function syncWebcamPlayback(cur, rateMultiplier = 1) {
  if (!project.webcam) return;
  const videoEl = project.webcam.videoEl;
  if (!webcamVisibleFor(cur)) {
    if (!videoEl.paused) videoEl.pause();
    return;
  }
  const expected = webcamTimeFor(playhead.localMs);
  // Clamped the same way applyExportDecodeSpeed clamps the main video's rate, so the
  // two can't diverge if EXPORT_DECODE_SPEEDUP is ever tuned past what keeps
  // speedOf(seg) * rateMultiplier under the ceiling.
  const baseRate = Math.min(16, speedOf(cur.seg) * rateMultiplier);
  // Positive: the webcam clip is ahead of where it should be (needs to slow down).
  const driftMs = videoEl.currentTime * 1000 - expected;

  if (Math.abs(driftMs) > WEBCAM_HARD_RESYNC_MS) {
    videoEl.currentTime = expected / 1000;
    videoEl.playbackRate = baseRate;
  } else if (Math.abs(driftMs) > WEBCAM_SOFT_CORRECT_MS) {
    const nudge = Math.max(-WEBCAM_MAX_RATE_NUDGE, Math.min(WEBCAM_MAX_RATE_NUDGE, driftMs / 1000));
    videoEl.playbackRate = baseRate * (1 - nudge);
  } else {
    videoEl.playbackRate = baseRate;
  }
  if (videoEl.paused) videoEl.play().catch(() => {});
}

function pauseWebcam() {
  if (project.webcam && !project.webcam.videoEl.paused) project.webcam.videoEl.pause();
}

// preservesPitch keeps sped-up narration intelligible instead of chipmunked.
// It defaults to true in Chrome, but set it explicitly so the behaviour is not
// left to a default that could change.
function applySpeed(info) {
  info.src.videoEl.preservesPitch = true;
  info.src.videoEl.playbackRate = speedOf(info.seg);
}

async function play() {
  if (playing) return;
  if (!isLoaded()) return;
  editorAudioCtx.resume();
  playing = true;
  setPlayIcon(true);
  const cur = getCurrentSegment();
  const { seg, src } = cur;
  // A trim (or finishing playback) can leave the playhead outside the clip's
  // range; restart from its in-point rather than playing trimmed-off footage.
  if (playhead.localMs < seg.in || playhead.localMs >= seg.out - 15) {
    playhead.localMs = seg.in;
    await seekTo(src.videoEl, seg.in / 1000);
  }
  applySpeed(cur);
  syncWebcamSeek(playhead.localMs);
  await src.videoEl.play();
  syncWebcamPlayback(cur);
  rafId = requestAnimationFrame(tick);
}

function pause() {
  playing = false;
  setPlayIcon(false);
  const cur = getCurrentSegment();
  if (cur) cur.src.videoEl.pause();
  pauseWebcam();
  if (rafId) cancelAnimationFrame(rafId);
}

function setPlayIcon(isPlaying) {
  document.getElementById('icon-play').classList.toggle('hidden', isPlaying);
  document.getElementById('icon-pause').classList.toggle('hidden', !isPlaying);
}

function tick() {
  if (!playing) return;
  const cur = getCurrentSegment();
  if (!cur) { pause(); return; }
  const { seg, src } = cur;
  playhead.localMs = src.videoEl.currentTime * 1000;

  if (playhead.localMs >= seg.out - 15) {
    const nextIndex = playhead.segIndex + 1;
    if (nextIndex >= segmentCount()) {
      pause();
      rewindToStart();
      return;
    }
    const next = getSegmentByIndex(nextIndex);
    playhead.segIndex = nextIndex;
    // Two halves of a split are the same source, adjacent, at the same speed —
    // let playback run straight through instead of pausing and re-seeking, which
    // would put an audible hiccup at every cut point.
    const contiguous = next.src === src
      && Math.abs(next.seg.in - seg.out) < 40
      && speedOf(next.seg) === speedOf(seg);
    if (!contiguous) {
      src.videoEl.pause();
      playhead.localMs = next.seg.in;
      applySpeed(next);
      seekTo(next.src.videoEl, next.seg.in / 1000).then(() => {
        if (playing) next.src.videoEl.play();
      });
    }
    syncWebcamSeek(getCurrentSegment().seg.in);
  }
  syncWebcamPlayback(getCurrentSegment());
  renderFrame();
  rafId = requestAnimationFrame(tick);
}

function rewindToStart() {
  if (!isLoaded()) return;
  playhead.segIndex = 0;
  const first = getSegmentByIndex(0);
  playhead.localMs = first.seg.in;
  return seekTo(first.src.videoEl, first.seg.in / 1000).then(renderFrame);
}

document.getElementById('btn-play').addEventListener('click', () => {
  if (playing) pause(); else play();
});

// ---------- timeline ----------

function renderTimeline() {
  const track = document.getElementById('timeline-track');
  track.querySelectorAll('.clip').forEach((el) => el.remove());
  clipViews = [];

  for (let i = 0; i < segmentCount(); i += 1) {
    const view = buildClip(getSegmentByIndex(i));
    clipViews.push(view);
    track.appendChild(view.clipEl);
  }

  layoutTimeline();
}

function buildClip(info) {
  const { seg, src, type, index } = info;

  const clipEl = document.createElement('div');
  clipEl.className = 'clip';
  clipEl.classList.toggle('selected', seg.id === selectedSegmentId);

  const body = document.createElement('div');
  body.className = 'clip-body';
  clipEl.appendChild(body);

  // Video and audio get their own lanes, the way every NLE lays this out — a
  // waveform blended on top of thumbnails is unreadable (and was washing the
  // filmstrip out to white on light-coloured pages).
  const videoLane = document.createElement('div');
  videoLane.className = 'clip-lane clip-lane-video';
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.className = 'clip-thumbs';
  videoLane.appendChild(thumbCanvas);
  body.appendChild(videoLane);

  const audioLane = document.createElement('div');
  audioLane.className = 'clip-lane clip-lane-audio';
  const waveCanvas = document.createElement('canvas');
  waveCanvas.className = 'clip-waveform';
  audioLane.appendChild(waveCanvas);
  body.appendChild(audioLane);

  const label = document.createElement('div');
  label.className = 'clip-label';
  label.textContent = `${src.file ? '🎬' : '🖥'} ${src.file ? src.name : 'Screen'}`;
  clipEl.appendChild(label);

  if (speedOf(seg) !== 1) {
    const badge = document.createElement('div');
    badge.className = 'clip-speed';
    badge.textContent = `${speedOf(seg)}×`;
    clipEl.appendChild(badge);
  }

  // Any segment can be deleted now — that's what makes cutting a mistake out of
  // the middle possible, rather than only trimming the ends.
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'clip-remove';
  remove.textContent = '✕';
  remove.title = 'Delete this clip';
  remove.addEventListener('click', (e) => { e.stopPropagation(); deleteSegment(seg.id); });
  clipEl.appendChild(remove);

  const leftHandle = document.createElement('div');
  leftHandle.className = 'trim-handle left';
  const rightHandle = document.createElement('div');
  rightHandle.className = 'trim-handle right';
  clipEl.appendChild(leftHandle);
  clipEl.appendChild(rightHandle);

  const view = { seg, src, type, index, clipEl, body, videoLane, audioLane, thumbCanvas, waveCanvas };

  bindTrimHandle(leftHandle, view, 'left');
  bindTrimHandle(rightHandle, view, 'right');

  clipEl.addEventListener('click', (e) => {
    if (e.target === leftHandle || e.target === rightHandle) return;
    if (e.target.closest && e.target.closest('.clip-remove')) return;
    selectSegment(seg.id);
    const rect = document.getElementById('timeline-track').getBoundingClientRect();
    seekToGlobalElapsed(((e.clientX - rect.left) / rect.width) * totalOutputDurationMs());
  });

  attachHoverPreview(clipEl, view);

  return view;
}

// Zooms and click markers get their own lane below the clips, rather than sitting
// on top of the thumbnails where they hid the picture and were easy to mis-click.
function renderZoomLane() {
  const lane = document.getElementById('zoom-lane');
  lane.innerHTML = '';
  const total = totalOutputDurationMs();
  const width = lane.clientWidth;
  if (!total || !width) return;

  project.zoomKeyframes.forEach((kf) => {
    const start = recordingTimeToGlobal(kf.t);
    if (start == null) return; // this zoom now sits in trimmed-away footage
    const end = recordingTimeToGlobal(kf.t + kf.duration);
    const x1 = (start / total) * width;
    const x2 = end == null ? x1 + 8 : (end / total) * width;

    const bar = document.createElement('div');
    bar.className = 'zoom-bar';
    bar.classList.toggle('manual', !!kf.manual);
    bar.classList.toggle('selected', kf.id === selectedKeyframeId);
    bar.style.left = `${x1}px`;
    bar.style.width = `${Math.max(8, x2 - x1)}px`;
    bar.title = `${kf.scale.toFixed(2)}× for ${(kf.duration / 1000).toFixed(1)}s${kf.manual ? ' (manual)' : ''}`;
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedKeyframeId = kf.id;
      renderZoomLane();
      renderZoomSettings();
      renderFrame();
    });
    lane.appendChild(bar);
  });

  project.clicks.forEach((c) => {
    const g = recordingTimeToGlobal(c.t);
    if (g == null) return;
    const dot = document.createElement('div');
    dot.className = 'click-dot';
    dot.classList.toggle('active', project.zoomKeyframes.some((kf) => kf.clickT === c.t));
    dot.style.left = `${(g / total) * width}px`;
    dot.title = 'Click detected — toggle its zoom';
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleZoomKeyframe(c);
      renderZoomLane();
      renderZoomSettings();
      renderFrame();
    });
    lane.appendChild(dot);
  });
}

function layoutTimeline() {
  const total = totalOutputDurationMs();
  // Set every clip's flex-basis first so the row reflows once before any
  // width is measured — measuring mid-loop would read sizes from a
  // half-updated layout (other clips still at their default auto size).
  clipViews.forEach((view) => {
    const raw = total > 0 ? (segOutputMs(view.seg) / total) * 100 : 0;
    const pct = Number.isFinite(raw) ? raw : 0;
    view.clipEl.style.flex = `0 0 ${Math.max(pct, 0.5)}%`;
  });

  clipViews.forEach((view) => {
    const { videoLane, audioLane, thumbCanvas, waveCanvas } = view;
    const sizeCanvas = (canvasEl, laneEl) => {
      const w = Math.max(1, Math.round(laneEl.clientWidth));
      const h = Math.max(1, Math.round(laneEl.clientHeight));
      if (canvasEl.width !== w || canvasEl.height !== h) {
        canvasEl.width = w;
        canvasEl.height = h;
      }
    };
    sizeCanvas(thumbCanvas, videoLane);
    sizeCanvas(waveCanvas, audioLane);
    drawClipThumbs(view);
    drawClipWaveform(view);
  });

  // These measure laid-out widths, so they have to run after the clips above have
  // been sized.
  renderRuler();
  renderZoomLane();
  renderCaptionLane();
  updatePlayhead();
}

function renderRuler() {
  const ruler = document.getElementById('ruler');
  ruler.innerHTML = '';
  const total = totalOutputDurationMs();
  if (!Number.isFinite(total) || total <= 0) return;
  const width = ruler.clientWidth;
  if (!width) return; // not laid out yet; layoutTimeline will call us again

  const targetPxPerTick = 90;
  const tickCount = Math.max(2, Math.floor(width / targetPxPerTick));
  const niceSteps = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
  const step = niceSteps.find((s) => s >= total / tickCount) || niceSteps[niceSteps.length - 1];

  for (let t = 0; t <= total && ruler.childElementCount < 400; t += step) {
    const x = (t / total) * width;
    const tick = document.createElement('div');
    tick.className = 'ruler-tick';
    // Labels within ~44px of the end read right-to-left so they stay inside.
    if (x > width - 44) tick.classList.add('flip');
    tick.style.left = `${x}px`;
    tick.textContent = fmtShort(t);
    ruler.appendChild(tick);

    // A subdivision between labels, as every editor's ruler has — makes the
    // spacing readable without doubling the number of timecodes.
    const mid = t + step / 2;
    if (mid <= total) {
      const minor = document.createElement('div');
      minor.className = 'ruler-tick minor';
      minor.style.left = `${(mid / total) * width}px`;
      ruler.appendChild(minor);
    }
  }
}

// How soon after the click typing has to start to count as "typing into what was
// just clicked" rather than an unrelated later burst.
const TYPING_LINK_GAP_MS = 1200;
// Small buffer after the last keystroke before releasing the zoom, so it doesn't
// cut away the instant the cursor stops.
const TYPING_HOLD_TAIL_MS = 500;

// The default hold, unless a typing burst follows the click closely enough to count
// as typing into whatever was clicked — then it holds through the whole burst
// instead of cutting away on a fixed timer while someone's still mid-sentence.
function durationForClick(click) {
  const typing = (project.typing || []).find(
    (iv) => iv.start >= click.t && iv.start - click.t < TYPING_LINK_GAP_MS
  );
  if (!typing) return ZOOM_HOLD_MS;
  return Math.max(ZOOM_HOLD_MS, (typing.end - click.t) + TYPING_HOLD_TAIL_MS);
}

function makeKeyframe(click) {
  return {
    id: `kf-${click.t}`,
    clickT: click.t,
    t: Math.max(0, click.t - ZOOM_LEAD_IN_MS),
    x: click.x,
    y: click.y,
    duration: durationForClick(click),
    scale: ZOOM_SCALE,
  };
}

function findKeyframeForClick(click) {
  return project.zoomKeyframes.findIndex((kf) => kf.clickT === click.t);
}

function toggleZoomKeyframe(click) {
  pushHistory();
  const idx = findKeyframeForClick(click);
  if (idx >= 0) {
    const removed = project.zoomKeyframes.splice(idx, 1)[0];
    if (selectedKeyframeId === removed.id) selectedKeyframeId = null;
  } else {
    const kf = makeKeyframe(click);
    project.zoomKeyframes.push(kf);
    selectedKeyframeId = kf.id;
  }
  invalidateCamera();
}

// Adds a zoom wherever the playhead is, for things the user never clicked.
// Targets frame centre; drag the crosshair on the preview to aim it.
function addZoomAtPlayhead() {
  const cur = getCurrentSegment();
  if (!cur) return;
  if (cur.type !== 'recording') {
    setStatus('Zooms apply to the screen recording, not to added clips.');
    return;
  }
  pushHistory();
  const kf = {
    id: `kf-manual-${nextKeyframeId++}`,
    manual: true,
    clickT: null,
    t: playhead.localMs,
    x: 0.5,
    y: 0.5,
    duration: ZOOM_HOLD_MS,
    scale: ZOOM_SCALE,
  };
  project.zoomKeyframes.push(kf);
  selectedKeyframeId = kf.id;
  invalidateCamera();
  renderTimeline();
  renderZoomSettings();
  renderFrame();
  setStatus('Zoom added — drag the crosshair on the preview to aim it');
}

// Turn every detected click into a zoom, skipping clicks that land inside a
// zoom already in flight — otherwise a burst of clicks in one spot stacks up
// into a jittery mess. Manually placed zooms are preserved: this rebuilds only
// the click-derived ones.
function autoApplyZooms() {
  const manual = project.zoomKeyframes.filter((kf) => kf.manual);
  const auto = [];
  let busyUntil = -Infinity;
  [...project.clicks]
    .sort((a, b) => a.t - b.t)
    .forEach((c) => {
      if (c.t < busyUntil) return;
      const kf = makeKeyframe(c);
      auto.push(kf);
      busyUntil = kf.t + kf.duration;
    });
  project.zoomKeyframes = [...manual, ...auto].sort((a, b) => a.t - b.t);
  selectedKeyframeId = null;
  invalidateCamera();
}

function renderZoomSettings() {
  let panel = document.getElementById('zoom-settings');
  const kf = project.zoomKeyframes.find((k) => k.id === selectedKeyframeId);
  if (!kf) { if (panel) panel.remove(); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'zoom-settings';
    panel.className = 'zoom-settings';
    document.querySelector('.timeline-panel').insertAdjacentElement('afterend', panel);
  }
  panel.innerHTML = `
    <label>Zoom <input type="range" min="1.1" max="${KEYFRAME_MAX_ZOOM}" step="0.05" value="${kf.scale}" class="kf-scale" /><span class="kf-val">${kf.scale.toFixed(2)}×</span></label>
    <label>Hold <input type="range" min="600" max="${KEYFRAME_MAX_HOLD_MS}" step="100" value="${kf.duration}" class="kf-duration" /><span class="kf-val">${(kf.duration / 1000).toFixed(1)}s</span></label>
    <button type="button" class="del-kf">Remove zoom</button>
  `;
  const scaleInput = panel.querySelector('.kf-scale');
  const durationInput = panel.querySelector('.kf-duration');
  // pushHistory on mousedown, once per drag gesture — not on 'input', which fires on
  // every tick of the drag and would make undo revert one slider-step at a time.
  scaleInput.addEventListener('mousedown', pushHistory);
  scaleInput.addEventListener('input', (e) => {
    kf.scale = parseFloat(e.target.value);
    e.target.nextElementSibling.textContent = `${kf.scale.toFixed(2)}×`;
    invalidateCamera();
    renderFrame();
  });
  durationInput.addEventListener('mousedown', pushHistory);
  durationInput.addEventListener('input', (e) => {
    kf.duration = parseInt(e.target.value, 10);
    e.target.nextElementSibling.textContent = `${(kf.duration / 1000).toFixed(1)}s`;
    invalidateCamera();
    renderFrame();
  });
  panel.querySelector('.del-kf').addEventListener('click', () => {
    pushHistory();
    const idx = project.zoomKeyframes.findIndex((k) => k.id === kf.id);
    if (idx >= 0) project.zoomKeyframes.splice(idx, 1);
    selectedKeyframeId = null;
    invalidateCamera();
    renderTimeline();
    renderFrame();
  });
}

// ---------- trim handles ----------

function bindTrimHandle(handle, view, side) {
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    pushHistory(); // once per drag gesture, not per mousemove — undo reverts the whole trim
    const track = document.getElementById('timeline-track');
    dragging = { view, side };
    handle.classList.add('dragging');
    const tooltip = document.createElement('div');
    tooltip.className = 'drag-tooltip';
    handle.appendChild(tooltip);

    // Anchor the px->ms mapping to the state at mousedown. Trimming changes both
    // this segment's in/out and the project total, so recomputing the mapping on
    // every mousemove would feed the drag back into itself and compound.
    const anchor = {
      in0: view.seg.in,
      out0: view.seg.out,
      before0: segmentOffsetMs(view.index),
      total0: totalOutputDurationMs(),
      candidates: snapCandidatesMs(view),
    };

    let queued = false;
    const onMove = (ev) => {
      handleTrimDrag(view, side, ev, track, tooltip, anchor);
      if (!queued) {
        queued = true;
        requestAnimationFrame(() => { queued = false; });
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      handle.classList.remove('dragging');
      tooltip.remove();
      dragging = null;
      renderTimeline();
      renderZoomSettings();
      renderClipPanel();
      // The trim may have moved in/out past where the video element is
      // parked; re-seek so playback resumes inside the new range.
      if (playhead.segIndex === view.index) {
        seekTo(view.src.videoEl, playhead.localMs / 1000).then(renderFrame);
      } else {
        renderFrame();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// Snap targets, in output time: the timeline ends, every clip boundary, and each
// click marker (so a trim can land exactly on a click).
function snapCandidatesMs(view) {
  const candidates = [0, totalOutputDurationMs()];
  let offset = 0;
  project.segments.forEach((seg) => {
    candidates.push(offset, offset + segOutputMs(seg));
    offset += segOutputMs(seg);
  });
  if (view.type === 'recording') {
    const before = segmentOffsetMs(view.index);
    project.clicks.forEach((c) => {
      candidates.push(before + (c.t - view.seg.in) / speedOf(view.seg));
    });
  }
  return candidates;
}

function handleTrimDrag(view, side, ev, track, tooltip, anchor) {
  const { seg, src } = view;
  const trackRect = track.getBoundingClientRect();
  let globalMs = ((ev.clientX - trackRect.left) / trackRect.width) * anchor.total0;

  const snapPxToMs = (SNAP_PX / Math.max(trackRect.width, 1)) * anchor.total0;
  for (const c of anchor.candidates) {
    if (Math.abs(c - globalMs) <= snapPxToMs) { globalMs = c; break; }
  }

  // Output offset within this clip -> source time. The speed factor is why this
  // isn't a straight subtraction.
  const localMs = anchor.in0 + (globalMs - anchor.before0) * speedOf(seg);

  if (side === 'left') {
    seg.in = Math.min(Math.max(0, localMs), seg.out - MIN_SEGMENT_MS);
  } else {
    seg.out = Math.max(Math.min(src.duration, localMs), seg.in + MIN_SEGMENT_MS);
  }
  clampPlayheadToSegment(view.index, seg);
  layoutTimeline();
  renderFrame();
  tooltip.textContent = fmt(side === 'left' ? seg.in : seg.out);
}

function clampPlayheadToSegment(segIndex, seg) {
  if (playhead.segIndex !== segIndex) return;
  playhead.localMs = Math.min(Math.max(playhead.localMs, seg.in), seg.out);
}

// ---------- scrubbing ----------
//
// Two things make this feel smooth. First, the playhead and time label update
// straight from the pointer, so the UI never waits on a decode. Second, seeks are
// *coalesced*: a seek is in flight at most once, and only the latest requested
// position is honoured when it lands. Issuing one seek per mousemove instead
// builds a backlog and the video lags seconds behind the cursor.

let scrubbing = false;
let seekInFlight = false;
let pendingSeek = null;

function requestScrubSeek(src, seconds) {
  pendingSeek = { src, seconds };
  if (!seekInFlight) pumpSeek();
}

// Seeking a compressed format (WebM/VP8/VP9, what this app records) is not
// frame-exact — the browser lands on the nearest keyframe rather than the exact
// requested time, and MediaRecorder output can go a meaningful fraction of a second
// between keyframes. Left uncorrected, playhead.localMs stays at the *requested*
// time while the frame actually painted on screen is a *different* one — so
// splitting (or anything else keyed off playhead.localMs) doesn't match what was
// visibly on screen when the decision was made. Resyncing to the actual landed
// time after a seek settles means "split here" always splits the frame that's
// actually showing, not the pixel the ruler happened to be dragged to.
function resyncPlayheadToActualFrame(src) {
  const cur = getCurrentSegment();
  if (!cur || cur.src !== src) return; // superseded by a newer seek or segment change
  playhead.localMs = Math.min(Math.max(src.videoEl.currentTime * 1000, cur.seg.in), cur.seg.out);
  updatePlayhead();
  updateTimeLabel();
}

function pumpSeek() {
  if (!pendingSeek) { seekInFlight = false; return; }
  const { src, seconds } = pendingSeek;
  pendingSeek = null;
  seekInFlight = true;
  seekTo(src.videoEl, seconds).then(() => {
    // Only once truly settled — a mid-drag intermediate seek resyncing would show
    // as the time label briefly jumping backward to whatever keyframe it landed on
    // before the next requested position overwrites it a moment later.
    if (!pendingSeek) resyncPlayheadToActualFrame(src);
    renderFrame();
    pumpSeek();
  });
}

function globalFromClientX(clientX) {
  const track = document.getElementById('timeline-track');
  const rect = track.getBoundingClientRect();
  if (!rect.width) return 0;
  const frac = (clientX - rect.left) / rect.width;
  return Math.min(1, Math.max(0, frac)) * totalOutputDurationMs();
}

function scrubTo(clientX) {
  const target = resolveGlobal(globalFromClientX(clientX));
  if (!target) return;
  playhead.segIndex = target.index;
  playhead.localMs = target.localMs;
  // Immediate visual feedback; the frame catches up when the seek resolves.
  updatePlayhead();
  updateTimeLabel();
  syncWebcamSeek(target.localMs);
  requestScrubSeek(target.src, target.localMs / 1000);
}

function beginScrub(e) {
  if (!isLoaded()) return;
  e.preventDefault();
  pause();
  scrubbing = true;
  document.body.classList.add('scrubbing');
  scrubTo(e.clientX);

  let queued = false;
  let lastX = e.clientX;
  const onMove = (ev) => {
    lastX = ev.clientX;
    // One update per frame is plenty, and keeps mousemove cheap.
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (scrubbing) scrubTo(lastX);
    });
  };
  const onUp = (ev) => {
    if (ev && typeof ev.clientX === 'number') lastX = ev.clientX;
    // Flush: a quick flick can release before the throttled frame runs, and
    // dropping that last position would leave the playhead where the drag began.
    scrubTo(lastX);
    scrubbing = false;
    document.body.classList.remove('scrubbing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function initScrubbing() {
  // Grab the playhead itself, or press anywhere on the ruler — both are what
  // people reach for.
  document.getElementById('playhead-grab').addEventListener('mousedown', beginScrub);
  document.getElementById('ruler').addEventListener('mousedown', beginScrub);
}

// ---------- preview coordinate mapping ----------
//
// Overlays (the zoom crosshair, the crop handles) live in client space, but the
// values they edit are normalised against the *video content* — which sits inside
// the stage's inset window, not the whole canvas. So every mapping goes
// client <-> canvas <-> content rect, and the canvas is usually displayed at a
// different size than its internal resolution.

function previewMapping() {
  const cur = getCurrentSegment();
  if (!cur) return null;
  const clientRect = canvas.getBoundingClientRect();
  if (!clientRect.width) return null;
  const scale = clientRect.width / canvas.width;

  const frame = currentFrame();
  const chromeH = frame.chrome * Math.min(canvas.width, canvas.height);
  const src = sourceRect(cur.src, cur.src.videoEl);
  const content = contentRect(src, canvas.width, canvas.height, chromeH);

  return { clientRect, scale, content, cur, src };
}

// Normalised point within the video content -> px relative to the canvas box.
// Deliberately *not* viewport coordinates: the overlays are absolutely positioned
// inside .preview-stage, so they track the video through page scrolls for free.
function contentToStage(map, nx, ny) {
  return {
    x: (map.content.x + nx * map.content.w) * map.scale,
    y: (map.content.y + ny * map.content.h) * map.scale,
  };
}

// Client px -> normalised point within the video content, clamped to it.
function clientToContent(map, clientX, clientY) {
  const cx = (clientX - map.clientRect.left) / map.scale;
  const cy = (clientY - map.clientRect.top) / map.scale;
  return {
    x: Math.min(1, Math.max(0, (cx - map.content.x) / map.content.w)),
    y: Math.min(1, Math.max(0, (cy - map.content.y) / map.content.h)),
  };
}

// ---------- zoom target crosshair ----------

function selectedKeyframe() {
  return project.zoomKeyframes.find((k) => k.id === selectedKeyframeId) || null;
}

function updateZoomTarget() {
  const el = document.getElementById('zoom-target');
  if (!el) return;
  const kf = selectedKeyframe();
  const map = previewMapping();
  if (!kf || !map || cropping || map.cur.type !== 'recording') {
    el.classList.remove('visible');
    return;
  }
  const p = contentToStage(map, kf.x, kf.y);
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  el.classList.add('visible');
}

function initZoomTargetDrag() {
  const el = document.getElementById('zoom-target');
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const kf = selectedKeyframe();
    if (!kf) return;
    pushHistory(); // once per drag gesture, not per mousemove

    const onMove = (ev) => {
      const map = previewMapping();
      if (!map) return;
      const n = clientToContent(map, ev.clientX, ev.clientY);
      kf.x = n.x;
      kf.y = n.y;
      invalidateCamera();
      renderFrame();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ---------- webcam controls ----------

// Fractions of the whole canvas, not the inset screen — the bubble is free to sit
// over the background too.
const CAM_CORNERS = [
  { id: 'bl', name: 'Bottom left', x: 0.10, y: 0.85 },
  { id: 'br', name: 'Bottom right', x: 0.90, y: 0.85 },
  { id: 'tl', name: 'Top left', x: 0.10, y: 0.15 },
  { id: 'tr', name: 'Top right', x: 0.90, y: 0.15 },
  { id: 'c', name: 'Centre', x: 0.5, y: 0.5 },
];

// Client px -> normalised canvas coordinates. Distinct from clientToContent, which
// maps into the inset screen rect for zoom/crop.
function clientToCanvasNorm(clientX, clientY) {
  const clientRect = canvas.getBoundingClientRect();
  if (!clientRect.width) return null;
  const scale = clientRect.width / canvas.width;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return {
    x: clamp01((clientX - clientRect.left) / scale / canvas.width),
    y: clamp01((clientY - clientRect.top) / scale / canvas.height),
    scale,
    clientRect,
  };
}

const CAM_SHAPES = [
  { id: 'circle', name: 'Circle' },
  { id: 'rounded', name: 'Rounded' },
];

function renderWebcamControls() {
  const corners = document.getElementById('cam-corners');
  corners.innerHTML = '';
  CAM_CORNERS.forEach((c) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = c.name;
    // Free dragging means the bubble often sits at no preset; highlight only on
    // an actual match rather than guessing.
    btn.classList.toggle('active',
      Math.abs(webcamStyle.x - c.x) < 0.01 && Math.abs(webcamStyle.y - c.y) < 0.01);
    btn.addEventListener('click', () => {
      webcamStyle.x = c.x;
      webcamStyle.y = c.y;
      renderWebcamControls();
      renderFrame();
    });
    corners.appendChild(btn);
  });

  const shapes = document.getElementById('cam-shapes');
  shapes.innerHTML = '';
  CAM_SHAPES.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = s.name;
    btn.classList.toggle('active', webcamStyle.shape === s.id);
    btn.addEventListener('click', () => {
      webcamStyle.shape = s.id;
      renderWebcamControls();
      renderFrame();
    });
    shapes.appendChild(btn);
  });

  const size = document.getElementById('cam-size');
  size.value = webcamStyle.size;
  document.getElementById('cam-size-val').textContent = `${Math.round(webcamStyle.size * 100)}%`;
  const minSize = document.getElementById('cam-min-size');
  minSize.value = webcamStyle.minSize;
  document.getElementById('cam-min-size-val').textContent = `${Math.round(webcamStyle.minSize * 100)}%`;
  document.getElementById('cam-enabled').checked = webcamStyle.enabled;
  document.getElementById('cam-border').checked = webcamStyle.border;
  document.getElementById('cam-shadow').checked = webcamStyle.shadow;
  document.getElementById('cam-mirror').checked = webcamStyle.mirror;
}

function bindWebcamControls() {
  document.getElementById('cam-size').addEventListener('input', (e) => {
    webcamStyle.size = parseFloat(e.target.value);
    document.getElementById('cam-size-val').textContent = `${Math.round(webcamStyle.size * 100)}%`;
    renderFrame();
  });
  document.getElementById('cam-min-size').addEventListener('input', (e) => {
    webcamStyle.minSize = parseFloat(e.target.value);
    document.getElementById('cam-min-size-val').textContent = `${Math.round(webcamStyle.minSize * 100)}%`;
    renderFrame();
  });
  [['cam-enabled', 'enabled'], ['cam-border', 'border'], ['cam-shadow', 'shadow'], ['cam-mirror', 'mirror']]
    .forEach(([id, key]) => {
      document.getElementById(id).addEventListener('change', (e) => {
        webcamStyle[key] = e.target.checked;
        renderFrame();
      });
    });
}

// Drag the caption block straight on the preview, the same way the webcam bubble
// works. Registered before initWebcamDrag() and stops the event outright on a hit,
// so the two never both start a drag from one click where a dragged caption
// happens to overlap the bubble — captions are drawn on top, so they get first
// refusal, matching what's actually visible.
function initCaptionDrag() {
  canvas.addEventListener('mousedown', (e) => {
    if (cropping || !captionHitRect) return;

    const map = clientToCanvasNorm(e.clientX, e.clientY);
    if (!map) return;

    const box = captionHitRect;
    const px = (e.clientX - map.clientRect.left) / map.scale;
    const py = (e.clientY - map.clientRect.top) / map.scale;
    if (px < box.x || px > box.x + box.w || py < box.y || py > box.y + box.h) return;

    e.preventDefault();
    e.stopImmediatePropagation(); // claim this click before initWebcamDrag sees it
    canvas.classList.add('grabbing');
    // Grab offset, so the block doesn't snap its centre to the cursor.
    const grabDx = captionStyle.x - map.x;
    const grabDy = captionStyle.y - map.y;
    const onMove = (ev) => {
      const m = clientToCanvasNorm(ev.clientX, ev.clientY);
      if (!m) return;
      captionStyle.x = Math.min(1, Math.max(0, m.x + grabDx));
      captionStyle.y = Math.min(1, Math.max(0, m.y + grabDy));
      renderFrame();
    };
    const onUp = () => {
      canvas.classList.remove('grabbing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      renderSubtitleControls(); // a preset may no longer be the active one
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// Drag the bubble straight on the preview. Hit-tested against the same rect the
// renderer draws, so what you grab is what you see.
function initWebcamDrag() {
  canvas.addEventListener('mousedown', (e) => {
    if (cropping) return; // crop handles own the preview in that mode
    const cur = getCurrentSegment();
    if (!webcamVisibleFor(cur)) return;

    const map = clientToCanvasNorm(e.clientX, e.clientY);
    if (!map) return;

    // Hit-test in canvas pixels against the rect the renderer uses — including
    // whatever the bubble is currently shrunk to, if a zoom is active right now.
    const cam = cur.type === 'recording' ? getCamera(cur.src.videoEl.currentTime * 1000) : null;
    const bubble = webcamRect(canvas.width, canvas.height, cam ? cam.scale : 1);
    const px = (e.clientX - map.clientRect.left) / map.scale;
    const py = (e.clientY - map.clientRect.top) / map.scale;
    if (px < bubble.x || px > bubble.x + bubble.d || py < bubble.y || py > bubble.y + bubble.d) return;

    e.preventDefault();
    canvas.classList.add('grabbing');
    // Grab offset, so the bubble doesn't snap its centre to the cursor.
    const grabDx = webcamStyle.x - map.x;
    const grabDy = webcamStyle.y - map.y;
    const onMove = (ev) => {
      const m = clientToCanvasNorm(ev.clientX, ev.clientY);
      if (!m) return;
      webcamStyle.x = Math.min(1, Math.max(0, m.x + grabDx));
      webcamStyle.y = Math.min(1, Math.max(0, m.y + grabDy));
      renderFrame();
    };
    const onUp = () => {
      canvas.classList.remove('grabbing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      renderWebcamControls(); // a preset may no longer be the active one
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ---------- crop ----------
//
// Writes into the same `source.crop` fractions the letterbox fix already uses, so
// sourceRect() needs no changes — manual crop and auto letterbox-trim are the same
// mechanism with different origins.

const ASPECT_PRESETS = [
  { id: 'source', name: 'Source' },
  { id: '16:9', name: '16:9', w: 1920, h: 1080 },
  { id: '9:16', name: '9:16', w: 1080, h: 1920 },
  { id: '1:1', name: '1:1', w: 1080, h: 1080 },
  { id: '4:5', name: '4:5', w: 1080, h: 1350 },
];
let aspectId = 'source';

function currentCrop() {
  const cur = getCurrentSegment();
  if (!cur) return null;
  return cur.src.crop || { top: 0, bottom: 0, left: 0, right: 0 };
}

// The crop box is expressed against the *uncropped* source, so the overlay has to
// be drawn from the full frame rather than the already-cropped content rect.
function fullFrameRect() {
  const cur = getCurrentSegment();
  if (!cur) return null;
  const clientRect = canvas.getBoundingClientRect();
  if (!clientRect.width) return null;
  const scale = clientRect.width / canvas.width;
  const videoEl = cur.src.videoEl;
  const frame = currentFrame();
  const chromeH = frame.chrome * Math.min(canvas.width, canvas.height);
  const full = { sx: 0, sy: 0, sw: videoEl.videoWidth, sh: videoEl.videoHeight };
  if (!full.sw || !full.sh) return null;
  const content = contentRect(full, canvas.width, canvas.height, chromeH);
  return { clientRect, scale, content };
}

function updateCropOverlay() {
  const overlay = document.getElementById('crop-overlay');
  if (!overlay) return;
  if (!cropping) { overlay.classList.remove('visible'); return; }
  const map = fullFrameRect();
  const crop = currentCrop();
  if (!map || !crop) { overlay.classList.remove('visible'); return; }

  // Canvas-relative, matching .preview-stage as the positioning context.
  const left = (map.content.x + crop.left * map.content.w) * map.scale;
  const top = (map.content.y + crop.top * map.content.h) * map.scale;
  const width = map.content.w * (1 - crop.left - crop.right) * map.scale;
  const height = map.content.h * (1 - crop.top - crop.bottom) * map.scale;

  overlay.style.left = `${left}px`;
  overlay.style.top = `${top}px`;
  overlay.style.width = `${Math.max(0, width)}px`;
  overlay.style.height = `${Math.max(0, height)}px`;
  overlay.classList.add('visible');
}

const MIN_CROP_FRACTION = 0.1;

function initCropDrag() {
  const overlay = document.getElementById('crop-overlay');
  overlay.querySelectorAll('.crop-handle').forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = getCurrentSegment();
      if (!cur) return;
      if (!cur.src.crop) cur.src.crop = { top: 0, bottom: 0, left: 0, right: 0 };
      const crop = cur.src.crop;
      const edge = handle.dataset.edge;

      const onMove = (ev) => {
        const map = fullFrameRect();
        if (!map) return;
        const nx = (ev.clientX - map.clientRect.left) / map.scale;
        const ny = (ev.clientY - map.clientRect.top) / map.scale;
        const fx = Math.min(1, Math.max(0, (nx - map.content.x) / map.content.w));
        const fy = Math.min(1, Math.max(0, (ny - map.content.y) / map.content.h));

        if (edge === 'left') crop.left = Math.min(fx, 1 - crop.right - MIN_CROP_FRACTION);
        if (edge === 'right') crop.right = Math.min(1 - fx, 1 - crop.left - MIN_CROP_FRACTION);
        if (edge === 'top') crop.top = Math.min(fy, 1 - crop.bottom - MIN_CROP_FRACTION);
        if (edge === 'bottom') crop.bottom = Math.min(1 - fy, 1 - crop.top - MIN_CROP_FRACTION);

        // Manual crop supersedes the auto letterbox trim, so keep it applied.
        stage.trimBars = true;
        layoutTimeline();
        renderFrame();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

// ---------- mask ----------
//
// Unlike crop, which is expressed against the *uncropped* source (see
// fullFrameRect()), a mask paints over the whole composited output, full canvas
// width — the same coordinate space webcamStyle/clientToCanvasNorm already use —
// rather than the inset content rect, so it stays put across crop/aspect changes
// and still covers a webcam bubble docked in that band. Handles are positioned
// against the same full-canvas fractions drawMasks() itself draws from.

const MIN_MASK_GAP = 0.08; // fraction of canvas height that must stay unmasked

function updateMaskOverlay() {
  const topHandle = document.getElementById('mask-handle-top');
  const bottomHandle = document.getElementById('mask-handle-bottom');
  if (!topHandle || !bottomHandle) return;
  if (!maskAdjusting) {
    topHandle.classList.remove('visible');
    bottomHandle.classList.remove('visible');
    return;
  }
  const clientRect = canvas.getBoundingClientRect();
  if (!clientRect.width) return;
  const scale = clientRect.width / canvas.width;
  const width = canvas.width * scale;

  topHandle.style.left = '0px';
  topHandle.style.width = `${width}px`;
  topHandle.style.top = `${maskStyle.top * canvas.height * scale}px`;
  topHandle.classList.toggle('visible', maskStyle.top > 0);

  bottomHandle.style.left = '0px';
  bottomHandle.style.width = `${width}px`;
  bottomHandle.style.top = `${(1 - maskStyle.bottom) * canvas.height * scale}px`;
  bottomHandle.classList.toggle('visible', maskStyle.bottom > 0);
}

function initMaskDrag() {
  ['top', 'bottom'].forEach((edge) => {
    const handle = document.getElementById(`mask-handle-${edge}`);
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const onMove = (ev) => {
        const map = clientToCanvasNorm(ev.clientX, ev.clientY);
        if (!map) return;
        const fy = map.y;

        if (edge === 'top') {
          maskStyle.top = Math.max(0, Math.min(fy, 1 - maskStyle.bottom - MIN_MASK_GAP));
        } else {
          maskStyle.bottom = Math.max(0, Math.min(1 - fy, 1 - maskStyle.top - MIN_MASK_GAP));
        }
        renderFrame();
        renderMaskControls(); // checkbox state can flip if a drag zeroes a band out
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

const DEFAULT_MASK_FRACTION = 0.12;

function renderMaskControls() {
  document.getElementById('mask-top').checked = maskStyle.top > 0;
  document.getElementById('mask-bottom').checked = maskStyle.bottom > 0;
  document.getElementById('mask-color').value = maskStyle.color;
  document.getElementById('mask-feather').value = maskStyle.feather;
  document.getElementById('mask-feather-val').textContent = `${Math.round(maskStyle.feather * 100)}%`;
}

function bindMaskControls() {
  document.getElementById('mask-top').addEventListener('change', (e) => {
    maskStyle.top = e.target.checked
      ? Math.min(DEFAULT_MASK_FRACTION, 1 - maskStyle.bottom - MIN_MASK_GAP)
      : 0;
    renderFrame();
    updateMaskOverlay();
  });
  document.getElementById('mask-bottom').addEventListener('change', (e) => {
    maskStyle.bottom = e.target.checked
      ? Math.min(DEFAULT_MASK_FRACTION, 1 - maskStyle.top - MIN_MASK_GAP)
      : 0;
    renderFrame();
    updateMaskOverlay();
  });
  document.getElementById('mask-color').addEventListener('input', (e) => {
    maskStyle.color = e.target.value;
    renderFrame();
  });
  document.getElementById('mask-feather').addEventListener('input', (e) => {
    maskStyle.feather = parseFloat(e.target.value);
    document.getElementById('mask-feather-val').textContent = `${Math.round(maskStyle.feather * 100)}%`;
    renderFrame();
  });

  document.getElementById('btn-mask-adjust').addEventListener('click', () => {
    maskAdjusting = !maskAdjusting;
    // Mutually exclusive with crop: both dim/overlay the same preview area, and
    // showing both sets of handles at once would be unreadable.
    if (maskAdjusting && cropping) {
      cropping = false;
      document.getElementById('btn-crop').classList.remove('active');
      setStatus('');
    }
    document.getElementById('btn-mask-adjust').classList.toggle('active', maskAdjusting);
    setStatus(maskAdjusting ? 'Drag the handles to resize the masked bands' : '');
    renderFrame();
  });
}

function renderAspectOptions() {
  const root = document.getElementById('aspect-options');
  root.innerHTML = '';
  ASPECT_PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = preset.name;
    btn.classList.toggle('active', aspectId === preset.id);
    btn.addEventListener('click', () => {
      aspectId = preset.id;
      if (preset.id === 'source') {
        canvas.width = baseOutputSize.w;
        canvas.height = baseOutputSize.h;
      } else {
        canvas.width = preset.w;
        canvas.height = preset.h;
      }
      renderAspectOptions();
      renderFrame();
    });
    root.appendChild(btn);
  });
}

// ---------- split / select / delete / speed ----------

function selectSegment(id) {
  selectedSegmentId = id;
  clipViews.forEach((v) => v.clipEl.classList.toggle('selected', v.seg.id === id));
  renderClipPanel();
}

function splitAtPlayhead() {
  const cur = getCurrentSegment();
  if (!cur) return;
  const { seg } = cur;
  const at = playhead.localMs;
  if (at - seg.in < MIN_SEGMENT_MS || seg.out - at < MIN_SEGMENT_MS) {
    setStatus('Too close to the clip edge to split.');
    return;
  }
  pushHistory();
  // The right half shares the source; only the in/out window differs. That's the
  // whole trick that makes per-range speed and mid-take deletion possible.
  const right = {
    id: nextSegmentId++,
    sourceId: seg.sourceId,
    in: at,
    out: seg.out,
    speed: seg.speed,
  };
  seg.out = at;
  project.segments.splice(playhead.segIndex + 1, 0, right);
  selectedSegmentId = right.id;
  renderTimeline();
  renderClipPanel();
  renderFrame();
  setStatus('Clip split');
}

function deleteSegment(id) {
  if (project.segments.length <= 1) {
    setStatus('That’s the only clip — trim it instead of deleting it.');
    return;
  }
  const idx = project.segments.findIndex((s) => s.id === id);
  if (idx < 0) return;
  pushHistory();
  project.segments.splice(idx, 1);
  releaseUnusedSources();

  if (selectedSegmentId === id) {
    selectedSegmentId = project.segments[Math.min(idx, project.segments.length - 1)].id;
  }
  pause();
  playhead.segIndex = Math.min(playhead.segIndex, project.segments.length - 1);
  const cur = getCurrentSegment();
  playhead.localMs = cur.seg.in;
  seekTo(cur.src.videoEl, cur.seg.in / 1000).then(() => {
    renderTimeline();
    renderClipPanel();
    renderFrame();
  });
  setStatus('Clip deleted');
}

// Frees object URLs for added files once no segment references them. The
// recording source is kept regardless — clicks and zoom keyframes point at it,
// and it may be re-added later.
function releaseUnusedSources() {
  const used = new Set(project.segments.map((s) => s.sourceId));
  project.sources = project.sources.filter((src) => {
    if (used.has(src.id) || src.kind === 'recording') return true;
    URL.revokeObjectURL(src.url);
    return false;
  });
}

function setSegmentSpeed(seg, speed) {
  if (seg.speed === speed) return; // re-clicking the already-active speed — nothing to undo
  pushHistory();
  seg.speed = speed;
  // The video element may be mid-playback on this segment.
  const cur = getCurrentSegment();
  if (cur && cur.seg === seg) applySpeed(cur);
  renderTimeline();
  renderClipPanel();
  renderFrame();
}

function renderClipPanel() {
  const panel = document.getElementById('clip-panel');
  const info = getSelectedSegment();
  if (!info) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const { seg, src, type } = info;
  // Per-clip webcam visibility: splitting is already how ranges get carved out, so
  // "hide the bubble here" needs no separate range model.
  const camToggle = project.webcam && type === 'recording'
    ? `<label class="check clip-panel-cam"><input type="checkbox" class="cam-seg"${seg.webcam === false ? '' : ' checked'} /> Webcam</label>`
    : '';
  panel.innerHTML = `
    <span class="clip-panel-name">${src.file ? `🎬 ${escapeHtml(src.name)}` : '🖥 Screen Recording'}</span>
    <span class="clip-panel-time">${fmt(seg.in)} → ${fmt(seg.out)} · ${fmt(segOutputMs(seg))} out</span>
    ${camToggle}
    <span class="clip-panel-speeds">
      ${SPEED_OPTIONS.map((s) => `<button type="button" class="ghost speed-opt${speedOf(seg) === s ? ' active' : ''}" data-speed="${s}">${s}×</button>`).join('')}
    </span>
    <button type="button" class="ghost danger-ghost clip-panel-del">Delete clip</button>
  `;
  panel.querySelectorAll('.speed-opt').forEach((btn) => {
    btn.addEventListener('click', () => setSegmentSpeed(seg, parseFloat(btn.dataset.speed)));
  });
  const camSeg = panel.querySelector('.cam-seg');
  if (camSeg) {
    camSeg.addEventListener('change', (e) => {
      pushHistory();
      seg.webcam = e.target.checked;
      renderFrame();
    });
  }
  panel.querySelector('.clip-panel-del').addEventListener('click', () => deleteSegment(seg.id));
}

// ---------- hover scrub preview ----------

function attachHoverPreview(clipEl, view) {
  const preview = document.getElementById('hover-preview');
  const previewCanvas = document.getElementById('hover-preview-canvas');
  const previewCtx = previewCanvas.getContext('2d');
  const previewTime = document.getElementById('hover-preview-time');

  clipEl.addEventListener('mousemove', (e) => {
    if (dragging || scrubbing) { preview.classList.remove('visible'); return; }
    const rect = clipEl.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const localMs = view.seg.in + p * (view.seg.out - view.seg.in);

    if (view.src.thumbs && view.src.thumbs.length) {
      let nearest = view.src.thumbs[0];
      view.src.thumbs.forEach((t) => {
        if (Math.abs(t.t - localMs) < Math.abs(nearest.t - localMs)) nearest = t;
      });
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      previewCtx.drawImage(nearest.canvas, 0, 0, previewCanvas.width, previewCanvas.height);
    }
    previewTime.textContent = fmtShort(localMs);
    preview.classList.add('visible');
    preview.style.left = `${e.clientX - preview.offsetWidth / 2}px`;
    preview.style.top = `${rect.top - preview.offsetHeight - 12}px`;
  });

  clipEl.addEventListener('mouseleave', () => preview.classList.remove('visible'));
}

// ---------- thumbnails ----------

async function generateThumbnails(obj) {
  const clone = document.createElement('video');
  clone.src = obj.url;
  clone.preload = 'auto';
  clone.muted = true;
  clone.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;';
  document.body.appendChild(clone);
  await new Promise((resolve) => clone.addEventListener('loadedmetadata', resolve, { once: true }));

  const thumbs = [];
  for (let i = 0; i < THUMB_COUNT; i += 1) {
    const t = (i / (THUMB_COUNT - 1)) * obj.duration;
    const ok = await seekToOrGiveUp(clone, Math.min(t, obj.duration - 10) / 1000);
    if (!ok) break;
    const frame = document.createElement('canvas');
    frame.width = THUMB_W; frame.height = THUMB_H;
    const fctx = frame.getContext('2d');
    fctx.fillStyle = '#000';
    fctx.fillRect(0, 0, THUMB_W, THUMB_H);
    // Respect the letterbox crop so timeline thumbnails match the preview.
    const src = sourceRect(obj, clone);
    const fit = Math.min(THUMB_W / src.sw, THUMB_H / src.sh);
    const dw = src.sw * fit;
    const dh = src.sh * fit;
    fctx.drawImage(clone, src.sx, src.sy, src.sw, src.sh, (THUMB_W - dw) / 2, (THUMB_H - dh) / 2, dw, dh);
    thumbs.push({ t, canvas: frame });
    // Show progress as frames arrive instead of waiting for the whole strip.
    obj.thumbs = thumbs.slice();
    clipViews.filter((v) => v.src === obj).forEach(drawClipThumbs);
  }

  obj.thumbs = thumbs;
  clone.remove();
  // A source can back several segments after a split, so redraw all of them.
  clipViews.filter((v) => v.src === obj).forEach(drawClipThumbs);
}

function drawClipThumbs(view) {
  const { src, seg, thumbCanvas } = view;
  const tctx = thumbCanvas.getContext('2d');
  const { width: w, height: h } = thumbCanvas;
  tctx.clearRect(0, 0, w, h);
  if (!src.thumbs || !src.thumbs.length) return;

  // Only the frames inside this segment's window — so the two halves of a split
  // show different thumbnails rather than both showing the whole source.
  const visible = src.thumbs.filter((t) => t.t >= seg.in && t.t <= seg.out);
  const frames = visible.length ? visible : src.thumbs;

  // Tile at the frames' own aspect ratio and cover-fit each cell, so the strip
  // reads as a filmstrip instead of a few stretched-out smears.
  const first = frames[0].canvas;
  const cellW = Math.max(8, Math.round(h * (first.width / first.height)));
  const cells = Math.max(1, Math.ceil(w / cellW));
  for (let i = 0; i < cells; i += 1) {
    const frame = frames[Math.min(frames.length - 1, Math.floor((i / cells) * frames.length))];
    tctx.drawImage(frame.canvas, i * cellW, 0, cellW, h);
  }

  // Hairlines between cells give the strip some structure at a glance.
  tctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let i = 1; i < cells; i += 1) tctx.fillRect(i * cellW, 0, 1, h);
}

// ---------- waveform ----------

async function generateWaveform(obj) {
  const blob = obj.blob || obj.file;
  if (!blob) return;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const decodeCtx = new AudioContext();
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
    decodeCtx.close();
    const data = audioBuffer.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(data.length / PEAK_BUCKETS));
    const peaks = [];
    for (let i = 0; i < PEAK_BUCKETS; i += 1) {
      let min = 0, max = 0;
      const start = i * bucketSize;
      const end = Math.min(data.length, start + bucketSize);
      for (let j = start; j < end; j += 1) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks.push([min, max]);
    }
    obj.peaks = peaks;
  } catch (_) {
    obj.peaks = [];
  }
  clipViews.filter((v) => v.src === obj).forEach(drawClipWaveform);
}

function drawClipWaveform(view) {
  const { src, seg, waveCanvas } = view;
  const wctx = waveCanvas.getContext('2d');
  wctx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
  if (!src.peaks || !src.peaks.length) return;

  const startIdx = Math.floor((seg.in / src.duration) * src.peaks.length);
  const endIdx = Math.max(startIdx + 1, Math.ceil((seg.out / src.duration) * src.peaks.length));
  const slice = src.peaks.slice(startIdx, endIdx);
  if (!slice.length) return;

  const w = waveCanvas.width;
  const h = waveCanvas.height;
  const mid = h / 2;
  // Its own lane on a dark background, so it stays legible regardless of how
  // bright the recorded page is.
  wctx.fillStyle = 'rgba(124,58,237,0.85)';
  const barW = Math.max(1, w / slice.length);
  slice.forEach(([min, max], i) => {
    const y1 = mid + min * mid * 0.9;
    const y2 = mid + max * mid * 0.9;
    wctx.fillRect(i * barW, Math.min(y1, y2), Math.max(1, barW - 0.5), Math.max(1, Math.abs(y2 - y1)));
  });
  // Centre line, so silence still reads as a track rather than an empty box.
  wctx.fillStyle = 'rgba(255,255,255,0.18)';
  wctx.fillRect(0, Math.round(mid), w, 1);
}

// ---------- stage controls ----------

function renderSwatches() {
  const root = document.getElementById('bg-swatches');
  root.innerHTML = '';
  BG_PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.title = preset.name;
    btn.style.background = preset.stops.length === 1
      ? preset.stops[0]
      : `linear-gradient(135deg, ${preset.stops.join(', ')})`;
    btn.classList.toggle('active', !stage.image && stage.presetId === preset.id);
    btn.addEventListener('click', () => {
      stage.presetId = preset.id;
      clearStageImage();
      renderSwatches();
      renderFrame();
    });
    root.appendChild(btn);
  });
}

function renderFrameOptions() {
  const root = document.getElementById('frame-options');
  root.innerHTML = '';
  FRAME_PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = preset.name;
    btn.classList.toggle('active', stage.frameId === preset.id);
    btn.addEventListener('click', () => {
      stage.frameId = preset.id;
      renderFrameOptions();
      renderFrame();
    });
    root.appendChild(btn);
  });
}

document.getElementById('frame-light').addEventListener('change', (e) => {
  stage.frameLight = e.target.checked;
  renderFrame();
});

document.getElementById('frame-label').addEventListener('input', (e) => {
  stage.frameLabel = e.target.value;
  renderFrame();
});

// Strips the scheme and any trailing slash — what a browser's URL bar shows.
function prettyUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch (_) {
    return raw;
  }
}

function clearStageImage() {
  if (stage.imageUrl) URL.revokeObjectURL(stage.imageUrl);
  stage.image = null;
  stage.imageUrl = null;
  document.getElementById('btn-bg-clear').classList.add('hidden');
}

document.getElementById('btn-bg-image').addEventListener('click', () => {
  document.getElementById('bg-file-input').click();
});

document.getElementById('btn-bg-clear').addEventListener('click', () => {
  clearStageImage();
  renderSwatches();
  renderFrame();
});

document.getElementById('bg-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', () => reject(new Error('could not decode image')), { once: true });
      img.src = url;
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    setStatus(`Could not load "${file.name}" as a background.`);
    return;
  }
  clearStageImage();
  stage.image = img;
  stage.imageUrl = url;
  document.getElementById('btn-bg-clear').classList.remove('hidden');
  renderSwatches();
  renderFrame();
  setStatus(`Background set to "${file.name}"`);
});

function bindStageSlider(id, key, format) {
  const input = document.getElementById(id);
  const label = document.getElementById(`${id}-val`);
  input.value = stage[key];
  label.textContent = format(stage[key]);
  input.addEventListener('input', (e) => {
    stage[key] = parseFloat(e.target.value);
    label.textContent = format(stage[key]);
    renderFrame();
  });
}

bindStageSlider('stage-padding', 'padding', (v) => `${Math.round(v * 100)}%`);
bindStageSlider('stage-radius', 'radius', (v) => `${Math.round(v * 100)}%`);

document.getElementById('stage-shadow').addEventListener('change', (e) => {
  stage.shadow = e.target.checked;
  renderFrame();
});

// Only revealed when bars were actually detected — an escape hatch in case the
// detection is wrong, rather than a control everyone has to reason about.
document.getElementById('stage-trim-bars').addEventListener('change', (e) => {
  stage.trimBars = e.target.checked;
  layoutTimeline();
  renderFrame();
});

// Bootstrap calls all live at the very bottom of this file, next to init() — see
// the note there. Running them here would reach const declarations further down.

document.getElementById('btn-crop').addEventListener('click', () => {
  cropping = !cropping;
  // Mutually exclusive with mask-adjust — see the note above bindMaskControls().
  if (cropping && maskAdjusting) {
    maskAdjusting = false;
    document.getElementById('btn-mask-adjust').classList.remove('active');
  }
  document.getElementById('btn-crop').classList.toggle('active', cropping);
  setStatus(cropping ? 'Drag the edges of the preview to crop' : '');
  renderFrame();
});

document.getElementById('btn-crop-reset').addEventListener('click', () => {
  const cur = getCurrentSegment();
  if (!cur) return;
  // Re-detect rather than clearing outright, so resetting a manual crop doesn't
  // also bring the letterbox bars back.
  detectLetterbox(cur.src.videoEl, cur.src.duration).then((crop) => {
    cur.src.crop = crop;
    layoutTimeline();
    renderFrame();
    setStatus(crop ? 'Crop reset to auto letterbox trim' : 'Crop cleared');
  });
});

document.getElementById('btn-zoom-all').addEventListener('click', () => {
  if (!isLoaded()) return;
  pushHistory();
  autoApplyZooms();
  renderTimeline();
  renderZoomSettings();
  renderFrame();
  setStatus(`${project.zoomKeyframes.length} zooms applied`);
});

document.getElementById('btn-zoom-none').addEventListener('click', () => {
  if (!isLoaded()) return;
  pushHistory();
  project.zoomKeyframes = [];
  selectedKeyframeId = null;
  invalidateCamera();
  renderTimeline();
  renderZoomSettings();
  renderFrame();
  setStatus('All zooms cleared');
});

document.getElementById('btn-add-video').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  // Shared by "Choose a video…" (nothing loaded yet) and "Add clip" (something
  // already is) — same distinction the drop handler below makes.
  if (file) await addVideoFile(file, { primary: !isLoaded() });
});

// Turns a file into a source on the timeline. Shared by "Add clip" and by the
// standalone editor's opening drop — the only difference is `primary`.
//
// A primary file is given `kind: 'recording'`. That is not a fib for its own sake:
// subtitles, the caption overlay and the per-clip webcam toggle all key off that
// kind, so an uploaded video gets exactly the same capabilities a capture would
// instead of a quietly reduced subset. What it does not get is a click log, which
// only exists for something this extension recorded — so zooms on an uploaded file
// are the ones you place yourself.
async function addVideoFile(file, { primary = false } = {}) {
  if (!/^video\//.test(file.type) && !/\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name)) {
    setStatus(`"${file.name}" does not look like a video file.`);
    return null;
  }

  setStatus(`Opening "${file.name}"…`);
  const url = URL.createObjectURL(file);
  const videoEl = document.createElement('video');
  videoEl.src = url;
  videoEl.preload = 'auto';

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('the browser could not read it')), 15000);
      videoEl.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once: true });
      videoEl.addEventListener('error', () => {
        clearTimeout(timeout);
        const c = videoEl.error && videoEl.error.code;
        // 4 is MEDIA_ERR_SRC_NOT_SUPPORTED, which for video almost always means the
        // container is fine but the codec is not — worth saying, because "failed to
        // load" sends people looking at the file rather than at the format.
        reject(new Error(c === 4 ? 'this browser cannot decode that codec' : 'the file could not be read'));
      }, { once: true });
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    setStatus(`Could not open "${file.name}" — ${err.message}.`);
    return null;
  }

  attachAudioGraph(videoEl);

  const durationMs = await resolveDurationMs(videoEl, 0);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    URL.revokeObjectURL(url);
    setStatus(`Could not read the length of "${file.name}".`);
    return null;
  }
  await seekTo(videoEl, 0);

  const source = {
    id: nextSourceId++,
    kind: primary ? 'recording' : 'file',
    name: file.name,
    videoEl,
    url,
    file,
    // generateSubtitles() transcribes recordingSource().blob; a File is a Blob.
    blob: primary ? file : null,
    duration: durationMs,
    crop: null,
    thumbs: null,
    peaks: null,
  };
  project.sources.push(source);

  const segment = {
    id: nextSegmentId++,
    sourceId: source.id,
    in: 0,
    out: durationMs,
    speed: 1,
  };
  project.segments.push(segment);
  selectedSegmentId = segment.id;

  if (primary) {
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    baseOutputSize = { w: canvas.width, h: canvas.height };
    playhead.segIndex = 0;
    playhead.localMs = 0;
    document.body.classList.remove('no-video');
    // Name the project after the file, minus the extension — it is the best guess
    // available, and it is what the export will be called.
    initRecordingName({ pageTitle: file.name.replace(/\.[^.]+$/, ''), source: 'tab' });
    renderCaptionList();
  }

  renderTimeline();
  renderClipPanel();
  renderFrame();
  setStatus(primary ? `Opened "${file.name}"` : `Added "${file.name}"`);

  generateThumbnails(source).catch((err) => console.warn('[editor] thumbnails failed', err));
  generateWaveform(source).catch((err) => console.warn('[editor] waveform failed', err));
  return source;
}

// ---------- standalone editor ----------
//
// Reached by opening the editor with no ?session — from the popup's "Open editor",
// or just by visiting the URL. The whole window is a drop target, because a
// drop-zone you have to aim at is a worse drop zone.

function initStandalone() {
  document.body.classList.add('no-video');
  canvas.width = 1280;
  canvas.height = 720;
  baseOutputSize = { w: canvas.width, h: canvas.height };
  renderFrame();
  setStatus('');

  const pick = () => document.getElementById('file-input').click();
  document.getElementById('btn-open-video').addEventListener('click', pick);

  // Save to Drive uploads through the extension — on an extension page directly, and
  // from a hosted page through the bridge iframe, which needs the ?ext= id the
  // extension appends when *it* opens the editor. Someone who arrived from the
  // marketing site has neither, so the button could only ever produce an error about
  // a missing extension id. Hide it rather than let them find that out by clicking.
  if (!IS_EXTENSION_ORIGIN && !qs.get('ext')) {
    document.getElementById('btn-drive').hidden = true;
  }
}

function initDropTarget() {
  let depth = 0; // dragenter/dragleave fire per child element, so count instead of toggling

  window.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    depth += 1;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    // The first video dropped becomes the project; later ones append as clips.
    await addVideoFile(file, { primary: !isLoaded() });
  });
}

document.getElementById('btn-split').addEventListener('click', splitAtPlayhead);
document.getElementById('btn-add-zoom').addEventListener('click', addZoomAtPlayhead);
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

// Keyboard shortcuts, skipped while typing in a field.
window.addEventListener('keydown', (e) => {
  if (!isLoaded()) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    splitAtPlayhead();
  } else if (e.key === ' ') {
    e.preventDefault();
    if (playing) pause(); else play();
  }
});

// Undo/redo get their own listener: the one above bails out on any modifier key,
// which is exactly the case this needs. Still skipped while typing in a field, so
// Ctrl/Cmd+Z in a caption text box uses the browser's native text-field undo
// instead of reaching into the project history.
window.addEventListener('keydown', (e) => {
  if (!isLoaded()) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (!(e.metaKey || e.ctrlKey)) return;

  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    redo();
  }
});

window.addEventListener('resize', () => {
  if (!isLoaded()) return; // renderRuler and layout both read the timeline
  layoutTimeline();
  renderRuler();
  // The canvas display size changed, so the overlays' px offsets are stale.
  renderFrame();
});

// ---------- subtitles ----------

// Cue grouping is an editorial decision, not a model one, so it happens here rather
// than in the worker: break on a long pause, at sentence ends, or once a line gets
// too long to read comfortably.
const CUE_MAX_CHARS = 84;
const CUE_MAX_MS = 6000;
const CUE_PAUSE_MS = 700;

function groupWordsIntoCues(words) {
  const cues = [];
  let current = null;

  words.forEach((word) => {
    const endsSentence = /[.!?]$/.test(word.text);
    if (current) {
      const gap = word.t - current.endT;
      const tooLong = (current.text.length + word.text.length + 1) > CUE_MAX_CHARS;
      const tooSlow = (word.endT - current.t) > CUE_MAX_MS;
      if (gap > CUE_PAUSE_MS || tooLong || tooSlow) {
        cues.push(current);
        current = null;
      }
    }
    if (!current) {
      current = { id: `cue-${cues.length + 1}`, t: word.t, endT: word.endT, text: word.text, words: [word] };
    } else {
      current.text += ` ${word.text}`;
      current.endT = word.endT;
      current.words.push(word);
    }
    if (endsSentence) {
      cues.push(current);
      current = null;
    }
  });
  if (current) cues.push(current);

  // Re-id after grouping so ids stay sequential and stable for the DOM list.
  return cues.map((c, i) => ({ ...c, id: `cue-${i + 1}` }));
}

// Whisper wants 16 kHz mono Float32. OfflineAudioContext does the resample and
// downmix in one pass — far less code than doing it by hand, and it's the same
// decode path generateWaveform already uses.
async function extractSpeechAudio(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  decodeCtx.close();

  const targetRate = 16000;
  const frames = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  // Level check. Fed silence or near-silence, Whisper doesn't fail — it invents
  // plausible-looking nonsense, which is indistinguishable from a broken model
  // unless we measure the input. The usual cause is the mic never opening, leaving
  // the recording with tab audio only.
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    sumSquares += samples[i] * samples[i];
  }
  const rms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;

  return {
    samples,
    peak,
    rms,
    durationS: samples.length / targetRate,
    sourceRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
  };
}

// Below this there's nothing worth transcribing. Normal speech sits well above it;
// a silent track is typically < 0.001.
const SPEECH_RMS_FLOOR = 0.0015;

let transcribeWorker = null;

let subtitleElapsedTimer = null;

// `ratio` null means "no measurable progress" — the bar animates instead of sitting
// at a fixed percentage, which is what made a long transcription look hung.
function setSubtitleProgress(text, ratio, detail) {
  const wrap = document.getElementById('subs-progress');
  const bar = document.getElementById('sub-progress');
  const label = document.getElementById('sub-progress-label');
  const detailEl = document.getElementById('sub-progress-detail');
  const elapsedEl = document.getElementById('sub-progress-elapsed');
  if (!wrap || !bar) return;

  if (text == null) {
    wrap.classList.add('hidden');
    clearInterval(subtitleElapsedTimer);
    subtitleElapsedTimer = null;
    return;
  }

  wrap.classList.remove('hidden');
  label.textContent = text;
  detailEl.textContent = detail || '';

  const indeterminate = ratio == null;
  bar.classList.toggle('indeterminate', indeterminate);
  bar.style.width = indeterminate ? '' : `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;

  // An elapsed counter is the cheapest possible proof that something is still
  // happening, and it's the thing people actually look for.
  if (!subtitleElapsedTimer) {
    const startedAt = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      elapsedEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    subtitleElapsedTimer = setInterval(tick, 1000);
  }
}

async function generateSubtitles() {
  const recording = recordingSource();
  if (!recording || !recording.blob) {
    setStatus('No recording audio to transcribe.');
    return;
  }
  const btn = document.getElementById('btn-transcribe');
  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Transcribing…';

  try {
    setSubtitleProgress('Reading audio', null, 'decoding and resampling');
    const audio = await extractSpeechAudio(recording.blob);
    if (!audio.samples.length) throw new Error('the recording has no audio track');

    console.info('[editor] speech audio', {
      durationS: Math.round(audio.durationS),
      sourceRate: audio.sourceRate,
      channels: audio.channels,
      peak: audio.peak.toFixed(4),
      rms: audio.rms.toFixed(5),
    });

    // Refuse rather than hand Whisper silence and present its hallucinations as a
    // transcript.
    if (audio.rms < SPEECH_RMS_FLOOR) {
      throw new Error(
        `the recording's audio is silent (level ${audio.rms.toFixed(5)}). `
        + 'Was the microphone enabled and working? Only tab audio is captured otherwise.'
      );
    }

    if (!transcribeWorker) {
      // Relative to the document, since editor.js is a classic script and has no
      // import.meta. The worker itself is a module, so it can use import.meta.url
      // to resolve the vendored model paths.
      transcribeWorker = new Worker('transcribe.worker.js', { type: 'module' });
    }

    let wordLevel = true;
    const words = await new Promise((resolve, reject) => {
      const cleanup = () => {
        transcribeWorker.removeEventListener('message', onMessage);
        transcribeWorker.removeEventListener('error', onError);
        transcribeWorker.removeEventListener('messageerror', onError);
      };
      const onMessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          setSubtitleProgress(msg.message, msg.ratio, msg.detail);
        } else if (msg.type === 'done') {
          cleanup();
          wordLevel = msg.wordLevel !== false;
          resolve(msg.words || []);
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.error));
        }
      };
      // A module worker that fails to load reports an `error` *event*, not an
      // exception — without this the promise simply never settles and the button
      // appears to do nothing at all. The worker is discarded so a retry rebuilds it.
      const onError = (e) => {
        cleanup();
        transcribeWorker.terminate();
        transcribeWorker = null;
        reject(new Error(e.message
          ? `worker failed: ${e.message}`
          : 'the transcription worker could not start — check that vendor/ is present and complete'));
      };
      transcribeWorker.addEventListener('message', onMessage);
      transcribeWorker.addEventListener('error', onError);
      transcribeWorker.addEventListener('messageerror', onError);
      // Transferred, not copied — the buffer can be tens of MB.
      // ?asr=webgpu opts into the faster-but-less-reliable backend.
      transcribeWorker.postMessage(
        {
          type: 'TRANSCRIBE',
          audio: audio.samples,
          device: qs.get('asr') || undefined,
          model: captionModel,
          modelBase: MODEL_BASE_URL || undefined,
        },
        [audio.samples.buffer]
      );
    });

    setSubtitleProgress('Building text', 0.98);
    // Hand-written cues aren't Whisper's to overwrite — a re-run replaces what it
    // transcribed, and merges the typed ones back in by time.
    const handWritten = project.captions.filter((c) => c.manual);
    project.captions = groupWordsIntoCues(words);
    if (handWritten.length) {
      project.captions = [...project.captions, ...handWritten].sort((a, b) => a.t - b.t);
    }
    if (!wordLevel) {
      // Fallback path returned phrase-level chunks, so "words" are whole phrases —
      // highlighting them would light up an entire line at a time.
      project.captions.forEach((cue) => { cue.words = null; });
      captionStyle.wordHighlight = false;
      renderSubtitleControls();
    }
    await saveCaptions();
    renderCaptionList();
    renderCaptionLane();
    renderFrame();
    setSubtitleProgress(null);
    setStatus(project.captions.length
      ? `${project.captions.length} subtitle lines generated${wordLevel ? '' : ' (no word timings available)'}`
      : 'No speech was detected in the recording');
  } catch (err) {
    setSubtitleProgress(null);
    setStatus(`Subtitles failed: ${err.message || err}`);
    console.error('[editor] transcription failed', err);
  } finally {
    btn.disabled = false;
    btn.textContent = btnLabel;
  }
}

async function saveCaptions() {
  // An uploaded file has no session to store against, and a random key would save
  // cues that could never be found again. Editing still works; only persistence is
  // skipped, which is the honest behaviour for a file the editor does not own.
  if (!sessionId) return;
  try {
    if (IS_EXTENSION_ORIGIN) {
      if (typeof drSaveCaptions !== 'function') await loadScript('../db.js');
      await drSaveCaptions(sessionId, project.captions);
    } else {
      await bridgeRequest(
        { type: 'DR_SAVE_CAPTIONS', sessionId, cues: project.captions },
        'DR_CAPTIONS_SAVED'
      );
    }
  } catch (err) {
    console.warn('[editor] could not save captions', err);
  }
}

async function loadCaptions(id) {
  try {
    if (IS_EXTENSION_ORIGIN) {
      if (typeof drLoadCaptions !== 'function') await loadScript('../db.js');
      return await drLoadCaptions(id);
    }
    const msg = await bridgeRequest({ type: 'DR_REQUEST_CAPTIONS', sessionId: id }, 'DR_CAPTIONS');
    return msg.cues || null;
  } catch (err) {
    console.warn('[editor] could not load captions', err);
    return null;
  }
}

// ---------- subtitles UI ----------

const SUB_STYLES = [
  { id: 'box', name: 'Boxed' },
  { id: 'outline', name: 'Outline' },
  { id: 'shadow', name: 'Shadow' },
];

// Which speech model to transcribe with. Both are vendored; see vendor/README.md for
// the size and accuracy each buys. "Accurate" is the default because a wrong word costs
// more to fix by hand than the extra wait costs to sit through — but a long recording on
// a slow machine is exactly when you want the cheap one, so it stays one click away.
// Where model weights are fetched from. Empty means alongside the editor
// (`../vendor/models/`), which is right for local serving and the bundled build.
//
// Set an absolute URL (WITH trailing slash) to serve weights from a separate host —
// the escape hatch for GitHub Pages, which refuses the 157 MB Accurate decoder
// outright. Point it at a bucket (R2, S3+CloudFront…) laid out exactly like
// vendor/models/, with CORS allowing GET and HEAD from the site's origin; the
// worker inherits it, so the probe and the actual weight fetches always agree.
const MODEL_BASE_URL = '';

// `dir` must match the worker's MODELS registry in transcribe.worker.js — it is what
// the availability probe below checks for on disk.
const SUB_MODELS = [
  { id: 'accurate', name: 'Accurate', dir: 'whisper-small.en-timestamped', title: 'whisper-small.en — better on names, jargon and accents; roughly 5× the transcription time' },
  { id: 'base', name: 'Fast', dir: 'whisper-base.en-timestamped', title: 'whisper-base.en — quickest; rougher on names and jargon' },
];

// A deployment may legitimately ship only some models: GitHub refuses any file over
// 100 MB, so the Accurate decoder (157 MB) cannot be pushed there at all, and
// site/.gitignore excludes it. Without this probe, picking Accurate on such a host
// would sit through the whole model-load progress bar and then fail with a raw 404 —
// so instead each model's config is HEAD-checked up front and missing ones are
// removed from the choice entirely. A network error keeps the option (hiding a model
// that exists is worse than a late failure); only a definite 404 removes it.
async function detectAvailableModels() {
  const present = await Promise.all(SUB_MODELS.map(async (m) => {
    try {
      const res = await fetch(`${MODEL_BASE_URL || '../vendor/models/'}${m.dir}/config.json`, { method: 'HEAD' });
      return res.ok;
    } catch (_) {
      return true;
    }
  }));
  if (present.every(Boolean)) return;

  for (let i = SUB_MODELS.length - 1; i >= 0; i -= 1) {
    if (!present[i]) SUB_MODELS.splice(i, 1);
  }
  if (SUB_MODELS.length && !SUB_MODELS.some((m) => m.id === captionModel)) {
    captionModel = SUB_MODELS[0].id;
  }
  renderSubtitleControls();
}
const SUB_MODEL_KEY = 'demoRecorder.subtitleModel';

// Persisted rather than per-session: whichever the user settled on is a preference about
// their machine and their speech, not about this one recording.
let captionModel = 'accurate';
try {
  const saved = localStorage.getItem(SUB_MODEL_KEY);
  if (saved && SUB_MODELS.some((m) => m.id === saved)) captionModel = saved;
} catch (_) {
  // storage blocked (private mode, site settings) — the default is fine
}

const SUB_POSITIONS = [
  { id: 'bottom', name: 'Bottom', x: 0.5, y: 0.91 },
  { id: 'top', name: 'Top', x: 0.5, y: 0.09 },
];

function renderSubtitleControls() {
  const styles = document.getElementById('sub-styles');
  styles.innerHTML = '';
  SUB_STYLES.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = s.name;
    btn.classList.toggle('active', captionStyle.style === s.id);
    btn.addEventListener('click', () => {
      captionStyle.style = s.id;
      renderSubtitleControls();
      renderFrame();
    });
    styles.appendChild(btn);
  });

  const models = document.getElementById('sub-models');
  models.innerHTML = '';
  SUB_MODELS.forEach((m) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = m.name;
    btn.title = m.title;
    btn.classList.toggle('active', captionModel === m.id);
    btn.addEventListener('click', () => {
      captionModel = m.id;
      try {
        localStorage.setItem(SUB_MODEL_KEY, m.id);
      } catch (_) {
        // storage blocked — the choice still applies for this session
      }
      renderSubtitleControls();
    });
    models.appendChild(btn);
  });

  const positions = document.getElementById('sub-positions');
  positions.innerHTML = '';
  SUB_POSITIONS.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = p.name;
    // Free dragging means captions often sit at no preset; highlight only on an
    // actual match, same as the webcam corner buttons.
    btn.classList.toggle('active',
      Math.abs(captionStyle.x - p.x) < 0.01 && Math.abs(captionStyle.y - p.y) < 0.01);
    btn.addEventListener('click', () => {
      captionStyle.x = p.x;
      captionStyle.y = p.y;
      renderSubtitleControls();
      renderFrame();
    });
    positions.appendChild(btn);
  });

  document.getElementById('sub-enabled').checked = captionStyle.enabled;
  document.getElementById('sub-highlight').checked = captionStyle.wordHighlight;
  document.getElementById('sub-size').value = captionStyle.fontSize;
  document.getElementById('sub-size-val').textContent = `${Math.round(captionStyle.fontSize * 100)}%`;
  document.getElementById('sub-color').value = captionStyle.color;
  document.getElementById('sub-highlight-color').value = captionStyle.highlightColor;
}

function bindSubtitleControls() {
  document.getElementById('btn-transcribe').addEventListener('click', generateSubtitles);
  document.getElementById('btn-add-cue').addEventListener('click', addManualCue);

  document.getElementById('sub-size').addEventListener('input', (e) => {
    captionStyle.fontSize = parseFloat(e.target.value);
    document.getElementById('sub-size-val').textContent = `${Math.round(captionStyle.fontSize * 100)}%`;
    renderFrame();
  });
  document.getElementById('sub-enabled').addEventListener('change', (e) => {
    captionStyle.enabled = e.target.checked;
    renderFrame();
  });
  document.getElementById('sub-highlight').addEventListener('change', (e) => {
    captionStyle.wordHighlight = e.target.checked;
    renderFrame();
  });
  document.getElementById('sub-color').addEventListener('input', (e) => {
    captionStyle.color = e.target.value;
    renderFrame();
  });
  document.getElementById('sub-highlight-color').addEventListener('input', (e) => {
    captionStyle.highlightColor = e.target.value;
    renderFrame();
  });

  document.getElementById('btn-srt').addEventListener('click', () => {
    if (!project.captions.length) return setStatus('No subtitles to export yet.');
    downloadBlob(new Blob([buildSrt()], { type: 'text/plain' }), fileNameFor('srt'));
  });
  document.getElementById('btn-vtt').addEventListener('click', () => {
    if (!project.captions.length) return setStatus('No subtitles to export yet.');
    downloadBlob(new Blob([buildVtt()], { type: 'text/vtt' }), fileNameFor('vtt'));
  });
}

const MANUAL_CUE_MS = 2500;   // default length of a hand-added cue
const MANUAL_CUE_MIN_MS = 400; // ...unless the next cue starts sooner than that

// Add a cue by hand at the playhead. Transcription isn't the only way subtitles get
// written: a recording with no narration still wants captions, and a mumbled word is
// often faster to type than to re-record. Times are stored in recording-source ms,
// exactly like a transcribed cue, so trimming and speed changes carry it correctly.
async function addManualCue() {
  const cur = getCurrentSegment();
  if (!cur || cur.type !== 'recording') {
    setStatus('Subtitles belong to the screen recording — move the playhead onto it.');
    return;
  }

  const t = Math.max(0, Math.round(playhead.localMs));
  if (project.captions.some((c) => t >= c.t && t <= c.endT)) {
    setStatus("There's already text at that moment — edit it, or move the playhead.");
    return;
  }

  // Don't run over whatever comes next; a cue that overlaps its neighbour would make
  // activeCue() pick by array order rather than by time.
  const next = project.captions
    .filter((c) => c.t > t)
    .reduce((soonest, c) => (soonest == null || c.t < soonest.t ? c : soonest), null);
  const room = next ? next.t - t : Infinity;
  if (room < MANUAL_CUE_MIN_MS) {
    setStatus('Not enough space before the next line of text — move the playhead.');
    return;
  }

  const cue = {
    id: `cue-manual-${nextManualCueId++}`,
    t,
    endT: t + Math.min(MANUAL_CUE_MS, room - 1),
    text: '',
    // No per-word timings to have: nothing was spoken at a known time. The renderer
    // treats the whole cue as one "word", so the highlight still behaves.
    words: null,
    // Survives a re-run of transcription, which otherwise replaces every cue.
    manual: true,
  };

  pushHistory();
  project.captions.push(cue);
  project.captions.sort((a, b) => a.t - b.t);
  focusCueId = cue.id;
  await saveCaptions();
  renderCaptionList();
  renderCaptionLane();
  renderFrame();
  setStatus(`Text added at ${fmtShort(t)} — type it in`);
}

// Set by addManualCue so the new row's input takes focus once it exists; a cue you
// have to click into before typing is a cue you'd rather have typed straight into.
let focusCueId = null;
let nextManualCueId = 1;

// The cue list is editable because transcription is never perfect — product names
// and jargon in particular always need a pass.
function renderCaptionList() {
  const root = document.getElementById('subs-list');
  root.innerHTML = '';
  document.getElementById('subs-hint').classList.toggle('hidden', project.captions.length > 0);
  const count = project.captions.length;
  document.getElementById('subs-count').textContent = count
    ? `${count} line${count === 1 ? '' : 's'} of text`
    : 'No text yet';

  project.captions.forEach((cue) => {
    const row = document.createElement('div');
    row.className = 'sub-row';
    row.dataset.cueId = cue.id;

    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'sub-time';
    time.textContent = fmtShort(cue.t);
    time.title = 'Jump here';
    time.addEventListener('click', () => {
      const globalMs = recordingTimeToGlobal(cue.t);
      if (globalMs != null) seekToGlobalElapsed(globalMs);
      else setStatus('That text sits in footage you trimmed away.');
    });

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'sub-text';
    text.value = cue.text;
    text.placeholder = 'Caption text…';
    // Once per editing session (focus), not per keystroke ('input' fires on every
    // one) — undo reverts the whole edit back to what it read before this pass.
    text.addEventListener('focus', () => pushHistory());
    // Commit on every keystroke for a hand-typed cue, so the preview shows the words
    // appearing as they're typed rather than only on blur.
    text.addEventListener('input', () => {
      cue.text = text.value;
      cue.words = null;
      renderCaptionLane();
      renderFrame();
    });
    text.addEventListener('change', () => {
      cue.text = text.value;
      // Editing text invalidates per-word timings for this cue; drop them so the
      // highlight doesn't light up words that are no longer there.
      cue.words = null;
      saveCaptions();
      renderCaptionLane();
      renderFrame();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sub-del';
    del.textContent = '✕';
    del.title = 'Delete text';
    del.addEventListener('click', () => {
      pushHistory();
      project.captions = project.captions.filter((c) => c.id !== cue.id);
      saveCaptions();
      renderCaptionList();
      renderCaptionLane();
      renderFrame();
    });

    row.append(time, text, del);
    root.appendChild(row);

    if (focusCueId === cue.id) {
      focusCueId = null;
      text.focus();
      // The rail scrolls; a focused row below the fold is no better than an unfocused
      // one. block:'nearest' so an already-visible row doesn't jump.
      row.scrollIntoView({ block: 'nearest' });
    }
  });
}

function renderCaptionLane() {
  const lane = document.getElementById('caption-lane');
  const has = project.captions.length > 0;
  lane.classList.toggle('hidden', !has);
  lane.innerHTML = '';
  if (!has) return;

  const total = totalOutputDurationMs();
  const width = lane.clientWidth;
  if (!total || !width) return;

  project.captions.forEach((cue) => {
    const start = recordingTimeToGlobal(cue.t);
    if (start == null) return; // trimmed away
    const end = recordingTimeToGlobal(cue.endT);
    const x1 = (start / total) * width;
    const x2 = end == null ? x1 + 6 : (end / total) * width;
    const bar = document.createElement('div');
    bar.className = 'caption-bar';
    bar.style.left = `${x1}px`;
    bar.style.width = `${Math.max(4, x2 - x1)}px`;
    bar.title = cue.text;
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      seekToGlobalElapsed(start);
    });
    lane.appendChild(bar);
  });
}

// Keeps the visible cue in sync with playback, so the list follows the video.
function highlightActiveCue() {
  const cur = getCurrentSegment();
  if (!cur || cur.type !== 'recording' || !project.captions.length) return;
  const sourceMs = playhead.localMs;
  const active = activeCue(sourceMs);
  document.querySelectorAll('.sub-row').forEach((row) => {
    row.classList.toggle('current', !!active && row.dataset.cueId === active.id);
  });
}

// ---------- subtitle sidecar files ----------

function pad2(n) { return String(n).padStart(2, '0'); }

function timecode(ms, srt) {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const frac = String(Math.floor(total % 1000)).padStart(3, '0');
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}${srt ? ',' : '.'}${frac}`;
}

// Cue times must be expressed in *output* time, not source time: after trims,
// deletions and speed changes the two differ, and a sidecar built from source time
// would drift against the exported video.
function cuesInOutputTime() {
  const out = [];
  project.captions.forEach((cue) => {
    // An untyped cue would become a numbered but blank entry in the sidecar, which
    // some players render as a flash of empty caption box.
    if (!cueHasText(cue)) return;
    const start = recordingTimeToGlobal(cue.t);
    const end = recordingTimeToGlobal(cue.endT);
    // Dropped entirely if it fell inside footage that was trimmed away.
    if (start == null && end == null) return;
    // Clamp cues that straddle a cut.
    const from = start != null ? start : recordingTimeToGlobal(cue.t + 1) ?? 0;
    const to = end != null ? end : from + 1200;
    if (to <= from) return;
    out.push({ from, to, text: cue.text });
  });
  return out.sort((a, b) => a.from - b.from);
}

function buildSrt() {
  return cuesInOutputTime()
    .map((c, i) => `${i + 1}\n${timecode(c.from, true)} --> ${timecode(c.to, true)}\n${c.text}\n`)
    .join('\n');
}

function buildVtt() {
  const body = cuesInOutputTime()
    .map((c) => `${timecode(c.from, false)} --> ${timecode(c.to, false)}\n${c.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

// ---------- QA capture panel ----------

let capture = null;
let debugTab = 'network';
let debugFilter = '';
let debugRowEls = [];

function initDebugPanel(logs) {
  capture = logs;
  const panel = document.getElementById('debug-panel');
  const hasData = logs && ((logs.network && logs.network.length) || (logs.console && logs.console.length));
  if (!hasData) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  document.getElementById('count-network').textContent = (logs.network || []).length;
  document.getElementById('count-console').textContent = (logs.console || []).length;

  // Be explicit about the two ways this capture is incomplete, rather than
  // letting empty response bodies read as a bug.
  const notes = [];
  const dropped = logs.dropped || {};
  if (dropped.network || dropped.console) {
    notes.push(`Capture hit its size limit — ${dropped.network || 0} requests and ${dropped.console || 0} console entries were dropped (oldest first).`);
  }
  if (logs.responseBodiesLimited) {
    notes.push('Response bodies are only available for requests the page made via fetch/XHR — images, documents and beacons show headers only.');
  }
  const note = document.getElementById('debug-note');
  note.textContent = notes.join(' ');
  note.classList.toggle('hidden', !notes.length);

  renderDebugList();
}

document.querySelectorAll('.debug-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    debugTab = tab.dataset.tab;
    document.querySelectorAll('.debug-tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderDebugList();
  });
});

document.getElementById('debug-filter').addEventListener('input', (e) => {
  debugFilter = e.target.value.toLowerCase();
  renderDebugList();
});

function debugEntries() {
  if (!capture) return [];
  const list = debugTab === 'network' ? (capture.network || []) : (capture.console || []);
  if (!debugFilter) return list;
  return list.filter((entry) => {
    const haystack = debugTab === 'network'
      ? `${entry.method} ${entry.url} ${entry.status || ''} ${entry.type || ''}`
      : `${entry.level} ${entry.text}`;
    return haystack.toLowerCase().includes(debugFilter);
  });
}

// Captured data is page-controlled — URLs, headers and console text can contain
// anything — so it must never be interpolated into innerHTML unescaped.
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function statusClass(entry) {
  if (entry.failed || entry.error) return 'bad';
  if (entry.status >= 500) return 'bad';
  if (entry.status >= 400) return 'warn';
  return 'ok';
}

function renderDebugList() {
  const root = document.getElementById('debug-list');
  root.innerHTML = '';
  debugRowEls = [];
  const entries = debugEntries();

  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'debug-empty';
    empty.textContent = debugFilter ? 'Nothing matches that filter.' : 'Nothing captured.';
    root.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'debug-row';

    const summary = document.createElement('div');
    summary.className = 'debug-summary';
    if (debugTab === 'network') {
      summary.innerHTML = `
        <span class="debug-time">${fmtShort(entry.t)}</span>
        <span class="debug-method">${escapeHtml(entry.method || '')}</span>
        <span class="debug-status ${statusClass(entry)}">${entry.failed ? 'ERR' : (entry.status || '—')}</span>
        <span class="debug-url" title="${escapeHtml(entry.url || '')}">${escapeHtml(entry.url || '')}</span>
        <span class="debug-type">${escapeHtml(entry.type || entry.bodySource || '')}</span>
      `;
    } else {
      summary.innerHTML = `
        <span class="debug-time">${fmtShort(entry.t)}</span>
        <span class="debug-level ${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span>
        <span class="debug-text">${escapeHtml(entry.text || '')}</span>
      `;
    }
    row.appendChild(summary);

    // Clicking a row jumps the video to the moment it happened — the whole point
    // of capturing against the video's clock.
    summary.addEventListener('click', (e) => {
      if (e.target.closest('.debug-detail')) return;
      // entry.t is recording-source time; map it onto the edited output.
      const globalMs = recordingTimeToGlobal(entry.t);
      if (globalMs != null) seekToGlobalElapsed(globalMs);
      row.classList.toggle('open');
      if (row.classList.contains('open') && !row.querySelector('.debug-detail')) {
        row.appendChild(buildDebugDetail(entry));
      }
    });

    root.appendChild(row);
    debugRowEls.push({ el: row, entry });
  });
}

function headerTable(title, headers) {
  if (!headers || !headers.length) return '';
  const rows = headers
    .map((h) => `<div class="hdr"><span>${escapeHtml(h.name)}</span><span>${escapeHtml(h.value)}</span></div>`)
    .join('');
  return `<section><h4>${title}</h4>${rows}</section>`;
}

function bodyBlock(title, body, note) {
  if (!body) return note ? `<section><h4>${title}</h4><p class="muted">${note}</p></section>` : '';
  return `<section><h4>${title}</h4><pre>${escapeHtml(body)}</pre></section>`;
}

// POSIX shell quoting: wrap in single quotes and escape embedded ones by
// closing, emitting an escaped quote, and reopening ('\'').
function shellQuote(value) {
  return String(value == null ? '' : value).replace(/'/g, "'\\''");
}

// Mirrors DevTools' "Copy as cURL" (bash flavour) — the form that pastes into a
// bug report and imports into Postman/Insomnia.
function toCurl(entry) {
  const parts = [`curl '${shellQuote(entry.url)}'`];
  const method = (entry.method || 'GET').toUpperCase();
  if (method !== 'GET') parts.push(`-X ${method}`);

  (entry.requestHeaders || []).forEach((h) => {
    if (!h || !h.name) return;
    // HTTP/2 pseudo-headers aren't valid curl headers.
    if (h.name.startsWith(':')) return;
    parts.push(`-H '${shellQuote(h.name)}: ${shellQuote(h.value)}'`);
  });

  if (entry.requestBody) parts.push(`--data-raw '${shellQuote(entry.requestBody)}'`);

  // Line continuations keep long commands readable when pasted.
  return parts.join(' \\\n  ');
}

async function copyToClipboard(text, btn) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // Clipboard API can be blocked (not focused, permissions); fall back.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = label; }, 1200);
}

function buildDebugDetail(entry) {
  const detail = document.createElement('div');
  detail.className = 'debug-detail';

  if (debugTab === 'console') {
    detail.innerHTML = `
      ${entry.source ? `<section><h4>Source</h4><pre>${escapeHtml(entry.source)}</pre></section>` : ''}
      <section><h4>Message</h4><pre>${escapeHtml(entry.text || '')}</pre></section>
      ${entry.stack ? `<section><h4>Stack</h4><pre>${escapeHtml(entry.stack)}</pre></section>` : ''}
    `;
    return detail;
  }

  const timing = entry.endT != null ? `${Math.max(0, entry.endT - entry.t)} ms` : 'unknown';
  detail.innerHTML = `
    <div class="debug-actions">
      <button type="button" class="ghost copy-curl">Copy as cURL</button>
      <button type="button" class="ghost copy-url">Copy URL</button>
    </div>
    <section><h4>General</h4>
      <div class="hdr"><span>URL</span><span>${escapeHtml(entry.url || '')}</span></div>
      <div class="hdr"><span>Method</span><span>${escapeHtml(entry.method || '')}</span></div>
      <div class="hdr"><span>Status</span><span>${entry.failed ? escapeHtml(entry.error || 'failed') : (entry.status || '—')}</span></div>
      <div class="hdr"><span>Duration</span><span>${timing}</span></div>
      ${entry.fromCache ? '<div class="hdr"><span>Cache</span><span>served from cache</span></div>' : ''}
      ${entry.unpaired ? '<div class="hdr"><span>Note</span><span>captured by the page probe only</span></div>' : ''}
    </section>
    ${headerTable('Request headers', entry.requestHeaders)}
    ${headerTable('Response headers', entry.responseHeaders)}
    ${bodyBlock('Payload', entry.requestBody, entry.requestBodyKind === 'binary' ? 'Binary body — not captured.' : null)}
    ${bodyBlock('Response', entry.responseBody, 'Not available — only fetch/XHR responses can be captured.')}
    ${entry.truncated ? '<p class="muted">Body truncated at 128 KB.</p>' : ''}
  `;

  const curlBtn = detail.querySelector('.copy-curl');
  curlBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't re-seek/collapse the row
    copyToClipboard(toCurl(entry), curlBtn);
  });
  if (!entry.requestHeaders || !entry.requestHeaders.length) {
    // Cached requests never fire onSendHeaders, so the command would be missing
    // auth headers — better to say so than hand over a curl that 401s.
    curlBtn.title = 'Request headers were not captured for this request, so the command may be incomplete.';
  }

  const urlBtn = detail.querySelector('.copy-url');
  urlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyToClipboard(entry.url || '', urlBtn);
  });

  return detail;
}

// Highlight whichever row corresponds to the current playhead position.
function syncDebugToPlayhead() {
  if (!capture || !debugRowEls.length) return;
  if (!document.getElementById('debug-follow').checked) return;
  // Captured entries are timestamped against the screen recording, so they only
  // line up while the playhead is inside a recording segment — not an added clip.
  const cur = getCurrentSegment();
  if (!cur || cur.type !== 'recording') {
    debugRowEls.forEach(({ el }) => el.classList.remove('current'));
    return;
  }
  const nowT = playhead.localMs;
  let best = null;
  debugRowEls.forEach(({ el, entry }) => {
    el.classList.remove('current');
    if (entry.t <= nowT && (!best || entry.t > best.entry.t)) best = { el, entry };
  });
  if (best) best.el.classList.add('current');
}

// ---------- HAR / console export ----------

function toHar() {
  const entries = (capture.network || []).map((e) => ({
    startedDateTime: new Date((capture.startedAt || Date.now()) + e.t).toISOString(),
    time: e.endT != null ? Math.max(0, e.endT - e.t) : -1,
    request: {
      method: e.method || 'GET',
      url: e.url || '',
      httpVersion: 'HTTP/1.1',
      headers: e.requestHeaders || [],
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: e.requestBody ? e.requestBody.length : 0,
      ...(e.requestBody ? { postData: { mimeType: 'application/octet-stream', text: e.requestBody } } : {}),
    },
    response: {
      status: e.status || 0,
      statusText: e.statusText || '',
      httpVersion: 'HTTP/1.1',
      headers: e.responseHeaders || [],
      cookies: [],
      content: {
        size: e.responseBody ? e.responseBody.length : (e.responseSize || 0),
        mimeType: 'application/octet-stream',
        ...(e.responseBody ? { text: e.responseBody } : {}),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: e.responseSize || -1,
    },
    cache: {},
    timings: { send: 0, wait: e.endT != null ? Math.max(0, e.endT - e.t) : -1, receive: 0 },
    _demoRecorder: { t: e.t, bodySource: e.bodySource, unpaired: !!e.unpaired },
  }));

  return {
    log: {
      version: '1.2',
      creator: { name: 'Click & Record', version: '0.1.0' },
      pages: [],
      entries,
    },
  };
}

document.getElementById('btn-download-har').addEventListener('click', () => {
  if (!capture) return;
  const blob = new Blob([JSON.stringify(toHar(), null, 2)], { type: 'application/json' });
  downloadBlob(blob, fileNameFor('har'));
});

document.getElementById('btn-download-console').addEventListener('click', () => {
  if (!capture) return;
  const blob = new Blob([JSON.stringify(capture.console || [], null, 2)], { type: 'application/json' });
  downloadBlob(blob, fileNameFor('console.json'));
});

// ---------- save to Drive ----------

document.getElementById('btn-drive').addEventListener('click', async () => {
  const btn = document.getElementById('btn-drive');
  btn.disabled = true;
  const original = btn.innerHTML; // keeps the icon, which textContent would drop
  btn.textContent = 'Uploading…';
  try {
    // Uses whatever format and quality the export dialog is set to, so a Drive upload
    // and a local export of the same recording are the same file.
    const plan = exportPlan();
    const filename = fileNameFor(plan.format.ext);

    // Render the edited composition first — Drive should get what the user sees,
    // not the raw capture sitting in IndexedDB.
    setStatus('Rendering video for upload…');
    const blob = await renderComposition(plan);
    if (!blob) {
      setStatus('Upload cancelled — nothing was rendered or sent.');
      return;
    }

    setStatus('Uploading to Google Drive…');
    let result;
    if (IS_EXTENSION_ORIGIN) {
      // This page is an extension page here, so it can talk to chrome.identity
      // and Drive directly.
      if (typeof drDriveUpload !== 'function') await loadScript('../drive.js');
      result = { ok: true, ...(await drDriveUpload(blob, filename)) };
    } else {
      // The hosted page can't reach chrome.identity, so the bridge (an extension
      // page) performs the upload. Blobs survive structured clone by reference.
      const msg = await bridgeRequest(
        { type: 'DR_UPLOAD_TO_DRIVE', sessionId, filename, blob },
        'DR_UPLOAD_RESULT',
        600000
      );
      result = msg.result;
    }
    if (!result || !result.ok) throw new Error((result && result.error) || 'Upload failed.');
    setStatus(`Saved to Google Drive as ${result.name || filename}`);
    window.open(result.link, '_blank', 'noopener');
  } catch (err) {
    setStatus(`Drive upload failed: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

// ---------- export ----------

// ---------- export settings ----------
//
// MediaRecorder can produce MP4/H.264 in current Chrome, which is worth offering as the
// default: WebM is smaller for the same quality but still gets refused by plenty of
// editors, phones and upload forms. Candidates are probed rather than assumed, and a
// format with nothing supported simply isn't shown.

const EXPORT_FORMATS = [
  {
    id: 'mp4',
    name: 'MP4',
    ext: 'mp4',
    note: 'H.264 + AAC. Plays and imports everywhere — the safe choice.',
    mimes: [
      'video/mp4;codecs=avc1.640028,mp4a.40.2', // High profile
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // Baseline, wider device support
      'video/mp4',
    ],
  },
  {
    id: 'webm',
    name: 'WebM',
    ext: 'webm',
    note: 'VP9 + Opus. Noticeably smaller at the same quality; ideal for the web, '
      + 'awkward in some editors.',
    mimes: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  },
];

// Bits per pixel per frame. Screen recordings are mostly flat colour with hard text
// edges, and those edges are the first thing a thin bitrate smears — so these run higher
// than you'd use for camera footage.
// The floors matter as much as the ratios. Export used to be a flat 8 Mbps whatever the
// resolution, which worked out generous at 720p (~0.29 bpp) and thin at 1080p (~0.13) —
// the second of those is what made exports look soft. Scaling by pixel count fixes 1080p,
// but a per-pixel rate alone would have made 720p *worse* than it was, so High keeps the
// old 8 Mbps as its floor and is the default.
const EXPORT_QUALITIES = [
  {
    id: 'high',
    name: 'High',
    bpp: 0.28,
    minBitrate: 8_000_000,
    // Inset shrinks the recording inside a fixed canvas, so its pixels get resampled down
    // and text softens. Rendering the export larger by the same proportion puts the
    // recording back at (at least) its native resolution. This is the one real fix for
    // the long-standing "inset trades resolution" problem.
    compensateInset: true,
  },
  { id: 'balanced', name: 'Balanced', bpp: 0.20, minBitrate: 4_000_000 },
  { id: 'small', name: 'Small', bpp: 0.11, minBitrate: 1_500_000, maxHeight: 720 },
];

// Beyond this, real-time encoding starts dropping frames on ordinary hardware — and a
// dropped frame is a worse artefact than a slightly soft one.
const EXPORT_MAX_WIDTH = 2560;
const EXPORT_FPS = 30;

// How much faster than 1x the source <video> elements are played during the fast
// export capture loop (see captureExportFrames). VideoFrame timestamps come from
// the output timeline, not wall-clock, so this only changes throughput, never
// correctness — it exists purely to get through decode+composite+encode faster
// than real time. Not a validated ceiling, just a starting point: raise it if
// hardware keeps up cleanly, lower it if frames start dropping.
const EXPORT_DECODE_SPEEDUP = 4;

let exportFormatId = null;   // resolved on first use, once support is known
let exportQualityId = 'high';

function availableExportFormats() {
  return EXPORT_FORMATS
    .map((f) => ({ ...f, mime: f.mimes.find((m) => MediaRecorder.isTypeSupported(m)) }))
    .filter((f) => f.mime);
}

// H.264 requires even dimensions, and an odd-sized canvas is a silent encoder failure.
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Works out exactly what will be encoded, so the dialog can state it rather than
// promising "high quality" and hoping.
function exportPlan() {
  const formats = availableExportFormats();
  const format = formats.find((f) => f.id === exportFormatId) || formats[0];
  const quality = EXPORT_QUALITIES.find((q) => q.id === exportQualityId) || EXPORT_QUALITIES[0];

  let scale = 1;
  if (quality.compensateInset) {
    // stage.padding is a fraction of the smaller dimension, applied to both sides.
    const visible = 1 - 2 * stage.padding;
    if (visible > 0) scale = Math.min(1.5, 1 / visible);
  }
  if (quality.maxHeight && canvas.height * scale > quality.maxHeight) {
    scale = quality.maxHeight / canvas.height;
  }
  if (canvas.width * scale > EXPORT_MAX_WIDTH) scale = EXPORT_MAX_WIDTH / canvas.width;

  const width = even(canvas.width * scale);
  const height = even(canvas.height * scale);
  const videoBitsPerSecond = Math.round(
    Math.min(50_000_000, Math.max(quality.minBitrate, width * height * EXPORT_FPS * quality.bpp))
  );
  const audioBitsPerSecond = 128_000;
  const durationMs = totalOutputDurationMs();
  const estBytes = ((videoBitsPerSecond + audioBitsPerSecond) / 8) * (durationMs / 1000);

  return { format, quality, width, height, videoBitsPerSecond, audioBitsPerSecond, durationMs, estBytes };
}

function fmtBytes(bytes) {
  if (!bytes || !isFinite(bytes)) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderExportDialog() {
  const plan = exportPlan();
  const formats = availableExportFormats();
  exportFormatId = plan.format ? plan.format.id : null;

  const formatRoot = document.getElementById('export-formats');
  formatRoot.innerHTML = '';
  formats.forEach((f) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = f.name;
    btn.classList.toggle('active', plan.format && f.id === plan.format.id);
    btn.addEventListener('click', () => { exportFormatId = f.id; renderExportDialog(); });
    formatRoot.appendChild(btn);
  });
  document.getElementById('export-format-note').textContent = plan.format ? plan.format.note : '';

  const qualityRoot = document.getElementById('export-qualities');
  qualityRoot.innerHTML = '';
  EXPORT_QUALITIES.forEach((q) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'frame-option ghost';
    btn.textContent = q.name;
    btn.classList.toggle('active', q.id === plan.quality.id);
    btn.addEventListener('click', () => { exportQualityId = q.id; renderExportDialog(); });
    qualityRoot.appendChild(btn);
  });

  const mbps = (plan.videoBitsPerSecond / 1_000_000).toFixed(1);
  const secs = Math.round(plan.durationMs / 1000);

  // Both formats now prefer the WebCodecs fast path (renderCompositionWebCodecs /
  // renderCompositionWebCodecsMp4) — offline audio pre-render + a cranked-up decode
  // rate means neither is bound to the recording's own duration any more. This is a
  // cheap synchronous approximation of mp4FastExportSupported() for the dialog's
  // copy only; the real (async, codec-specific) check happens at export time in
  // renderComposition(), which is what actually decides whether MP4 falls back to
  // the real-time path.
  const likelyFast = plan.format && supportsWebCodecs() && (
    plan.format.id === 'webm' ? typeof window.WebMMuxer !== 'undefined'
      : plan.format.id === 'mp4' ? typeof window.Mp4Muxer !== 'undefined'
        : false
  );

  document.getElementById('export-estimate').textContent =
    `${plan.width}×${plan.height} · ${mbps} Mbps · about ${fmtBytes(plan.estBytes)}. `
    + (likelyFast
      ? `Renders frame-by-frame rather than in real time, so it usually finishes well before the video’s own length (${secs ? `${secs}s` : 'its length'}).`
      : `Rendered in real time, so it takes roughly ${secs ? `${secs}s` : 'as long as the video'}.`);

  document.getElementById('export-go').disabled = !plan.format || !plan.durationMs;

  document.getElementById('export-hint').textContent = likelyFast
    ? 'Runs in the background — switching tabs, letting your screen lock, or your computer sleeping the display won’t interrupt it.'
    : 'This renders in real time, so it takes about as long as the final video’s length. It’s safe to switch tabs — export pauses and picks back up exactly where it left off.';
}

// Set by the Cancel button on the export overlay and read by the render loop. A whole
// object rather than a bare boolean so the loop closes over a stable reference.
const exportAbort = { requested: false };

function requestExportCancel() {
  if (exportAbort.requested) return;
  exportAbort.requested = true;
  const btn = document.getElementById('btn-export-cancel');
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
}

function openExportDialog() {
  if (!isLoaded()) return setStatus('Nothing to export yet.');
  renderExportDialog();
  document.getElementById('export-dialog').classList.remove('hidden');
}

function closeExportDialog() {
  document.getElementById('export-dialog').classList.add('hidden');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

document.getElementById('btn-export').addEventListener('click', openExportDialog);
document.getElementById('export-cancel').addEventListener('click', closeExportDialog);

// Clicking the backdrop dismisses; clicking inside must not.
document.getElementById('export-dialog').addEventListener('click', (e) => {
  if (e.target.id === 'export-dialog') closeExportDialog();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('export-dialog').classList.contains('hidden')) {
    closeExportDialog();
  }
});

document.getElementById('btn-export-cancel').addEventListener('click', requestExportCancel);

document.getElementById('export-go').addEventListener('click', async () => {
  const plan = exportPlan();
  closeExportDialog();
  try {
    const blob = await renderComposition(plan);
    // Cancelled: the partial file is deliberately thrown away rather than downloaded.
    // Half a video with no indication of where it stops is worse than none.
    if (!blob) {
      setStatus('Export cancelled — nothing was saved.');
      return;
    }
    downloadBlob(blob, fileNameFor(plan.format.ext));
    setStatus(`Exported ${plan.width}×${plan.height} ${plan.format.name} · ${fmtBytes(blob.size)}`);
  } catch (err) {
    setStatus(`Export failed: ${err.message || err}`);
    console.error('[editor] export failed', err);
  }
});

// Renders the whole composition — trims, zooms, stage look, appended clips — and
// returns it as a Blob. Both Export and Save-to-Drive go through here, so Drive
// gets the *edited* video rather than the raw capture.
// WebM prefers the WebCodecs pipeline (renderCompositionWebCodecs) whenever
// VideoEncoder/AudioEncoder/WebMMuxer are available — real, direct browser support,
// not a polyfill. MP4 prefers its own WebCodecs pipeline
// (renderCompositionWebCodecsMp4, site/vendor/mp4-muxer) but only once its specific
// AAC/H.264 codec support is confirmed; otherwise both fall back to the older
// real-time MediaRecorder path (renderCompositionRealtime), which always works.
async function renderComposition(plan = exportPlan()) {
  if (plan.format.id === 'webm' && supportsWebCodecsExport()) {
    return renderCompositionWebCodecs(plan);
  }
  // MP4's fast path needs its own AAC/H.264 capability probe (checked here, before
  // any UI/pause side effects) rather than the WebM branch's — a browser can have
  // WebCodecs without supporting this particular codec pair, and the fallback below
  // needs to be silent, not a half-started export that then throws.
  if (plan.format.id === 'mp4' && await mp4FastExportSupported(plan)) {
    return renderCompositionWebCodecsMp4(plan);
  }
  return renderCompositionRealtime(plan);
}

function supportsWebCodecs() {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
}

function supportsWebCodecsExport() {
  return supportsWebCodecs() && typeof window.WebMMuxer !== 'undefined';
}

async function mp4FastExportSupported(plan) {
  if (typeof window.Mp4Muxer === 'undefined' || !supportsWebCodecs()) return false;
  const videoConfig = {
    codec: 'avc1.640028',
    width: plan.width,
    height: plan.height,
    bitrate: plan.videoBitsPerSecond,
    framerate: EXPORT_FPS,
  };
  const audioConfig = {
    codec: 'mp4a.40.2',
    sampleRate: editorAudioCtx.sampleRate,
    numberOfChannels: 2,
    bitrate: plan.audioBitsPerSecond,
  };
  try {
    const [videoSupport, audioSupport] = await Promise.all([
      VideoEncoder.isConfigSupported(videoConfig),
      AudioEncoder.isConfigSupported(audioConfig),
    ]);
    return videoSupport.supported && audioSupport.supported;
  } catch (_) {
    return false;
  }
}

// ---------- export: WebCodecs pipeline (WebM + MP4), faster than real time ----------
//
// Frame-by-frame encoding instead of real-time MediaRecorder capture. The original
// motivation: the previous design played the source in real time, drew each
// requestAnimationFrame tick to a canvas, and captured that canvas with
// MediaRecorder — which meant export was entirely at the mercy of anything that
// could throttle rAF (a hidden tab, a sleeping display, heavy system load):
// drawing would silently stall while the recorder and the underlying <video> kept
// running, producing a file with a frozen picture and perfectly normal audio for
// the rest of its length.
//
// Video is driven by requestVideoFrameCallback rather than requestAnimationFrame.
// Unlike rAF, rVFC is tied to the media decode pipeline, not to compositing, so it
// keeps firing regardless of tab visibility or display state — the same property
// this codebase already relies on in extension/offscreen.js to keep the webcam
// pipeline alive in a hidden offscreen document. Each callback draws the frame that
// actually just arrived (via renderInto(), unchanged — same function the live
// preview uses) and hands it to a VideoEncoder.
//
// Audio used to come from the live Web Audio graph via MediaStreamTrackProcessor,
// which coupled export to real-time playback: both video and audio were driven by
// the same real <video> elements, so nothing could run faster than the recording's
// own duration. renderExportAudio() below decodes every source once and mixes the
// whole timeline through an OfflineAudioContext instead — the same
// decodeAudioData + OfflineAudioContext primitive extractSpeechAudio() already uses
// to prep Whisper's input — which renders at CPU speed, not wall-clock speed. With
// audio decoupled, the video side no longer has anything real-time to stay in sync
// with either, so captureExportFrames() plays each source at
// EXPORT_DECODE_SPEEDUP× during capture; VideoFrame timestamps come from the output
// timeline (currentOutputElapsedMs), not wall-clock, so decoding faster only changes
// throughput, never correctness.
//
// One accepted trade: AudioBufferSourceNode.playbackRate doesn't preserve pitch the
// way the live <video> path's preservesPitch did, so a segment with a manual speed
// change (speedOf(seg) != 1) will sound pitch-shifted in the export. Segments at 1x
// are unaffected.
//
// Muxing is the one piece WebCodecs doesn't provide — MediaRecorder did that for
// free. site/vendor/webm-muxer and site/vendor/mp4-muxer (MIT, both
// Vanilagy/*-muxer, same author/API) package the encoders' output into a standard,
// playable file.

const decodedAudioCache = new WeakMap(); // source -> decoded AudioBuffer, reused across exports

async function decodedAudioFor(src) {
  const blob = src.blob || src.file;
  if (!blob) return null; // a source with no audio track
  if (decodedAudioCache.has(src)) return decodedAudioCache.get(src);
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    decodeCtx.close();
  }
  decodedAudioCache.set(src, decoded);
  return decoded;
}

// Pre-renders the whole output timeline's audio in one shot instead of capturing it
// live off playing <video> elements — see the pipeline note above for why this is
// what actually unlocks faster-than-real-time export.
async function renderExportAudio(plan) {
  const sampleRate = editorAudioCtx.sampleRate;
  const numberOfChannels = 2;
  const totalFrames = Math.max(1, Math.ceil((plan.durationMs / 1000) * sampleRate));
  const offline = new OfflineAudioContext(numberOfChannels, totalFrames, sampleRate);

  for (let i = 0; i < segmentCount(); i += 1) {
    const { seg, src } = getSegmentByIndex(i);
    const decoded = await decodedAudioFor(src);
    if (!decoded) continue;
    const offsetS = seg.in / 1000;
    if (offsetS >= decoded.duration) continue;
    const node = offline.createBufferSource();
    node.buffer = decoded;
    node.playbackRate.value = speedOf(seg); // accepted pitch-shift trade for sped segments
    node.connect(offline.destination);
    const durationS = Math.min((seg.out - seg.in) / 1000, decoded.duration - offsetS);
    node.start(segmentOffsetMs(i) / 1000, offsetS, durationS);
  }

  return offline.startRendering();
}

// Feeds a fully-rendered AudioBuffer into a WebCodecs AudioEncoder. Runs once,
// before the video capture loop rather than interleaved with it — there's no live
// stream to keep pace with any more, so there's nothing gained by overlapping them.
async function pumpAudioBufferToEncoder(audioEncoder, audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const totalFrames = audioBuffer.length;
  const chunkFrames = Math.max(1, Math.round(audioBuffer.sampleRate * 0.02)); // ~20ms

  for (let start = 0; start < totalFrames; start += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - start);
    const data = new Float32Array(frames * channels);
    for (let ch = 0; ch < channels; ch += 1) {
      audioBuffer.copyFromChannel(data.subarray(ch * frames, (ch + 1) * frames), ch, start);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: audioBuffer.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: Math.round((start / audioBuffer.sampleRate) * 1_000_000),
      data,
    });
    audioEncoder.encode(audioData);
    audioData.close();
    if (audioEncoder.encodeQueueSize > 30) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// The fast paths never route audio through the live graph, but the sources still
// get played back (muted) at EXPORT_DECODE_SPEEDUP for their video frames — silence
// them the same way connectForExport/disconnectForExport used to, or export blasts
// sped-up, chipmunked audio out the speakers for no reason.
function silenceSourcesForFastExport() {
  project.sources.forEach((src) => {
    src.videoEl.muted = true;
    const gain = audioGainByVideo.get(src.videoEl);
    if (gain) { try { gain.disconnect(editorAudioCtx.destination); } catch (_) {} }
  });
}

function restoreSourcesAfterFastExport() {
  project.sources.forEach((src) => {
    src.videoEl.muted = false;
    const gain = audioGainByVideo.get(src.videoEl);
    if (gain) { try { gain.connect(editorAudioCtx.destination); } catch (_) {} }
  });
}

// preservesPitch is irrelevant here (this element's audio is never used — see
// renderExportAudio), but harmless to leave set. Rate is clamped to Chrome's
// practical playbackRate ceiling.
function applyExportDecodeSpeed(info) {
  info.src.videoEl.preservesPitch = true;
  info.src.videoEl.playbackRate = Math.min(16, speedOf(info.seg) * EXPORT_DECODE_SPEEDUP);
}

// Shared by both fast export paths (WebM and MP4) — walks the output timeline
// exactly once, handing each composited frame to whichever VideoEncoder the caller
// configured. The webcam bubble's own drift-correction (syncWebcamPlayback) is told
// about the same EXPORT_DECODE_SPEEDUP so it doesn't mistake the sped-up main clip
// for a huge desync and hard-resync-seek itself into a stall.
async function captureExportFrames(plan, videoEncoder, errorBox) {
  const w = plan.width;
  const h = plan.height;
  const totalMs = plan.durationMs;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const octx = outCanvas.getContext('2d', { alpha: false });

  let cancelled = false;

  playhead.segIndex = 0;
  const first = getSegmentByIndex(0);
  playhead.localMs = first.seg.in;
  await seekTo(first.src.videoEl, first.seg.in / 1000);
  applyExportDecodeSpeed(first);
  syncWebcamSeek(first.seg.in);

  await first.src.videoEl.play();
  syncWebcamPlayback(first, EXPORT_DECODE_SPEEDUP);

  let frameIndex = 0;
  const KEYFRAME_INTERVAL_FRAMES = EXPORT_FPS * 2; // a hint, not a hard requirement — see below

  await new Promise((resolve, reject) => {
    function captureNext() {
      const cur = getCurrentSegment();
      if (!cur) { resolve(); return; }
      if (exportAbort.requested) { cancelled = true; resolve(); return; }
      if (errorBox.error) { reject(errorBox.error); return; }

      cur.src.videoEl.requestVideoFrameCallback((_now, metadata) => {
        // The segment can have changed while this callback was in flight (a seek
        // between segments resolving) — that path already re-enters captureNext()
        // itself below, so a stale callback here just steps aside.
        const live = getCurrentSegment();
        if (!live || live.src !== cur.src) return;
        if (exportAbort.requested) { cancelled = true; resolve(); return; }
        if (errorBox.error) { reject(errorBox.error); return; }

        // metadata.mediaTime is the presentation time of the frame that's actually
        // ready right now — more accurate than reading videoEl.currentTime
        // separately, which could tick further between this callback firing and
        // the read.
        playhead.localMs = (metadata.mediaTime != null ? metadata.mediaTime * 1000 : live.src.videoEl.currentTime * 1000);
        syncWebcamPlayback(live, EXPORT_DECODE_SPEEDUP);
        renderInto(octx, w, h);

        const outputMs = currentOutputElapsedMs();
        const frame = new VideoFrame(outCanvas, { timestamp: Math.round(outputMs * 1000) });
        videoEncoder.encode(frame, { keyFrame: frameIndex % KEYFRAME_INTERVAL_FRAMES === 0 });
        frame.close();
        frameIndex += 1;

        document.getElementById('export-progress').textContent =
          `${Math.min(100, Math.round((outputMs / totalMs) * 100))}%`;

        const advance = () => {
          // Cheap backpressure: on hardware where encoding can't keep up with
          // capture, let the queue drain a little rather than piling up VideoFrames
          // (each one holds a full frame of raw pixel data) faster than they can be
          // consumed.
          if (videoEncoder.encodeQueueSize > 30) {
            setTimeout(captureNext, 30);
          } else {
            captureNext();
          }
        };

        if (playhead.localMs >= live.seg.out - 15) {
          const nextIndex = live.index + 1;
          if (nextIndex >= segmentCount()) { resolve(); return; }
          const next = getSegmentByIndex(nextIndex);
          playhead.segIndex = nextIndex;
          const contiguous = next.src === live.src
            && Math.abs(next.seg.in - live.seg.out) < 40
            && speedOf(next.seg) === speedOf(live.seg);
          if (contiguous) { advance(); return; }
          live.src.videoEl.pause();
          applyExportDecodeSpeed(next);
          syncWebcamSeek(next.seg.in);
          seekTo(next.src.videoEl, next.seg.in / 1000).then(() => {
            next.src.videoEl.play();
            captureNext();
          });
          return;
        }
        advance();
      });
    }
    captureNext();
  });

  return { cancelled };
}

function showExportOverlay() {
  pause();
  editorAudioCtx.resume();
  const overlay = document.getElementById('export-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('export-progress').textContent = '0%';
  document.getElementById('export-headline').classList.remove('paused');
  document.getElementById('export-spinner').classList.remove('paused');

  exportAbort.requested = false;
  const cancelBtn = document.getElementById('btn-export-cancel');
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel export';
  return overlay;
}

async function finishFastExport(overlay) {
  restoreSourcesAfterFastExport();
  project.sources.forEach((src) => {
    src.videoEl.pause();
    src.videoEl.playbackRate = 1;
  });
  pauseWebcam();

  await rewindToStart();
  renderFrame();

  overlay.classList.add('hidden');
  exportAbort.requested = false;
}

async function renderCompositionWebCodecs(plan) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    throw new Error('This browser supports WebCodecs but not requestVideoFrameCallback — cannot export.');
  }

  const overlay = showExportOverlay();
  const w = plan.width;
  const h = plan.height;
  const sampleRate = editorAudioCtx.sampleRate;
  const numberOfChannels = 2;

  let blob = null;

  // Everything from here down can throw (an unsupported encoder config, an encoder
  // error mid-export) in ways the older real-time path never could. Without this,
  // throwing out of the middle of the function would skip the teardown below
  // entirely, leaving the export overlay stuck open and every source muted/silenced.
  try {
    const videoConfig = {
      codec: 'vp09.00.10.08', // VP9 profile 0, level 1.0, 8-bit — broad Chromium support
      width: w,
      height: h,
      bitrate: plan.videoBitsPerSecond,
      framerate: EXPORT_FPS,
    };
    const audioConfig = { codec: 'opus', sampleRate, numberOfChannels, bitrate: plan.audioBitsPerSecond };

    const [videoSupport, audioSupport] = await Promise.all([
      VideoEncoder.isConfigSupported(videoConfig),
      AudioEncoder.isConfigSupported(audioConfig),
    ]);
    if (!videoSupport.supported) throw new Error(`This browser can't encode VP9 at ${w}×${h} — try a smaller export size.`);
    if (!audioSupport.supported) throw new Error(`This browser can't encode Opus audio at ${sampleRate}Hz.`);

    const target = new WebMMuxer.ArrayBufferTarget();
    const muxer = new WebMMuxer.Muxer({
      target,
      video: { codec: 'V_VP9', width: w, height: h, frameRate: EXPORT_FPS },
      audio: { codec: 'A_OPUS', sampleRate, numberOfChannels },
      // AudioData timestamps here start at 0 by construction (renderExportAudio
      // builds one buffer for the whole timeline), but 'offset' costs nothing and
      // guards against any future off-by-one at the seam.
      firstTimestampBehavior: 'offset',
    });

    const errorBox = { error: null };
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => { errorBox.error = err; },
    });
    videoEncoder.configure(videoConfig);

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (err) => { errorBox.error = err; },
    });
    audioEncoder.configure(audioConfig);

    const audioBuffer = await renderExportAudio(plan);
    await pumpAudioBufferToEncoder(audioEncoder, audioBuffer);
    await audioEncoder.flush();
    audioEncoder.close();

    silenceSourcesForFastExport();
    const { cancelled } = await captureExportFrames(plan, videoEncoder, errorBox);

    await videoEncoder.flush();
    videoEncoder.close();
    muxer.finalize();

    blob = cancelled ? null : new Blob([target.buffer], { type: 'video/webm' });
  } finally {
    await finishFastExport(overlay);
  }

  return blob;
}

// Structurally identical to renderCompositionWebCodecs above — same offline-audio
// pre-render, same decode-speedup capture loop — just muxed as MP4 (H.264/AAC via
// site/vendor/mp4-muxer) instead of WebM (VP9/Opus). Support (and therefore the
// real-time fallback) is decided by mp4FastExportSupported() before this is ever
// called, so no isConfigSupported check is repeated here.
async function renderCompositionWebCodecsMp4(plan) {
  const overlay = showExportOverlay();
  const w = plan.width;
  const h = plan.height;
  const sampleRate = editorAudioCtx.sampleRate;
  const numberOfChannels = 2;

  let blob = null;

  try {
    const videoConfig = {
      codec: 'avc1.640028', // High profile — matches the MP4 format's real-time mime choice
      width: w,
      height: h,
      bitrate: plan.videoBitsPerSecond,
      framerate: EXPORT_FPS,
    };
    const audioConfig = { codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: plan.audioBitsPerSecond };

    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({
      target,
      video: { codec: 'avc', width: w, height: h, frameRate: EXPORT_FPS },
      audio: { codec: 'aac', numberOfChannels, sampleRate },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    const errorBox = { error: null };
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => { errorBox.error = err; },
    });
    videoEncoder.configure(videoConfig);

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (err) => { errorBox.error = err; },
    });
    audioEncoder.configure(audioConfig);

    const audioBuffer = await renderExportAudio(plan);
    await pumpAudioBufferToEncoder(audioEncoder, audioBuffer);
    await audioEncoder.flush();
    audioEncoder.close();

    silenceSourcesForFastExport();
    const { cancelled } = await captureExportFrames(plan, videoEncoder, errorBox);

    await videoEncoder.flush();
    videoEncoder.close();
    muxer.finalize();

    blob = cancelled ? null : new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    await finishFastExport(overlay);
  }

  return blob;
}

// ---------- export: real-time MediaRecorder pipeline (MP4, and the WebCodecs fallback) ----------
async function renderCompositionRealtime(plan) {
  pause();
  editorAudioCtx.resume();
  const overlay = document.getElementById('export-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('export-progress').textContent = '0%';
  // Defensive reset: normally cleared by resumeFromHidden() before an export can
  // finish, but a stray leftover from an aborted prior run must not leak in.
  document.getElementById('export-headline').classList.remove('paused');
  document.getElementById('export-spinner').classList.remove('paused');

  exportAbort.requested = false;
  const cancelBtn = document.getElementById('btn-export-cancel');
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel export';

  // The export canvas is sized from the plan, not from the preview. Every stage
  // measurement is a fraction of the canvas's smaller dimension, so rendering at a
  // different size scales the whole composition rather than shifting it — which is what
  // makes the High preset's inset compensation safe.
  const w = plan.width;
  const h = plan.height;

  const exportDest = editorAudioCtx.createMediaStreamDestination();
  project.sources.forEach((src) => connectForExport(src.videoEl, exportDest));

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const octx = outCanvas.getContext('2d', { alpha: false });

  const canvasStream = outCanvas.captureStream(EXPORT_FPS);
  const outStream = new MediaStream([...canvasStream.getVideoTracks(), ...exportDest.stream.getAudioTracks()]);
  const mimeType = plan.format.mime;
  const recorder = new MediaRecorder(outStream, {
    mimeType,
    videoBitsPerSecond: plan.videoBitsPerSecond,
    audioBitsPerSecond: plan.audioBitsPerSecond,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));

  playhead.segIndex = 0;
  const first = getSegmentByIndex(0);
  playhead.localMs = first.seg.in;
  await seekTo(first.src.videoEl, first.seg.in / 1000);
  applySpeed(first);

  syncWebcamSeek(first.seg.in);

  const totalMs = totalOutputDurationMs();
  recorder.start();
  await first.src.videoEl.play();
  syncWebcamPlayback(first);

  // ---- tab-visibility guard --------------------------------------------------
  //
  // Export is real-time: renderInto() has to be called roughly once per output
  // frame, in step with how far the source video has actually played. That
  // pairing only holds while the tab is visible. Chrome throttles or fully stops
  // requestAnimationFrame in a hidden tab, but does NOT stop <video> playback —
  // so currentTime keeps advancing while renderInto() stops being called. The
  // segment-transition bookkeeping still ends up visiting every segment (a
  // Node harness confirmed that), but visually the frames that should have
  // shown the skipped stretch were simply never drawn — canvas.captureStream()
  // just keeps re-emitting whatever was on the canvas before the gap, which
  // reads as "part of the video is missing" once played back. This is also
  // consistent with something measured directly in this codebase: a canvas
  // capture stream in a hidden tab has produced literally 0 recorded bytes.
  //
  // The fix is to make hiding harmless rather than merely discouraged: pause the
  // recorder AND the currently-playing source in lockstep the instant the tab
  // goes hidden, and resume both together when it's visible again. Paused video
  // does not advance currentTime, so nothing drifts and nothing gets skipped —
  // the recording picks back up exactly where it left off. `pendingFrame` is
  // tracked and explicitly cancelled on hide so a stray already-queued rAF can
  // never sneak a tick in after the recorder has been told to pause, and the
  // loop's own first check re-confirms visibility before doing any work.
  let pendingFrame = null;
  let pausedForVisibility = false;

  const exportHeadline = document.getElementById('export-headline');
  const exportSpinner = document.getElementById('export-spinner');

  function pauseForHidden() {
    if (pausedForVisibility) return;
    pausedForVisibility = true;
    if (pendingFrame !== null) { cancelAnimationFrame(pendingFrame); pendingFrame = null; }
    if (recorder.state === 'recording') recorder.pause();
    const cur = getCurrentSegment();
    if (cur && !cur.src.videoEl.paused) cur.src.videoEl.pause();
    if (project.webcam && !project.webcam.videoEl.paused) project.webcam.videoEl.pause();
    exportHeadline.classList.add('paused');
    exportSpinner.classList.add('paused');
  }

  function resumeFromHidden() {
    if (!pausedForVisibility) return;
    pausedForVisibility = false;
    if (recorder.state === 'paused') recorder.resume();
    const cur = getCurrentSegment();
    if (cur) cur.src.videoEl.play().catch(() => {});
    exportHeadline.classList.remove('paused');
    exportSpinner.classList.remove('paused');
    pendingFrame = requestAnimationFrame(loop);
  }

  function onVisibilityChange() {
    if (document.hidden) pauseForHidden();
    else resumeFromHidden();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  // The tab could already be hidden when Export was clicked (e.g. triggered
  // programmatically, or focus moved during the confirmation dialog) — catch that
  // starting condition too, rather than only reacting to a later transition.
  if (document.hidden) pauseForHidden();

  // visibilitychange only reliably fires for switching tabs/apps — it does *not*
  // reliably fire when the display itself sleeps (a laptop's screen-idle timeout)
  // while this tab stays the nominal foreground one, and that throttles/stops rAF
  // exactly the same way a hidden tab does. Watching a static export-progress
  // screen for several minutes without touching the mouse or keyboard is exactly
  // when that idle timeout hits — so this can't be treated as an edge case.
  // setInterval is the backstop: unlike rAF, it isn't tied to compositing, so it
  // keeps a heartbeat regardless of *why* rendering stalled, and pauses/resumes
  // the same recorder+video lockstep loop() otherwise only reaches via that one
  // DOM event.
  let lastTickAt = performance.now();
  const STALL_THRESHOLD_MS = 500; // generous vs. a single slow frame under normal load
  const watchdogId = setInterval(() => {
    const stalled = performance.now() - lastTickAt > STALL_THRESHOLD_MS;
    if (stalled) pauseForHidden();
    else if (!document.hidden) resumeFromHidden();
  }, 250);

  function loop() {
    lastTickAt = performance.now();
    pendingFrame = null;
    // Belt and braces alongside the cancel-on-hide above: if some scheduling
    // order let a tick through right at the hidden/visible boundary, bail
    // rather than render or advance state on stale timing.
    if (pausedForVisibility || document.hidden) return;
    // Checked first so a cancel takes effect on the very next frame rather than after
    // whatever seek or segment change was about to happen.
    if (exportAbort.requested) { finish(); return; }
    const cur = getCurrentSegment();
    if (!cur) { finish(); return; }
    renderInto(octx, w, h);
    const elapsed = currentOutputElapsedMs();
    document.getElementById('export-progress').textContent = `${Math.min(100, Math.round((elapsed / totalMs) * 100))}%`;

    // Speed needs no special handling here: playbackRate makes the source run
    // faster in real time, and MediaRecorder simply captures fewer seconds.
    playhead.localMs = cur.src.videoEl.currentTime * 1000;
    syncWebcamPlayback(cur);
    if (playhead.localMs >= cur.seg.out - 15) {
      const nextIndex = playhead.segIndex + 1;
      if (nextIndex >= segmentCount()) { finish(); return; }
      const next = getSegmentByIndex(nextIndex);
      playhead.segIndex = nextIndex;
      const contiguous = next.src === cur.src
        && Math.abs(next.seg.in - cur.seg.out) < 40
        && speedOf(next.seg) === speedOf(cur.seg);
      if (contiguous) {
        pendingFrame = requestAnimationFrame(loop);
        return;
      }
      cur.src.videoEl.pause();
      applySpeed(next);
      syncWebcamSeek(next.seg.in);
      seekTo(next.src.videoEl, next.seg.in / 1000).then(() => {
        // The tab may have gone hidden while this seek was in flight; don't
        // resume playback (or schedule the next frame) into a paused export.
        if (pausedForVisibility) return;
        next.src.videoEl.play();
        pendingFrame = requestAnimationFrame(loop);
      });
      return;
    }
    pendingFrame = requestAnimationFrame(loop);
  }

  let finish;
  await new Promise((resolve) => {
    finish = resolve;
    if (!document.hidden) pendingFrame = requestAnimationFrame(loop);
    // else: pauseForHidden() already ran above; resumeFromHidden() starts the
    // loop once the tab is actually shown.
  });

  document.removeEventListener('visibilitychange', onVisibilityChange);
  clearInterval(watchdogId);
  // recorder.state is never 'paused' here: finish() is only reachable from inside
  // loop(), and loop() returns immediately without doing anything while
  // pausedForVisibility is true — so reaching this line already implies we are not
  // paused. stop() is spec-valid directly from 'paused' too if that ever changes,
  // so no need to resume() first — doing so would risk capturing one extra,
  // unwanted frame of stale canvas content between the resume and the stop.
  recorder.stop();
  await stopped;
  const cancelled = exportAbort.requested;
  // Built either way so the recorder's buffers are released; only returned if wanted.
  const blob = new Blob(chunks, { type: mimeType });

  project.sources.forEach((src) => {
    src.videoEl.pause();
    disconnectForExport(src.videoEl, exportDest); // also restores speaker monitoring
    src.videoEl.playbackRate = 1; // leave nothing sped up behind
  });
  pauseWebcam();

  await rewindToStart();
  renderFrame();

  overlay.classList.add('hidden');
  exportAbort.requested = false;
  return cancelled ? null : blob;
}

// ---------- start ----------
//
// Everything below runs last on purpose. These functions read `const` bindings
// declared throughout the file, and a `const` is in its temporal dead zone until
// execution reaches its line — so calling any of them earlier throws
// "Cannot access X before initialization" and aborts the whole script, leaving the
// editor half-wired. Function declarations hoist, which is what makes the mistake
// so easy: the call looks fine, the data isn't there yet.
renderSwatches();
renderFrameOptions();
renderAspectOptions();
renderSubtitleControls();
renderMaskControls();
initZoomTargetDrag();
initCropDrag();
initMaskDrag();
initScrubbing();
bindWebcamControls();
initCaptionDrag();
initWebcamDrag();
bindSubtitleControls();
bindMaskControls();
initDropTarget();
detectAvailableModels().catch(() => {}); // async; re-renders the model picker if one is absent

init().catch((err) => setStatus(`Error: ${err.message || err}`));
