// Authentication: Google ID tokens, temporary share sessions and
// long-lived owner sessions.

import { FRONTEND_URL, SHARE_TTL_SECONDS } from './publicActions.js';
import { sheetReadCache_ } from './sheetRead.js';

// --- Authentication (same scheme as the other apps: health / asset / tweet) ---
// Script Properties:
//   GOOGLE_OAUTH_CLIENT_ID: OAuth client ID used to verify ID tokens
//   AVAILABLE_GMAILS: comma-separated emails allowed to read the data
// Data requests accept either a verified Google ID token (id_token
// parameter or Authorization: Bearer header) or a temporary share token
// (share_token parameter). The share token travels in the frontend URL
// hash fragment (#share=...), so it never reaches servers or referrers.
// issue_share / revoke_share actions require an ID token.
// Authentication is always required for the private actions below:
// when the two properties above are unset, token verification fails
// and the request is rejected (fail closed).

function getScriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function extractIdToken_(e) {
  const headers = (e && e.headers) || {};
  const auth = headers.Authorization || headers.authorization || '';
  const bearerMatch = String(auth).match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) {
    return bearerMatch[1];
  }
  return (e && e.parameter && e.parameter.id_token) || '';
}

function getAllowedEmails_() {
  return getScriptProperty_('AVAILABLE_GMAILS')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

// Successful ID-token verifications are cached for a few
// minutes: the /social screen fires several authenticated
// requests per load (detail, history, the blog shapes), and
// without the cache every one of them pays a live tokeninfo
// fetch. The cache key is the SHA-256 hash of the token (the
// token itself is never stored), the entry dies with the
// token's own expiry at the latest, and the allowed-email
// list is re-checked on a hit so removing an address takes
// effect immediately. Failed verifications are never cached.
const ID_TOKEN_VERIFY_CACHE_PREFIX = 'id_token_verify_v1_';
const ID_TOKEN_VERIFY_CACHE_MAX_SECONDS = 300;

function verifyGoogleIdTokenOrThrow_(idToken) {
  if (!idToken) {
    throw new Error('missing id token');
  }
  const oauthClientId = getScriptProperty_('GOOGLE_OAUTH_CLIENT_ID');
  if (!oauthClientId) {
    throw new Error('missing GOOGLE_OAUTH_CLIENT_ID');
  }
  const cache = sheetReadCache_();
  let cacheKey = null;
  try {
    cacheKey = cache
      ? ID_TOKEN_VERIFY_CACHE_PREFIX + hashShareToken_(idToken)
      : null;
  } catch (err) {
    cacheKey = null;
  }
  if (cacheKey) {
    let cached = null;
    try {
      cached = JSON.parse(cache.get(cacheKey) || 'null');
    } catch (err) {
      cached = null;
    }
    if (
      cached &&
      cached.email &&
      Number.isFinite(cached.exp) &&
      cached.exp > Math.floor(Date.now() / 1000)
    ) {
      if (!getAllowedEmails_().includes(cached.email)) {
        throw new Error('forbidden email');
      }
      return { email: cached.email, sub: cached.sub };
    }
  }
  const response = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) {
    throw new Error('token verification failed');
  }
  const payload = JSON.parse(response.getContentText());
  const validIssuer =
    payload.iss === 'accounts.google.com' || payload.iss === 'https://accounts.google.com';
  if (!validIssuer) {
    throw new Error('invalid iss');
  }
  if (payload.aud !== oauthClientId) {
    throw new Error('invalid aud');
  }
  const expSeconds = Number(payload.exp || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expSeconds) || expSeconds <= nowSeconds) {
    throw new Error('token expired');
  }
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!emailVerified) {
    throw new Error('email not verified');
  }
  const email = String(payload.email || '').toLowerCase();
  if (!email) {
    throw new Error('missing email');
  }
  if (!getAllowedEmails_().includes(email)) {
    throw new Error('forbidden email');
  }
  if (cacheKey) {
    try {
      cache.put(
        cacheKey,
        JSON.stringify({ email, sub: payload.sub, exp: expSeconds }),
        Math.max(
          1,
          Math.min(
            ID_TOKEN_VERIFY_CACHE_MAX_SECONDS,
            expSeconds - Math.floor(Date.now() / 1000)
          )
        )
      );
    } catch (err) {
      // Caching a verification is an optimization only; a
      // cache failure never fails the verification itself.
    }
  }
  return { email, sub: payload.sub };
}

