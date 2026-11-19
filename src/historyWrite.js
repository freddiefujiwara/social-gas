// SNS snapshot history (Google Sheets), write side: tab layouts,
// row builders and the upsert into the history spreadsheet.

import { getScriptProperty_ } from './auth.js';
import { snsNumberOrNull_ } from './snsCounts.js';
import { dedupeXDailyPosts_, xDailyDateKey_ } from './xDetail.js';

// --- SNS snapshot history (Google Sheets) ---
// The snapshot above is overwritten on every collection, so the
// trend would be lost. When the Script Property SNS_HISTORY_SHEET_ID
// names a spreadsheet, collectSnsCounts() also writes the snapshot
// to it, in two different shapes:
//   - "account" is the one time series: one appended row per
//     collection, the input of the /ga trend charts.
//   - Every post-shaped tab ("media", "threads_media",
//     "youtube_media"), the "daily" tab, the follower-demographics
//     tab ("ig_demographics") and the Threads account-metrics tab
//     ("threads_account") hold ONE row per key (media_id / post_id /
//     video_id / date / breakdown segment / metric) and are
//     upserted: the whole tab is read back, the fresh rows are
//     merged in by key — a fresh value wins, but a null in the
//     fresh fetch becomes an empty cell and never erases the
//     stored value — and the tab is rewritten as header + one row
//     per key. That also folds duplicates written by earlier
//     append-only collections into a single row per post on the
//     next run.
// The blog's GA4 numbers are written to the same spreadsheet by
// appendBlogHistory_ below ("blog_daily" / "blog_posts").
// All sheets are created when missing and get their header row
// when still empty. The sheet ID is only ever read from the Script
// Property, never written in code. Unset (the default) means no
// history is written at all, and a failed write never fails the
// collection itself: it is logged as one secret-free summary line
// instead.

