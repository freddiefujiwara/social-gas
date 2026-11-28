// Collection-time read precompute and the hourly collection
// entry points (collectSnsCounts / setupSnsTriggers).

import { SNS_DETAIL_VARIANT_SCOPES, SNS_INSTAGRAM_MAIN_ID, SNS_INSTAGRAM_SUB_ID, SNS_SNAPSHOT_PROPERTY, fetchInstagramFollowers_, fetchThreadsFollowers_, shapeSnsDetail_, snsDetailCacheKey_ } from './snsCounts.js';
import { fetchThreadsAccountDetail_, fetchThreadsRecentPosts_ } from './threadsDetail.js';
import { fetchXDetail_ } from './xDetail.js';
import { refreshMetaTokenIfNeeded_, refreshThreadsTokenIfNeeded, refreshThreadsTokenIfNeeded_ } from './threadsAuth.js';
import { fetchInstagramAccountDetail_, fetchInstagramMediaCount_, fetchInstagramViewsInsights_, joinSnsErrors_ } from './instagramDetail.js';
import { fetchInstagramDemographics_, fetchInstagramRecentMedia_ } from './instagramMedia.js';
import { fetchYouTubeChannelDetail_ } from './youtubeDetail.js';
import { fetchTikTokAccountDetail_ } from './tiktokDetail.js';
import { appendSnsHistory_ } from './historyWrite.js';
import { appendBlogHistory_ } from './blogHistory.js';
import { assembleSnsHistoryResponse_ } from './snsHistoryRead.js';
import { BLOG_REPORT_CACHE_KEY_PREFIX, BLOG_REPORT_CACHE_SECONDS, SNS_DETAIL_CACHE_KEY, SNS_DETAIL_CACHE_SECONDS, SNS_HISTORY_CACHE_KEY, SNS_HISTORY_CACHE_SECONDS, blogDailyData_, blogPagesData_, blogScrollData_, blogSourcesData_, blogSpeedData_, blogTotalsData_, buildSnsDetailFromSheet_, openHistorySpreadsheet_, putCachedText_, resolveBlogDateKey_, sheetReadCache_ } from './sheetRead.js';
import { collectPostComments_ } from './comments.js';

