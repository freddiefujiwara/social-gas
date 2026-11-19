// Sheet-backed read side: sns_detail and the blog report served
// from the history spreadsheet, plus the payload cache helpers.

import { getScriptProperty_ } from './auth.js';
import { buildEmptySnsDetail_ } from './snsCounts.js';
import { SNS_THREADS_RECENT_POSTS_LIMIT } from './threadsDetail.js';
import { SNS_X_RECENT_POSTS_LIMIT, dedupeXDailyPosts_, xDailyDateKey_ } from './xDetail.js';
import { SNS_HISTORY_X_REACTIONS_COLUMNS, SNS_X_REACTIONS_TAB, SNS_X_RECENT_FOLLOWS_LIMIT, SNS_X_UNATTRIBUTED_LIMIT } from './xReactions.js';
import { SNS_DEMOGRAPHICS_TOP_LIMIT, SNS_RECENT_MEDIA_LIMIT, SNS_RECENT_VIDEO_LIMIT } from './instagramDetail.js';
import { SNS_DAY_MS, jstDateKey_ } from './instagramDaily.js';
import { BLOG_TOTALS_WINDOW_KEY, SNS_HISTORY_ACCOUNT_COLUMNS, SNS_HISTORY_BLOG_DAILY_COLUMNS, SNS_HISTORY_BLOG_PAGES_COLUMNS, SNS_HISTORY_BLOG_SCROLL_COLUMNS, SNS_HISTORY_BLOG_SOURCES_COLUMNS, SNS_HISTORY_BLOG_SPEED_COLUMNS, SNS_HISTORY_BLOG_TOTALS_COLUMNS, SNS_HISTORY_DAILY_COLUMNS, SNS_HISTORY_DEMOGRAPHICS_COLUMNS, SNS_HISTORY_MEDIA_COLUMNS, SNS_HISTORY_SHEET_ID_PROPERTY, SNS_HISTORY_THREADS_ACCOUNT_COLUMNS, SNS_HISTORY_THREADS_MEDIA_COLUMNS, SNS_HISTORY_X_DAILY_COLUMNS, SNS_HISTORY_X_MEDIA_COLUMNS, SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS, readSnsHistoryRows_, snsHistoryKeyCell_, summarizeSnsHistoryError_ } from './historyWrite.js';
import { BLOG_RENDER_METRIC, BLOG_RENDER_SLOW_METRIC, BLOG_SCROLL_DIMENSION, BLOG_SCROLL_LEVELS } from './blogHistory.js';
import { snsHistoryNumberCell_, snsHistoryTimestampCell_ } from './snsHistoryRead.js';

// --- Sheet-backed read side (stage 2) ---
// The /social screen's reads are assembled from the history
// spreadsheet, so rendering the screen never calls the Meta /
// GA4 / YouTube APIs: the hourly collection is the only API
// client, and the builders below only read sheets. Reads are
// cached in CacheService for an hour — the numbers only
// change at the hourly collection anyway, and the collection
// itself precomputes the payloads into the cache (see
// precomputeReadCaches_), so in the steady state a read never
// touches the sheet at all. A sheet that cannot be read
// degrades to the stored snapshot (SNS detail) or to an
// explicit "not collected yet" error (blog reports), never
// to a live API call made for the screen.

const SNS_DETAIL_CACHE_KEY = 'sns_detail_sheet_v1';
const SNS_DETAIL_CACHE_SECONDS = 3600;
const SNS_HISTORY_CACHE_KEY = 'sns_history_sheet_v1';
const SNS_HISTORY_CACHE_SECONDS = 3600;
const BLOG_REPORT_CACHE_KEY_PREFIX = 'blog_report_sheet_v1_';
const BLOG_REPORT_CACHE_SECONDS = 3600;

// The script cache, or null when CacheService is unavailable
// (unit tests, a bare editor run) — caching is always optional
// on the read side.
function sheetReadCache_() {
  try {
    return typeof CacheService !== 'undefined'
      ? CacheService.getScriptCache()
      : null;
  } catch (err) {
    return null;
  }
}

// CacheService caps one value at 100KB, and the assembled
// payloads can outgrow that (the SNS detail carries dozens of
// captions; the history grows to hundreds of rows). Payload
// texts are therefore stored split into chunks of
// PAYLOAD_CACHE_CHUNK_CHARS characters under "<key>#<index>",
// with the chunk count under "<key>#count" written last, so
// a reader can never assemble a half-written value: a missing
// or corrupt chunk simply reads as a cache miss, and the
// caller rebuilds from the sheet exactly as before. The chunk
// size stays well under the byte cap even for text that is
// three bytes per character in UTF-8. The chunk cap leaves
// room for the largest payload, the SNS history at its full
// 6600-row window (roughly 3.1M characters, ~103 chunks).
const PAYLOAD_CACHE_CHUNK_CHARS = 30000;
const PAYLOAD_CACHE_MAX_CHUNKS = 120;

