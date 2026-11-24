// SNS follower counts snapshot (YouTube / Instagram / Threads)
// and the sns_counts / live sns_detail response builders.

import { getScriptProperty_ } from './auth.js';
import { parseInsightsTotalValue_ } from './instagramDetail.js';
import { SNS_HISTORY_SHEET_ID_PROPERTY, summarizeSnsHistoryError_ } from './historyWrite.js';
import { SNS_DETAIL_CACHE_KEY, SNS_DETAIL_CACHE_SECONDS, buildSnsDetailFromSheet_, getCachedText_, putCachedText_, sheetReadCache_ } from './sheetRead.js';

// --- SNS follower counts (YouTube / Instagram / Threads) ---
// collectSnsCounts() runs on a time-driven trigger (see setupSnsTriggers)
// and stores a snapshot in the Script Property SNS_COUNTS_SNAPSHOT.
// The action=sns_counts endpoint is public by design: it only ever
// returns the public projection of that snapshot (follower counts,
// the Instagram KPIs, collected_at). It never exposes tokens, any
// GA4 data, or the admin-only detail in the snapshot; the full
// snapshot is served by action=sns_detail behind the usual
// authentication gate (see buildSnsDetailResponse_).
//
// Script Properties used here:
//   META_ACCESS_TOKEN: Meta long-lived user token (about 60 days) used
//     for the Instagram accounts through graph.facebook.com.
//   META_APP_ID / META_APP_SECRET: when both are set, the token above is
//     refreshed with fb_exchange_token before it gets close to expiry.
//   META_TOKEN_EXPIRES_AT: ISO timestamp of the token expiry, maintained
//     by refreshMetaTokenIfNeeded_().
//   META_THREADS_ACCESS_TOKEN (optional): Threads long-lived token, used
//     for graph.threads.net when set (Threads tokens are issued per app
//     through the Threads use case, separately from the token above).
//     Falls back to META_ACCESS_TOKEN when unset. When its expiry is
//     recorded in META_THREADS_TOKEN_EXPIRES_AT, it is refreshed with
//     th_refresh_token in the same way.
//   THREADS_APP_ID / THREADS_APP_SECRET (optional): credentials of the
//     dedicated Threads app (use case "Access the Threads API").
//     THREADS_APP_ID is the Threads app ID shown at the top of the
//     Threads API Settings screen — the OAuth client_id — which is
//     NOT the Meta app ID. When
//     set, the Threads token above can be obtained entirely inside
//     GAS: run threadsAuthorizeUrl() in the editor, open the logged
//     URL, and approve; the OAuth callback lands on this Web App's
//     /exec (see handleThreadsOAuthCallback_) and stores the
//     long-lived token in META_THREADS_ACCESS_TOKEN, the Threads user
//     id in THREADS_USER_ID and the acquisition time in
//     THREADS_TOKEN_AT. refreshThreadsTokenIfNeeded() renews the
//     token with th_refresh_token once it is 50+ days old, so no
//     manual re-authorization is needed while the collections keep
//     running. THREADS_REDIRECT_URI may override the redirect URI
//     (default: this Web App's own /exec URL); the same URI must be
//     registered in the Threads app's settings.
//   SNS_HISTORY_SHEET_ID (optional): spreadsheet that receives the
//     history writes of every collection (see appendSnsHistory_):
//     one appended row per collection on "account", one upserted
//     row per post / video / day / segment / metric on the other
//     tabs. The same spreadsheet also receives the blog's GA4
//     history on every collection (see appendBlogHistory_). Unset
//     means no history is written.
// The Instagram snapshot also carries account KPIs for the main
// account: media_count (post count, available with instagram_basic)
// plus views_30d / non_follower_pct from the account insights, which
// stay null until the token also has instagram_manage_insights.
// When the insights calls fail, instagram.insights_error holds a
// short secret-free summary of the API error (null on success) so the
// failure is visible in the snapshot instead of silently null.
// The Threads section likewise carries detail beyond the follower
// count — the account metrics and per-post insights described in
// the Threads detail section below — under the same rule, with
// threads.detail_error / threads.posts_error as the summaries.

