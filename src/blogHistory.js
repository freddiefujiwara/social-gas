// Blog history: GA4 reports written into the history spreadsheet.

import { articleIdFromPath_ } from './publicActions.js';
import { getScriptProperty_ } from './auth.js';
import { SNS_DAY_MS, jstDateKey_ } from './instagramDaily.js';
import { BLOG_POSTS_DAILY_WINDOW_DAYS, BLOG_SPEED_CUMULATIVE_TAB, BLOG_TOTALS_WINDOW_KEY, SNS_HISTORY_BLOG_DAILY_COLUMNS, SNS_HISTORY_BLOG_PAGES_COLUMNS, SNS_HISTORY_BLOG_POSTS_COLUMNS, SNS_HISTORY_BLOG_POSTS_DAILY_COLUMNS, SNS_HISTORY_BLOG_SCROLL_COLUMNS, SNS_HISTORY_BLOG_SOURCES_COLUMNS, SNS_HISTORY_BLOG_SPEED_COLUMNS, SNS_HISTORY_BLOG_SPEED_CUMULATIVE_COLUMNS, SNS_HISTORY_BLOG_TOTALS_COLUMNS, SNS_HISTORY_SHEET_ID_PROPERTY, snsHistoryKeyCell_, snsHistoryNumCell_, snsHistoryTextCell_, summarizeSnsHistoryError_, upsertSnsHistorySheet_ } from './historyWrite.js';
import { buildReportRequest_, fetchReport_, parseFilterClauses_ } from './ga4.js';

// --- Blog history (GA4 -> the same history spreadsheet) ---
// Stage 1 of serving /social from the spreadsheet: the blog's
// numbers join the SNS history in the same workbook, so the
// collection side is complete before any read side switches
// over. Stage 2 (below) reads them back for the screen.
// collectSnsCounts() calls appendBlogHistory_() right after the
// SNS writes; it pulls the blog's GA4 numbers through the
// runReport bridge (buildReportRequest_ / fetchReport_ with
// GA4_PROPERTY_ID) and upserts five tabs:
//   - "blog_daily" (key: date): one row per calendar day over
//     the whole display window (28daysAgo..today, 29 days).
//     Every run re-fetches the full window, so a day GA4 later
//     restates is overwritten with the corrected value on the
//     next run. views / users / sessions are the
//     day's GA4 totals. avg_speed_ms is the day's average wv_lcp
//     value: the blog sends each Core Web Vital as its own event
//     (wv_lcp, wv_inp, ...) with the measured value in the
//     standard `value` parameter, so the Data API aggregates the
//     day's mean as eventValue / eventCount — the aggregation the
//     earlier speed checks used — and LCP is the display-speed
//     metric of that set. music_plays is the day's music_play
//     eventCount.
//   - "blog_posts" (key: path): one row per article, carrying its
//     views over the last 28 days — the window the /social blog
//     tab reads. Article paths arrive split as /<id> and
//     /blog/<id>; both merge under the canonical /blog/<id>, the
//     merge rule the frontend's page ranking applies (and the
//     same article-id test as action=top_articles). The title is
//     GA4's pageTitle on the article's most-viewed path form.
//   - "blog_pages" (key: path): the same fetch with no article
//     filter — every page path under its canonical key — for the
//     top-pages ranking, which mixes articles and app pages.
//   - "blog_totals" (key: window): the window's totals row. The
//     28-day user count deduplicates across days, so it cannot
//     be summed out of blog_daily; it is collected as-is.
//   - "blog_sources" (key: channel): the window's views split
//     by sessionDefaultChannelGroup, for the sources ranking.
//   - "blog_scroll" (key: path): one row per article, carrying
//     its article_scroll counts over the window pivoted by the
//     percent_scrolled marks (25 / 50 / 75 / 100), so the
//     screen can show how far each article is actually read.
//     The event only exists since the blog started sending it
//     (2026-11-14), so older articles simply have no counts
//     until they are read again.
//   - "blog_speed" (key: date + path): one row per article per
//     calendar day, carrying that day's total article_render
//     time and sample count, from the blog's article_render
//     events (the render_ms custom metric). The screen divides
//     the two for the day's average display time; an article
//     with no display on a day has no row for that day. The
//     pre-daily cumulative rows live on under the
//     blog_speed_cumulative tab (see migrateBlogSpeedTab_).
//     The row also carries the day's article_render_slow count
//     (displays of ten seconds or more) so a stall-inflated
//     average is visible as one.
// Both writes are best-effort in the same way as the SNS history:
// gated on SNS_HISTORY_SHEET_ID and GA4_PROPERTY_ID, and a failure
// logs one line instead of failing the collection.

