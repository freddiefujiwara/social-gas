// Instagram daily follows series (JST days).

import { getScriptProperty_ } from './auth.js';
import { META_GRAPH_BASE, SNS_INSTAGRAM_MAIN_ID } from './snsCounts.js';
import { fetchInsightsJson_ } from './instagramDetail.js';
import { followsBreakdownLabels_, parseFollowsBreakdown_ } from './instagramMedia.js';

// --- Instagram daily follows series --------------------------------
// Per-day follows/unfollows for the last 30 Asia/Tokyo calendar
// days, so the /ga Instagram tab can chart follows and unfollows
// per day and map the day's posts onto the same axis. Meta offers
// no per-post follow attribution, so the day series plus the post
// dates (from recent_media) is the closest honest view; the
// shaping lives here, the mapping lives in the frontend.
//
// How a day is read was settled by production debugging on
// 2026-11-09 (debugInstagramDailyFollows): the plain period=day
// form is rejected (HTTP 400 "(#100) The following metrics
// (follows_and_unfollows) should be specified with parameter
// metric_type=total_value"), and the metric_type=total_value form
// answers only the whole window's split — total_value.breakdowns
// by follow_type, with no per-day values and no end_time — so one
// request can never yield a day series. The series is therefore
// built one day at a time: for each JST calendar day, the same
// total_value + breakdown=follow_type request the totals use is
// narrowed to that day's since/until window (JST 00:00:00 to
// 23:59:59 as unix seconds), and parseFollowsBreakdown_ reads the
// split. A day whose request fails or carries no split stays
// { follows: null, unfollows: null } in the series and is counted
// in missing_days; the fetch only gives up (series null, error
// set) when every day failed. Today's row is a running total —
// the day is still in progress — and later collections overwrite
// it, so the series self-corrects.
const SNS_DAILY_FOLLOWS_DAYS = 30;
const SNS_JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SNS_DAY_MS = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" of an instant read in Asia/Tokyo. Computed by
// shifting the instant by the JST offset and reading UTC fields,
// so the runtime's own timezone never leaks into the key.
function jstDateKey_(ms) {
  const shifted = new Date(ms + SNS_JST_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return shifted.getUTCFullYear() + '-' + month + '-' + day;
}

// One JST calendar day's window as unix seconds: since is the
// day's 00:00:00 JST and until its 23:59:59 JST. Date.parse with
// an explicit +09:00 offset keeps the conversion independent of
// the runtime timezone; JST has no daylight saving, so the day
// is always exactly SNS_DAY_MS long.
function jstDayWindowSec_(dateKey) {
  const startMs = Date.parse(dateKey + 'T00:00:00+09:00');
  if (!Number.isFinite(startMs)) {
    return null;
  }
  // Date.parse rolls a nonexistent day over to the next real
  // one (2026-02-30 parses as 2026-03-02): a key that does not
  // name the day it parsed to has no JST window.
  if (jstDateKey_(startMs) !== dateKey) {
    return null;
  }
  const since = Math.floor(startMs / 1000);
  return { since: since, until: since + SNS_DAY_MS / 1000 - 1 };
}

// The SNS_DAILY_FOLLOWS_DAYS JST date keys ending today (JST),
// ascending. nowMs is a parameter so the shape stays testable;
// stepping back in whole days is exact because JST never shifts.
function dailyFollowsDateKeys_(nowMs) {
  const todayStartMs = Date.parse(jstDateKey_(nowMs) + 'T00:00:00+09:00');
  const keys = [];
  for (let i = SNS_DAILY_FOLLOWS_DAYS - 1; i >= 0; i--) {
    keys.push(jstDateKey_(todayStartMs - i * SNS_DAY_MS));
  }
  return keys;
}

// Fetches one JST day's follows/unfollows split. Returns
// { follows, unfollows, error }: on success error is null and a
// side the response did not report stays null (never guessed as
// 0); on failure both sides are null and error summarises why,
// built only from the response status/body or the observed
// breakdown labels, never from the request URL.
function fetchInstagramDailyFollowsDay_(dateKey, token) {
  const dayWindow = jstDayWindowSec_(dateKey);
  if (!dayWindow) {
    return { follows: null, unfollows: null, error: 'invalid date: ' + dateKey };
  }
  const url =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=follows_and_unfollows&period=day' +
    '&metric_type=total_value&since=' +
    dayWindow.since +
    '&until=' +
    dayWindow.until +
    '&breakdown=follow_type&access_token=' +
    encodeURIComponent(token);
  const res = fetchInsightsJson_(url);
  if (res.error) {
    return { follows: null, unfollows: null, error: res.error };
  }
  const parsed = parseFollowsBreakdown_(res.data);
  if (!parsed) {
    const labels = followsBreakdownLabels_(res.data);
    return {
      follows: null,
      unfollows: null,
      error:
        'response had no follow_type breakdown' +
        (labels.length ? ' (labels: [' + labels.join(', ') + '])' : ''),
    };
  }
  return { follows: parsed.follows, unfollows: parsed.unfollows, error: null };
}

// Builds the per-day series by fetching each of the last
// SNS_DAILY_FOLLOWS_DAYS JST days on its own. Returns
// { series, missing_days, error } and never throws: without a
// token the series stays null with no error (the same "not
// configured" silence as the other Instagram fetches); days that
// fail stay in the series as null/null rows counted in
// missing_days, with error still null; only when every day
// failed is the series null and error set (summarising the first
// day's failure).
function fetchInstagramDailyFollows_() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return { series: null, missing_days: 0, error: null };
  }
  const dateKeys = dailyFollowsDateKeys_(Date.now());
  const series = [];
  let missingDays = 0;
  let firstError = null;
  dateKeys.forEach((dateKey) => {
    const day = fetchInstagramDailyFollowsDay_(dateKey, token);
    if (day.error) {
      missingDays += 1;
      if (!firstError) {
        firstError = day.error;
      }
    }
    series.push({
      date: dateKey,
      follows: day.follows,
      unfollows: day.unfollows,
    });
  });
  if (missingDays === dateKeys.length) {
    return {
      series: null,
      missing_days: missingDays,
      error:
        'follows_and_unfollows daily: all ' +
        missingDays +
        ' days failed (first: ' +
        firstError +
        ')',
    };
  }
  return { series: series, missing_days: missingDays, error: null };
}


export { SNS_DAY_MS, dailyFollowsDateKeys_, fetchInstagramDailyFollowsDay_, fetchInstagramDailyFollows_, jstDateKey_, jstDayWindowSec_ };
