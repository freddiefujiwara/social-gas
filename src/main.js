// Web app entry points: doGet / doPost routing and the smoke
// records inlet (action=record_smoke).

import { fetchMusicCount_, fetchTopArticles_ } from './publicActions.js';
import { extractIdToken_, getScriptProperty_, issueOwnerSession_, issueShareSession_, requireOwnerAuth_, revokeOwnerSession_, revokeShareSession_, validateOwnerToken_, validateShareToken_, verifyGoogleIdTokenOrThrow_ } from './auth.js';
import { buildSnsCountsResponse_, buildSnsDetailResponse_ } from './snsCounts.js';
import { THREADS_OAUTH_STATE_PROPERTY, handleThreadsOAuthCallback_, threadsAuthorizeUrl } from './threadsAuth.js';
import { SNS_HISTORY_SHEET_ID_PROPERTY, summarizeSnsHistoryError_ } from './historyWrite.js';
import { buildSnsHistoryResponse_ } from './snsHistoryRead.js';
import { buildBlogReportResponse_ } from './sheetRead.js';
import { htmlOut_, jsonOut_, parseRunParams_ } from './ga4.js';
import { serveCommentsRss_ } from './commentsRss.js';
import { servePerfRss_ } from './perfRss.js';

// --- Smoke records inlet (doPost, action=record_smoke) ---
// The morning smoke workflow on GitHub Actions measures the
// static pages, the pinned blog articles and the GAS endpoints
// from its runner and POSTs one JSON batch here:
//   { action: 'record_smoke', token,
//     records: [{ target, kind, ms, ok }] }
// Rows land in the history spreadsheet's "smoke_records" tab —
// an append-only log (recorded_at, target, kind, ms, ok) the
// trend is read from. The token must match the Script Property
// SMOKE_RECORD_TOKEN; while that property is unset the inlet
// refuses every batch, so deploying this code alone records
// nothing. The matching GitHub Actions secret carries the same
// token; neither side prints it.
const SMOKE_RECORDS_TAB = 'smoke_records';
const SMOKE_RECORDS_COLUMNS = ['recorded_at', 'target', 'kind', 'ms', 'ok'];
const SMOKE_RECORD_TOKEN_PROPERTY = 'SMOKE_RECORD_TOKEN';
const SMOKE_RECORDS_MAX_BATCH = 100;

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body && body.action === 'record_smoke') {
      return jsonOut_(recordSmoke_(body));
    }
    return jsonOut_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid request body' });
  }
}

// Validates one record_smoke batch and appends its rows.
// Refusals are ok:false answers, never throws, so the caller
// can log the reason; a failed append writes nothing (the
// batch lands in a single setValues call).
function recordSmoke_(body) {
  const expected = getScriptProperty_(SMOKE_RECORD_TOKEN_PROPERTY);
  if (!expected) {
    return { ok: false, error: 'smoke recording is not configured' };
  }
  if (!body || body.token !== expected) {
    return { ok: false, error: 'invalid token' };
  }
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return { ok: false, error: 'history sheet is not configured' };
  }
  const records = Array.isArray(body.records)
    ? body.records.slice(0, SMOKE_RECORDS_MAX_BATCH)
    : [];
  if (!records.length) {
    return { ok: false, error: 'no records' };
  }
  const recordedAt = new Date().toISOString();
  const rows = records.map((record) => {
    const item = record || {};
    return [
      recordedAt,
      String(item.target || ''),
      String(item.kind || ''),
      typeof item.ms === 'number' && Number.isFinite(item.ms)
        ? Math.round(item.ms)
        : '',
      item.ok === true ? 'ok' : 'ng',
    ];
  });
  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    appendSmokeRows_(spreadsheet, rows);
  } catch (err) {
    return {
      ok: false,
      error: 'append failed: ' + summarizeSnsHistoryError_(err, sheetId),
    };
  }
  return { ok: true, recorded: rows.length };
}

// Appends rows to the smoke_records tab, creating it with its
// header row on first use.
function appendSmokeRows_(spreadsheet, rows) {
  let sheet = spreadsheet.getSheetByName(SMOKE_RECORDS_TAB);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SMOKE_RECORDS_TAB);
    sheet
      .getRange(1, 1, 1, SMOKE_RECORDS_COLUMNS.length)
      .setValues([SMOKE_RECORDS_COLUMNS]);
  }
  if (rows.length) {
    sheet
      .getRange(sheet.getLastRow() + 1, 1, rows.length, SMOKE_RECORDS_COLUMNS.length)
      .setValues(rows);
  }
}

