// Service worker: coordinates tab capture, the offscreen recorder, click
// logging (content.js), optional QA capture (capture.js), and the editor tab.

importScripts('db.js', 'capture.js');

const OFFSCREEN_URL = 'offscreen.html';

// The "get ready" beat between hitting Start and tape rolling.
//
// Chrome ties chrome.tabCapture to the click that opened the popup, so the *stream*
// has to be acquired on that gesture and can't wait. The recorder doesn't have the
// same constraint, so it's held back by exactly this long and the countdown lands
// outside the file rather than inside it. Owned here, not in popup.js: the popup
// counts down to the instant the recorder was actually given, so the two can't
// disagree — and if the popup is closed mid-countdown the recording still starts.
//
// A round 3000, not the 3×700 the popup used to tick locally. The popup renders
// ceil(remaining / 1000), so this budget has to leave a full second of slack for the
// work still queued after it's minted — at 2100 a couple of hundred milliseconds of
// setup would drop the first digit shown straight to "2".
const COUNTDOWN_MS = 3000;

// Where to open the editor. The hosted page pulls the recording back through
// bridge.html, so the video still never leaves the machine.
//
// Change this to your deployed domain when you have one; the origin must also be
// added to the manifest's web_accessible_resources matches AND to
// ALLOWED_PARENT_ORIGINS in bridge.js. Override at runtime without editing code:
//   chrome.storage.local.set({ editorBaseUrl: 'http://localhost:3000' })   // local dev
// Set it to '' to fall back to the copy bundled inside the extension.
const DEFAULT_EDITOR_BASE_URL = 'https://clickandrecord.tech';

async function buildEditorUrl(sessionId) {
  // No session is legitimate: the editor also opens on its own, so you can drop in
  // a video you already have and use the same tools on it.
  const path = sessionId
    ? `editor/editor.html?session=${encodeURIComponent(sessionId)}`
    : 'editor/editor.html';
  let base = DEFAULT_EDITOR_BASE_URL;
  try {
    const stored = await chrome.storage.local.get('editorBaseUrl');
    if (stored.editorBaseUrl !== undefined) base = stored.editorBaseUrl;
  } catch (_) {
    // storage unavailable — keep the built-in default
  }
  if (!base) return chrome.runtime.getURL(path);
  const join = path.includes('?') ? '&' : '?';
  return `${base.replace(/\/+$/, '')}/${path}${join}ext=${chrome.runtime.id}`;
}

function idleState() {
  return {
    phase: 'idle', // idle | recording | processing
    sessionId: null,
    tabId: null,
    startTime: null,
    paused: false,
    options: null,
    clicks: [],
    typing: [],
    pageUrl: '',
    pageTitle: '',
  };
}

let state = idleState();

// MV3 service workers unload when idle, which would wipe `state` mid-recording —
// and then stopping would have no sessionId to save under (IndexedDB's "key path
// yielded a value that is not a valid key"), no options, and no click log. So the
// live state is mirrored into chrome.storage.session and restored on demand.
const DR_STATE_KEY = 'recordingState';

// Last start failure, surfaced by the popup on its next open. Session-scoped: a failure
// from a previous browser session is stale by definition. Declared up here with the other
// module constants rather than beside its user — `const` has no hoisting, and this file's
// history says that gets forgotten.
const DR_LAST_ERROR_KEY = 'lastStartError';

// Crash-recovery bookkeeping. Deliberately chrome.storage.local, not .session:
// session storage is wiped when Chrome itself dies, which is exactly the case
// this exists to survive — see checkForOrphanedRecording() below.
const DR_PENDING_RECOVERY_KEY = 'pendingRecovery';
function recSessionMetaKey(sessionId) {
  return `recSessionMeta:${sessionId}`;
}

async function setLastError(error) {
  try {
    await chrome.storage.session.set({ [DR_LAST_ERROR_KEY]: { error, at: Date.now() } });
  } catch (_) {
    // storage unavailable — the console message is all there is
  }
}

async function persistState() {
  try {
    await chrome.storage.session.set({ [DR_STATE_KEY]: state });
  } catch (err) {
    console.warn('[demo-recorder/background] could not persist state', err);
  }
}

async function restoreState() {
  if (state.phase !== 'idle') return; // in-memory copy is already current
  try {
    const stored = await chrome.storage.session.get(DR_STATE_KEY);
    const saved = stored[DR_STATE_KEY];
    if (saved && saved.phase && saved.phase !== 'idle') state = saved;
  } catch (_) {
    // storage unavailable — nothing to restore
  }
}

async function clearPersistedState() {
  try {
    await chrome.storage.session.remove(DR_STATE_KEY);
  } catch (_) {
    // nothing to do
  }
}

