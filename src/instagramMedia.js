// Instagram demographics and recent media (with media insights).

import { getScriptProperty_ } from './auth.js';
import { META_GRAPH_BASE, SNS_INSTAGRAM_MAIN_ID } from './snsCounts.js';
import { SNS_DEMOGRAPHICS_TOP_LIMIT, SNS_RECENT_MEDIA_LIMIT, fetchInsightsJson_, joinSnsErrors_ } from './instagramDetail.js';
import { readStoredMediaDurations_, resolveMediaDurationSec_ } from './mediaDuration.js';

// Reads the follows/unfollows split out of a follows_and_unfollows
// total_value response. Production diagnostics on 2026-11-09
// (debugSnsInsights) pinned down the only shape this metric returns
// numbers in: metric_type=total_value plus breakdown=follow_type,
// and the breakdown's results are labelled by the resulting state —
// FOLLOWER is the number of accounts that started following (they
// end up followers) and NON_FOLLOWER is the number that unfollowed
// (they end up non-followers); without the breakdown the response
// carries neither total_value nor values at all. Matching is
// therefore exact (case-insensitive) on those two labels, which
// take priority over any looser reading. Anything else leaves the
// split null, and the caller records the observed labels via
// followsBreakdownLabels_ so an unexpected labelling stays
// observable instead of being guessed at.
function parseFollowsBreakdown_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const totalValue = entry && entry.total_value;
  if (!totalValue || !Array.isArray(totalValue.breakdowns)) {
    return null;
  }
  let follows = null;
  let unfollows = null;
  totalValue.breakdowns.forEach((breakdown) => {
    const keys = (breakdown && breakdown.dimension_keys) || [];
    if (!keys.includes('follow_type')) {
      return;
    }
    ((breakdown && breakdown.results) || []).forEach((row) => {
      const value = Number(row && row.value);
      if (!Number.isFinite(value)) {
        return;
      }
      const dims = ((row && row.dimension_values) || []).map((dim) =>
        String(dim).toUpperCase()
      );
      dims.forEach((dim) => {
        if (dim === 'FOLLOWER') {
          follows = value;
        } else if (dim === 'NON_FOLLOWER' || dim === 'NON-FOLLOWER') {
          unfollows = value;
        }
      });
    });
  });
  if (follows === null && unfollows === null) {
    return null;
  }
  return { follows, unfollows };
}

// Lists the dimension values a follows_and_unfollows response
// actually carried on its follow_type breakdown (original casing,
// deduplicated, in response order), or an empty list when the
// response has no such breakdown. Used only to make an unmatched
// labelling observable in instagram.detail_error; the values are
// API labels, never secrets or URLs.
function followsBreakdownLabels_(data) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const totalValue = entry && entry.total_value;
  if (!totalValue || !Array.isArray(totalValue.breakdowns)) {
    return [];
  }
  const labels = [];
  totalValue.breakdowns.forEach((breakdown) => {
    const keys = (breakdown && breakdown.dimension_keys) || [];
    if (!keys.includes('follow_type')) {
      return;
    }
    ((breakdown && breakdown.results) || []).forEach((row) => {
      ((row && row.dimension_values) || []).forEach((dim) => {
        const label = String(dim);
        if (!labels.includes(label)) {
          labels.push(label);
        }
      });
    });
  });
  return labels;
}