const SNS_SNAPSHOT_PROPERTY = 'SNS_COUNTS_SNAPSHOT';
const SNS_YOUTUBE_CHANNEL_ID = 'UCbiDZXbr391oT_vsRiqwPFg';
const SNS_INSTAGRAM_MAIN_ID = '17841401041540002'; // @freddiefujiwara
const SNS_FACEBOOK_PAGE_ID = '362616541057810'; // Page "freddiefujiwara"
const SNS_INSTAGRAM_SUB_ID = '17841434285478967'; // @anemone_cancer
const SNS_THREADS_USER_ID = '17841462976834295'; // @freddiefujiwara
const META_GRAPH_BASE = 'https://graph.facebook.com/v25.0/';
const THREADS_GRAPH_BASE = 'https://graph.threads.net/v1.0/';
const SNS_TOKEN_REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

function getSnsCountsSnapshot_() {
  const raw = getScriptProperty_(SNS_SNAPSHOT_PROPERTY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// The public sns_counts response is a fixed projection of the
// snapshot: only the follower/KPI fields the top page consumes. The
// snapshot itself also carries the admin-only detail collected for
// action=sns_detail (account insights, demographics, per-post and
// per-video numbers); those must never leak into the public action,
// so the snapshot is never returned verbatim here. reach_30d and
// saves_30d (the snapshot's interactions_30d.saves) are part of the
// projection because the top page hero shows them; they are the
// same stored values action=sns_detail serves.
function buildSnsCountsResponse_() {
  const snapshot = getSnsCountsSnapshot_();
  if (!snapshot) {
    return {
      ok: true,
      action: 'sns_counts',
      collected_at: null,
      youtube: { subscribers: null },
      instagram: {
        freddiefujiwara: null,
        anemone_cancer: null,
        media_count: null,
        views_30d: null,
        non_follower_pct: null,
        reach_30d: null,
        saves_30d: null,
        insights_error: null,
      },
      threads: { followers: null },
      x: { followers: null },
    };
  }
  const youtube = snapshot.youtube || {};
  const instagram = snapshot.instagram || {};
  const threads = snapshot.threads || {};
  const x = snapshot.x || {};
  return {
    ok: true,
    action: 'sns_counts',
    collected_at: snapshot.collected_at || null,
    youtube: { subscribers: snsNumberOrNull_(youtube.subscribers) },
    instagram: {
      freddiefujiwara: snsNumberOrNull_(instagram.freddiefujiwara),
      anemone_cancer: snsNumberOrNull_(instagram.anemone_cancer),
      media_count: snsNumberOrNull_(instagram.media_count),
      views_30d: snsNumberOrNull_(instagram.views_30d),
      non_follower_pct: snsNumberOrNull_(instagram.non_follower_pct),
      reach_30d: snsNumberOrNull_(instagram.reach_30d),
      saves_30d: snsNumberOrNull_(
        instagram.interactions_30d && instagram.interactions_30d.saves
      ),
      insights_error:
        instagram.insights_error != null ? instagram.insights_error : null,
    },
    threads: { followers: snsNumberOrNull_(threads.followers) },
    x: { followers: snsNumberOrNull_(x.followers) },
  };
}

function snsNumberOrNull_(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// A value that arrived over the wire (an API response field)
// as a number, or null when it did not arrive as one. Bare
// Number() coercion is not used for this: it reads null / ''
// / whitespace as 0, true as 1 and [5] as 5 — counts the
// source never reported — and it throws on a value whose
// toString is not a function (producible via JSON). Only
// finite numbers and non-blank numeric strings count here.
function apiNumberOrNull_(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

// Default detail payload served by action=sns_detail before the
// first collection: the full key set with null values, so the /ga
// frontend can rely on the shape.
function buildEmptySnsDetail_() {
  return {
    collected_at: null,
    youtube: {
      subscribers: null,
      total_views: null,
      video_count: null,
      recent_videos: null,
      youtube_error: null,
    },
    instagram: {
      freddiefujiwara: null,
      anemone_cancer: null,
      media_count: null,
      views_30d: null,
      non_follower_pct: null,
      insights_error: null,
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
      demographics: { age_gender: null, top_cities: null, top_countries: null },
      detail_error: null,
      recent_media: null,
      media_error: null,
    },
    threads: {
      followers: null,
      threads_error: null,
      views_30d: null,
      interactions_30d: {
        total: null,
        likes: null,
        replies: null,
        reposts: null,
        quotes: null,
      },
      detail_error: null,
      recent_posts: null,
      posts_error: null,
    },
    x: {
      followers: null,
      username: null,
      api_balance_usd: null,
      api_daily_posts: null,
      usage_error: null,
      x_error: null,
      recent_posts: null,
      posts_error: null,
      // Reaction facts per post ({ tweet_id: [fact, ...] }),
      // the unattributed replies / quotes, and the newest
      // stored follows, all from the "x_reactions" tab — see
      // buildXReactionRows_. Only the sheet-built detail
      // carries them; the snapshot fallback leaves them null
      // and the screen simply offers no detail then.
      reactions: null,
      unattributed_reactions: null,
      recent_follows: null,
    },
  };
}

// --- sns_detail scopes ---
// The detail is the screen's largest payload (the recent
// media / posts lists dominate it), and each tab needs only
// part of it, so action=sns_detail accepts an optional scope:
//   (no scope)   the full payload, exactly as before.
//   overview     every platform section with its heavy
//                per-post collections reduced (scalars kept),
//                for the overview tab: each channel's recent
//                list keeps only its top posts, trimmed (see
//                SNS_DETAIL_OVERVIEW_TOP_POSTS below), and
//                the X reaction collections empty.
//   instagram / threads / youtube / x
//                only that platform's section, complete.
// An unknown scope reads as no scope. Every variant carries
// detail_scope at the top level (the full payload does not),
// is cached under its own chunked-cache key, and is
// precomputed at collection time alongside the full payload
// (see precomputeReadCaches_), so a scoped read costs the
// same cache hit as the full one. The shaping is pure: it
// runs on the assembled detail (sheet-built or the snapshot
// fallback) and never changes what the full payload holds.
const SNS_DETAIL_VARIANT_SCOPES = [
  'overview',
  'instagram',
  'threads',
  'youtube',
  'x',
];

// The per-post collections the overview scope empties, per
// platform section. The X section's reactions are keyed by
// the very posts recent_posts carries, so the map empties
// with the list. Bounded daily aggregates (daily_follows,
// api_daily_posts, demographics) are not per-post lists and
// stay, like every scalar.
const SNS_DETAIL_OVERVIEW_EMPTIED_FIELDS = {
  x: ['unattributed_reactions', 'recent_follows'],
};

// The overview tab's per-channel top lists (the frontend's
// topPostsByChannel, src/api.js of the social frontend) rank
// each channel's recent items by views and show the top 3,
// so the overview scope keeps exactly those three per list
// instead of emptying the lists: the same ranking the screen
// applies (its sortMedia by "views", descending), each item
// trimmed to the fields that ranking and its renderer read
// (the caption / title head, the link, the view count, and
// Instagram's media type, the label fallback when a caption
// is empty). The platform scopes and the full payload keep
// the complete lists, so a channel tab never reads these.
const SNS_DETAIL_OVERVIEW_TOP_LIMIT = 3;
const SNS_DETAIL_OVERVIEW_TOP_POSTS = {
  youtube: {
    field: 'recent_videos',
    itemFields: ['title', 'url', 'views'],
  },
  instagram: {
    field: 'recent_media',
    itemFields: ['caption', 'type', 'permalink', 'views'],
  },
  threads: {
    field: 'recent_posts',
    itemFields: ['text', 'permalink', 'views'],
  },
  x: {
    field: 'recent_posts',
    itemFields: ['text', 'url', 'views'],
  },
};

// A view count the frontend's sortMedia treats as missing:
// null, undefined or a non-finite number. A missing count
// sinks below every present one, whichever the direction.
function snsDetailOverviewViewsMissing_(value) {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'number' && !Number.isFinite(value))
  );
}

// The frontend's sortMedia comparator for "views",
// descending: missing counts sink, two numbers compare
// numerically, anything else compares as strings.
// Array.prototype.sort is stable, so equal counts keep the
// collected (newest-first) order — the overview's top 3 are
// the same items the screen picks from the full payload.
function compareSnsDetailOverviewViewsDesc_(a, b) {
  const av = a ? a.views : null;
  const bv = b ? b.views : null;
  const aMissing = snsDetailOverviewViewsMissing_(av);
  const bMissing = snsDetailOverviewViewsMissing_(bv);
  if (aMissing && bMissing) {
    return 0;
  }
  if (aMissing) {
    return 1;
  }
  if (bMissing) {
    return -1;
  }
  const cmp =
    typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv));
  return -cmp;
}

