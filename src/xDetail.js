// X detail: the tweet-gas sync and the x-cli stats feed.

import { getScriptProperty_ } from './auth.js';
import { xFeedFirstElement_, xNotifyDateToIso_ } from './xReactions.js';
import { SNS_CAPTION_MAX_LENGTH } from './instagramMedia.js';
import { snsHistoryKeyCell_ } from './historyWrite.js';

// --- X detail (via tweet-gas, GAS-to-GAS sync) ---------------------
// X's API keys live only in tweet-gas (the project that posts to
// X); this project never holds them. The hourly collection POSTs
// { action: 'sns_snapshot', sync_token } to tweet-gas's web app
// and receives the follower count plus the newest posts with
// their public metrics. The response also carries the X API
// usage half (credit balance and daily post consumption) at
// its top level — see extractXUsage_ for the field contract.
// That is the same machine sync-token
// pattern alarm-gas and time-table-gas use: the caller holds
// TWEET_GAS_EXEC_URL (the other app's /exec URL) and
// TWEET_GAS_SYNC_TOKEN, the same value as tweet-gas's SYNC_TOKEN
// property. While either property is unset the section reads as
// all nulls with no error — X simply is not connected yet. A
// failed call reports the same summary on x_error and
// posts_error (the two halves travel in one call here, unlike
// the per-edge fetches of the other networks), without touching
// the rest of the collection.
//
// The profile half (followers and recent posts) prefers the
// stats feed x-cli's hourly output is converted to on the
// home server (the X_STATS_URL property points at the RSS):
// the feed carries the same values as the snapshot's x
// section, so the collection stops depending on tweet-gas's
// per-hour profile / post reads against the official API —
// the main credit consumer. The usage half has no feed
// equivalent (it is billing data) and always comes from
// tweet-gas. A feed that cannot be fetched, cannot be
// parsed, or is older than SNS_X_STATS_MAX_AGE_MS simply
// falls back to the tweet-gas values, so the feed is an
// optimisation, never a new single point of failure.

const SNS_X_RECENT_POSTS_LIMIT = 50;

// How old the X stats file may be before it counts as stale.
// The file is regenerated hourly during the day (05:03–21:03
// JST) and pauses overnight, so the worst healthy gap is about
// 8 hours; a full day of slack still catches a dead generator.
const SNS_X_STATS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// How many days of X API post consumption the sync carries
// (tweet-gas sends the last 90 days).
const SNS_X_DAILY_POSTS_LIMIT = 90;

