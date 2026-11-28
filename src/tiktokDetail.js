// TikTok detail: account totals and recent videos (Display API).

import { getScriptProperty_ } from './auth.js';
import { apiNumberOrNull_ } from './snsCounts.js';
import { joinSnsErrors_ } from './instagramDetail.js';
import { errorMessageText_ } from './historyWrite.js';

// --- TikTok detail (Display API, sns_detail only) ---
// TikTok joins the collection through its official Display API:
// collectSnsCounts() reads the account totals (followers,
// following, total likes, video count) from /v2/user/info/ and
// the newest videos with their public metrics from
// /v2/video/list/, into the snapshot's tiktok section (served
// only through the authenticated action=sns_detail; the public
// projection returns the follower count only).
//
// Script Properties used here:
//   TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET: the TikTok app's
//     credentials (developers.tiktok.com), used only for the
//     OAuth token calls below.
//   TIKTOK_REFRESH_TOKEN: the long-lived refresh token from the
//     one-time authorization; TikTok rotates it on refresh, and
//     the newest one is stored back on every refresh.
//   TIKTOK_ACCESS_TOKEN / TIKTOK_ACCESS_TOKEN_EXPIRES_AT: the
//     short-lived access token (about a day) and its expiry as
//     a millisecond epoch, maintained by ensureTikTokAccessToken_.
//   TIKTOK_USERNAME: the authorized account's username, recorded
//     whenever the user-info call succeeds, so the sheet-backed
//     read side can rebuild video URLs (the history tabs store
//     no username, exactly like the X section).
// While the client credentials or the refresh token are unset
// the section reads as all nulls with tiktok_error saying so —
// TikTok simply is not connected yet. Every fetch fails
// independently, exactly like the other networks: an
// unobtainable value stays null and the rest of the snapshot is
// unaffected, and error summaries are built from response
// status/body only, never from a request (the token calls carry
// the client secret in their body).
//
// One-time setup: set TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET,
// run logTikTokAuthorizeUrl() in the editor, open the logged
// URL and approve; TikTok redirects back to this Web App's /exec
// (TIKTOK_REDIRECT_URI, registered as the app's redirect URI)
// with a code, which the Web App itself stores in
// TIKTOK_AUTH_CODE (see handleTikTokOAuthCallback_). Then run
// bootstrapTikTokToken(), which exchanges it for the first
// access / refresh token pair and deletes the code.

const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_REDIRECT_URI =
  'https://script.google.com/macros/s/AKfycbypis7IqAtM2u0_h7ysiZ5UgztUEwNYJ1zPMnr8IbTBXiyfiapfRMtD_9CxVpc5G8YVzQ/exec';
// video.upload joins the Display API scopes for the draft
// upload below (Content Posting API). The stored refresh
// token only carries the scopes granted when it was issued,
// so after this addition the one-time authorization has to be
// re-run (logTikTokAuthorizeUrl + bootstrapTikTokToken) before
// uploads work; the read side is unaffected.
const TIKTOK_OAUTH_SCOPES =
  'user.info.basic,user.info.stats,video.list,video.upload';
// The fixed OAuth state of the authorization below. doGet
// routes a code back here by this state (checked before the
// Threads callback, whose state is a saved random value, so
// the two can never collide).
const TIKTOK_OAUTH_STATE = 'social-gas';
// Only the statistics fields are requested from /v2/user/info/.
// The basic fields (open_id, display_name, username) stay out
// on purpose: measured on 2026-11-28 in the Sandbox, a user-info
// call that includes a basic field fails wholesale with
// HTTP 401 scope_not_authorized — even though user.info.basic
// is granted — and takes the statistics down with it, while a
// statistics-only call succeeds. The username therefore comes
// from the recorded TIKTOK_USERNAME property whenever the
// response carries none (see fetchTikTokAccountDetail_).
const TIKTOK_USER_FIELDS =
  'follower_count,following_count,likes_count,video_count';
const TIKTOK_VIDEO_FIELDS =
  'id,create_time,title,duration,view_count,like_count,comment_count,share_count,cover_image_url';
const SNS_TIKTOK_RECENT_VIDEOS_LIMIT = 20;
// An access token inside its last minute counts as expired, so
// a collection never starts a pair of API calls on a token that
// dies between them.
const TIKTOK_TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