const BLOG_POSTS_WINDOW_DAYS = 28;
const BLOG_POSTS_FETCH_LIMIT = 1000;
const BLOG_DAILY_FETCH_LIMIT = 40;
const BLOG_SOURCES_FETCH_LIMIT = 100;
const BLOG_SPEED_EVENT_NAME = 'wv_lcp';
const BLOG_MUSIC_EVENT_NAME = 'music_play';
const BLOG_RENDER_EVENT_NAME = 'article_render';
const BLOG_RENDER_METRIC = 'customEvent:render_ms';
// The companion event the blog sends alongside article_render
// when a display takes ten seconds or more. Its per-day,
// per-article count separates one stalled load from uniformly
// slow displays in a way the average alone cannot (the map
// article on 2026-11-12: a 7.5s average from six ~1.8s displays
// and one 41.8s stall). Counting a named event needs no custom
// metric.
const BLOG_RENDER_SLOW_EVENT_NAME = 'article_render_slow';
// The third metric name the screen's speed report asks for when
// it wants the slow counts: the sheet bridge serves it from
// blog_speed's slow_count column. It is a bridge name, not a
// GA4 metric — the Data API cannot count one named event inside
// another event's report without a filter, and this bridge
// serves fixed shapes only.
const BLOG_RENDER_SLOW_METRIC = 'customEvent:render_slow_count';
// The daily speed fetch keys rows by date x pagePath x pageTitle,
// so its row count grows with the window's days in a way the
// window-only fetches' does not; the cap sits well above the
// observed volume (a few dozen rows a day) without paging.
const BLOG_SPEED_DAILY_FETCH_LIMIT = 5000;
// The blog's read-depth event: article_scroll fires once per
// display at each of the 25 / 50 / 75 / 100 percent scroll
// marks, carrying the mark in the percent_scrolled custom
// dimension (registered in GA4 with event scope). Counting a
// named event needs no custom metric — eventCount split by
// that dimension is the whole report.
const BLOG_SCROLL_EVENT_NAME = 'article_scroll';
const BLOG_SCROLL_DIMENSION = 'customEvent:percent_scrolled';
const BLOG_SCROLL_LEVELS = [25, 50, 75, 100];
// The scroll fetch keys rows by pagePath x percent_scrolled,
// so its row count grows with the article count times the
// levels in a way the window-only fetches' does not; the cap
// sits well above the observed volume without paging.
const BLOG_SCROLL_FETCH_LIMIT = 5000;

// One runReport call for the blog history: the report's rows, or
// null when the API did not answer 200 (or the fetch itself
// failed). Callers read null as "no fresh data", never as zeros.
function fetchBlogReportRows_(propertyId, params) {
  try {
    const result = fetchReport_(propertyId, buildReportRequest_(params));
    if (result.status !== 200) {
      return null;
    }
    return (result.data && result.data.rows) || [];
  } catch (err) {
    return null;
  }
}

// GA4 reports the date dimension as YYYYMMDD; the sheet keys days
// by the ISO form every other daily tab uses. Anything else reads
// as no date.
function ga4DateKey_(value) {
  const raw = String(value || '');
  if (!/^\d{8}$/.test(raw)) {
    return '';
  }
  return raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
}

function blogReportRowDate_(row) {
  const values = (row && row.dimensionValues) || [];
  return ga4DateKey_(values[0] && values[0].value);
}

function blogReportMetric_(row, index) {
  const values = (row && row.metricValues) || [];
  const num = Number(values[index] && values[index].value);
  return Number.isFinite(num) ? num : null;
}

