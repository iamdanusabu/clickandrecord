// Runs in a hidden iframe embedded by the hosted editor page.
//
// The recording lives in IndexedDB under the chrome-extension:// origin, so a
// page on another origin can't read it. This frame *is* that origin, so it can
// — and it hands the Blob up to its parent via postMessage. Structured clone
// passes a Blob by reference, so even a large video isn't copied through JS
// memory, and the bytes never leave the machine.
//
// Only origins matching the allowlist below are answered. Note that the parent
// page can lie about nothing here: event.origin is set by the browser, not by
// the sender.

const ALLOWED_PARENT_ORIGINS = [
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  // The production host. Any origin listed here can read recordings out of the
  // extension, so additions belong to deployments you control — nothing else.
  /^https:\/\/(www\.)?clickandrecord\.tech$/,
];

function isAllowedOrigin(origin) {
  return ALLOWED_PARENT_ORIGINS.some((re) => re.test(origin));
}

window.addEventListener('message', async (event) => {
  if (!isAllowedOrigin(event.origin)) return;
  const msg = event.data;
  if (!msg || !msg.sessionId) return;

  const reply = (payload) => event.source.postMessage(payload, event.origin);

  try {
    if (msg.type === 'DR_REQUEST_RECORDING') {
      const rec = await drLoadRecording(msg.sessionId);
      if (!rec) {
        reply({ type: 'DR_ERROR', error: 'Recording not found (it may have been cleared from storage).' });
        return;
      }
      const key = `session:${msg.sessionId}`;
      const stored = await chrome.storage.session.get(key);
      const info = stored[key] || {};
      reply({
        type: 'DR_RECORDING',
        blob: rec.blob,
        meta: rec.meta,
        clicks: info.clicks || [],
        pageUrl: info.pageUrl || '',
        pageTitle: info.pageTitle || '',
        source: info.source || 'tab',
      });
      return;
    }

    if (msg.type === 'DR_REQUEST_LOGS') {
      reply({ type: 'DR_LOGS', logs: await drLoadLogs(msg.sessionId) });
      return;
    }

    if (msg.type === 'DR_REQUEST_CAPTIONS') {
      reply({ type: 'DR_CAPTIONS', cues: await drLoadCaptions(msg.sessionId) });
      return;
    }

    if (msg.type === 'DR_SAVE_CAPTIONS') {
      // The hosted editor can't reach IndexedDB itself, so corrections come back
      // through here to be persisted.
      await drSaveCaptions(msg.sessionId, msg.cues || []);
      reply({ type: 'DR_CAPTIONS_SAVED' });
      return;
    }

    if (msg.type === 'DR_REQUEST_WEBCAM') {
      const cam = await drLoadWebcam(msg.sessionId);
      // Older recordings have the bubble baked in and no separate track; null is a
      // valid answer, not an error.
      reply({
        type: 'DR_WEBCAM',
        blob: cam ? cam.blob : null,
        meta: cam ? cam.meta : null,
      });
      return;
    }

    if (msg.type === 'DR_UPLOAD_TO_DRIVE') {
      // chrome.identity isn't reachable from the hosted page, so the upload runs
      // here — this frame is an extension page. The editor sends the rendered
      // (edited) blob; falling back to the raw recording would silently upload
      // something other than what the user was looking at, so we don't.
      try {
        const blob = msg.blob;
        if (!blob) throw new Error('No rendered video was supplied for upload.');
        const result = await drDriveUpload(blob, msg.filename);
        reply({ type: 'DR_UPLOAD_RESULT', result: { ok: true, ...result } });
      } catch (err) {
        reply({ type: 'DR_UPLOAD_RESULT', result: { ok: false, error: err.message || String(err) } });
      }
      return;
    }
  } catch (err) {
    reply({ type: 'DR_ERROR', error: err.message || String(err) });
  }
});

// Tell the host page we're listening. Carries no data, so '*' is safe here —
// and the parent's own origin isn't known to us until it messages us first.
if (window.parent !== window) {
  window.parent.postMessage({ type: 'DR_BRIDGE_READY' }, '*');
}