function doGet(e) {
  try {
    const parameter = (e && e.parameter) || {};
    // Threads OAuth callback: Threads redirects the owner's browser
    // here with a code after threadsAuthorizeUrl(). The state saved
    // by that helper is the credential for this one request — the
    // redirect carries no ID token — so it is handled before every
    // other route. A code whose state does not match the saved one is
    // never treated as an API action; it just gets a plain page.
    if (parameter.code) {
      const expectedState = getScriptProperty_(THREADS_OAUTH_STATE_PROPERTY);
      if (expectedState && parameter.state && parameter.state === expectedState) {
        const result = handleThreadsOAuthCallback_(parameter.code);
        if (result.ok) {
          return htmlOut_(
            '<!DOCTYPE html><html><body>' +
              '<p>Threads の認可が完了しました。このタブは閉じて構いません。</p>' +
              '</body></html>'
          );
        }
        console.log('Threads OAuth callback failed: ' + result.error);
        return htmlOut_(
          '<!DOCTYPE html><html><body>' +
            '<p>Threads の認可に失敗しました。Apps Script の実行ログを確認してください。</p>' +
            '</body></html>'
        );
      }
      return htmlOut_(
        '<!DOCTYPE html><html><body>' +
          '<p>Threads の認可フローが確認できませんでした。threadsAuthorizeUrl() からやり直してください。</p>' +
          '</body></html>'
      );
    }
    if (parameter.action === 'sns_counts') {
      // Public by design: returns only the stored SNS follower snapshot.
      // Handled before the GA4 property check and before authentication.
      return jsonOut_(buildSnsCountsResponse_());
    }
    if (parameter.action === 'comments_rss') {
      // The stored post comments / replies as RSS for /reader,
      // gated by its own token (COMMENTS_RSS_TOKEN): the feed
      // carries comment text, so nothing is served without it.
      // Handled before the GA4 property check like sns_counts —
      // it reads only the history sheet, never the GA4 API.
      return serveCommentsRss_(parameter);
    }
    if (parameter.action === 'perf_rss') {
      // The performance highlights as RSS for /reader, gated
      // by the same RSS token as the comments feed: the items
      // carry the real figures, so nothing is served without
      // it. Like comments_rss it reads only the history sheet.
      return servePerfRss_(parameter);
    }
    const propertyId =
      PropertiesService.getScriptProperties().getProperty('GA4_PROPERTY_ID');
    if (!propertyId) {
      return jsonOut_({
        ok: false,
        error: 'GA4_PROPERTY_ID is not set in Script Properties',
      });
    }
    // The public music play count is served before any
    // authentication: it exposes only the aggregate count.
    if (parameter.action === 'music_count') {
      try {
        const payload = fetchMusicCount_(propertyId);
        return jsonOut_(
          Object.assign({ ok: true, action: 'music_count' }, payload)
        );
      } catch (error) {
        return jsonOut_({
          ok: false,
          status: 502,
          error: String((error && error.message) || error),
        });
      }
    }
    // The public top-articles ranking is served before any
    // authentication, like the music count: it exposes only the
    // top few article ids and their view counts.
    if (parameter.action === 'top_articles') {
      try {
        const payload = fetchTopArticles_(propertyId);
        return jsonOut_(
          Object.assign({ ok: true, action: 'top_articles' }, payload)
        );
      } catch (error) {
        return jsonOut_({
          ok: false,
          status: 502,
          error: String((error && error.message) || error),
        });
      }
    }
    let shareSession = null;
    if (parameter.action === 'exchange_session') {
      try {
        verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
      } catch (error) {
        return jsonOut_({ ok: false, status: 401, error: String((error && error.message) || error) });
      }
      return jsonOut_(Object.assign({ ok: true }, issueOwnerSession_()));
    }
    if (parameter.action === 'revoke_session') {
      // Only the holder of the live session token may revoke it;
      // an unauthenticated revoke would let anyone kill the owner's
      // 30-day session at will.
      if (!parameter.session_token || !validateOwnerToken_(parameter.session_token)) {
        return jsonOut_({ ok: false, status: 401, error: 'session expired or invalid' });
      }
      return jsonOut_(Object.assign({ ok: true }, revokeOwnerSession_(parameter.session_token)));
    }
    if (parameter.action === 'issue_share' || parameter.action === 'revoke_share') {
      try {
        requireOwnerAuth_(e);
      } catch (error) {
        return jsonOut_({ ok: false, status: 401, error: String((error && error.message) || error) });
      }
      const result =
        parameter.action === 'issue_share' ? issueShareSession_() : revokeShareSession_();
      return jsonOut_(Object.assign({ ok: true }, result));
    }
    {
      if (parameter.session_token) {
        if (!validateOwnerToken_(parameter.session_token)) {
          return jsonOut_({
            ok: false,
            status: 401,
            error: 'session expired or invalid',
          });
        }
      } else if (parameter.share_token) {
        shareSession = validateShareToken_(parameter.share_token);
        if (!shareSession) {
          return jsonOut_({
            ok: false,
            status: 401,
            error: 'share session expired or invalid',
          });
        }
      } else {
        try {
          verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
        } catch (error) {
          const message = String((error && error.message) || error);
          return jsonOut_({
            ok: false,
            status: message === 'forbidden email' ? 403 : 401,
            error: message,
          });
        }
      }
    }
    // The SNS detail snapshot sits behind the same gate as the GA4
    // report (ID token or share token): it carries per-post numbers
    // and follower demographics that the public sns_counts action
    // deliberately never returns.
    if (parameter.action === 'sns_detail') {
      return jsonOut_(buildSnsDetailResponse_());
    }
    // The history rows behind the trend charts sit behind the same
    // gate: they are the same numbers as sns_detail, only older.
    if (parameter.action === 'sns_history') {
      return jsonOut_(buildSnsHistoryResponse_());
    }
    // The screen's blog reports are served from the history
    // sheet (stage 2): the GA4 Data API is no longer called to
    // render the screen. buildReportRequest_ / fetchReport_
    // remain as the collection side's bridge (the blog history
    // writes, music_count, top_articles).
    const params = parseRunParams_(parameter);
    return jsonOut_(buildBlogReportResponse_(params, shareSession));
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}


export { SMOKE_RECORDS_COLUMNS, appendSmokeRows_, doGet, doPost, recordSmoke_ };