// The blog's daily numbers over the display window
// (28daysAgo..today, 29 days), keyed by ISO date:
// { views, users, sessions, avg_speed_ms, music_plays }, each
// field null when its report carried no value for that day.
// Returns null when the totals report itself failed — without it
// there is no day to key the rows by. The music and speed reports
// fail independently of it: their fields just stay null.
function fetchBlogDailyData_(propertyId) {
  const nowMs = Date.now();
  const range = {
    startDate: jstDateKey_(nowMs - BLOG_POSTS_WINDOW_DAYS * SNS_DAY_MS),
    endDate: jstDateKey_(nowMs),
  };
  const totals = fetchBlogReportRows_(
    propertyId,
    Object.assign({}, range, {
      metrics: ['screenPageViews', 'activeUsers', 'sessions'],
      dimensions: ['date'],
      limit: BLOG_DAILY_FETCH_LIMIT,
      offset: 0,
      filters: [],
    })
  );
  if (!totals) {
    return null;
  }
  const byDate = {};
  const day = (key) => {
    if (!byDate[key]) {
      byDate[key] = {
        views: null,
        users: null,
        sessions: null,
        avg_speed_ms: null,
        music_plays: null,
      };
    }
    return byDate[key];
  };
  totals.forEach((row) => {
    const key = blogReportRowDate_(row);
    if (!key) {
      return;
    }
    const entry = day(key);
    entry.views = blogReportMetric_(row, 0);
    entry.users = blogReportMetric_(row, 1);
    entry.sessions = blogReportMetric_(row, 2);
  });
  const music = fetchBlogReportRows_(
    propertyId,
    Object.assign({}, range, {
      metrics: ['eventCount'],
      dimensions: ['date'],
      limit: BLOG_DAILY_FETCH_LIMIT,
      offset: 0,
      filters: parseFilterClauses_(
        'eventName:exact:' + BLOG_MUSIC_EVENT_NAME
      ),
    })
  );
  if (music) {
    music.forEach((row) => {
      const key = blogReportRowDate_(row);
      if (key) {
        day(key).music_plays = blogReportMetric_(row, 0);
      }
    });
  }
  const speed = fetchBlogReportRows_(
    propertyId,
    Object.assign({}, range, {
      metrics: ['eventValue', 'eventCount'],
      dimensions: ['date'],
      limit: BLOG_DAILY_FETCH_LIMIT,
      offset: 0,
      filters: parseFilterClauses_(
        'eventName:exact:' + BLOG_SPEED_EVENT_NAME
      ),
    })
  );
  if (speed) {
    speed.forEach((row) => {
      const key = blogReportRowDate_(row);
      if (!key) {
        return;
      }
      const totalValue = blogReportMetric_(row, 0);
      const count = blogReportMetric_(row, 1);
      if (totalValue !== null && count) {
        day(key).avg_speed_ms = Math.round(totalValue / count);
      }
    });
  }
  return byDate;
}

// One "blog_daily" row per day of fetchBlogDailyData_, oldest
// first. A day the totals report did not mention never enters the
// map, so a day GA4 has not processed yet neither records a row
// nor erases a stored one through the upsert.
function buildBlogDailyRows_(byDate, collectedAt) {
  return Object.keys(byDate || {})
    .sort()
    .map((date) => {
      const entry = byDate[date] || {};
      return [
        date,
        snsHistoryNumCell_(entry.views),
        snsHistoryNumCell_(entry.users),
        snsHistoryNumCell_(entry.sessions),
        snsHistoryNumCell_(entry.avg_speed_ms),
        snsHistoryNumCell_(entry.music_plays),
        snsHistoryTextCell_(collectedAt),
      ];
    });
}

// The one pagePath x pageTitle fetch behind both blog_posts
// and blog_pages: the raw report rows, or null when the API did
// not answer 200 (or the fetch itself failed).
function fetchBlogPathRows_(propertyId) {
  return fetchBlogReportRows_(propertyId, {
    startDate: BLOG_POSTS_WINDOW_DAYS + 'daysAgo',
    endDate: 'today',
    metrics: ['screenPageViews'],
    dimensions: ['pagePath', 'pageTitle'],
    limit: BLOG_POSTS_FETCH_LIMIT,
    offset: 0,
    filters: [],
  });
}

// Merges pagePath report rows under the key keyOf(rawPath)
// computes (an empty key drops the row): split path forms of
// one page are summed, and the title comes from the most-viewed
// form. Entries come back sorted by views descending; the
// upsert keeps stored rows in place regardless.
function mergeBlogPathRows_(rows, keyOf) {
  const byPath = {};
  (rows || []).forEach((row) => {
    const dimensionValues = (row && row.dimensionValues) || [];
    const path = keyOf(dimensionValues[0] && dimensionValues[0].value);
    if (!path) {
      return;
    }
    const views = blogReportMetric_(row, 0) || 0;
    const rawTitle = String(
      (dimensionValues[1] && dimensionValues[1].value) || ''
    );
    const title = rawTitle === '(not set)' ? '' : rawTitle;
    const existing = byPath[path];
    if (!existing) {
      byPath[path] = { path, title, views_28d: views, topViews: views };
      return;
    }
    existing.views_28d += views;
    if (views > existing.topViews) {
      existing.topViews = views;
      existing.title = title;
    }
  });
  return Object.keys(byPath)
    .map((path) => byPath[path])
    .sort((a, b) => b.views_28d - a.views_28d)
    .map((entry) => ({
      path: entry.path,
      title: entry.title,
      views_28d: entry.views_28d,
    }));
}