// --- Temporary share sessions ---
// Only the SHA-256 hash and the expiry are stored, in Script Properties.
// Issuing a new token overwrites the old one, which invalidates old links.

function hashShareToken_(token) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token))
    .map((byte) => ((byte % 256) + 256) % 256)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function issueShareSession_() {
  const now = new Date();
  const expires = new Date(now.getTime() + SHARE_TTL_SECONDS * 1000);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SHARE_TOKEN_HASH', hashShareToken_(token));
  props.setProperty('SHARE_EXPIRES_AT', expires.toISOString());
  return {
    share_token: token,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
    ttl_seconds: SHARE_TTL_SECONDS,
  };
}

function revokeShareSession_() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('SHARE_TOKEN_HASH');
  props.deleteProperty('SHARE_EXPIRES_AT');
  return { revoked: true };
}

function validateShareToken_(token) {
  if (!token) {
    return null;
  }
  const props = PropertiesService.getScriptProperties();
  const hash = props.getProperty('SHARE_TOKEN_HASH');
  if (!hash || hashShareToken_(token) !== hash) {
    return null;
  }
  const expiresAt = props.getProperty('SHARE_EXPIRES_AT');
  if (!expiresAt || expiresAt <= new Date().toISOString()) {
    return null;
  }
  return { expires_at: expiresAt };
}

// --- Owner sessions (long-lived sign-in) ---
// Google ID tokens expire after about an hour, which used to drop the
// owner back at the sign-in gate. After a Google sign-in the frontend
// exchanges the ID token for one of these 30-day owner sessions and
// uses it for all later calls. The frontend revokes only its own
// session on logout.
//
// Storage: a JSON map in the Script Property OWNER_SESSIONS, of the
// form { "<sha256 hash of token>": "<expires_at ISO>", ... }.
// Owner sessions coexist across devices and browsers: issuing a new
// one adds an entry and does NOT overwrite or revoke the others
// (unlike share sessions, where reissuing must invalidate the old
// link -- that behaviour is unchanged and lives in separate keys).
// A Script Property map is used instead of a sheet tab because this
// app's history spreadsheet is optional (SNS_HISTORY_SHEET_ID may be
// unset, in which case SpreadsheetApp is never touched), while auth
// must work regardless; share and owner sessions have always lived
// in Script Properties here. Each entry is about 100 bytes, expired
// entries are pruned on load, and the map is capped at
// OWNER_SESSIONS_MAX newest entries, so it stays far below the
// per-property size limit. The property is created by this code on
// first issue, so no manual property setup is needed.
//
// Backward compatibility: the previous single-session keys
// OWNER_TOKEN_HASH / OWNER_EXPIRES_AT are still honoured.
// loadOwnerSessions_() merges a live legacy entry into the map in
// memory, so a token issued before this change keeps working until
// its own 30-day expiry; issueOwnerSession_() then persists the
// merged map and deletes the legacy keys (the migration).

const OWNER_SESSIONS_PROPERTY = 'OWNER_SESSIONS';
const OWNER_SESSIONS_MAX = 10;

