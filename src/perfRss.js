// Performance highlights RSS (action=perf_rss) for /reader.

import { getScriptProperty_ } from './auth.js';
import { snsNumberOrNull_ } from './snsCounts.js';
import { SNS_DAY_MS, jstDateKey_ } from './instagramDaily.js';
import { SNS_HISTORY_ACCOUNT_COLUMNS, SNS_HISTORY_BLOG_DAILY_COLUMNS, SNS_HISTORY_BLOG_POSTS_COLUMNS, SNS_HISTORY_BLOG_POSTS_DAILY_COLUMNS, SNS_HISTORY_DAILY_COLUMNS, SNS_HISTORY_MEDIA_COLUMNS, SNS_HISTORY_SHEET_ID_PROPERTY, SNS_HISTORY_THREADS_MEDIA_COLUMNS, SNS_HISTORY_X_MEDIA_COLUMNS, SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS, snsHistoryKeyCell_, summarizeSnsHistoryError_ } from './historyWrite.js';
import { historyTextOrNull_, historyTimestampOrNull_, openHistorySpreadsheet_, readHistoryTabObjects_ } from './sheetRead.js';
import { jsonOut_ } from './ga4.js';
import { COMMENTS_RSS_TOKEN_PROPERTY } from './comments.js';
import { escapeXmlText_, xmlOut_ } from './commentsRss.js';

// --- Performance highlights RSS (action=perf_rss) ---
// GET /exec?action=perf_rss&token=... returns the SNS / blog
// performance highlights as RSS for /reader: one item per
// delivery slot — morning 06:00, noon 12:30, evening 20:30
// (Asia/Tokyo). The feed is computed on the fly from the
// history tabs (account / blog_daily / blog_posts / media);
// nothing is stored for it and no platform API is called.
// Each item reads the newest account snapshot at or before
// its slot, so an item's figures never change once its slot
// has passed, and the guid (date + slot) is stable across
// fetches — the same item can never reappear as new. The
// token is the reader-facing RSS token shared with the
// comments feed (COMMENTS_RSS_TOKEN): the items carry the
// real figures, so the feed refuses every request while the
// property is unset or the token mismatches.

const PERF_RSS_SLOTS = [
  { key: 'morning', label: '朝', time: '06:00:00' },
  { key: 'noon', label: '昼', time: '12:30:00' },
  { key: 'evening', label: '夜', time: '20:30:00' },
];
// Items per RSS response: five days of slots.
const PERF_RSS_ITEM_COUNT = 15;
const PERF_RSS_CHANNEL = {
  title: 'SNSハイライト（@freddiefujiwara）',
  link: 'https://freddiefujiwara.com/social/',
  description:
    'SNSとブログのパフォーマンスのハイライト（朝6:00・昼12:30・夜20:30）',
};

// The delivery slots at or before nowMs, newest first, as
// { key, label, dateKey, atMs }. Stepping back whole JST days
// is exact because JST never shifts (see jstDateKey_).
function perfRssSlots_(nowMs, count) {
  const slots = [];
  const todayStartMs = Date.parse(jstDateKey_(nowMs) + 'T00:00:00+09:00');
  for (let dayOffset = 0; slots.length < count && dayOffset < 40; dayOffset++) {
    const dateKey = jstDateKey_(todayStartMs - dayOffset * SNS_DAY_MS);
    PERF_RSS_SLOTS.slice()
      .reverse()
      .forEach((slot) => {
        const atMs = Date.parse(dateKey + 'T' + slot.time + '+09:00');
        if (atMs <= nowMs && slots.length < count) {
          slots.push({ key: slot.key, label: slot.label, dateKey, atMs });
        }
      });
  }
  return slots;
}

// The account state at an instant: the newest stored row at or
// before atMs, normalized to the figures a highlight carries.
// Null when no collection predates the instant.
function perfSnapshotAt_(accountRows, atMs) {
  let best = null;
  let bestAt = -Infinity;
  (accountRows || []).forEach((row) => {
    const iso = historyTimestampOrNull_(row && row.collected_at);
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at) || at > atMs || at <= bestAt) {
      return;
    }
    bestAt = at;
    best = row;
  });
  if (!best) {
    return null;
  }
  return {
    total: snsNumberOrNull_(best.total_followers),
    ig: snsNumberOrNull_(best.ig_followers),
    threads: snsNumberOrNull_(best.threads_followers),
    youtube: snsNumberOrNull_(best.youtube_subscribers),
    x: snsNumberOrNull_(best.x_followers),
    views30d: snsNumberOrNull_(best.views_30d),
    balance: snsNumberOrNull_(best.x_api_balance_usd),
  };
}