// No controls window: it needed its own OS window (which Chrome can't keep on top,
// so it hid behind the browser) and drawing controls into the recorded tab instead
// would bake them into the video. Recording is controlled from the toolbar popup,
// or the keyboard shortcut registered in the manifest, with the REC badge as the
// persistent indicator.

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // DISPLAY_MEDIA as well as USER_MEDIA: this document opens the window/screen picker
    // and holds the resulting display stream, not just the camera and mic.
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
    justification: 'Composite and record screen + webcam + mic for a product demo.',
  });
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// Safety net against a hang anywhere in the offscreen document's message handler.
// prepareCaptureInner()/stopCapture() do real, unbounded async work in there (camera
// permission, video playback, IndexedDB writes) — a single stalled await, now or in
// the future, means this call never resolves, which means startRecording()/
// stopRecording() never resolve, which means state.phase never leaves 'starting' /
// 'processing'. Every later attempt then fails with "A recording is already in
// progress." even though nothing is actually happening — which is exactly what an
// unawaited-timeout play() call did here before it was fixed. 20s is generous for
// anything that isn't actually stuck (camera/mic permission happens earlier, as its
// own step) and short enough that a genuinely stuck take fails fast and resets
// cleanly instead of silently locking recording out until the extension is reloaded.
const OFFSCREEN_MESSAGE_TIMEOUT_MS = 20000;

function sendToOffscreen(message, timeoutMs = OFFSCREEN_MESSAGE_TIMEOUT_MS) {
  const send = chrome.runtime.sendMessage(message)
    .catch((err) => ({ ok: false, error: err.message || String(err) }));
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({
      ok: false,
      error: `${message.type} timed out after ${timeoutMs}ms — the offscreen document may be stuck.`,
    }), timeoutMs);
  });
  return Promise.race([send, timeout]);
}

function resetState() {
  state = idleState();
  chrome.action.setBadgeText({ text: '' });
  clearPersistedState();
}

// stopRecording()'s failure branch and the RECORDING_ERROR handler both discard
// `state` outside the happy path — the one moment a take that's about to be
// treated as an orphan still has its clicks/typing log sitting in memory.
// resetState() (via clearPersistedState()) throws away chrome.storage.session
// too, so anything worth keeping has to be copied out first, not after.
async function harvestAndResetState() {
  if (state.sessionId) {
    try {
      const key = recSessionMetaKey(state.sessionId);
      const stored = await chrome.storage.local.get(key);
      await chrome.storage.local.set({
        [key]: { ...(stored[key] || {}), clicks: state.clicks, typing: state.typing },
      });
    } catch (err) {
      console.warn('[demo-recorder/background] could not harvest state before reset', err);
    }
  }
  resetState();
}

// Removes every trace of one session's crash-recovery artifacts: the durable
// chunk rows, its chunkMeta row, its recSessionMeta snapshot, and — if it's the
// one currently being offered — the pendingRecovery marker itself. Shared by
// discard, a successful recovery, and the scan's own self-heal/expiry paths.
async function cleanupOrphanArtifacts(sessionId) {
  const results = await Promise.allSettled([
    drDeleteChunks(sessionId),
    drDeleteChunkMeta(sessionId),
    chrome.storage.local.remove(recSessionMetaKey(sessionId)),
  ]);
  results.forEach((r) => {
    if (r.status === 'rejected') {
      console.warn('[demo-recorder/background] orphan cleanup step failed', r.reason);
    }
  });
  try {
    const stored = await chrome.storage.local.get(DR_PENDING_RECOVERY_KEY);
    const pending = stored[DR_PENDING_RECOVERY_KEY];
    if (pending && pending.sessionId === sessionId) {
      await chrome.storage.local.remove(DR_PENDING_RECOVERY_KEY);
    }
  } catch (_) {
    // storage unavailable — nothing to do
  }
}

// Looks for a recording that never reached stopCapture()'s final save: the
// offscreen document died, the browser crashed, or the extension got reloaded
// mid-take. Chunk rows in IndexedDB (written incrementally by offscreen.js's
// ondataavailable handlers) are the trail that's left behind — see db.js.
//
// Run after every service-worker (re)spawn and on every GET_STATE (i.e.
// whenever the popup opens), unconditionally — not gated on state.phase, since
// the offscreen-only-crash case is exactly state.phase reading 'recording'
// while nothing backs it up any more. Safe to call whenever: a genuinely live
// recording is never mistaken for an orphan (see the guards below).
async function checkForOrphanedRecording() {
  const ids = await drGetAllChunkMetaSessionIds().catch(() => []);
  if (!ids.length) return;

  // state.phase alone doesn't prove the offscreen document that owns it is
  // still alive — only Chrome's own context list does. If state claims a
  // recording is still going but the document is gone, state is stale; harvest
  // whatever it still remembers before this loop treats that session as an
  // orphan below.
  if (state.phase !== 'idle' && !(await hasOffscreenDocument())) {
    await harvestAndResetState();
  }

  for (const sessionId of ids) {
    // Genuinely still recording or mid-stop — not an orphan.
    if (state.phase !== 'idle' && state.sessionId === sessionId) continue;

    const finalized = await drLoadRecording(sessionId);
    if (finalized) {
      // stopCapture()'s own chunk cleanup didn't finish — self-heal, no prompt.
      await cleanupOrphanArtifacts(sessionId);
      continue;
    }

    const rows = await drListChunks(sessionId);
    if (!rows.some((r) => r.kind === 'screen')) {
      // Crashed before the first ~1s timeslice ever flushed — nothing to recover.
      await cleanupOrphanArtifacts(sessionId);
      continue;
    }

    const meta = await drLoadChunkMeta(sessionId);
    if (!meta || Date.now() - meta.startedAt > 48 * 60 * 60 * 1000) {
      // No meta, or a crash old enough that surfacing it now would be more
      // confusing than useful.
      await cleanupOrphanArtifacts(sessionId);
      continue;
    }

    await chrome.storage.local.set({
      [DR_PENDING_RECOVERY_KEY]: { sessionId, meta, discoveredAt: Date.now() },
    });
    return; // surface one at a time — resolve it before looking for another
  }
}

