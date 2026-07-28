// Runs on every page. Its only job while a recording is active: log click
// coordinates (normalized 0..1, so they survive any DPI/capture-resolution
// mismatch) with a timestamp relative to recording start. That click log is
// what the editor turns into zoom-ins.
//
// Deliberately renders NOTHING into the page: chrome.tabCapture records the
// tab's own content, so anything drawn here would be baked into the video. That's
// why recording is controlled from the toolbar popup and a keyboard shortcut
// instead of an on-page widget.

let drState = {
  active: false,
  paused: false,
  startTime: 0,
  clicksEnabled: true,
  source: 'tab',
};

// Clicks have to be reported as a fraction of the *recorded frame*, because that's the
// only space the editor's zoom camera understands. Which frame that is depends on what
// was captured, and the three cases need different arithmetic:
//
//   tab     — the frame is this page's viewport, so viewport coordinates already are the
//             answer. This is the original path.
//   window  — the frame is the browser window, whose position and size in screen space
//             this page can read directly. Computed per click rather than once at the
//             start, so moving or resizing the window mid-recording stays correct.
//   screen  — the frame is the whole display, so screen coordinates over screen size.
//
// Returns null when the click lands outside the recorded surface — clicking in a second
// window while recording the first, say. Dropping those is the point: a zoom into a
// coordinate the frame doesn't contain would be worse than no zoom at all.
//
// The honest limit of all this is that a content script only sees clicks inside web
// pages. Clicks in other applications, in Chrome's own chrome, or on the desktop are
// invisible to an extension, so a screen recording gets zooms for the web-page clicks
// and nothing for the rest.
function framePosition(e) {
  let x;
  let y;

  if (drState.source === 'screen') {
    // availLeft/availTop are non-standard but Chrome reports them, and they're what puts
    // a secondary monitor's origin into the virtual-desktop space screenX/Y use.
    const originX = window.screen.availLeft || 0;
    const originY = window.screen.availTop || 0;
    x = (e.screenX - originX) / window.screen.width;
    y = (e.screenY - originY) / window.screen.height;
  } else if (drState.source === 'window') {
    x = (e.screenX - window.screenX) / window.outerWidth;
    y = (e.screenY - window.screenY) / window.outerHeight;
  } else {
    x = e.clientX / window.innerWidth;
    y = e.clientY / window.innerHeight;
  }

  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x, y };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    // lets background.js detect whether this script is already live before
    // injecting a second copy (which would double-log every click)
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'RECORDING_STARTED') {
    drState = {
      active: true,
      paused: false,
      startTime: msg.startTime,
      clicksEnabled: !!msg.options.clicks,
      source: msg.options.source || 'tab',
    };
  } else if (msg.type === 'RECORDING_STOPPED') {
    drState.active = false;
  } else if (msg.type === 'SET_PAUSED') {
    drState.paused = msg.paused;
  }
});

// probe.js runs in the page's MAIN world, which has no chrome.* APIs, so it
// posts its entries to the window and we relay them. Only same-window messages
// carrying our tag are accepted — a page script could still forge one, so these
// entries are treated as page-supplied data, never as instructions.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.__drTag !== 'DR_PROBE' || !msg.payload) return;
  // Not gated on drState here: the probe is injected before RECORDING_STARTED
  // reaches us, and gating locally would drop the first requests of the
  // recording. background.js gates on its own phase/paused state instead.
  chrome.runtime.sendMessage({ type: 'PROBE_ENTRY', entry: msg.payload }).catch(() => {});
});

document.addEventListener(
  'mousedown',
  (e) => {
    if (!drState.active || drState.paused || !drState.clicksEnabled) return;
    const pos = framePosition(e);
    if (!pos) return; // outside the recorded surface
    const click = { x: pos.x, y: pos.y, t: Date.now() - drState.startTime };
    chrome.runtime.sendMessage({ type: 'CLICK_EVENT', click }).catch(() => {});
  },
  { capture: true }
);
