// Manual diagnostics, run from the Apps Script editor:
// debugSnsInsights / debugInstagramDailyFollows / debugThreads*.

import { getScriptProperty_ } from './auth.js';
import { META_GRAPH_BASE, SNS_INSTAGRAM_MAIN_ID, SNS_THREADS_USER_ID, THREADS_GRAPH_BASE, parseThreadsFollowersCount_, threadsFollowersInsightsUrl_ } from './snsCounts.js';
import { THREADS_ACCOUNT_METRICS, THREADS_MEDIA_INSIGHT_METRICS, buildThreadsPostEntry_, parseThreadsInsightsByName_, parseThreadsMediaInsights_, threadsPostListUrl_ } from './threadsDetail.js';
import { parseInsightsDailySum_, snsInsightsWindow_, summarizeInsightsError_ } from './instagramDetail.js';
import { dailyFollowsDateKeys_, fetchInstagramDailyFollowsDay_, fetchInstagramDailyFollows_, jstDayWindowSec_ } from './instagramDaily.js';

// --- Manual diagnostics: debugSnsInsights -------------------------
// Run by hand from the Apps Script editor when the account-detail
// numbers look wrong (as on 2026-11-09, when its raw responses
// pinned down the follows_and_unfollows follow_type labels —
// FOLLOWER = new follows, NON_FOLLOWER = unfollows — and showed
// profile_links_taps coming back 0 in both the total_value form and
// the daily-sum fallback while the Instagram app showed real bio
// link taps). It logs the raw Graph API responses for six request
// shapes (A–F) so the next fix starts from what the API actually
// returns instead of a guess. It is never called from a trigger or
// from doGet, and it does not touch the snapshot. Access tokens are
// never logged: request URLs are printed with
// access_token=<redacted>, and any token string is scrubbed from
// response bodies before logging.
const SNS_DEBUG_LOG_LIMIT = 3000;

function debugSnsInsights() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set; nothing to diagnose.');
    return;
  }
  const window = snsInsightsWindow_();
  const range = '&since=' + window.since + '&until=' + window.until;
  debugLogInsightsShape_(
    'A follows_and_unfollows breakdown=follow_type',
    'metric=follows_and_unfollows&period=day&metric_type=total_value' +
      range +
      '&breakdown=follow_type',
    token,
    {}
  );
  debugLogInsightsShape_(
    'B follows_and_unfollows metric_type=total_value (no breakdown)',
    'metric=follows_and_unfollows&period=day&metric_type=total_value' + range,
    token,
    {}
  );
  debugLogInsightsShape_(
    'C follows_and_unfollows plain (no metric_type, no breakdown)',
    'metric=follows_and_unfollows&period=day' + range,
    token,
    {}
  );
  debugLogInsightsShape_(
    'D profile_links_taps metric_type=total_value',
    'metric=profile_links_taps&period=day&metric_type=total_value' + range,
    token,
    {}
  );
  debugLogInsightsShape_(
    'E profile_links_taps plain (no metric_type)',
    'metric=profile_links_taps&period=day' + range,
    token,
    { summarizeValues: true }
  );
  debugLogInsightsShape_(
    'F profile_links_taps period=lifetime metric_type=total_value',
    'metric=profile_links_taps&period=lifetime&metric_type=total_value',
    token,
    { errorsOnly: true }
  );
}

// --- Manual diagnostics: debugInstagramDailyFollows ---------------
// Run by hand from the Apps Script editor to check the per-day
// follows fetch against the live API. The production run on
// 2026-11-09 settled the request form (see the daily follows
// section above): the plain period=day form is rejected and the
// total_value form only answers whole-window splits, so the
// series is fetched one JST day at a time. This logs the raw
// total_value response for yesterday's JST window (token redacted
// by debugLogInsightsShape_), then the newest few days as the
// per-day fetch reads them, then the full fetch outcome (series
// length, missing days, error) — all without running a
// collection. Never called from a trigger or doGet; does not
// touch the snapshot.
function debugInstagramDailyFollows() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set; nothing to diagnose.');
    return;
  }
  const dateKeys = dailyFollowsDateKeys_(Date.now());
  const yesterday = dateKeys[dateKeys.length - 2];
  const yesterdayWindow = jstDayWindowSec_(yesterday);
  debugLogInsightsShape_(
    'G follows_and_unfollows one JST day (' +
      yesterday +
      ') metric_type=total_value breakdown=follow_type',
    'metric=follows_and_unfollows&period=day&metric_type=total_value' +
      '&since=' +
      yesterdayWindow.since +
      '&until=' +
      yesterdayWindow.until +
      '&breakdown=follow_type',
    token,
    {}
  );
  Logger.log('=== per-day fetch (newest 3 days) ===');
  dateKeys.slice(-3).forEach((dateKey) => {
    const day = fetchInstagramDailyFollowsDay_(dateKey, token);
    Logger.log(
      dateKey +
        ': follows=' +
        day.follows +
        ' unfollows=' +
        day.unfollows +
        (day.error ? ' error: ' + day.error : '')
    );
  });
  const fetched = fetchInstagramDailyFollows_();
  Logger.log('=== full daily_follows fetch ===');
  Logger.log('error: ' + (fetched.error || '(none)'));
  Logger.log('missing_days: ' + fetched.missing_days);
  Logger.log(
    'series: ' +
      (fetched.series
        ? fetched.series.length +
          ' days, ' +
          fetched.series[0].date +
          ' .. ' +
          fetched.series[fetched.series.length - 1].date
        : '(null)')
  );
}