// Reassembles a crashed session's durable chunks into a normal finalized
// recording — after this, it's indistinguishable from one that reached a clean
// stop, and the existing editor hand-off works unchanged.
async function recoverSession(sessionId) {
  const meta = await drLoadChunkMeta(sessionId);
  if (!meta) return { ok: false, error: 'Nothing to recover.' };

  const rows = await drListChunks(sessionId);
  const screenRows = rows.filter((r) => r.kind === 'screen').sort((a, b) => a.seq - b.seq);
  const webcamRows = rows.filter((r) => r.kind === 'webcam').sort((a, b) => a.seq - b.seq);

  if (!screenRows.length) {
    await cleanupOrphanArtifacts(sessionId);
    return { ok: false, error: 'The recording had not captured any frames yet.' };
  }

  const finalMeta = {
    width: meta.width,
    height: meta.height,
    duration: Math.max(0, screenRows[screenRows.length - 1].ts - meta.startedAt),
    mimeType: meta.mimeType,
  };
  const blob = new Blob(screenRows.map((r) => r.blob), { type: meta.mimeType });
  await drSaveRecording(sessionId, blob, finalMeta);

  if (meta.hasWebcam && webcamRows.length) {
    const camBlob = new Blob(webcamRows.map((r) => r.blob), { type: meta.webcamMimeType });
    await drSaveWebcam(sessionId, camBlob, {
      mimeType: meta.webcamMimeType,
      duration: Math.max(0, webcamRows[webcamRows.length - 1].ts - meta.webcamStartedAt),
      startOffsetMs: Math.max(0, meta.webcamStartedAt - meta.startedAt),
    });
  }

  // Same payload shape onRecordingSaved() writes, so the editor's loadSession()
  // needs no idea this recording came from a crash rather than a clean stop.
  const stored = await chrome.storage.local.get(recSessionMetaKey(sessionId));
  const recMeta = stored[recSessionMetaKey(sessionId)] || {};
  const payload = {
    sessionId,
    meta: finalMeta,
    clicks: recMeta.clicks || [],
    typing: recMeta.typing || [],
    startTime: recMeta.startTime || meta.startedAt,
    pageUrl: recMeta.pageUrl || '',
    pageTitle: recMeta.pageTitle || '',
    source: recMeta.source || 'tab',
  };
  await chrome.storage.session.set({ [`session:${sessionId}`]: payload });

  await cleanupOrphanArtifacts(sessionId);
  chrome.tabs.create({ url: await buildEditorUrl(sessionId) });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // chrome.runtime.sendMessage delivers to every extension context with a listener,
  // including this one — so a message this file sent *to* offscreen.js (OFFSCREEN_*)
  // arrives back here too. Without this guard, handleMessage's default case answered
  // it with "Unknown message type" before offscreen.js's real, slower response (open
  // the camera, wait on video metadata, flush the recording to IndexedDB) came back —
  // and whichever answered first won the race. That's what made prepare/begin/stop
  // fail intermittently: this fast, wrong answer usually beat the real one.
  if (msg && typeof msg.type === 'string' && msg.type.startsWith('OFFSCREEN_')) return false;

  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    console.error('[demo-recorder/background]', err);
    sendResponse({ ok: false, error: err.message || String(err) });
  });
  return true; // keep the channel open for the async response
});

