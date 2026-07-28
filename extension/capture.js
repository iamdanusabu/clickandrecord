// QA capture: collects network activity and console output for the duration of a
// recording, timestamped against the same clock as the video.
//
// Two sources, because neither is sufficient alone:
//   * chrome.webRequest sees EVERY request (documents, images, beacons — not just
//     ones a script made) and gives headers, status, sizes and timings. What it
//     cannot give, in MV3, is response bodies.
//   * probe.js, injected into the page's MAIN world, wraps fetch/XHR and so does
//     have request payloads and response bodies — but only for requests the page's
//     own JS makes.
// They're merged on the way out (see mergedNetwork), preferring webRequest for
// protocol facts and the probe for bodies.
//
// Loaded into the service worker via importScripts from background.js.

const DR_CAP_LIMITS = {
  network: 5000,
  console: 2000,
  body: 128 * 1024,
  totalBytes: 50 * 1024 * 1024,
};

const drCapture = {
  active: false,
  tabId: null,
  startTime: 0,
  pending: new Map(), // requestId -> entry being assembled across webRequest events
  network: [],        // completed webRequest entries
  probe: [],          // entries from probe.js
  console: [],
  dropped: { network: 0, console: 0 },
  bytes: 0,
};

function drCapReset() {
  drCapture.pending.clear();
  drCapture.network = [];
  drCapture.probe = [];
  drCapture.console = [];
  drCapture.dropped = { network: 0, console: 0 };
  drCapture.bytes = 0;
}

// Every push goes through here so no capture can grow without bound. Oldest
// entries are dropped first and the count is surfaced to the UI, which is
// preferable to silently keeping a partial log that looks complete.
function drCapPush(list, entry, limitKey) {
  const size = drCapEstimateSize(entry);
  if (drCapture.bytes + size > DR_CAP_LIMITS.totalBytes) {
    drCapture.dropped[limitKey] += 1;
    return;
  }
  list.push(entry);
  drCapture.bytes += size;
  const limit = DR_CAP_LIMITS[limitKey];
  while (list.length > limit) {
    const removed = list.shift();
    drCapture.bytes -= drCapEstimateSize(removed);
    drCapture.dropped[limitKey] += 1;
  }
}

function drCapEstimateSize(entry) {
  let n = 200; // rough per-entry overhead
  if (entry.requestBody) n += entry.requestBody.length;
  if (entry.responseBody) n += entry.responseBody.length;
  if (entry.text) n += entry.text.length;
  return n;
}

function drCapRelTime(timeStamp) {
  return Math.max(0, Math.round((timeStamp || Date.now()) - drCapture.startTime));
}

// ---------- webRequest ----------

function drCapMatchesTab(details) {
  return drCapture.active && details.tabId === drCapture.tabId;
}

function drCapEntryFor(details) {
  let entry = drCapture.pending.get(details.requestId);
  if (!entry) {
    entry = {
      id: details.requestId,
      t: drCapRelTime(details.timeStamp),
      method: details.method,
      url: details.url,
      type: details.type,
      source: 'webRequest',
    };
    drCapture.pending.set(details.requestId, entry);
  }
  return entry;
}

function drCapOnBeforeRequest(details) {
  if (!drCapMatchesTab(details)) return;
  const entry = drCapEntryFor(details);
  const body = details.requestBody;
  if (body) {
    if (body.formData) {
      entry.requestBody = JSON.stringify(body.formData).slice(0, DR_CAP_LIMITS.body);
      entry.requestBodyKind = 'formData';
    } else if (body.raw && body.raw.length) {
      // raw is an array of ArrayBuffers; decode what we can.
      try {
        const decoder = new TextDecoder();
        const text = body.raw
          .map((part) => (part.bytes ? decoder.decode(part.bytes) : ''))
          .join('');
        entry.requestBody = text.slice(0, DR_CAP_LIMITS.body);
        entry.requestBodyKind = 'raw';
      } catch (_) {
        entry.requestBodyKind = 'binary';
      }
    }
  }
}

function drCapOnSendHeaders(details) {
  if (!drCapMatchesTab(details)) return;
  drCapEntryFor(details).requestHeaders = details.requestHeaders || [];
}

function drCapOnHeadersReceived(details) {
  if (!drCapMatchesTab(details)) return;
  const entry = drCapEntryFor(details);
  entry.responseHeaders = details.responseHeaders || [];
  entry.status = details.statusCode;
}

function drCapFinish(details, extra) {
  if (!drCapMatchesTab(details)) return;
  const entry = drCapEntryFor(details);
  Object.assign(entry, extra, { endT: drCapRelTime(details.timeStamp) });
  drCapture.pending.delete(details.requestId);
  drCapPush(drCapture.network, entry, 'network');
}