function putCachedText_(cache, key, text, ttlSeconds) {
  if (!cache || typeof text !== 'string') {
    return false;
  }
  try {
    const chunks = [];
    for (
      let index = 0;
      index < text.length;
      index += PAYLOAD_CACHE_CHUNK_CHARS
    ) {
      chunks.push(text.slice(index, index + PAYLOAD_CACHE_CHUNK_CHARS));
    }
    if (chunks.length === 0) {
      chunks.push('');
    }
    if (chunks.length > PAYLOAD_CACHE_MAX_CHUNKS) {
      return false;
    }
    chunks.forEach((chunk, index) => {
      cache.put(key + '#' + index, chunk, ttlSeconds);
    });
    cache.put(key + '#count', String(chunks.length), ttlSeconds);
    return true;
  } catch (err) {
    return false;
  }
}

function getCachedText_(cache, key) {
  if (!cache) {
    return null;
  }
  try {
    const count = Number(cache.get(key + '#count'));
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > PAYLOAD_CACHE_MAX_CHUNKS
    ) {
      return null;
    }
    const parts = [];
    for (let index = 0; index < count; index++) {
      const part = cache.get(key + '#' + index);
      if (typeof part !== 'string') {
        return null;
      }
      parts.push(part);
    }
    return parts.join('');
  } catch (err) {
    return null;
  }
}

// Opens the history spreadsheet, or null when the property is
// unset. Throws only when the open itself fails; callers treat
// that as "sheet unavailable".
function openHistorySpreadsheet_() {
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return null;
  }
  return SpreadsheetApp.openById(sheetId);
}

// Reads one history tab as row objects keyed by column name.
// Returns null when the tab does not exist, [] when it exists
// but holds no data rows. Cell values keep the types Sheets
// hands back (numbers as numbers, timestamps as Dates or ISO
// strings, untouched cells as '').
function readHistoryTabObjects_(spreadsheet, name, columns) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    return null;
  }
  return readSnsHistoryRows_(sheet, columns).map((cells) => {
    const row = {};
    columns.forEach((column, index) => {
      row[column] = cells[index];
    });
    return row;
  });
}

// Reads only the last data row of a history tab, as a row
// object. Returns undefined when the tab does not exist, null
// when it holds no data rows. The account tab is append-only
// and chronological, so its last row is the newest collection
// — the one consumer (the SNS detail) needs nothing older,
// and reading the whole tab for it would grow by a row an
// hour forever.
function readHistoryTabLastRowObject_(spreadsheet, name, columns) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    return undefined;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }
  const cells = sheet
    .getRange(lastRow, 1, 1, columns.length)
    .getValues()[0];
  const row = {};
  columns.forEach((column, index) => {
    row[column] = cells[index];
  });
  return row;
}

// A text cell as a string, or null when it holds nothing.
function historyTextOrNull_(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

// A timestamp cell (a Date, or an ISO string Sheets left alone)
// as an ISO string, or null.
function historyTimestampOrNull_(value) {
  return snsHistoryTimestampCell_(value);
}

// Newest-first ordering for the stored timestamps
// (posted_at / published_at): parsed instants when both sides
// parse, the ISO strings themselves otherwise.
function compareTimestampDesc_(a, b) {
  const ta = Date.parse(a || '');
  const tb = Date.parse(b || '');
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    return tb - ta;
  }
  const x = String(a || '');
  const y = String(b || '');
  return x < y ? 1 : x > y ? -1 : 0;
}

// The account row with the newest collected_at, as
// { row, collected_at }, or null when no row carries a
// timestamp. The account tab is the one appended time series,
// so its newest row is the "current" state the SNS detail is
// built around.
function latestAccountRow_(rows) {
  let latest = null;
  (rows || []).forEach((row) => {
    const at = historyTimestampOrNull_(row.collected_at);
    if (at && (!latest || at > latest.collected_at)) {
      latest = { row, collected_at: at };
    }
  });
  return latest;
}