async function handleMessage(msg, sender) {
  // The worker may have been restarted since the recording began.
  await restoreState();

  switch (msg.type) {
    case 'GET_STATE': {
      // Read and clear together: an error is shown once, then it's history.
      let lastError = null;
      try {
        const stored = await chrome.storage.session.get(DR_LAST_ERROR_KEY);
        if (stored[DR_LAST_ERROR_KEY]) {
          lastError = stored[DR_LAST_ERROR_KEY].error;
          await chrome.storage.session.remove(DR_LAST_ERROR_KEY);
        }
      } catch (_) {
        // storage unavailable — nothing to report
      }
      // Unconditional, not gated on state.phase === 'idle': the offscreen-only-
      // crash case is exactly `state.phase` reading 'recording' while nothing
      // backs it up any more — checkForOrphanedRecording() has to be allowed to
      // notice that itself (via hasOffscreenDocument()), or it never gets the
      // chance to. It never mistakes a genuinely live recording for an orphan;
      // see its own guards.
      await checkForOrphanedRecording().catch((err) => {
        console.warn('[demo-recorder/background] orphan scan failed', err);
      });
      return { ...state, clickCount: state.clicks.length, lastError };
    }

    case 'GET_PENDING_RECOVERY': {
      const stored = await chrome.storage.local.get(DR_PENDING_RECOVERY_KEY).catch(() => ({}));
      return { pending: stored[DR_PENDING_RECOVERY_KEY] || null };
    }

    case 'RECOVER_SESSION':
      return recoverSession(msg.sessionId);

    case 'DISCARD_RECOVERY':
      await cleanupOrphanArtifacts(msg.sessionId);
      return { ok: true };

    case 'START_RECORDING':
      return startRecording(msg.options);

    case 'STOP_RECORDING':
      return stopRecording();

    case 'TOGGLE_PAUSE': {
      state.paused = !state.paused;
      await persistState();
      chrome.tabs.sendMessage(state.tabId, { type: 'SET_PAUSED', paused: state.paused }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_SET_PAUSED', paused: state.paused }).catch(() => {});
      return { ok: true, paused: state.paused };
    }

    case 'MEDIA_PERMISSION_RESULT': {
      const resolve = permissionWaiter;
      permissionWaiter = null;
      if (resolve) resolve({ ok: !!msg.ok, error: msg.error });
      return { ok: true };
    }

    case 'MEDIA_PERMISSION_CLOSED': {
      // Window dismissed without answering; don't leave startRecording hanging.
      const resolve = permissionWaiter;
      permissionWaiter = null;
      if (resolve) resolve({ ok: false, error: 'The permission window was closed.' });
      return { ok: true };
    }

    case 'OPEN_EDITOR':
      await chrome.tabs.create({ url: await buildEditorUrl(null) });
      return { ok: true };

    case 'REQUEST_MEDIA_PERMISSION':
      return requestMediaPermission({ video: !!msg.video, audio: !!msg.audio });

    case 'GET_MEDIA_PERMISSION':
      return { state: await mediaPermissionState() };

    case 'RECORDER_ROLLING':
      await adoptRecorderEpoch(msg.startedAt);
      return { ok: true };

    // The recorded window or screen went away (closed, or "Stop sharing"). Finish the
    // take rather than keep filming a frozen last frame — what's been captured so far
    // is worth keeping, and the editor opens on it as usual.
    case 'SOURCE_ENDED':
      if (state.phase === 'recording') {
        console.info('[demo-recorder/background] capture source ended; finishing the recording');
        await stopRecording();
      }
      return { ok: true };

    case 'PROBE_ENTRY':
      if (state.phase === 'recording' && !state.paused) {
        drCapAddProbeEntry(msg.entry);
      }
      return { ok: true };

    case 'CLICK_EVENT':
      // A negative offset means the click happened during the countdown, before the
      // recorder rolled — there's no frame for it to zoom into, so drop it rather
      // than hand the editor a zoom that starts before the video does.
      if (state.phase === 'recording' && !state.paused && msg.click.t >= 0) {
        state.clicks.push(msg.click);
        // Persisted per click so a worker restart can't lose the click log — these
        // arrive at human pace, so the write volume is trivial.
        await persistState();
        chrome.runtime.sendMessage({ type: 'CLICK_COUNT_UPDATE', count: state.clicks.length }).catch(() => {});
      }
      return { ok: true };

    case 'TYPING_INTERVAL':
      // One message per burst (content.js debounces locally), not per keystroke, so
      // this is as cheap to persist as a click. Clamped to >=0 for the same reason
      // clicks are dropped below zero — a burst starting during the countdown has no
      // frame before it to hold a zoom into.
      if (state.phase === 'recording' && !state.paused) {
        const start = Math.max(0, msg.interval.start);
        const end = Math.max(start, msg.interval.end);
        state.typing.push({ start, end });
        await persistState();
      }
      return { ok: true };

    case 'WIDGET_STOP_CLICKED':
      return stopRecording();

    case 'RECORDING_SAVED':
      // offscreen finished writing the blob to IndexedDB
      await onRecordingSaved(msg.sessionId, msg.meta);
      return { ok: true };

    case 'RECORDING_ERROR':
      drCapStop();
      await harvestAndResetState();
      checkForOrphanedRecording().catch((err) => {
        console.warn('[demo-recorder/background] orphan scan failed', err);
      });
      return { ok: true };

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

// The manifest only injects content.js into pages loaded *after* the
// extension starts, so a tab that was already open (or open across an
// extension reload) has no live content script — no click logging and no
// floating widget. Ping it, and inject on demand if nobody answers.
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong && pong.ok) return true;
  } catch (_) {
    // no listener on the other end — fall through and inject
  }
  try {
    // content.js pulls content.css into its own shadow root, so there's no
    // stylesheet to inject here.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (err) {
    // restricted page (chrome://, the Web Store, PDF viewer) — recording
    // still works, but clicks can't be logged there.
    console.warn('[demo-recorder/background] content script unavailable', err);
    return false;
  }
}

// probe.js must run in the page's MAIN world to wrap the page's own fetch/XHR
// and console; an isolated content script gets its own copies of those globals
// and would see nothing. The recording's start time is stashed on <html> so the
// probe can timestamp against the same clock as the video.
async function setProbeEpoch(tabId, startTime) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (t) => { document.documentElement.dataset.drStart = String(t); },
    args: [startTime],
  });
}

