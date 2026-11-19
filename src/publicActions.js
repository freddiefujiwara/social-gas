import { buildReportRequest_, fetchReport_, parseFilterClauses_ } from './ga4.js';

/**
 * ga4-gas: GA4 Data API bridge.
 *
 * Runs as a Web app under the owner's Google account and returns GA4
 * Data API runReport results as JSON.
 *
 * Query parameters:
 *   start      (default "28daysAgo") - GA4 date expression or YYYY-MM-DD
 *   end        (default "today")
 *   metrics    (default "screenPageViews,activeUsers,sessions") - comma separated
 *   dimensions (default "pagePath") - comma separated; empty means totals only
 *   limit      (default 25)
 *   offset     (default 0) - row offset for paging together with limit
 *   filter     - dimension filter clauses separated by ";", each clause is
 *                "<dimension>:<matchType>:<value>", matchType is one of
 *                exact / contains / beginsWith / endsWith / regexp.
 *                Multiple clauses are combined with AND. Example:
 *                filter=pagePath:contains:/blog/;sessionDefaultChannelGroup:exact:Organic Search
 *                (Filters are parsed and validated, but filtered reports
 *                are not served: see below.)
 *
 * The default report is served from the history spreadsheet the
 * hourly collection writes (stage 2), in the fixed shapes the
 * /social screen uses — totals, daily views, page ranking,
 * channel ranking, per-article display times — and no longer
 * calls the GA4 Data API.
 * Unsupported parameter combinations answer ok:false.
 *
 * Actions:
 *   action=music_count - a public action: returns only the
 *                cumulative music_play event count and its timestamp
 *                (cached for about an hour).
 *   action=top_articles - a public action: returns only the top
 *                few blog articles of the last 28 days (article id
 *                and view count, cached for about an hour). Every
 *                other request, including the default report,
 *                requires authentication once it is configured
 *                (see below).
 *
 * The GA4 property ID comes from the Script Property GA4_PROPERTY_ID,
 * so it is never written in the source (see README "Setup").
 */

const GA4_API_BASE = 'https://analyticsdata.googleapis.com/v1beta/properties/';
const FRONTEND_URL = 'https://freddiefujiwara.com/social/';
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

// --- Public music play count (action=music_count) ---
// The one deliberately unauthenticated action: the site header on
// every page shows the cumulative music_play count, and a public
// page cannot hold a credential. It returns exactly two values —
// the total eventCount of the music_play event since the event was
// introduced (2026-11-08) and when that total was produced — and
// nothing else. Results are cached in CacheService so the GA4 Data
// API is hit at most about once an hour no matter how often the
// action is called.
const MUSIC_COUNT_CACHE_KEY = 'music_count_v1';
const MUSIC_COUNT_CACHE_SECONDS = 60 * 60;
const MUSIC_PLAY_START_DATE = '2026-11-08';

function fetchMusicCount_(propertyId) {
  const cache =
    typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null;
  if (cache) {
    const cached = cache.get(MUSIC_COUNT_CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && Number.isFinite(parsed.count) && parsed.updated_at) {
          return parsed;
        }
      } catch (error) {
        // A corrupt cache entry is ignored; a fresh value is fetched.
      }
    }
  }
  const body = buildReportRequest_({
    startDate: MUSIC_PLAY_START_DATE,
    endDate: 'today',
    metrics: ['eventCount'],
    dimensions: [],
    limit: 1,
    offset: 0,
    filters: parseFilterClauses_('eventName:exact:music_play'),
  });
  const result = fetchReport_(propertyId, body);
  if (result.status !== 200) {
    throw new Error('GA4 API request failed with status ' + result.status);
  }
  let count = 0;
  const rows = (result.data && result.data.rows) || [];
  if (rows.length > 0) {
    const metricValues = rows[0].metricValues || [];
    const value = Number(metricValues[0] && metricValues[0].value);
    count = Number.isFinite(value) ? value : 0;
  }
  const payload = { count, updated_at: new Date().toISOString() };
  if (cache) {
    cache.put(
      MUSIC_COUNT_CACHE_KEY,
      JSON.stringify(payload),
      MUSIC_COUNT_CACHE_SECONDS
    );
  }
  return payload;
}

