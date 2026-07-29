const views = {
  idle: document.getElementById('view-idle'),
  countdown: document.getElementById('view-countdown'),
  recording: document.getElementById('view-recording'),
  processing: document.getElementById('view-processing'),
  error: document.getElementById('view-error'),
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  showView('error');
}

// ---------- what to record ----------
//
// Click zoom-ins work on all three sources — content.js maps each click into whichever
// frame is being recorded. What it can't do is see clicks outside a web page, so on a
// window or screen recording, clicks in other apps produce no zoom.
//
// QA capture is the one thing that stays tab-only, because chrome.webRequest is filtered
// to a single tab: attaching one tab's network log to a whole-desktop recording would
// read as evidence about everything on screen. It switches off visibly, with the reason.

let recordSource = 'tab';

const SOURCE_NOTES = {
  window: 'Chrome will ask which window. Click zoom-ins only cover clicks in Chrome '
    + 'pages, and QA capture needs a tab recording.',
  screen: 'Chrome will ask which screen — tick "Share audio" there for system sound. '
    + 'Click zoom-ins only cover clicks in Chrome pages, and QA capture needs a tab '
    + 'recording.',
};

const SOURCE_SUMMARIES = {
  tab: 'Your current tab is recorded.',
  window: 'The window you pick is recorded, including any app — not just Chrome.',
  screen: 'The whole screen is recorded, including everything outside the browser.',
};

function applySourceUI() {
  document.querySelectorAll('.source-opt').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.source === recordSource);
  });

  const tabOnly = recordSource !== 'tab';
  // Only QA capture is gated on the source now; clicks work everywhere.
  ['capture'].forEach((key) => {
    const input = document.getElementById(`opt-${key}`);
    const row = document.getElementById(`row-${key}`);
    input.disabled = tabOnly;
    row.classList.toggle('row-disabled', tabOnly);
    // Remember what it was, so switching back to Tab restores the choice instead of
    // quietly leaving a feature off.
    if (tabOnly) {
      if (input.dataset.wanted === undefined) input.dataset.wanted = input.checked ? '1' : '';
      input.checked = false;
    } else if (input.dataset.wanted !== undefined) {
      input.checked = input.dataset.wanted === '1';
      delete input.dataset.wanted;
    }
  });

  const note = document.getElementById('source-note');
  note.textContent = SOURCE_NOTES[recordSource] || '';
  note.classList.toggle('hidden', !SOURCE_NOTES[recordSource]);

  document.getElementById('source-summary').textContent =
    SOURCE_SUMMARIES[recordSource] || SOURCE_SUMMARIES.tab;
}

document.querySelectorAll('.source-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    recordSource = btn.dataset.source;
    applySourceUI();
  });
});

let timerInterval = null;
function startTimerUI(startTime) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const secs = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    document.getElementById('rec-timer').textContent = `${m}:${s}`;
  }, 250);
}

// Whether a device kind is actually accessible. enumerateDevices() only fills in
// device *labels* once permission exists, which makes this a reliable check that
// never triggers a prompt — unlike navigator.permissions.query, which reports
// 'prompt' for extension origins even when getUserMedia works fine (that's what
// had this popup insisting access was missing while the camera light was on).
async function deviceAccess() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const has = (kind) => devices.some((d) => d.kind === kind);
    const labelled = (kind) => devices.some((d) => d.kind === kind && d.label !== '');
    return {
      camera: { present: has('videoinput'), granted: labelled('videoinput') },
      mic: { present: has('audioinput'), granted: labelled('audioinput') },
    };
  } catch (_) {
    return { camera: { present: false, granted: false }, mic: { present: false, granted: false } };
  }
}

let previewStream = null;

function stopPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
  document.getElementById('cam-preview').srcObject = null;
  document.getElementById('cam-wrap').classList.add('hidden');
}

