// X reaction detail: the notify RSS feed collected into the
// x_reactions history tab.

import { getScriptProperty_ } from './auth.js';
import { SNS_DAY_MS } from './instagramDaily.js';
import { SNS_CAPTION_MAX_LENGTH } from './instagramMedia.js';
import { readSnsHistoryRows_, snsHistoryTextCell_, upsertSnsHistorySheet_ } from './historyWrite.js';
import { historyTextOrNull_, historyTimestampOrNull_, readHistoryTabObjects_ } from './sheetRead.js';

// --- X reaction detail (notify RSS -> "x_reactions" tab) ---
// The per-post counts say how many reactions a post got; this
// section keeps who reacted and, for replies and quotes, what
// they wrote. The source is the notify RSS x-cli writes hourly
// on the home server (the X_NOTIFY_URL property points at it)
// — the same feed /reader reads. Each item carries the base
// RSS elements (title / link / description / pubDate / guid)
// plus the generator's xn-namespaced extensions (namespace
// https://freddiefujiwara.com/ns/x-notify): xn:kind, one
// xn:actor per named actor (username attribute, display name
// as the body), xn:tweet-id and xn:message. The guid is the
// stable identity the RSS conversion already maintains
// (x-notify-<kind>-<first actor username>-<tweetId>); the
// notification's own entry id rotates on X's side and is
// never used. The parser prefers the extension elements and
// falls back to the guid / title, so a feed without the
// extensions still yields the first actor of each item. The
// feed is a rolling window, so the stored rows are facts
// accumulated from the first collection on: a reaction is
// stored the first time a notification carrying it is seen,
// and nothing is ever backfilled for the time before the
// feature started. Aggregated like notifications only name
// the actors X chose to list, so the stored likers can stay
// a subset of the post's like count.
//
// Facts land in the history spreadsheet's "x_reactions" tab,
// one row per reaction fact, upserted by reaction_key:
//   like / retweet: kind|tweet_id|actor_username — one row
//     per named actor of the (possibly aggregated)
//     notification. Only for these kinds does the item's
//     tweet-id name one of the owner's posts, so only they
//     attach to a post.
//   reply / quote: kind|reaction_tweet_id — the item is the
//     reaction itself (its author, its body in description,
//     its moment in pubDate), and the notify data carries no
//     pointer to the post it answers, so the row stays
//     unattributed (tweet_id empty) and the read side serves
//     it separately, never under a guessed post.
//   follow: follow||actor_username — account-level, no post.
// The feed carries no per-notification timestamp either
// (pubDate is the tweet's own moment), so a fact's moment is
// pubDate for replies and quotes (acted_at — there the tweet
// is the reaction) and simply the first collection that saw
// it (collected_at) for the rest. Like the stats file, the
// notify feed is an optimisation, never a dependency: an
// unset X_NOTIFY_URL, a failed fetch (the file briefly
// disappears in the early-morning hours while the home
// server tidies its feed files), or a body with no items
// all skip the update and keep the stored rows untouched.

const X_NOTIFY_URL_PROPERTY = 'X_NOTIFY_URL';
const SNS_X_REACTIONS_TAB = 'x_reactions';
// Keyed by its first column (reaction_key), like the comment
// tabs: a reaction fact has no use for a leading timestamp.
const SNS_HISTORY_X_REACTIONS_COLUMNS = [
  'reaction_key',
  'kind',
  'tweet_id',
  'actor_name',
  'actor_username',
  'text',
  'reaction_tweet_id',
  'acted_at',
  'collected_at',
];
const SNS_X_REACTION_KINDS = ['like', 'retweet', 'reply', 'quote', 'follow'];
// Stored reaction rows older than this (by collected_at) are
// pruned during collection. The screen only ever shows the
// newest SNS_X_RECENT_POSTS_LIMIT posts — about two months of
// posting — so 120 days keeps every reaction those posts can
// still display, with slack.
// (Defined locally rather than reusing the comments retention:
// that one keys on posted_at at 60 days, a different contract.)
const SNS_X_REACTIONS_RETENTION_DAYS = 120;
// Follow rows served in sns_detail: the screen shows a compact
// "recent follows" line, not a follower registry.
const SNS_X_RECENT_FOLLOWS_LIMIT = 10;
// Unattributed replies / quotes served in sns_detail: a
// reading list, newest first, not an archive.
const SNS_X_UNATTRIBUTED_LIMIT = 20;

