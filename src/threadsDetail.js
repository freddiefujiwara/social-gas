// Threads detail: account metrics and per-post metrics.

import { THREADS_GRAPH_BASE, apiNumberOrNull_, threadsToken_, threadsUserId_ } from './snsCounts.js';
import { fetchInsightsJson_, joinSnsErrors_, parseViewsDailyTotal_, snsInsightsWindow_ } from './instagramDetail.js';
import { SNS_CAPTION_MAX_LENGTH } from './instagramMedia.js';

// --- Threads detail (account metrics + per-post, sns_detail only) --
// Threads started as followers-only (the public snapshot). The /ga
// Threads tab now wants the same depth as Instagram, so
// collectSnsCounts() also gathers, into the snapshot's threads
// section (served only through the authenticated action=sns_detail;
// the public projection keeps returning followers only):
//   - account-level totals for the last 30 days from the user's
//     threads_insights edge: views plus the interaction split
//     (likes / replies / reposts / quotes), failures summarised in
//     threads.detail_error;
//   - the newest posts (id, text, timestamp, permalink) from the
//     user's threads edge, each with its media insights (views /
//     likes / replies / reposts / quotes), failures summarised in
//     threads.posts_error.
// Every fetch fails independently, exactly like the Instagram
// detail: an unobtainable value stays null and the rest of the
// snapshot is unaffected, and error summaries are built from
// response status/body only, never from a request URL.

const SNS_THREADS_RECENT_POSTS_LIMIT = 30;
const THREADS_MEDIA_INSIGHT_METRICS = 'views,likes,replies,reposts,quotes';
const THREADS_ACCOUNT_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'];

// One account-level threads_insights request for a single metric
// over the shared 30-day window. The URL carries no token; callers
// append '&access_token=...' themselves.
function threadsAccountInsightsUrl_(userId, metric, window) {
  return (
    THREADS_GRAPH_BASE +
    userId +
    '/threads_insights?metric=' +
    metric +
    '&since=' +
    window.since +
    '&until=' +
    window.until
  );
}

