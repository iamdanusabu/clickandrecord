// Click & Record — "How it works" tour.
//
// Same rule as ui.js: purely additive. This file injects its own DOM (a welcome
// modal, a help button, the spotlight overlay) and otherwise only clicks
// `.rail-tab` buttons the same way a user's mouse would — it never reaches into
// editor.js or ui.js internals, so neither has to know this exists.
//
// The tour is read-only: it narrates the real UI under a spotlight rather than
// showing screenshots, but it doesn't require the viewer to actually do anything.
// Shown once automatically (tracked in localStorage); replayable any time from the
// "?" button this file adds to the topbar.

(() => {
  const SEEN_KEY = 'dr_tour_seen_v1';

  // Only shown when the editor has no video loaded yet — everything else in the
  // tour describes controls that either don't do anything or aren't even on
  // screen until then, so it goes first and the rest follow once real.
  const INTRO_STEP = {
    targetSel: '.dz-card',
    side: 'bottom',
    title: 'Start here',
    body: 'Choose a video to edit, or drop one anywhere on the page. Once it loads, the timeline, zooms, styling and export below all come alive.',
  };

  const STEPS = [
    {
      targetSel: '.recording-name',
      side: 'bottom',
      title: 'Name it',
      body: 'This names the exported file — click it any time to rename. It stays “Untitled recording” until you do.',
    },
    {
      targetSel: '.timeline-panel',
      side: 'top',
      title: 'Timeline',
      body: 'Drag a clip’s ends to trim it, hover to scrub, and hit <strong>Split</strong> to cut at the playhead. Yellow dots are detected clicks — each gets an automatic zoom; click a dot to toggle it off, or place one by hand with <strong>Add zoom</strong>.',
    },
    {
      tab: 'style',
      title: 'Style',
      body: 'Pick a background colour or upload your own image, then shape the stage around the recording — inset, rounded corners, drop shadow.',
    },
    {
      tab: 'frame',
      title: 'Frame',
      body: 'Wrap the recording in a mock browser or OS window, and edit the address-bar text if the real URL shouldn’t be public.',
    },
    {
      tab: 'camera',
      title: 'Camera',
      body: 'If you recorded with a webcam, its bubble shows up here — drag it anywhere on the preview, resize or reshape it, or hide it for part of the video with a clip’s own Webcam checkbox.',
      unavailableNote: 'This recording has no webcam track, so there’s nothing to show yet — record with your camera on to use this.',
    },
    {
      tab: 'output',
      title: 'Output',
      body: 'Choose the export aspect ratio — 16:9, 9:16, 1:1, 4:5 — then turn on Crop and drag the preview’s edges to frame exactly what matters. <strong>Mask</strong> covers a band at the top or bottom instead — handy for hiding a taskbar or a notification, with a soft feathered edge so it reads as a dissolve rather than a hard cut.',
    },
    {
      tab: 'subtitles',
      title: 'Subtitles',
      body: 'Generate captions on your own machine, nothing uploaded, then style their size, position and colour. Drag the subtitle anywhere on the preview to place it, or write cues by hand with <strong>+ Add cue</strong>.',
    },
    {
      tab: 'inspect',
      title: 'Inspect',
      body: 'If Network & console capture was on while recording, the requests and logs that happened alongside your clicks show up here, synced to the playhead — handy for bug reports.',
      unavailableNote: 'Nothing was captured for this recording — turn on Network & console in the popup next time you record.',
    },
    {
      targetSel: '.topbar-right',
      side: 'bottom',
      title: 'Save & export',
      body: 'Save straight to Google Drive, or Export to pick a format and quality. Export renders in real time, and it’s safe to switch tabs while it works — it picks back up where it left off.',
    },
  ];

  let seen;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { seen = null; }
  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode, etc. */ }
  }

  // ---------- overlay DOM (built once, reused every run) ----------

  const overlay = document.createElement('div');
  overlay.className = 'tour-overlay hidden';
  const maskTop = document.createElement('div');
  const maskBottom = document.createElement('div');
  const maskLeft = document.createElement('div');
  const maskRight = document.createElement('div');
  [maskTop, maskBottom, maskLeft, maskRight].forEach((m) => m.className = 'tour-mask');
  const ring = document.createElement('div');
  ring.className = 'tour-ring';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.innerHTML = `
    <div class="tour-card-head">
      <span class="tour-count" id="tour-count"></span>
      <button class="tour-skip" id="tour-skip" type="button">Skip tour</button>
    </div>
    <h3 class="tour-title" id="tour-title"></h3>
    <p class="tour-body" id="tour-body"></p>
    <div class="tour-card-actions">
      <button class="ghost" id="tour-back" type="button">Back</button>
      <button class="primary" id="tour-next" type="button">Next</button>
    </div>
  `;
  overlay.append(maskTop, maskBottom, maskLeft, maskRight, ring, card);
  document.body.appendChild(overlay);

  const countEl = card.querySelector('#tour-count');
  const titleEl = card.querySelector('#tour-title');
  const bodyEl = card.querySelector('#tour-body');
  const backBtn = card.querySelector('#tour-back');
  const nextBtn = card.querySelector('#tour-next');
  const skipBtn = card.querySelector('#tour-skip');

  let activeSteps = STEPS;
  let idx = 0;
  let currentEl = null;
  let currentSide = 'bottom';
  let running = false;

  // ---------- geometry ----------

  function layout() {
    if (!currentEl) return;
    const rect = currentEl.getBoundingClientRect();
    const pad = 8;
    const r = {
      top: Math.max(rect.top - pad, 0),
      left: Math.max(rect.left - pad, 0),
      right: Math.min(rect.right + pad, window.innerWidth),
      bottom: Math.min(rect.bottom + pad, window.innerHeight),
    };
    maskTop.style.cssText = `top:0;left:0;width:100%;height:${r.top}px`;
    maskBottom.style.cssText = `top:${r.bottom}px;left:0;width:100%;height:${Math.max(window.innerHeight - r.bottom, 0)}px`;
    maskLeft.style.cssText = `top:${r.top}px;left:0;width:${r.left}px;height:${r.bottom - r.top}px`;
    maskRight.style.cssText = `top:${r.top}px;left:${r.right}px;width:${Math.max(window.innerWidth - r.right, 0)}px;height:${r.bottom - r.top}px`;
    ring.style.cssText = `top:${r.top}px;left:${r.left}px;width:${r.right - r.left}px;height:${r.bottom - r.top}px`;

    // Measure the card only after its text is set, since body length varies step
    // to step and changes both its width (wraps) and height.
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const margin = 16;
    let left; let top;
    if (currentSide === 'left') {
      left = r.left - margin - cw;
      top = r.top + (r.bottom - r.top) / 2 - ch / 2;
    } else if (currentSide === 'right') {
      left = r.right + margin;
      top = r.top + (r.bottom - r.top) / 2 - ch / 2;
    } else if (currentSide === 'top') {
      left = r.left + (r.right - r.left) / 2 - cw / 2;
      top = r.top - margin - ch;
    } else {
      left = r.left + (r.right - r.left) / 2 - cw / 2;
      top = r.bottom + margin;
    }
    left = Math.min(Math.max(left, 12), window.innerWidth - cw - 12);
    top = Math.min(Math.max(top, 12), window.innerHeight - ch - 12);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  // ---------- steps ----------

  // A tab step always resolves to something real: the rail-page content when its
  // tab is enabled, or the tab button itself (with a note explaining why) when
  // it isn't — so every step has a real element to point at, never a 0x0 rect.
  function resolveStep(step) {
    if (!step.tab) {
      return { el: document.querySelector(step.targetSel), body: step.body, side: step.side };
    }
    const tabEl = document.querySelector(`.rail-tab[data-page="${step.tab}"]`);
    if (!tabEl) return null;
    if (tabEl.disabled) {
      return { el: tabEl, body: step.unavailableNote || step.body, side: 'left' };
    }
    tabEl.click();
    const page = document.querySelector(`.rail-page[data-page="${step.tab}"]`);
    return { el: page || tabEl, body: step.body, side: 'left' };
  }

  function render(i) {
    idx = Math.max(0, Math.min(i, activeSteps.length - 1));
    const resolved = resolveStep(activeSteps[idx]);
    if (!resolved || !resolved.el) return; // nothing sensible to point at; hold position

    // Some targets (the timeline, before any video is loaded) are legitimately
    // display:none and report a 0x0 rect — spotlighting that collapses the whole
    // screen into an unreadable sliver. Fall back to the column that contains it.
    const rect = resolved.el.getBoundingClientRect();
    const usable = rect.width > 0 && rect.height > 0;
    currentEl = usable ? resolved.el : (document.querySelector('.stage-col') || document.body);
    currentSide = resolved.side || 'bottom';
    currentEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    countEl.textContent = `${idx + 1} / ${activeSteps.length}`;
    titleEl.textContent = activeSteps[idx].title;
    bodyEl.innerHTML = resolved.body;
    backBtn.style.visibility = idx === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = idx === activeSteps.length - 1 ? 'Finish' : 'Next';

    requestAnimationFrame(layout);
  }

  function next() { if (idx >= activeSteps.length - 1) return stop(true); render(idx + 1); }
  function prev() { render(idx - 1); }

  function onKeydown(e) {
    if (e.key === 'Escape') return stop(true);
    if (e.key === 'ArrowRight' || e.key === 'Enter') return next();
    if (e.key === 'ArrowLeft') return prev();
  }

  function start() {
    running = true;
    // Decided fresh each run: if a video's already loaded (or gets loaded between
    // runs), the "add a video" step has nothing left to teach and is left out.
    activeSteps = document.body.classList.contains('no-video') ? [INTRO_STEP, ...STEPS] : STEPS;
    overlay.classList.remove('hidden');
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', layout);
    render(0);
  }

  function stop(remember) {
    running = false;
    if (remember) markSeen();
    overlay.classList.add('hidden');
    currentEl = null;
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', layout);
  }

  nextBtn.addEventListener('click', next);
  backBtn.addEventListener('click', prev);
  skipBtn.addEventListener('click', () => stop(true));
  // Clicking the dimmed area advances rather than doing nothing — it reads as
  // "go on" rather than a dead click, and Skip tour is always one tap away.
  [maskTop, maskBottom, maskLeft, maskRight].forEach((m) => m.addEventListener('click', next));

  // ---------- welcome modal ----------

  const welcome = document.createElement('div');
  welcome.id = 'tour-welcome';
  welcome.className = 'modal hidden';
  welcome.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="tour-welcome-title">
      <h2 class="modal-title" id="tour-welcome-title">New to the editor?</h2>
      <p class="field-hint" style="margin:0">A minute-long tour of every option — timeline, style, camera, subtitles, and export.</p>
      <div class="modal-actions">
        <button class="ghost" id="tour-welcome-skip" type="button">Skip</button>
        <button class="primary" id="tour-welcome-start" type="button">Show me how</button>
      </div>
    </div>
  `;
  document.body.appendChild(welcome);
  welcome.querySelector('#tour-welcome-skip').addEventListener('click', () => {
    markSeen();
    welcome.classList.add('hidden');
  });
  welcome.querySelector('#tour-welcome-start').addEventListener('click', () => {
    markSeen();
    welcome.classList.add('hidden');
    start();
  });

  // ---------- persistent help button ----------

  const helpBtn = document.createElement('button');
  helpBtn.id = 'btn-tour-help';
  helpBtn.className = 'tour-help-btn';
  helpBtn.type = 'button';
  helpBtn.title = 'How it works';
  helpBtn.setAttribute('aria-label', 'How it works');
  helpBtn.textContent = '?';
  helpBtn.addEventListener('click', () => {
    welcome.classList.add('hidden');
    if (!running) start();
  });
  const topbarRight = document.querySelector('.topbar-right');
  if (topbarRight) topbarRight.insertBefore(helpBtn, topbarRight.firstChild);

  if (!seen) welcome.classList.remove('hidden');
})();
