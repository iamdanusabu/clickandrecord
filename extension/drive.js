// Google Drive upload.
//
// Auth uses chrome.identity.launchWebAuthFlow rather than getAuthToken: the
// latter needs an `oauth2` block in the manifest, and a manifest carrying a
// placeholder client ID would fail to load while Drive is unconfigured. This way
// the feature stays genuinely dormant until a client ID is set, and it works for
// unpacked extensions.
//
// Scope is drive.file — the narrowest scope that allows uploading. The extension
// can only ever see files it created itself, never the user's existing Drive.
//
// Setup, in Google Cloud Console, for whichever client ID is in use:
//   1. APIs & Services -> enable the Google Drive API.
//   2. Credentials -> OAuth client ID of type "Web application".
//   3. Under "Authorised redirect URIs" add exactly:
//        https://<extension-id>.chromiumapp.org/
//      (chrome.identity.getRedirectURL() returns this; log it if unsure.)
//   4. OAuth consent screen: while the app is in "Testing", every Google account
//      that will sign in must be listed under "Test users".

const DR_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DR_DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

// An OAuth *client ID* is a public identifier, not a secret — it travels in the
// auth URL on every sign-in, and Chrome extensions conventionally ship it in the
// manifest. Safe to keep in source. (A client *secret* would not be, and the
// implicit flow used here never needs one.)
// Override at runtime without touching this file:
//   chrome.storage.local.set({ driveClientId: '…apps.googleusercontent.com' })
const DR_DRIVE_DEFAULT_CLIENT_ID = '661065451891-ei7tm5j1ikve715cd90ucs9n2tisgbk6.apps.googleusercontent.com';

// Implicit-flow tokens carry no refresh token, so they're cached in memory with
// their expiry and re-requested when stale.
let drDriveToken = null; // { accessToken, expiresAt }

async function drDriveClientId() {
  try {
    const { driveClientId } = await chrome.storage.local.get('driveClientId');
    if (driveClientId) return driveClientId;
  } catch (_) {
    // storage unavailable — fall back to the built-in id
  }
  return DR_DRIVE_DEFAULT_CLIENT_ID || null;
}

async function drDriveGetToken({ interactive = true } = {}) {
  if (drDriveToken && drDriveToken.expiresAt > Date.now() + 60_000) {
    return drDriveToken.accessToken;
  }

  const clientId = await drDriveClientId();
  if (!clientId) {
    throw new Error(
      'Google Drive is not configured yet. Set a client ID with '
      + "chrome.storage.local.set({ driveClientId: '…apps.googleusercontent.com' }) — see drive.js for setup steps."
    );
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', DR_DRIVE_SCOPE);
  authUrl.searchParams.set('prompt', 'consent');

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive,
  });
  if (!redirect) throw new Error('Google sign-in was cancelled.');

  // Implicit flow returns the token in the URL fragment.
  const params = new URLSearchParams(new URL(redirect).hash.replace(/^#/, ''));
  const accessToken = params.get('access_token');
  if (!accessToken) {
    throw new Error(params.get('error') || 'Google sign-in did not return a token.');
  }
  const expiresIn = Number(params.get('expires_in') || 3600) * 1000;
  drDriveToken = { accessToken, expiresAt: Date.now() + expiresIn };
  return accessToken;
}

function drDriveSignOut() {
  drDriveToken = null;
}

// Resumable upload: a single multipart POST would mean holding the whole video in
// one request body, which is a bad idea at video sizes. This opens a session,
// then streams the blob to the returned URL.
async function drDriveUpload(blob, filename, onProgress) {
  const token = await drDriveGetToken();

  const startRes = await fetch(DR_DRIVE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': blob.type || 'video/webm',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify({ name: filename, mimeType: blob.type || 'video/webm' }),
  });

  if (!startRes.ok) {
    if (startRes.status === 401) drDriveSignOut(); // force re-auth next attempt
    throw new Error(`Drive rejected the upload session (${startRes.status}): ${await startRes.text()}`);
  }

  const sessionUrl = startRes.headers.get('Location');
  if (!sessionUrl) throw new Error('Drive did not return an upload URL.');

  if (onProgress) onProgress(0);
  const putRes = await fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || 'video/webm',
      'Content-Length': String(blob.size),
    },
    body: blob,
  });
  if (!putRes.ok) {
    throw new Error(`Drive upload failed (${putRes.status}): ${await putRes.text()}`);
  }
  if (onProgress) onProgress(1);

  const file = await putRes.json();
  return {
    id: file.id,
    name: file.name,
    link: `https://drive.google.com/file/d/${file.id}/view`,
  };
}

// Callers: editor/editor.js when it runs on the extension origin, and bridge.js
// when the editor is hosted elsewhere. Both hand over the *rendered* blob, so
// there's deliberately no path here that uploads the raw recording — that would
// silently send something other than what the user edited.
