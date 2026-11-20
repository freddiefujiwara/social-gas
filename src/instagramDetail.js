// Instagram detail: media count, account insights and the
// per-account detail block of sns_detail.

import { getScriptProperty_ } from './auth.js';
import { META_GRAPH_BASE, SNS_INSTAGRAM_MAIN_ID, apiNumberOrNull_ } from './snsCounts.js';
import { fetchInstagramDailyFollows_ } from './instagramDaily.js';
import { followsBreakdownLabels_, parseFollowsBreakdown_ } from './instagramMedia.js';

function fetchInstagramMediaCount_() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return null;
  }
  try {
    const res = UrlFetchApp.fetch(
      META_GRAPH_BASE +
        SNS_INSTAGRAM_MAIN_ID +
        '?fields=media_count&access_token=' +
        encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      return null;
    }
    const data = JSON.parse(res.getContentText());
    return apiNumberOrNull_(data && data.media_count);
  } catch (err) {
    return null;
  }
}

// Instagram KPI from the account insights (last 30 days):
//   views_30d: total Views across the whole account
//   non_follower_pct: share of those Views from non-followers (%), 1 decimal
// Insights require the instagram_manage_insights permission. Until the
// token carries it, the insights calls error out and both values stay
// null while every other fetch keeps working; once the permission is
// added they fill in automatically.
//
// Request shape (Meta Graph API, on the IG user node):
//   GET /{ig-id}/insights?metric=views&period=day
//       &metric_type=total_value&breakdown=follow_type
//       &since=<unix>&until=<unix>&access_token=...
// The total_value response carries the breakdown as
// total_value.breakdowns[].results[] with dimension_values like
// ["FOLLOWER"] / ["NON_FOLLOWER"]. If that shape is unavailable, a
// total_value request without the breakdown fills views_30d only —
// its response may carry total_value.value directly, or per-day
// values[].value to sum. (Observed in production on 2026-11-08: the
// breakdown dimension is named follow_type, not follower_type, and
// the views metric requires metric_type=total_value on every call.)
//
// Diagnostics: the result always carries insights_error — null when
// the breakdown request succeeded, otherwise a short summary of what
// the API actually said (or that the daily-totals fallback was used),
// so a failing insights call is observable in the snapshot and the
// execution log instead of silently producing null KPIs. Summaries
// are built only from the response status/body, never from the
// request URL, because the URL carries the access token.
function fetchInstagramViewsInsights_() {
  const result = { views_30d: null, non_follower_pct: null, insights_error: null };
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return result;
  }
  const until = Math.floor(Date.now() / 1000);
  const since = until - 30 * 24 * 60 * 60;
  const base =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=views&period=day&since=' +
    since +
    '&until=' +
    until +
    '&access_token=' +
    encodeURIComponent(token);
  const breakdownRes = fetchInsightsJson_(
    base + '&metric_type=total_value&breakdown=follow_type'
  );
  const breakdown = parseViewsBreakdown_(breakdownRes.data);
  if (breakdown) {
    result.views_30d = breakdown.total;
    const partsTotal = breakdown.follower + breakdown.nonFollower;
    if (partsTotal > 0) {
      result.non_follower_pct =
        Math.round((breakdown.nonFollower / partsTotal) * 1000) / 10;
    }
    return result;
  }
  const dailyRes = fetchInsightsJson_(base + '&metric_type=total_value');
  const total = parseViewsDailyTotal_(dailyRes.data);
  if (total !== null) {
    result.views_30d = total;
    result.insights_error =
      'follow_type breakdown unavailable' +
      (breakdownRes.error ? ' (' + breakdownRes.error + ')' : '') +
      '; used daily totals fallback';
    return result;
  }
  const notes = [];
  notes.push(
    breakdownRes.error
      ? 'breakdown: ' + breakdownRes.error
      : 'breakdown: response had no follow_type breakdown'
  );
  notes.push(
    dailyRes.error
      ? 'daily: ' + dailyRes.error
      : 'daily: response had no daily values'
  );
  result.insights_error = notes.join('; ');
  return result;
}

// Builds a fields= query fragment with the value encoded.
// UrlFetchApp.fetch throws "Invalid argument" on a URL with
// literal braces, and Graph API nested field expansion
// (instagram_business_account{id}, replies{...}, from{...})
// uses them, so the fields value must be percent-encoded.
function graphFieldsParam_(fields) {
  return 'fields=' + encodeURIComponent(fields);
}