// The notify feed's raw XML, or null when this run must not
// touch the stored reactions: X_NOTIFY_URL unset, the fetch
// failed or did not answer 200, or the body does not look
// like a feed with items (a partial write on the server side
// is not "no reactions"). Never throws.
function fetchXNotifyFeed_() {
  const url = getScriptProperty_(X_NOTIFY_URL_PROPERTY);
  if (!url) {
    return null;
  }
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    return null;
  }
  if (res.getResponseCode() !== 200) {
    return null;
  }
  const text = res.getContentText();
  if (!text || text.indexOf('<item') === -1) {
    return null;
  }
  return text;
}

// Decodes one RSS element body: a CDATA section unwraps to
// its literal text, anything else is entity-decoded (&amp;
// and friends plus numeric references).
function xFeedElementText_(raw) {
  if (raw === null || raw === undefined) {
    return '';
  }
  const text = String(raw).trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) {
    return cdata[1];
  }
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (match, dec) =>
      String.fromCharCode(parseInt(dec, 10))
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// The body of the first element with the given local name in
// one item's XML, whatever prefix (or none) it carries, or
// null when the item has no such element. The notify feed is
// machine-generated with a fixed shape, so this deliberately
// small extractor — instead of a full XML parser — is what
// the collection uses; it only ever reads the one feed.
function xFeedFirstElement_(itemXml, localName) {
  const pattern = new RegExp(
    '<(?:[A-Za-z_][\\w.-]*:)?' +
      localName +
      '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?' +
      localName +
      '>'
  );
  const match = String(itemXml).match(pattern);
  return match ? xFeedElementText_(match[1]) : null;
}

// Every xn:actor of one item as { name, username }: the
// username rides in the attribute, the display name is the
// element body. Elements without a username cannot key a
// fact and are dropped.
function xFeedActors_(itemXml) {
  const actors = [];
  const pattern =
    /<(?:[A-Za-z_][\w.-]*:)?actor\s+username="([^"]*)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?actor>/g;
  let match;
  while ((match = pattern.exec(String(itemXml))) !== null) {
    const username = xFeedElementText_(match[1]);
    if (!username) {
      continue;
    }
    actors.push({ name: xFeedElementText_(match[2]), username });
  }
  return actors;
}

// The guid's three payload segments —
// x-notify-<kind>-<first actor username>-<tweetId> — as
// { kind, username, tweetId }, or null when the guid does not
// carry that shape. Follow guids end after the username (no
// tweetId). The fallback for every field the extension
// elements name directly.
function xNotifyGuidParts_(guid) {
  const parts = String(guid || '').split('-');
  if (parts.length < 4 || parts[0] !== 'x' || parts[1] !== 'notify') {
    return null;
  }
  return {
    kind: parts[2] || '',
    username: parts[3] || '',
    tweetId: parts.length > 4 ? parts.slice(4).join('-') : '',
  };
}

// The title's display name: titles read
// "<name> (@<username>) - <kind>", so the name is what leads
// up to the handle parenthesis. Null when the shape differs.
function xNotifyTitleName_(title) {
  const match = String(title || '').match(/^([\s\S]*?) \(@[^)]+\) - \w+$/);
  return match ? match[1] : null;
}

