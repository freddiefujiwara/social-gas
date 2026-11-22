// Manual diagnostics for media duration probing.

import { getScriptProperty_ } from './auth.js';
import { META_GRAPH_BASE, SNS_INSTAGRAM_MAIN_ID, snsNumberOrNull_ } from './snsCounts.js';
import { SNS_RECENT_MEDIA_LIMIT, fetchInsightsJson_ } from './instagramDetail.js';
import { MEDIA_DURATION_PROBE_BYTES, fetchMediaDurationSec_, inspectMp4Headers_, mp4BoxTypePresent_, parseMp4DurationSec_ } from './mediaDuration.js';
import { SNS_HISTORY_MEDIA_COLUMNS } from './historyWrite.js';
import { historyTextOrNull_, openHistorySpreadsheet_, readHistoryTabObjects_ } from './sheetRead.js';

// --- Manual diagnostics: debugMediaDuration / debugMediaDurationMissing /
// debugMediaUrlMissing ---
// Run by hand from the Apps Script editor when duration_sec
// stays null for a post (as on 2026-11-15, when the first
// production collection measured only 2 of the newest 30
// videos — the two long song reels — and the fragmented-MP4
// mehd fallback followed). debugMediaDuration inspects one
// post: call it with the media_id to inspect; with no argument
// it probes the newest video in the recent media list, which
// is the form the editor's Run button can use.
// debugMediaDurationMissing inspects the posts that are
// actually unmeasured: it reads the media tab the way the
// collection does, takes up to five REELS / VIDEO rows whose
// duration_sec is still empty, and runs the same diagnosis on
// each — the no-argument auto-pick above can land on a post
// that already has a duration (it did on 2026-11-15: it picked
// a measured song reel and showed a healthy pipeline), which
// says nothing about the posts that fail. For each Range
// probe (head, then tail) the diagnosis logs the HTTP status,
// the byte count, which of the moov / mvhd / mvex / mehd byte
// patterns appear, the raw mvhd timescale / duration and mehd
// duration the inspector read, and the parse result — so the
// next fix starts from what Instagram actually serves instead
// of a guess. None of the functions here is ever called from a
// trigger, doGet or the collection, and none touches the
// snapshot or the sheet. The media_url (a signed CDN URL) and
// the access token are never logged.
// debugMediaUrlMissing goes one step earlier in the pipeline:
// when debugMediaDurationMissing ran in production on
// 2026-11-15, every unmeasured post stopped at "media has no
// media_url to probe" — the media objects the Graph API handed
// back carried no media_url at all, so the MP4 was never even
// fetched. It shows, for each unmeasured post, whether the
// recent-list object and two direct-by-id fetches (no fields
// parameter, and fields=media_url,media_type,media_product_type)
// carry a media_url, listing key names only (plus the values
// of identifying fields such as media_type), and feeds any
// media_url a direct fetch did return through
// fetchMediaDurationSec_ — so the next fix starts from which
// request shape, if any, actually returns the URL.
function debugMediaDuration(mediaId) {
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set; nothing to diagnose.');
    return;
  }
  const list = debugFetchMediaList_(token);
  if (list.error) {
    Logger.log('media list failed: ' + list.error);
    return;
  }
  const items = list.items;
  let media = null;
  if (mediaId != null && String(mediaId) !== '') {
    media =
      items.find((item) => item && String(item.id) === String(mediaId)) ||
      null;
    if (!media) {
      const one = debugFetchMediaById_(mediaId, token);
      if (one.error) {
        Logger.log(
          'media ' + mediaId + ' not in the recent list; direct fetch failed: ' +
            one.error
        );
        return;
      }
      media = one.media;
    }
  } else {
    media =
      items.find(
        (item) =>
          item &&
          item.media_url &&
          (item.media_product_type === 'REELS' ||
            item.media_type === 'VIDEO')
      ) || null;
    if (!media) {
      Logger.log('no video with a media_url in the recent media list.');
      return;
    }
    Logger.log(
      'no media_id given; probing the newest video: ' + media.id
    );
  }
  if (!media || !media.media_url) {
    Logger.log('media has no media_url to probe.');
    return;
  }
  debugLogMediaDurationProbes_(media);
}