function loadOwnerSessions_(props) {
  const nowIso = new Date().toISOString();
  const sessions = {};
  try {
    const parsed = JSON.parse(props.getProperty(OWNER_SESSIONS_PROPERTY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const hash of Object.keys(parsed)) {
        const expiresAt = parsed[hash];
        if (typeof expiresAt === 'string' && expiresAt > nowIso) {
          sessions[hash] = expiresAt;
        }
      }
    }
  } catch (err) {
    // A corrupt map must not lock the owner out: start from an
    // empty map; a live legacy entry below is still merged in.
  }
  const legacyHash = props.getProperty('OWNER_TOKEN_HASH');
  const legacyExpiresAt = props.getProperty('OWNER_EXPIRES_AT');
  if (
    legacyHash &&
    legacyExpiresAt &&
    legacyExpiresAt > nowIso &&
    !(legacyHash in sessions)
  ) {
    sessions[legacyHash] = legacyExpiresAt;
  }
  return sessions;
}

function saveOwnerSessions_(props, sessions) {
  let entries = Object.entries(sessions);
  if (entries.length > OWNER_SESSIONS_MAX) {
    entries.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
    entries = entries.slice(0, OWNER_SESSIONS_MAX);
  }
  if (!entries.length) {
    props.deleteProperty(OWNER_SESSIONS_PROPERTY);
    return {};
  }
  const trimmed = {};
  for (const [hash, expiresAt] of entries) {
    trimmed[hash] = expiresAt;
  }
  props.setProperty(OWNER_SESSIONS_PROPERTY, JSON.stringify(trimmed));
  return trimmed;
}

function issueOwnerSession_() {
  const now = new Date();
  const expires = new Date(now.getTime() + SHARE_TTL_SECONDS * 1000);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const props = PropertiesService.getScriptProperties();
  const sessions = loadOwnerSessions_(props);
  sessions[hashShareToken_(token)] = expires.toISOString();
  saveOwnerSessions_(props, sessions);
  // The merged map now carries any legacy session, so the old
  // single-session keys are removed (the migration step).
  props.deleteProperty('OWNER_TOKEN_HASH');
  props.deleteProperty('OWNER_EXPIRES_AT');
  return {
    session_token: token,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
    ttl_seconds: SHARE_TTL_SECONDS,
  };
}

function revokeOwnerSession_(token) {
  const props = PropertiesService.getScriptProperties();
  if (token) {
    const hash = hashShareToken_(token);
    const sessions = loadOwnerSessions_(props);
    if (hash in sessions) {
      delete sessions[hash];
      saveOwnerSessions_(props, sessions);
    }
    if (props.getProperty('OWNER_TOKEN_HASH') === hash) {
      props.deleteProperty('OWNER_TOKEN_HASH');
      props.deleteProperty('OWNER_EXPIRES_AT');
    }
  }
  // Without a token the session to revoke cannot be identified, so
  // no other session is touched (mirrors health-gas).
  return { revoked: true };
}

function validateOwnerToken_(token) {
  if (!token) {
    return null;
  }
  const props = PropertiesService.getScriptProperties();
  const sessions = loadOwnerSessions_(props);
  const expiresAt = sessions[hashShareToken_(token)];
  if (!expiresAt) {
    return null;
  }
  return { expires_at: expiresAt };
}

// Owner proof for owner-only actions: a valid Google ID token, or a
// live owner session token (the post-sign-in steady state).
function requireOwnerAuth_(e) {
  const sessionToken = (e && e.parameter && e.parameter.session_token) || '';
  if (sessionToken && validateOwnerToken_(sessionToken)) {
    return;
  }
  verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
}

// Editor helper: issue a token and log the frontend share URL.
// Useful for bootstrapping before the frontend is deployed.
function issueShareToken() {
  const session = issueShareSession_();
  const url = FRONTEND_URL + '#share=' + session.share_token;
  console.log('Share URL (expires ' + session.expires_at + '): ' + url);
  return url;
}

export { OWNER_SESSIONS_MAX, OWNER_SESSIONS_PROPERTY, extractIdToken_, getAllowedEmails_, getScriptProperty_, hashShareToken_, issueOwnerSession_, issueShareSession_, issueShareToken, loadOwnerSessions_, requireOwnerAuth_, revokeOwnerSession_, revokeShareSession_, saveOwnerSessions_, validateOwnerToken_, validateShareToken_, verifyGoogleIdTokenOrThrow_ };