// --- Collection-time read precompute ---
// The read side above serves the screen from CacheService;
// this fills that cache at the one moment the data changes —
// the end of the hourly collection — so a screen load never
// pays the sheet reads and assembly at all. Everything here
// is best-effort: a precompute failure is logged and left for
// the read path to rebuild from the sheet, exactly as before
// this step existed. Payloads are stored through the chunked
// helpers, under the same keys the readers consult.
function precomputeReadCaches_() {
  const cache = sheetReadCache_();
  if (!cache) {
    return;
  }
  const spreadsheet = openHistorySpreadsheet_();
  if (!spreadsheet) {
    return;
  }
  try {
    const detail = buildSnsDetailFromSheet_(spreadsheet);
    if (detail) {
      putCachedText_(
        cache,
        SNS_DETAIL_CACHE_KEY,
        JSON.stringify(detail),
        SNS_DETAIL_CACHE_SECONDS
      );
      // The scoped variants ride along: each is shaped from
      // the same assembled detail and stored under its own
      // key, so a tab's first scoped read is a cache hit too.
      SNS_DETAIL_VARIANT_SCOPES.forEach((scope) => {
        putCachedText_(
          cache,
          snsDetailCacheKey_(scope),
          JSON.stringify(shapeSnsDetail_(detail, scope)),
          SNS_DETAIL_CACHE_SECONDS
        );
      });
    }
  } catch (err) {
    console.log('SNS detail precompute failed: ' + err);
  }
  try {
    putCachedText_(
      cache,
      SNS_HISTORY_CACHE_KEY,
      JSON.stringify(assembleSnsHistoryResponse_(spreadsheet)),
      SNS_HISTORY_CACHE_SECONDS
    );
  } catch (err) {
    console.log('SNS history precompute failed: ' + err);
  }
  // The blog shapes the screen asks for: the totals (always
  // three metrics) and the daily series over the default
  // window, plus the pages / sources rankings at the metric
  // widths the screen uses. Any other parameter combination
  // simply misses here and is cached by its first read, as
  // before.
  const blogShapes = [
    ['totals', 3, () => blogTotalsData_(spreadsheet)],
    [
      'daily',
      1,
      () => {
        const nowMs = Date.now();
        const startKey = resolveBlogDateKey_('28daysAgo', nowMs);
        const endKey = resolveBlogDateKey_('today', nowMs);
        return startKey && endKey
          ? {
              data: blogDailyData_(spreadsheet, startKey, endKey),
              dates: [startKey, endKey],
            }
          : null;
      },
    ],
    ['pages', 1, () => blogPagesData_(spreadsheet, { metrics: [0] })],
    ['pages', 3, () => blogPagesData_(spreadsheet, { metrics: [0, 0, 0] })],
    ['sources', 1, () => blogSourcesData_(spreadsheet, { metrics: [0] })],
    [
      'sources',
      3,
      () => blogSourcesData_(spreadsheet, { metrics: [0, 0, 0] }),
    ],
    ['speed', 2, () => blogSpeedData_(spreadsheet, 2)],
    ['speed', 3, () => blogSpeedData_(spreadsheet, 3)],
    ['scroll', 1, () => blogScrollData_(spreadsheet)],
  ];
  blogShapes.forEach(([shape, metricsLength, build]) => {
    try {
      const built = build();
      if (!built) {
        return;
      }
      const data = built.data !== undefined ? built.data : built;
      if (!data) {
        return;
      }
      let key = BLOG_REPORT_CACHE_KEY_PREFIX + shape + '_' + metricsLength;
      if (built.dates) {
        key += '_' + built.dates[0] + '_' + built.dates[1];
      }
      putCachedText_(
        cache,
        key,
        JSON.stringify(data),
        BLOG_REPORT_CACHE_SECONDS
      );
    } catch (err) {
      console.log('Blog ' + shape + ' precompute failed: ' + err);
    }
  });
}