// Only the rows stamped with the newest collected_at of the
// set. The blog window tabs (blog_pages / blog_sources) are
// snapshots of a moving 28-day window: a row the newest
// collection did not refresh belongs to an older window, and
// its frozen views_28d must not leak into the ranking.
function latestBatchRows_(rows) {
  const list = rows || [];
  let max = null;
  list.forEach((row) => {
    const at = historyTimestampOrNull_(row.collected_at);
    if (at && (!max || at > max)) {
      max = at;
    }
  });
  if (!max) {
    return list.slice();
  }
  return list.filter(
    (row) => historyTimestampOrNull_(row.collected_at) === max
  );
}

// The sns_detail payload assembled from the history sheet, in
// exactly the snapshot's shape (buildEmptySnsDetail_ is the
// skeleton). Returns null when the sheet is unconfigured or
// holds no usable account row — the caller falls back to the
// stored snapshot then. What the sheet deliberately does not
// hold stays null: the per-collection error notes
// (insights_error, detail_error, media_error, ...) are the
// diagnostics of one fetch, not history, so a sheet-built
// detail never carries them; and daily_follows lists only the
// days that carry a value (days null on both sides were never
// written), so daily_follows_missing_days stays null too.
function buildSnsDetailFromSheet_(openedSpreadsheet) {
  const spreadsheet = openedSpreadsheet || openHistorySpreadsheet_();
  if (!spreadsheet) {
    return null;
  }
  // The detail is built around the newest account row only:
  // read just the tab's last row, and fall back to scanning
  // the whole tab only when that row carries no timestamp
  // (a leftover of a partial write, say).
  let latest = null;
  const lastAccountRow = readHistoryTabLastRowObject_(
    spreadsheet,
    'account',
    SNS_HISTORY_ACCOUNT_COLUMNS
  );
  if (lastAccountRow) {
    const at = historyTimestampOrNull_(lastAccountRow.collected_at);
    if (at) {
      latest = { row: lastAccountRow, collected_at: at };
    }
  }
  if (!latest) {
    const accountRows = readHistoryTabObjects_(
      spreadsheet,
      'account',
      SNS_HISTORY_ACCOUNT_COLUMNS
    );
    if (!accountRows || !accountRows.length) {
      return null;
    }
    latest = latestAccountRow_(accountRows);
    if (!latest) {
      return null;
    }
  }
  const account = latest.row;
  const num = snsHistoryNumberCell_;
  const detail = buildEmptySnsDetail_();
  detail.collected_at = latest.collected_at;

  detail.youtube.subscribers = num(account.youtube_subscribers);
  detail.youtube.total_views = num(account.yt_total_views);
  detail.youtube.video_count = num(account.yt_video_count);
  const videoRows = readHistoryTabObjects_(
    spreadsheet,
    'youtube_media',
    SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS
  );
  if (videoRows) {
    detail.youtube.recent_videos = videoRows
      .map((row) => {
        const id = historyTextOrNull_(row.video_id);
        return {
          id,
          title: historyTextOrNull_(row.title),
          published_at: historyTimestampOrNull_(row.published_at),
          views: num(row.views),
          likes: num(row.likes),
          comments: num(row.comments),
          duration_sec: num(row.duration_sec),
          // The sheet does not store the watch URL (stage 1's
          // call: it is derivable), so it is rebuilt from the
          // video id here.
          url: id ? 'https://www.youtube.com/watch?v=' + id : null,
        };
      })
      .filter((video) => video.id)
      .sort((a, b) => compareTimestampDesc_(a.published_at, b.published_at))
      .slice(0, SNS_RECENT_VIDEO_LIMIT);
  }

  const ig = detail.instagram;
  ig.freddiefujiwara = num(account.ig_followers);
  ig.anemone_cancer = num(account.ig_anemone_followers);
  ig.media_count = num(account.media_count);
  ig.views_30d = num(account.views_30d);
  ig.non_follower_pct = num(account.non_follower_pct);
  ig.reach_30d = num(account.reach_30d);
  ig.accounts_engaged_30d = num(account.accounts_engaged_30d);
  ig.interactions_30d = {
    total: num(account.interactions_total),
    likes: num(account.interactions_likes),
    comments: num(account.interactions_comments),
    shares: num(account.interactions_shares),
    saves: num(account.interactions_saves),
  };
  ig.profile_links_taps_30d = num(account.profile_links_taps_30d);
  ig.profile_links_taps_source = historyTextOrNull_(
    account.profile_links_taps_source
  );
  ig.follows_30d = num(account.follows_30d);
  ig.unfollows_30d = num(account.unfollows_30d);

  const dailyRows = readHistoryTabObjects_(
    spreadsheet,
    'daily',
    SNS_HISTORY_DAILY_COLUMNS
  );
  if (dailyRows) {
    ig.daily_follows = dailyRows
      .map((row) => ({
        date: snsHistoryKeyCell_(row.date),
        follows: num(row.follows),
        unfollows: num(row.unfollows),
      }))
      .filter((entry) => entry.date)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  const demoRows = readHistoryTabObjects_(
    spreadsheet,
    'ig_demographics',
    SNS_HISTORY_DEMOGRAPHICS_COLUMNS
  );
  if (demoRows) {
    const groups = { age_gender: [], city: [], country: [] };
    demoRows.forEach((row) => {
      const breakdown = historyTextOrNull_(row.breakdown);
      const key = historyTextOrNull_(row.key);
      const value = num(row.value);
      if (!breakdown || !key || value === null || !groups[breakdown]) {
        return;
      }
      groups[breakdown].push({ key, value });
    });
    const byValueDesc = (a, b) => b.value - a.value;
    ig.demographics = {
      age_gender: groups.age_gender.sort(byValueDesc),
      top_cities: groups.city
        .sort(byValueDesc)
        .slice(0, SNS_DEMOGRAPHICS_TOP_LIMIT),
      top_countries: groups.country
        .sort(byValueDesc)
        .slice(0, SNS_DEMOGRAPHICS_TOP_LIMIT),
    };
  }

  const mediaRows = readHistoryTabObjects_(
    spreadsheet,
    'media',
    SNS_HISTORY_MEDIA_COLUMNS
  );
  if (mediaRows) {
    ig.recent_media = mediaRows
      .map((row) => ({
        id: historyTextOrNull_(row.media_id),
        type: historyTextOrNull_(row.type),
        posted_at: historyTimestampOrNull_(row.posted_at),
        caption: historyTextOrNull_(row.caption),
        permalink: historyTextOrNull_(row.permalink),
        thumbnail_url: historyTextOrNull_(row.thumbnail_url),
        views: num(row.views),
        reach: num(row.reach),
        likes: num(row.likes),
        comments: num(row.comments),
        shares: num(row.shares),
        saves: num(row.saves),
        avg_watch_sec: num(row.avg_watch_sec),
        total_watch_sec: num(row.total_watch_sec),
        duration_sec: num(row.duration_sec),
      }))
      .filter((entry) => entry.id)
      .sort((a, b) => compareTimestampDesc_(a.posted_at, b.posted_at))
      .slice(0, SNS_RECENT_MEDIA_LIMIT);
  }

  const th = detail.threads;
  th.followers = num(account.threads_followers);
  const thAccountRows = readHistoryTabObjects_(
    spreadsheet,
    'threads_account',
    SNS_HISTORY_THREADS_ACCOUNT_COLUMNS
  );
  if (thAccountRows) {
    const byMetric = {};
    thAccountRows.forEach((row) => {
      const metric = historyTextOrNull_(row.metric);
      const value = num(row.value);
      if (metric && value !== null) {
        byMetric[metric] = value;
      }
    });
    const metricOrNull = (name) =>
      Object.prototype.hasOwnProperty.call(byMetric, name)
        ? byMetric[name]
        : null;
    th.views_30d = metricOrNull('views_30d');
    th.interactions_30d = {
      total: metricOrNull('interactions_total'),
      likes: metricOrNull('interactions_likes'),
      replies: metricOrNull('interactions_replies'),
      reposts: metricOrNull('interactions_reposts'),
      quotes: metricOrNull('interactions_quotes'),
    };
  }
  const postRows = readHistoryTabObjects_(
    spreadsheet,
    'threads_media',
    SNS_HISTORY_THREADS_MEDIA_COLUMNS
  );
  if (postRows) {
    th.recent_posts = postRows
      .map((row) => ({
        id: historyTextOrNull_(row.post_id),
        type: historyTextOrNull_(row.type),
        posted_at: historyTimestampOrNull_(row.posted_at),
        text: historyTextOrNull_(row.text),
        permalink: historyTextOrNull_(row.permalink),
        views: num(row.views),
        likes: num(row.likes),
        replies: num(row.replies),
        reposts: num(row.reposts),
        quotes: num(row.quotes),
      }))
      .filter((entry) => entry.id)
      .sort((a, b) => compareTimestampDesc_(a.posted_at, b.posted_at))
      .slice(0, SNS_THREADS_RECENT_POSTS_LIMIT);
  }

  // X: the follower count rides the account row; the posts ride
  // x_media. The username is not stored in the sheet (it never
  // changes and no screen needs it), so a sheet-built detail
  // leaves it null — the stored-snapshot fallback carries it.
  const x = detail.x;
  x.followers = num(account.x_followers);
  x.api_balance_usd = num(account.x_api_balance_usd);
  const xDailyRows = readHistoryTabObjects_(
    spreadsheet,
    'x_daily',
    SNS_HISTORY_X_DAILY_COLUMNS
  );
  if (xDailyRows) {
    // Stored dates are normalized on the way out as well: a
    // row written before the ingestion-side normalization (or
    // a date cell Sheets coerced into a Date) must still read
    // back as its calendar day, and two stored shapes of one
    // day must not surface as two entries.
    x.api_daily_posts = dedupeXDailyPosts_(
      xDailyRows.map((row) => ({
        date: xDailyDateKey_(row.date),
        tweets_consumed: num(row.tweets_consumed),
      }))
    );
  }
  const xRows = readHistoryTabObjects_(
    spreadsheet,
    'x_media',
    SNS_HISTORY_X_MEDIA_COLUMNS
  );
  if (xRows) {
    x.recent_posts = xRows
      .map((row) => {
        const id = historyTextOrNull_(row.post_id);
        return {
          id,
          posted_at: historyTimestampOrNull_(row.posted_at),
          text: historyTextOrNull_(row.text),
          url: id ? 'https://x.com/i/web/status/' + id : null,
          views: num(row.views),
          likes: num(row.likes),
          reposts: num(row.reposts),
          replies: num(row.replies),
        };
      })
      .filter((entry) => entry.id)
      .sort((a, b) => compareTimestampDesc_(a.posted_at, b.posted_at))
      .slice(0, SNS_X_RECENT_POSTS_LIMIT);
  }
  // The stored reaction facts join the detail here: likes and
  // reposts grouped by the post they reacted to, restricted to
  // the posts the detail actually carries (the tab can hold
  // facts for posts that already fell out of the recent
  // window — they stay stored but are not served); replies
  // and quotes, which no notify data can attribute to a post,
  // as one newest-first list of their own; plus the newest
  // follows as an account-level list. Each list is newest
  // first by the moment the reaction happened (acted_at for
  // replies / quotes, the first collection that saw them for
  // the rest).
  const reactionRows = readHistoryTabObjects_(
    spreadsheet,
    SNS_X_REACTIONS_TAB,
    SNS_HISTORY_X_REACTIONS_COLUMNS
  );
  if (reactionRows) {
    const servedPostIds = {};
    (x.recent_posts || []).forEach((post) => {
      if (post.id) {
        servedPostIds[post.id] = true;
      }
    });
    const byPost = {};
    const follows = [];
    const unattributed = [];
    reactionRows.forEach((row) => {
      const kind = historyTextOrNull_(row.kind);
      if (!kind) {
        return;
      }
      const entry = {
        kind,
        actor_name: historyTextOrNull_(row.actor_name),
        actor_username: historyTextOrNull_(row.actor_username),
        text: historyTextOrNull_(row.text),
        reaction_tweet_id: historyTextOrNull_(row.reaction_tweet_id),
        acted_at: historyTimestampOrNull_(row.acted_at),
        collected_at: historyTimestampOrNull_(row.collected_at),
      };
      if (kind === 'follow') {
        follows.push(entry);
        return;
      }
      if (kind === 'reply' || kind === 'quote') {
        unattributed.push(entry);
        return;
      }
      const tweetId = historyTextOrNull_(row.tweet_id);
      if (!tweetId || !servedPostIds[tweetId]) {
        return;
      }
      (byPost[tweetId] = byPost[tweetId] || []).push(entry);
    });
    Object.keys(byPost).forEach((tweetId) => {
      byPost[tweetId].sort((a, b) =>
        compareTimestampDesc_(
          a.acted_at || a.collected_at,
          b.acted_at || b.collected_at
        )
      );
    });
    x.reactions = byPost;
    x.unattributed_reactions = unattributed
      .sort((a, b) =>
        compareTimestampDesc_(
          a.acted_at || a.collected_at,
          b.acted_at || b.collected_at
        )
      )
      .slice(0, SNS_X_UNATTRIBUTED_LIMIT);
    x.recent_follows = follows
      .sort((a, b) => compareTimestampDesc_(a.collected_at, b.collected_at))
      .slice(0, SNS_X_RECENT_FOLLOWS_LIMIT);
  }
  return detail;
}

// The fixed report shapes the /social screen asks for, mapped
// to the sheet construction that answers them. Anything else
// (other dimensions, dimension filters, other metric sets) is
// not served: the endpoint no longer runs live GA4 reports
// for the screen, and an unanswerable shape must say so
// instead of inventing numbers.
function blogReportShape_(params) {
  if (!params || (params.filters && params.filters.length)) {
    return null;
  }
  const dims = params.dimensions || [];
  const metrics = params.metrics || [];
  if (dims.length === 0) {
    return metrics.join(',') === 'screenPageViews,activeUsers,sessions'
      ? 'totals'
      : null;
  }
  // The per-article read-depth report: pagePath x the
  // percent_scrolled custom dimension, counted with
  // eventCount, served from the blog_scroll tab in the same
  // GA4 shape the live report would return (one row per
  // article x level; a level with no count has no row).
  if (
    dims.length === 2 &&
    dims[0] === 'pagePath' &&
    dims[1] === BLOG_SCROLL_DIMENSION &&
    metrics.join(',') === 'eventCount'
  ) {
    return 'scroll';
  }
  // The per-article display-time report: pagePath x the
  // article_render metric pair (total render_ms, sample count),
  // served from the blog_speed tab in the same GA4 shape the
  // live report would return. The pair may carry the bridge's
  // slow-count metric as a third value (the day's
  // article_render_slow count); the pair alone keeps serving
  // the two values, so a screen that predates the slow counts
  // is unaffected.
  if (
    dims.length === 1 &&
    dims[0] === 'pagePath' &&
    (metrics.join(',') === BLOG_RENDER_METRIC + ',eventCount' ||
      metrics.join(',') ===
        BLOG_RENDER_METRIC + ',eventCount,' + BLOG_RENDER_SLOW_METRIC)
  ) {
    return 'speed';
  }
  if (dims.length !== 1 || metrics[0] !== 'screenPageViews') {
    return null;
  }
  if (dims[0] === 'date') {
    return metrics.length === 1 ? 'daily' : null;
  }
  if (dims[0] === 'pagePath') {
    return 'pages';
  }
  if (dims[0] === 'sessionDefaultChannelGroup') {
    return 'sources';
  }
  return null;
}

// A GA4-shaped report row: the screen's shaping helpers read
// only data.rows' dimensionValues[0] and metricValues[i], so
// the synthesized data carries exactly those.
function blogReportRow_(dimensionValue, metricValues) {
  return {
    dimensionValues:
      dimensionValue === null || dimensionValue === undefined
        ? []
        : [{ value: String(dimensionValue) }],
    metricValues: (metricValues || []).map((value) => ({
      value: String(value === null || value === undefined ? 0 : value),
    })),
  };
}

// Metric values for a row whose first metric is a view count.
// The per-page users/sessions of the old live pages report
// were never collected into the sheet, and the screen reads
// only metricValues[0] on those reports, so the remaining
// slots ride as 0.
function blogViewsMetricValues_(views, metricCount) {
  const values = [views === null || views === undefined ? 0 : views];
  while (values.length < Math.max(1, metricCount || 1)) {
    values.push(0);
  }
  return values;
}

function blogTotalsData_(spreadsheet) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_totals',
    SNS_HISTORY_BLOG_TOTALS_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const row = rows.filter(
    (entry) => historyTextOrNull_(entry.window) === BLOG_TOTALS_WINDOW_KEY
  )[0];
  if (!row) {
    return null;
  }
  return {
    rows: [
      blogReportRow_(null, [
        snsHistoryNumberCell_(row.views),
        snsHistoryNumberCell_(row.users),
        snsHistoryNumberCell_(row.sessions),
      ]),
    ],
    rowCount: 1,
  };
}