// Follower demographics (period=lifetime): age/gender pairs, top
// cities and top countries. Returns { demographics, error }; each of
// the three lists fails independently to null.
function fetchInstagramDemographics_() {
  const demographics = { age_gender: null, top_cities: null, top_countries: null };
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return { demographics, error: null };
  }
  const base =
    META_GRAPH_BASE +
    SNS_INSTAGRAM_MAIN_ID +
    '/insights?metric=follower_demographics&period=lifetime' +
    '&metric_type=total_value&access_token=' +
    encodeURIComponent(token);
  const errors = [];
  let ageGender = fetchDemographicBreakdown_(
    base + '&breakdown=age,gender',
    ['age', 'gender']
  );
  if (ageGender.error) {
    // Some API versions accept only one breakdown dimension at a
    // time; fall back to the age-only split before giving up.
    const retry = fetchDemographicBreakdown_(base + '&breakdown=age', ['age']);
    if (retry.error) {
      errors.push('demographics(age_gender): ' + ageGender.error);
    } else {
      ageGender = retry;
    }
  }
  demographics.age_gender = ageGender.rows;
  const cities = fetchDemographicBreakdown_(base + '&breakdown=city', ['city']);
  if (cities.error) {
    errors.push('demographics(top_cities): ' + cities.error);
  } else {
    demographics.top_cities = cities.rows
      ? cities.rows.slice(0, SNS_DEMOGRAPHICS_TOP_LIMIT)
      : null;
  }
  const countries = fetchDemographicBreakdown_(
    base + '&breakdown=country',
    ['country']
  );
  if (countries.error) {
    errors.push('demographics(top_countries): ' + countries.error);
  } else {
    demographics.top_countries = countries.rows
      ? countries.rows.slice(0, SNS_DEMOGRAPHICS_TOP_LIMIT)
      : null;
  }
  return { demographics, error: joinSnsErrors_(errors) };
}

function fetchDemographicBreakdown_(url, dims) {
  const res = fetchInsightsJson_(url);
  if (res.error) {
    return { rows: null, error: res.error };
  }
  return { rows: parseDemographicsBreakdown_(res.data, dims), error: null };
}

// Reads one breakdown of a follower_demographics total_value
// response as [{ key, value }] sorted by value descending, where key
// is the dimension values joined with "/" (e.g. "25-34/F"). Returns
// null when the requested breakdown is not in the response.
function parseDemographicsBreakdown_(data, dims) {
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  const totalValue = entry && entry.total_value;
  if (!totalValue || !Array.isArray(totalValue.breakdowns)) {
    return null;
  }
  let rows = null;
  totalValue.breakdowns.forEach((breakdown) => {
    const keys = (breakdown && breakdown.dimension_keys) || [];
    if (!dims.every((dim) => keys.includes(dim))) {
      return;
    }
    rows = ((breakdown && breakdown.results) || [])
      .map((row) => ({
        key: ((row && row.dimension_values) || []).join('/'),
        value: Number(row && row.value),
      }))
      .filter((row) => Number.isFinite(row.value));
  });
  if (!rows) {
    return null;
  }
  rows.sort((a, b) => b.value - a.value);
  return rows;
}

// Metric sets tried in order for one media's insights. Reels accept
// the watch-time metrics; other media types reject them, and some
// reject views/shares too, so a failure retries with a smaller set
// and keeps whatever could be read.
const MEDIA_INSIGHTS_ATTEMPTS_REEL = [
  'views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time',
  'reach,likes,comments,saved,total_interactions',
  'likes,comments',
];
const MEDIA_INSIGHTS_ATTEMPTS_FEED = [
  'views,reach,likes,comments,shares,saved,total_interactions',
  'reach,likes,comments,saved,total_interactions',
  'likes,comments',
];

// Newest Instagram media (up to SNS_RECENT_MEDIA_LIMIT) with their
// per-post insights. Returns { recent_media, media_error }:
// recent_media is null only when the media list itself could not be
// read; a post whose insights all failed keeps null metrics and is
// counted in media_error.
function fetchInstagramRecentMedia_() {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return { recent_media: null, media_error: null };
  }
  const listRes = fetchInsightsJson_(
    META_GRAPH_BASE +
      SNS_INSTAGRAM_MAIN_ID +
      '/media?fields=id,media_type,media_product_type,caption,timestamp,permalink,thumbnail_url,media_url&limit=' +
      SNS_RECENT_MEDIA_LIMIT +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (listRes.error) {
    return { recent_media: null, media_error: 'media list: ' + listRes.error };
  }
  const items =
    listRes.data && Array.isArray(listRes.data.data) ? listRes.data.data : null;
  if (!items) {
    return {
      recent_media: null,
      media_error: 'media list: response had no media array',
    };
  }
  const storedDurations = readStoredMediaDurations_();
  const failures = [];
  const recentMedia = items.slice(0, SNS_RECENT_MEDIA_LIMIT).map((media) => {
    const entry = buildRecentMediaEntry_(media);
    entry.duration_sec = resolveMediaDurationSec_(media, storedDurations);
    const insights = fetchMediaInsights_(media, token);
    if (insights.error) {
      failures.push(insights.error);
    }
    Object.assign(entry, insights.values);
    return entry;
  });
  return {
    recent_media: recentMedia,
    media_error: failures.length
      ? failures.length +
        ' of ' +
        recentMedia.length +
        ' media insights failed (' +
        failures[0] +
        ')'
      : null,
  };
}