// One channel's overview list: the top items by views (see
// compareSnsDetailOverviewViewsDesc_), each trimmed to the
// given fields. A value that is not a list reads as an empty
// one, like the frontend's listOf.
function snsDetailOverviewTopItems_(items, itemFields) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .slice()
    .sort(compareSnsDetailOverviewViewsDesc_)
    .slice(0, SNS_DETAIL_OVERVIEW_TOP_LIMIT)
    .map((item) => {
      const trimmed = {};
      if (item && typeof item === 'object') {
        itemFields.forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(item, field)) {
            trimmed[field] = item[field];
          }
        });
      }
      return trimmed;
    });
}

function normalizeSnsDetailScope_(scope) {
  return SNS_DETAIL_VARIANT_SCOPES.indexOf(scope) >= 0 ? scope : null;
}

function snsDetailCacheKey_(scope) {
  return scope ? SNS_DETAIL_CACHE_KEY + '_' + scope : SNS_DETAIL_CACHE_KEY;
}

function shapeSnsDetailOverviewSection_(platform, section) {
  if (!section || typeof section !== 'object') {
    return section;
  }
  const shaped = Object.assign({}, section);
  (SNS_DETAIL_OVERVIEW_EMPTIED_FIELDS[platform] || []).forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(shaped, field)) {
      shaped[field] = [];
    }
  });
  const topPosts = SNS_DETAIL_OVERVIEW_TOP_POSTS[platform];
  if (
    topPosts &&
    Object.prototype.hasOwnProperty.call(shaped, topPosts.field)
  ) {
    shaped[topPosts.field] = snsDetailOverviewTopItems_(
      shaped[topPosts.field],
      topPosts.itemFields
    );
  }
  if (
    platform === 'x' &&
    Object.prototype.hasOwnProperty.call(shaped, 'reactions')
  ) {
    shaped.reactions = {};
  }
  return shaped;
}