// A wire value from the tweet-gas response as a number, or null
// when it did not arrive as one.
function xWireNumberOrNull_(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// The day key of one X daily-posts entry: the leading
// "YYYY-MM-DD" of the wire date, or null when the value does
// not start with that shape. tweet-gas has shipped the dates
// both as plain "YYYY-MM-DD" and as full ISO timestamps
// ("2026-11-10T00:00:00.000Z" — seen in production on
// 2026-11-13, with a tweet-gas-side trim in flight); only the
// leading date part names the day, so anything past it is cut
// here instead of letting the two shapes split one day into
// two x_daily keys. A Date (what Sheets hands back for a
// stored date cell) is formatted in Asia/Tokyo by the same
// rule the stored upsert keys use.
function xDailyDateKey_(value) {
  if (value instanceof Date) {
    return snsHistoryKeyCell_(value) || null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1] : null;
}

// One entry per day out of normalized daily-posts entries:
// entries the normalization could not date are dropped, a day
// that arrives twice (e.g. once per date shape) keeps its last
// entry — the same winner the x_daily upsert would keep — and
// the result is ascending, capped at the newest days.
function dedupeXDailyPosts_(entries) {
  const byDate = {};
  (entries || []).forEach((entry) => {
    if (entry && entry.date) {
      byDate[entry.date] = entry;
    }
  });
  return Object.keys(byDate)
    .sort()
    .slice(-SNS_X_DAILY_POSTS_LIMIT)
    .map((date) => byDate[date]);
}

// The X API usage section from the tweet-gas response: the
// credit balance (USD) and the daily post consumption, or nulls
// when the response carries no usage half. The contract (set by
// tweet-gas): the snapshot response carries, at its top level,
// x_usage (an object, or null when tweet-gas could not obtain a
// Bearer token at all) and usage_error (a summary string, or
// null). Inside x_usage, credit_balance_usd is the balance
// total and daily_posts is the last 90 days of
// { date, tweets_consumed } in ascending order — the date
// nominally "YYYY-MM-DD" but normalized through
// xDailyDateKey_ because production has also sent full ISO
// timestamps; either half may independently be missing (null)
// when its own fetch failed, with usage_error saying so. A
// balance the API reports as zero is a real balance and is
// kept. Fields this side does not consume (cycle_posts_consumed
// and friends) are ignored, never an error.
function extractXUsage_(data) {
  const result = { balance_usd: null, daily_posts: null, usage_error: null };
  const root = data || {};
  if (typeof root.usage_error === 'string' && root.usage_error) {
    result.usage_error = root.usage_error;
  }
  const usage = root.x_usage;
  if (!usage || typeof usage !== 'object') {
    return result;
  }
  result.balance_usd = xWireNumberOrNull_(usage.credit_balance_usd);
  if (Array.isArray(usage.daily_posts)) {
    result.daily_posts = dedupeXDailyPosts_(
      usage.daily_posts.map((entry) => {
        const item = entry || {};
        return {
          date: xDailyDateKey_(item.date),
          tweets_consumed: xWireNumberOrNull_(item.tweets_consumed),
        };
      })
    );
  }
  return result;
}

// One snapshot entry for an X post, normalized from the wire
// entry tweet-gas sends. The text is capped under the same limit
// as Instagram captions and Threads texts; the post URL is not
// on the wire (it is derivable), so it is rebuilt from the post
// id here — the same call the read side makes for YouTube videos.
function buildXPostEntry_(post) {
  const item = post || {};
  const id = item.id != null ? String(item.id) : null;
  const text = item.text != null ? String(item.text) : '';
  return {
    id,
    posted_at: item.posted_at || null,
    text: text.slice(0, SNS_CAPTION_MAX_LENGTH),
    url: id ? 'https://x.com/i/web/status/' + id : null,
    views: xWireNumberOrNull_(item.views),
    likes: xWireNumberOrNull_(item.likes),
    reposts: xWireNumberOrNull_(item.reposts),
    replies: xWireNumberOrNull_(item.replies),
  };
}

// The whole X section from one POST to tweet-gas. Never throws:
// every failure mode (unconfigured, HTTP error, malformed or
// not-ok body) lands in the error fields with the values null.
function fetchXDetailFromTweetGas_() {
  const result = {
    followers: null,
    username: null,
    api_balance_usd: null,
    api_daily_posts: null,
    usage_error: null,
    recent_posts: null,
    x_error: null,
    posts_error: null,
  };
  const url = getScriptProperty_('TWEET_GAS_EXEC_URL');
  const token = getScriptProperty_('TWEET_GAS_SYNC_TOKEN');
  if (!url || !token) {
    return result;
  }
  const fail = (message) => {
    result.x_error = message;
    result.posts_error = message;
    return result;
  };
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'text/plain',
      payload: JSON.stringify({ action: 'sns_snapshot', sync_token: token }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    return fail(
      'tweet-gas fetch exception (' + ((err && err.name) || 'Error') + ')'
    );
  }
  if (res.getResponseCode() !== 200) {
    return fail('tweet-gas HTTP ' + res.getResponseCode());
  }
  let data = null;
  try {
    data = JSON.parse(res.getContentText());
  } catch (err) {
    data = null;
  }
  if (!data || data.ok !== true) {
    const reason =
      data && data.error
        ? String(data.error).slice(0, 200)
        : 'response was not ok JSON';
    return fail('tweet-gas: ' + reason);
  }
  const x = data.x || {};
  result.followers = xWireNumberOrNull_(x.followers);
  result.username = x.username != null ? String(x.username) : null;
  const usage = extractXUsage_(data);
  result.api_balance_usd = usage.balance_usd;
  result.api_daily_posts = usage.daily_posts;
  result.usage_error = usage.usage_error;
  result.x_error =
    typeof data.x_error === 'string' && data.x_error ? data.x_error : null;
  result.posts_error =
    typeof data.posts_error === 'string' && data.posts_error
      ? data.posts_error
      : null;
  if (Array.isArray(x.recent_posts)) {
    result.recent_posts = x.recent_posts
      .map(buildXPostEntry_)
      .filter((entry) => entry.id)
      .slice(0, SNS_X_RECENT_POSTS_LIMIT);
  }
  return result;
}

// Parses the stats RSS x-cli's output is converted to on the
// home server (namespace https://freddiefujiwara.com/ns/x-stats,
// prefix xs): the channel carries xs:username / xs:followers /
// xs:following / xs:collected-at, and each item is one post —
// guid is the post id, pubDate its moment, description its
// text, and xs:views / xs:likes / xs:reposts / xs:replies its
// metrics. Returns { collected_at, username, followers,
// recent_posts } with the posts in the wire shape
// buildXPostEntry_ consumes, or null when the document does
// not yield a collected_at or any post at all — a feed that
// cannot prove when it was made is not a stats source. The
// element reads reuse the notify feed's extractor
// (xFeedFirstElement_), which matches on local names, so the
// xs prefix itself is never hard-coded here.
function parseXStatsFeed_(xmlText) {
  const text = String(xmlText || '');
  const head = text.split('<item')[0];
  const collectedAt = xFeedFirstElement_(head, 'collected-at');
  if (!collectedAt || !Number.isFinite(Date.parse(collectedAt))) {
    return null;
  }
  const posts = [];
  const pattern = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const itemXml = match[1];
    posts.push({
      id: xFeedFirstElement_(itemXml, 'guid'),
      posted_at: xNotifyDateToIso_(xFeedFirstElement_(itemXml, 'pubDate')),
      text: xFeedFirstElement_(itemXml, 'description') || '',
      views: xWireNumberOrNull_(xFeedFirstElement_(itemXml, 'views')),
      likes: xWireNumberOrNull_(xFeedFirstElement_(itemXml, 'likes')),
      reposts: xWireNumberOrNull_(xFeedFirstElement_(itemXml, 'reposts')),
      replies: xWireNumberOrNull_(xFeedFirstElement_(itemXml, 'replies')),
    });
  }
  if (!posts.length) {
    return null;
  }
  const username = xFeedFirstElement_(head, 'username');
  return {
    collected_at: collectedAt,
    username: username || null,
    followers: xWireNumberOrNull_(xFeedFirstElement_(head, 'followers')),
    recent_posts: posts,
  };
}

