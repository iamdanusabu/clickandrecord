// Injected into the page's MAIN world (chrome.scripting world: 'MAIN') when QA
// capture is enabled, so it can wrap the page's own globals.
//
// Why this exists: chrome.webRequest sees every request but MV3 gives it no way
// to read response bodies. Wrapping fetch/XHR here recovers request payloads and
// response bodies for the requests QAs actually care about (API calls), and the
// same hook point gives us real console output. The alternative, chrome.debugger,
// would provide all of this but shows a "started debugging this browser" infobar
// and locks DevTools out of the tab.
//
// The MAIN world has no chrome.* APIs, so entries leave via window.postMessage
// and content.js relays them to the background.

(() => {
  // Guard against double injection (e.g. an SPA soft-navigation re-running us).
  if (window.__drProbeInstalled) return;
  window.__drProbeInstalled = true;

  const TAG = 'DR_PROBE';
  const MAX_BODY = 128 * 1024; // matches the cap capture.js enforces

  // Read on every use rather than captured once. The recording's epoch is the moment
  // MediaRecorder actually rolls, which is a countdown away from injection and can
  // land a couple of hundred milliseconds off its scheduled instant — background.js
  // rewrites this attribute with the true value once it knows it. Snapshotting here
  // would leave every entry biased by that difference.
  let fallbackStart = Date.now();
  function base() {
    const attr = Number(document.documentElement.dataset.drStart);
    return Number.isFinite(attr) && attr > 0 ? attr : fallbackStart;
  }

  function emit(payload) {
    try {
      window.postMessage({ __drTag: TAG, payload }, window.location.origin);
    } catch (_) {
      // structured-clone failure on an exotic value — drop this entry rather
      // than break the page
    }
  }

  function now() { return Date.now() - base(); }

  function clip(text) {
    if (typeof text !== 'string') return { body: null, truncated: false };
    if (text.length <= MAX_BODY) return { body: text, truncated: false };
    return { body: text.slice(0, MAX_BODY), truncated: true };
  }

  // ---------- console + errors ----------

  function describe(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`;
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value); // circular or exotic
    }
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const original = console[level];
    if (typeof original !== 'function') return;
    console[level] = function drConsole(...args) {
      emit({
        kind: 'console',
        level,
        t: now(),
        text: args.map(describe).join(' '),
      });
      return original.apply(this, args);
    };
  });

  window.addEventListener('error', (e) => {
    emit({
      kind: 'console',
      level: 'error',
      t: now(),
      text: `Uncaught ${e.message}`,
      source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      stack: e.error && e.error.stack,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    emit({
      kind: 'console',
      level: 'error',
      t: now(),
      text: `Unhandled promise rejection: ${describe(e.reason)}`,
    });
  });

  // ---------- fetch ----------

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function drFetch(input, init) {
      const started = now();
      const req = input instanceof Request ? input : new Request(input, init);
      let requestBody = null;
      try {
        // Reading the body consumes it, so clone first.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          requestBody = clip(await req.clone().text()).body;
        }
      } catch (_) {
        // streaming or opaque body
      }

      let response;
      try {
        response = await originalFetch.call(this, req);
      } catch (err) {
        emit({
          kind: 'network',
          source: 'fetch',
          t: started,
          endT: now(),
          method: req.method,
          url: req.url,
          failed: true,
          error: String(err && err.message ? err.message : err),
          requestBody,
        });
        throw err;
      }

      // clone() so the page's own read of the body isn't consumed by ours.
      let responseBody = null;
      let truncated = false;
      try {
        const clipped = clip(await response.clone().text());
        responseBody = clipped.body;
        truncated = clipped.truncated;
      } catch (_) {
        // opaque/cross-origin response, or an already-disturbed stream
      }

      emit({
        kind: 'network',
        source: 'fetch',
        t: started,
        endT: now(),
        method: req.method,
        url: req.url,
        status: response.status,
        statusText: response.statusText,
        responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
        requestBody,
        responseBody,
        truncated,
      });

      return response;
    };
  }

  // ---------- XMLHttpRequest ----------

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    const open = OriginalXHR.prototype.open;
    const send = OriginalXHR.prototype.send;
    const setHeader = OriginalXHR.prototype.setRequestHeader;

    OriginalXHR.prototype.open = function drOpen(method, url, ...rest) {
      this.__dr = { method, url, headers: [] };
      return open.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.setRequestHeader = function drSetHeader(name, value) {
      if (this.__dr) this.__dr.headers.push({ name, value });
      return setHeader.call(this, name, value);
    };

    OriginalXHR.prototype.send = function drSend(body) {
      const meta = this.__dr;
      if (meta) {
        meta.started = now();
        this.addEventListener('loadend', () => {
          let responseBody = null;
          let truncated = false;
          try {
            // Touching .responseText throws for arraybuffer/blob response types.
            if (this.responseType === '' || this.responseType === 'text') {
              const clipped = clip(this.responseText);
              responseBody = clipped.body;
              truncated = clipped.truncated;
            }
          } catch (_) {
            // non-text response
          }
          emit({
            kind: 'network',
            source: 'xhr',
            t: meta.started,
            endT: now(),
            method: meta.method,
            url: new URL(meta.url, window.location.href).href,
            status: this.status,
            statusText: this.statusText,
            failed: this.status === 0,
            requestHeaders: meta.headers,
            requestBody: typeof body === 'string' ? clip(body).body : null,
            responseBody,
            truncated,
          });
        });
      }
      return send.call(this, body);
    };
  }
})();