const SNS_HISTORY_SHEET_ID_PROPERTY = 'SNS_HISTORY_SHEET_ID';
const SNS_HISTORY_ACCOUNT_COLUMNS = [
  'collected_at',
  'ig_followers',
  'ig_anemone_followers',
  'threads_followers',
  'youtube_subscribers',
  'total_followers',
  'media_count',
  'views_30d',
  'non_follower_pct',
  'reach_30d',
  'accounts_engaged_30d',
  'interactions_total',
  'interactions_likes',
  'interactions_comments',
  'interactions_shares',
  'interactions_saves',
  'profile_links_taps_30d',
  'profile_links_taps_source',
  'follows_30d',
  'unfollows_30d',
  'yt_total_views',
  'yt_video_count',
  // Appended last on purpose: the production "account" tab was
  // created with the columns above, and rows are read positionally
  // against this list, so a new column may only ever join at the
  // end. (buildSnsHistoryResponse_ additionally falls back to this
  // canonical position for a column the stored header predates.)
  'x_followers',
  // The X API credit balance (USD) from the tweet-gas sync,
  // appended after x_followers under the same rule.
  'x_api_balance_usd',
];
const SNS_HISTORY_MEDIA_COLUMNS = [
  'collected_at',
  'media_id',
  'posted_at',
  'type',
  'caption',
  'permalink',
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saves',
  'avg_watch_sec',
  'total_watch_sec',
  // Appended last on purpose, like x_followers on the account tab:
  // rows are read positionally against this list, so a new column
  // may only ever join at the end.
  'thumbnail_url',
  // The video's own length in seconds (reels / videos only),
  // appended after thumbnail_url under the same rule. The Graph
  // API exposes no duration field, so the collection reads it
  // from the MP4's mvhd box (see fetchMediaDurationSec_); a
  // stored value is carried over by later collections and never
  // re-fetched.
  'duration_sec',
];
// The upserted tabs. "daily" is keyed by its first column (date);
// the post tabs are keyed by their second column (the id), right
// after collected_at, mirroring "media".
const SNS_HISTORY_DAILY_COLUMNS = [
  'date',
  'follows',
  'unfollows',
  'collected_at',
];
const SNS_HISTORY_THREADS_MEDIA_COLUMNS = [
  'collected_at',
  'post_id',
  'posted_at',
  'type',
  'text',
  'permalink',
  'views',
  'likes',
  'replies',
  'reposts',
  'quotes',
];
const SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS = [
  'collected_at',
  'video_id',
  'published_at',
  'title',
  'views',
  'likes',
  'comments',
  'duration_sec',
];
// "x_media" mirrors the other post tabs (collected_at first, the
// post id as the upsert key). The post URL is not stored — it is
// derived from the id on the read side, like youtube_media.
const SNS_HISTORY_X_MEDIA_COLUMNS = [
  'collected_at',
  'post_id',
  'posted_at',
  'text',
  'views',
  'likes',
  'reposts',
  'replies',
];
// "x_daily" is keyed by its first column (date), like the
// Instagram "daily" tab: one row per calendar day of X API
// post consumption from the tweet-gas usage half.
const SNS_HISTORY_X_DAILY_COLUMNS = ['date', 'tweets_consumed', 'collected_at'];
// "ig_demographics" is keyed by its first column, the breakdown
// and segment joined ("age_gender|25-34/F", "city|Kawaguchi",
// "country|JP"), so the three follower_demographics breakdowns
// share one tab in the same 1-key-1-row shape.
const SNS_HISTORY_DEMOGRAPHICS_COLUMNS = [
  'breakdown_key',
  'breakdown',
  'key',
  'value',
  'collected_at',
];
// "threads_account" is keyed by metric name: the Threads account
// totals (30-day views and the interaction parts) that the
// "account" tab never carried.
const SNS_HISTORY_THREADS_ACCOUNT_COLUMNS = [
  'metric',
  'value',
  'collected_at',
];
// The blog tabs (written by appendBlogHistory_ from GA4, not from
// the SNS snapshot). "blog_daily" is keyed by date like "daily";
// "blog_posts" is keyed by the canonical article path.
const SNS_HISTORY_BLOG_DAILY_COLUMNS = [
  'date',
  'views',
  'users',
  'sessions',
  'avg_speed_ms',
  'music_plays',
  'collected_at',
];
const SNS_HISTORY_BLOG_POSTS_COLUMNS = [
  'path',
  'title',
  'views_28d',
  'collected_at',
];
// "blog_posts_daily" is keyed by date + canonical article
// path: one row per article per JST day, so the highlight
// feed can rank yesterday's articles (blog_posts only keeps
// the 28-day window). The fetch re-reads the last
// BLOG_POSTS_DAILY_WINDOW_DAYS days on every collection, so
// GA4's late-arriving revisions land without a repair step.
const SNS_HISTORY_BLOG_POSTS_DAILY_COLUMNS = [
  'date',
  'path',
  'title',
  'views',
  'collected_at',
];
const BLOG_POSTS_DAILY_WINDOW_DAYS = 8;
// Stage 2 (the read side serves the blog tab from the sheet)
// added three more blog tabs to the same workbook:
// "blog_pages" mirrors "blog_posts" but keeps EVERY page path,
// not just articles — the screen's top-pages ranking mixes
// articles with the app pages. "blog_totals" holds the window
// totals (the daily users cannot be summed into a 28-day user
// count, so the range totals are collected as their own row).
// "blog_sources" holds the traffic-channel split.
const SNS_HISTORY_BLOG_PAGES_COLUMNS = [
  'path',
  'title',
  'views_28d',
  'collected_at',
];
const SNS_HISTORY_BLOG_TOTALS_COLUMNS = [
  'window',
  'views',
  'users',
  'sessions',
  'collected_at',
];
// The single blog_totals row's key: the totals always cover the
// fixed 28daysAgo..today window the screen's totals report reads.
const BLOG_TOTALS_WINDOW_KEY = '28d';
const SNS_HISTORY_BLOG_SOURCES_COLUMNS = [
  'channel',
  'views_28d',
  'collected_at',
];
// "blog_scroll" (key: canonical article path) carries each
// article's read-depth counts over the window, from the blog's
// article_scroll events: how many displays reached each of the
// 25 / 50 / 75 / 100 percent scroll marks (the event's
// percent_scrolled custom dimension, pivoted into one column
// per level). A level an article never reached stays 0 in its
// row; articles with no article_scroll event at all have no
// row. Like blog_posts, every collection re-fetches the whole
// window, so the counts are the window's latest figures.
const SNS_HISTORY_BLOG_SCROLL_COLUMNS = [
  'path',
  'scroll_25',
  'scroll_50',
  'scroll_75',
  'scroll_100',
  'collected_at',
];
// "blog_speed" (key: JST date + canonical article path) carries
// each article's total article_render time and sample count for
// one calendar day, from the blog's article_render event
// (render_ms is the GA4 custom metric 「記事表示時間」). The
// average is total / samples; articles nobody displayed that
// day have no row. Every collection re-fetches the whole window
// day by day, so a day's rows are overwritten with GA4's latest
// figures while the day is in the window and stay as the final
// values once it ages out — the same contract as blog_daily.
// Before this daily shape, the tab held one cumulative row per
// article over the whole window; those rows are archived under
// BLOG_SPEED_CUMULATIVE_TAB on the first daily collection (see
// migrateBlogSpeedTab_) and are never mixed into the daily tab.
// slow_count counts the day's article_render_slow companion
// events for the article — the displays that took ten seconds
// or more — so an average inflated by one stall reads as such.
// The column rides last so the daily rows keep their cell
// positions; rows collected before it existed read it as empty.
const SNS_HISTORY_BLOG_SPEED_COLUMNS = [
  'date',
  'path',
  'title',
  'total_render_ms',
  'samples',
  'collected_at',
  'slow_count',
];
// The pre-daily blog_speed schema (one cumulative row per
// article, keyed by path alone), kept so the migration can
// recognize — and stop touching — an already-archived tab.
const SNS_HISTORY_BLOG_SPEED_CUMULATIVE_COLUMNS = [
  'path',
  'title',
  'total_render_ms',
  'samples',
  'collected_at',
];
const BLOG_SPEED_CUMULATIVE_TAB = 'blog_speed_cumulative';
// Numbers are written as numbers; anything else (null, undefined,
// non-finite) becomes an empty cell so the sheet stays sortable.
function snsHistoryNumCell_(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : '';
}

