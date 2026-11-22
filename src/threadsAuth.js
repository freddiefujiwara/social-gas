// Meta / Threads token refresh and the Threads OAuth flow.

import { getScriptProperty_ } from './auth.js';
import { META_GRAPH_BASE, SNS_TOKEN_REFRESH_WINDOW_MS } from './snsCounts.js';
import { summarizeInsightsError_ } from './instagramDetail.js';

function isTokenRefreshDue_(expiresAtIso) {
  if (!expiresAtIso) {
    return true;
  }
  const expiresMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresMs)) {
    return true;
  }
  return expiresMs - Date.now() <= SNS_TOKEN_REFRESH_WINDOW_MS;
}

function storeRefreshedToken_(props, tokenKey, expiresKey, data) {
  if (!data || !data.access_token) {
    return false;
  }
  props.setProperty(tokenKey, data.access_token);
  const expiresIn = Number(data.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    props.setProperty(
      expiresKey,
      new Date(Date.now() + expiresIn * 1000).toISOString()
    );
  }
  return true;
}

function refreshMetaTokenIfNeeded_() {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty('META_APP_ID');
  const appSecret = props.getProperty('META_APP_SECRET');
  const token = props.getProperty('META_ACCESS_TOKEN');
  if (!appId || !appSecret || !token) {
    return false;
  }
  if (!isTokenRefreshDue_(props.getProperty('META_TOKEN_EXPIRES_AT'))) {
    return false;
  }
  try {
    const url =
      META_GRAPH_BASE +
      'oauth/access_token?grant_type=fb_exchange_token' +
      '&client_id=' +
      encodeURIComponent(appId) +
      '&client_secret=' +
      encodeURIComponent(appSecret) +
      '&fb_exchange_token=' +
      encodeURIComponent(token);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return false;
    }
    return storeRefreshedToken_(
      props,
      'META_ACCESS_TOKEN',
      'META_TOKEN_EXPIRES_AT',
      JSON.parse(res.getContentText())
    );
  } catch (err) {
    return false;
  }
}

function refreshThreadsTokenIfNeeded_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('META_THREADS_ACCESS_TOKEN');
  if (!token) {
    return false;
  }
  if (!isTokenRefreshDue_(props.getProperty('META_THREADS_TOKEN_EXPIRES_AT'))) {
    return false;
  }
  try {
    const url =
      'https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token' +
      '&access_token=' +
      encodeURIComponent(token);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return false;
    }
    return storeRefreshedToken_(
      props,
      'META_THREADS_ACCESS_TOKEN',
      'META_THREADS_TOKEN_EXPIRES_AT',
      JSON.parse(res.getContentText())
    );
  } catch (err) {
    return false;
  }
}

// --- Threads OAuth (authorization completed inside GAS) ---
// The dedicated Threads app cannot be added to the existing Meta app
// from the developer console, so its long-lived token is obtained
// here instead: the owner runs threadsAuthorizeUrl() in the editor,
// opens the logged URL and approves the threads_basic,
// threads_manage_insights and threads_read_replies scopes.
// threads_basic covers the profile reads, and
// threads_manage_insights is required because the
// follower count comes from the threads_insights edge (the profile
// node has no followers_count field, and insights refuses a
// threads_basic-only token with a permission error). Threads
// redirects the browser back to this Web App's /exec with a code and
// the state saved below; doGet routes that request to
// handleThreadsOAuthCallback_, which exchanges the code for a
// short-lived token, upgrades it to a long-lived one and stores it
// in META_THREADS_ACCESS_TOKEN (the property fetchThreadsFollowers_
// already reads). refreshThreadsTokenIfNeeded() then keeps the token
// alive with th_refresh_token, so the manual authorization is a
// one-time setup step.

const THREADS_OAUTH_STATE_PROPERTY = 'THREADS_OAUTH_STATE';
const THREADS_AUTHORIZE_URL = 'https://threads.net/oauth/authorize';
// Scopes requested at authorization time, comma-separated as the
// Threads OAuth endpoint expects. threads_manage_insights is needed
// for the threads_insights follower count, and threads_read_replies
// for the conversation edge the comments collection reads replies
// from; a refreshed token keeps the scopes of the original
// authorization, so widening the scope requires one fresh
// authorization run.
const THREADS_OAUTH_SCOPES =
  'threads_basic,threads_manage_insights,threads_read_replies';
const THREADS_TOKEN_EXCHANGE_URL = 'https://graph.threads.net/oauth/access_token';
const THREADS_LONG_LIVED_URL = 'https://graph.threads.net/access_token';
const THREADS_REFRESH_URL = 'https://graph.threads.net/refresh_access_token';
// Long-lived Threads tokens live about 60 days; renew at 50 days so a
// failed attempt still leaves a window to retry before expiry.
const THREADS_TOKEN_REFRESH_AGE_MS = 50 * 24 * 60 * 60 * 1000;

function threadsRedirectUri_() {
  const override = getScriptProperty_('THREADS_REDIRECT_URI');
  if (override) {
    return override;
  }
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }
}

// Editor helper: builds the Threads authorization URL and logs it.
// Open the logged URL in a browser and approve; the callback stores
// the long-lived token in the Script Properties.
function threadsAuthorizeUrl() {
  const appId = getScriptProperty_('THREADS_APP_ID');
  if (!appId) {
    console.log('THREADS_APP_ID is not set in Script Properties');
    return '';
  }
  const redirectUri = threadsRedirectUri_();
  if (!redirectUri) {
    console.log('Could not determine the Web App URL; set THREADS_REDIRECT_URI');
    return '';
  }
  const state = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(
    THREADS_OAUTH_STATE_PROPERTY,
    state
  );
  const url =
    THREADS_AUTHORIZE_URL +
    '?client_id=' +
    encodeURIComponent(appId) +
    '&redirect_uri=' +
    encodeURIComponent(redirectUri) +
    '&scope=' +
    THREADS_OAUTH_SCOPES +
    '&response_type=code&state=' +
    encodeURIComponent(state);
  console.log('Threads authorize URL: ' + url);
  return url;
}

