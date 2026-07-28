// A visible extension page whose only job is to trigger Chrome's camera/mic
// permission prompt.
//
// This exists because offscreen.js can't: an offscreen document has no UI, so
// Chrome refuses to show a permission prompt from one and getUserMedia rejects
// immediately. The recorder therefore recorded silently without webcam or mic and
// the user was never asked. Granting here stores the decision against the
// extension's origin, after which the offscreen document and the controls window
// can open the same devices without prompting.
//
// Failure is deliberately NOT reported to the background straight away: the
// background closes this window as soon as it has an answer, so reporting an
// immediate rejection made the window flash shut before the user could read the
// reason or retry. Only success — or the user dismissing the window — is final.

const params = new URLSearchParams(location.search);
const wantVideo = params.get('video') === '1';
const wantAudio = params.get('audio') === '1';

const titleEl = document.getElementById('title');
const hintEl = document.getElementById('hint');
const errorEl = document.getElementById('error');
const retryBtn = document.getElementById('btn-retry');

const label = wantVideo && wantAudio ? 'camera & microphone'
  : wantVideo ? 'camera' : 'microphone';
titleEl.textContent = `Allow ${label}`;

let reported = false;

function report(payload) {
  if (reported) return Promise.resolve();
  reported = true;
  return chrome.runtime.sendMessage({ type: 'MEDIA_PERMISSION_RESULT', ...payload })
    .catch(() => {});
}

async function alreadyGranted() {
  try {
    const queries = [];
    if (wantVideo) queries.push(navigator.permissions.query({ name: 'camera' }));
    if (wantAudio) queries.push(navigator.permissions.query({ name: 'microphone' }));
    const states = await Promise.all(queries);
    return states.length > 0 && states.every((s) => s.state === 'granted');
  } catch (_) {
    return false; // Permissions API unavailable for these names — just ask.
  }
}

async function request() {
  errorEl.classList.add('hidden');
  retryBtn.classList.add('hidden');
  hintEl.textContent = `Chrome will ask for access. Choose Allow so your ${label} can be recorded.`;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: wantVideo ? { width: 640, height: 480, facingMode: 'user' } : false,
      audio: wantAudio ? { echoCancellation: true, noiseSuppression: true } : false,
    });
    // Release the devices straight away — this page only needed the grant, and
    // holding the camera open would leave its indicator light on.
    stream.getTracks().forEach((t) => t.stop());
    hintEl.textContent = 'Granted.';
    await report({ ok: true });
    window.close();
  } catch (err) {
    // Stay open and explain. Reporting here would let the background close us
    // before this message could be read.
    const denied = err.name === 'NotAllowedError';
    const missing = err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError';
    hintEl.textContent = '';
    errorEl.textContent = denied
      ? `Access was blocked. Click the camera icon in Chrome's address bar (or Settings → Privacy and security → Site settings → Camera/Microphone) and allow it for this extension, then press Try again.`
      : missing
        ? `No ${label} was found. Plug one in, or turn that option off in the popup and record the screen only.`
        : `Could not open the ${label}: ${err.name} — ${err.message}`;
    errorEl.classList.remove('hidden');
    retryBtn.classList.remove('hidden');
  }
}

retryBtn.addEventListener('click', request);

// Dismissing the window without granting is the user's answer — tell the
// background so startRecording isn't left waiting.
window.addEventListener('unload', () => {
  if (reported) return;
  reported = true;
  chrome.runtime.sendMessage({ type: 'MEDIA_PERMISSION_CLOSED' }).catch(() => {});
});

(async () => {
  // If it's already granted there's nothing to ask; report and get out of the way.
  if (await alreadyGranted()) {
    await report({ ok: true });
    window.close();
    return;
  }
  request();
})();