// TikTok API error bodies carry API messages (no secrets), so a
// truncated message is safe to keep for diagnosis.
function summarizeTikTokError_(err) {
  return errorMessageText_(err).slice(0, 200);
}

// A compact summary of a TikTok error response, e.g.
// "HTTP 401 code=access_token_invalid: <message>". TikTok v2
// error bodies are { error: { code, message, log_id } }; only
// the code and message are used, and the message is truncated,
// so nothing else in the body can leak into the snapshot or
// the log.
function tikTokApiErrorSummary_(status, bodyText) {
  let summary = 'HTTP ' + status;
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    parsed = null;
  }
  const error = parsed && parsed.error;
  if (error) {
    if (error.code !== undefined && error.code !== null && error.code !== '') {
      summary += ' code=' + error.code;
    }
    if (error.message) {
      summary += ': ' + String(error.message).slice(0, 200);
    }
  }
  return summary;
}

// The error a TikTok v2 body carries on an HTTP 200 (the API
// reports some failures that way), as a summary, or null when
// the body reports success (error.code "ok" or no error at all).
function tikTokBodyError_(data) {
  const error = data && data.error;
  if (!error || !error.code || error.code === 'ok') {
    return null;
  }
  return (
    'code=' +
    error.code +
    (error.message ? ': ' + String(error.message).slice(0, 200) : '')
  );
}

// One token-endpoint POST (form body: Apps Script sends an
// object payload as application/x-www-form-urlencoded, which
// is what /v2/oauth/token/ expects). Returns { data, error }
// and never throws; the summaries never include the request,
// whose body carries the client secret.
function postTikTokToken_(payload) {
  let res;
  try {
    res = UrlFetchApp.fetch(TIKTOK_TOKEN_URL, {
      method: 'post',
      payload,
      muteHttpExceptions: true,
    });
  } catch (err) {
    return {
      data: null,
      error: 'fetch exception (' + ((err && err.name) || 'Error') + ')',
    };
  }
  const status = res.getResponseCode();
  const bodyText = res.getContentText();
  if (status !== 200) {
    return { data: null, error: tikTokApiErrorSummary_(status, bodyText) };
  }
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch (err) {
    return { data: null, error: 'HTTP 200 with unparseable JSON body' };
  }
  const bodyError = tikTokBodyError_(data);
  if (bodyError) {
    return { data: null, error: bodyError };
  }
  return { data, error: null };
}

// Stores a token-endpoint response: the access token, its
// expiry (millisecond epoch, from expires_in seconds) and the
// refresh token whenever the response rotates it. Returns
// false when the response carries no access token.
function storeTikTokTokens_(props, data) {
  if (!data || !data.access_token) {
    return false;
  }
  props.setProperty('TIKTOK_ACCESS_TOKEN', data.access_token);
  const expiresIn = Number(data.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    props.setProperty(
      'TIKTOK_ACCESS_TOKEN_EXPIRES_AT',
      String(Date.now() + expiresIn * 1000)
    );
  }
  if (data.refresh_token) {
    props.setProperty('TIKTOK_REFRESH_TOKEN', data.refresh_token);
  }
  return true;
}