function snsHistoryTextCell_(value) {
  return value === null || value === undefined ? '' : String(value);
}

// One "account" row from a snapshot. total_followers is the
// combined follower total the screens chart — main Instagram +
// Threads + YouTube + X — summing only the values that are
// numbers, and stays empty when all four are null. Null values
// become empty cells throughout.
function buildSnsHistoryAccountRow_(snapshot) {
  const snap = snapshot || {};
  const youtube = snap.youtube || {};
  const instagram = snap.instagram || {};
  const threads = snap.threads || {};
  const x = snap.x || {};
  const interactions = instagram.interactions_30d || {};
  const totalParts = [
    snsNumberOrNull_(instagram.freddiefujiwara),
    snsNumberOrNull_(threads.followers),
    snsNumberOrNull_(youtube.subscribers),
    snsNumberOrNull_(x.followers),
  ].filter((value) => value !== null);
  return [
    snsHistoryTextCell_(snap.collected_at),
    snsHistoryNumCell_(instagram.freddiefujiwara),
    snsHistoryNumCell_(instagram.anemone_cancer),
    snsHistoryNumCell_(threads.followers),
    snsHistoryNumCell_(youtube.subscribers),
    totalParts.length
      ? totalParts.reduce((sum, value) => sum + value, 0)
      : '',
    snsHistoryNumCell_(instagram.media_count),
    snsHistoryNumCell_(instagram.views_30d),
    snsHistoryNumCell_(instagram.non_follower_pct),
    snsHistoryNumCell_(instagram.reach_30d),
    snsHistoryNumCell_(instagram.accounts_engaged_30d),
    snsHistoryNumCell_(interactions.total),
    snsHistoryNumCell_(interactions.likes),
    snsHistoryNumCell_(interactions.comments),
    snsHistoryNumCell_(interactions.shares),
    snsHistoryNumCell_(interactions.saves),
    snsHistoryNumCell_(instagram.profile_links_taps_30d),
    snsHistoryTextCell_(instagram.profile_links_taps_source),
    snsHistoryNumCell_(instagram.follows_30d),
    snsHistoryNumCell_(instagram.unfollows_30d),
    snsHistoryNumCell_(youtube.total_views),
    snsHistoryNumCell_(youtube.video_count),
    snsHistoryNumCell_(x.followers),
    snsHistoryNumCell_(x.api_balance_usd),
  ];
}