// A report date parameter ('today', '28daysAgo',
// 'YYYY-MM-DD') resolved to the JST calendar key the sheet
// keys days by, or null for anything else.
function resolveBlogDateKey_(value, nowMs) {
  const raw = String(value || '');
  if (raw === 'today') {
    return jstDateKey_(nowMs);
  }
  const daysAgo = /^(\d+)daysAgo$/.exec(raw);
  if (daysAgo) {
    return jstDateKey_(nowMs - Number(daysAgo[1]) * SNS_DAY_MS);
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function blogDailyData_(spreadsheet, startKey, endKey) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_daily',
    SNS_HISTORY_BLOG_DAILY_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const viewsByDate = {};
  rows.forEach((row) => {
    const date = snsHistoryKeyCell_(row.date);
    if (date && date >= startKey && date <= endKey) {
      viewsByDate[date] = snsHistoryNumberCell_(row.views);
    }
  });
  const dates = Object.keys(viewsByDate).sort();
  return {
    rows: dates.map((date) =>
      blogReportRow_(date.replace(/-/g, ''), [viewsByDate[date]])
    ),
    rowCount: dates.length,
  };
}

function blogPagesData_(spreadsheet, params) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_pages',
    SNS_HISTORY_BLOG_PAGES_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const entries = latestBatchRows_(rows)
    .map((row) => ({
      path: historyTextOrNull_(row.path),
      views: snsHistoryNumberCell_(row.views_28d),
    }))
    .filter((entry) => entry.path)
    .sort((a, b) => (b.views || 0) - (a.views || 0));
  return {
    rows: entries.map((entry) =>
      blogReportRow_(
        entry.path,
        blogViewsMetricValues_(entry.views, params.metrics.length)
      )
    ),
    rowCount: entries.length,
  };
}