// The access token for the API calls, refreshing it first when
// there is none or the stored one is expired (inside the
// safety margin). Returns { token, error }: token is null when
// TikTok is not configured or the refresh failed, with error
// saying which.
function ensureTikTokAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const clientKey = props.getProperty('TIKTOK_CLIENT_KEY');
  const clientSecret = props.getProperty('TIKTOK_CLIENT_SECRET');
  const refreshToken = props.getProperty('TIKTOK_REFRESH_TOKEN');
  if (!clientKey || !clientSecret || !refreshToken) {
    return {
      token: null,
      error:
        'TikTok API credentials are not configured ' +
        '(TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REFRESH_TOKEN)',
    };
  }
  const accessToken = props.getProperty('TIKTOK_ACCESS_TOKEN');
  const expiresAt = Number(props.getProperty('TIKTOK_ACCESS_TOKEN_EXPIRES_AT'));
  if (
    accessToken &&
    Number.isFinite(expiresAt) &&
    expiresAt - Date.now() > TIKTOK_TOKEN_EXPIRY_MARGIN_MS
  ) {
    return { token: accessToken, error: null };
  }
  const res = postTikTokToken_({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (res.error) {
    return { token: null, error: 'token refresh: ' + res.error };
  }
  if (!storeTikTokTokens_(props, res.data)) {
    return { token: null, error: 'token refresh: response had no access_token' };
  }
  return { token: res.data.access_token, error: null };
}

// One authenticated Display API call. Returns { data, error }
// and never throws, in the fetchInsightsJson_ shape.
function fetchTikTokJson_(url, options, token) {
  let res;
  try {
    res = UrlFetchApp.fetch(
      url,
      Object.assign({}, options, {
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      })
    );
  } catch (err) {
    return {
      data: null,
      error: 'fetch exception (' + ((err && err.name) || 'Error') + ')',
    };
  }
  const status = res.getResponseCode();
  const bodyText = res.getContentText();
  if (status !== 200) {
    return { data: null, error: tikTokApiErrorSummary_(status, bodyText) };
  }
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch (err) {
    return { data: null, error: 'HTTP 200 with unparseable JSON body' };
  }
  const bodyError = tikTokBodyError_(data);
  if (bodyError) {
    return { data: null, error: bodyError };
  }
  return { data, error: null };
}

// The watch URL of one video, rebuilt from the account
// username and the video id (the history tabs store no URL,
// the same call the read side makes for YouTube videos). Null
// when either part is missing.
function tikTokVideoUrl_(username, id) {
  return username && id
    ? 'https://www.tiktok.com/@' + username + '/video/' + id
    : null;
}

// The authorized account's username as recorded by the last
// successful user-info call (TIKTOK_USERNAME), or null. The
// sheet-backed read side rebuilds video URLs with it.
function tikTokStoredUsername_() {
  return getScriptProperty_('TIKTOK_USERNAME') || null;
}

// A video's create_time (Unix seconds on the wire) as an ISO
// timestamp, or null when it did not arrive as a number.
function tikTokPublishedAt_(createTime) {
  const seconds = apiNumberOrNull_(createTime);
  if (seconds === null) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The newest videos (up to SNS_TIKTOK_RECENT_VIDEOS_LIMIT) with
// their public metrics. The watch URLs are built from the
// account username (the user-info response's, or the recorded
// one); without it they stay null and the rest of each entry
// is unaffected.
function fetchTikTokRecentVideos_(token, username) {
  const res = fetchTikTokJson_(
    TIKTOK_API_BASE +
      'video/list/?fields=' +
      encodeURIComponent(TIKTOK_VIDEO_FIELDS),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ max_count: SNS_TIKTOK_RECENT_VIDEOS_LIMIT }),
    },
    token
  );
  if (res.error) {
    return { videos: null, error: 'recent videos: ' + res.error };
  }
  const items =
    res.data && res.data.data && Array.isArray(res.data.data.videos)
      ? res.data.data.videos
      : null;
  if (!items) {
    return { videos: null, error: 'recent videos: response had no videos array' };
  }
  const videos = items
    .map((item) => {
      const video = item || {};
      const id = video.id != null ? String(video.id) : null;
      return {
        id,
        title: video.title != null ? String(video.title) : null,
        published_at: tikTokPublishedAt_(video.create_time),
        views: apiNumberOrNull_(video.view_count),
        likes: apiNumberOrNull_(video.like_count),
        comments: apiNumberOrNull_(video.comment_count),
        shares: apiNumberOrNull_(video.share_count),
        duration_sec: apiNumberOrNull_(video.duration),
        cover_url:
          video.cover_image_url != null && video.cover_image_url !== ''
            ? String(video.cover_image_url)
            : null,
        url: tikTokVideoUrl_(username, id),
      };
    })
    .filter((video) => video.id);
  return { videos, error: null };
}