// One "media" row per entry of instagram.recent_media (an empty list
// when the media fetch failed and the snapshot carries null), each
// stamped with the snapshot's collected_at so a post's growth can be
// followed across collections.
function buildSnsHistoryMediaRows_(snapshot) {
  const snap = snapshot || {};
  const instagram = snap.instagram || {};
  const media = Array.isArray(instagram.recent_media)
    ? instagram.recent_media
    : [];
  return media.map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(snap.collected_at),
      snsHistoryTextCell_(item.id),
      snsHistoryTextCell_(item.posted_at),
      snsHistoryTextCell_(item.type),
      snsHistoryTextCell_(item.caption),
      snsHistoryTextCell_(item.permalink),
      snsHistoryNumCell_(item.views),
      snsHistoryNumCell_(item.reach),
      snsHistoryNumCell_(item.likes),
      snsHistoryNumCell_(item.comments),
      snsHistoryNumCell_(item.shares),
      snsHistoryNumCell_(item.saves),
      snsHistoryNumCell_(item.avg_watch_sec),
      snsHistoryNumCell_(item.total_watch_sec),
      snsHistoryTextCell_(item.thumbnail_url),
      snsHistoryNumCell_(item.duration_sec),
    ];
  });
}

// One "daily" row per day of instagram.daily_follows that carries
// at least one value. Days whose fetch came back null on both
// sides are skipped entirely: they record nothing, and (through
// the upsert) never erase a value an earlier collection stored
// for the same date.
function buildSnsHistoryDailyRows_(snapshot) {
  const snap = snapshot || {};
  const instagram = snap.instagram || {};
  const series = Array.isArray(instagram.daily_follows)
    ? instagram.daily_follows
    : [];
  return series
    .filter((entry) => {
      const item = entry || {};
      return (
        item.date !== null &&
        item.date !== undefined &&
        item.date !== '' &&
        (snsNumberOrNull_(item.follows) !== null ||
          snsNumberOrNull_(item.unfollows) !== null)
      );
    })
    .map((entry) => [
      snsHistoryTextCell_(entry.date),
      snsHistoryNumCell_(entry.follows),
      snsHistoryNumCell_(entry.unfollows),
      snsHistoryTextCell_(snap.collected_at),
    ]);
}

// One "threads_media" row per entry of threads.recent_posts (an
// empty list while Threads is unconfigured or its fetch failed
// and the snapshot carries null).
function buildSnsHistoryThreadsMediaRows_(snapshot) {
  const snap = snapshot || {};
  const threads = snap.threads || {};
  const posts = Array.isArray(threads.recent_posts) ? threads.recent_posts : [];
  return posts.map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(snap.collected_at),
      snsHistoryTextCell_(item.id),
      snsHistoryTextCell_(item.posted_at),
      snsHistoryTextCell_(item.type),
      snsHistoryTextCell_(item.text),
      snsHistoryTextCell_(item.permalink),
      snsHistoryNumCell_(item.views),
      snsHistoryNumCell_(item.likes),
      snsHistoryNumCell_(item.replies),
      snsHistoryNumCell_(item.reposts),
      snsHistoryNumCell_(item.quotes),
    ];
  });
}

// One "youtube_media" row per entry of youtube.recent_videos. The
// per-video numbers already ride every collection via the uploads
// playlist fetch (SNS_RECENT_VIDEO_LIMIT videos), so nothing extra
// is fetched for the history.
function buildSnsHistoryYouTubeMediaRows_(snapshot) {
  const snap = snapshot || {};
  const youtube = snap.youtube || {};
  const videos = Array.isArray(youtube.recent_videos)
    ? youtube.recent_videos
    : [];
  return videos.map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(snap.collected_at),
      snsHistoryTextCell_(item.id),
      snsHistoryTextCell_(item.published_at),
      snsHistoryTextCell_(item.title),
      snsHistoryNumCell_(item.views),
      snsHistoryNumCell_(item.likes),
      snsHistoryNumCell_(item.comments),
      snsHistoryNumCell_(item.duration_sec),
    ];
  });
}

