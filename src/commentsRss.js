// Comments RSS rendering (action=comments_rss) for /reader.

import { getScriptProperty_ } from './auth.js';
import { SNS_HISTORY_SHEET_ID_PROPERTY, summarizeSnsHistoryError_ } from './historyWrite.js';
import { compareTimestampDesc_, historyTextOrNull_, historyTimestampOrNull_, openHistorySpreadsheet_, readHistoryTabObjects_ } from './sheetRead.js';
import { jsonOut_ } from './ga4.js';
import { COMMENTS_RSS_CHANNELS, COMMENTS_RSS_TOKEN_PROPERTY, SNS_COMMENTS_RSS_LIMIT, SNS_COMMENTS_RSS_TITLE_CHARS } from './comments.js';

function escapeXmlText_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlOut_(xml) {
  return ContentService.createTextOutput(xml).setMimeType(
    ContentService.MimeType.XML
  );
}

// Builds the RSS 2.0 document for one source from normalized
// rows ({ id, username, text, posted_at, permalink }): newest
// first, at most SNS_COMMENTS_RSS_LIMIT items. The guid is the
// platform's comment / reply id itself — immutable, so a stored
// comment can never reappear as a new article the way a
// regenerated id made the X notification feed repeat items.
// pubDate is Date#toUTCString(), strict RFC 822. Rows whose
// posted_at does not parse are skipped: an item without a valid
// pubDate would poison the whole feed for strict readers.
function buildCommentsRss_(source, rows) {
  const channel = COMMENTS_RSS_CHANNELS[source];
  const items = (rows || [])
    .slice()
    .sort((a, b) => compareTimestampDesc_(a.posted_at, b.posted_at))
    .slice(0, SNS_COMMENTS_RSS_LIMIT);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '<channel>',
    '<title>' + escapeXmlText_(channel.title) + '</title>',
    '<link>' + escapeXmlText_(channel.link) + '</link>',
    '<description>' + escapeXmlText_(channel.description) + '</description>',
  ];
  items.forEach((row) => {
    const when = new Date(row.posted_at || '');
    if (Number.isNaN(when.getTime()) || !row.id) {
      return;
    }
    const text = row.text || '';
    const title =
      '@' +
      (row.username || '') +
      ': ' +
      text.slice(0, SNS_COMMENTS_RSS_TITLE_CHARS);
    lines.push(
      '<item>',
      '<title>' + escapeXmlText_(title) + '</title>',
      '<link>' + escapeXmlText_(row.permalink || channel.link) + '</link>',
      '<guid isPermaLink="false">' + escapeXmlText_(row.id) + '</guid>',
      '<pubDate>' + when.toUTCString() + '</pubDate>',
      '<description>' + escapeXmlText_(text) + '</description>',
      '</item>'
    );
  });
  lines.push('</channel>', '</rss>');
  return lines.join('\n');
}

// The stored rows of one source's tab, normalized to the shape
// buildCommentsRss_ consumes. A missing tab reads as no rows.
function commentsRssRows_(spreadsheet, source) {
  const channel = COMMENTS_RSS_CHANNELS[source];
  const rows = readHistoryTabObjects_(
    spreadsheet,
    channel.tab,
    channel.columns
  );
  if (!rows) {
    return [];
  }
  return rows
    .map((row) => ({
      id: historyTextOrNull_(row[channel.idColumn]) || '',
      username: historyTextOrNull_(row.username) || '',
      text: historyTextOrNull_(row.text) || '',
      posted_at: historyTimestampOrNull_(row.posted_at) || '',
      permalink: historyTextOrNull_(row.permalink) || '',
    }))
    .filter((row) => row.id);
}

// Serves action=comments_rss. The token check comes first and
// fails closed: an unset COMMENTS_RSS_TOKEN refuses every
// request, and a mismatch answers a JSON 403-shaped refusal —
// never the feed. An unknown source is a 400-shaped refusal.
// With the history sheet unconfigured the feed is simply empty.
function serveCommentsRss_(parameter) {
  const expected = getScriptProperty_(COMMENTS_RSS_TOKEN_PROPERTY);
  if (!expected || !parameter.token || parameter.token !== expected) {
    return jsonOut_({ ok: false, status: 403, error: 'invalid token' });
  }
  const source = parameter.source || '';
  if (!COMMENTS_RSS_CHANNELS[source]) {
    return jsonOut_({ ok: false, status: 400, error: 'unknown source' });
  }
  let rows = [];
  try {
    const spreadsheet = openHistorySpreadsheet_();
    if (spreadsheet) {
      rows = commentsRssRows_(spreadsheet, source);
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
  return xmlOut_(buildCommentsRss_(source, rows));
}


export { buildCommentsRss_, commentsRssRows_, escapeXmlText_, serveCommentsRss_, xmlOut_ };