// Account totals (followers, following, total likes, video
// count) plus the newest videos. Each half fails independently.
function fetchTikTokAccountDetail_() {
  const result = {
    followers: null,
    following: null,
    total_likes: null,
    video_count: null,
    username: null,
    recent_videos: null,
    tiktok_error: null,
  };
  const auth = ensureTikTokAccessToken_();
  if (!auth.token) {
    result.tiktok_error = auth.error;
    return result;
  }
  const errors = [];
  const userRes = fetchTikTokJson_(
    TIKTOK_API_BASE +
      'user/info/?fields=' +
      encodeURIComponent(TIKTOK_USER_FIELDS),
    { method: 'get' },
    auth.token
  );
  if (userRes.error) {
    errors.push('user info: ' + userRes.error);
  } else {
    const user =
      (userRes.data && userRes.data.data && userRes.data.data.user) || {};
    result.followers = apiNumberOrNull_(user.follower_count);
    result.following = apiNumberOrNull_(user.following_count);
    result.total_likes = apiNumberOrNull_(user.likes_count);
    result.video_count = apiNumberOrNull_(user.video_count);
    result.username =
      user.username != null && user.username !== ''
        ? String(user.username)
        : null;
    if (result.username) {
      PropertiesService.getScriptProperties().setProperty(
        'TIKTOK_USERNAME',
        result.username
      );
    }
  }
  if (!result.username) {
    // The statistics-only request above normally returns no
    // username: fall back to the recorded one so the video
    // URLs below can still be built. Stays null when none was
    // ever recorded.
    result.username = tikTokStoredUsername_();
  }
  const videos = fetchTikTokRecentVideos_(auth.token, result.username);
  result.recent_videos = videos.videos;
  if (videos.error) {
    errors.push(videos.error);
  }
  result.tiktok_error = joinSnsErrors_(errors);
  return result;
}

// The TikTok authorization URL for the one-time setup (see the
// section header). Empty when TIKTOK_CLIENT_KEY is unset.
function tikTokAuthorizeUrl_() {
  const clientKey = getScriptProperty_('TIKTOK_CLIENT_KEY');
  if (!clientKey) {
    return '';
  }
  return (
    TIKTOK_AUTHORIZE_URL +
    '?client_key=' +
    encodeURIComponent(clientKey) +
    '&scope=' +
    TIKTOK_OAUTH_SCOPES +
    '&response_type=code' +
    '&redirect_uri=' +
    encodeURIComponent(TIKTOK_REDIRECT_URI) +
    '&state=' +
    TIKTOK_OAUTH_STATE
  );
}

// The doGet callback for the authorization above: TikTok
// redirects the owner's browser back to the Web App's /exec
// with the state and a code. The code is only stored, as
// TIKTOK_AUTH_CODE, where bootstrapTikTokToken() picks it up —
// the owner no longer has to copy the code out of the redirect
// URL by hand. Returns false (and stores nothing) without a
// code.
function handleTikTokOAuthCallback_(code) {
  if (!code) {
    return false;
  }
  PropertiesService.getScriptProperties().setProperty('TIKTOK_AUTH_CODE', code);
  return true;
}

// Editor helper: builds the TikTok authorization URL and logs
// it. Open the logged URL in a browser and approve; TikTok
// redirects back to the Web App's /exec with a code, which the
// Web App stores in TIKTOK_AUTH_CODE — then run
// bootstrapTikTokToken().
function logTikTokAuthorizeUrl() {
  const url = tikTokAuthorizeUrl_();
  if (!url) {
    console.log('TIKTOK_CLIENT_KEY is not set in Script Properties');
    return '';
  }
  console.log('TikTok authorize URL: ' + url);
  return url;
}

// Editor helper: exchanges the authorization code stored in
// TIKTOK_AUTH_CODE (from the redirect after logTikTokAuthorizeUrl)
// for the first access / refresh token pair, stores them and
// deletes the code. Returns true on success; failures are
// logged as secret-free summaries.
function bootstrapTikTokToken() {
  const props = PropertiesService.getScriptProperties();
  const code = props.getProperty('TIKTOK_AUTH_CODE');
  if (!code) {
    console.log('TIKTOK_AUTH_CODE is not set in Script Properties');
    return false;
  }
  const clientKey = props.getProperty('TIKTOK_CLIENT_KEY');
  const clientSecret = props.getProperty('TIKTOK_CLIENT_SECRET');
  if (!clientKey || !clientSecret) {
    console.log(
      'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set in Script Properties'
    );
    return false;
  }
  const res = postTikTokToken_({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: TIKTOK_REDIRECT_URI,
  });
  if (res.error) {
    console.log('TikTok token exchange failed: ' + res.error);
    return false;
  }
  if (!storeTikTokTokens_(props, res.data)) {
    console.log('TikTok token exchange failed: response had no access_token');
    return false;
  }
  props.deleteProperty('TIKTOK_AUTH_CODE');
  console.log('TikTok tokens stored');
  return true;
}