async function injectProbe(tabId, startTime) {
  try {
    await setProbeEpoch(tabId, startTime);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['probe.js'],
    });
    return true;
  } catch (err) {
    // Restricted page, or a CSP that blocks injection — webRequest capture still
    // works, we just lose response bodies and console output.
    console.warn('[demo-recorder/background] probe injection failed', err);
    return false;
  }
}

// chrome.tabCapture picks its own stream size, and if its aspect ratio doesn't
// match the tab, Chrome letterboxes the content into it with black bars. Asking
// for the tab's actual viewport dimensions avoids that.
async function getTabViewport(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      }),
    });
    return (res && res.result) || null;
  } catch (_) {
    return null; // restricted page — fall back to whatever Chrome gives us
  }
}

async function startRecording(options) {
  if (state.phase !== 'idle') {
    return { ok: false, error: 'A recording is already in progress.' };
  }

  // Claim the slot before the first await. Setting up the streams now takes as long
  // as the count-in, and the guard above only rejects re-entry once a phase is set —
  // without this, two Starts in quick succession would both get through and run two
  // recorders against one session.
  state = { ...idleState(), phase: 'starting' };
  try {
    return await setUpRecording(options);
  } catch (err) {
    // Every failure path has to release the slot. Left claimed, the guard above would
    // reject every later attempt with "already in progress" until the service worker
    // happened to restart.
    resetState();
    const error = err.message || String(err);
    // Stash it, because the reply below often reaches nobody. Choosing a window or screen
    // closes the popup — Chrome's picker takes focus — so the message port is already dead
    // by the time anything can go wrong, and the failure would otherwise be visible only in
    // the service worker console. The popup reads this back the next time it opens.
    await setLastError(error);
    return { ok: false, error };
  }
}


// Which surface is being recorded. 'tab' is the original behaviour and the only one
// where the extension can see inside what it's filming — see qaCaptureSupported().
const SOURCES = ['tab', 'window', 'screen'];

// Click-to-zoom works on all three sources. content.js maps each click into the
// recorded frame's own coordinate space — viewport for a tab, window bounds for a
// window, display bounds for a screen — and drops clicks that land outside it. See
// framePosition() there.
//
// What doesn't carry over is *coverage*: a content script only sees clicks inside web
// pages, so a screen recording gets zooms for clicks in Chrome tabs and none for clicks
// in other applications. That's a gap in what can be observed, not a reason to refuse.
//
// QA capture is a different case and stays tab-only. chrome.webRequest is filtered to a
// single tab, so pairing a window or desktop recording with one tab's network log
// invites exactly the wrong conclusion during a bug hunt — the log would look like
// evidence about everything on screen while describing one tab.
function qaCaptureSupported(source) {
  return source === 'tab';
}

// Window and screen sources never touch this file. The offscreen document calls
// `getDisplayMedia()`, which shows its own picker and returns a MediaStream directly — no
// stream id, so nothing has to be handed between contexts. Three earlier designs tried to
// mint an id here or in a picker window and pass it along; each failed differently, and
// `getDisplayStream()` in offscreen.js documents all three. Only tab capture still needs
// an id from the service worker, because Chrome ties `chrome.tabCapture` to the click that
// opened the popup.

// chrome.tabCapture.getMediaStreamId happily mints an id for a chrome://, the Chrome
// Web Store, or the built-in PDF viewer, and getUserMedia happily redeems it — but Chrome
// never delivers real frames for those origins, so the video track sits there producing
// nothing and the take ends as a 0-byte file with no error anywhere in the pipeline. Same
// restriction ensureContentScript already works around for click logging (see its comment
// above); tab capture has no equivalent fallback, so it has to be refused up front instead.
function isRestrictedTabUrl(url) {
  if (!url) return true; // no readable url — Chrome hides it on the same restricted pages
  return /^(chrome|edge|about|chrome-extension|devtools):/i.test(url)
    || /^https:\/\/chrome\.google\.com\/webstore/i.test(url)
    || /^https:\/\/chromewebstore\.google\.com/i.test(url);
}