// One "x_media" row per entry of x.recent_posts (an empty list
// while X is unconfigured or its fetch failed and the snapshot
// carries null).
function buildSnsHistoryXMediaRows_(snapshot) {
  const snap = snapshot || {};
  const x = snap.x || {};
  const posts = Array.isArray(x.recent_posts) ? x.recent_posts : [];
  return posts.map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(snap.collected_at),
      snsHistoryTextCell_(item.id),
      snsHistoryTextCell_(item.posted_at),
      snsHistoryTextCell_(item.text),
      snsHistoryNumCell_(item.views),
      snsHistoryNumCell_(item.likes),
      snsHistoryNumCell_(item.reposts),
      snsHistoryNumCell_(item.replies),
    ];
  });
}

// One "x_daily" row per entry of x.api_daily_posts: the X API
// post consumption of one calendar day, keyed by its date like
// the Instagram "daily" tab. The date is normalized through
// xDailyDateKey_ on the way in, so a snapshot whose days still
// carry full ISO timestamps keys them by their calendar day.
// A failed daily fetch (the snapshot carries null) contributes
// no rows, so stored days are never erased by an outage; a day
// whose count the API did not report (tweets_consumed null)
// still records its date with an empty count cell.
function buildSnsHistoryXDailyRows_(snapshot) {
  const snap = snapshot || {};
  const x = snap.x || {};
  const days = Array.isArray(x.api_daily_posts) ? x.api_daily_posts : [];
  return dedupeXDailyPosts_(
    days.map((entry) => {
      const item = entry || {};
      return {
        date: xDailyDateKey_(item.date),
        tweets_consumed: item.tweets_consumed,
      };
    })
  ).map((entry) => [
    snsHistoryTextCell_(entry.date),
    snsHistoryNumCell_(entry.tweets_consumed),
    snsHistoryTextCell_(snap.collected_at),
  ]);
}

// One "ig_demographics" row per (breakdown, segment) of
// instagram.demographics — the age x gender pyramid segments and
// the top cities / countries the "account" tab has no shape for.
// A breakdown the fresh fetch failed (null) contributes no rows,
// so its stored segments are never erased by an outage; a segment
// that drops out of a later top list simply keeps its last value.
function buildSnsHistoryDemographicsRows_(snapshot) {
  const snap = snapshot || {};
  const instagram = snap.instagram || {};
  const demographics = instagram.demographics || {};
  const breakdowns = [
    ['age_gender', demographics.age_gender],
    ['city', demographics.top_cities],
    ['country', demographics.top_countries],
  ];
  const rows = [];
  breakdowns.forEach((pair) => {
    const name = pair[0];
    const segments = pair[1];
    if (!Array.isArray(segments)) {
      return;
    }
    segments.forEach((segment) => {
      const item = segment || {};
      const key = snsHistoryTextCell_(item.key);
      if (!key) {
        return;
      }
      rows.push([
        name + '|' + key,
        name,
        key,
        snsHistoryNumCell_(item.value),
        snsHistoryTextCell_(snap.collected_at),
      ]);
    });
  });
  return rows;
}

// One "threads_account" row per Threads account metric — the
// 30-day views and interaction totals the snapshot carries but no
// tab held. Only metrics that came back as numbers produce a row
// (the same rule as "daily"), so a failed metric never erases its
// stored value through the upsert.
function buildSnsHistoryThreadsAccountRows_(snapshot) {
  const snap = snapshot || {};
  const threads = snap.threads || {};
  const interactions = threads.interactions_30d || {};
  const candidates = [
    ['views_30d', threads.views_30d],
    ['interactions_total', interactions.total],
    ['interactions_likes', interactions.likes],
    ['interactions_replies', interactions.replies],
    ['interactions_reposts', interactions.reposts],
    ['interactions_quotes', interactions.quotes],
  ];
  return candidates
    .filter((pair) => snsNumberOrNull_(pair[1]) !== null)
    .map((pair) => [
      pair[0],
      snsHistoryNumCell_(pair[1]),
      snsHistoryTextCell_(snap.collected_at),
    ]);
}

// Returns the named sheet, creating it when missing, and writes the
// header row only when the sheet is still empty (an existing header
// — or any existing data — is left untouched).
function ensureSnsHistorySheet_(spreadsheet, name, columns) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
  }
  return sheet;
}