// The blog_speed tab in the GA4 report shape, for yesterday
// (JST) only: one row per article, metricValues
// [total_render_ms, samples], slowest average first. Today's
// rows are a running total and never served, so the ranking
// always shows a finished day; articles with no recorded
// display yesterday are absent, exactly like the live report.
// The payload carries the served day as `date` next to the GA4
// rows, so the screen can label the ranking with the day it
// actually shows (the hour-cached payload can straddle
// midnight, when the day it holds is no longer yesterday).
// When the report asked for the slow-count metric as well
// (metricCount 3), each row carries the day's slow_count as
// the third value (0 when the tab holds none for it, e.g.
// rows collected before the column).
function blogSpeedData_(spreadsheet, metricCount) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_speed',
    SNS_HISTORY_BLOG_SPEED_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const date = jstDateKey_(Date.now() - SNS_DAY_MS);
  const entries = rows
    .filter((row) => snsHistoryKeyCell_(row.date) === date)
    .map((row) => ({
      path: historyTextOrNull_(row.path),
      total: snsHistoryNumberCell_(row.total_render_ms),
      samples: snsHistoryNumberCell_(row.samples),
      slow: snsHistoryNumberCell_(row.slow_count),
    }))
    .filter((entry) => entry.path && entry.samples)
    .sort((a, b) => b.total / b.samples - a.total / a.samples);
  const wantsSlow = (metricCount || 2) >= 3;
  return {
    rows: entries.map((entry) =>
      blogReportRow_(
        entry.path,
        wantsSlow
          ? [entry.total, entry.samples, entry.slow || 0]
          : [entry.total, entry.samples]
      )
    ),
    rowCount: entries.length,
    date,
  };
}