// Shared transport for manual diagnostics. Keep the raw body available
// for parsers, but log only a redacted URL and the exception type.
function debugFetch_(url, token) {
  Logger.log('GET ' + url + '&access_token=<redacted>');
  let res;
  try {
    res = UrlFetchApp.fetch(
      url + '&access_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
  } catch (err) {
    Logger.log('fetch exception (' + ((err && err.name) || 'Error') + ')');
    return null;
  }
  const status = res.getResponseCode();
  Logger.log('HTTP ' + status);
  return { status, bodyText: res.getContentText() };
}

function debugLogBody_(bodyText, token) {
  Logger.log(debugScrubToken_(bodyText, token).slice(0, SNS_DEBUG_LOG_LIMIT));
}

// Fetches one insights shape for debugSnsInsights and logs the
// request URL (token redacted), the HTTP status and the raw body,
// truncated to SNS_DEBUG_LOG_LIMIT characters. With errorsOnly, an
// error response is reduced to the summarizeInsightsError_ summary
// (shape F). With summarizeValues, a values[] list in the body also
// gets a count/sum line (shape E). Never throws.
function debugLogInsightsShape_(label, query, token, options) {
  const opts = options || {};
  const base = META_GRAPH_BASE + SNS_INSTAGRAM_MAIN_ID + '/insights?' + query;
  Logger.log('=== ' + label + ' ===');
  const response = debugFetch_(base, token);
  if (!response) return;
  const { status, bodyText } = response;
  if (status !== 200 && opts.errorsOnly) {
    Logger.log(summarizeInsightsError_(status, debugScrubToken_(bodyText, token)));
    return;
  }
  debugLogBody_(bodyText, token);
  if (opts.summarizeValues && status === 200) {
    let data = null;
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      data = null;
    }
    const entry = data && Array.isArray(data.data) ? data.data[0] : null;
    const count = entry && Array.isArray(entry.values) ? entry.values.length : 0;
    const sum = parseInsightsDailySum_(data);
    Logger.log(
      'values: ' +
        count +
        ' entries, sum = ' +
        (sum === null ? '(no numeric values)' : sum)
    );
  }
}

// Removes any occurrence of the access token from text about to be
// logged. Graph API bodies should never contain it; this is a
// belt-and-braces scrub so debugSnsInsights can never leak it.
function debugScrubToken_(text, token) {
  const value = String(text == null ? '' : text);
  if (!token) {
    return value;
  }
  return value.split(token).join('<redacted>')
    .split(encodeURIComponent(token)).join('<redacted>');
}

// --- Manual diagnostics: debugThreadsFollowers --------------------
// Run by hand from the Apps Script editor when collectSnsCounts
// keeps storing threads.followers = null after the Threads OAuth
// flow has completed (as on 2026-11-09: authorization finished and
// the long-lived token was saved, yet the followers fetch came back
// null with no error recorded anywhere — the fetch returns null on
// any non-200 response or exception without keeping the status or
// body, so the snapshot cannot say why). Its first production run
// showed why: the profile request ?fields=followers_count fails
// with HTTP 500 "Tried accessing nonexisting field
// (followers_count)", so fetchThreadsFollowers_ now reads the
// followers_count metric from the threads_insights edge instead.
// This diagnostic logs whether META_THREADS_ACCESS_TOKEN is set
// (never its value), which user id the production fetch would use,
// the raw status/body of the very same insights request
// fetchThreadsFollowers_ makes, and the count parsed out of it. If
// the insights edge refuses the token over a missing scope, that
// error message shows up here verbatim. It is never called from a
// trigger or from doGet, and it does not touch the snapshot. The
// request URL is printed with access_token=<redacted> and the body
// is scrubbed the same way as in debugSnsInsights.
function debugThreadsFollowers() {
  const threadsToken = getScriptProperty_('META_THREADS_ACCESS_TOKEN');
  Logger.log(
    'META_THREADS_ACCESS_TOKEN is ' +
      (threadsToken ? 'set.' : 'not set.')
  );
  const token = threadsToken || getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set either; nothing to diagnose.');
    return;
  }
  if (!threadsToken) {
    Logger.log('Falling back to META_ACCESS_TOKEN (the Instagram token).');
  }
  const propertyUserId = getScriptProperty_('THREADS_USER_ID');
  const userId = propertyUserId || SNS_THREADS_USER_ID;
  Logger.log(
    'Threads user id: ' +
      userId +
      (propertyUserId
        ? ' (from THREADS_USER_ID)'
        : ' (THREADS_USER_ID is not set; using the SNS_THREADS_USER_ID fallback)')
  );
  const base = threadsFollowersInsightsUrl_(userId);
  const response = debugFetch_(base, token);
  if (!response) return;
  const { bodyText } = response;
  debugLogBody_(bodyText, token);
  let parsed = null;
  try {
    parsed = parseThreadsFollowersCount_(JSON.parse(bodyText));
  } catch (err) {
    parsed = null;
  }
  Logger.log(
    'parsed followers_count: ' + (parsed === null ? 'null' : parsed)
  );
}