// Captions are passed through in full: the /ga screen classifies
// each post into a genre by keyword rules over the whole caption,
// hashtags included, and the old 80-character cut-off hid the tail
// of the caption (where the hashtags live) from that classification
// and misfiled posts. SNS_CAPTION_MAX_LENGTH is only a safety cap
// against pathological inputs, far beyond any real caption.
const SNS_CAPTION_MAX_LENGTH = 2000;

function buildRecentMediaEntry_(media) {
  const caption =
    media && media.caption != null ? String(media.caption) : '';
  return {
    id: media && media.id != null ? String(media.id) : null,
    type: (media && (media.media_product_type || media.media_type)) || null,
    posted_at: (media && media.timestamp) || null,
    caption: caption.slice(0, SNS_CAPTION_MAX_LENGTH),
    permalink: (media && media.permalink) || null,
    // The still image for the /social post lists: videos and reels
    // carry thumbnail_url, photos carry only media_url (the image
    // itself), so the first non-empty one wins. Both are signed
    // CDN URLs that expire; the hourly collection refreshes them,
    // so a stored value is never older than the collection that
    // wrote it.
    thumbnail_url:
      (media && media.thumbnail_url) || (media && media.media_url) || null,
    views: null,
    reach: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    avg_watch_sec: null,
    total_watch_sec: null,
    duration_sec: null,
  };
}

// Per-post insights with shrinking metric sets (see the attempts
// above). Returns { values, error }: error is set only when every
// attempt failed. Watch times arrive in milliseconds and are stored
// as seconds (avg to 0.1s, total to whole seconds).
function fetchMediaInsights_(media, token) {
  const empty = {
    views: null,
    reach: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    avg_watch_sec: null,
    total_watch_sec: null,
  };
  if (!media || media.id == null) {
    return { values: empty, error: null };
  }
  const isReel =
    media.media_product_type === 'REELS' || media.media_type === 'VIDEO';
  const attempts = isReel
    ? MEDIA_INSIGHTS_ATTEMPTS_REEL
    : MEDIA_INSIGHTS_ATTEMPTS_FEED;
  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const res = fetchInsightsJson_(
      META_GRAPH_BASE +
        media.id +
        '/insights?metric=' +
        attempts[i] +
        '&access_token=' +
        encodeURIComponent(token)
    );
    if (!res.error) {
      return { values: Object.assign({}, empty, parseMediaInsights_(res.data)), error: null };
    }
    lastError = res.error;
  }
  return { values: empty, error: String(media.id) + ': ' + lastError };
}

// Maps one media insights response to the snapshot's key names
// (saved -> saves) with watch-time conversion to seconds. Metrics
// absent from the response stay out of the map, so the caller's
// nulls remain for them.
function parseMediaInsights_(data) {
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
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      return;
    }
    switch (entry.name) {
      case 'views':
        values.views = num;
        break;
      case 'reach':
        values.reach = num;
        break;
      case 'likes':
        values.likes = num;
        break;
      case 'comments':
        values.comments = num;
        break;
      case 'shares':
        values.shares = num;
        break;
      case 'saved':
        values.saves = num;
        break;
      case 'ig_reels_avg_watch_time':
        values.avg_watch_sec = Math.round(num / 100) / 10;
        break;
      case 'ig_reels_video_view_total_time':
        values.total_watch_sec = Math.round(num / 1000);
        break;
      default:
        break;
    }
  });
  return values;
}


export { SNS_CAPTION_MAX_LENGTH, fetchInstagramDemographics_, fetchInstagramRecentMedia_, fetchMediaInsights_, followsBreakdownLabels_, parseDemographicsBreakdown_, parseFollowsBreakdown_, parseMediaInsights_ };