function drCapOnCompleted(details) {
  drCapFinish(details, {
    status: details.statusCode,
    fromCache: details.fromCache,
    responseSize: details.responseSize,
  });
}

function drCapOnErrorOccurred(details) {
  drCapFinish(details, { failed: true, error: details.error });
}

const DR_CAP_FILTER = { urls: ['<all_urls>'] };

function drCapStart(tabId, startTime) {
  if (drCapture.active) drCapStop();
  drCapture.active = true;
  drCapture.tabId = tabId;
  drCapture.startTime = startTime;
  drCapReset();

  chrome.webRequest.onBeforeRequest.addListener(drCapOnBeforeRequest, DR_CAP_FILTER, ['requestBody']);
  chrome.webRequest.onSendHeaders.addListener(drCapOnSendHeaders, DR_CAP_FILTER, ['requestHeaders']);
  chrome.webRequest.onHeadersReceived.addListener(drCapOnHeadersReceived, DR_CAP_FILTER, ['responseHeaders']);
  chrome.webRequest.onCompleted.addListener(drCapOnCompleted, DR_CAP_FILTER);
  chrome.webRequest.onErrorOccurred.addListener(drCapOnErrorOccurred, DR_CAP_FILTER);
}

// Move the clock everything is timestamped against, without disturbing the capture
// itself. Capture is armed a countdown before the recorder rolls (so requests already
// in flight are seen), and the recorder can roll a little off its scheduled instant —
// this is how the true epoch gets applied once it's known. Entries already assembled
// keep the offsets they were given; they're all pre-roll, and drCapOffset floors them
// at zero regardless.
function drCapRebase(startTime) {
  if (!drCapture.active || !startTime) return;
  drCapture.startTime = startTime;
}

function drCapStop() {
  if (!drCapture.active) return;
  drCapture.active = false;
  chrome.webRequest.onBeforeRequest.removeListener(drCapOnBeforeRequest);
  chrome.webRequest.onSendHeaders.removeListener(drCapOnSendHeaders);
  chrome.webRequest.onHeadersReceived.removeListener(drCapOnHeadersReceived);
  chrome.webRequest.onCompleted.removeListener(drCapOnCompleted);
  chrome.webRequest.onErrorOccurred.removeListener(drCapOnErrorOccurred);
}

// ---------- entries relayed from probe.js ----------

function drCapAddProbeEntry(payload) {
  if (!drCapture.active || !payload) return;
  if (payload.kind === 'console') {
    drCapPush(drCapture.console, payload, 'console');
  } else if (payload.kind === 'network') {
    drCapPush(drCapture.probe, payload, 'network');
  }
}

// ---------- merge ----------

// The probe knows nothing of webRequest's requestId, so pairing is a heuristic:
// same method+URL, closest start time within a tolerance. Concurrent identical
// requests can therefore mis-pair; an unmatched probe entry is kept as its own
// row rather than discarded, and `bodySource` records where a body came from so
// the UI can be honest about it.
const DR_CAP_PAIR_TOLERANCE_MS = 1500;

function drCapMergedNetwork() {
  const unclaimed = new Set(drCapture.probe.map((_, i) => i));

  const merged = drCapture.network.map((entry) => {
    let bestIndex = -1;
    let bestDelta = Infinity;
    drCapture.probe.forEach((p, i) => {
      if (!unclaimed.has(i)) return;
      if (p.method !== entry.method || p.url !== entry.url) return;
      const delta = Math.abs(p.t - entry.t);
      if (delta < bestDelta && delta <= DR_CAP_PAIR_TOLERANCE_MS) {
        bestDelta = delta;
        bestIndex = i;
      }
    });
    if (bestIndex < 0) return { ...entry, bodySource: null };

    unclaimed.delete(bestIndex);
    const p = drCapture.probe[bestIndex];
    return {
      ...entry,
      requestBody: entry.requestBody || p.requestBody || null,
      responseBody: p.responseBody || null,
      truncated: !!p.truncated,
      bodySource: p.source, // 'fetch' | 'xhr'
    };
  });

  drCapture.probe.forEach((p, i) => {
    if (unclaimed.has(i)) merged.push({ ...p, bodySource: p.source, unpaired: true });
  });

  return merged.sort((a, b) => a.t - b.t);
}

function drCapSnapshot() {
  return {
    network: drCapMergedNetwork(),
    console: [...drCapture.console].sort((a, b) => a.t - b.t),
    dropped: { ...drCapture.dropped },
    // Response bodies are only ever available for page-initiated fetch/XHR;
    // the editor uses this to explain empty bodies rather than look broken.
    responseBodiesLimited: true,
  };
}
