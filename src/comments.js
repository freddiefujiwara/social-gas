// Post comments / replies / DM collection into the history
// spreadsheet (the source of the /reader RSS feeds).

import { getScriptProperty_ } from './auth.js';
import { META_GRAPH_BASE, SNS_FACEBOOK_PAGE_ID, SNS_INSTAGRAM_MAIN_ID, THREADS_GRAPH_BASE, snsNumberOrNull_, threadsToken_ } from './snsCounts.js';
import { collectXReactions_ } from './xReactions.js';
import { fetchInsightsJson_, graphFieldsParam_ } from './instagramDetail.js';
import { SNS_DAY_MS } from './instagramDaily.js';
import { SNS_CAPTION_MAX_LENGTH } from './instagramMedia.js';
import { SNS_HISTORY_MEDIA_COLUMNS, SNS_HISTORY_SHEET_ID_PROPERTY, SNS_HISTORY_THREADS_MEDIA_COLUMNS, readSnsHistoryRows_, snsHistoryNumCell_, snsHistoryTextCell_, summarizeSnsHistoryError_, upsertSnsHistorySheet_ } from './historyWrite.js';
import { historyTextOrNull_, historyTimestampOrNull_, readHistoryTabObjects_ } from './sheetRead.js';

// --- Post comments / replies (collection + RSS for /reader) ---
// /reader wants the comments on the owner's Instagram posts and
// the replies to the owner's Threads posts as RSS feeds, in the
// same "everything becomes a feed" shape as the X notification
// feeds. The official APIs expose no notification timeline, but
// the comments / replies on one's own posts are readable, so the
// hourly collection gathers those and this section serves them
// back as RSS 2.0:
//
//   - collectPostComments_() rides collectSnsCounts(): it diffs
//     the counts the snapshot just fetched (media.comments /
//     posts.replies) against the counts the history tabs still
//     store from the previous run, and only for the posts whose
//     count grew does it fetch the detail (IG: the media's
//     comments edge with replies expanded; Threads: the post's
//     conversation edge). Rows land in the history spreadsheet's
//     "ig_comments" / "threads_replies" tabs, upserted by the
//     platform's immutable comment / reply id, and rows whose
//     posted_at is over 60 days old are pruned on the same run —
//     the window /reader itself keeps.
//   - GET /exec?action=comments_rss&source=instagram|threads
//     |instagram_dm&token=... returns the newest 50 stored
//     rows as RSS. The
//     request never calls the platform APIs; it only reads the
//     tabs. The token must match the Script Property
//     COMMENTS_RSS_TOKEN (the shared-token pattern of the
//     tweet-gas sync and groq-gas): while the property is unset
//     the feed refuses every request, so deploying this code
//     alone exposes nothing — the feed carries comment text and
//     is never served unauthenticated.
//
// Scope prerequisites (re-authorized by the owner; the code
// degrades to per-source errors without them): IG needs
// instagram_manage_comments on the Meta token, Threads needs
// threads_read_replies (see the THREADS_OAUTH_SCOPES change),
// and the DM collection additionally needs
// instagram_manage_messages plus pages_manage_metadata /
// pages_read_engagement / pages_show_list on the Meta token —
// Instagram messaging on the Facebook Login path runs through
// the linked Facebook Page and its Page access token. The
// Instagram app's "allow access to messages" toggle (message
// controls / connected tools) must also be on.
// A post's first-ever detail fetch reaches back only a fixed
// grace window before the previous collection observed the
// post, so enabling the feature does not flood the feed with
// the comments that were already there — while a comment the
// platform's counts were slow to reflect is not lost either
// (see SNS_COMMENTS_BOUNDARY_GRACE_MS).