async function setUpRecording(options) {
  const source = SOURCES.includes(options.source) ? options.source : 'tab';
  options = { ...options, source };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');

  if (source === 'tab' && isRestrictedTabUrl(tab.url)) {
    throw new Error(
      "This tab can't be recorded — chrome:// pages, the Chrome Web Store and the PDF "
      + 'viewer are off-limits to extensions. Switch to a regular tab, or record a window '
      + 'or your screen instead.'
    );
  }

  // Only tab capture needs an id from here, and it must be taken on the click that opened
  // the popup — Chrome ties chrome.tabCapture to that user gesture. Window and screen ids
  // are obtained by the offscreen document instead, for the reasons above.
  let streamId = null;
  if (source === 'tab') {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (err) {
      throw new Error(`Tab capture permission failed: ${err.message}`);
    }
  }

  // Enforced here as well as in the popup, so a stale options object can't switch it
  // back on for a source where the log would mislead.
  if (!qaCaptureSupported(source)) options.capture = false;

  // Get the camera/mic grant before the recorder starts. Done after
  // getMediaStreamId so the user gesture that authorises tab capture isn't spent
  // waiting on a prompt.
  if (options.webcam || options.mic) {
    // Not named `state`: this function owns the module-level recording state, and
    // shadowing it here is how a stray assignment ends up in the wrong place.
    const permState = await mediaPermissionState();
    if (permState !== 'granted') {
      const perm = await requestMediaPermission({ video: options.webcam, audio: options.mic });
      if (!perm.ok) {
        throw new Error(
          `Camera/microphone access is needed for those options: ${perm.error || 'not granted'}. `
          + 'Grant it, or turn off webcam and microphone and record the screen only.'
        );
      }
    }
  }

  await ensureOffscreenDocument();
  await ensureContentScript(tab.id);

  // Minted here rather than by offscreen at stop time: two contexts now write for
  // one session — offscreen saves the screen video, the controls window saves the
  // webcam — and both need the key up front so they can save independently.
  const sessionId = crypto.randomUUID();

  // Open the streams and build the recorders, but don't roll tape yet. This is the
  // slow part (getUserMedia for camera and mic, waiting on tab video metadata) and
  // it runs *before* the epoch is minted, so the countdown is spent on work that
  // had to happen anyway instead of being recorded.
  // Viewport pinning only applies to tab capture (it's what stops Chrome letterboxing
  // the tab into a differently-shaped stream). Reading it means running a script in the
  // page, so don't: when the user asked to record a window or their screen, this tab
  // isn't the subject and shouldn't be touched.
  const viewport = source === 'tab' ? await getTabViewport(tab.id) : null;

  const prepResp = await sendToOffscreen({
    type: 'OFFSCREEN_PREPARE',
    streamId,
    sessionId,
    options: { ...options, viewport },
    tabId: tab.id,
  });

  if (!prepResp || !prepResp.ok) {
    throw new Error((prepResp && prepResp.error) || 'Recorder failed to start.');
  }

  // The recording's epoch: the instant the recorders will roll, one countdown from
  // now. Everything that timestamps against the video — clicks, the QA capture, the
  // popup's timer — is handed this same value, so they all share an origin with the
  // video's own clock. Anything that happens before it (the tab settling, a click on
  // the popup) lands at a negative offset and is discarded rather than shifting
  // every zoom a couple of seconds late.
  //
  // Minted here, as late as possible: the popup counts down to this absolute
  // instant, so every millisecond spent below is a millisecond it doesn't get to
  // show. COUNTDOWN_MS carries enough slack to absorb what's left.
  const startTime = Date.now() + COUNTDOWN_MS;

  // First, before the slower calls below — the recorders need the longest possible
  // notice of an instant that's already ticking. Awaited despite that: it's a couple
  // of milliseconds, and the alternative is a recording that shows REC, runs a timer,
  // and yields an empty file because nothing ever rolled.
  const beginResp = await sendToOffscreen({
    type: 'OFFSCREEN_BEGIN',
    startAt: startTime,
  });

  if (!beginResp || !beginResp.ok) {
    // The devices are open at this point; hand them back before giving up.
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    throw new Error((beginResp && beginResp.error) || 'Recorder would not roll.');
  }

  state = {
    phase: 'recording',
    sessionId,
    tabId: tab.id,
    startTime,
    paused: false,
    options,
    clicks: [],
    // What actually opened, not just what was asked for — a webcam/mic that failed
    // to grant still leaves options.webcam/mic true, and telling the popup "your
    // camera is recording" when it silently isn't would be its own kind of
    // confusion. Kept in state (not just the one-time startRecording response) so
    // reopening the popup later still describes the recording accurately.
    gotWebcam: !!prepResp.gotWebcam,
    gotMic: !!prepResp.gotMic,
    // Only meaningful for a tab recording — it prefills the editor's mock URL bar, and
    // labelling a window or desktop capture with whatever tab happened to be in front
    // would put a URL on footage that isn't of that page.
    pageUrl: source === 'tab' ? (tab.url || '') : '',
    pageTitle: source === 'tab' ? (tab.title || '') : '',
  };

  // Durable snapshot of what a crash recovery would need to describe this take
  // in the editor. Written now, not just harvested later, because a full
  // browser crash wipes chrome.storage.session (where the rest of `state`
  // normally lives) and leaves nothing else to harvest afterward — this is the
  // only copy of pageUrl/pageTitle/source that can survive that case.
  chrome.storage.local.set({
    [recSessionMetaKey(sessionId)]: {
      pageUrl: state.pageUrl,
      pageTitle: state.pageTitle,
      source,
      startTime,
      clicks: [],
      typing: [],
      savedAt: Date.now(),
    },
  }).catch(() => {});

  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: '#e53c48' });
  // The badge alone reads as "something is on", not "this is still recording even
  // though you closed the popup" — the confusion this exists to head off. Naming
  // what's actually being captured matters too: without it, "recording" reads as
  // screen-only, and someone who can't see their camera preview anywhere once the
  // popup is closed has no way to tell it's still being captured in the background.
  chrome.action.setTitle({
    title: `Click & Record — recording ${captureSummary(options, state.gotWebcam, state.gotMic)}. `
      + 'This keeps going even if you close this popup — click the icon, or press Alt+Shift+S, to stop.',
  });

  // Armed now rather than at startTime, so requests already in flight when the
  // recording begins are still seen. capture.js floors its offsets at zero, so
  // pre-roll requests collapse onto the first frame instead of going negative.
  if (options.capture) {
    drCapStart(tab.id, startTime);
    await injectProbe(tab.id, startTime);
  }

  // Sent for every source now: content.js needs `options.source` to know which
  // coordinate space to map clicks into.
  chrome.tabs.sendMessage(tab.id, { type: 'RECORDING_STARTED', startTime, options })
    .catch(() => {
      // content script may not be injected on this page (e.g. chrome:// URLs)
    });

  await persistState();

  // Pass through what the recorder actually managed to open, so the popup can warn
  // rather than let the user find out after the fact.
  const missing = [];
  if (options.webcam && !prepResp.gotWebcam) missing.push('webcam');
  if (options.mic && !prepResp.gotMic) missing.push('microphone');

  return { ok: true, startTime, countdownMs: COUNTDOWN_MS, missing };
}