// --- Public top articles (action=top_articles) ---
// The second deliberately unauthenticated action: the top page's
// "よく読まれている記事" section is baked at build time from this
// ranking, and a public page cannot hold a credential. It returns
// exactly the top few blog articles of the last 28 days — article
// id and view count, nothing else. Results are cached in
// CacheService so the GA4 Data API is hit at most about once an
// hour no matter how often the action is called.
//
// Article paths are recorded both as /<id> (the SPA's
// base-relative route) and as /blog/<id> (the real URL); the two
// forms are merged before ranking, the same rule the /ga screen
// applies in its page ranking.
const TOP_ARTICLES_CACHE_KEY = 'top_articles_v1';
const TOP_ARTICLES_CACHE_SECONDS = 60 * 60;
const TOP_ARTICLES_DAYS = 28;
const TOP_ARTICLES_LIMIT = 10;
const TOP_ARTICLES_FETCH_LIMIT = 1000;
const ARTICLE_ID_PATTERN = /^[0-9][A-Za-z0-9_-]{24,}$/;

// The blog article id a pagePath belongs to, or '' when the path
// is not a blog article. Article ids are the long URL-safe
// document tokens (they start with a digit); app pages such as
// /list-of-stuff/ are not articles.
function articleIdFromPath_(path) {
  const id = String(path || '')
    .replace(/^\/(blog\/)?/, '')
    .replace(/\/$/, '');
  return ARTICLE_ID_PATTERN.test(id) ? id : '';
}

// Merge GA report rows (pagePath x screenPageViews) into the
// article ranking: split paths summed per article, sorted by
// views descending, cut to the top `limit`.
function rankTopArticles_(rows, limit) {
  const merged = new Map();
  (rows || []).forEach((row) => {
    const dimensionValues = row.dimensionValues || [];
    const metricValues = row.metricValues || [];
    const id = articleIdFromPath_(
      dimensionValues[0] && dimensionValues[0].value
    );
    if (!id) return;
    const views = Number(metricValues[0] && metricValues[0].value) || 0;
    merged.set(id, (merged.get(id) || 0) + views);
  });
  return Array.from(merged.entries())
    .map(([id, views]) => ({ id, views }))
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}

function fetchTopArticles_(propertyId) {
  const cache =
    typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null;
  if (cache) {
    const cached = cache.get(TOP_ARTICLES_CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.articles) && parsed.updated_at) {
          return parsed;
        }
      } catch (error) {
        // A corrupt cache entry is ignored; a fresh value is fetched.
      }
    }
  }
  const body = buildReportRequest_({
    startDate: '28daysAgo',
    endDate: 'today',
    metrics: ['screenPageViews'],
    dimensions: ['pagePath'],
    limit: TOP_ARTICLES_FETCH_LIMIT,
    offset: 0,
    filters: [],
  });
  const result = fetchReport_(propertyId, body);
  if (result.status !== 200) {
    throw new Error('GA4 API request failed with status ' + result.status);
  }
  const payload = {
    days: TOP_ARTICLES_DAYS,
    articles: rankTopArticles_(
      (result.data && result.data.rows) || [],
      TOP_ARTICLES_LIMIT
    ),
    updated_at: new Date().toISOString(),
  };
  if (cache) {
    cache.put(
      TOP_ARTICLES_CACHE_KEY,
      JSON.stringify(payload),
      TOP_ARTICLES_CACHE_SECONDS
    );
  }
  return payload;
}


export { FRONTEND_URL, GA4_API_BASE, SHARE_TTL_SECONDS, articleIdFromPath_, fetchMusicCount_, fetchTopArticles_, rankTopArticles_ };