// The recent media list for the debug functions, as
// { items, error }: items is the media array (possibly empty)
// on success, error the fetchInsightsJson_ error text.
function debugFetchMediaList_(token) {
  const listRes = fetchInsightsJson_(
    META_GRAPH_BASE +
      SNS_INSTAGRAM_MAIN_ID +
      '/media?fields=id,media_type,media_product_type,permalink,media_url&limit=' +
      SNS_RECENT_MEDIA_LIMIT +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (listRes.error) {
    return { items: null, error: listRes.error };
  }
  return {
    items:
      listRes.data && Array.isArray(listRes.data.data) ? listRes.data.data : [],
    error: null,
  };
}

// One media object fetched directly by id, as { media, error },
// for posts that have aged out of the recent media list.
function debugFetchMediaById_(mediaId, token) {
  return debugFetchMediaByIdWithFields_(
    mediaId,
    token,
    'id,media_type,media_product_type,permalink,media_url'
  );
}

// One media object fetched directly by id with a caller-chosen
// fields parameter, as { media, error }; fields null omits the
// parameter entirely, which is a different request shape (the
// Graph API then returns its default field set).
function debugFetchMediaByIdWithFields_(mediaId, token, fields) {
  const oneRes = fetchInsightsJson_(
    META_GRAPH_BASE +
      encodeURIComponent(String(mediaId)) +
      '?' +
      (fields ? 'fields=' + fields + '&' : '') +
      'access_token=' +
      encodeURIComponent(token)
  );
  if (oneRes.error) {
    return { media: null, error: oneRes.error };
  }
  return { media: oneRes.data, error: null };
}

// The per-media diagnosis both debug entry points share: the
// header line, the head / tail Range probes with their HTTP
// status, byte count, box patterns and raw header fields, the
// parse result, and the collection path's own result for
// comparison.
function debugLogMediaDurationProbes_(media) {
  Logger.log(
    '=== debugMediaDuration: media ' +
      media.id +
      ' (' +
      (media.media_product_type || media.media_type || 'unknown type') +
      ') ==='
  );
  const probes = [
    ['head', 'bytes=0-' + (MEDIA_DURATION_PROBE_BYTES - 1)],
    ['tail', 'bytes=-' + MEDIA_DURATION_PROBE_BYTES],
  ];
  probes.forEach(([label, range]) => {
    const probe = debugProbeMediaRange_(media.media_url, range);
    Logger.log('--- ' + label + ' range ' + range + ' ---');
    if (!probe.bytes) {
      Logger.log(
        'fetch failed (status: ' +
          (probe.status === null ? 'exception' : probe.status) +
          ')'
      );
      return;
    }
    Logger.log(
      'status: ' + probe.status + ', bytes: ' + probe.bytes.length
    );
    Logger.log(
      'box patterns: moov=' +
        mp4BoxTypePresent_(probe.bytes, 'moov') +
        ' mvhd=' +
        mp4BoxTypePresent_(probe.bytes, 'mvhd') +
        ' mvex=' +
        mp4BoxTypePresent_(probe.bytes, 'mvex') +
        ' mehd=' +
        mp4BoxTypePresent_(probe.bytes, 'mehd')
    );
    const headers = inspectMp4Headers_(probe.bytes);
    Logger.log(
      'mvhd: ' +
        (headers.mvhd
          ? 'version=' +
            headers.mvhd.version +
            ' timescale=' +
            headers.mvhd.timescale +
            ' duration=' +
            headers.mvhd.duration
          : '(none)')
    );
    Logger.log(
      'mehd: ' +
        (headers.mehd
          ? 'version=' + headers.mehd.version + ' duration=' + headers.mehd.duration
          : '(none)')
    );
    Logger.log(
      'parse result: ' + parseMp4DurationSec_(probe.bytes) + ' sec'
    );
  });
  Logger.log(
    'fetchMediaDurationSec_ (the collection path): ' +
      fetchMediaDurationSec_(media.media_url) +
      ' sec'
  );
}

// How many unmeasured videos debugMediaDurationMissing probes
// in one run: enough to see the pattern across posts, few
// enough to stay well inside the execution budget (each post
// costs up to four ranged fetches plus its media fetch).
const DEBUG_MEDIA_DURATION_MISSING_LIMIT = 5;

// The media tab's unmeasured videos, as [{ media_id, type }]
// in tab order: rows whose type is one the collection tries
// to measure (REELS / VIDEO) and whose duration_sec cell
// holds no number yet — the same cell reading
// readStoredMediaDurations_ applies. Pure, so the selection
// is testable without a sheet.
function selectUnmeasuredDurationMediaRows_(rows, limit) {
  const cap =
    typeof limit === 'number' && limit > 0
      ? Math.floor(limit)
      : DEBUG_MEDIA_DURATION_MISSING_LIMIT;
  const selected = [];
  (rows || []).forEach((row) => {
    if (!row || selected.length >= cap) {
      return;
    }
    const mediaId = historyTextOrNull_(row.media_id);
    const type = historyTextOrNull_(row.type);
    if (!mediaId || (type !== 'REELS' && type !== 'VIDEO')) {
      return;
    }
    if (snsNumberOrNull_(row.duration_sec) !== null) {
      return;
    }
    selected.push({ media_id: mediaId, type });
  });
  return selected;
}

// The media tab's rows for the debug entry points, read the
// way the collection reads them, as { rows, stop }: rows is the
// tab's objects on success, stop the log line the caller should
// print (and then return) when there is nothing to diagnose.
function debugReadMediaTabRows_() {
  let spreadsheet;
  try {
    spreadsheet = openHistorySpreadsheet_();
    if (!spreadsheet) {
      return {
        rows: null,
        stop: 'SNS_HISTORY_SHEET_ID is not set; nothing to diagnose.',
      };
    }
    const rows = readHistoryTabObjects_(
      spreadsheet,
      'media',
      SNS_HISTORY_MEDIA_COLUMNS
    );
    if (!rows) {
      return {
        rows: null,
        stop: 'the media tab does not exist; nothing to diagnose.',
      };
    }
    return { rows, stop: null };
  } catch (err) {
    return {
      rows: null,
      stop:
        'media tab could not be read: ' +
        String((err && err.message) || err).slice(0, 200),
    };
  }
}

// Manual diagnosis for the posts whose duration_sec is still
// missing (see the section header above). Reads the media tab
// the way the collection does, then diagnoses each selected
// post in turn; one post's failure is logged and never stops
// the rest. The media_url for each post comes from the Graph
// API (the tab does not store it): the recent media list
// first, a direct fetch by id for posts no longer in it.
function debugMediaDurationMissing() {
  const tab = debugReadMediaTabRows_();
  if (tab.stop) {
    Logger.log(tab.stop);
    return;
  }
  const rows = tab.rows;
  const targets = selectUnmeasuredDurationMediaRows_(
    rows,
    DEBUG_MEDIA_DURATION_MISSING_LIMIT
  );
  if (!targets.length) {
    Logger.log(
      'no REELS / VIDEO rows without a duration_sec in the media tab.'
    );
    return;
  }
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set; nothing to diagnose.');
    return;
  }
  const byId = {};
  const list = debugFetchMediaList_(token);
  if (list.error) {
    Logger.log(
      'media list failed: ' +
        list.error +
        ' (diagnosing via direct fetches instead)'
    );
  } else {
    list.items.forEach((item) => {
      if (item && item.id != null) {
        byId[String(item.id)] = item;
      }
    });
  }
  Logger.log(
    '=== debugMediaDurationMissing: ' +
      targets.length +
      ' unmeasured video(s) ==='
  );
  targets.forEach((target, index) => {
    Logger.log(
      '--- [' +
        (index + 1) +
        '/' +
        targets.length +
        '] media_id=' +
        target.media_id +
        ' type=' +
        target.type +
        ' ---'
    );
    try {
      let media = byId[target.media_id] || null;
      if (!media) {
        const one = debugFetchMediaById_(target.media_id, token);
        if (one.error) {
          Logger.log('direct fetch failed: ' + one.error);
          return;
        }
        media = one.media;
      }
      if (!media || !media.media_url) {
        Logger.log('media has no media_url to probe.');
        return;
      }
      debugLogMediaDurationProbes_(media);
    } catch (err) {
      Logger.log(
        'diagnosis failed: ' +
          String((err && err.message) || err).slice(0, 200)
      );
    }
  });
}