// The recorders were asked to roll at state.startTime; this is them reporting when
// they actually did. A hidden document's timers can drift a couple of hundred
// milliseconds, so rather than trusting the scheduled instant, every clock that has
// to agree with the video is repointed at the real one — clicks (content.js), the QA
// capture's webRequest side (capture.js) and its in-page probe (probe.js).
//
// Everything logged before this point happened during the countdown and is pre-roll
// by definition, so nothing already recorded needs rewriting.
async function adoptRecorderEpoch(startedAt) {
  if (state.phase !== 'recording' || !startedAt) return;
  const drift = startedAt - state.startTime;
  state.startTime = startedAt;
  await persistState();

  drCapRebase(startedAt);

  chrome.tabs.sendMessage(state.tabId, {
    type: 'RECORDING_STARTED',
    startTime: startedAt,
    options: state.options,
  }).catch(() => {});

  if (state.options && state.options.capture) {
    setProbeEpoch(state.tabId, startedAt).catch(() => {});
  }

  if (Math.abs(drift) > 50) {
    console.info(`[demo-recorder/background] recorder rolled ${drift}ms off schedule; clocks rebased`);
  }
}

// Puts a tab's content script into the recording state so its clicks get logged.
async function armTabForClicks(tabId) {
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, {
    type: 'RECORDING_STARTED',
    startTime: state.startTime,
    options: state.options,
  }).catch(() => {
    // restricted page — nothing to log there
  });
}

// Which tabs should be logging clicks right now.
//
// For a window or screen recording, any tab the user moves to is on camera, so its
// clicks belong to the video. For a tab recording the opposite holds: only the recorded
// tab's clicks do, and arming others would log clicks the viewer never sees.
//
// This also covers navigation. A content script is destroyed and recreated on every page
// load, losing the recording state it was told about — so without re-arming, navigating
// mid-recording silently stopped click logging even for a plain tab recording.
function shouldArmForClicks(tabId) {
  if (state.phase !== 'recording') return false;
  if (!state.options || !state.options.clicks) return false;
  if (state.options.source === 'tab') return tabId === state.tabId;
  return true;
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await restoreState();
  if (shouldArmForClicks(tabId)) await armTabForClicks(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  await restoreState();
  if (shouldArmForClicks(tabId)) await armTabForClicks(tabId);
});

async function stopRecording() {
  if (state.phase !== 'recording') {
    return { ok: false, error: 'No recording in progress.' };
  }
  state.phase = 'processing';

  chrome.tabs.sendMessage(state.tabId, { type: 'RECORDING_STOPPED' }).catch(() => {});
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: '' }); // back to the manifest default

  // OFFSCREEN_STOP saves both the screen recording and the webcam track.
  const stopResp = await sendToOffscreen({ type: 'OFFSCREEN_STOP' });
  if (!stopResp || !stopResp.ok) {
    drCapStop();
    await harvestAndResetState();
    // A stop that failed after tape had actually started rolling can still
    // leave a full set of durable chunks behind — surface it immediately
    // rather than waiting for the popup to reopen.
    checkForOrphanedRecording().catch((err) => {
      console.warn('[demo-recorder/background] orphan scan failed', err);
    });
    return { ok: false, error: (stopResp && stopResp.error) || 'Failed to finalize recording.' };
  }
  await onRecordingSaved(stopResp.sessionId, stopResp.meta);
  return { ok: true };
}

// ---------- camera / mic permission ----------
//
// getUserMedia can't prompt from an offscreen document (no UI), so the grant has
// to be obtained from a visible extension page first. permission.html does that;
// once granted, the offscreen recorder can open the same devices silently.

let permissionWaiter = null;

// Shared with popup.js's own copy (there's no module system between a service
// worker and a popup page to import this from, so it's duplicated — keep them in
// sync if this changes).
function captureSummary(options, gotWebcam, gotMic) {
  const items = ['screen'];
  if (options.webcam && gotWebcam) items.push('camera');
  if (options.mic && gotMic) items.push('microphone');
  if (items.length === 1) return 'your screen';
  if (items.length === 2) return `your ${items[0]} and ${items[1]}`;
  return `your ${items[0]}, ${items[1]} and ${items[2]}`;
}

