// Click & Record — right-rail tab switching.
//
// Purely presentational: this file owns which rail page is on screen and nothing
// else. editor.js is untouched by it — every control it manages keeps the same id
// and the same handlers, they just live in a tab now.
//
// Two rail pages depend on what the recording actually contains, and editor.js
// reveals them by flipping visibility on the panels themselves:
//   #webcam-row    — `hidden` attribute cleared when a webcam track loads
//   #debug-panel   — `.hidden` class removed when QA capture data loads
// Rather than duplicating that knowledge (or editing editor.js), the tabs watch
// those two elements and enable themselves when their content appears.

(() => {
  const tabs = Array.from(document.querySelectorAll('.rail-tab'));
  const pages = Array.from(document.querySelectorAll('.rail-page'));
  if (!tabs.length) return;

  function show(name) {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.page === name));
    pages.forEach((p) => p.classList.toggle('active', p.dataset.page === name));
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.disabled) return;
      // Opening a tab is an acknowledgement — clear its "new data" dot.
      tab.classList.remove('has-data');
      show(tab.dataset.page);
    });
  });

  // ---------- availability ----------

  // `notify` puts a dot on the tab the first time its content arrives, so data
  // showing up in a collapsed tab isn't silently missed.
  function link({ page, panel, empty, isAvailable, notify }) {
    const tab = tabs.find((t) => t.dataset.page === page);
    const panelEl = document.getElementById(panel);
    const emptyEl = empty ? document.getElementById(empty) : null;
    if (!tab || !panelEl) return;

    let wasAvailable = null;
    function sync() {
      const available = isAvailable(panelEl);
      tab.disabled = !available;
      tab.classList.toggle('unavailable', !available);
      if (emptyEl) emptyEl.classList.toggle('hidden', available);
      // Becoming available is the interesting transition; the initial false isn't.
      if (notify && available && wasAvailable === false && !tab.classList.contains('active')) {
        tab.classList.add('has-data');
      }
      wasAvailable = available;
      // If the open tab just went away, fall back to the first page.
      if (!available && tab.classList.contains('active')) show(tabs[0].dataset.page);
    }

    sync();
    new MutationObserver(sync).observe(panelEl, {
      attributes: true,
      attributeFilter: ['hidden', 'class'],
    });
  }

  link({
    page: 'camera',
    panel: 'webcam-row',
    empty: 'webcam-empty',
    isAvailable: (el) => !el.hidden,
  });

  link({
    page: 'inspect',
    panel: 'debug-panel',
    empty: 'debug-empty-state',
    isAvailable: (el) => !el.classList.contains('hidden'),
    notify: true,
  });
})();