// Parses the notify feed into normalized items:
// { guid, kind, actors, tweetId, text, actedAt } — text is
// the item's description (the post's text for likes and
// reposts, the reaction's own body for replies and quotes)
// and actedAt is pubDate as ISO (the tweet's moment; for
// replies and quotes, the reaction's). Items the parser
// cannot place at all (no kind from either the extension or
// the guid) are dropped here; kind filtering happens in
// buildXReactionRows_.
function parseXNotifyFeed_(xmlText) {
  const items = [];
  const pattern = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = pattern.exec(String(xmlText || ''))) !== null) {
    const itemXml = match[1];
    const guid = xFeedFirstElement_(itemXml, 'guid') || '';
    const guidParts = xNotifyGuidParts_(guid);
    const kind =
      xFeedFirstElement_(itemXml, 'kind') ||
      (guidParts ? guidParts.kind : '') ||
      '';
    if (!kind) {
      continue;
    }
    let actors = xFeedActors_(itemXml);
    if (!actors.length && guidParts && guidParts.username) {
      actors = [
        {
          name: xNotifyTitleName_(xFeedFirstElement_(itemXml, 'title')) || '',
          username: guidParts.username,
        },
      ];
    }
    const tweetId =
      xFeedFirstElement_(itemXml, 'tweet-id') ||
      (guidParts ? guidParts.tweetId : '') ||
      '';
    items.push({
      guid,
      kind,
      actors,
      tweetId,
      text: xFeedFirstElement_(itemXml, 'description') || '',
      actedAt: xNotifyDateToIso_(xFeedFirstElement_(itemXml, 'pubDate')),
    });
  }
  return items;
}

// The feed's date strings (RFC 822, "Wed, 18 Nov 2026
// 12:51:28 +0000") normalized to ISO, or null when the value
// does not parse — an unreadable moment is stored as empty
// rather than guessed.
function xNotifyDateToIso_(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Expands the parsed notify items into "x_reactions" rows
// (see the section header for the keying rules). Pure: the
// same notification seen again in a later feed expands to
// the same keys, and the collector only offers keys the tab
// does not already hold, so re-scans never duplicate or
// refresh a stored fact. Within one feed, repeated keys
// collapse to the first expansion.
function buildXReactionRows_(items, collectedAt) {
  const rows = [];
  const seen = {};
  const push = (row) => {
    const key = row[0];
    if (!key || seen[key]) {
      return;
    }
    seen[key] = true;
    rows.push(row);
  };
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const kind = String(item.kind || '');
    if (SNS_X_REACTION_KINDS.indexOf(kind) === -1) {
      return;
    }
    const actors = (Array.isArray(item.actors) ? item.actors : []).filter(
      (actor) => actor && actor.username
    );
    if (kind === 'reply' || kind === 'quote') {
      // The item is the reaction itself; the notify data
      // names no target post, so the row stays unattributed.
      const reactionId = String(item.tweetId || '');
      const author = actors[0] || null;
      if (!reactionId || !author) {
        return;
      }
      push([
        snsHistoryTextCell_(kind + '|' + reactionId),
        snsHistoryTextCell_(kind),
        snsHistoryTextCell_(''),
        snsHistoryTextCell_(author.name || ''),
        snsHistoryTextCell_(author.username),
        snsHistoryTextCell_(
          String(item.text || '').slice(0, SNS_CAPTION_MAX_LENGTH)
        ),
        snsHistoryTextCell_(reactionId),
        snsHistoryTextCell_(item.actedAt || ''),
        snsHistoryTextCell_(collectedAt),
      ]);
      return;
    }
    if (kind === 'follow') {
      actors.forEach((actor) => {
        push([
          snsHistoryTextCell_('follow||' + actor.username),
          snsHistoryTextCell_(kind),
          snsHistoryTextCell_(''),
          snsHistoryTextCell_(actor.name || ''),
          snsHistoryTextCell_(actor.username),
          snsHistoryTextCell_(''),
          snsHistoryTextCell_(''),
          snsHistoryTextCell_(''),
          snsHistoryTextCell_(collectedAt),
        ]);
      });
      return;
    }
    // like / retweet: the item's tweet-id is the post reacted
    // to; every named actor is one fact.
    const target = String(item.tweetId || '');
    if (!target) {
      return;
    }
    actors.forEach((actor) => {
      push([
        snsHistoryTextCell_(kind + '|' + target + '|' + actor.username),
        snsHistoryTextCell_(kind),
        snsHistoryTextCell_(target),
        snsHistoryTextCell_(actor.name || ''),
        snsHistoryTextCell_(actor.username),
        snsHistoryTextCell_(''),
        snsHistoryTextCell_(''),
        snsHistoryTextCell_(''),
        snsHistoryTextCell_(collectedAt),
      ]);
    });
  });
  return rows;
}