// Exchanges an authorization code for the long-lived Threads token
// and stores it. Returns { ok, error } with a secret-free error
// summary on failure (the summaries only reuse API error fields, and
// transport failures are reported without the request URL, which
// carries the app secret in the exchange call).
function handleThreadsOAuthCallback_(code) {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty('THREADS_APP_ID');
  const appSecret = props.getProperty('THREADS_APP_SECRET');
  const redirectUri = threadsRedirectUri_();
  if (!appId || !appSecret) {
    return { ok: false, error: 'THREADS_APP_ID / THREADS_APP_SECRET are not set' };
  }
  if (!redirectUri) {
    return { ok: false, error: 'redirect URI is not available' };
  }
  try {
    const codeRes = UrlFetchApp.fetch(THREADS_TOKEN_EXCHANGE_URL, {
      method: 'post',
      payload: {
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: code,
      },
      muteHttpExceptions: true,
    });
    if (codeRes.getResponseCode() !== 200) {
      return {
        ok: false,
        error:
          'code exchange: ' +
          summarizeInsightsError_(codeRes.getResponseCode(), codeRes.getContentText()),
      };
    }
    const shortLived = JSON.parse(codeRes.getContentText());
    const shortToken = shortLived && shortLived.access_token;
    if (!shortToken) {
      return { ok: false, error: 'code exchange: response had no access_token' };
    }
    const longRes = UrlFetchApp.fetch(
      THREADS_LONG_LIVED_URL +
        '?grant_type=th_exchange_token&client_secret=' +
        encodeURIComponent(appSecret) +
        '&access_token=' +
        encodeURIComponent(shortToken),
      { muteHttpExceptions: true }
    );
    if (longRes.getResponseCode() !== 200) {
      return {
        ok: false,
        error:
          'long-lived exchange: ' +
          summarizeInsightsError_(longRes.getResponseCode(), longRes.getContentText()),
      };
    }
    const longLived = JSON.parse(longRes.getContentText());
    if (!longLived || !longLived.access_token) {
      return { ok: false, error: 'long-lived exchange: response had no access_token' };
    }
    props.setProperty('META_THREADS_ACCESS_TOKEN', longLived.access_token);
    if (shortLived.user_id != null && shortLived.user_id !== '') {
      props.setProperty('THREADS_USER_ID', String(shortLived.user_id));
    }
    props.setProperty('THREADS_TOKEN_AT', new Date().toISOString());
    const expiresIn = Number(longLived.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      props.setProperty(
        'META_THREADS_TOKEN_EXPIRES_AT',
        new Date(Date.now() + expiresIn * 1000).toISOString()
      );
    }
    props.deleteProperty(THREADS_OAUTH_STATE_PROPERTY);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: 'network error while contacting graph.threads.net' };
  }
}

// Renews the OAuth-obtained Threads token once it is 50+ days old.
// Tokens recorded without THREADS_TOKEN_AT (registered manually) are
// left to refreshThreadsTokenIfNeeded_(), which works off the
// recorded expiry instead. Returns a secret-free error summary on
// failure and null otherwise, so collectSnsCounts can surface it as
// the snapshot's threads_error.
function refreshThreadsTokenIfNeeded() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('META_THREADS_ACCESS_TOKEN');
  if (!token) {
    return null;
  }
  const acquiredAt = props.getProperty('THREADS_TOKEN_AT');
  if (!acquiredAt) {
    return null;
  }
  const acquiredMs = Date.parse(acquiredAt);
  if (!Number.isFinite(acquiredMs)) {
    return null;
  }
  if (Date.now() - acquiredMs < THREADS_TOKEN_REFRESH_AGE_MS) {
    return null;
  }
  try {
    const res = UrlFetchApp.fetch(
      THREADS_REFRESH_URL +
        '?grant_type=th_refresh_token&access_token=' +
        encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      const summary =
        'refresh: ' +
        summarizeInsightsError_(res.getResponseCode(), res.getContentText());
      console.log('Threads token refresh failed: ' + summary);
      return summary;
    }
    const data = JSON.parse(res.getContentText());
    if (!data || !data.access_token) {
      const summary = 'refresh: response had no access_token';
      console.log('Threads token refresh failed: ' + summary);
      return summary;
    }
    props.setProperty('META_THREADS_ACCESS_TOKEN', data.access_token);
    props.setProperty('THREADS_TOKEN_AT', new Date().toISOString());
    const expiresIn = Number(data.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      props.setProperty(
        'META_THREADS_TOKEN_EXPIRES_AT',
        new Date(Date.now() + expiresIn * 1000).toISOString()
      );
    }
    console.log('Threads token refreshed');
    return null;
  } catch (err) {
    const summary = 'refresh: network error while contacting graph.threads.net';
    console.log('Threads token refresh failed: ' + summary);
    return summary;
  }
}


export { THREADS_OAUTH_STATE_PROPERTY, handleThreadsOAuthCallback_, isTokenRefreshDue_, refreshMetaTokenIfNeeded_, refreshThreadsTokenIfNeeded, refreshThreadsTokenIfNeeded_, threadsAuthorizeUrl, threadsRedirectUri_ };