// The scoped view of an assembled detail. scope is a
// normalized scope (see normalizeSnsDetailScope_); null
// returns the detail itself, untouched.
function shapeSnsDetail_(detail, scope) {
  if (!detail || !scope) {
    return detail;
  }
  if (scope === 'overview') {
    return {
      collected_at: detail.collected_at,
      detail_scope: 'overview',
      youtube: shapeSnsDetailOverviewSection_('youtube', detail.youtube),
      instagram: shapeSnsDetailOverviewSection_(
        'instagram',
        detail.instagram
      ),
      threads: shapeSnsDetailOverviewSection_('threads', detail.threads),
      x: shapeSnsDetailOverviewSection_('x', detail.x),
    };
  }
  const shaped = { collected_at: detail.collected_at, detail_scope: scope };
  shaped[scope] = detail[scope];
  return shaped;
}

// action=sns_detail (authenticated): the detail for the
// /social admin screen, assembled from the history spreadsheet
// (stage 2: the screen's reads come from the sheet, never from
// a live API call — see buildSnsDetailFromSheet_ below). The
// stored snapshot is the fallback: when the sheet cannot be
// read (or holds no account row yet), the snapshot is served
// exactly as before, and before the first collection the empty
// shape above is served. The assembled detail is cached for
// an hour — and the hourly collection precomputes it — so
// repeated screen loads do not re-read every tab. The optional
// scope (see the scopes section above) shapes the payload
// after assembly; the full payload is served when it is
// absent or unknown.
function buildSnsDetailResponse_(scope) {
  const normalizedScope = normalizeSnsDetailScope_(scope);
  const cache = sheetReadCache_();
  const cacheKey = snsDetailCacheKey_(normalizedScope);
  if (cache) {
    const hit = getCachedText_(cache, cacheKey);
    if (hit) {
      try {
        return Object.assign(
          { ok: true, action: 'sns_detail' },
          JSON.parse(hit)
        );
      } catch (err) {
        // A corrupt cache entry is ignored; the detail is rebuilt.
      }
    }
  }
  let detail = null;
  try {
    detail = buildSnsDetailFromSheet_();
  } catch (err) {
    console.log(
      'SNS detail from sheet failed: ' +
        summarizeSnsHistoryError_(
          err,
          getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY)
        )
    );
    detail = null;
  }
  if (!detail) {
    detail = getSnsCountsSnapshot_() || buildEmptySnsDetail_();
  }
  const shaped = shapeSnsDetail_(detail, normalizedScope);
  if (cache) {
    // Stored chunked (see putCachedText_): a detail past the
    // per-value cap is cached too, instead of going uncached
    // as it did when the whole JSON had to fit one value.
    putCachedText_(
      cache,
      cacheKey,
      JSON.stringify(shaped),
      SNS_DETAIL_CACHE_SECONDS
    );
  }
  return Object.assign({ ok: true, action: 'sns_detail' }, shaped);
}

