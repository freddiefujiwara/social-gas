// YouTube detail: channel totals and recent videos.

import { SNS_YOUTUBE_CHANNEL_ID, snsNumberOrNull_ } from './snsCounts.js';
import { SNS_RECENT_VIDEO_LIMIT, joinSnsErrors_ } from './instagramDetail.js';
import { errorMessageText_ } from './historyWrite.js';

// YouTube advanced-service errors carry API messages (no secrets),
// so a truncated message is safe to keep for diagnosis.
function summarizeYouTubeError_(err) {
  return errorMessageText_(err).slice(0, 200);
}

// Channel totals (subscribers, total views, video count) plus the
// newest uploaded videos. Each half fails independently.
function fetchYouTubeChannelDetail_() {
  const result = {
    subscribers: null,
    total_views: null,
    video_count: null,
    recent_videos: null,
    youtube_error: null,
  };
  if (typeof YouTube === 'undefined' || !YouTube.Channels) {
    result.youtube_error = 'YouTube advanced service is unavailable';
    return result;
  }
  const errors = [];
  try {
    const res = YouTube.Channels.list('statistics', { id: SNS_YOUTUBE_CHANNEL_ID });
    const items = (res && res.items) || [];
    const stats = items.length ? items[0].statistics : null;
    if (stats) {
      if (!stats.hiddenSubscriberCount) {
        result.subscribers = snsNumberOrNull_(Number(stats.subscriberCount));
      }
      result.total_views = snsNumberOrNull_(Number(stats.viewCount));
      result.video_count = snsNumberOrNull_(Number(stats.videoCount));
    }
  } catch (err) {
    errors.push('channel statistics: ' + summarizeYouTubeError_(err));
  }
  const videos = fetchYouTubeRecentVideos_();
  result.recent_videos = videos.videos;
  if (videos.error) {
    errors.push(videos.error);
  }
  result.youtube_error = joinSnsErrors_(errors);
  return result;
}

// An ISO 8601 duration (PT#H#M#S) as whole seconds. Null when
// the value is missing or not in that shape — and for a zero
// length, which the API reports for live and upcoming videos
// rather than a real duration.
function parseYouTubeDurationSec_(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) {
    return null;
  }
  const sec =
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0);
  return sec > 0 ? Math.round(sec) : null;
}

// Newest uploads (up to SNS_RECENT_VIDEO_LIMIT) via the channel's
// uploads playlist, with per-video view/like/comment counts.
function fetchYouTubeRecentVideos_() {
  try {
    const details = YouTube.Channels.list('contentDetails', {
      id: SNS_YOUTUBE_CHANNEL_ID,
    });
    const channelItems = (details && details.items) || [];
    const related =
      (channelItems.length &&
        channelItems[0].contentDetails &&
        channelItems[0].contentDetails.relatedPlaylists) ||
      {};
    if (!related.uploads) {
      return { videos: [], error: null };
    }
    const playlist = YouTube.PlaylistItems.list('snippet', {
      playlistId: related.uploads,
      maxResults: SNS_RECENT_VIDEO_LIMIT,
    });
    const metas = ((playlist && playlist.items) || [])
      .map((item) => {
        const snippet = (item && item.snippet) || {};
        const resource = snippet.resourceId || {};
        return {
          id: resource.videoId || null,
          title: snippet.title || null,
          published_at: snippet.publishedAt || null,
        };
      })
      .filter((meta) => meta.id);
    if (!metas.length) {
      return { videos: [], error: null };
    }
    const statsRes = YouTube.Videos.list('statistics,contentDetails', {
      id: metas.map((meta) => meta.id).join(','),
    });
    const statsById = {};
    const detailsById = {};
    ((statsRes && statsRes.items) || []).forEach((item) => {
      if (item && item.id) {
        statsById[item.id] = item.statistics || {};
        detailsById[item.id] = item.contentDetails || {};
      }
    });
    const videos = metas.map((meta) => {
      const stats = statsById[meta.id] || {};
      const details = detailsById[meta.id] || {};
      return {
        id: meta.id,
        title: meta.title,
        published_at: meta.published_at,
        views: snsNumberOrNull_(Number(stats.viewCount)),
        likes: snsNumberOrNull_(Number(stats.likeCount)),
        comments: snsNumberOrNull_(Number(stats.commentCount)),
        duration_sec: parseYouTubeDurationSec_(details.duration),
        url: 'https://www.youtube.com/watch?v=' + meta.id,
      };
    });
    return { videos, error: null };
  } catch (err) {
    return { videos: null, error: 'recent videos: ' + summarizeYouTubeError_(err) };
  }
}


export { fetchYouTubeChannelDetail_, fetchYouTubeRecentVideos_, summarizeYouTubeError_ };