// Normalizes a key cell read back from a sheet into the string the
// upsert matches on. Sheets coerces a "YYYY-MM-DD" string into a
// Date, so a stored daily key is formatted back in Asia/Tokyo —
// the timezone every daily key is written in — by shifting the
// instant nine hours ahead and reading the UTC fields. A string
// key that still carries a full ISO timestamp (the shape
// tweet-gas once sent for the x_daily dates) is cut back to its
// leading calendar day, so a row stored in that shape merges
// with — instead of duplicating — the day's normalized row.
// Non-date keys (post ids, metric names) never match that
// prefix shape and pass through untouched.
function snsHistoryKeyCell_(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return '';
    }
    const jst = new Date(value.getTime() + 9 * 60 * 60 * 1000);
    const pad = (num) => String(num).padStart(2, '0');
    return (
      jst.getUTCFullYear() +
      '-' +
      pad(jst.getUTCMonth() + 1) +
      '-' +
      pad(jst.getUTCDate())
    );
  }
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value).trim();
  const timestamp = /^(\d{4}-\d{2}-\d{2})T/.exec(text);
  return timestamp ? timestamp[1] : text;
}

// Reads the data rows (everything under the header) of a history
// sheet, padded out to the column count. Row values keep the types
// Sheets hands back (numbers as numbers, timestamps as Dates).
function readSnsHistoryRows_(sheet, columns) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  return sheet
    .getRange(2, 1, lastRow - 1, columns.length)
    .getValues()
    .map((row) => {
      const cells = (row || []).slice(0, columns.length);
      while (cells.length < columns.length) {
        cells.push('');
      }
      return cells;
    });
}

// Merges fresh rows into the stored ones by key: one output row
// per key, in first-seen order, where a fresh row's non-empty
// cells win and its empty cells (the nulls of the fresh fetch)
// leave the stored values untouched. Rows without a key are
// dropped on both sides. The key is one column index, or an
// array of indexes for the tabs keyed by more than one column
// (blog_speed is keyed by date + path); a row missing any part
// of a composite key is dropped the same way.
function mergeSnsHistoryRows_(existingRows, newRows, keyIndex) {
  const keyIndexes = Array.isArray(keyIndex) ? keyIndex : [keyIndex];
  const merged = [];
  const indexByKey = {};
  const absorb = (row) => {
    const parts = keyIndexes.map((index) => snsHistoryKeyCell_(row[index]));
    if (parts.some((part) => !part)) {
      return;
    }
    const key = parts.join('\u0001');
    if (!(key in indexByKey)) {
      indexByKey[key] = merged.length;
      merged.push(row.slice());
      return;
    }
    const target = merged[indexByKey[key]];
    row.forEach((cell, index) => {
      if (cell !== '' && cell !== null && cell !== undefined) {
        target[index] = cell;
      }
    });
  };
  (existingRows || []).forEach(absorb);
  (newRows || []).forEach(absorb);
  return merged;
}

// Upserts the fresh rows of one key-keyed history tab: ensures the
// sheet, merges stored + fresh rows by key, writes the merged data
// rows under the (untouched) header, and deletes any surplus rows
// the append-only era left behind, so the tab always holds the
// header plus exactly one row per key.
function upsertSnsHistorySheet_(spreadsheet, name, columns, keyIndex, newRows) {
  const sheet = ensureSnsHistorySheet_(spreadsheet, name, columns);
  const merged = mergeSnsHistoryRows_(
    readSnsHistoryRows_(sheet, columns),
    newRows,
    keyIndex
  );
  if (merged.length) {
    sheet.getRange(2, 1, merged.length, columns.length).setValues(merged);
  }
  const surplus = sheet.getLastRow() - (merged.length + 1);
  if (surplus > 0) {
    sheet.deleteRows(merged.length + 2, surplus);
  }
  return sheet;
}

// Compact, secret-free summary of a Sheets failure for the log. The
// configured sheet ID is scrubbed first, in case a Drive error
// message quotes it.
// The one-line error-to-text idiom shared by the error summarizers.
function errorMessageText_(err) {
  return String((err && err.message) || err || 'unknown error');
}

function summarizeSnsHistoryError_(err, sheetId) {
  let message = errorMessageText_(err);
  if (sheetId) {
    message = message.split(sheetId).join('[sheet]');
  }
  return message.slice(0, 200);
}