const COMMENTS_RSS_TOKEN_PROPERTY = 'COMMENTS_RSS_TOKEN';
const SNS_IG_COMMENTS_TAB = 'ig_comments';
const SNS_THREADS_REPLIES_TAB = 'threads_replies';
// Both tabs are keyed by their first column (the platform's
// comment / reply id), unlike the media tabs whose key follows
// collected_at: a comment row has no use for a leading timestamp.
const SNS_HISTORY_IG_COMMENTS_COLUMNS = [
  'comment_id',
  'media_id',
  'parent_comment_id',
  'username',
  'text',
  'posted_at',
  'like_count',
  'permalink',
  'collected_at',
];
const SNS_HISTORY_THREADS_REPLIES_COLUMNS = [
  'reply_id',
  'post_id',
  'username',
  'text',
  'posted_at',
  'permalink',
  'collected_at',
];
const SNS_IG_DM_TAB = 'ig_dm';
// Instagram direct messages (received ones only), collected
// through the linked Page's conversations edge — see
// collectInstagramDm_. Keyed by the platform's message id,
// like the comment tabs. Conversations have no public
// permalink, so every row points at the inbox.
const SNS_HISTORY_IG_DM_COLUMNS = [
  'message_id',
  'conversation_id',
  'username',
  'text',
  'posted_at',
  'permalink',
  'collected_at',
];
const SNS_IG_DM_INBOX_URL = 'https://www.instagram.com/direct/inbox/';
// Conversations scanned per collection and messages read per
// conversation. The cadence is hourly and dedupe is by message
// id, so these windows only bound the API fan-out; a message
// is stored the first time it appears inside them.
const SNS_DM_CONVERSATION_LIMIT = 10;
const SNS_DM_MESSAGE_LIMIT = 25;
// Placeholder text for a message with no text body (an image,
// a shared post, a voice note): the arrival itself is what the
// feed reports, so the row is kept with this marker.
const SNS_DM_ATTACHMENT_TEXT = '（添付メッセージ）';
// Stored comments older than this are pruned during collection;
// it matches the retention /reader applies to its local store.
const SNS_COMMENTS_RETENTION_DAYS = 60;
// How far back a post's first-ever detail fetch reaches: the
// previous observation moment minus this grace. The stored
// comment count only reflects a new comment once the
// platform's numbers catch up, which can trail the comment
// itself by a collection or more; the unshifted moment would
// sit after such a comment and drop it for good — the count
// stops growing afterwards, so no later fetch ever retries
// it. (This race is why the feed stayed empty after launch:
// growth was consistently detected one collection too late.)
const SNS_COMMENTS_BOUNDARY_GRACE_MS = 2 * SNS_DAY_MS;
// Items per RSS response (the newest ones win).
const SNS_COMMENTS_RSS_LIMIT = 50;
// Comments requested per detail fetch. The APIs return newest
// first and a count diff is normally a handful of comments, so
// one page is the whole story in practice.
const SNS_COMMENTS_PAGE_LIMIT = 50;
// Detail fetches per source per collection, as a runaway guard:
// a burst beyond this is picked up by the following collections
// (the stored counts keep lagging until the detail lands).
const SNS_COMMENTS_DETAIL_FETCH_MAX = 5;
// Characters of the comment text the RSS item title carries.
const SNS_COMMENTS_RSS_TITLE_CHARS = 60;

const COMMENTS_RSS_CHANNELS = {
  instagram: {
    tab: SNS_IG_COMMENTS_TAB,
    columns: SNS_HISTORY_IG_COMMENTS_COLUMNS,
    idColumn: 'comment_id',
    title: 'Instagram コメント（@freddiefujiwara）',
    link: 'https://www.instagram.com/freddiefujiwara/',
    description: '自分の Instagram 投稿へのコメントと返信',
  },
  threads: {
    tab: SNS_THREADS_REPLIES_TAB,
    columns: SNS_HISTORY_THREADS_REPLIES_COLUMNS,
    idColumn: 'reply_id',
    title: 'Threads 返信（@freddiefujiwara）',
    link: 'https://www.threads.net/@freddiefujiwara',
    description: '自分の Threads 投稿への返信',
  },
  instagram_dm: {
    tab: SNS_IG_DM_TAB,
    columns: SNS_HISTORY_IG_DM_COLUMNS,
    idColumn: 'message_id',
    title: 'Instagram DM（@freddiefujiwara）',
    link: SNS_IG_DM_INBOX_URL,
    description: 'Instagram で受け取ったダイレクトメッセージ',
  },
};