// --- TikTok draft upload (Content Posting API) ---
// Sends a video into the authorized account's TikTok inbox as
// a draft (the publish status SEND_TO_USER_INBOX): the owner
// reviews it and posts it from the TikTok app, so nothing goes
// public from here. The flow is the FILE_UPLOAD source of the
// Content Posting API: initialize (which hands back a
// publish_id and a one-shot upload URL), PUT the bytes in
// chunks, then poll the publish status until TikTok has taken
// the video into the inbox.
//
// Chunking follows the API's rule: below 64MB the whole video
// goes as a single chunk; at or above it, fixed 10MB chunks
// (the last one smaller), each PUT with its Content-Range.
//
// Unlike the collection above — which never throws, so one
// network's failure cannot take the snapshot down — this flow
// throws: it runs from the editor on demand, and every failure
// message names the stage that failed (init / upload /
// status). The video.upload scope is required (see
// TIKTOK_OAUTH_SCOPES); without it the init call is refused
// with scope_not_authorized.

const TIKTOK_INBOX_INIT_URL =
  TIKTOK_API_BASE + 'post/publish/inbox/video/init/';
const TIKTOK_PUBLISH_STATUS_URL =
  TIKTOK_API_BASE + 'post/publish/status/fetch/';
const TIKTOK_UPLOAD_SINGLE_CHUNK_LIMIT_BYTES = 64 * 1024 * 1024;
const TIKTOK_UPLOAD_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
// The publish status is checked right after the upload and
// then every 5 seconds, up to 12 checks in all.
const TIKTOK_UPLOAD_STATUS_CHECKS = 12;
const TIKTOK_UPLOAD_STATUS_INTERVAL_MS = 5000;

// The chunk plan for one video of the given size, in the
// API's terms (chunk_size / total_chunk_count for the init
// call).
function tikTokUploadChunkPlan_(videoSize) {
  if (videoSize < TIKTOK_UPLOAD_SINGLE_CHUNK_LIMIT_BYTES) {
    return { chunkSize: videoSize, totalChunkCount: 1 };
  }
  return {
    chunkSize: TIKTOK_UPLOAD_CHUNK_SIZE_BYTES,
    totalChunkCount: Math.ceil(videoSize / TIKTOK_UPLOAD_CHUNK_SIZE_BYTES),
  };
}

// The init step: reserves the publish and returns its
// publish_id and upload URL. Throws an init-stage error.
function initTikTokInboxUpload_(token, videoSize, plan) {
  const res = fetchTikTokJson_(
    TIKTOK_INBOX_INIT_URL,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: plan.chunkSize,
          total_chunk_count: plan.totalChunkCount,
        },
      }),
    },
    token
  );
  if (res.error) {
    throw new Error('TikTok draft upload failed at init: ' + res.error);
  }
  const data = (res.data && res.data.data) || {};
  if (!data.publish_id || !data.upload_url) {
    throw new Error(
      'TikTok draft upload failed at init: response had no publish_id / upload_url'
    );
  }
  return {
    publishId: String(data.publish_id),
    uploadUrl: String(data.upload_url),
  };
}

// One chunk PUT against the upload URL (not a JSON call: the
// endpoint answers 206 for an interim chunk and 201 for the
// final one, with no body to speak of). Returns { error } and
// never throws, like the other fetch helpers.
function putTikTokVideoChunk_(uploadUrl, chunk, first, last, totalSize) {
  let res;
  try {
    res = UrlFetchApp.fetch(uploadUrl, {
      method: 'put',
      contentType: 'video/mp4',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': 'bytes ' + first + '-' + last + '/' + totalSize,
      },
      payload: chunk,
      muteHttpExceptions: true,
    });
  } catch (err) {
    return {
      error: 'fetch exception (' + ((err && err.name) || 'Error') + ')',
    };
  }
  const status = res.getResponseCode();
  if (status === 201 || status === 206) {
    return { error: null };
  }
  return { error: tikTokApiErrorSummary_(status, res.getContentText()) };
}