// The canonical key a pagePath counts under in the sheet and in
// the screen's page ranking: an article's split forms merge
// under /blog/<id>; every other path is its own key. The
// language editions are the exception: they keep their raw
// /blog/en/<id> / /blog/zh/<id> key here even though
// articleIdFromPath_ counts them toward the article in the
// per-article tabs — blog_pages feeds the screen's language
// breakdown, which reads the edition rows as they are.
function canonicalBlogPath_(path) {
  const raw = String(path || '');
  if (/^\/blog\/(en|zh)\//.test(raw)) {
    return raw;
  }
  const id = articleIdFromPath_(raw);
  return id ? '/blog/' + id : raw;
}

// The blog's per-article views over the last 28 days, merged
// under the canonical /blog/<id> path as described above.
// Returns null when the report failed.
function fetchBlogPostsData_(propertyId) {
  const rows = fetchBlogPathRows_(propertyId);
  if (!rows) {
    return null;
  }
  return mergeBlogPathRows_(rows, (path) => {
    const id = articleIdFromPath_(path);
    return id ? '/blog/' + id : '';
  });
}

// The same fetch with no article filter: every page path under
// its canonical key, for the screen's top-pages ranking (which
// mixes articles with the app pages). Returns null when the
// report failed.
function fetchBlogPagesData_(propertyId) {
  const rows = fetchBlogPathRows_(propertyId);
  if (!rows) {
    return null;
  }
  return mergeBlogPathRows_(rows, canonicalBlogPath_);
}

// The window's blog totals as GA4 reports them with no
// dimension. The range-wide user count deduplicates across
// days, so it cannot be summed out of blog_daily — it rides
// its own tab. Returns null when the report failed; a window
// GA4 answers with no rows at all reads as all-null fields.
function fetchBlogTotalsData_(propertyId) {
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: BLOG_POSTS_WINDOW_DAYS + 'daysAgo',
    endDate: 'today',
    metrics: ['screenPageViews', 'activeUsers', 'sessions'],
    dimensions: [],
    limit: 1,
    offset: 0,
    filters: [],
  });
  if (!rows) {
    return null;
  }
  const row = rows[0] || null;
  return {
    views: row ? blogReportMetric_(row, 0) : null,
    users: row ? blogReportMetric_(row, 1) : null,
    sessions: row ? blogReportMetric_(row, 2) : null,
  };
}

// The window's views split by traffic channel
// (sessionDefaultChannelGroup), for the screen's sources
// ranking. Returns null when the report failed.
function fetchBlogSourcesData_(propertyId) {
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: BLOG_POSTS_WINDOW_DAYS + 'daysAgo',
    endDate: 'today',
    metrics: ['screenPageViews'],
    dimensions: ['sessionDefaultChannelGroup'],
    limit: BLOG_SOURCES_FETCH_LIMIT,
    offset: 0,
    filters: [],
  });
  if (!rows) {
    return null;
  }
  return rows
    .map((row) => {
      const dimensionValues = (row && row.dimensionValues) || [];
      return {
        channel: String(
          (dimensionValues[0] && dimensionValues[0].value) || ''
        ),
        views_28d: blogReportMetric_(row, 0) || 0,
      };
    })
    .filter((entry) => entry.channel)
    .sort((a, b) => b.views_28d - a.views_28d);
}

// One "blog_speed" row per entry of fetchBlogSpeedDailyData_:
// one article's display times for one calendar day, with the
// slow count the caller merged in from fetchBlogSlowCounts_
// (an unset slow_count writes an empty cell, which the upsert
// merge reads as "keep the stored count").
function buildBlogSpeedRows_(entries, collectedAt) {
  return (entries || []).map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(item.date),
      snsHistoryTextCell_(item.path),
      snsHistoryTextCell_(item.title),
      snsHistoryNumCell_(item.total_render_ms),
      snsHistoryNumCell_(item.samples),
      snsHistoryTextCell_(collectedAt),
      snsHistoryNumCell_(item.slow_count),
    ];
  });
}

// One "blog_posts" row per entry of fetchBlogPostsData_.
function buildBlogPostsRows_(entries, collectedAt) {
  return (entries || []).map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(item.path),
      snsHistoryTextCell_(item.title),
      snsHistoryNumCell_(item.views_28d),
      snsHistoryTextCell_(collectedAt),
    ];
  });
}