// Trims an UrlFetchApp exception message for the log. The message
// can embed the request URL, which carries the access token, so
// the URL (and any access_token fragment) is removed entirely;
// what remains is the reason, e.g. "Invalid argument".
function sanitizeFetchErrorDetail_(message) {
  return String(message || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/access_token[^,\s]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Fetches an insights URL and returns { data, error }: data is the
// parsed JSON body on HTTP 200 (otherwise null) and error is a short
// secret-free summary of what went wrong (otherwise null). The
// exception message is reduced to the error name plus the
// sanitized reason, so no request URL or access token leaks.
function fetchInsightsJson_(url) {
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    const detail = sanitizeFetchErrorDetail_(
      err && err.message ? err.message : ''
    );
    return {
      data: null,
      error:
        'fetch exception (' +
        ((err && err.name) || 'Error') +
        ')' +
        (detail ? ': ' + detail : ''),
    };
  }
  const status = res.getResponseCode();
  const bodyText = res.getContentText();
  if (status !== 200) {
    return { data: null, error: summarizeInsightsError_(status, bodyText) };
  }
  try {
    return { data: JSON.parse(bodyText), error: null };
  } catch (err) {
    return { data: null, error: 'HTTP 200 with unparseable JSON body' };
  }
}

// Builds a compact summary of a Graph API error response, e.g.
// "HTTP 400 code=10 subcode=1234567: <error.message>". Only fields
// from the response body are used, and the message is truncated, so
// no token or other secret can leak into the snapshot or the log.
function summarizeInsightsError_(status, bodyText) {
  let summary = 'HTTP ' + status;
  let parsed = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    parsed = null;
  }
  const error = parsed && parsed.error;
  if (error) {
    if (error.code !== undefined && error.code !== null) {
      summary += ' code=' + error.code;
    }
    if (error.error_subcode !== undefined && error.error_subcode !== null) {
      summary += ' subcode=' + error.error_subcode;
    }
    if (error.message) {
      summary += ': ' + String(error.message).slice(0, 200);
    }
  }
  return summary;
}

// Returns { total, follower, nonFollower } in views, or null when the
// total_value + follow_type breakdown shape is not present.
function parseViewsBreakdown_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const totalValue = entry && entry.total_value;
  if (!totalValue) {
    return null;
  }
  const breakdowns = Array.isArray(totalValue.breakdowns)
    ? totalValue.breakdowns
    : [];
  let follower = null;
  let nonFollower = null;
  breakdowns.forEach((breakdown) => {
    const keys = (breakdown && breakdown.dimension_keys) || [];
    if (!keys.includes('follow_type')) {
      return;
    }
    ((breakdown && breakdown.results) || []).forEach((row) => {
      const dims = (row && row.dimension_values) || [];
      const value = apiNumberOrNull_(row && row.value);
      if (value === null) {
        return;
      }
      if (dims.includes('NON_FOLLOWER')) {
        nonFollower = value;
      } else if (dims.includes('FOLLOWER')) {
        follower = value;
      }
    });
  });
  if (follower === null && nonFollower === null) {
    return null;
  }
  const partsTotal = (follower || 0) + (nonFollower || 0);
  const reported = apiNumberOrNull_(totalValue.value);
  return {
    total: reported !== null ? reported : partsTotal,
    follower: follower || 0,
    nonFollower: nonFollower || 0,
  };
}

// Reads the total views out of a no-breakdown insights response, or
// null. With metric_type=total_value the response may carry
// total_value.value directly; otherwise the per-day values[].value
// are summed.
function parseViewsDailyTotal_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) {
    return null;
  }
  const totalValue = apiNumberOrNull_(
    entry.total_value && entry.total_value.value
  );
  if (totalValue !== null) {
    return totalValue;
  }
  const values = Array.isArray(entry.values) ? entry.values : null;
  if (!values) {
    return null;
  }
  let total = 0;
  let seen = false;
  values.forEach((row) => {
    const value = apiNumberOrNull_(row && row.value);
    if (value !== null) {
      total += value;
      seen = true;
    }
  });
  return seen ? total : null;
}