// The profile half of the X section from the stats feed x-cli's
// output is converted to on the home server (the X_STATS_URL
// property points at the RSS): the same values the tweet-gas
// snapshot's x section carries (metrics missing on a post are
// null, never 0). Never throws and never guesses: an unset
// X_STATS_URL, a failed fetch, an unparsable body, or a
// collected_at older than SNS_X_STATS_MAX_AGE_MS all return
// null, and the caller falls back to the tweet-gas values. The
// returned posts pass through the same normalization as the
// wire posts.
function fetchXStatsFile_() {
  const url = getScriptProperty_('X_STATS_URL');
  if (!url) {
    return null;
  }
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    return null;
  }
  if (res.getResponseCode() !== 200) {
    return null;
  }
  const data = parseXStatsFeed_(res.getContentText());
  if (!data) {
    return null;
  }
  const collectedMs = Date.parse(data.collected_at);
  if (
    !Number.isFinite(collectedMs) ||
    Date.now() - collectedMs > SNS_X_STATS_MAX_AGE_MS
  ) {
    return null;
  }
  return {
    followers: data.followers,
    username: data.username,
    recent_posts: data.recent_posts
      .map(buildXPostEntry_)
      .filter((entry) => entry.id)
      .slice(0, SNS_X_RECENT_POSTS_LIMIT),
  };
}

// The X section for one collection: the usage half always comes
// from tweet-gas, and the profile half (followers, username,
// recent posts) is overlaid from the stats file whenever the
// file yields it — see the section header for why. A half the
// file provides also clears that half's tweet-gas error: the
// numbers are there, so there is nothing left to report.
function fetchXDetail_() {
  const result = fetchXDetailFromTweetGas_();
  const stats = fetchXStatsFile_();
  if (!stats) {
    return result;
  }
  if (stats.followers != null) {
    result.followers = stats.followers;
  }
  if (stats.username) {
    result.username = stats.username;
  }
  if (stats.recent_posts) {
    result.recent_posts = stats.recent_posts;
    result.posts_error = null;
  }
  if (stats.followers != null && stats.recent_posts) {
    result.x_error = null;
  }
  return result;
}


export { SNS_X_RECENT_POSTS_LIMIT, buildXPostEntry_, dedupeXDailyPosts_, extractXUsage_, fetchXDetail_, parseXStatsFeed_, xDailyDateKey_, xWireNumberOrNull_ };