// An integer with thousands separators, sign kept.
function perfFormatInt_(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// A delta against a base value, signed: "+12" / "-3" / "0".
// Empty when either side is missing.
function perfDeltaText_(value, base) {
  if (typeof value !== 'number' || typeof base !== 'number') {
    return '';
  }
  const delta = value - base;
  return (delta > 0 ? '+' : '') + perfFormatInt_(delta);
}

// The newest completed JST day in blog_daily, as
// { dateKey, views }: today's row is still a running total,
// so the day an item names is always a finished one.
function perfBlogDay_(blogDailyRows, slotDateKey) {
  let best = null;
  (blogDailyRows || []).forEach((row) => {
    const dateKey = snsHistoryKeyCell_(row && row.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || dateKey >= slotDateKey) {
      return;
    }
    const views = snsNumberOrNull_(row.views);
    if (typeof views !== 'number') {
      return;
    }
    if (!best || dateKey > best.dateKey) {
      best = { dateKey, views };
    }
  });
  return best;
}

// The blog day as a compact segment: ブログ(11/16)48回.
function perfBlogSegment_(blogDay) {
  if (!blogDay) {
    return '';
  }
  const parts = blogDay.dateKey.split('-');
  return (
    'ブログ(' +
    Number(parts[1]) +
    '/' +
    Number(parts[2]) +
    ')' +
    perfFormatInt_(blogDay.views) +
    '回'
  );
}

// The blog day as a full detail line.
function perfBlogLine_(blogDay) {
  if (!blogDay) {
    return '';
  }
  const parts = blogDay.dateKey.split('-');
  return (
    'ブログ（' +
    Number(parts[1]) +
    '月' +
    Number(parts[2]) +
    '日）: 表示 ' +
    perfFormatInt_(blogDay.views) +
    '回'
  );
}

// blog_posts rows whose GA4 page title never got past the
// SPA shell carry the site title instead of the article's;
// they say nothing about which article was read, so the
// most-read pick skips them.
const PERF_BLOG_GENERIC_TITLE = '藤原史和｜川口を歩くQAエンジニア';

// The most-read article of the stored 28-day window, or null.
function perfTopBlogPost_(blogPostRows) {
  let best = null;
  (blogPostRows || []).forEach((row) => {
    const title = historyTextOrNull_(row && row.title);
    const views = snsNumberOrNull_(row && row.views_28d);
    if (!title || title === PERF_BLOG_GENERIC_TITLE || typeof views !== 'number') {
      return;
    }
    if (!best || views > best.views) {
      best = { title, views };
    }
  });
  return best;
}

// The Instagram posts published inside (fromMs, toMs], as
// one-line captions, oldest first, at most three.
function perfNewPostCaptions_(mediaRows, fromMs, toMs) {
  const fresh = [];
  (mediaRows || []).forEach((row) => {
    const iso = historyTimestampOrNull_(row && row.posted_at);
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at) || at <= fromMs || at > toMs) {
      return;
    }
    const caption = historyTextOrNull_(row.caption) || '';
    const firstLine = caption.split(/\r?\n/)[0].trim();
    fresh.push({ at, text: firstLine.slice(0, 40) || '（キャプションなし）' });
  });
  return fresh
    .sort((a, b) => a.at - b.at)
    .slice(0, 3)
    .map((post) => post.text);
}

// The character budget of one item's summary. /reader's
// article cards clamp the summary to three lines, which at
// phone width holds roughly 110 characters; the segments
// below join in priority order and the lower ones drop off
// when the budget runs out, so the headline figures always
// fit on the card.
const PERF_RSS_SUMMARY_CHARS = 110;

// A "(+22)" style suffix for a delta, or '' when the delta
// is missing or zero.
function perfDeltaSuffix_(value, base) {
  const delta = perfDeltaText_(value, base);
  if (!delta || delta === '0') {
    return '';
  }
  return '(' + delta + ')';
}