// The stored per-post counts of one history tab as
// { id: { count, collected_at } }: the baseline the next
// collection diffs against. Rows whose count cell does not read
// as a number keep a null count and never trigger a fetch.
function previousCountsById_(rows, idColumn, countColumn) {
  const byId = {};
  (rows || []).forEach((row) => {
    const id = historyTextOrNull_(row && row[idColumn]);
    if (!id) {
      return;
    }
    byId[id] = {
      count: snsNumberOrNull_(row[countColumn]),
      collected_at: historyTextOrNull_(row.collected_at) || '',
    };
  });
  return byId;
}

// Which posts to fetch detail for: the ones present in the
// previous baseline whose count grew. A post with no baseline
// row (first seen this run) is skipped — its current count
// becomes the baseline when the history upsert lands, and only
// growth after that fetches detail. Capped so one collection
// never fans out beyond SNS_COMMENTS_DETAIL_FETCH_MAX fetches.
function planCommentTargets_(freshCounts, previousById, maxTargets) {
  const targets = [];
  (freshCounts || []).forEach((entry) => {
    if (!entry || !entry.id) {
      return;
    }
    const prev = previousById ? previousById[entry.id] : null;
    if (!prev) {
      return;
    }
    if (typeof entry.count !== 'number' || typeof prev.count !== 'number') {
      return;
    }
    if (entry.count > prev.count) {
      targets.push({ id: entry.id, prevCollectedAt: prev.collected_at || '' });
    }
  });
  return targets.slice(0, maxTargets);
}

// The stored comments of one post as { postId: boundary }: the
// boundary is the oldest stored posted_at, the line the next
// fetch filters against. A post absent from the map has no
// stored comments yet.
function oldestStoredCommentByPost_(rows, postColumn) {
  const byPost = {};
  (rows || []).forEach((row) => {
    const postId = historyTextOrNull_(row && row[postColumn]);
    if (!postId) {
      return;
    }
    const iso = historyTimestampOrNull_(row.posted_at);
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) {
      return;
    }
    if (!(postId in byPost) || at < byPost[postId].at) {
      byPost[postId] = { at, iso };
    }
  });
  const boundaries = {};
  Object.keys(byPost).forEach((postId) => {
    boundaries[postId] = byPost[postId].iso;
  });
  return boundaries;
}

// Keeps only the comments posted after a boundary instant. The
// boundary is what stops the feed from filling with comments
// that predate the feature: on a post's first-ever detail fetch
// it is the moment the previous collection observed the post
// (the stored media row's collected_at), and afterwards it is
// the oldest stored comment's posted_at — a comment that
// arrived since is always newer than both, while the rest of
// the fetched page is either already stored (the id-keyed
// upsert would dedupe it) or older than the feature. An
// unreadable boundary keeps nothing: baselining silently is
// safer than importing blindly.
function filterCommentsAfter_(comments, boundaryIso) {
  const since = Date.parse(boundaryIso || '');
  if (!Number.isFinite(since)) {
    return [];
  }
  return (comments || []).filter((comment) => {
    const at = Date.parse((comment && comment.posted_at) || '');
    return Number.isFinite(at) && at > since;
  });
}

// The first-fetch boundary for a post with no stored
// comments: the previous observation moment shifted back by
// SNS_COMMENTS_BOUNDARY_GRACE_MS. An unreadable moment stays
// unreadable, so filterCommentsAfter_ keeps nothing
// (baselining silently beats importing blindly).
function firstFetchBoundary_(prevCollectedAtIso) {
  const at = Date.parse(prevCollectedAtIso || '');
  if (!Number.isFinite(at)) {
    return '';
  }
  return new Date(at - SNS_COMMENTS_BOUNDARY_GRACE_MS).toISOString();
}

// One IG comments page (newest first) flattened to plain comment
// objects: top-level comments with parent_id '' and their
// replies with the parent's id. The media's comments insight
// count includes the replies, so both halves belong to the feed.
function parseInstagramComments_(data) {
  const items = data && Array.isArray(data.data) ? data.data : [];
  const comments = [];
  const toComment = (item, parentId) => ({
    id: String(item.id),
    parent_id: parentId,
    username: item.username != null ? String(item.username) : '',
    text: item.text != null ? String(item.text) : '',
    posted_at: item.timestamp || '',
    like_count: snsNumberOrNull_(item.like_count),
  });
  items.forEach((item) => {
    if (!item || item.id == null) {
      return;
    }
    comments.push(toComment(item, ''));
    const replies =
      item.replies && Array.isArray(item.replies.data) ? item.replies.data : [];
    replies.forEach((reply) => {
      if (!reply || reply.id == null) {
        return;
      }
      comments.push(toComment(reply, String(item.id)));
    });
  });
  return comments;
}