// Only called once access is confirmed, so it can't cause a prompt that would
// close the popup out from under the user.
async function startPreview() {
  if (previewStream) return;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    const video = document.getElementById('cam-preview');
    video.srcObject = previewStream;
    document.getElementById('cam-wrap').classList.remove('hidden');
    await video.play().catch(() => {});
  } catch (err) {
    previewStream = null;
    document.getElementById('cam-wrap').classList.add('hidden');
  }
}

async function refreshPermissionNotice() {
  const notice = document.getElementById('perm-notice');
  const wantCam = document.getElementById('opt-webcam').checked;
  const wantMic = document.getElementById('opt-mic').checked;

  if (!wantCam && !wantMic) {
    notice.classList.add('hidden');
    stopPreview();
    return;
  }

  const access = await deviceAccess();
  const ok = (!wantCam || access.camera.granted) && (!wantMic || access.mic.granted);
  notice.classList.toggle('hidden', ok);

  if (wantCam && access.camera.granted) await startPreview();
  else stopPreview();
}

// Shared by the explicit "Allow camera & mic" button and the automatic trigger
// below. `silent` skips the full-screen error view for the automatic path — a
// toggle flip shouldn't blow away everything else the user was setting up over a
// prompt they may not have even wanted answered yet; the inline notice already
// says enough, and the button stays there to retry.
async function requestPermissionNow({ silent } = {}) {
  const btn = document.getElementById('btn-grant');
  btn.disabled = true;
  btn.textContent = 'Waiting for Chrome…';
  const resp = await chrome.runtime.sendMessage({
    type: 'REQUEST_MEDIA_PERMISSION',
    video: document.getElementById('opt-webcam').checked,
    audio: document.getElementById('opt-mic').checked,
  });
  btn.disabled = false;
  btn.textContent = 'Allow camera & mic';
  await refreshPermissionNotice();
  if (!resp || !resp.ok) {
    if (!silent) showError((resp && resp.error) || 'Access was not granted.');
  }
}

document.getElementById('btn-grant').addEventListener('click', () => requestPermissionNow());

// The production complaint this exists to fix: people toggle webcam/mic on (or
// just open the popup with the defaults already on), click Start, and never
// noticed the "Allow camera & mic" button or the Chrome prompt it opens — so they
// get a screen-only recording and think the app is broken. Firing the same
// request automatically, the moment access is wanted, means the visible Chrome
// window shows up without needing a second click on something easy to miss.
let autoPermissionInFlight = false;
async function maybeAutoRequestPermission() {
  if (autoPermissionInFlight) return;
  const wantCam = document.getElementById('opt-webcam').checked;
  const wantMic = document.getElementById('opt-mic').checked;
  if (!wantCam && !wantMic) return;

  const access = await deviceAccess();
  const ok = (!wantCam || access.camera.granted) && (!wantMic || access.mic.granted);
  if (ok) return;

  // Once explicitly blocked, Chrome won't show the prompt again regardless — pop
  // an empty window on every toggle would just be noise. The notice + button
  // below still lets them retry after fixing it in Chrome's site settings.
  const permState = await chrome.runtime.sendMessage({ type: 'GET_MEDIA_PERMISSION' }).catch(() => null);
  if (permState && permState.state === 'denied') return;

  autoPermissionInFlight = true;
  await requestPermissionNow({ silent: true });
  autoPermissionInFlight = false;
}

['opt-webcam', 'opt-mic'].forEach((id) => {
  document.getElementById(id).addEventListener('change', async () => {
    await refreshPermissionNotice();
    if (document.getElementById(id).checked) await maybeAutoRequestPermission();
  });
});

// Release the camera when the popup goes away, so the indicator light doesn't stay
// on and the controls window can open the device cleanly.
window.addEventListener('unload', stopPreview);