// Drops the stored reaction rows whose collected_at is older
// than the retention window, rewriting the tab in place (the
// pruneOldCommentRows_ write pattern, on collected_at instead
// of posted_at). Rows whose collected_at does not parse are
// kept: an unreadable timestamp is not proof of age.
function pruneXReactionRows_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SNS_X_REACTIONS_TAB);
  if (!sheet) {
    return 0;
  }
  const columns = SNS_HISTORY_X_REACTIONS_COLUMNS;
  const rows = readSnsHistoryRows_(sheet, columns);
  if (!rows.length) {
    return 0;
  }
  const collectedIndex = columns.indexOf('collected_at');
  const cutoff = Date.now() - SNS_X_REACTIONS_RETENTION_DAYS * SNS_DAY_MS;
  const kept = rows.filter((row) => {
    const iso = historyTimestampOrNull_(row[collectedIndex]);
    const at = iso ? Date.parse(iso) : NaN;
    return !Number.isFinite(at) || at >= cutoff;
  });
  const dropped = rows.length - kept.length;
  if (!dropped) {
    return 0;
  }
  if (kept.length) {
    sheet.getRange(2, 1, kept.length, columns.length).setValues(kept);
  }
  const surplus = sheet.getLastRow() - (kept.length + 1);
  if (surplus > 0) {
    sheet.deleteRows(kept.length + 2, surplus);
  }
  return dropped;
}

// The X half of the comments-style collection: fetches the
// notify feed and stores the reaction facts the tab does not
// hold yet. Returns { stored, error }; a skipped update (see
// fetchXNotifyFeed_) is neither stored nor an error, and
// failures never throw — the hosting collection still counts
// as a success.
function collectXReactions_(spreadsheet, collectedAt) {
  const result = { stored: 0, error: null };
  const feedText = fetchXNotifyFeed_();
  if (!feedText) {
    return result;
  }
  const items = parseXNotifyFeed_(feedText);
  if (!items.length) {
    return result;
  }
  const storedRows =
    readHistoryTabObjects_(
      spreadsheet,
      SNS_X_REACTIONS_TAB,
      SNS_HISTORY_X_REACTIONS_COLUMNS
    ) || [];
  const storedKeys = {};
  storedRows.forEach((row) => {
    const key = historyTextOrNull_(row.reaction_key);
    if (key) {
      storedKeys[key] = true;
    }
  });
  const newRows = buildXReactionRows_(items, collectedAt).filter(
    (row) => !storedKeys[row[0]]
  );
  if (newRows.length) {
    upsertSnsHistorySheet_(
      spreadsheet,
      SNS_X_REACTIONS_TAB,
      SNS_HISTORY_X_REACTIONS_COLUMNS,
      0,
      newRows
    );
    result.stored = newRows.length;
  }
  pruneXReactionRows_(spreadsheet);
  return result;
}


export { SNS_HISTORY_X_REACTIONS_COLUMNS, SNS_X_REACTIONS_TAB, SNS_X_RECENT_FOLLOWS_LIMIT, SNS_X_UNATTRIBUTED_LIMIT, buildXReactionRows_, collectXReactions_, fetchXNotifyFeed_, parseXNotifyFeed_, xFeedFirstElement_, xNotifyDateToIso_ };