// The blog's per-article views per calendar day over the
// last BLOG_POSTS_DAILY_WINDOW_DAYS days, merged under the
// canonical /blog/<id> path like blog_posts (split path forms
// are summed; the title comes from the most-viewed form that
// day). Returns null when the report failed.
function fetchBlogPostsDailyData_(propertyId) {
  const nowMs = Date.now();
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: jstDateKey_(
      nowMs - (BLOG_POSTS_DAILY_WINDOW_DAYS - 1) * SNS_DAY_MS
    ),
    endDate: jstDateKey_(nowMs),
    metrics: ['screenPageViews'],
    dimensions: ['date', 'pagePath', 'pageTitle'],
    limit: BLOG_POSTS_FETCH_LIMIT,
    offset: 0,
    filters: [],
  });
  if (!rows) {
    return null;
  }
  const byDayPath = {};
  rows.forEach((row) => {
    const dimensionValues = (row && row.dimensionValues) || [];
    const date = ga4DateKey_(dimensionValues[0] && dimensionValues[0].value);
    if (!date) {
      return;
    }
    const id = articleIdFromPath_(
      dimensionValues[1] && dimensionValues[1].value
    );
    if (!id) {
      return;
    }
    const path = '/blog/' + id;
    const views = blogReportMetric_(row, 0) || 0;
    const rawTitle = String(
      (dimensionValues[2] && dimensionValues[2].value) || ''
    );
    const title = rawTitle === '(not set)' ? '' : rawTitle;
    const key = date + '|' + path;
    const existing = byDayPath[key];
    if (!existing) {
      byDayPath[key] = { date, path, title, views, topViews: views };
      return;
    }
    existing.views += views;
    if (views > existing.topViews) {
      existing.topViews = views;
      existing.title = title;
    }
  });
  return Object.keys(byDayPath)
    .map((key) => byDayPath[key])
    .map((entry) => ({
      date: entry.date,
      path: entry.path,
      title: entry.title,
      views: entry.views,
    }))
    .sort((a, b) => {
      if (a.date !== b.date) {
        return a.date < b.date ? -1 : 1;
      }
      return b.views - a.views;
    });
}

// One "blog_posts_daily" row per entry of
// fetchBlogPostsDailyData_.
function buildBlogPostsDailyRows_(entries, collectedAt) {
  return (entries || []).map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(item.date),
      snsHistoryTextCell_(item.path),
      snsHistoryTextCell_(item.title),
      snsHistoryNumCell_(item.views),
      snsHistoryTextCell_(collectedAt),
    ];
  });
}

// One "blog_pages" row per entry of fetchBlogPagesData_ — the
// same row shape as blog_posts over the wider net.
function buildBlogPagesRows_(entries, collectedAt) {
  return buildBlogPostsRows_(entries, collectedAt);
}

// The single "blog_totals" row. A null totals object (the
// report failed) never reaches this builder — the caller skips
// the tab — while null fields become empty cells, which the
// upsert merge reads as "keep the stored value".
function buildBlogTotalsRows_(totals, collectedAt) {
  if (!totals) {
    return [];
  }
  return [
    [
      BLOG_TOTALS_WINDOW_KEY,
      snsHistoryNumCell_(totals.views),
      snsHistoryNumCell_(totals.users),
      snsHistoryNumCell_(totals.sessions),
      snsHistoryTextCell_(collectedAt),
    ],
  ];
}