// A signed delta for prose: +18 / -3 / ±0.
function perfSignedText_(delta) {
  if (typeof delta !== 'number' || !isFinite(delta)) {
    return '';
  }
  if (delta > 0) {
    return '+' + perfFormatInt_(delta);
  }
  if (delta < 0) {
    return '-' + perfFormatInt_(-delta);
  }
  return '±0';
}

// The first line of a caption or post text, truncated so a
// section line stays readable.
function perfFirstLine_(text, maxChars) {
  const first = String(text == null ? '' : text).split('\n')[0].trim();
  const limit = maxChars || 30;
  return first.length > limit ? first.slice(0, limit) + '…' : first;
}

// Posts whose posted_at (or published_at) falls inside
// [fromMs, toMs).
function perfPostsInWindow_(rows, fromMs, toMs) {
  return (rows || []).filter((row) => {
    const ms = Date.parse(row && (row.posted_at || row.published_at));
    return isFinite(ms) && ms >= fromMs && ms < toMs;
  });
}

function perfByViewsDesc_(rows) {
  return rows
    .slice()
    .sort(
      (a, b) =>
        (snsNumberOrNull_(b.views) || 0) - (snsNumberOrNull_(a.views) || 0)
    );
}

// Per-channel sections for "yesterday": the last completed
// JST day relative to the slot. Each section carries the
// follower movement, the day's posts and the signals that
// feed the next action — the best save rate on Instagram,
// the most-viewed post on Threads and X, the X credit burn.
// A channel with nothing known at all is skipped.
function perfChannelSections_(slot, data) {
  const endMs = Date.parse(slot.dateKey + 'T00:00:00+09:00');
  const startMs = endMs - SNS_DAY_MS;
  const dateKey = jstDateKey_(startMs);
  const dateParts = dateKey.split('-');
  const label =
    '昨日（' + Number(dateParts[1]) + '月' + Number(dateParts[2]) + '日）';
  const endSnap = perfSnapshotAt_(data.accountRows, endMs);
  const startSnap = perfSnapshotAt_(data.accountRows, startMs);
  const followerDelta = (pick) => {
    if (!endSnap || !startSnap) {
      return '';
    }
    const after = pick(endSnap);
    const before = pick(startSnap);
    if (typeof after !== 'number' || typeof before !== 'number') {
      return '';
    }
    return perfSignedText_(after - before);
  };
  const sections = [];
  const addSection = (name, lines) => {
    if (lines.length) {
      sections.push('【' + name + ' ' + label + '】');
      lines.forEach((line) => sections.push(line));
    }
  };

  // Instagram.
  const igLines = [];
  const igDelta = followerDelta((snap) => snap.ig);
  if (igDelta) {
    let line = 'フォロワー ' + igDelta;
    const dailyRow = (data.dailyRows || []).find(
      (row) => snsHistoryKeyCell_(row && row.date) === dateKey
    );
    const follows = dailyRow ? snsNumberOrNull_(dailyRow.follows) : null;
    const unfollows = dailyRow ? snsNumberOrNull_(dailyRow.unfollows) : null;
    if (typeof follows === 'number' && typeof unfollows === 'number') {
      line +=
        '（フォロー ' +
        perfFormatInt_(follows) +
        ' / 解除 ' +
        perfFormatInt_(unfollows) +
        '）';
    }
    igLines.push(line);
  }
  const igPosts = perfByViewsDesc_(
    perfPostsInWindow_(data.mediaRows, startMs, endMs)
  );
  if (igPosts.length) {
    igLines.push('投稿 ' + igPosts.length + '件（再生順）');
    igPosts.slice(0, 3).forEach((row) => {
      let line =
        '・' +
        perfFirstLine_(row.caption, 30) +
        ': 再生' +
        perfFormatInt_(snsNumberOrNull_(row.views) || 0) +
        '回';
      const saves = snsNumberOrNull_(row.saves);
      if (typeof saves === 'number') {
        line += ' / 保存' + perfFormatInt_(saves);
      }
      const shares = snsNumberOrNull_(row.shares);
      if (typeof shares === 'number') {
        line += ' / シェア' + perfFormatInt_(shares);
      }
      const avg = snsNumberOrNull_(row.avg_watch_sec);
      const dur = snsNumberOrNull_(row.duration_sec);
      if (typeof avg === 'number' && typeof dur === 'number' && dur > 0) {
        line += ' / 視聴率' + Math.round((avg / dur) * 100) + '%';
      }
      igLines.push(line);
    });
    let best = null;
    igPosts.forEach((row) => {
      const views = snsNumberOrNull_(row.views);
      const saves = snsNumberOrNull_(row.saves);
      if (typeof views === 'number' && views > 0 && typeof saves === 'number') {
        const rate = saves / views;
        if (!best || rate > best.rate) {
          best = { rate, row };
        }
      }
    });
    if (best) {
      igLines.push(
        '保存率トップ: ' +
          perfFirstLine_(best.row.caption, 30) +
          '（' +
          (best.rate * 100).toFixed(1) +
          '%）'
      );
    }
  } else if (igLines.length) {
    igLines.push('投稿なし');
  }
  addSection('Instagram', igLines);

  // Threads.
  const thLines = [];
  const thDelta = followerDelta((snap) => snap.threads);
  if (thDelta) {
    thLines.push('フォロワー ' + thDelta);
  }
  const thPosts = perfByViewsDesc_(
    perfPostsInWindow_(data.threadsMediaRows, startMs, endMs)
  );
  if (thPosts.length) {
    const top = thPosts[0];
    thLines.push(
      '投稿 ' +
        thPosts.length +
        '件 / 最多表示: ' +
        perfFirstLine_(top.text, 30) +
        '（表示' +
        perfFormatInt_(snsNumberOrNull_(top.views) || 0) +
        '回・返信' +
        perfFormatInt_(snsNumberOrNull_(top.replies) || 0) +
        '）'
    );
  } else if (thLines.length) {
    thLines.push('投稿なし');
  }
  addSection('Threads', thLines);

  // YouTube.
  const ytLines = [];
  const ytDelta = followerDelta((snap) => snap.youtube);
  if (ytDelta) {
    ytLines.push('登録者 ' + ytDelta);
  }
  const ytPosts = perfPostsInWindow_(data.youtubeMediaRows, startMs, endMs);
  if (ytPosts.length) {
    ytPosts.forEach((row) => {
      ytLines.push(
        '新規動画: ' +
          perfFirstLine_(row.title, 40) +
          '（再生' +
          perfFormatInt_(snsNumberOrNull_(row.views) || 0) +
          '回）'
      );
    });
  } else if (ytLines.length) {
    ytLines.push('新規動画なし');
  }
  addSection('YouTube', ytLines);

  // X.
  const xLines = [];
  const xDelta = followerDelta((snap) => snap.x);
  if (xDelta) {
    xLines.push('フォロワー ' + xDelta);
  }
  const xPosts = perfByViewsDesc_(
    perfPostsInWindow_(data.xMediaRows, startMs, endMs)
  );
  if (xPosts.length) {
    const top = xPosts[0];
    xLines.push(
      'ポスト ' +
        xPosts.length +
        '件 / 最多表示: ' +
        perfFirstLine_(top.text, 30) +
        '（表示' +
        perfFormatInt_(snsNumberOrNull_(top.views) || 0) +
        '回）'
    );
  } else if (xLines.length) {
    xLines.push('ポストなし');
  }
  if (
    endSnap &&
    startSnap &&
    typeof endSnap.balance === 'number' &&
    typeof startSnap.balance === 'number'
  ) {
    const spent = startSnap.balance - endSnap.balance;
    if (spent > 0) {
      xLines.push(
        'クレジット消費: $' +
          spent.toFixed(2) +
          '（残高 $' +
          endSnap.balance.toFixed(2) +
          '）'
      );
    }
  }
  addSection('X', xLines);

  // Blog: yesterday's views against the day before.
  const blogLines = [];
  const dayBeforeKey = jstDateKey_(startMs - SNS_DAY_MS);
  let yesterdayViews = null;
  let dayBeforeViews = null;
  (data.blogDailyRows || []).forEach((row) => {
    const key = snsHistoryKeyCell_(row && row.date);
    const views = snsNumberOrNull_(row && row.views);
    if (key === dateKey) {
      yesterdayViews = views;
    }
    if (key === dayBeforeKey) {
      dayBeforeViews = views;
    }
  });
  if (typeof yesterdayViews === 'number') {
    let line = '表示 ' + perfFormatInt_(yesterdayViews) + '回';
    if (typeof dayBeforeViews === 'number') {
      line +=
        '（前日比 ' +
        perfSignedText_(yesterdayViews - dayBeforeViews) +
        '）';
    }
    blogLines.push(line);
  }
  const topDaily = (data.blogPostsDailyRows || [])
    .filter((row) => {
      const title = historyTextOrNull_(row && row.title);
      return (
        snsHistoryKeyCell_(row && row.date) === dateKey &&
        title &&
        title !== PERF_BLOG_GENERIC_TITLE &&
        typeof snsNumberOrNull_(row.views) === 'number'
      );
    })
    .map((row) => ({
      title: historyTextOrNull_(row.title),
      views: snsNumberOrNull_(row.views),
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 5);
  if (topDaily.length) {
    blogLines.push('昨日の記事トップ' + topDaily.length);
    topDaily.forEach((entry, index) => {
      blogLines.push(
        index +
          1 +
          '. ' +
          entry.title +
          '（' +
          perfFormatInt_(entry.views) +
          '回）'
      );
    });
  }
  addSection('ブログ', blogLines);

  return sections;
}

// One highlight item for a slot, or null when no account
// snapshot predates it. prevSlot is the chronologically
// previous slot (the next entry of perfRssSlots_): it anchors
// the since-last-delivery view growth and the new-posts
// window. The description is two-part plain text: the
// compact summary first (what /reader's card shows), then a
// separator line, then the full detail lines — the card's
// expand view on the reader side reveals the whole text, so
// nothing is lost by keeping the headline short.
//
// The morning item is the full report. The noon and evening
// items are diffs against the previous slot instead: deltas
// since the last delivery, today's running blog total, the
// credit burn, and new posts — the per-channel "yesterday"
// sections and the 28-day top article stay morning-only, as
// they would repeat the same completed day.
function buildPerfHighlightItem_(slot, prevSlot, data) {
  const snap = perfSnapshotAt_(data.accountRows, slot.atMs);
  if (!snap) {
    return null;
  }
  const dayAgo = perfSnapshotAt_(data.accountRows, slot.atMs - SNS_DAY_MS);
  const prev = prevSlot ? perfSnapshotAt_(data.accountRows, prevSlot.atMs) : null;
  const isDiff = slot.key !== 'morning' && !!prev;
  const segments = [];
  const lines = [];
  if (typeof snap.total === 'number') {
    const segmentBase = isDiff ? prev : dayAgo;
    segments.push(
      '延べ' +
        perfFormatInt_(snap.total) +
        '人' +
        (segmentBase ? perfDeltaSuffix_(snap.total, segmentBase.total) : '')
    );
    let line = 'SNS延べフォロワー数: ' + perfFormatInt_(snap.total) + '人';
    if (isDiff) {
      line +=
        '（前回配信から ' + perfSignedText_(snap.total - prev.total) + '）';
    } else {
      const delta = dayAgo ? perfDeltaText_(snap.total, dayAgo.total) : '';
      if (delta) {
        line += '（前日比 ' + delta + '）';
      }
    }
    lines.push(line);
  }
  const parts = [];
  const fullParts = [];
  const fullPart = (name, value, prevValue) => {
    let part = name + ' ' + perfFormatInt_(value) + '人';
    if (isDiff && typeof prevValue === 'number') {
      part += '（' + perfSignedText_(value - prevValue) + '）';
    }
    fullParts.push(part);
  };
  if (typeof snap.ig === 'number') {
    parts.push('IG' + perfFormatInt_(snap.ig));
    fullPart('Instagram', snap.ig, prev && prev.ig);
  }
  if (typeof snap.threads === 'number') {
    parts.push('Th' + perfFormatInt_(snap.threads));
    fullPart('Threads', snap.threads, prev && prev.threads);
  }
  if (typeof snap.youtube === 'number') {
    parts.push('YT' + perfFormatInt_(snap.youtube));
    fullPart('YouTube', snap.youtube, prev && prev.youtube);
  }
  if (typeof snap.x === 'number') {
    parts.push('X' + perfFormatInt_(snap.x));
    fullPart('X', snap.x, prev && prev.x);
  }
  if (parts.length) {
    segments.push(parts.join(' '));
    lines.push('内訳: ' + fullParts.join(' / '));
  }
  if (typeof snap.views30d === 'number') {
    segments.push(
      '再生' +
        perfFormatInt_(snap.views30d) +
        '回' +
        (prev ? perfDeltaSuffix_(snap.views30d, prev.views30d) : '')
    );
    let line =
      'Instagram 過去30日の再生回数: ' + perfFormatInt_(snap.views30d) + '回';
    const delta = prev ? perfDeltaText_(snap.views30d, prev.views30d) : '';
    if (delta) {
      line += '（前回配信から ' + delta + '回）';
    }
    lines.push(line);
  }
  let blogToday = null;
  if (isDiff) {
    (data.blogDailyRows || []).forEach((row) => {
      if (snsHistoryKeyCell_(row && row.date) === slot.dateKey) {
        const views = snsNumberOrNull_(row.views);
        if (typeof views === 'number') {
          blogToday = views;
        }
      }
    });
  }
  if (typeof blogToday === 'number') {
    segments.push('ブログ(本日)' + perfFormatInt_(blogToday) + '回');
    lines.push(
      'ブログ（本日・途中経過）: 表示 ' + perfFormatInt_(blogToday) + '回'
    );
  } else {
    const blogDay = perfBlogDay_(data.blogDailyRows, slot.dateKey);
    const blogSegment = perfBlogSegment_(blogDay);
    if (blogSegment) {
      segments.push(blogSegment);
      lines.push(perfBlogLine_(blogDay));
    }
  }
  if (typeof snap.balance === 'number') {
    segments.push('X残高$' + snap.balance.toFixed(2));
    const spent =
      isDiff && typeof prev.balance === 'number'
        ? prev.balance - snap.balance
        : 0;
    if (spent > 0) {
      lines.push(
        'X クレジット消費（前回配信から）: $' +
          spent.toFixed(2) +
          '（残高 $' +
          snap.balance.toFixed(2) +
          '）'
      );
    } else {
      lines.push('X クレジット残高: $' + snap.balance.toFixed(2));
    }
  }
  const topPost = isDiff ? null : perfTopBlogPost_(data.blogPostRows);
  if (topPost) {
    segments.push(
      '人気記事: ' + topPost.title + ' ' + perfFormatInt_(topPost.views) + '回'
    );
    lines.push(
      'よく読まれている記事: ' +
        topPost.title +
        '（28日で ' +
        perfFormatInt_(topPost.views) +
        '回）'
    );
  }
  if (prevSlot) {
    perfNewPostCaptions_(data.mediaRows, prevSlot.atMs, slot.atMs).forEach(
      (caption) => {
        segments.push('新規: ' + caption);
        lines.push('新規投稿: ' + caption);
      }
    );
  }
  const sections = isDiff ? [] : perfChannelSections_(slot, data);
  if (sections.length) {
    lines.push('');
    sections.forEach((line) => lines.push(line));
  }
  let summary = '';
  segments.forEach((segment) => {
    const next = summary ? summary + ' / ' + segment : segment;
    if (next.length <= PERF_RSS_SUMMARY_CHARS) {
      summary = next;
    }
  });
  const dateParts = slot.dateKey.split('-');
  return {
    title:
      Number(dateParts[1]) +
      '月' +
      Number(dateParts[2]) +
      '日 ' +
      slot.label +
      'のハイライト',
    guid: 'perf-' + slot.dateKey + '-' + slot.key,
    pubDate: new Date(slot.atMs).toUTCString(),
    descriptionText:
      summary +
      '\n-------\n' +
      lines.join('\n') +
      '\n詳しくは ' +
      PERF_RSS_CHANNEL.link,
  };
}

// Builds the RSS 2.0 document from highlight items (newest
// first). Titles, guids and descriptions are escaped here.
function buildPerfRss_(items) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '<channel>',
    '<title>' + escapeXmlText_(PERF_RSS_CHANNEL.title) + '</title>',
    '<link>' + escapeXmlText_(PERF_RSS_CHANNEL.link) + '</link>',
    '<description>' + escapeXmlText_(PERF_RSS_CHANNEL.description) + '</description>',
  ];
  (items || []).forEach((item) => {
    if (!item || !item.guid || !item.pubDate) {
      return;
    }
    lines.push(
      '<item>',
      '<title>' + escapeXmlText_(item.title || '') + '</title>',
      '<link>' + escapeXmlText_(PERF_RSS_CHANNEL.link) + '</link>',
      '<guid isPermaLink="false">' + escapeXmlText_(item.guid) + '</guid>',
      '<pubDate>' + item.pubDate + '</pubDate>',
      '<description>' + escapeXmlText_(item.descriptionText || '') + '</description>',
      '</item>'
    );
  });
  lines.push('</channel>', '</rss>');
  return lines.join('\n');
}

