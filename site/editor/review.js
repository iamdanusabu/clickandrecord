// Click & Record — "leave a review" prompt.
//
// Same rule as ui.js and tour.js: purely additive. It injects its own DOM and
// listens for one event editor.js dispatches after a successful export
// ('cr:exported'); it never reaches into editor.js internals.
//
// Two surfaces, both only for people who recorded with the extension (a ?session=
// URL) — someone who opened a file in the standalone editor may never have
// installed it, and asking them to review it would be odd:
//
//   1. A small card after a successful export, once they've clearly been using it:
//      at least MIN_EXPORTS exports, or an export MIN_DAYS+ days after first use.
//      That's the moment they just got something out of the product.
//   2. A quiet line inside the export progress overlay for returning users — the
//      one place people sit and wait with nothing to do.
//
// Both options are always shown side by side — review, or email us if something's
// wrong. Deliberately no "Are you enjoying it?" gate that sends only happy people
// to the store: filtering reviews by sentiment is review manipulation under the
// Chrome Web Store policies, and it hides exactly the feedback worth hearing.
//
// State lives in localStorage on this origin; if storage is unavailable the prompt
// simply never shows.

(() => {
  const REVIEW_URL = 'https://chromewebstore.google.com/detail/lfpnagkdegnjjghefcbpeoblgoaklnnn/reviews';
  const FEEDBACK_EMAIL = 'nevolabsco@gmail.com';
  const KEY = 'cr_review_v1';

  const MIN_EXPORTS = 2;
  const MIN_DAYS = 3;
  const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // after "Not now" / feedback
  const MAX_DISMISSALS = 3;                   // then never ask again
  const DAY_MS = 24 * 60 * 60 * 1000;

  const fromExtension = new URLSearchParams(location.search).has('session');
  if (!fromExtension) return;

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || null;
    } catch (_) {
      return null;
    }
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { /* private mode etc. */ }
  }

  let state = load();
  if (!state) {
    state = { firstSeen: Date.now(), exports: 0, reviewed: false, dismissals: 0, snoozedUntil: 0 };
    save(state);
    // If storage refused the write, don't pester someone on every visit.
    if (!load()) return;
  }

  const finished = () => state.reviewed || state.dismissals >= MAX_DISMISSALS;
  const snoozed = () => Date.now() < (state.snoozedUntil || 0);
  const engaged = () => state.exports >= MIN_EXPORTS
    || (state.exports >= 1 && Date.now() - state.firstSeen >= MIN_DAYS * DAY_MS);

  const mailto = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent('Click & Record feedback')}`;

  function markReviewed() { state.reviewed = true; save(state); }
  function snooze() {
    state.dismissals += 1;
    state.snoozedUntil = Date.now() + SNOOZE_MS;
    save(state);
  }

  // ---------- styles ----------

  const style = document.createElement('style');
  style.textContent = `
.cr-review {
  position: fixed; right: 20px; bottom: 20px; z-index: 900;
  width: min(360px, calc(100vw - 32px));
  padding: 18px 18px 16px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  font-family: var(--font-ui);
  animation: cr-review-in .28s cubic-bezier(.2,.7,.2,1);
}
@keyframes cr-review-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .cr-review { animation: none; } }
.cr-review h3 { margin: 0 28px 6px 0; font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.cr-review p { margin: 0 0 14px; font-size: 12.5px; line-height: 1.5; color: var(--text-dim); }
.cr-review .cr-review-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.cr-review a.primary { text-decoration: none; border-radius: var(--radius-sm); transition: background .12s ease; }
.cr-review .cr-review-feedback { font-size: 12.5px; color: var(--text-dim); text-decoration: underline; text-underline-offset: 3px; }
.cr-review .cr-review-feedback:hover { color: var(--text); }
.cr-review .cr-review-close {
  position: absolute; top: 10px; right: 10px; width: 26px; height: 26px;
  display: grid; place-items: center; padding: 0;
  background: transparent; border: 0; border-radius: var(--radius-xs);
  color: var(--text-faint); font-size: 16px; line-height: 1; cursor: pointer;
}
.cr-review .cr-review-close:hover { background: var(--surface); color: var(--text); }
.cr-review-later { margin-left: auto; font-size: 12px; color: var(--text-faint); background: none; border: 0; padding: 4px; cursor: pointer; }
.cr-review-later:hover { color: var(--text); }
.cr-review-inline { margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-dim); line-height: 1.5; }
.cr-review-inline a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
`;
  document.head.appendChild(style);

  // ---------- 1. post-export card ----------

  let card = null;

  function closeCard() {
    if (card) { card.remove(); card = null; }
  }

  function showCard() {
    if (card) return;
    card = document.createElement('div');
    card.className = 'cr-review';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'cr-review-title');
    card.innerHTML = `
      <button type="button" class="cr-review-close" aria-label="Close">×</button>
      <h3 id="cr-review-title">Your video is ready. Got a minute?</h3>
      <p>Click &amp; Record is free and made by a tiny team. A review on the Chrome Web Store
        is the single biggest thing that helps other people find it. Something not working?
        Tell us instead and we'll fix it.</p>
      <div class="cr-review-actions">
        <a class="primary" href="${REVIEW_URL}" target="_blank" rel="noopener" data-act="review">Leave a review</a>
        <a class="cr-review-feedback" href="${mailto}" data-act="feedback">Send feedback</a>
        <button type="button" class="cr-review-later" data-act="later">Not now</button>
      </div>`;
    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act
        || (e.target.closest('.cr-review-close') ? 'later' : null);
      if (!act) return;
      if (act === 'review') markReviewed();
      else snooze(); // feedback or dismiss — ask again later, not tomorrow
      closeCard();
    });
    document.body.appendChild(card);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && card) { snooze(); closeCard(); }
  });

  window.addEventListener('cr:exported', () => {
    state.exports += 1;
    save(state);
    if (!finished() && !snoozed() && engaged()) {
      // A beat after the download starts, so it doesn't land on top of the
      // browser's own download bubble at the same instant.
      setTimeout(showCard, 1200);
    }
  });

  // ---------- 2. line in the export overlay ----------

  const box = document.querySelector('#export-overlay .export-box');
  if (box) {
    const line = document.createElement('p');
    line.className = 'cr-review-inline hidden';
    line.innerHTML = `While you wait: if Click &amp; Record has been useful,
      <a href="${REVIEW_URL}" target="_blank" rel="noopener">a quick review</a> helps a lot.
      Problem? <a href="${mailto}">Email us</a>.`;
    line.querySelector(`a[href="${REVIEW_URL}"]`).addEventListener('click', markReviewed);
    box.appendChild(line);

    // Shown each time the overlay opens, to people who've already exported at
    // least once — a first-time exporter hasn't seen the result yet.
    const overlay = document.getElementById('export-overlay');
    const sync = () => {
      const open = !overlay.classList.contains('hidden');
      if (open) line.classList.toggle('hidden', finished() || state.exports < 1);
    };
    new MutationObserver(sync).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }
})();