// One ranged GET for the duration debug functions, reporting
// the HTTP status alongside the bytes ({ status, bytes };
// status is null when the fetch itself threw, bytes null
// unless the status was 200 / 206). Never throws.
function debugProbeMediaRange_(mediaUrl, range) {
  let res;
  try {
    res = UrlFetchApp.fetch(mediaUrl, {
      muteHttpExceptions: true,
      headers: { Range: range },
    });
  } catch (err) {
    return { status: null, bytes: null };
  }
  const status = res.getResponseCode();
  if (status !== 200 && status !== 206) {
    return { status, bytes: null };
  }
  try {
    const content = res.getContent();
    return { status, bytes: content && content.length ? content : null };
  } catch (err) {
    return { status, bytes: null };
  }
}

// The media object fields whose values debugMediaUrlMissing may
// print: identifying labels only. Everything else about the
// object — above all the media_url value and any permalink —
// stays out of the log; only key names are shown.
const DEBUG_MEDIA_IDENTITY_FIELDS = [
  'media_type',
  'media_product_type',
  'status',
];

// What a media object offers the duration pipeline, without any
// of its values: whether a usable media_url is present, the key
// names it carries, and the identifying fields above. Pure, so
// the no-values-in-the-log rule is testable.
function summarizeMediaObjectForDebug_(media) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return null;
  }
  const identity = {};
  DEBUG_MEDIA_IDENTITY_FIELDS.forEach((name) => {
    const value = media[name];
    if (typeof value === 'string' && value !== '') {
      identity[name] = value;
    }
  });
  return {
    has_media_url:
      typeof media.media_url === 'string' && media.media_url !== '',
    keys: Object.keys(media),
    identity,
  };
}