// Trigger target: collects the latest follower counts and stores the
// snapshot. Each service fails independently (null), so one broken or
// unconfigured service never blocks the others.
function collectSnsCounts() {
  refreshMetaTokenIfNeeded_();
  refreshThreadsTokenIfNeeded_();
  const threadsRefreshError = refreshThreadsTokenIfNeeded();
  const igViews = fetchInstagramViewsInsights_();
  const igDetail = fetchInstagramAccountDetail_();
  const igDemographics = fetchInstagramDemographics_();
  const igMedia = fetchInstagramRecentMedia_();
  const yt = fetchYouTubeChannelDetail_();
  const tt = fetchTikTokAccountDetail_();
  const thDetail = fetchThreadsAccountDetail_();
  const thPosts = fetchThreadsRecentPosts_();
  const xDetail = fetchXDetail_();
  const snapshot = {
    collected_at: new Date().toISOString(),
    youtube: {
      subscribers: yt.subscribers,
      total_views: yt.total_views,
      video_count: yt.video_count,
      recent_videos: yt.recent_videos,
      youtube_error: yt.youtube_error,
    },
    tiktok: {
      followers: tt.followers,
      following: tt.following,
      total_likes: tt.total_likes,
      video_count: tt.video_count,
      recent_videos: tt.recent_videos,
      tiktok_error: tt.tiktok_error,
    },
    instagram: {
      freddiefujiwara: fetchInstagramFollowers_(SNS_INSTAGRAM_MAIN_ID),
      anemone_cancer: fetchInstagramFollowers_(SNS_INSTAGRAM_SUB_ID),
      media_count: fetchInstagramMediaCount_(),
      views_30d: igViews.views_30d,
      non_follower_pct: igViews.non_follower_pct,
      insights_error: igViews.insights_error,
      reach_30d: igDetail.reach_30d,
      accounts_engaged_30d: igDetail.accounts_engaged_30d,
      interactions_30d: igDetail.interactions_30d,
      profile_links_taps_30d: igDetail.profile_links_taps_30d,
      profile_links_taps_source: igDetail.profile_links_taps_source,
      follows_30d: igDetail.follows_30d,
      unfollows_30d: igDetail.unfollows_30d,
      daily_follows: igDetail.daily_follows,
      daily_follows_missing_days: igDetail.daily_follows_missing_days,
      daily_follows_error: igDetail.daily_follows_error,
      demographics: igDemographics.demographics,
      detail_error: joinSnsErrors_([igDetail.detail_error, igDemographics.error]),
      recent_media: igMedia.recent_media,
      media_error: igMedia.media_error,
    },
    threads: {
      followers: fetchThreadsFollowers_(),
      threads_error: threadsRefreshError,
      views_30d: thDetail.views_30d,
      interactions_30d: thDetail.interactions_30d,
      detail_error: thDetail.detail_error,
      recent_posts: thPosts.recent_posts,
      posts_error: thPosts.posts_error,
    },
    x: {
      followers: xDetail.followers,
      username: xDetail.username,
      api_balance_usd: xDetail.api_balance_usd,
      api_daily_posts: xDetail.api_daily_posts,
      usage_error: xDetail.usage_error,
      x_error: xDetail.x_error,
      recent_posts: xDetail.recent_posts,
      posts_error: xDetail.posts_error,
    },
  };
  if (snapshot.threads.threads_error) {
    console.log('Threads refresh error: ' + snapshot.threads.threads_error);
  }
  if (snapshot.threads.detail_error) {
    console.log('Threads detail error: ' + snapshot.threads.detail_error);
  }
  if (snapshot.threads.posts_error) {
    console.log('Threads posts error: ' + snapshot.threads.posts_error);
  }
  if (igViews.insights_error) {
    console.log('Instagram insights error: ' + igViews.insights_error);
  }
  if (snapshot.instagram.detail_error) {
    console.log('Instagram detail error: ' + snapshot.instagram.detail_error);
  }
  if (snapshot.instagram.daily_follows_error) {
    console.log(
      'Instagram daily follows error: ' + snapshot.instagram.daily_follows_error
    );
  }
  if (snapshot.instagram.daily_follows_missing_days) {
    console.log(
      'Instagram daily follows missing days: ' +
        snapshot.instagram.daily_follows_missing_days
    );
  }
  if (snapshot.instagram.media_error) {
    console.log('Instagram media error: ' + snapshot.instagram.media_error);
  }
  if (snapshot.youtube.youtube_error) {
    console.log('YouTube detail error: ' + snapshot.youtube.youtube_error);
  }
  if (snapshot.tiktok.tiktok_error) {
    console.log('TikTok detail error: ' + snapshot.tiktok.tiktok_error);
  }
  if (snapshot.x.x_error) {
    console.log('X detail error: ' + snapshot.x.x_error);
  }
  if (snapshot.x.posts_error && snapshot.x.posts_error !== snapshot.x.x_error) {
    console.log('X posts error: ' + snapshot.x.posts_error);
  }
  PropertiesService.getScriptProperties().setProperty(
    SNS_SNAPSHOT_PROPERTY,
    JSON.stringify(snapshot)
  );
  // The comments collection diffs this run's counts against the
  // counts the history tabs still store, so it runs before the
  // history upsert below overwrites them with this run's values.
  collectPostComments_(snapshot);
  appendSnsHistory_(snapshot);
  appendBlogHistory_();
  // The history writes above are the only moments the read
  // payloads can change, so rebuild them into the read cache
  // here; screen loads then never assemble from the sheet.
  try {
    precomputeReadCaches_();
  } catch (err) {
    console.log('Read cache precompute failed: ' + err);
  }
  console.log('SNS counts collected: ' + JSON.stringify(snapshot));
  return snapshot;
}

// Editor helper: (re)install the hourly time-driven trigger for
// collectSnsCounts. Run once from the editor after deployment; triggers
// are not part of the deployed code.
function setupSnsTriggers() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'collectSnsCounts')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('collectSnsCounts').timeBased().everyHours(1).create();
}


export { collectSnsCounts, precomputeReadCaches_, setupSnsTriggers };