function blogSourcesData_(spreadsheet, params) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_sources',
    SNS_HISTORY_BLOG_SOURCES_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const entries = latestBatchRows_(rows)
    .map((row) => ({
      channel: historyTextOrNull_(row.channel),
      views: snsHistoryNumberCell_(row.views_28d),
    }))
    .filter((entry) => entry.channel)
    .sort((a, b) => (b.views || 0) - (a.views || 0));
  return {
    rows: entries.map((entry) =>
      blogReportRow_(
        entry.channel,
        blogViewsMetricValues_(entry.views, params.metrics.length)
      )
    ),
    rowCount: entries.length,
  };
}

// The blog_scroll tab in the GA4 report shape: one row per
// article x scroll level of the newest collection batch, as
// dimensionValues [path, percent] and metricValues [count].
// A level whose stored count is 0 (or empty) emits no row,
// exactly like the live report, which only returns the
// combinations that occurred. Articles are ordered by their
// 25% count descending (the widest reach first), levels
// ascending inside an article.
function blogScrollData_(spreadsheet) {
  const rows = readHistoryTabObjects_(
    spreadsheet,
    'blog_scroll',
    SNS_HISTORY_BLOG_SCROLL_COLUMNS
  );
  if (!rows) {
    return null;
  }
  const entries = latestBatchRows_(rows)
    .map((row) => {
      const entry = { path: historyTextOrNull_(row.path) };
      BLOG_SCROLL_LEVELS.forEach((mark) => {
        entry['scroll_' + mark] = snsHistoryNumberCell_(
          row['scroll_' + mark]
        );
      });
      return entry;
    })
    .filter(
      (entry) =>
        entry.path &&
        BLOG_SCROLL_LEVELS.some((mark) => entry['scroll_' + mark])
    )
    .sort((a, b) => (b.scroll_25 || 0) - (a.scroll_25 || 0));
  const reportRows = [];
  entries.forEach((entry) => {
    BLOG_SCROLL_LEVELS.forEach((mark) => {
      const count = entry['scroll_' + mark];
      if (!count) {
        return;
      }
      reportRows.push({
        dimensionValues: [
          { value: String(entry.path) },
          { value: String(mark) },
        ],
        metricValues: [{ value: String(count) }],
      });
    });
  });
  return { rows: reportRows, rowCount: reportRows.length };
}

