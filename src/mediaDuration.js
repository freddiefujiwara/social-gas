// Media duration: measuring a video's own length from its MP4
// headers when the API does not provide it.

import { snsNumberOrNull_ } from './snsCounts.js';
import { SNS_HISTORY_MEDIA_COLUMNS } from './historyWrite.js';
import { historyTextOrNull_, openHistorySpreadsheet_, readHistoryTabObjects_ } from './sheetRead.js';

// --- Media duration (the video's own length) ---
//
// Neither the media object nor its insights carry the video's
// length, so the duration comes from the MP4 file itself: the
// mvhd box inside moov holds the movie's timescale and
// duration (fragmented MP4s leave that duration at 0 and carry
// the length in the mehd box instead — see
// parseMp4DurationSec_). A length never changes once a post
// exists, so the
// collection first reuses the value the media tab already
// stores for the post and only fetches files for videos it has
// never measured — that keeps the extra UrlFetch calls (and
// the 6-minute execution budget) bounded to the genuinely new
// videos of each run.

const MEDIA_DURATION_PROBE_BYTES = 512 * 1024;
// Sanity bound for a parsed mvhd: anything longer is treated
// as a false "mvhd" hit inside compressed media data.
const MEDIA_DURATION_MAX_SEC = 24 * 60 * 60;

// The media tab's stored durations as { media_id: seconds }.
// Best-effort: any failure (history unconfigured, tab missing,
// sheet unreadable) yields an empty map and the collection
// simply measures what it can.
function readStoredMediaDurations_() {
  const durations = {};
  try {
    const spreadsheet = openHistorySpreadsheet_();
    if (!spreadsheet) {
      return durations;
    }
    const rows = readHistoryTabObjects_(
      spreadsheet,
      'media',
      SNS_HISTORY_MEDIA_COLUMNS
    );
    if (!rows) {
      return durations;
    }
    rows.forEach((row) => {
      const id = historyTextOrNull_(row.media_id);
      const sec = snsNumberOrNull_(row.duration_sec);
      if (id && sec !== null) {
        durations[id] = sec;
      }
    });
  } catch (err) {
    // Durations are a cache, never a collection blocker.
  }
  return durations;
}

// One media's duration in seconds: the stored value when the
// tab already has one, a fresh measurement for a video (reels
// and feed videos) whose file URL is known, otherwise null
// (photos, carousels and failed measurements alike).
function resolveMediaDurationSec_(media, storedDurations) {
  if (!media || media.id == null) {
    return null;
  }
  const stored = (storedDurations || {})[String(media.id)];
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    return stored;
  }
  const isVideo =
    media.media_product_type === 'REELS' || media.media_type === 'VIDEO';
  if (!isVideo || !media.media_url) {
    return null;
  }
  return fetchMediaDurationSec_(media.media_url);
}

// Measures one MP4's length by fetching its head (reels keep
// moov up front) and, when no mvhd turns up there, its tail
// (moov can sit behind mdat instead). Each fetch asks for a
// 512KB range; a server that ignores Range and returns the
// whole file still parses, because the parser only scans the
// bytes it was handed. Any failure returns null.
function fetchMediaDurationSec_(mediaUrl) {
  const head = fetchMediaByteRange_(
    mediaUrl,
    'bytes=0-' + (MEDIA_DURATION_PROBE_BYTES - 1)
  );
  const fromHead = head ? parseMp4DurationSec_(head) : null;
  if (fromHead !== null) {
    return fromHead;
  }
  const tail = fetchMediaByteRange_(
    mediaUrl,
    'bytes=-' + MEDIA_DURATION_PROBE_BYTES
  );
  return tail ? parseMp4DurationSec_(tail) : null;
}

// One ranged GET of a media file, returning the raw bytes or
// null. Only 200 / 206 count as success; the CDN redirect is
// followed by UrlFetchApp itself.
function fetchMediaByteRange_(mediaUrl, range) {
  let res;
  try {
    res = UrlFetchApp.fetch(mediaUrl, {
      muteHttpExceptions: true,
      headers: { Range: range },
    });
  } catch (err) {
    return null;
  }
  const status = res.getResponseCode();
  if (status !== 200 && status !== 206) {
    return null;
  }
  try {
    const content = res.getContent();
    return content && content.length ? content : null;
  } catch (err) {
    return null;
  }
}

