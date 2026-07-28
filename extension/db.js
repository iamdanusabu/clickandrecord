// Shared IndexedDB helper. Loaded by both offscreen.js and editor/editor.js —
// both are extension pages under the same chrome-extension:// origin, so they
// share the same IndexedDB database and can hand off large video Blobs
// without ever routing them through chrome.runtime messaging.

const DR_DB_NAME = 'demo-recorder';
const DR_DB_VERSION = 4;
const DR_STORE = 'recordings';
// Network/console capture lives here rather than in chrome.storage.session:
// clicks fit that store's ~10MB quota comfortably, a QA capture will not.
const DR_LOG_STORE = 'logs';
// The webcam is recorded as its own video so the editor can position and size the
// bubble after the fact. Kept in a separate store because it's written by a
// different context (the controls window) than the screen recording (offscreen) —
// sharing one record would mean two writers racing on a read-modify-write.
const DR_WEBCAM_STORE = 'webcam';
// Subtitle cues, kept so generated text *and* hand corrections survive reopening
// the editor — retranscribing to get your edits back would be unforgivable.
const DR_CAPTION_STORE = 'captions';

// Every store is keyed by sessionId, so a missing one produces IndexedDB's
// famously opaque "key path yielded a value that is not a valid key". Fail with
// something that names the actual problem instead.
function drRequireSessionId(sessionId, where) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error(`${where}: missing sessionId (got ${JSON.stringify(sessionId)})`);
  }
  return sessionId;
}

function drOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DR_DB_NAME, DR_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DR_STORE)) {
        db.createObjectStore(DR_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(DR_LOG_STORE)) {
        db.createObjectStore(DR_LOG_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(DR_WEBCAM_STORE)) {
        db.createObjectStore(DR_WEBCAM_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(DR_CAPTION_STORE)) {
        db.createObjectStore(DR_CAPTION_STORE, { keyPath: 'sessionId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function drSaveRecording(sessionId, blob, meta) {
  drRequireSessionId(sessionId, 'drSaveRecording');
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_STORE, 'readwrite');
    tx.objectStore(DR_STORE).put({ sessionId, blob, meta, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function drLoadRecording(sessionId) {
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_STORE, 'readonly');
    const req = tx.objectStore(DR_STORE).get(sessionId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function drDeleteRecording(sessionId) {
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_STORE, 'readwrite');
    tx.objectStore(DR_STORE).delete(sessionId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function drSaveLogs(sessionId, logs) {
  drRequireSessionId(sessionId, 'drSaveLogs');
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_LOG_STORE, 'readwrite');
    tx.objectStore(DR_LOG_STORE).put({ sessionId, ...logs, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function drLoadLogs(sessionId) {
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_LOG_STORE, 'readonly');
    const req = tx.objectStore(DR_LOG_STORE).get(sessionId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function drSaveWebcam(sessionId, blob, meta) {
  drRequireSessionId(sessionId, 'drSaveWebcam');
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_WEBCAM_STORE, 'readwrite');
    tx.objectStore(DR_WEBCAM_STORE).put({ sessionId, blob, meta, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function drLoadWebcam(sessionId) {
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_WEBCAM_STORE, 'readonly');
    const req = tx.objectStore(DR_WEBCAM_STORE).get(sessionId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function drSaveCaptions(sessionId, cues) {
  drRequireSessionId(sessionId, 'drSaveCaptions');
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_CAPTION_STORE, 'readwrite');
    tx.objectStore(DR_CAPTION_STORE).put({ sessionId, cues, savedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function drLoadCaptions(sessionId) {
  const db = await drOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DR_CAPTION_STORE, 'readonly');
    const req = tx.objectStore(DR_CAPTION_STORE).get(sessionId);
    req.onsuccess = () => resolve(req.result ? req.result.cues : null);
    req.onerror = () => reject(req.error);
  });
}