// The blog's per-article display times, one entry per calendar
// day per article over the display window: the article_render
// events' render_ms total and sample count for that day, merged
// under the canonical /blog/<id> path like blog_posts (the
// title comes from the path form with the most samples that
// day). The window is re-fetched whole on every collection, so
// days GA4 has not recorded yet simply have no entries — the
// first daily collection backfills every day the window still
// covers (back to the render metric's first day), with no
// separate repair step. Returns null when the report failed —
// while the render_ms custom metric is unregistered in GA4 the
// API answers an error, which reads as a failed report and
// simply skips the tab until the first displays arrive.
function fetchBlogSpeedDailyData_(propertyId) {
  const nowMs = Date.now();
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: jstDateKey_(nowMs - BLOG_POSTS_WINDOW_DAYS * SNS_DAY_MS),
    endDate: jstDateKey_(nowMs),
    metrics: [BLOG_RENDER_METRIC, 'eventCount'],
    dimensions: ['date', 'pagePath', 'pageTitle'],
    limit: BLOG_SPEED_DAILY_FETCH_LIMIT,
    offset: 0,
    filters: parseFilterClauses_(
      'eventName:exact:' + BLOG_RENDER_EVENT_NAME
    ),
  });
  if (!rows) {
    return null;
  }
  const byDayPath = {};
  rows.forEach((row) => {
    const dimensionValues = (row && row.dimensionValues) || [];
    const date = ga4DateKey_(
      dimensionValues[0] && dimensionValues[0].value
    );
    if (!date) {
      return;
    }
    const id = articleIdFromPath_(
      dimensionValues[1] && dimensionValues[1].value
    );
    if (!id) {
      return;
    }
    const samples = blogReportMetric_(row, 1) || 0;
    if (!samples) {
      return;
    }
    const path = '/blog/' + id;
    const rawTitle = String(
      (dimensionValues[2] && dimensionValues[2].value) || ''
    );
    const title = rawTitle === '(not set)' ? '' : rawTitle;
    const key = date + '|' + path;
    const existing = byDayPath[key];
    if (!existing) {
      byDayPath[key] = {
        date,
        path,
        title,
        total_render_ms: blogReportMetric_(row, 0) || 0,
        samples,
        topSamples: samples,
      };
      return;
    }
    existing.total_render_ms += blogReportMetric_(row, 0) || 0;
    existing.samples += samples;
    if (samples > existing.topSamples) {
      existing.topSamples = samples;
      existing.title = title;
    }
  });
  return Object.keys(byDayPath)
    .map((key) => byDayPath[key])
    .map((entry) => ({
      date: entry.date,
      path: entry.path,
      title: entry.title,
      total_render_ms: entry.total_render_ms,
      samples: entry.samples,
    }))
    .sort((a, b) => {
      if (a.date !== b.date) {
        return a.date < b.date ? -1 : 1;
      }
      return b.total_render_ms / b.samples - a.total_render_ms / a.samples;
    });
}

// The per-day, per-article counts of article_render_slow over
// the same window as fetchBlogSpeedDailyData_ — how many of
// each article's displays on each day took ten seconds or
// more — merged under the canonical /blog/<id> path like the
// speed data, as { 'yyyy-mm-dd|/blog/<id>': count }. Day +
// article pairs with no slow display are absent (the caller
// reads absence as zero). Returns null when the report failed:
// the caller then leaves the stored counts untouched instead
// of reporting a false zero.
function fetchBlogSlowCounts_(propertyId) {
  const nowMs = Date.now();
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: jstDateKey_(nowMs - BLOG_POSTS_WINDOW_DAYS * SNS_DAY_MS),
    endDate: jstDateKey_(nowMs),
    metrics: ['eventCount'],
    dimensions: ['date', 'pagePath'],
    limit: BLOG_SPEED_DAILY_FETCH_LIMIT,
    offset: 0,
    filters: parseFilterClauses_(
      'eventName:exact:' + BLOG_RENDER_SLOW_EVENT_NAME
    ),
  });
  if (!rows) {
    return null;
  }
  const counts = {};
  rows.forEach((row) => {
    const dimensionValues = (row && row.dimensionValues) || [];
    const date = ga4DateKey_(
      dimensionValues[0] && dimensionValues[0].value
    );
    if (!date) {
      return;
    }
    const id = articleIdFromPath_(
      dimensionValues[1] && dimensionValues[1].value
    );
    if (!id) {
      return;
    }
    const count = blogReportMetric_(row, 0) || 0;
    if (!count) {
      return;
    }
    const key = date + '|/blog/' + id;
    counts[key] = (counts[key] || 0) + count;
  });
  return counts;
}

// Moves a pre-daily "blog_speed" tab out of the way before the
// first daily write: while the tab's header still starts with
// the cumulative schema's "path", the sheet is renamed to the
// archive tab (BLOG_SPEED_CUMULATIVE_TAB, or the first free
// numbered variant), so the daily upsert starts from an empty
// tab and the old cumulative rows are never merged into — or
// read as — daily ones. A tab already headed "date" (or no tab
// at all) is left alone, so the migration runs once. Best
// effort like the rest of the blog history: a failure logs one
// line and the collection carries on.
function migrateBlogSpeedTab_(spreadsheet) {
  try {
    const sheet = spreadsheet.getSheetByName('blog_speed');
    if (!sheet || sheet.getLastRow() === 0) {
      return;
    }
    const header = sheet.getRange(1, 1, 1, 1).getValues()[0][0];
    if (
      snsHistoryKeyCell_(header) !==
      SNS_HISTORY_BLOG_SPEED_CUMULATIVE_COLUMNS[0]
    ) {
      return;
    }
    let archiveName = BLOG_SPEED_CUMULATIVE_TAB;
    for (
      let suffix = 2;
      spreadsheet.getSheetByName(archiveName);
      suffix++
    ) {
      archiveName = BLOG_SPEED_CUMULATIVE_TAB + '_' + suffix;
    }
    sheet.setName(archiveName);
    console.log(
      'Blog history: archived the cumulative blog_speed tab as ' +
        archiveName
    );
  } catch (err) {
    console.log(
      'Blog history: blog_speed migration failed: ' +
        summarizeSnsHistoryError_(
          err,
          getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY)
        )
    );
  }
}

