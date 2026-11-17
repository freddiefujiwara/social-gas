import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

// The post comments / replies feature: the hourly collection
// diffs the per-post counts against the history tabs, fetches
// detail only for the posts whose count grew, upserts rows into
// ig_comments / threads_replies, prunes rows over 60 days old,
// and serves the stored rows as RSS behind COMMENTS_RSS_TOKEN.
describe('Post comments / replies collection and RSS', () => {
  let outputs;
  let store;
  let fetchHandler;
  let fetchCalls;
  let sheets;
  let spreadsheet;

  const res = (status, body) => ({
    getResponseCode: () => status,
    getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  // The in-memory sheet double from the SNS history tests: rows
  // are plain arrays, row 1 is the header.
  const makeSheet = () => {
    const sheet = {
      rows: [],
      getLastRow() {
        return sheet.rows.length;
      },
      getRange(row, col, numRows, numCols) {
        return {
          setValues: (values) => {
            values.forEach((valueRow, i) => {
              sheet.rows[row - 1 + i] = valueRow.slice();
            });
          },
          getValues: () => {
            const out = [];
            for (let i = 0; i < numRows; i++) {
              const source = sheet.rows[row - 1 + i] || [];
              out.push(source.slice(col - 1, col - 1 + (numCols || source.length)));
            }
            return out;
          },
        };
      },
      appendRow(row) {
        sheet.rows.push(row.slice());
      },
      deleteRows(position, count) {
        sheet.rows.splice(position - 1, count);
      },
    };
    return sheet;
  };

  const seedTab = (name, columns, dataRows) => {
    const sheet = makeSheet();
    sheet.rows.push(columns.slice());
    dataRows.forEach((row) => sheet.rows.push(row.slice()));
    sheets[name] = sheet;
    return sheet;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    store = {};
    fetchCalls = [];
    fetchHandler = () => {
      throw new Error('unexpected fetch');
    };
    sheets = {};
    spreadsheet = {
      getSheetByName: (name) => sheets[name] || null,
      insertSheet: (name) => {
        sheets[name] = makeSheet();
        return sheets[name];
      },
    };

    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (key) => (key in store ? store[key] : null),
        setProperty: (key, value) => {
          store[key] = value;
        },
        deleteProperty: (key) => {
          delete store[key];
        },
      }),
    };
    global.ContentService = {
      createTextOutput: vi.fn((text) => {
        const out = {
          text,
          mimeType: null,
          setMimeType(m) {
            this.mimeType = m;
            return this;
          },
        };
        outputs.push(out);
        return out;
      }),
      MimeType: {
        JSON: 'application/json',
        HTML: 'text/html',
        XML: 'text/xml',
      },
    };
    global.UrlFetchApp = {
      fetch: vi.fn((url, options) => {
        fetchCalls.push({ url, options });
        return fetchHandler(url, options);
      }),
    };
    global.SpreadsheetApp = { openById: vi.fn(() => spreadsheet) };
  });

  const lastOutput = () => outputs[outputs.length - 1];

  describe('planCommentTargets_', () => {
    const prev = {
      m1: { count: 2, collected_at: '2026-11-16T00:00:00.000Z' },
      m2: { count: 5, collected_at: '2026-11-16T00:00:00.000Z' },
      m3: { count: null, collected_at: '2026-11-16T00:00:00.000Z' },
    };

    it('selects only the posts whose count grew past a numeric baseline', () => {
      const targets = Code.planCommentTargets_(
        [
          { id: 'm1', count: 3 }, // grew
          { id: 'm2', count: 5 }, // unchanged
          { id: 'm3', count: 9 }, // baseline not numeric
          { id: 'm4', count: 1 }, // no baseline row yet
          { id: 'm1x', count: null }, // fresh count unknown
        ],
        prev,
        5
      );
      expect(targets).toEqual([
        { id: 'm1', prevCollectedAt: '2026-11-16T00:00:00.000Z' },
      ]);
    });

    it('caps the number of detail fetches per run', () => {
      const many = {};
      const fresh = [];
      for (let i = 0; i < 8; i++) {
        many['p' + i] = { count: 1, collected_at: '2026-11-16T00:00:00.000Z' };
        fresh.push({ id: 'p' + i, count: 2 });
      }
      expect(Code.planCommentTargets_(fresh, many, 5)).toHaveLength(5);
    });
  });

  describe('previousCountsById_', () => {
    it('maps rows by id with numeric counts and null for empty cells', () => {
      const rows = [
        { media_id: 'm1', comments: 4, collected_at: '2026-11-16T00:00:00.000Z' },
        { media_id: 'm2', comments: '', collected_at: '2026-11-16T00:00:00.000Z' },
        { media_id: '', comments: 3, collected_at: '2026-11-16T00:00:00.000Z' },
      ];
      expect(Code.previousCountsById_(rows, 'media_id', 'comments')).toEqual({
        m1: { count: 4, collected_at: '2026-11-16T00:00:00.000Z' },
        m2: { count: null, collected_at: '2026-11-16T00:00:00.000Z' },
      });
    });
  });

  describe('filterCommentsAfter_', () => {
    const comments = [
      { id: 'a', posted_at: '2026-11-16T00:30:00.000Z' },
      { id: 'b', posted_at: '2026-11-16T01:30:00.000Z' },
      { id: 'c', posted_at: 'not-a-date' },
    ];

    it('keeps only comments posted after the boundary', () => {
      expect(
        Code.filterCommentsAfter_(comments, '2026-11-16T01:00:00.000Z').map(
          (c) => c.id
        )
      ).toEqual(['b']);
    });

    it('keeps nothing when the boundary does not parse', () => {
      expect(Code.filterCommentsAfter_(comments, '')).toEqual([]);
      expect(Code.filterCommentsAfter_(comments, null)).toEqual([]);
    });
  });

  describe('parseInstagramComments_', () => {
    it('flattens replies under their parent and skips id-less entries', () => {
      const parsed = Code.parseInstagramComments_({
        data: [
          {
            id: 'c1',
            text: '最初のコメント',
            username: 'alice',
            timestamp: '2026-11-16T01:00:00+0000',
            like_count: 2,
            replies: {
              data: [
                {
                  id: 'r1',
                  text: '返信です',
                  username: 'bob',
                  timestamp: '2026-11-16T01:05:00+0000',
                  like_count: 0,
                },
                { text: 'id なし' },
              ],
            },
          },
          { text: 'id なしの親' },
        ],
      });
      expect(parsed).toEqual([
        {
          id: 'c1',
          parent_id: '',
          username: 'alice',
          text: '最初のコメント',
          posted_at: '2026-11-16T01:00:00+0000',
          like_count: 2,
        },
        {
          id: 'r1',
          parent_id: 'c1',
          username: 'bob',
          text: '返信です',
          posted_at: '2026-11-16T01:05:00+0000',
          like_count: 0,
        },
      ]);
    });
  });

  describe('parseThreadsConversation_', () => {
    it('drops the root post and the owner\u2019s own replies', () => {
      const parsed = Code.parseThreadsConversation_(
        {
          data: [
            { id: 'p1', text: 'root', username: 'freddiefujiwara' },
            {
              id: 'r1',
              text: '他人の返信',
              username: 'carol',
              timestamp: '2026-11-16T01:00:00Z',
              permalink: 'https://www.threads.net/@carol/post/R1',
              is_reply_owned_by_me: false,
            },
            {
              id: 'r2',
              text: '自分の返信',
              username: 'freddiefujiwara',
              timestamp: '2026-11-16T01:10:00Z',
              is_reply_owned_by_me: true,
            },
          ],
        },
        'p1'
      );
      expect(parsed).toEqual([
        {
          id: 'r1',
          username: 'carol',
          text: '他人の返信',
          posted_at: '2026-11-16T01:00:00Z',
          permalink: 'https://www.threads.net/@carol/post/R1',
        },
      ]);
    });
  });

  describe('collectInstagramComments_', () => {
    const T0 = '2026-11-16T00:00:00.000Z';
    const T1 = '2026-11-16T01:00:00.000Z';
    const mediaRow = (comments, collectedAt) => {
      const row = Code.SNS_HISTORY_MEDIA_COLUMNS.map(() => '');
      const set = (name, value) => {
        row[Code.SNS_HISTORY_MEDIA_COLUMNS.indexOf(name)] = value;
      };
      set('collected_at', collectedAt);
      set('media_id', 'm1');
      set('comments', comments);
      set('permalink', 'https://www.instagram.com/reel/M1/');
      return row;
    };
    const snapshot = (comments) => ({
      collected_at: T1,
      instagram: {
        recent_media: [
          {
            id: 'm1',
            permalink: 'https://www.instagram.com/reel/M1/',
            comments,
          },
        ],
      },
      threads: { recent_posts: null },
    });

    beforeEach(() => {
      store.META_ACCESS_TOKEN = 'meta-token';
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
    });

    it('reaches back over the grace window on the first fetch, but no further', () => {
      seedTab('media', Code.SNS_HISTORY_MEDIA_COLUMNS, [mediaRow(2, T0)]);
      fetchHandler = (url) => {
        expect(url).toContain('/m1/comments');
        expect(url).toContain('replies%7B');
        expect(url).not.toContain('{');
        expect(url).not.toContain('}');
        return res(200, {
          data: [
            {
              id: 'c-ancient',
              text: 'ずっと前のコメント',
              username: 'erin',
              timestamp: '2026-11-10T00:00:00+0000',
              like_count: 0,
            },
            {
              id: 'c-old',
              text: '前からあるコメント',
              username: 'alice',
              timestamp: '2026-11-15T23:30:00+0000',
              like_count: 1,
              replies: {
                data: [
                  {
                    id: 'r-new',
                    text: '新しい返信',
                    username: 'bob',
                    timestamp: '2026-11-16T00:40:00+0000',
                    like_count: 0,
                  },
                ],
              },
            },
            {
              id: 'c-new',
              text: '新しいコメント',
              username: 'carol',
              timestamp: '2026-11-16T00:30:00+0000',
              like_count: 3,
            },
          ],
        });
      };
      const result = Code.collectInstagramComments_(
        spreadsheet,
        snapshot(3),
        T1
      );
      expect(result).toEqual({ stored: 3, error: null });
      const tab = sheets.ig_comments;
      expect(tab.rows[0]).toEqual(Code.SNS_HISTORY_IG_COMMENTS_COLUMNS);
      const byId = {};
      tab.rows.slice(1).forEach((row) => {
        byId[row[0]] = row;
      });
      expect(Object.keys(byId).sort()).toEqual(['c-new', 'c-old', 'r-new']);
      expect(byId['c-new']).toEqual([
        'c-new',
        'm1',
        '',
        'carol',
        '新しいコメント',
        '2026-11-16T00:30:00+0000',
        3,
        'https://www.instagram.com/reel/M1/',
        T1,
      ]);
      expect(byId['r-new'][2]).toBe('c-old');
    });

    it('keeps a comment the counts reflected one collection late', () => {
      // The regression this fixes: the comment landed just
      // after a collection (00:05), but the stored count only
      // grew at the collection after next — by then the
      // previous observation moment (01:00) sat after the
      // comment, and the unshifted boundary dropped it.
      seedTab('media', Code.SNS_HISTORY_MEDIA_COLUMNS, [mediaRow(2, T1)]);
      fetchHandler = () =>
        res(200, {
          data: [
            {
              id: 'c-late',
              text: '反映が遅れたコメント',
              username: 'frank',
              timestamp: '2026-11-16T00:05:00+0000',
              like_count: 0,
            },
          ],
        });
      const result = Code.collectInstagramComments_(
        spreadsheet,
        snapshot(3),
        '2026-11-16T02:00:00.000Z'
      );
      expect(result).toEqual({ stored: 1, error: null });
      expect(sheets.ig_comments.rows[1][0]).toBe('c-late');
    });

    it('does not re-import older comments on later fetches (boundary moves to the oldest stored)', () => {
      seedTab('media', Code.SNS_HISTORY_MEDIA_COLUMNS, [mediaRow(3, T1)]);
      seedTab('ig_comments', Code.SNS_HISTORY_IG_COMMENTS_COLUMNS, [
        [
          'c-new',
          'm1',
          '',
          'carol',
          '新しいコメント',
          '2026-11-16T00:30:00+0000',
          3,
          'https://www.instagram.com/reel/M1/',
          T1,
        ],
      ]);
      fetchHandler = () =>
        res(200, {
          data: [
            {
              id: 'c-old',
              text: '前からあるコメント',
              username: 'alice',
              timestamp: '2026-11-15T23:30:00+0000',
              like_count: 1,
            },
            {
              id: 'c-new',
              text: '新しいコメント',
              username: 'carol',
              timestamp: '2026-11-16T00:30:00+0000',
              like_count: 3,
            },
            {
              id: 'c-newer',
              text: 'さらに新しいコメント',
              username: 'dave',
              timestamp: '2026-11-16T01:30:00+0000',
              like_count: 0,
            },
          ],
        });
      const result = Code.collectInstagramComments_(
        spreadsheet,
        snapshot(4),
        '2026-11-16T02:00:00.000Z'
      );
      expect(result.error).toBeNull();
      const ids = sheets.ig_comments.rows.slice(1).map((row) => row[0]);
      expect(ids.sort()).toEqual(['c-new', 'c-newer']);
    });

    it('fetches nothing while the count did not grow', () => {
      seedTab('media', Code.SNS_HISTORY_MEDIA_COLUMNS, [mediaRow(3, T0)]);
      const result = Code.collectInstagramComments_(
        spreadsheet,
        snapshot(3),
        T1
      );
      expect(result).toEqual({ stored: 0, error: null });
      expect(fetchCalls).toHaveLength(0);
      expect(sheets.ig_comments).toBeUndefined();
    });

    it('summarizes a failed fetch instead of throwing', () => {
      seedTab('media', Code.SNS_HISTORY_MEDIA_COLUMNS, [mediaRow(2, T0)]);
      fetchHandler = () =>
        res(400, { error: { code: 10, message: 'permission denied' } });
      const result = Code.collectInstagramComments_(
        spreadsheet,
        snapshot(3),
        T1
      );
      expect(result.stored).toBe(0);
      expect(result.error).toContain('m1');
      expect(result.error).toContain('permission denied');
    });
  });

  describe('collectThreadsReplies_', () => {
    const T0 = '2026-11-16T00:00:00.000Z';
    const T1 = '2026-11-16T01:00:00.000Z';
    const postRow = (replies, collectedAt) => {
      const row = Code.SNS_HISTORY_THREADS_MEDIA_COLUMNS.map(() => '');
      const set = (name, value) => {
        row[Code.SNS_HISTORY_THREADS_MEDIA_COLUMNS.indexOf(name)] = value;
      };
      set('collected_at', collectedAt);
      set('post_id', 'p1');
      set('replies', replies);
      return row;
    };
    const snapshot = (replies) => ({
      collected_at: T1,
      instagram: { recent_media: null },
      threads: { recent_posts: [{ id: 'p1', replies }] },
    });

    beforeEach(() => {
      store.META_THREADS_ACCESS_TOKEN = 'threads-token';
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
    });

    it('stores new replies over the grace window, excluding the owner’s own and ancient ones', () => {
      seedTab('threads_media', Code.SNS_HISTORY_THREADS_MEDIA_COLUMNS, [
        postRow(1, T0),
      ]);
      fetchHandler = (url) => {
        expect(url).toContain('/p1/conversation');
        return res(200, {
          data: [
            {
              id: 'r-ancient',
              text: 'ずっと前の返信',
              username: 'erin',
              timestamp: '2026-11-10T00:00:00Z',
              permalink: 'https://www.threads.net/@erin/post/RA',
              is_reply_owned_by_me: false,
            },
            {
              id: 'r-old',
              text: '前からある返信',
              username: 'alice',
              timestamp: '2026-11-15T23:00:00Z',
              permalink: 'https://www.threads.net/@alice/post/RO',
              is_reply_owned_by_me: false,
            },
            {
              id: 'r-own',
              text: '自分の返信',
              username: 'freddiefujiwara',
              timestamp: '2026-11-16T00:20:00Z',
              permalink: 'https://www.threads.net/@freddiefujiwara/post/RW',
              is_reply_owned_by_me: true,
            },
            {
              id: 'r-new',
              text: '新しい返信',
              username: 'carol',
              timestamp: '2026-11-16T00:30:00Z',
              permalink: 'https://www.threads.net/@carol/post/RN',
              is_reply_owned_by_me: false,
            },
          ],
        });
      };
      const result = Code.collectThreadsReplies_(spreadsheet, snapshot(2), T1);
      expect(result).toEqual({ stored: 2, error: null });
      expect(sheets.threads_replies.rows).toEqual([
        Code.SNS_HISTORY_THREADS_REPLIES_COLUMNS,
        [
          'r-old',
          'p1',
          'alice',
          '前からある返信',
          '2026-11-15T23:00:00Z',
          'https://www.threads.net/@alice/post/RO',
          T1,
        ],
        [
          'r-new',
          'p1',
          'carol',
          '新しい返信',
          '2026-11-16T00:30:00Z',
          'https://www.threads.net/@carol/post/RN',
          T1,
        ],
      ]);
    });
  });

  describe('pruneOldCommentRows_', () => {
    it('drops rows older than 60 days and keeps recent and unparseable ones', () => {
      const now = Date.now();
      const old = new Date(now - 61 * 86400000).toISOString();
      const recent = new Date(now - 86400000).toISOString();
      const tab = seedTab('ig_comments', Code.SNS_HISTORY_IG_COMMENTS_COLUMNS, [
        ['c-old', 'm1', '', 'a', '古い', old, 0, '', ''],
        ['c-recent', 'm1', '', 'b', '新しい', recent, 0, '', ''],
        ['c-odd', 'm1', '', 'c', '日付なし', '', 0, '', ''],
      ]);
      const dropped = Code.pruneOldCommentRows_(
        spreadsheet,
        'ig_comments',
        Code.SNS_HISTORY_IG_COMMENTS_COLUMNS
      );
      expect(dropped).toBe(1);
      expect(tab.rows.slice(1).map((row) => row[0])).toEqual([
        'c-recent',
        'c-odd',
      ]);
    });
  });

  describe('buildCommentsRss_', () => {
    const rows = [
      {
        id: 'c1',
        username: 'alice',
        text: 'a & b <tag> のコメント',
        posted_at: '2026-11-16T00:30:00.000Z',
        permalink: 'https://www.instagram.com/reel/M1/',
      },
      {
        id: 'c2',
        username: 'bob',
        text: '新しい方',
        posted_at: '2026-11-16T01:30:00.000Z',
        permalink: 'https://www.instagram.com/reel/M1/',
      },
      {
        id: 'c3',
        username: 'carol',
        text: '日付が壊れている',
        posted_at: 'garbage',
        permalink: '',
      },
    ];

    it('emits newest-first RSS 2.0 with the comment id as guid and an RFC 822 pubDate', () => {
      const xml = Code.buildCommentsRss_('instagram', rows);
      expect(xml).toContain('<rss version="2.0">');
      expect(xml.indexOf('<guid isPermaLink="false">c2</guid>')).toBeLessThan(
        xml.indexOf('<guid isPermaLink="false">c1</guid>')
      );
      expect(xml).not.toContain('c3');
      const pubDates = xml.match(/<pubDate>[^<]+<\/pubDate>/g) || [];
      expect(pubDates).toHaveLength(2);
      pubDates.forEach((tag) => {
        expect(tag).toMatch(
          /^<pubDate>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>$/
        );
      });
    });

    it('escapes XML in titles and descriptions', () => {
      const xml = Code.buildCommentsRss_('instagram', rows);
      expect(xml).toContain('a &amp; b &lt;tag&gt; のコメント');
      expect(xml).not.toContain('<tag>');
      expect(xml).toContain('<title>@alice: a &amp; b');
    });

    it('caps the feed at SNS_COMMENTS_RSS_LIMIT items', () => {
      const many = [];
      for (let i = 0; i < 60; i++) {
        many.push({
          id: 'c' + i,
          username: 'u',
          text: 't' + i,
          posted_at: new Date(Date.UTC(2026, 10, 16, 0, i)).toISOString(),
          permalink: '',
        });
      }
      const xml = Code.buildCommentsRss_('threads', many);
      expect((xml.match(/<item>/g) || []).length).toBe(
        Code.SNS_COMMENTS_RSS_LIMIT
      );
    });
  });

  describe('serveCommentsRss_ via doGet', () => {
    const callRss = (parameter) =>
      Code.doGet({ parameter, headers: {} });

    beforeEach(() => {
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      seedTab('ig_comments', Code.SNS_HISTORY_IG_COMMENTS_COLUMNS, [
        [
          'c1',
          'm1',
          '',
          'alice',
          'こんにちは',
          '2026-11-16T00:30:00.000Z',
          1,
          'https://www.instagram.com/reel/M1/',
          '2026-11-16T01:00:00.000Z',
        ],
      ]);
    });

    it('refuses every request while COMMENTS_RSS_TOKEN is unset', () => {
      const out = callRss({
        action: 'comments_rss',
        source: 'instagram',
        token: 'anything',
      });
      expect(out).toBe(lastOutput());
      expect(JSON.parse(out.text)).toEqual({
        ok: false,
        status: 403,
        error: 'invalid token',
      });
    });

    it('refuses a mismatched token without serving comment text', () => {
      store.COMMENTS_RSS_TOKEN = 'the-token';
      const out = callRss({
        action: 'comments_rss',
        source: 'instagram',
        token: 'wrong',
      });
      expect(JSON.parse(out.text).status).toBe(403);
      expect(out.text).not.toContain('こんにちは');
    });

    it('refuses an unknown source', () => {
      store.COMMENTS_RSS_TOKEN = 'the-token';
      const out = callRss({
        action: 'comments_rss',
        source: 'facebook',
        token: 'the-token',
      });
      expect(JSON.parse(out.text)).toEqual({
        ok: false,
        status: 400,
        error: 'unknown source',
      });
    });

    it('serves the stored comments as XML to the matching token', () => {
      store.COMMENTS_RSS_TOKEN = 'the-token';
      const out = callRss({
        action: 'comments_rss',
        source: 'instagram',
        token: 'the-token',
      });
      expect(out.mimeType).toBe('text/xml');
      expect(out.text).toContain('<rss version="2.0">');
      expect(out.text).toContain('<guid isPermaLink="false">c1</guid>');
      expect(out.text).toContain('こんにちは');
    });

    it('serves an empty feed while the tab does not exist yet', () => {
      store.COMMENTS_RSS_TOKEN = 'the-token';
      const out = callRss({
        action: 'comments_rss',
        source: 'threads',
        token: 'the-token',
      });
      expect(out.mimeType).toBe('text/xml');
      expect(out.text).toContain('<rss version="2.0">');
      expect(out.text).not.toContain('<item>');
    });
  });

  describe('collectPostComments_', () => {
    it('does not touch SpreadsheetApp while the history sheet is unconfigured', () => {
      global.SpreadsheetApp = {
        openById: vi.fn(() => {
          throw new Error('must not be called');
        }),
      };
      expect(() =>
        Code.collectPostComments_({ collected_at: '2026-11-16T01:00:00.000Z' })
      ).not.toThrow();
      expect(global.SpreadsheetApp.openById).not.toHaveBeenCalled();
    });
  });
});