// --- SNS detail (for the /ga admin screen, action=sns_detail) ---
// collectSnsCounts() also gathers the numbers the public snapshot
// does not need: Instagram account-level insights for the last 30
// days, follower demographics, per-post insights for the newest
// media, YouTube channel totals plus the newest videos, and the
// Threads account metrics and per-post insights (see the Threads
// detail section below). They are stored in the same snapshot and
// served only through the authenticated action=sns_detail;
// action=sns_counts keeps returning the small public projection
// built above.
//
// Every fetch below fails independently: an unobtainable value stays
// null and the rest of the snapshot is unaffected. Failures are
// summarised per section — instagram.detail_error for the account
// insights and demographics, instagram.media_error for per-post
// insights, youtube.youtube_error for YouTube, threads.detail_error
// and threads.posts_error for Threads — using the same
// secret-free style as instagram.insights_error: summaries are built
// from response status/body or exception names only, never from a
// request URL (URLs carry the access token).

const SNS_RECENT_MEDIA_LIMIT = 30;
const SNS_RECENT_VIDEO_LIMIT = 10;
const SNS_DEMOGRAPHICS_TOP_LIMIT = 10;

function joinSnsErrors_(parts) {
  const list = (parts || []).filter(Boolean);
  return list.length ? list.join('; ') : null;
}

function snsInsightsWindow_() {
  const until = Math.floor(Date.now() / 1000);
  return { since: until - 30 * 24 * 60 * 60, until };
}

// Fetches one account-level insights metric as a 30-day total_value.
// Returns { value, error, data } and never throws; the total is read
// with parseViewsDailyTotal_, which accepts both the total_value
// form and a per-day values[] list to sum (the logic is
// metric-agnostic). data carries the raw body for callers that need
// the breakdown form (follows_and_unfollows).
function fetchAccountInsightTotal_(metric, extra) {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  const window = snsInsightsWindow_();
  const url =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=' +
    metric +
    '&period=day&metric_type=total_value&since=' +
    window.since +
    '&until=' +
    window.until +
    (extra || '') +
    '&access_token=' +
    encodeURIComponent(token);
  const res = fetchInsightsJson_(url);
  if (res.error) {
    return { value: null, error: metric + ': ' + res.error, data: null };
  }
  return { value: parseViewsDailyTotal_(res.data), error: null, data: res.data };
}

// Reads only the total_value.value out of an insights response, or
// null. Kept separate from parseViewsDailyTotal_ (which also sums
// per-day values) so callers can tell which form a number came from.
function parseInsightsTotalValue_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) {
    return null;
  }
  return apiNumberOrNull_(entry.total_value && entry.total_value.value);
}

// Sums only the per-day values[].value of an insights response, or
// null when the response carries no daily values.
function parseInsightsDailySum_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry || !Array.isArray(entry.values)) {
    return null;
  }
  let total = 0;
  let seen = false;
  entry.values.forEach((row) => {
    const value = apiNumberOrNull_(row && row.value);
    if (value !== null) {
      total += value;
      seen = true;
    }
  });
  return seen ? total : null;
}

// Fetches one account-level insights metric in the plain daily form
// (no metric_type) and returns the raw { data, error }. Some metrics
// reject a request without metric_type=total_value (observed for
// views), so on an error the request is retried once in that form;
// either response is only read for its per-day values.
function fetchAccountInsightDaily_(metric) {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  const window = snsInsightsWindow_();
  const base =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=' +
    metric +
    '&period=day&since=' +
    window.since +
    '&until=' +
    window.until;
  let res = fetchInsightsJson_(base + '&access_token=' + encodeURIComponent(token));
  if (res.error) {
    res = fetchInsightsJson_(
      base + '&metric_type=total_value&access_token=' + encodeURIComponent(token)
    );
  }
  return res;
}