// --- Manual diagnostics: debugThreadsPosts ------------------------
// Run by hand from the Apps Script editor after the Threads detail
// collection (account metrics + per-post insights) is deployed, to
// see the raw shapes the new requests actually return before
// trusting the parsed snapshot — the same debug-first step
// debugThreadsFollowers provided for the follower count. It runs
// the three new request families once each: the combined account
// insights request (metric=views,likes,replies,reposts,quotes over
// the 30-day window), the user's threads list (limit 3, just enough
// to see the entry shape), and the media insights of the first
// listed post. Each stage logs its request URL with
// access_token=<redacted>, the HTTP status and the scrubbed body,
// plus the values the production parsers read out of it. The stages
// are independent: a stage that fails or returns nothing usable
// stops only itself. It is never called from a trigger or from
// doGet, and it does not touch the snapshot.
function debugThreadsPosts() {
  const threadsToken = getScriptProperty_('META_THREADS_ACCESS_TOKEN');
  Logger.log(
    'META_THREADS_ACCESS_TOKEN is ' +
      (threadsToken ? 'set.' : 'not set.')
  );
  const token = threadsToken || getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set either; nothing to diagnose.');
    return;
  }
  if (!threadsToken) {
    Logger.log('Falling back to META_ACCESS_TOKEN (the Instagram token).');
  }
  const propertyUserId = getScriptProperty_('THREADS_USER_ID');
  const userId = propertyUserId || SNS_THREADS_USER_ID;
  Logger.log(
    'Threads user id: ' +
      userId +
      (propertyUserId
        ? ' (from THREADS_USER_ID)'
        : ' (THREADS_USER_ID is not set; using the SNS_THREADS_USER_ID fallback)')
  );
  const window = snsInsightsWindow_();
  const accountData = debugThreadsGet_(
    'account insights (metric=views,likes,replies,reposts,quotes, last 30 days)',
    THREADS_GRAPH_BASE +
      userId +
      '/threads_insights?metric=' +
      THREADS_ACCOUNT_METRICS.join(',') +
      '&since=' +
      window.since +
      '&until=' +
      window.until,
    token
  );
  if (accountData) {
    Logger.log(
      'parsed account totals: ' +
        JSON.stringify(parseThreadsInsightsByName_(accountData))
    );
  }
  const listData = debugThreadsGet_(
    'threads list (limit 3)',
    threadsPostListUrl_(userId, 3),
    token
  );
  const items =
    listData && Array.isArray(listData.data) ? listData.data : null;
  if (!items || !items.length) {
    Logger.log('no posts in the list response; skipping media insights.');
    return;
  }
  const firstEntry = buildThreadsPostEntry_(items[0]);
  Logger.log('first post entry: ' + debugScrubToken_(JSON.stringify(firstEntry), token));
  if (firstEntry.id == null) {
    Logger.log('first post has no id; skipping media insights.');
    return;
  }
  const mediaData = debugThreadsGet_(
    'media insights for the first post',
    THREADS_GRAPH_BASE +
      firstEntry.id +
      '/insights?metric=' +
      THREADS_MEDIA_INSIGHT_METRICS,
    token
  );
  if (mediaData) {
    Logger.log(
      'parsed media insights: ' +
        JSON.stringify(parseThreadsMediaInsights_(mediaData))
    );
  }
}

// One GET for debugThreadsPosts: logs the label, the request URL
// with the token redacted, the HTTP status and the scrubbed body
// (truncated like the other diagnostics), and returns the parsed
// body on HTTP 200 — null on any failure, so the calling stage can
// stop without throwing. The token itself is only ever appended to
// the real request, never to the logged one.
function debugThreadsGet_(label, url, token) {
  Logger.log('=== ' + label + ' ===');
  const response = debugFetch_(url, token);
  if (!response) return null;
  const { status, bodyText } = response;
  debugLogBody_(bodyText, token);
  if (status !== 200) {
    return null;
  }
  try {
    return JSON.parse(bodyText);
  } catch (err) {
    Logger.log('response body is not JSON; nothing parsed.');
    return null;
  }
}


export { debugSnsInsights, debugInstagramDailyFollows, debugThreadsFollowers, debugThreadsPosts };