// Fetches one media's comments page. Returns { comments, error }
// in the fetchInsightsJson_ shape of habits: error is a short
// secret-free summary (the media id plus the API summary).
function fetchInstagramComments_(mediaId, token) {
  const res = fetchInsightsJson_(
    META_GRAPH_BASE +
      mediaId +
      '/comments?' +
      graphFieldsParam_(
        'id,text,username,timestamp,like_count,' +
          'replies{id,text,username,timestamp,like_count}'
      ) +
      '&limit=' +
      SNS_COMMENTS_PAGE_LIMIT +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (res.error) {
    return { comments: null, error: String(mediaId) + ': ' + res.error };
  }
  if (!res.data || !Array.isArray(res.data.data)) {
    return {
      comments: null,
      error: String(mediaId) + ': response had no comments array',
    };
  }
  return { comments: parseInstagramComments_(res.data), error: null };
}

// One Threads conversation page flattened to plain reply
// objects. The conversation edge returns every depth of reply
// (each still addressed to the root post this feed is about),
// and it includes the owner's own replies: those are dropped
// (is_reply_owned_by_me), as is the root post itself when the
// edge echoes it back.
function parseThreadsConversation_(data, postId) {
  const items = data && Array.isArray(data.data) ? data.data : [];
  const replies = [];
  items.forEach((item) => {
    if (!item || item.id == null) {
      return;
    }
    if (String(item.id) === String(postId)) {
      return;
    }
    if (item.is_reply_owned_by_me === true) {
      return;
    }
    replies.push({
      id: String(item.id),
      username: item.username != null ? String(item.username) : '',
      text: item.text != null ? String(item.text) : '',
      posted_at: item.timestamp || '',
      permalink: item.permalink || '',
    });
  });
  return replies;
}

// Fetches one post's conversation page. Returns
// { replies, error } like fetchInstagramComments_.
function fetchThreadsConversation_(postId, token) {
  const res = fetchInsightsJson_(
    THREADS_GRAPH_BASE +
      postId +
      '/conversation?fields=id,text,username,permalink,timestamp,' +
      'is_reply_owned_by_me&limit=' +
      SNS_COMMENTS_PAGE_LIMIT +
      '&access_token=' +
      encodeURIComponent(token)
  );
  if (res.error) {
    return { replies: null, error: String(postId) + ': ' + res.error };
  }
  if (!res.data || !Array.isArray(res.data.data)) {
    return {
      replies: null,
      error: String(postId) + ': response had no conversation array',
    };
  }
  return { replies: parseThreadsConversation_(res.data, postId), error: null };
}

// Drops the stored rows of one comments tab whose posted_at is
// older than the retention window, rewriting the tab in place
// (the same write pattern as upsertSnsHistorySheet_). Rows whose
// posted_at does not parse are kept: an unreadable timestamp is
// not proof of age. Returns the number of rows dropped.
function pruneOldCommentRows_(spreadsheet, tabName, columns) {
  const sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) {
    return 0;
  }
  const rows = readSnsHistoryRows_(sheet, columns);
  if (!rows.length) {
    return 0;
  }
  const postedIndex = columns.indexOf('posted_at');
  const cutoff = Date.now() - SNS_COMMENTS_RETENTION_DAYS * SNS_DAY_MS;
  const kept = rows.filter((row) => {
    const iso = historyTimestampOrNull_(row[postedIndex]);
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

// The Instagram half of collectPostComments_: fetches the
// comments of the media whose stored count grew and upserts
// them into ig_comments. Returns { stored, error }; failures are
// summarized, never thrown, and one media's failure does not
// stop the others.
function collectInstagramComments_(spreadsheet, snapshot, collectedAt) {
  const result = { stored: 0, error: null };
  const instagram = (snapshot && snapshot.instagram) || {};
  const media = Array.isArray(instagram.recent_media)
    ? instagram.recent_media
    : null;
  if (!media) {
    return result;
  }
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return result;
  }
  const prevById = previousCountsById_(
    readHistoryTabObjects_(spreadsheet, 'media', SNS_HISTORY_MEDIA_COLUMNS),
    'media_id',
    'comments'
  );
  const storedRows =
    readHistoryTabObjects_(
      spreadsheet,
      SNS_IG_COMMENTS_TAB,
      SNS_HISTORY_IG_COMMENTS_COLUMNS
    ) || [];
  const storedBoundaryByMedia = oldestStoredCommentByPost_(
    storedRows,
    'media_id'
  );
  const permalinkById = {};
  const freshCounts = media
    .filter((entry) => entry && entry.id != null)
    .map((entry) => {
      permalinkById[String(entry.id)] = entry.permalink || '';
      return {
        id: String(entry.id),
        count: snsNumberOrNull_(entry.comments),
      };
    });
  const targets = planCommentTargets_(
    freshCounts,
    prevById,
    SNS_COMMENTS_DETAIL_FETCH_MAX
  );
  const failures = [];
  const newRows = [];
  targets.forEach((target) => {
    const fetched = fetchInstagramComments_(target.id, token);
    if (fetched.error) {
      failures.push(fetched.error);
      return;
    }
    const boundary =
      target.id in storedBoundaryByMedia
        ? storedBoundaryByMedia[target.id]
        : firstFetchBoundary_(target.prevCollectedAt);
    const feedable = filterCommentsAfter_(fetched.comments, boundary);
    feedable.forEach((comment) => {
      newRows.push([
        snsHistoryTextCell_(comment.id),
        snsHistoryTextCell_(target.id),
        snsHistoryTextCell_(comment.parent_id),
        snsHistoryTextCell_(comment.username),
        snsHistoryTextCell_(comment.text.slice(0, SNS_CAPTION_MAX_LENGTH)),
        snsHistoryTextCell_(comment.posted_at),
        snsHistoryNumCell_(comment.like_count),
        snsHistoryTextCell_(permalinkById[target.id]),
        snsHistoryTextCell_(collectedAt),
      ]);
    });
  });
  if (newRows.length) {
    upsertSnsHistorySheet_(
      spreadsheet,
      SNS_IG_COMMENTS_TAB,
      SNS_HISTORY_IG_COMMENTS_COLUMNS,
      0,
      newRows
    );
    result.stored = newRows.length;
  }
  pruneOldCommentRows_(
    spreadsheet,
    SNS_IG_COMMENTS_TAB,
    SNS_HISTORY_IG_COMMENTS_COLUMNS
  );
  result.error = failures.length
    ? failures.length + ' media comment fetches failed (' + failures[0] + ')'
    : null;
  return result;
}

// The Threads half of collectPostComments_: fetches the
// conversations of the posts whose stored reply count grew and
// upserts them into threads_replies. Returns { stored, error }
// like collectInstagramComments_.
function collectThreadsReplies_(spreadsheet, snapshot, collectedAt) {
  const result = { stored: 0, error: null };
  const threads = (snapshot && snapshot.threads) || {};
  const posts = Array.isArray(threads.recent_posts)
    ? threads.recent_posts
    : null;
  if (!posts) {
    return result;
  }
  const token = threadsToken_();
  if (!token) {
    return result;
  }
  const prevById = previousCountsById_(
    readHistoryTabObjects_(
      spreadsheet,
      'threads_media',
      SNS_HISTORY_THREADS_MEDIA_COLUMNS
    ),
    'post_id',
    'replies'
  );
  const storedRows =
    readHistoryTabObjects_(
      spreadsheet,
      SNS_THREADS_REPLIES_TAB,
      SNS_HISTORY_THREADS_REPLIES_COLUMNS
    ) || [];
  const storedBoundaryByPost = oldestStoredCommentByPost_(storedRows, 'post_id');
  const freshCounts = posts
    .filter((entry) => entry && entry.id != null)
    .map((entry) => ({
      id: String(entry.id),
      count: snsNumberOrNull_(entry.replies),
    }));
  const targets = planCommentTargets_(
    freshCounts,
    prevById,
    SNS_COMMENTS_DETAIL_FETCH_MAX
  );
  const failures = [];
  const newRows = [];
  targets.forEach((target) => {
    const fetched = fetchThreadsConversation_(target.id, token);
    if (fetched.error) {
      failures.push(fetched.error);
      return;
    }
    const boundary =
      target.id in storedBoundaryByPost
        ? storedBoundaryByPost[target.id]
        : firstFetchBoundary_(target.prevCollectedAt);
    const feedable = filterCommentsAfter_(fetched.replies, boundary);
    feedable.forEach((reply) => {
      newRows.push([
        snsHistoryTextCell_(reply.id),
        snsHistoryTextCell_(target.id),
        snsHistoryTextCell_(reply.username),
        snsHistoryTextCell_(reply.text.slice(0, SNS_CAPTION_MAX_LENGTH)),
        snsHistoryTextCell_(reply.posted_at),
        snsHistoryTextCell_(reply.permalink),
        snsHistoryTextCell_(collectedAt),
      ]);
    });
  });
  if (newRows.length) {
    upsertSnsHistorySheet_(
      spreadsheet,
      SNS_THREADS_REPLIES_TAB,
      SNS_HISTORY_THREADS_REPLIES_COLUMNS,
      0,
      newRows
    );
    result.stored = newRows.length;
  }
  pruneOldCommentRows_(
    spreadsheet,
    SNS_THREADS_REPLIES_TAB,
    SNS_HISTORY_THREADS_REPLIES_COLUMNS
  );
  result.error = failures.length
    ? failures.length +
      ' post conversation fetches failed (' +
      failures[0] +
      ')'
    : null;
  return result;
}

// Resolves the Facebook Page linked to the main Instagram
// account, with its Page access token: Instagram messaging on
// the Facebook Login path is a Page surface, so the user token
// alone cannot read conversations. Returns
// { pageId, pageToken, error }.
//
// The known page is asked directly first: /me/accounts returns
// no pages at all for the stored token (no page was selected
// when the token was granted), while the page itself answers,
// carries the Instagram link, and hands out its Page token.
// The /me/accounts scan stays as a fallback in case the page
// ever becomes visible through the list again.
function resolveInstagramPage_(userToken) {
  const direct = fetchInsightsJson_(
    META_GRAPH_BASE +
      SNS_FACEBOOK_PAGE_ID +
      '?' +
      graphFieldsParam_('id,access_token,instagram_business_account{id}') +
      '&access_token=' +
      encodeURIComponent(userToken)
  );
  if (!direct.error && direct.data) {
    const linkedDirect =
      direct.data.instagram_business_account &&
      direct.data.instagram_business_account.id;
    if (
      linkedDirect != null &&
      String(linkedDirect) === SNS_INSTAGRAM_MAIN_ID
    ) {
      return {
        pageId: String(direct.data.id),
        pageToken: direct.data.access_token || '',
        error: null,
      };
    }
  }
  const res = fetchInsightsJson_(
    META_GRAPH_BASE +
      'me/accounts?' +
      graphFieldsParam_('id,access_token,instagram_business_account{id}') +
      '&limit=50&access_token=' +
      encodeURIComponent(userToken)
  );
  if (res.error) {
    return { pageId: null, pageToken: null, error: res.error };
  }
  const pages = res.data && Array.isArray(res.data.data) ? res.data.data : [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const linked =
      page && page.instagram_business_account
        ? page.instagram_business_account.id
        : null;
    if (linked != null && String(linked) === SNS_INSTAGRAM_MAIN_ID) {
      return {
        pageId: String(page.id),
        pageToken: page.access_token || '',
        error: null,
      };
    }
  }
  return {
    pageId: null,
    pageToken: null,
    error: 'no linked page found for the Instagram account',
  };
}

// One conversation's messages page flattened to plain message
// objects, received ones only: a message the owner sent (from
// the Page or from the Instagram account itself, depending on
// which identity the API echoes) is dropped, as in the Threads
// half. A message with no text body keeps the attachment
// placeholder so its arrival still reaches the feed.
function parseInstagramDmMessages_(data, pageId) {
  const items = data && Array.isArray(data.data) ? data.data : [];
  const messages = [];
  items.forEach((item) => {
    if (!item || item.id == null) {
      return;
    }
    const from = item.from || {};
    const fromId = from.id != null ? String(from.id) : '';
    if (fromId === String(pageId) || fromId === SNS_INSTAGRAM_MAIN_ID) {
      return;
    }
    const text =
      item.message != null && String(item.message) !== ''
        ? String(item.message)
        : SNS_DM_ATTACHMENT_TEXT;
    messages.push({
      id: String(item.id),
      username:
        from.username != null
          ? String(from.username)
          : from.name != null
            ? String(from.name)
            : '',
      text,
      posted_at: item.created_time || '',
    });
  });
  return messages;
}

// Fetches the id list of the Page's Instagram conversations,
// most recently updated first. Returns { ids, error }.
function fetchInstagramConversations_(pageId, pageToken) {
  const res = fetchInsightsJson_(
    META_GRAPH_BASE +
      pageId +
      '/conversations?platform=instagram&fields=id&limit=' +
      SNS_DM_CONVERSATION_LIMIT +
      '&access_token=' +
      encodeURIComponent(pageToken)
  );
  if (res.error) {
    return { ids: null, error: res.error };
  }
  if (!res.data || !Array.isArray(res.data.data)) {
    return { ids: null, error: 'response had no conversations array' };
  }
  return {
    ids: res.data.data
      .filter((entry) => entry && entry.id != null)
      .map((entry) => String(entry.id)),
    error: null,
  };
}

// Fetches one conversation's latest messages page. Returns
// { messages, error } like fetchInstagramComments_.
function fetchInstagramConversationMessages_(conversationId, pageId, pageToken) {
  const res = fetchInsightsJson_(
    META_GRAPH_BASE +
      conversationId +
      '/messages?' +
      graphFieldsParam_('id,created_time,from{id,username,name},message') +
      '&limit=' +
      SNS_DM_MESSAGE_LIMIT +
      '&access_token=' +
      encodeURIComponent(pageToken)
  );
  if (res.error) {
    return {
      messages: null,
      error: String(conversationId) + ': ' + res.error,
    };
  }
  if (!res.data || !Array.isArray(res.data.data)) {
    return {
      messages: null,
      error: String(conversationId) + ': response had no messages array',
    };
  }
  return {
    messages: parseInstagramDmMessages_(res.data, pageId),
    error: null,
  };
}

// The Instagram DM half of the comments collection: scans the
// recent conversations of the linked Page and upserts the
// received messages that are not stored yet into ig_dm.
// Unlike the comment halves there is no count to diff — a
// conversation's message list is cheap to re-read and the
// message-id upsert dedupes — so nothing depends on a
// boundary the platform's numbers can outrun. The one
// exception is the first-ever run: while the tab holds no
// rows at all, only the last SNS_COMMENTS_BOUNDARY_GRACE_MS
// of messages is imported, so enabling the feature does not
// flood the feed with the inbox's history. Returns
// { stored, error } like the other halves; failures are
// summarized, never thrown.
function collectInstagramDm_(spreadsheet, collectedAt) {
  const result = { stored: 0, error: null };
  const token = getScriptProperty_('META_ACCESS_TOKEN');
  if (!token) {
    return result;
  }
  const page = resolveInstagramPage_(token);
  if (page.error) {
    result.error = page.error;
    return result;
  }
  const conversations = fetchInstagramConversations_(
    page.pageId,
    page.pageToken
  );
  if (conversations.error) {
    result.error = conversations.error;
    return result;
  }
  const storedRows =
    readHistoryTabObjects_(
      spreadsheet,
      SNS_IG_DM_TAB,
      SNS_HISTORY_IG_DM_COLUMNS
    ) || [];
  const storedIds = {};
  storedRows.forEach((row) => {
    const id = historyTextOrNull_(row.message_id);
    if (id) {
      storedIds[id] = true;
    }
  });
  const firstRun = storedRows.length === 0;
  const firstRunSince = firstRun
    ? Date.parse(collectedAt || '') - SNS_COMMENTS_BOUNDARY_GRACE_MS
    : NaN;
  const failures = [];
  const newRows = [];
  conversations.ids.forEach((conversationId) => {
    const fetched = fetchInstagramConversationMessages_(
      conversationId,
      page.pageId,
      page.pageToken
    );
    if (fetched.error) {
      failures.push(fetched.error);
      return;
    }
    fetched.messages.forEach((message) => {
      if (storedIds[message.id]) {
        return;
      }
      if (firstRun) {
        const at = Date.parse(message.posted_at || '');
        if (!Number.isFinite(at) || at <= firstRunSince) {
          return;
        }
      }
      storedIds[message.id] = true;
      newRows.push([
        snsHistoryTextCell_(message.id),
        snsHistoryTextCell_(conversationId),
        snsHistoryTextCell_(message.username),
        snsHistoryTextCell_(message.text.slice(0, SNS_CAPTION_MAX_LENGTH)),
        snsHistoryTextCell_(message.posted_at),
        snsHistoryTextCell_(SNS_IG_DM_INBOX_URL),
        snsHistoryTextCell_(collectedAt),
      ]);
    });
  });
  if (newRows.length) {
    upsertSnsHistorySheet_(
      spreadsheet,
      SNS_IG_DM_TAB,
      SNS_HISTORY_IG_DM_COLUMNS,
      0,
      newRows
    );
    result.stored = newRows.length;
  }
  pruneOldCommentRows_(spreadsheet, SNS_IG_DM_TAB, SNS_HISTORY_IG_DM_COLUMNS);
  result.error = failures.length
    ? failures.length +
      ' conversation message fetches failed (' +
      failures[0] +
      ')'
    : null;
  return result;
}

// The collection entry point collectSnsCounts() calls (before
// appendSnsHistory_, whose upsert would erase the baseline).
// No-op while the history sheet is unconfigured, and never
// throws: each half logs its own summary line and the counts
// collection that hosts it still counts as a success.
function collectPostComments_(snapshot) {
  const sheetId = getScriptProperty_(SNS_HISTORY_SHEET_ID_PROPERTY);
  if (!sheetId) {
    return;
  }
  try {
    const spreadsheet = SpreadsheetApp.openById(sheetId);
    const collectedAt =
      (snapshot && snapshot.collected_at) || new Date().toISOString();
    const ig = collectInstagramComments_(spreadsheet, snapshot, collectedAt);
    if (ig.error) {
      console.log('Instagram comments error: ' + ig.error);
    }
    const th = collectThreadsReplies_(spreadsheet, snapshot, collectedAt);
    if (th.error) {
      console.log('Threads replies error: ' + th.error);
    }
    const dm = collectInstagramDm_(spreadsheet, collectedAt);
    if (dm.error) {
      console.log('Instagram DM error: ' + dm.error);
    }
    const xr = collectXReactions_(spreadsheet, collectedAt);
    if (xr.error) {
      console.log('X reactions error: ' + xr.error);
    }
  } catch (err) {
    console.log(
      'Post comments collection failed: ' +
        summarizeSnsHistoryError_(err, sheetId)
    );
  }
}


export { COMMENTS_RSS_CHANNELS, COMMENTS_RSS_TOKEN_PROPERTY, SNS_COMMENTS_RETENTION_DAYS, SNS_COMMENTS_RSS_LIMIT, SNS_COMMENTS_RSS_TITLE_CHARS, SNS_HISTORY_IG_COMMENTS_COLUMNS, SNS_HISTORY_IG_DM_COLUMNS, SNS_HISTORY_THREADS_REPLIES_COLUMNS, SNS_IG_DM_TAB, collectInstagramComments_, collectInstagramDm_, collectPostComments_, collectThreadsReplies_, fetchInstagramComments_, fetchInstagramConversationMessages_, fetchInstagramConversations_, fetchThreadsConversation_, filterCommentsAfter_, firstFetchBoundary_, oldestStoredCommentByPost_, parseInstagramComments_, parseInstagramDmMessages_, parseThreadsConversation_, planCommentTargets_, previousCountsById_, pruneOldCommentRows_, resolveInstagramPage_ };