// The blog's per-article read depth over the last 28 days:
// the article_scroll eventCount split by pagePath x
// percent_scrolled, merged under the canonical /blog/<id>
// path like blog_posts and pivoted into one count per scroll
// level ({ path, scroll_25, scroll_50, scroll_75,
// scroll_100 }). Levels with no event stay 0; percent values
// outside BLOG_SCROLL_LEVELS, non-article paths and zero
// counts are dropped. Returns null when the report failed —
// while the percent_scrolled custom dimension is
// unregistered in GA4 (or no article_scroll event has been
// recorded yet) the API answers an error, which reads as a
// failed report and simply skips the tab.
function fetchBlogScrollData_(propertyId) {
  const rows = fetchBlogReportRows_(propertyId, {
    startDate: BLOG_POSTS_WINDOW_DAYS + 'daysAgo',
    endDate: 'today',
    metrics: ['eventCount'],
    dimensions: ['pagePath', BLOG_SCROLL_DIMENSION],
    limit: BLOG_SCROLL_FETCH_LIMIT,
    offset: 0,
    filters: parseFilterClauses_(
      'eventName:exact:' + BLOG_SCROLL_EVENT_NAME
    ),
  });
  if (!rows) {
    return null;
  }
  const byPath = {};
  rows.forEach((row) => {
    const dimensionValues = (row && row.dimensionValues) || [];
    const id = articleIdFromPath_(
      dimensionValues[0] && dimensionValues[0].value
    );
    if (!id) {
      return;
    }
    const level = Number(
      dimensionValues[1] && dimensionValues[1].value
    );
    if (BLOG_SCROLL_LEVELS.indexOf(level) === -1) {
      return;
    }
    const count = blogReportMetric_(row, 0) || 0;
    if (!count) {
      return;
    }
    const path = '/blog/' + id;
    if (!byPath[path]) {
      const entry = { path };
      BLOG_SCROLL_LEVELS.forEach((mark) => {
        entry['scroll_' + mark] = 0;
      });
      byPath[path] = entry;
    }
    byPath[path]['scroll_' + level] += count;
  });
  return Object.keys(byPath)
    .map((path) => byPath[path])
    .sort((a, b) => b.scroll_25 - a.scroll_25);
}

// One "blog_scroll" row per entry of fetchBlogScrollData_.
function buildBlogScrollRows_(entries, collectedAt) {
  return (entries || []).map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(item.path),
      snsHistoryNumCell_(item.scroll_25),
      snsHistoryNumCell_(item.scroll_50),
      snsHistoryNumCell_(item.scroll_75),
      snsHistoryNumCell_(item.scroll_100),
      snsHistoryTextCell_(collectedAt),
    ];
  });
}

// One "blog_sources" row per entry of fetchBlogSourcesData_.
function buildBlogSourcesRows_(entries, collectedAt) {
  return (entries || []).map((entry) => {
    const item = entry || {};
    return [
      snsHistoryTextCell_(item.channel),
      snsHistoryNumCell_(item.views_28d),
      snsHistoryTextCell_(collectedAt),
    ];
  });
}