async function requestMediaPermission({ video, audio }) {
  if (!video && !audio) return { ok: true };
  if (permissionWaiter) return { ok: false, error: 'A permission prompt is already open.' };

  // A default-positioned popup window can land in a corner, off to the side, or
  // behind the main window on some window managers — exactly the "nobody saw the
  // prompt" reports this exists to fix. Centre it over whichever window the user is
  // actually looking at instead of trusting Chrome's default placement.
  const width = 480;
  const height = 340; // room for the longer macOS-specific denial copy without scrolling
  let left; let top;
  try {
    const anchor = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    left = Math.round(anchor.left + (anchor.width - width) / 2);
    top = Math.round(anchor.top + (anchor.height - height) / 2);
  } catch (_) {
    // No normal window to anchor to (e.g. only popups open) — Chrome's default
    // placement is the fallback, not a hard failure.
  }

  const win = await chrome.windows.create({
    url: `permission.html?video=${video ? 1 : 0}&audio=${audio ? 1 : 0}`,
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true, // must be focused or the prompt can't be answered
  });

  // getLastFocused above and the create() call aren't atomic, so re-assert focus and
  // ask Chrome to flash the taskbar/dock entry — belt-and-suspenders against the
  // window opening without actually grabbing attention.
  try {
    await chrome.windows.update(win.id, { focused: true, drawAttention: true });
  } catch (_) {
    // window may already be gone (closed instantly) — nothing to focus
  }

  const result = await new Promise((resolve) => {
    permissionWaiter = resolve;
    // Don't hang forever if the window is left sitting there.
    setTimeout(() => {
      if (permissionWaiter === resolve) {
        permissionWaiter = null;
        resolve({ ok: false, error: 'Timed out waiting for a decision.' });
      }
    }, 180000);
  });

  try {
    await chrome.windows.remove(win.id);
  } catch (_) {
    // already closed itself
  }

  await chrome.storage.local.set({ mediaPermission: result.ok ? 'granted' : 'denied' });
  return result;
}

async function mediaPermissionState() {
  const { mediaPermission } = await chrome.storage.local.get('mediaPermission');
  return mediaPermission || 'unknown';
}

// Keyboard shortcut, so a recording can be stopped without hunting for the toolbar
// icon. Assign or change it at chrome://extensions/shortcuts.
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'stop-recording') return;
    await restoreState(); // not a message, so nothing else has restored it
    if (state.phase === 'recording') {
      stopRecording().catch((err) => console.error('[demo-recorder/background]', err));
    }
  });
}

// A real browser restart is the clearest signal a previous take might have
// been crashed rather than cleanly stopped — check for it as early as
// possible rather than waiting for the popup to be opened. restoreState()
// first: without it `state` is a fresh idleState() and checkForOrphanedRecording()
// has nothing to compare hasOffscreenDocument() against, so a session that
// chrome.storage.session still remembers as 'recording' would never be
// recognised as stale here.
chrome.runtime.onStartup.addListener(async () => {
  await restoreState();
  checkForOrphanedRecording().catch((err) => {
    console.warn('[demo-recorder/background] orphan scan failed', err);
  });
});

// Also run once on every service-worker (re)spawn, not just a full browser
// restart — an offscreen-document-only crash leaves the browser running but
// still orphans a chunk set, and the worker can respawn well before onStartup
// would ever fire again. Best-effort: nothing here blocks message handling.
restoreState().then(() => checkForOrphanedRecording()).catch((err) => {
  console.warn('[demo-recorder/background] orphan scan failed', err);
});

async function onRecordingSaved(sessionId, meta) {
  // Snapshot before stopping — drCapStop only detaches listeners, but taking the
  // snapshot first means anything still in flight is included.
  const capture = state.options && state.options.capture ? drCapSnapshot() : null;
  drCapStop();
  if (capture) {
    try {
      // startedAt lets the editor build HAR timestamps that are absolute rather
      // than relative to the recording.
      await drSaveLogs(sessionId, { ...capture, startedAt: state.startTime });
    } catch (err) {
      console.error('[demo-recorder/background] could not save capture', err);
    }
  }
  const payload = {
    sessionId,
    meta,
    clicks: state.clicks,
    typing: state.typing,
    startTime: state.startTime,
    // Used to prefill the mock browser frame's URL bar in the editor.
    pageUrl: state.pageUrl || '',
    // Both feed the editor's default recording name: the page title when there is one,
    // otherwise a label derived from what was captured.
    pageTitle: state.pageTitle || '',
    source: (state.options && state.options.source) || 'tab',
  };
  await chrome.storage.session.set({ [`session:${sessionId}`]: payload });
  // A clean save means offscreen.js's own stopCapture() already deleted the
  // chunks/chunkMeta rows for this session; this is just the local-storage
  // half of that same cleanup, so a completed recording leaves nothing behind.
  chrome.storage.local.remove(recSessionMetaKey(sessionId)).catch(() => {});
  resetState();
  await closeOffscreenDocument();

  chrome.tabs.create({ url: await buildEditorUrl(sessionId) });
}