// Scans a byte array (signed, as Apps Script hands back, or
// unsigned) for the two MP4 header boxes that carry a movie's
// length and returns their raw fields: { mvhd, mehd }, each
// either null or { version, timescale, duration } (mvhd) /
// { version, duration } (mehd). The first plausible candidate
// of each type wins: an mvhd candidate needs a known version
// and a nonzero timescale (its duration may still be 0 — see
// parseMp4DurationSec_), a mehd candidate a known version.
// mvhd layout after the type: version/flags (4 bytes), then
// for version 1 two 64-bit timestamps, a 32-bit timescale and
// a 64-bit duration; for version 0 the same fields at 32 bits
// each. mehd layout after the type: version/flags (4 bytes),
// then the duration at 32 bits (version 0) or 64 bits
// (version 1), in the movie's timescale units.
function inspectMp4Headers_(bytes) {
  const found = { mvhd: null, mehd: null };
  if (!bytes || bytes.length < 24) {
    return found;
  }
  const u8 = (index) => bytes[index] & 0xff;
  const u32 = (index) =>
    ((u8(index) * 256 + u8(index + 1)) * 256 + u8(index + 2)) * 256 +
    u8(index + 3);
  const matchesType = (index, type) =>
    u8(index) === type.charCodeAt(0) &&
    u8(index + 1) === type.charCodeAt(1) &&
    u8(index + 2) === type.charCodeAt(2) &&
    u8(index + 3) === type.charCodeAt(3);
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (!found.mvhd && matchesType(i, 'mvhd')) {
      const content = i + 4;
      const version = u8(content);
      let timescale = null;
      let duration = null;
      if (version === 1 && content + 32 <= bytes.length) {
        timescale = u32(content + 20);
        duration = u32(content + 24) * 4294967296 + u32(content + 28);
      } else if (version === 0 && content + 20 <= bytes.length) {
        timescale = u32(content + 12);
        duration = u32(content + 16);
      }
      if (timescale) {
        found.mvhd = { version, timescale, duration };
      }
    }
    if (!found.mehd && matchesType(i, 'mehd')) {
      const content = i + 4;
      const version = u8(content);
      let duration = null;
      if (version === 1 && content + 12 <= bytes.length) {
        duration = u32(content + 4) * 4294967296 + u32(content + 8);
      } else if (version === 0 && content + 8 <= bytes.length) {
        duration = u32(content + 4);
      }
      if (duration !== null) {
        found.mehd = { version, duration };
      }
    }
    if (found.mvhd && found.mehd) {
      break;
    }
  }
  return found;
}

// Whether the four box-type bytes appear anywhere in the byte
// array. Diagnostic only (debugMediaDuration): byte patterns
// can also occur inside compressed media data, so presence is
// a hint, not proof of a real box.
function mp4BoxTypePresent_(bytes, type) {
  if (!bytes || bytes.length < 4) {
    return false;
  }
  const codes = [
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      (bytes[i] & 0xff) === codes[0] &&
      (bytes[i + 1] & 0xff) === codes[1] &&
      (bytes[i + 2] & 0xff) === codes[2] &&
      (bytes[i + 3] & 0xff) === codes[3]
    ) {
      return true;
    }
  }
  return false;
}

// The pure parser: the movie length in seconds to 0.1s — the
// same precision avg_watch_sec is stored at — or null when no
// plausible header is present. A plain MP4 carries the length
// in mvhd's duration. A fragmented MP4 (the shape Instagram
// serves for most reels) leaves mvhd's duration at 0 and
// carries the full length in the mehd box inside mvex, in the
// same timescale units, so a zero mvhd duration falls back to
// mehd. A positive mvhd duration always wins over mehd.
function parseMp4DurationSec_(bytes) {
  const headers = inspectMp4Headers_(bytes);
  if (!headers.mvhd) {
    return null;
  }
  const duration = headers.mvhd.duration
    ? headers.mvhd.duration
    : headers.mehd
      ? headers.mehd.duration
      : 0;
  if (!duration) {
    return null;
  }
  const seconds = duration / headers.mvhd.timescale;
  if (
    !Number.isFinite(seconds) ||
    seconds < 0.1 ||
    seconds > MEDIA_DURATION_MAX_SEC
  ) {
    return null;
  }
  return Math.round(seconds * 10) / 10;
}


export { MEDIA_DURATION_PROBE_BYTES, fetchMediaDurationSec_, inspectMp4Headers_, mp4BoxTypePresent_, parseMp4DurationSec_, readStoredMediaDurations_, resolveMediaDurationSec_ };