// Writes the snapshot to the history spreadsheet. No-op unless
// SNS_HISTORY_SHEET_ID is set (SpreadsheetApp is not even touched
// then). The "account" tab is appended to, one row per collection;
// every other tab is upserted by its key. Never throws: any
// failure is logged as one line and the collection that produced
// the snapshot still counts as a success.
function appendSnsHistory_(snapshot) {
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return;
  }
  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    const accountSheet = ensureSnsHistorySheet_(
      spreadsheet,
      'account',
      SNS_HISTORY_ACCOUNT_COLUMNS
    );
    accountSheet.appendRow(buildSnsHistoryAccountRow_(snapshot));
    upsertSnsHistorySheet_(
      spreadsheet,
      'media',
      SNS_HISTORY_MEDIA_COLUMNS,
      1,
      buildSnsHistoryMediaRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'daily',
      SNS_HISTORY_DAILY_COLUMNS,
      0,
      buildSnsHistoryDailyRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'threads_media',
      SNS_HISTORY_THREADS_MEDIA_COLUMNS,
      1,
      buildSnsHistoryThreadsMediaRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'youtube_media',
      SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS,
      1,
      buildSnsHistoryYouTubeMediaRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'x_media',
      SNS_HISTORY_X_MEDIA_COLUMNS,
      1,
      buildSnsHistoryXMediaRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'x_daily',
      SNS_HISTORY_X_DAILY_COLUMNS,
      0,
      buildSnsHistoryXDailyRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'ig_demographics',
      SNS_HISTORY_DEMOGRAPHICS_COLUMNS,
      0,
      buildSnsHistoryDemographicsRows_(snapshot)
    );
    upsertSnsHistorySheet_(
      spreadsheet,
      'threads_account',
      SNS_HISTORY_THREADS_ACCOUNT_COLUMNS,
      0,
      buildSnsHistoryThreadsAccountRows_(snapshot)
    );
  } catch (err) {
    console.log(
      'SNS history append failed: ' + summarizeSnsHistoryError_(err, sheetId)
    );
  }
}


export { errorMessageText_, BLOG_POSTS_DAILY_WINDOW_DAYS, BLOG_SPEED_CUMULATIVE_TAB, BLOG_TOTALS_WINDOW_KEY, SNS_HISTORY_ACCOUNT_COLUMNS, SNS_HISTORY_BLOG_DAILY_COLUMNS, SNS_HISTORY_BLOG_PAGES_COLUMNS, SNS_HISTORY_BLOG_POSTS_COLUMNS, SNS_HISTORY_BLOG_POSTS_DAILY_COLUMNS, SNS_HISTORY_BLOG_SCROLL_COLUMNS, SNS_HISTORY_BLOG_SOURCES_COLUMNS, SNS_HISTORY_BLOG_SPEED_COLUMNS, SNS_HISTORY_BLOG_SPEED_CUMULATIVE_COLUMNS, SNS_HISTORY_BLOG_TOTALS_COLUMNS, SNS_HISTORY_DAILY_COLUMNS, SNS_HISTORY_DEMOGRAPHICS_COLUMNS, SNS_HISTORY_MEDIA_COLUMNS, SNS_HISTORY_SHEET_ID_PROPERTY, SNS_HISTORY_THREADS_ACCOUNT_COLUMNS, SNS_HISTORY_THREADS_MEDIA_COLUMNS, SNS_HISTORY_X_DAILY_COLUMNS, SNS_HISTORY_X_MEDIA_COLUMNS, SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS, appendSnsHistory_, buildSnsHistoryAccountRow_, buildSnsHistoryDailyRows_, buildSnsHistoryDemographicsRows_, buildSnsHistoryMediaRows_, buildSnsHistoryThreadsAccountRows_, buildSnsHistoryThreadsMediaRows_, buildSnsHistoryXDailyRows_, buildSnsHistoryXMediaRows_, buildSnsHistoryYouTubeMediaRows_, ensureSnsHistorySheet_, mergeSnsHistoryRows_, readSnsHistoryRows_, snsHistoryKeyCell_, snsHistoryNumCell_, snsHistoryTextCell_, summarizeSnsHistoryError_, upsertSnsHistorySheet_ };