function fetchGraphFollowersCount_(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      return null;
    }
    const data = JSON.parse(res.getContentText());
    return apiNumberOrNull_(data && data.followers_count);
  } catch (err) {
    return null;
  }
}

function fetchInstagramFollowers_(userId) {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return null;
  }
  return fetchGraphFollowersCount_(
    META_GRAPH_BASE +
      userId +
      '?fields=followers_count&access_token=' +
      encodeURIComponent(token)
  );
}

// The two inputs every Threads fetch needs, resolved the same way
// everywhere: the dedicated Threads token when set (falling back
// to the shared Meta token), and the authorized account's Threads
// user id from the OAuth flow (THREADS_USER_ID), with the constant
// as the pre-OAuth fallback.
function threadsToken_() {
  return (
    getScriptProperty_('META_THREADS_ACCESS_TOKEN') ||
    getScriptProperty_('META_ACCESS_TOKEN')
  );
}

function threadsUserId_() {
  return getScriptProperty_('THREADS_USER_ID') || SNS_THREADS_USER_ID;
}

// The one Threads insights request both the production fetch and
// debugThreadsFollowers make: the followers_count metric on the
// user's threads_insights edge. The URL carries no token; callers
// append '&access_token=...' themselves so the diagnostic can print
// the request with the token redacted.
function threadsFollowersInsightsUrl_(userId) {
  return THREADS_GRAPH_BASE + userId + '/threads_insights?metric=followers_count';
}

function fetchThreadsFollowers_() {
  const token = threadsToken_();
  if (!token) {
    return null;
  }
  const userId = threadsUserId_();
  try {
    const res = UrlFetchApp.fetch(
      threadsFollowersInsightsUrl_(userId) +
        '&access_token=' +
        encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      return null;
    }
    return parseThreadsFollowersCount_(JSON.parse(res.getContentText()));
  } catch (err) {
    return null;
  }
}

// Reads the followers count out of a threads_insights response for
// metric=followers_count, or null. followers_count does not exist as
// a field on the Threads user node — the profile request
// ?fields=followers_count fails with HTTP 500 "Tried accessing
// nonexisting field (followers_count)" (THApiException code 100,
// diagnosed in production on 2026-11-09) — so the count only comes
// from this insights edge. The metric is a current total, not a
// per-day flow: total_value.value wins when present, otherwise the
// newest values[] entry is the count. The values are never summed
// the way daily view counts are. Error bodies and any other shape
// read as null.
function parseThreadsFollowersCount_(data) {
  const totalValue = parseInsightsTotalValue_(data);
  if (totalValue !== null) {
    return totalValue;
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const values = entry && Array.isArray(entry.values) ? entry.values : null;
  if (!values) {
    return null;
  }
  for (let i = values.length - 1; i >= 0; i--) {
    const value = apiNumberOrNull_(values[i] && values[i].value);
    if (value !== null) {
      return value;
    }
  }
  return null;
}


export { META_GRAPH_BASE, SNS_DETAIL_VARIANT_SCOPES, SNS_FACEBOOK_PAGE_ID, SNS_INSTAGRAM_MAIN_ID, SNS_INSTAGRAM_SUB_ID, SNS_SNAPSHOT_PROPERTY, SNS_THREADS_USER_ID, SNS_TOKEN_REFRESH_WINDOW_MS, SNS_YOUTUBE_CHANNEL_ID, THREADS_GRAPH_BASE, apiNumberOrNull_, buildEmptySnsDetail_, buildSnsCountsResponse_, buildSnsDetailResponse_, compareSnsDetailOverviewViewsDesc_, fetchGraphFollowersCount_, fetchInstagramFollowers_, fetchThreadsFollowers_, getSnsCountsSnapshot_, normalizeSnsDetailScope_, parseThreadsFollowersCount_, shapeSnsDetail_, snsDetailCacheKey_, snsDetailOverviewTopItems_, snsNumberOrNull_, threadsFollowersInsightsUrl_, threadsToken_, threadsUserId_ };