// Profile link taps, in two stages. The total_value form is tried
// first; when it comes back null or 0 — the production snapshot on
// 2026-11-09 showed 0 while the Instagram app and the CLI reported
// dozens of bio link taps for the same account — the per-day values
// are summed instead, from the first response when it already
// carries them and from a dedicated daily request otherwise. The
// adopted form is reported as source ("total_value" / "daily_sum")
// so a wrong-looking number stays diagnosable in the snapshot.
// Returns { value, source, error } and never throws.
function fetchProfileLinksTaps_() {
  const first = fetchAccountInsightTotal_('profile_links_taps');
  if (first.error) {
    return { value: null, source: null, error: first.error };
  }
  const totalValue = parseInsightsTotalValue_(first.data);
  if (totalValue !== null && totalValue > 0) {
    return { value: totalValue, source: 'total_value', error: null };
  }
  let daily = parseInsightsDailySum_(first.data);
  if (daily === null) {
    const second = fetchAccountInsightDaily_('profile_links_taps');
    if (second.error) {
      if (totalValue === null) {
        return {
          value: null,
          source: null,
          error: 'profile_links_taps: ' + second.error,
        };
      }
    } else {
      daily = parseInsightsDailySum_(second.data);
    }
  }
  if (daily !== null) {
    return { value: daily, source: 'daily_sum', error: null };
  }
  if (totalValue !== null) {
    return { value: totalValue, source: 'total_value', error: null };
  }
  return {
    value: null,
    source: null,
    error: 'profile_links_taps: response had neither a total_value nor daily values',
  };
}

// Account-level detail for the main Instagram account (last 30
// days): reach, engaged accounts, the interaction totals, profile
// link taps, and the follows/unfollows split. Each metric is a
// separate request, so one rejected metric nulls only itself.
function fetchInstagramAccountDetail_() {
  const result = {
    reach_30d: null,
    accounts_engaged_30d: null,
    interactions_30d: {
      total: null,
      likes: null,
      comments: null,
      shares: null,
      saves: null,
    },
    profile_links_taps_30d: null,
    profile_links_taps_source: null,
    follows_30d: null,
    unfollows_30d: null,
    daily_follows: null,
    daily_follows_missing_days: null,
    daily_follows_error: null,
    detail_error: null,
  };
  if (!getScriptProperty_('META_ACCESS_TOKEN')) {
    return result;
  }
  const errors = [];
  const grab = (metric) => {
    const fetched = fetchAccountInsightTotal_(metric);
    if (fetched.error) {
      errors.push(fetched.error);
    }
    return fetched.value;
  };
  result.reach_30d = grab('reach');
  result.accounts_engaged_30d = grab('accounts_engaged');
  result.interactions_30d = {
    total: grab('total_interactions'),
    likes: grab('likes'),
    comments: grab('comments'),
    shares: grab('shares'),
    saves: grab('saves'),
  };
  const taps = fetchProfileLinksTaps_();
  result.profile_links_taps_30d = taps.value;
  result.profile_links_taps_source = taps.source;
  if (taps.error) {
    errors.push(taps.error);
  }
  const follows = fetchAccountInsightTotal_(
    'follows_and_unfollows',
    '&breakdown=follow_type'
  );
  if (follows.error) {
    errors.push(follows.error);
  } else {
    const parsed = parseFollowsBreakdown_(follows.data);
    if (parsed) {
      result.follows_30d = parsed.follows;
      result.unfollows_30d = parsed.unfollows;
    } else {
      // No label matched: record what the API actually sent so the
      // next adjustment starts from the observed labels, not a guess.
      const labels = followsBreakdownLabels_(follows.data);
      if (labels.length) {
        errors.push('follows_and_unfollows labels: [' + labels.join(', ') + ']');
      }
    }
  }
  // The per-day series fails on its own key, not into detail_error:
  // the /ga chart wants to tell "no data yet" apart from "the
  // totals are broken", and the totals above already report into
  // detail_error.
  const dailyFollows = fetchInstagramDailyFollows_();
  result.daily_follows = dailyFollows.series;
  result.daily_follows_missing_days = dailyFollows.missing_days;
  result.daily_follows_error = dailyFollows.error;
  result.detail_error = joinSnsErrors_(errors);
  return result;
}


export { SNS_DEMOGRAPHICS_TOP_LIMIT, SNS_RECENT_MEDIA_LIMIT, SNS_RECENT_VIDEO_LIMIT, fetchAccountInsightTotal_, fetchInsightsJson_, fetchInstagramAccountDetail_, fetchInstagramMediaCount_, fetchInstagramViewsInsights_, fetchProfileLinksTaps_, graphFieldsParam_, joinSnsErrors_, parseInsightsDailySum_, parseInsightsTotalValue_, parseViewsBreakdown_, parseViewsDailyTotal_, snsInsightsWindow_, summarizeInsightsError_ };