// The report response for the screen's fixed blog reports,
// assembled from the history sheet. The envelope matches the
// old live bridge's exactly (including _share, which share
// link validation rides on), but data.rows are synthesized in
// the GA4 shape from the sheet tabs — the Data API is not
// called. Unsupported parameter combinations, and a sheet
// that holds no data yet, answer ok:false instead of falling
// back to a live call. The full (unsliced) payload is cached
// per shape for an hour — and the hourly collection
// precomputes the screen's shapes; the limit/offset slicing
// happens per request, after the cache.
function buildBlogReportResponse_(params, shareSession) {
  const shape = blogReportShape_(params);
  if (!shape) {
    return {
      ok: false,
      error:
        "unsupported report parameters: the /social screen's reports are served from the history sheet in fixed shapes only",
    };
  }
  let startKey = null;
  let endKey = null;
  if (shape === 'daily') {
    const nowMs = Date.now();
    startKey = resolveBlogDateKey_(params.startDate, nowMs);
    endKey = resolveBlogDateKey_(params.endDate, nowMs);
    if (!startKey || !endKey) {
      return {
        ok: false,
        error:
          'unsupported report date range: ' +
          params.startDate +
          '..' +
          params.endDate,
      };
    }
  }
  const cache = sheetReadCache_();
  const cacheKey =
    BLOG_REPORT_CACHE_KEY_PREFIX +
    shape +
    '_' +
    params.metrics.length +
    (shape === 'daily' ? '_' + startKey + '_' + endKey : '');
  let data = null;
  if (cache) {
    const hit = getCachedText_(cache, cacheKey);
    if (hit) {
      try {
        data = JSON.parse(hit);
      } catch (err) {
        data = null;
      }
    }
  }
  if (!data) {
    try {
      const spreadsheet = openHistorySpreadsheet_();
      if (spreadsheet) {
        if (shape === 'totals') {
          data = blogTotalsData_(spreadsheet);
        } else if (shape === 'daily') {
          data = blogDailyData_(spreadsheet, startKey, endKey);
        } else if (shape === 'pages') {
          data = blogPagesData_(spreadsheet, params);
        } else if (shape === 'sources') {
          data = blogSourcesData_(spreadsheet, params);
        } else if (shape === 'speed') {
          data = blogSpeedData_(spreadsheet, params.metrics.length);
        } else if (shape === 'scroll') {
          data = blogScrollData_(spreadsheet);
        }
      }
    } catch (err) {
      console.log(
        'Blog report from sheet failed: ' +
          summarizeSnsHistoryError_(
            err,
            getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY)
          )
      );
      data = null;
    }
    if (data && cache) {
      putCachedText_(
        cache,
        cacheKey,
        JSON.stringify(data),
        BLOG_REPORT_CACHE_SECONDS
      );
    }
  }
  if (!data) {
    return {
      ok: false,
      error: 'blog data has not been collected into the history sheet yet',
    };
  }
  const offset = params.offset || 0;
  const limited = Object.assign({}, data, {
    rows: data.rows.slice(offset, offset + params.limit),
  });
  return {
    ok: true,
    property: getScriptProperty_('GA4_PROPERTY_ID'),
    startDate: params.startDate,
    endDate: params.endDate,
    metrics: params.metrics,
    dimensions: params.dimensions,
    filters: params.filters,
    offset: params.offset,
    _share: shareSession ? { expires_at: shareSession.expires_at } : undefined,
    data: limited,
  };
}


export { BLOG_REPORT_CACHE_KEY_PREFIX, BLOG_REPORT_CACHE_SECONDS, SNS_DETAIL_CACHE_KEY, SNS_DETAIL_CACHE_SECONDS, SNS_HISTORY_CACHE_KEY, SNS_HISTORY_CACHE_SECONDS, blogDailyData_, blogPagesData_, blogReportShape_, blogScrollData_, blogSourcesData_, blogSpeedData_, blogTotalsData_, buildBlogReportResponse_, buildSnsDetailFromSheet_, compareTimestampDesc_, getCachedText_, historyTextOrNull_, historyTimestampOrNull_, latestAccountRow_, latestBatchRows_, openHistorySpreadsheet_, putCachedText_, readHistoryTabLastRowObject_, readHistoryTabObjects_, resolveBlogDateKey_, sheetReadCache_ };