// Fetches one account-level Threads metric as a 30-day total.
// Returns { value, error } and never throws. The total is read with
// parseViewsDailyTotal_ (total_value when the response carries one,
// otherwise the sum of the per-day values): the reading is
// metric-agnostic, and for these flow metrics both forms mean the
// 30-day total — unlike followers_count, which is a current total
// and keeps its own parser above.
function fetchThreadsAccountInsightTotal_(metric) {
  const token = threadsToken_();
  const res = fetchInsightsJson_(
    threadsAccountInsightsUrl_(threadsUserId_(), metric, snsInsightsWindow_()) +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (res.error) {
    return { value: null, error: metric + ': ' + res.error };
  }
  return { value: parseViewsDailyTotal_(res.data), error: null };
}

// Account-level detail for Threads (last 30 days): views and the
// interaction totals. Each metric is a separate request, so one
// rejected metric nulls only itself. interactions_30d.total is the
// sum of the parts that came back, and stays null when none did.
function fetchThreadsAccountDetail_() {
  const result = {
    views_30d: null,
    interactions_30d: {
      total: null,
      likes: null,
      replies: null,
      reposts: null,
      quotes: null,
    },
    detail_error: null,
  };
  if (!threadsToken_()) {
    return result;
  }
  const errors = [];
  const grab = (metric) => {
    const fetched = fetchThreadsAccountInsightTotal_(metric);
    if (fetched.error) {
      errors.push(fetched.error);
    }
    return fetched.value;
  };
  result.views_30d = grab('views');
  const likes = grab('likes');
  const replies = grab('replies');
  const reposts = grab('reposts');
  const quotes = grab('quotes');
  const parts = [likes, replies, reposts, quotes].filter(
    (value) => value !== null
  );
  result.interactions_30d = {
    total: parts.length
      ? parts.reduce((sum, value) => sum + value, 0)
      : null,
    likes,
    replies,
    reposts,
    quotes,
  };
  result.detail_error = joinSnsErrors_(errors);
  return result;
}

// The user's own threads list (newest first). The URL carries no
// token; callers append '&access_token=...' themselves so the
// diagnostic can print the request with the token redacted.
function threadsPostListUrl_(userId, limit) {
  return (
    THREADS_GRAPH_BASE +
    userId +
    '/threads?fields=id,text,timestamp,permalink,media_type&limit=' +
    limit
  );
}

// One snapshot entry for a Threads post, with the insight values
// starting null (filled in by fetchThreadsPostInsights_). The text
// is passed through under the same safety cap as Instagram
// captions.
function buildThreadsPostEntry_(post) {
  const text = post && post.text != null ? String(post.text) : '';
  return {
    id: post && post.id != null ? String(post.id) : null,
    type: (post && post.media_type) || null,
    posted_at: (post && post.timestamp) || null,
    text: text.slice(0, SNS_CAPTION_MAX_LENGTH),
    permalink: (post && post.permalink) || null,
    views: null,
    likes: null,
    replies: null,
    reposts: null,
    quotes: null,
  };
}

// Maps one Threads media insights response to the snapshot's key
// names. Metrics absent from the response (or not numeric) stay out
// of the map, so the caller's nulls remain for them.
function parseThreadsMediaInsights_(data) {
  const values = {};
  const entries = data && Array.isArray(data.data) ? data.data : [];
  entries.forEach((entry) => {
    if (!entry || !entry.name) {
      return;
    }
    let raw = null;
    if (Array.isArray(entry.values) && entry.values.length) {
      raw = entry.values[0] && entry.values[0].value;
    }
    if (raw == null && entry.total_value) {
      raw = entry.total_value.value;
    }
    const num = apiNumberOrNull_(raw);
    if (num === null) {
      return;
    }
    if (THREADS_ACCOUNT_METRICS.indexOf(entry.name) >= 0) {
      values[entry.name] = num;
    }
  });
  return values;
}

// Per-post insights for one Threads post. Returns { values, error };
// a post the insights edge refuses (a repost of someone else's
// post, say) keeps its nulls and contributes one error line.
function fetchThreadsPostInsights_(post, token) {
  const empty = {
    views: null,
    likes: null,
    replies: null,
    reposts: null,
    quotes: null,
  };
  if (!post || post.id == null) {
    return { values: empty, error: null };
  }
  const res = fetchInsightsJson_(
    THREADS_GRAPH_BASE +
      post.id +
      '/insights?metric=' +
      THREADS_MEDIA_INSIGHT_METRICS +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (res.error) {
    return { values: empty, error: String(post.id) + ': ' + res.error };
  }
  return {
    values: Object.assign({}, empty, parseThreadsMediaInsights_(res.data)),
    error: null,
  };
}

// The newest Threads posts with their per-post insights, mirroring
// fetchInstagramRecentMedia_: the list fetch failing nulls the
// whole section, while per-post failures only null that post's
// numbers and are counted into posts_error.
function fetchThreadsRecentPosts_() {
  const token = threadsToken_();
  if (!token) {
    return { recent_posts: null, posts_error: null };
  }
  const listRes = fetchInsightsJson_(
    threadsPostListUrl_(threadsUserId_(), SNS_THREADS_RECENT_POSTS_LIMIT) +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (listRes.error) {
    return { recent_posts: null, posts_error: 'threads list: ' + listRes.error };
  }
  const items =
    listRes.data && Array.isArray(listRes.data.data) ? listRes.data.data : null;
  if (!items) {
    return {
      recent_posts: null,
      posts_error: 'threads list: response had no threads array',
    };
  }
  const failures = [];
  const posts = items.slice(0, SNS_THREADS_RECENT_POSTS_LIMIT).map((post) => {
    const entry = buildThreadsPostEntry_(post);
    const insights = fetchThreadsPostInsights_(post, token);
    if (insights.error) {
      failures.push(insights.error);
    }
    Object.assign(entry, insights.values);
    return entry;
  });
  return {
    recent_posts: posts,
    posts_error: failures.length
      ? failures.length +
        ' of ' +
        posts.length +
        ' post insights failed (' +
        failures[0] +
        ')'
      : null,
  };
}

// Reads one threads_insights entry (a single metric) as a total:
// total_value.value when present, otherwise the sum of the per-day
// values. This is the entry-level twin of parseViewsDailyTotal_,
// shared by the debugThreadsPosts by-name reading below.
function threadsInsightEntryTotal_(entry) {
  if (!entry) {
    return null;
  }
  const totalValue = apiNumberOrNull_(
    entry.total_value && entry.total_value.value
  );
  if (totalValue !== null) {
    return totalValue;
  }
  if (!Array.isArray(entry.values)) {
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

// Maps a multi-metric threads_insights response to { name: total },
// keeping only the metrics that read as numbers. Used by
// debugThreadsPosts to show what the combined account request
// actually carries before the per-metric production fetches are
// trusted.
function parseThreadsInsightsByName_(data) {
  const totals = {};
  const entries = data && Array.isArray(data.data) ? data.data : [];
  entries.forEach((entry) => {
    if (!entry || !entry.name) {
      return;
    }
    const total = threadsInsightEntryTotal_(entry);
    if (total !== null) {
      totals[entry.name] = total;
    }
  });
  return totals;
}


export { SNS_THREADS_RECENT_POSTS_LIMIT, THREADS_ACCOUNT_METRICS, THREADS_MEDIA_INSIGHT_METRICS, buildThreadsPostEntry_, fetchThreadsAccountDetail_, fetchThreadsAccountInsightTotal_, fetchThreadsPostInsights_, fetchThreadsRecentPosts_, parseThreadsInsightsByName_, parseThreadsMediaInsights_, threadsAccountInsightsUrl_, threadsInsightEntryTotal_, threadsPostListUrl_ };