// One publish-status read: { status, failReason, error }. The
// statuses that matter here are SEND_TO_USER_INBOX (done),
// FAILED (with fail_reason) and the PROCESSING_* family in
// between.
function fetchTikTokPublishStatus_(token, publishId) {
  const res = fetchTikTokJson_(
    TIKTOK_PUBLISH_STATUS_URL,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ publish_id: publishId }),
    },
    token
  );
  if (res.error) {
    return { status: null, failReason: null, error: res.error };
  }
  const data = (res.data && res.data.data) || {};
  return {
    status: data.status != null ? String(data.status) : null,
    failReason: data.fail_reason != null ? String(data.fail_reason) : null,
    error: null,
  };
}

// Polls the publish status until TikTok takes the video into
// the inbox; returns 'SEND_TO_USER_INBOX'. Throws a
// status-stage error on FAILED, on a failed status read, and
// when the checks run out.
function waitForTikTokInboxDelivery_(token, publishId) {
  for (let check = 0; check < TIKTOK_UPLOAD_STATUS_CHECKS; check++) {
    if (check > 0) {
      Utilities.sleep(TIKTOK_UPLOAD_STATUS_INTERVAL_MS);
    }
    const res = fetchTikTokPublishStatus_(token, publishId);
    if (res.error) {
      throw new Error('TikTok draft upload failed at status: ' + res.error);
    }
    if (res.status === 'SEND_TO_USER_INBOX') {
      return res.status;
    }
    if (res.status === 'FAILED') {
      throw new Error(
        'TikTok draft upload failed at status: publish FAILED' +
          (res.failReason ? ' (' + res.failReason + ')' : '')
      );
    }
  }
  throw new Error(
    'TikTok draft upload failed at status: no SEND_TO_USER_INBOX after ' +
      TIKTOK_UPLOAD_STATUS_CHECKS +
      ' checks'
  );
}

// Uploads one video's bytes as an inbox draft and returns
// { publish_id, status } once TikTok reports
// SEND_TO_USER_INBOX. Throws with the failed stage in the
// message (init / upload / status).
function uploadTikTokDraftBytes_(bytes) {
  const videoSize = bytes ? bytes.length : 0;
  if (!videoSize) {
    throw new Error('TikTok draft upload failed at init: the video is empty');
  }
  const auth = ensureTikTokAccessToken_();
  if (!auth.token) {
    throw new Error('TikTok draft upload failed at init: ' + auth.error);
  }
  const plan = tikTokUploadChunkPlan_(videoSize);
  const init = initTikTokInboxUpload_(auth.token, videoSize, plan);
  for (let index = 0; index < plan.totalChunkCount; index++) {
    const first = index * plan.chunkSize;
    const last = Math.min(first + plan.chunkSize, videoSize) - 1;
    const put = putTikTokVideoChunk_(
      init.uploadUrl,
      bytes.slice(first, last + 1),
      first,
      last,
      videoSize
    );
    if (put.error) {
      throw new Error(
        'TikTok draft upload failed at upload (chunk ' +
          (index + 1) +
          ' of ' +
          plan.totalChunkCount +
          '): ' +
          put.error
      );
    }
  }
  const status = waitForTikTokInboxDelivery_(auth.token, init.publishId);
  return { publish_id: init.publishId, status };
}

// Editor helper: sends the Drive file (a video) to the
// authorized account's TikTok inbox as a draft; the owner
// reviews and posts it from the TikTok app. Logs and returns
// the publish_id and the final status; failures throw with
// the failed stage in the message.
function uploadTikTokDraftFromDrive(fileId) {
  const bytes = DriveApp.getFileById(fileId).getBlob().getBytes();
  const result = uploadTikTokDraftBytes_(bytes);
  console.log(
    'TikTok draft sent to inbox: publish_id=' +
      result.publish_id +
      ' status=' +
      result.status
  );
  return result;
}


export { SNS_TIKTOK_RECENT_VIDEOS_LIMIT, TIKTOK_OAUTH_STATE, TIKTOK_REDIRECT_URI, bootstrapTikTokToken, fetchTikTokAccountDetail_, fetchTikTokRecentVideos_, handleTikTokOAuthCallback_, logTikTokAuthorizeUrl, summarizeTikTokError_, tikTokAuthorizeUrl_, tikTokPublishedAt_, tikTokStoredUsername_, tikTokVideoUrl_, uploadTikTokDraftBytes_, uploadTikTokDraftFromDrive };