async function refreshState() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (!state) return;

  // A start that failed after this popup closed — which is every window/screen failure,
  // since Chrome's picker takes focus and closes us before anything can go wrong. Without
  // this the recording just silently doesn't happen.
  if (state.lastError && state.phase === 'idle') {
    showError(state.lastError);
    return;
  }

  if (state.phase === 'recording') {
    document.getElementById('click-count').textContent = `${state.clickCount || 0} clicks detected`;
    // Reopened during the countdown — startTime is still in the future, so pick the
    // countdown back up rather than showing a timer stuck at 00:00.
    if (state.startTime > Date.now()) {
      runCountdown(state.startTime);
      return;
    }
    showView('recording');
    startTimerUI(state.startTime);
  } else if (state.phase === 'processing') {
    showView('processing');
  } else {
    showView('idle');
  }
}

document.getElementById('btn-start').addEventListener('click', async () => {
  const opts = {
    source: recordSource,
    webcam: document.getElementById('opt-webcam').checked,
    mic: document.getElementById('opt-mic').checked,
    clicks: document.getElementById('opt-clicks').checked,
    capture: document.getElementById('opt-capture').checked,
    // No bubble position here any more: the webcam is recorded as its own track and
    // positioned in the editor, so choosing it up front would be a false promise.
  };

  // Hand the camera over before the recorder opens it, so the two aren't briefly
  // competing for the same device.
  stopPreview();

  // The tab stream is acquired synchronously off this click (Chrome ties
  // tabCapture to the user gesture), but the recorder is held back until
  // resp.startTime — so the countdown below happens *before* the first recorded
  // frame instead of being baked into it.
  // For window/screen, Chrome's source picker takes focus and closes this popup, which
  // kills the message port before a reply can arrive. The recording is unaffected —
  // background.js carries on, the badge shows REC, and reopening the popup rejoins the
  // count-in. So a dead port here is an expected outcome, not a failure.
  const resp = await chrome.runtime
    .sendMessage({ type: 'START_RECORDING', options: opts })
    .catch(() => null);
  if (!resp) return;
  if (!resp.ok) {
    showError(resp.error || 'Could not start recording.');
    return;
  }

  if (resp.missing && resp.missing.length) {
    // The streams are already open, so this is a heads-up, not an error.
    document.getElementById('click-count').textContent =
      `Recording without ${resp.missing.join(' and ')}`;
  }

  runCountdown(resp.startTime);
});

// Counts down to the wall-clock instant the recorder was given, rather than ticking
// a local 3-2-1. Drift between the two would show up as the countdown hitting zero
// while the file has already started — or worse, hasn't yet.
function runCountdown(startTime) {
  showView('countdown');
  const num = document.getElementById('countdown-num');
  const tick = () => {
    const remaining = startTime - Date.now();
    if (remaining <= 0) {
      clearInterval(countdown);
      showView('recording');
      startTimerUI(startTime);
      return;
    }
    num.textContent = Math.ceil(remaining / 1000);
  };
  const countdown = setInterval(tick, 100);
  tick();
}

document.getElementById('btn-stop').addEventListener('click', async () => {
  showView('processing');
  const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  if (!resp || !resp.ok) {
    showError((resp && resp.error) || 'Could not finish recording.');
    return;
  }
  window.close();
});

document.getElementById('btn-pause').addEventListener('click', async () => {
  const btn = document.getElementById('btn-pause');
  const resp = await chrome.runtime.sendMessage({ type: 'TOGGLE_PAUSE' });
  if (resp && resp.ok) {
    btn.textContent = resp.paused ? 'Resume' : 'Pause';
  }
});

document.getElementById('btn-open-editor').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'OPEN_EDITOR' }).catch(() => {});
  window.close(); // the editor opens in a tab; leaving the popup up serves nothing
});

document.getElementById('btn-retry').addEventListener('click', () => showView('idle'));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CLICK_COUNT_UPDATE') {
    const el = document.getElementById('click-count');
    if (el) el.textContent = `${msg.count} clicks detected`;
  }
});

applySourceUI();
(async () => {
  await refreshState();
  await refreshPermissionNotice();
  // Webcam and mic default to on, so most people never touch those toggles at
  // all — gating on the idle view (not recording/processing/error) rather than
  // firing unconditionally on every open.
  if (!views.idle.classList.contains('hidden')) await maybeAutoRequestPermission();
})();