// Serves action=perf_rss. The token check is the comments
// feed's: an unset COMMENTS_RSS_TOKEN refuses every request.
// With the history sheet unconfigured the feed is empty.
function servePerfRss_(parameter) {
  const expected = getScriptProperty_(COMMENTS_RSS_TOKEN_PROPERTY);
  if (!expected || !parameter.token || parameter.token !== expected) {
    return jsonOut_({ ok: false, status: 403, error: 'invalid token' });
  }
  let items = [];
  try {
    const spreadsheet = openHistorySpreadsheet_();
    if (spreadsheet) {
      const data = {
        accountRows:
          readHistoryTabObjects_(
            spreadsheet,
            'account',
            SNS_HISTORY_ACCOUNT_COLUMNS
          ) || [],
        blogDailyRows:
          readHistoryTabObjects_(
            spreadsheet,
            'blog_daily',
            SNS_HISTORY_BLOG_DAILY_COLUMNS
          ) || [],
        blogPostRows:
          readHistoryTabObjects_(
            spreadsheet,
            'blog_posts',
            SNS_HISTORY_BLOG_POSTS_COLUMNS
          ) || [],
        blogPostsDailyRows:
          readHistoryTabObjects_(
            spreadsheet,
            'blog_posts_daily',
            SNS_HISTORY_BLOG_POSTS_DAILY_COLUMNS
          ) || [],
        mediaRows:
          readHistoryTabObjects_(
            spreadsheet,
            'media',
            SNS_HISTORY_MEDIA_COLUMNS
          ) || [],
        dailyRows:
          readHistoryTabObjects_(
            spreadsheet,
            'daily',
            SNS_HISTORY_DAILY_COLUMNS
          ) || [],
        threadsMediaRows:
          readHistoryTabObjects_(
            spreadsheet,
            'threads_media',
            SNS_HISTORY_THREADS_MEDIA_COLUMNS
          ) || [],
        youtubeMediaRows:
          readHistoryTabObjects_(
            spreadsheet,
            'youtube_media',
            SNS_HISTORY_YOUTUBE_MEDIA_COLUMNS
          ) || [],
        xMediaRows:
          readHistoryTabObjects_(
            spreadsheet,
            'x_media',
            SNS_HISTORY_X_MEDIA_COLUMNS
          ) || [],
      };
      // One extra slot: the oldest item still needs its
      // previous slot for the growth and new-posts windows.
      const slots = perfRssSlots_(Date.now(), PERF_RSS_ITEM_COUNT + 1);
      for (let i = 0; i < Math.min(PERF_RSS_ITEM_COUNT, slots.length); i++) {
        const item = buildPerfHighlightItem_(slots[i], slots[i + 1] || null, data);
        if (item) {
          items.push(item);
        }
      }
    }
  } catch (err) {
    return jsonOut_({
      ok: false,
      status: 502,
      error:
        'feed unavailable: ' +
        summarizeSnsHistoryError_(
          err,
          getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY)
        ),
    });
  }
  return xmlOut_(buildPerfRss_(items));
}


export { PERF_RSS_ITEM_COUNT, PERF_RSS_SLOTS, PERF_RSS_SUMMARY_CHARS, buildPerfHighlightItem_, buildPerfRss_, perfRssSlots_, perfSnapshotAt_, servePerfRss_ };