// Writes the blog's history tabs into the SNS history
// spreadsheet. No-op unless SNS_HISTORY_SHEET_ID and
// GA4_PROPERTY_ID are both set (SpreadsheetApp is not touched and
// GA4 is not queried then). Never throws, in the same way as
// appendSnsHistory_: a failed tab is logged and skipped, and the
// collection that called it still counts as a success.
function appendBlogHistory_() {
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return;
  }
  const propertyId = getScriptProperty_('GA4_PROPERTY_ID');
  if (!propertyId) {
    return;
  }
  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    const collectedAt = new Date().toISOString();
    const byDate = fetchBlogDailyData_(propertyId);
    if (byDate) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_daily',
        SNS_HISTORY_BLOG_DAILY_COLUMNS,
        0,
        buildBlogDailyRows_(byDate, collectedAt)
      );
    } else {
      console.log('Blog history: daily report failed, blog_daily skipped');
    }
    const posts = fetchBlogPostsData_(propertyId);
    if (posts) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_posts',
        SNS_HISTORY_BLOG_POSTS_COLUMNS,
        0,
        buildBlogPostsRows_(posts, collectedAt)
      );
    } else {
      console.log('Blog history: posts report failed, blog_posts skipped');
    }
    const postsDaily = fetchBlogPostsDailyData_(propertyId);
    if (postsDaily) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_posts_daily',
        SNS_HISTORY_BLOG_POSTS_DAILY_COLUMNS,
        [0, 1],
        buildBlogPostsDailyRows_(postsDaily, collectedAt)
      );
    } else {
      console.log(
        'Blog history: posts daily report failed, blog_posts_daily skipped'
      );
    }
    const pages = fetchBlogPagesData_(propertyId);
    if (pages) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_pages',
        SNS_HISTORY_BLOG_PAGES_COLUMNS,
        0,
        buildBlogPagesRows_(pages, collectedAt)
      );
    } else {
      console.log('Blog history: pages report failed, blog_pages skipped');
    }
    const totals = fetchBlogTotalsData_(propertyId);
    if (totals) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_totals',
        SNS_HISTORY_BLOG_TOTALS_COLUMNS,
        0,
        buildBlogTotalsRows_(totals, collectedAt)
      );
    } else {
      console.log('Blog history: totals report failed, blog_totals skipped');
    }
    const sources = fetchBlogSourcesData_(propertyId);
    if (sources) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_sources',
        SNS_HISTORY_BLOG_SOURCES_COLUMNS,
        0,
        buildBlogSourcesRows_(sources, collectedAt)
      );
    } else {
      console.log('Blog history: sources report failed, blog_sources skipped');
    }
    const scroll = fetchBlogScrollData_(propertyId);
    if (scroll) {
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_scroll',
        SNS_HISTORY_BLOG_SCROLL_COLUMNS,
        0,
        buildBlogScrollRows_(scroll, collectedAt)
      );
    } else {
      console.log('Blog history: scroll report failed, blog_scroll skipped');
    }
    migrateBlogSpeedTab_(spreadsheet);
    const speed = fetchBlogSpeedDailyData_(propertyId);
    if (speed) {
      // The slow counts ride the same rows, keyed by day +
      // article. A failed slow report leaves slow_count unset
      // on every entry, and the empty cells keep the stored
      // counts (the upsert merge), instead of reporting a
      // false zero for the day.
      const slowCounts = fetchBlogSlowCounts_(propertyId);
      if (slowCounts) {
        speed.forEach((entry) => {
          entry.slow_count = slowCounts[entry.date + '|' + entry.path] || 0;
        });
      } else {
        console.log(
          'Blog history: slow report failed, blog_speed slow counts kept'
        );
      }
      upsertSnsHistorySheet_(
        spreadsheet,
        'blog_speed',
        SNS_HISTORY_BLOG_SPEED_COLUMNS,
        [0, 1],
        buildBlogSpeedRows_(speed, collectedAt)
      );
    } else {
      console.log('Blog history: speed report failed, blog_speed skipped');
    }
  } catch (err) {
    console.log(
      'Blog history append failed: ' + summarizeSnsHistoryError_(err, sheetId)
    );
  }
}


export { BLOG_RENDER_METRIC, BLOG_RENDER_SLOW_METRIC, BLOG_SCROLL_DIMENSION, BLOG_SCROLL_EVENT_NAME, BLOG_SCROLL_LEVELS, appendBlogHistory_, buildBlogDailyRows_, buildBlogPagesRows_, buildBlogPostsDailyRows_, buildBlogPostsRows_, buildBlogScrollRows_, buildBlogSourcesRows_, buildBlogSpeedRows_, buildBlogTotalsRows_, canonicalBlogPath_, fetchBlogDailyData_, fetchBlogPagesData_, fetchBlogPathRows_, fetchBlogPostsDailyData_, fetchBlogPostsData_, fetchBlogReportRows_, fetchBlogScrollData_, fetchBlogSlowCounts_, fetchBlogSourcesData_, fetchBlogSpeedDailyData_, fetchBlogTotalsData_, ga4DateKey_, mergeBlogPathRows_, migrateBlogSpeedTab_ };