// One log-ready line describing a media object from its summary
// (see summarizeMediaObjectForDebug_).
function debugDescribeMediaObject_(media) {
  const summary = summarizeMediaObjectForDebug_(media);
  if (!summary) {
    return '(no object)';
  }
  const identity = Object.keys(summary.identity)
    .map((name) => name + '=' + summary.identity[name])
    .join(' ');
  return (
    'media_url ' +
    (summary.has_media_url ? 'present' : 'ABSENT') +
    '; keys: ' +
    (summary.keys.length ? summary.keys.join(', ') : '(none)') +
    (identity ? '; ' + identity : '')
  );
}

// The per-media diagnosis debugMediaUrlMissing runs: what the
// recent-list object offers, what two direct-by-id fetches
// offer (no fields parameter at all, then the minimal fields
// the duration pipeline needs), and — when a direct fetch did
// return a media_url — the duration the collection path reads
// from it.
function debugLogMediaUrlSources_(mediaId, listMedia, token) {
  Logger.log(
    'recent list object: ' +
      (listMedia
        ? debugDescribeMediaObject_(listMedia)
        : '(not in the recent media list)')
  );
  const shapes = [
    ['no fields', null],
    [
      'fields=media_url,media_type,media_product_type',
      'media_url,media_type,media_product_type',
    ],
  ];
  let directMediaWithUrl = null;
  shapes.forEach(([label, fields]) => {
    const one = debugFetchMediaByIdWithFields_(mediaId, token, fields);
    if (one.error) {
      Logger.log('direct fetch (' + label + '): failed: ' + one.error);
      return;
    }
    Logger.log(
      'direct fetch (' + label + '): ' + debugDescribeMediaObject_(one.media)
    );
    if (!directMediaWithUrl && one.media && one.media.media_url) {
      directMediaWithUrl = one.media;
    }
  });
  if (directMediaWithUrl) {
    Logger.log(
      'fetchMediaDurationSec_ (via a direct fetch): ' +
        fetchMediaDurationSec_(directMediaWithUrl.media_url) +
        ' sec'
    );
    return;
  }
  Logger.log(
    'no media_url from either direct fetch; the duration was not probed.'
  );
}

// Manual diagnosis for where the media_url goes missing (see
// the section header above). Selects the unmeasured posts the
// same way debugMediaDurationMissing does, then compares what
// each request shape returns for them; one post's failure is
// logged and never stops the rest.
function debugMediaUrlMissing() {
  const tab = debugReadMediaTabRows_();
  if (tab.stop) {
    Logger.log(tab.stop);
    return;
  }
  const targets = selectUnmeasuredDurationMediaRows_(
    tab.rows,
    DEBUG_MEDIA_DURATION_MISSING_LIMIT
  );
  if (!targets.length) {
    Logger.log(
      'no REELS / VIDEO rows without a duration_sec in the media tab.'
    );
    return;
  }
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    Logger.log('META_ACCESS_TOKEN is not set; nothing to diagnose.');
    return;
  }
  const byId = {};
  const list = debugFetchMediaList_(token);
  if (list.error) {
    Logger.log(
      'media list failed: ' +
        list.error +
        ' (checking the direct fetches instead)'
    );
  } else {
    list.items.forEach((item) => {
      if (item && item.id != null) {
        byId[String(item.id)] = item;
      }
    });
  }
  Logger.log(
    '=== debugMediaUrlMissing: ' +
      targets.length +
      ' unmeasured video(s) ==='
  );
  targets.forEach((target, index) => {
    Logger.log(
      '--- [' +
        (index + 1) +
        '/' +
        targets.length +
        '] media_id=' +
        target.media_id +
        ' type=' +
        target.type +
        ' ---'
    );
    try {
      debugLogMediaUrlSources_(
        target.media_id,
        byId[target.media_id] || null,
        token
      );
    } catch (err) {
      Logger.log(
        'diagnosis failed: ' +
          String((err && err.message) || err).slice(0, 200)
      );
    }
  });
}


export { debugMediaDuration, debugMediaDurationMissing, debugMediaUrlMissing, selectUnmeasuredDurationMediaRows_, summarizeMediaObjectForDebug_ };
