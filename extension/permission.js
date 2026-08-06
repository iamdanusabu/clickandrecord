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
const continueBtn = document.getElementById('btn-continue');

const label = wantVideo && wantAudio ? 'camera & microphone'
  : wantVideo ? 'camera' : 'microphone';
titleEl.textContent = `Allow ${label}`;

// macOS gates camera/mic behind its own system-level permission for the whole
// browser, on top of Chrome's per-site one — and the two look identical from
// here (getUserMedia rejects with the same NotAllowedError either way). Most
// "the prompt wasn't visible" reports turn out to be that OS dialog: it can
// appear once, on first use ever, easy to click through without reading, and a
// no at the OS level makes Chrome fail silently forever after with no
// indication that this page's own permission was never actually the problem.
const macPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
const isMac = /mac/i.test(macPlatform);

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

// Chrome and Brave both offer a duration choice on this prompt (e.g. "Allow
// this time" vs "Allow on every visit"). A time-limited grant expires mid-
// recording — the webcam track just stops with no error — so steer people
// toward the persistent option instead of the default-looking temporary one.
const durationHint = 'If it offers a choice of how long, pick "Allow on every visit" (or at least 1 day) — not "Allow this time only," or the camera will stop partway through recording.';

// Chrome's own permission bubble renders on top of this entire window the
// instant getUserMedia is called, covering the hint text before anyone can
// read it — the exact "the warning was there but I never saw it" reports
// this exists to fix. So: show the instructions first, behind a Continue
// button, and only call getUserMedia once the user has actually read them and
// clicked through. The bubble still covers the page after that, but by then
// the point has already landed.
function showInstructions() {
  hintEl.textContent = isMac
    ? `Chrome will ask for access — macOS may also show its own system dialog the first time. Choose Allow on both so your ${label} can be recorded. ${durationHint}`
    : `Chrome will ask for access. Choose Allow so your ${label} can be recorded. ${durationHint}`;
  errorEl.classList.add('hidden');
  retryBtn.classList.add('hidden');
  continueBtn.classList.remove('hidden');
}

async function request() {
  errorEl.classList.add('hidden');
  retryBtn.classList.add('hidden');
  continueBtn.classList.add('hidden');

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
      ? (isMac
        // Lead with the OS-level gate: it's the more likely cause on a Mac, and
        // Chrome's own address-bar fix does nothing if this is what's blocking it.
        ? `Access was blocked. On a Mac this is usually macOS itself: open System Settings → Privacy & Security → Camera (and Microphone), turn on Google Chrome, then fully quit and reopen Chrome — the toggle doesn't take effect without a restart — and press Try again. If Chrome is already allowed there, click the camera icon in Chrome's address bar instead and allow it for this extension.`
        : `Access was blocked. Click the camera icon in Chrome's address bar (or Settings → Privacy and security → Site settings → Camera/Microphone) and allow it for this extension, then press Try again.`)
      : missing
        ? `No ${label} was found. Plug one in, or turn that option off in the popup and record the screen only.`
        : `Could not open the ${label}: ${err.name} — ${err.message}`;
    errorEl.classList.remove('hidden');
    retryBtn.classList.remove('hidden');
  }
}

retryBtn.addEventListener('click', request);
continueBtn.addEventListener('click', request);

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
  showInstructions();
})();
