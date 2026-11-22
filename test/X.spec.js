import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

// X joins the collection through tweet-gas (GAS-to-GAS): the X
// API keys live only in tweet-gas, and collectSnsCounts POSTs
// { action: 'sns_snapshot', sync_token } to its web app — the
// same machine sync-token pattern alarm-gas / time-table-gas
// use. These tests pin the caller side: the request shape, the
// response mapping into the snapshot / history / read shapes,
// and the failure behaviour (nulls plus a summary, never a throw).
describe('X via tweet-gas (GAS-to-GAS sync)', () => {
  let store;
  let fetchHandler;

  const res = (status, body) => ({
    getResponseCode: () => status,
    getContentText: () =>
      typeof body === 'string' ? body : JSON.stringify(body),
  });

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
              out.push(
                source.slice(col - 1, col - 1 + (numCols || source.length))
              );
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

  let sheets;
  let spreadsheet;
  const serveTabs = (tabs) => {
    sheets = {};
    for (const [name, rows] of Object.entries(tabs)) {
      const sheet = makeSheet();
      sheet.rows = rows.map((row) => row.slice());
      sheets[name] = sheet;
    }
    spreadsheet = {
      getSheetByName: (name) => sheets[name] || null,
      insertSheet: (name) => {
        sheets[name] = makeSheet();
        return sheets[name];
      },
    };
    global.SpreadsheetApp = { openById: vi.fn(() => spreadsheet) };
    store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = {};
    sheets = {};
    fetchHandler = () => {
      throw new Error('unexpected fetch');
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
    global.UrlFetchApp = {
      fetch: vi.fn((url, options) => fetchHandler(url, options)),
    };
    delete global.SpreadsheetApp;
  });

  const configureSync = () => {
    store.TWEET_GAS_EXEC_URL = 'https://example.com/tweet-gas/exec';
    store.TWEET_GAS_SYNC_TOKEN = 'sync-secret';
  };

  const WIRE_POSTS = [
    {
      id: '2001',
      posted_at: '2026-11-09T10:00:00.000Z',
      text: '川口のブログを更新しました',
      views: 500,
      likes: 12,
      reposts: 3,
      replies: 2,
    },
    {
      id: '2002',
      posted_at: '2026-11-08T10:00:00.000Z',
      text: '数字が欠けた投稿',
      views: null,
      likes: 1,
      reposts: 0,
      replies: 0,
    },
  ];

  describe('fetchXDetail_', () => {
    it('returns all nulls without fetching while unconfigured', () => {
      const detail = Code.fetchXDetail_();
      expect(detail).toEqual({
        followers: null,
        username: null,
        api_balance_usd: null,
        api_daily_posts: null,
        usage_error: null,
        recent_posts: null,
        x_error: null,
        posts_error: null,
      });
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('POSTs the sync action with the token and maps the response', () => {
      configureSync();
      fetchHandler = (url, options) => {
        expect(url).toBe('https://example.com/tweet-gas/exec');
        expect(options.method).toBe('post');
        expect(options.contentType).toBe('text/plain');
        expect(JSON.parse(options.payload)).toEqual({
          action: 'sns_snapshot',
          sync_token: 'sync-secret',
        });
        return res(200, {
          ok: true,
          action: 'sns_snapshot',
          collected_at: '2026-11-10T00:00:00.000Z',
          x: {
            followers: 321,
            username: 'freddiefujiwara',
            recent_posts: WIRE_POSTS,
          },
          x_error: null,
          posts_error: null,
        });
      };
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(321);
      expect(detail.username).toBe('freddiefujiwara');
      expect(detail.x_error).toBeNull();
      expect(detail.posts_error).toBeNull();
      expect(detail.recent_posts).toHaveLength(2);
      expect(detail.recent_posts[0]).toEqual({
        id: '2001',
        posted_at: '2026-11-09T10:00:00.000Z',
        text: '川口のブログを更新しました',
        url: 'https://x.com/i/web/status/2001',
        views: 500,
        likes: 12,
        reposts: 3,
        replies: 2,
      });
      expect(detail.recent_posts[1].views).toBeNull();
    });

    it('reports an HTTP failure on both error fields', () => {
      configureSync();
      fetchHandler = () => res(401, 'Unauthorized');
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBeNull();
      expect(detail.recent_posts).toBeNull();
      expect(detail.x_error).toBe('tweet-gas HTTP 401');
      expect(detail.posts_error).toBe('tweet-gas HTTP 401');
    });

    it('reports a not-ok body with its reason', () => {
      configureSync();
      fetchHandler = () =>
        res(200, { ok: false, status: 401, error: 'sync token invalid' });
      const detail = Code.fetchXDetail_();
      expect(detail.x_error).toBe('tweet-gas: sync token invalid');
      expect(detail.posts_error).toBe('tweet-gas: sync token invalid');
    });

    it('passes tweet-gas partial errors through and keeps the numbers', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: null },
          x_error: null,
          posts_error: 'x posts: HTTP 429 code=88: Rate limit exceeded',
        });
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(321);
      expect(detail.recent_posts).toBeNull();
      expect(detail.x_error).toBeNull();
      expect(detail.posts_error).toContain('HTTP 429');
    });

    it('maps the usage half from the snapshot response', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: WIRE_POSTS },
          x_error: null,
          posts_error: null,
          x_usage: {
            credit_balance_usd: 41.65,
            prepaid_balance_usd: 25,
            free_balance_usd: 16.65,
            daily_posts: [
              { date: '2026-11-08', tweets_consumed: 120 },
              { date: '2026-11-07', tweets_consumed: null },
            ],
          },
          usage_error: null,
        });
      const detail = Code.fetchXDetail_();
      expect(detail.api_balance_usd).toBe(41.65);
      // Daily posts come out ascending, null counts preserved.
      expect(detail.api_daily_posts).toEqual([
        { date: '2026-11-07', tweets_consumed: null },
        { date: '2026-11-08', tweets_consumed: 120 },
      ]);
      expect(detail.usage_error).toBeNull();
      expect(detail.followers).toBe(321);
    });

    it('maps the usage half when the dates arrive as ISO timestamps', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: [] },
          x_error: null,
          posts_error: null,
          x_usage: {
            credit_balance_usd: 41.65,
            cycle_posts_consumed: 321,
            daily_posts: [
              { date: '2026-11-10T00:00:00.000Z', tweets_consumed: 96 },
              { date: '2026-11-09T00:00:00.000Z', tweets_consumed: 140 },
            ],
          },
          usage_error: null,
        });
      const detail = Code.fetchXDetail_();
      expect(detail.api_balance_usd).toBe(41.65);
      // The timestamp shape production sends is cut to its day.
      expect(detail.api_daily_posts).toEqual([
        { date: '2026-11-09', tweets_consumed: 140 },
        { date: '2026-11-10', tweets_consumed: 96 },
      ]);
    });

    it('passes a partial usage failure through as usage_error', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: [] },
          x_error: null,
          posts_error: null,
          x_usage: { credit_balance_usd: null, daily_posts: null },
          usage_error: 'credits fetch failed',
        });
      const detail = Code.fetchXDetail_();
      expect(detail.api_balance_usd).toBeNull();
      expect(detail.api_daily_posts).toBeNull();
      expect(detail.usage_error).toBe('credits fetch failed');
    });

    it('keeps the balance null when the response carries none', () => {
      configureSync();
      fetchHandler = () =>
        res(200, {
          ok: true,
          x: { followers: 321, username: 'freddiefujiwara', recent_posts: [] },
          x_error: null,
          posts_error: null,
        });
      expect(Code.fetchXDetail_().api_balance_usd).toBeNull();
    });

    it('survives a fetch exception', () => {
      configureSync();
      fetchHandler = () => {
        throw new Error('network down');
      };
      const detail = Code.fetchXDetail_();
      expect(detail.x_error).toContain('tweet-gas fetch exception');
      expect(detail.followers).toBeNull();
    });
  });

  describe('fetchXDetail_ with the stats feed', () => {
    const STATS_URL = 'https://example.com/x.freddie.stats.xml';

    // Modeled on the live feed: xs channel elements, then one
    // item per post (guid = post id, pubDate = its moment,
    // CDATA description = its text, xs metrics).
    const statsXml = (collectedAt, followers) =>
      [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<rss version="2.0" xmlns:xs="https://freddiefujiwara.com/ns/x-stats">',
        '<channel>',
        '  <title>X Stats (@freddiefujiwara)</title>',
        '  <link>https://twitter.com/freddiefujiwara</link>',
        '  <xs:username>freddiefujiwara</xs:username>',
        `  <xs:followers>${followers}</xs:followers>`,
        '  <xs:following>836</xs:following>',
        `  <xs:collected-at>${collectedAt}</xs:collected-at>`,
        '<item>',
        '  <title><![CDATA[ファイルからの投稿]]></title>',
        '  <link>https://twitter.com/freddiefujiwara/status/3001</link>',
        '  <description><![CDATA[ファイルからの投稿]]></description>',
        '  <pubDate>Mon, 16 Nov 2026 01:00:00 +0000</pubDate>',
        '  <guid isPermaLink="false">3001</guid>',
        '  <xs:views>111</xs:views>',
        '  <xs:likes>1</xs:likes>',
        '  <xs:reposts>0</xs:reposts>',
        '  <xs:replies>0</xs:replies>',
        '</item>',
        '</channel>',
        '</rss>',
      ].join('\n');

    const freshStats = () => statsXml(new Date().toISOString(), 1840);

    const tweetGasBody = {
      ok: true,
      action: 'sns_snapshot',
      collected_at: '2026-11-16T00:00:00.000Z',
      x: {
        followers: 321,
        username: 'freddiefujiwara',
        recent_posts: WIRE_POSTS,
      },
      x_usage: { credit_balance_usd: 12.5, daily_posts: [] },
      x_error: null,
      posts_error: null,
    };

    const routeFetches = (statsHandler) => {
      fetchHandler = (url) => {
        if (url === STATS_URL) {
          return statsHandler();
        }
        return res(200, tweetGasBody);
      };
    };

    it('prefers the feed for followers and posts, keeps usage from tweet-gas', () => {
      configureSync();
      store.X_STATS_URL = STATS_URL;
      routeFetches(() => res(200, freshStats()));
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(1840);
      expect(detail.recent_posts).toHaveLength(1);
      expect(detail.recent_posts[0].id).toBe('3001');
      expect(detail.recent_posts[0].posted_at).toBe(
        '2026-11-16T01:00:00.000Z'
      );
      expect(detail.recent_posts[0].text).toBe('ファイルからの投稿');
      expect(detail.recent_posts[0].views).toBe(111);
      expect(detail.recent_posts[0].url).toBe(
        'https://x.com/i/web/status/3001'
      );
      expect(detail.api_balance_usd).toBe(12.5);
    });

    it('falls back to tweet-gas when the feed fetch fails', () => {
      configureSync();
      store.X_STATS_URL = STATS_URL;
      routeFetches(() => res(500, 'server error'));
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(321);
      expect(detail.recent_posts).toHaveLength(2);
    });

    it('falls back to tweet-gas when the feed body is not a stats feed', () => {
      configureSync();
      store.X_STATS_URL = STATS_URL;
      routeFetches(() => res(200, '{"ok":true,"x":{}}'));
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(321);
      expect(detail.recent_posts).toHaveLength(2);
    });

    it('falls back to tweet-gas when the feed is stale', () => {
      configureSync();
      store.X_STATS_URL = STATS_URL;
      const stale = statsXml(
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        1840
      );
      routeFetches(() => res(200, stale));
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(321);
      expect(detail.recent_posts).toHaveLength(2);
    });

    it('uses the feed even while tweet-gas is unconfigured', () => {
      store.X_STATS_URL = STATS_URL;
      fetchHandler = (url) => {
        if (url === STATS_URL) {
          return res(200, freshStats());
        }
        throw new Error('unexpected fetch: ' + url);
      };
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(1840);
      expect(detail.recent_posts).toHaveLength(1);
      expect(detail.api_balance_usd).toBeNull();
      expect(detail.x_error).toBeNull();
      expect(detail.posts_error).toBeNull();
    });

    it('does not fetch the feed while X_STATS_URL is unset', () => {
      configureSync();
      fetchHandler = () => res(200, tweetGasBody);
      const detail = Code.fetchXDetail_();
      expect(detail.followers).toBe(321);
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseXStatsFeed_', () => {
    it('reads the channel values and the posts', () => {
      const parsed = Code.parseXStatsFeed_(
        [
          '<rss version="2.0" xmlns:xs="https://freddiefujiwara.com/ns/x-stats">',
          '<channel>',
          '  <xs:username>freddiefujiwara</xs:username>',
          '  <xs:followers>1842</xs:followers>',
          '  <xs:collected-at>2026-11-18T20:03:05.378Z</xs:collected-at>',
          '<item>',
          '  <description><![CDATA[本文です]]></description>',
          '  <pubDate>Wed, 18 Nov 2026 12:51:28 +0000</pubDate>',
          '  <guid isPermaLink="false">3001</guid>',
          '  <xs:views>89</xs:views>',
          '  <xs:likes>1</xs:likes>',
          '  <xs:reposts>0</xs:reposts>',
          '  <xs:replies>2</xs:replies>',
          '</item>',
          '</channel>',
          '</rss>',
        ].join('\n')
      );
      expect(parsed.collected_at).toBe('2026-11-18T20:03:05.378Z');
      expect(parsed.username).toBe('freddiefujiwara');
      expect(parsed.followers).toBe(1842);
      expect(parsed.recent_posts).toEqual([
        {
          id: '3001',
          posted_at: '2026-11-18T12:51:28.000Z',
          text: '本文です',
          views: 89,
          likes: 1,
          reposts: 0,
          replies: 2,
        },
      ]);
    });

    it('returns null without a collected-at or without items', () => {
      expect(
        Code.parseXStatsFeed_('<rss><channel></channel></rss>')
      ).toBeNull();
      expect(
        Code.parseXStatsFeed_(
          '<rss><channel><xs:collected-at>2026-11-18T20:03:05.378Z</xs:collected-at></channel></rss>'
        )
      ).toBeNull();
      expect(Code.parseXStatsFeed_('not xml at all')).toBeNull();
      expect(Code.parseXStatsFeed_(null)).toBeNull();
    });
  });

  describe('extractXUsage_', () => {
    it('reads the balance and daily posts from x_usage', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: 41.65,
          daily_posts: [{ date: '2026-11-08', tweets_consumed: 120 }],
        },
        usage_error: null,
      });
      expect(usage.balance_usd).toBe(41.65);
      expect(usage.daily_posts).toEqual([
        { date: '2026-11-08', tweets_consumed: 120 },
      ]);
      expect(usage.usage_error).toBeNull();
    });

    it('keeps a reported zero balance', () => {
      expect(
        Code.extractXUsage_({ x_usage: { credit_balance_usd: 0 } }).balance_usd
      ).toBe(0);
    });

    it('drops malformed daily entries and keeps null counts', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: null,
          daily_posts: [
            { date: 'not-a-date', tweets_consumed: 5 },
            { tweets_consumed: 5 },
            null,
            { date: '2026-11-08', tweets_consumed: null },
          ],
        },
      });
      expect(usage.daily_posts).toEqual([
        { date: '2026-11-08', tweets_consumed: null },
      ]);
    });

    it('normalizes ISO timestamp dates to their calendar day', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: 41.65,
          daily_posts: [
            { date: '2026-11-10T00:00:00.000Z', tweets_consumed: 96 },
            { date: '2026-11-09T12:34:56.789Z', tweets_consumed: 140 },
          ],
        },
      });
      expect(usage.daily_posts).toEqual([
        { date: '2026-11-09', tweets_consumed: 140 },
        { date: '2026-11-10', tweets_consumed: 96 },
      ]);
    });

    it('keeps one entry when both date shapes of a day arrive', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: null,
          daily_posts: [
            { date: '2026-11-09', tweets_consumed: 100 },
            { date: '2026-11-09T00:00:00.000Z', tweets_consumed: 140 },
          ],
        },
      });
      expect(usage.daily_posts).toEqual([
        { date: '2026-11-09', tweets_consumed: 140 },
      ]);
    });

    it('ignores usage fields it does not consume', () => {
      const usage = Code.extractXUsage_({
        x_usage: {
          credit_balance_usd: 41.65,
          cycle_posts_consumed: 321,
          prepaid_balance_usd: 25,
          free_balance_usd: 16.65,
          daily_posts: [{ date: '2026-11-08', tweets_consumed: 120 }],
        },
        usage_error: null,
      });
      expect(usage).toEqual({
        balance_usd: 41.65,
        daily_posts: [{ date: '2026-11-08', tweets_consumed: 120 }],
        usage_error: null,
      });
    });

    it('returns all nulls when x_usage itself is null or absent', () => {
      expect(Code.extractXUsage_({ x_usage: null })).toEqual({
        balance_usd: null,
        daily_posts: null,
        usage_error: null,
      });
      expect(Code.extractXUsage_({})).toEqual({
        balance_usd: null,
        daily_posts: null,
        usage_error: null,
      });
      expect(Code.extractXUsage_(null)).toEqual({
        balance_usd: null,
        daily_posts: null,
        usage_error: null,
      });
    });

    it('keeps usage_error even when x_usage is null', () => {
      const usage = Code.extractXUsage_({
        x_usage: null,
        usage_error: 'tweet-gas bearer unavailable',
      });
      expect(usage.usage_error).toBe('tweet-gas bearer unavailable');
      expect(usage.balance_usd).toBeNull();
    });
  });

  describe('xDailyDateKey_', () => {
    it('keeps a plain date and cuts an ISO timestamp to its day', () => {
      expect(Code.xDailyDateKey_('2026-11-10')).toBe('2026-11-10');
      expect(Code.xDailyDateKey_('2026-11-10T00:00:00.000Z')).toBe(
        '2026-11-10'
      );
    });

    it('formats a stored Date cell in Asia/Tokyo', () => {
      expect(Code.xDailyDateKey_(new Date('2026-11-10T00:00:00.000Z'))).toBe(
        '2026-11-10'
      );
      // 16:00 UTC is already the next day in Tokyo.
      expect(Code.xDailyDateKey_(new Date('2026-11-09T16:00:00.000Z'))).toBe(
        '2026-11-10'
      );
    });

    it('returns null for anything without a leading date', () => {
      expect(Code.xDailyDateKey_('not-a-date')).toBeNull();
      expect(Code.xDailyDateKey_('')).toBeNull();
      expect(Code.xDailyDateKey_(null)).toBeNull();
      expect(Code.xDailyDateKey_(undefined)).toBeNull();
      expect(Code.xDailyDateKey_(20261110)).toBeNull();
    });
  });

  describe('history rows', () => {
    const snapshotWithX = () => ({
      collected_at: '2026-11-10T00:00:00.000Z',
      instagram: { freddiefujiwara: 2000 },
      threads: { followers: 252 },
      youtube: { subscribers: 10 },
      x: {
        followers: 321,
        username: 'freddiefujiwara',
        recent_posts: [
          {
            id: '2001',
            posted_at: '2026-11-09T10:00:00.000Z',
            text: '投稿その1',
            url: 'https://x.com/i/web/status/2001',
            views: 500,
            likes: 12,
            reposts: 3,
            replies: 2,
          },
        ],
      },
    });

    it('counts X in the account row total and the trailing cell', () => {
      const row = Code.buildSnsHistoryAccountRow_(snapshotWithX());
      expect(row).toHaveLength(Code.SNS_HISTORY_ACCOUNT_COLUMNS.length);
      const totalIndex = Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('total_followers');
      expect(row[totalIndex]).toBe(2000 + 252 + 10 + 321);
      const xIndex = Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('x_followers');
      expect(row[xIndex]).toBe(321);
      // The API balance column rides last, after x_followers.
      const balanceIndex =
        Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('x_api_balance_usd');
      expect(balanceIndex).toBe(Code.SNS_HISTORY_ACCOUNT_COLUMNS.length - 1);
      expect(row[balanceIndex]).toBe('');
    });

    it('builds one x_media row per post, without the derived URL', () => {
      const rows = Code.buildSnsHistoryXMediaRows_(snapshotWithX());
      expect(rows).toEqual([
        [
          '2026-11-10T00:00:00.000Z',
          '2001',
          '2026-11-09T10:00:00.000Z',
          '投稿その1',
          500,
          12,
          3,
          2,
        ],
      ]);
    });

    it('builds one x_daily row per consumed day', () => {
      const snap = snapshotWithX();
      snap.x.api_daily_posts = [
        { date: '2026-11-08', tweets_consumed: 120 },
        { date: '2026-11-09', tweets_consumed: null },
      ];
      expect(Code.buildSnsHistoryXDailyRows_(snap)).toEqual([
        ['2026-11-08', 120, '2026-11-10T00:00:00.000Z'],
        ['2026-11-09', '', '2026-11-10T00:00:00.000Z'],
      ]);
      // A failed daily fetch (null) contributes no rows.
      snap.x.api_daily_posts = null;
      expect(Code.buildSnsHistoryXDailyRows_(snap)).toEqual([]);
    });

    it('keys x_daily rows by the calendar day of timestamp-shaped dates', () => {
      const snap = snapshotWithX();
      snap.x.api_daily_posts = [
        { date: '2026-11-09T00:00:00.000Z', tweets_consumed: 140 },
      ];
      expect(Code.buildSnsHistoryXDailyRows_(snap)).toEqual([
        ['2026-11-09', 140, '2026-11-10T00:00:00.000Z'],
      ]);
    });

    it('upserts x_daily end to end through appendSnsHistory_', () => {
      const snap = snapshotWithX();
      snap.x.api_daily_posts = [{ date: '2026-11-09', tweets_consumed: 100 }];
      serveTabs({});
      Code.appendSnsHistory_(snap);
      expect(sheets.x_daily.rows[0]).toEqual(Code.SNS_HISTORY_X_DAILY_COLUMNS);
      expect(sheets.x_daily.rows).toHaveLength(2);
      snap.x.api_daily_posts = [{ date: '2026-11-09', tweets_consumed: 140 }];
      Code.appendSnsHistory_(snap);
      // Still one row for the day, carrying the newer count.
      expect(sheets.x_daily.rows).toHaveLength(2);
      expect(sheets.x_daily.rows[1][1]).toBe(140);
    });

    it('merges a stored timestamp-shaped x_daily row into the normalized day', () => {
      serveTabs({
        x_daily: [
          Code.SNS_HISTORY_X_DAILY_COLUMNS,
          ['2026-11-09T00:00:00.000Z', 100, '2026-11-10T00:00:00.000Z'],
        ],
      });
      const snap = snapshotWithX();
      snap.x.api_daily_posts = [{ date: '2026-11-09', tweets_consumed: 140 }];
      Code.appendSnsHistory_(snap);
      // The legacy row converges onto the day key instead of
      // surviving as a second row for the same day.
      expect(sheets.x_daily.rows).toHaveLength(2);
      expect(sheets.x_daily.rows[1][0]).toBe('2026-11-09');
      expect(sheets.x_daily.rows[1][1]).toBe(140);
    });

    it('upserts x_media end to end through appendSnsHistory_', () => {
      serveTabs({});
      Code.appendSnsHistory_(snapshotWithX());
      expect(sheets.x_media.rows[0]).toEqual(Code.SNS_HISTORY_X_MEDIA_COLUMNS);
      expect(sheets.x_media.rows).toHaveLength(2);
      const updated = snapshotWithX();
      updated.collected_at = '2026-11-10T01:00:00.000Z';
      updated.x.recent_posts[0].views = 640;
      Code.appendSnsHistory_(updated);
      // Still one row for the post, carrying the newer numbers.
      expect(sheets.x_media.rows).toHaveLength(2);
      expect(sheets.x_media.rows[1][4]).toBe(640);
    });
  });

  describe('sheet-backed read side', () => {
    const accountRow = (values) => {
      const row = Code.SNS_HISTORY_ACCOUNT_COLUMNS.map(() => '');
      for (const [name, value] of Object.entries(values)) {
        row[Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf(name)] = value;
      }
      return row;
    };

    it('builds the X section of sns_detail from the sheet', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-10T00:00:00.000Z',
            ig_followers: 2000,
            threads_followers: 252,
            youtube_subscribers: 10,
            x_followers: 321,
          }),
        ],
        x_media: [
          Code.SNS_HISTORY_X_MEDIA_COLUMNS,
          [
            '2026-11-10T00:00:00.000Z',
            '2001',
            '2026-11-09T10:00:00.000Z',
            '古い投稿',
            500,
            12,
            3,
            2,
          ],
          [
            '2026-11-10T00:00:00.000Z',
            '2002',
            '2026-11-09T12:00:00.000Z',
            '新しい投稿',
            900,
            30,
            5,
            4,
          ],
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.x.followers).toBe(321);
      expect(detail.x.api_balance_usd).toBeNull();
      expect(detail.x.username).toBeNull();
      expect(detail.x.recent_posts.map((post) => post.id)).toEqual([
        '2002',
        '2001',
      ]);
      expect(detail.x.recent_posts[0].url).toBe(
        'https://x.com/i/web/status/2002'
      );
      expect(detail.x.recent_posts[0].views).toBe(900);
    });

    it('carries the daily posts through the sheet into sns_detail', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-10T00:00:00.000Z',
            x_followers: 321,
            x_api_balance_usd: 41.65,
          }),
        ],
        x_daily: [
          Code.SNS_HISTORY_X_DAILY_COLUMNS,
          ['2026-11-09', 140, '2026-11-10T00:00:00.000Z'],
          ['2026-11-08', '', '2026-11-10T00:00:00.000Z'],
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.x.api_daily_posts).toEqual([
        { date: '2026-11-08', tweets_consumed: null },
        { date: '2026-11-09', tweets_consumed: 140 },
      ]);
    });

    it('normalizes stored x_daily date shapes on the read side', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-10T00:00:00.000Z',
            x_followers: 321,
            x_api_balance_usd: 41.65,
          }),
        ],
        x_daily: [
          Code.SNS_HISTORY_X_DAILY_COLUMNS,
          // A row stored in the timestamp shape, the same day
          // stored again normalized, and a date cell Sheets
          // coerced into a Date: one entry per calendar day.
          ['2026-11-09T00:00:00.000Z', 100, '2026-11-10T00:00:00.000Z'],
          ['2026-11-09', 140, '2026-11-10T01:00:00.000Z'],
          [new Date('2026-11-08T00:00:00.000Z'), 55, '2026-11-10T00:00:00.000Z'],
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.x.api_daily_posts).toEqual([
        { date: '2026-11-08', tweets_consumed: 55 },
        { date: '2026-11-09', tweets_consumed: 140 },
      ]);
    });

    it('carries the API balance through the account row, sns_detail and sns_history', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-10T00:00:00.000Z',
            x_followers: 321,
            x_api_balance_usd: 41.65,
          }),
        ],
      });
      const detail = Code.buildSnsDetailFromSheet_();
      expect(detail.x.api_balance_usd).toBe(41.65);
      const response = Code.buildSnsHistoryResponse_();
      expect(response.rows).toHaveLength(1);
      expect(response.rows[0].x_api_balance_usd).toBe(41.65);
    });

    it('writes the API balance into the appended account row', () => {
      const row = Code.buildSnsHistoryAccountRow_({
        collected_at: '2026-11-10T00:00:00.000Z',
        x: { followers: 321, api_balance_usd: 41.65 },
      });
      const balanceIndex =
        Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('x_api_balance_usd');
      expect(row[balanceIndex]).toBe(41.65);
    });

    it('serves x_followers in sns_history from the canonical position when the stored header predates the column', () => {
      const oldColumns = Code.SNS_HISTORY_ACCOUNT_COLUMNS.slice(
        0,
        Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('x_followers')
      );
      expect(oldColumns).not.toContain('x_followers');
      const dataRow = oldColumns.map(() => '');
      dataRow[0] = '2026-11-10T00:00:00.000Z';
      dataRow.push(321); // the x_followers cell, past the old header
      const accountSheet = {
        getLastRow: () => 2,
        getRange: (row, col, numRows, numCols) => ({
          getValues: () =>
            [oldColumns, dataRow]
              .slice(row - 1, row - 1 + numRows)
              .map((r) => r.slice(col - 1, col - 1 + numCols)),
        }),
      };
      global.SpreadsheetApp = {
        openById: vi.fn(() => ({
          getSheetByName: (name) => (name === 'account' ? accountSheet : null),
        })),
      };
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      const response = Code.buildSnsHistoryResponse_();
      expect(response.rows).toHaveLength(1);
      expect(response.rows[0].x_followers).toBe(321);
    });
  });

  describe('public projection', () => {
    it('includes x.followers in sns_counts and stays null-safe', () => {
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify({
        collected_at: '2026-11-10T00:00:00.000Z',
        x: { followers: 321, recent_posts: [{ id: '2001' }] },
      });
      const response = Code.buildSnsCountsResponse_();
      expect(response.x).toEqual({ followers: 321 });
    });
  });

  describe('X reaction detail from the notify RSS', () => {
    const NOTIFY_URL = 'https://example.com/x.freddie.notify.xml';
    const COLLECTED = '2026-11-19T01:00:00.000Z';

    // Modeled on the live feed: CDATA title / description,
    // the xn extension elements, an aggregated like naming
    // two actors, a reply (its tweet-id is the reply's own),
    // a follow (no tweet-id), and a system notice.
    const FEED_XML = [
      '<?xml version="1.0" encoding="UTF-8" ?>',
      '<rss version="2.0" xmlns:xn="https://freddiefujiwara.com/ns/x-notify">',
      '<channel>',
      '<item>',
      '  <title><![CDATA[Alice (@alice) - like]]></title>',
      '  <link>https://twitter.com/freddiefujiwara/status/3001</link>',
      '  <description><![CDATA[自分の投稿]]></description>',
      '  <pubDate>Wed, 18 Nov 2026 12:51:28 +0000</pubDate>',
      '  <guid isPermaLink="false">x-notify-like-alice-3001</guid>',
      '  <xn:kind>like</xn:kind>',
      '  <xn:actor username="alice">Alice</xn:actor>',
      '  <xn:actor username="bob">Bob</xn:actor>',
      '  <xn:tweet-id>3001</xn:tweet-id>',
      '  <xn:message>Alice and Bob liked your post</xn:message>',
      '</item>',
      '<item>',
      '  <title><![CDATA[Carol (@carol) - reply]]></title>',
      '  <link>https://twitter.com/carol/status/4001</link>',
      '  <description><![CDATA[@freddiefujiwara 返信の本文です]]></description>',
      '  <pubDate>Sat, 17 Oct 2026 04:35:06 +0000</pubDate>',
      '  <guid isPermaLink="false">x-notify-reply-carol-4001</guid>',
      '  <xn:kind>reply</xn:kind>',
      '  <xn:actor username="carol">Carol</xn:actor>',
      '  <xn:tweet-id>4001</xn:tweet-id>',
      '  <xn:message></xn:message>',
      '</item>',
      '<item>',
      '  <title><![CDATA[Dave (@dave) - follow]]></title>',
      '  <link>https://twitter.com/dave</link>',
      '  <description><![CDATA[]]></description>',
      '  <pubDate>Wed, 18 Nov 2026 01:00:00 +0000</pubDate>',
      '  <guid isPermaLink="false">x-notify-follow-dave</guid>',
      '  <xn:kind>follow</xn:kind>',
      '  <xn:actor username="dave">Dave</xn:actor>',
      '  <xn:message>Dave followed you</xn:message>',
      '</item>',
      '<item>',
      '  <title><![CDATA[System - unknown]]></title>',
      '  <link>https://twitter.com/</link>',
      '  <description><![CDATA[Your blue checkmark is here!]]></description>',
      '  <pubDate>Wed, 18 Nov 2026 01:00:00 +0000</pubDate>',
      '  <guid isPermaLink="false">x-notify-unknown-freddiefujiwara</guid>',
      '  <xn:kind>unknown</xn:kind>',
      '  <xn:message>Your blue checkmark is here!</xn:message>',
      '</item>',
      '</channel>',
      '</rss>',
    ].join('\n');

    describe('parseXNotifyFeed_', () => {
      it('reads kind, every actor, tweet-id, body and pubDate per item', () => {
        const items = Code.parseXNotifyFeed_(FEED_XML);
        expect(items).toHaveLength(4);
        expect(items[0]).toEqual({
          guid: 'x-notify-like-alice-3001',
          kind: 'like',
          actors: [
            { name: 'Alice', username: 'alice' },
            { name: 'Bob', username: 'bob' },
          ],
          tweetId: '3001',
          text: '自分の投稿',
          actedAt: '2026-11-18T12:51:28.000Z',
        });
        expect(items[1].kind).toBe('reply');
        expect(items[1].tweetId).toBe('4001');
        expect(items[1].text).toBe('@freddiefujiwara 返信の本文です');
        expect(items[1].actedAt).toBe('2026-10-17T04:35:06.000Z');
        expect(items[2].kind).toBe('follow');
        expect(items[2].tweetId).toBe('');
      });

      it('falls back to the guid and title when the extensions are absent', () => {
        const bare = FEED_XML.replace(/ *<xn:.*\n/g, '');
        const items = Code.parseXNotifyFeed_(bare);
        expect(items[0].kind).toBe('like');
        expect(items[0].tweetId).toBe('3001');
        expect(items[0].actors).toEqual([
          { name: 'Alice', username: 'alice' },
        ]);
        expect(items[2].kind).toBe('follow');
        expect(items[2].actors).toEqual([{ name: 'Dave', username: 'dave' }]);
      });

      it('decodes entities in non-CDATA bodies', () => {
        const xml =
          '<rss><channel><item>' +
          '<title>Fish &amp; Chips (@fish) - like</title>' +
          '<description>1 &lt; 2 &amp; 3</description>' +
          '<pubDate>Wed, 18 Nov 2026 12:51:28 +0000</pubDate>' +
          '<guid>x-notify-like-fish-3001</guid>' +
          '<xn:kind>like</xn:kind>' +
          '<xn:actor username="fish">Fish &amp; Chips</xn:actor>' +
          '<xn:tweet-id>3001</xn:tweet-id>' +
          '</item></channel></rss>';
        const items = Code.parseXNotifyFeed_(xml);
        expect(items[0].text).toBe('1 < 2 & 3');
        expect(items[0].actors[0].name).toBe('Fish & Chips');
      });
    });

    describe('buildXReactionRows_', () => {
      const items = () => Code.parseXNotifyFeed_(FEED_XML);

      it('expands an aggregated like into one fact per named actor', () => {
        const rows = Code.buildXReactionRows_(items(), COLLECTED);
        expect(rows).toContainEqual([
          'like|3001|alice',
          'like',
          '3001',
          'Alice',
          'alice',
          '',
          '',
          '',
          COLLECTED,
        ]);
        expect(rows).toContainEqual([
          'like|3001|bob',
          'like',
          '3001',
          'Bob',
          'bob',
          '',
          '',
          '',
          COLLECTED,
        ]);
      });

      it('keeps a reply unattributed, keyed by its own tweet id', () => {
        const rows = Code.buildXReactionRows_(items(), COLLECTED);
        expect(rows).toContainEqual([
          'reply|4001',
          'reply',
          '',
          'Carol',
          'carol',
          '@freddiefujiwara 返信の本文です',
          '4001',
          '2026-10-17T04:35:06.000Z',
          COLLECTED,
        ]);
      });

      it('stores follows as account-level facts and skips system notices', () => {
        const rows = Code.buildXReactionRows_(items(), COLLECTED);
        expect(rows).toContainEqual([
          'follow||dave',
          'follow',
          '',
          'Dave',
          'dave',
          '',
          '',
          '',
          COLLECTED,
        ]);
        expect(rows).toHaveLength(4);
      });

      it('collapses repeated keys inside one feed', () => {
        const doubled = items().concat(items());
        expect(Code.buildXReactionRows_(doubled, COLLECTED)).toHaveLength(4);
      });
    });

    describe('fetchXNotifyFeed_', () => {
      it('does not fetch while X_NOTIFY_URL is unset', () => {
        expect(Code.fetchXNotifyFeed_()).toBeNull();
        expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
      });

      it('returns null for a missing file and a body without items', () => {
        store.X_NOTIFY_URL = NOTIFY_URL;
        fetchHandler = () => res(404, 'not found');
        expect(Code.fetchXNotifyFeed_()).toBeNull();
        fetchHandler = () => res(200, '<html>not a feed</html>');
        expect(Code.fetchXNotifyFeed_()).toBeNull();
      });

      it('returns the raw XML of a healthy feed', () => {
        store.X_NOTIFY_URL = NOTIFY_URL;
        fetchHandler = () => res(200, FEED_XML);
        expect(Code.fetchXNotifyFeed_()).toBe(FEED_XML);
      });
    });

    describe('collectXReactions_', () => {
      it('stores new facts once and dedupes the next scan of the same window', () => {
        serveTabs({});
        store.X_NOTIFY_URL = NOTIFY_URL;
        fetchHandler = () => res(200, FEED_XML);
        const first = Code.collectXReactions_(spreadsheet, COLLECTED);
        expect(first.stored).toBe(4);
        expect(first.error).toBeNull();
        expect(sheets.x_reactions.rows[0]).toEqual(
          Code.SNS_HISTORY_X_REACTIONS_COLUMNS
        );
        expect(sheets.x_reactions.rows).toHaveLength(5);
        const second = Code.collectXReactions_(
          spreadsheet,
          '2026-11-19T02:00:00.000Z'
        );
        expect(second.stored).toBe(0);
        expect(sheets.x_reactions.rows).toHaveLength(5);
      });

      it('leaves the tab untouched while the feed cannot be fetched', () => {
        serveTabs({});
        store.X_NOTIFY_URL = NOTIFY_URL;
        fetchHandler = () => res(404, 'not found');
        const result = Code.collectXReactions_(spreadsheet, COLLECTED);
        expect(result).toEqual({ stored: 0, error: null });
        expect(sheets.x_reactions).toBeUndefined();
      });

      it('prunes facts collected over 120 days ago', () => {
        const oldRow = [
          'like|1000|old',
          'like',
          '1000',
          'Old',
          'old',
          '',
          '',
          '',
          '2026-07-01T00:00:00.000Z',
        ];
        serveTabs({
          x_reactions: [Code.SNS_HISTORY_X_REACTIONS_COLUMNS, oldRow],
        });
        store.X_NOTIFY_URL = NOTIFY_URL;
        fetchHandler = () => res(200, FEED_XML);
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-19T00:00:00.000Z'));
        try {
          Code.collectXReactions_(spreadsheet, COLLECTED);
        } finally {
          vi.useRealTimers();
        }
        const keys = sheets.x_reactions.rows.map((row) => row[0]);
        expect(keys).not.toContain('like|1000|old');
        expect(keys).toContain('like|3001|alice');
      });
    });

    describe('sheet-backed read side', () => {
      const accountRow = (values) => {
        const row = Code.SNS_HISTORY_ACCOUNT_COLUMNS.map(() => '');
        for (const [name, value] of Object.entries(values)) {
          row[Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf(name)] = value;
        }
        return row;
      };

      it('groups likes under their post, replies stay unattributed, follows list newest first', () => {
        serveTabs({
          account: [
            Code.SNS_HISTORY_ACCOUNT_COLUMNS,
            accountRow({
              collected_at: '2026-11-19T00:00:00.000Z',
              x_followers: 321,
            }),
          ],
          x_media: [
            Code.SNS_HISTORY_X_MEDIA_COLUMNS,
            [
              '2026-11-19T00:00:00.000Z',
              '3001',
              '2026-11-18T10:00:00.000Z',
              '対象の投稿',
              500,
              12,
              3,
              2,
            ],
          ],
          x_reactions: [
            Code.SNS_HISTORY_X_REACTIONS_COLUMNS,
            [
              'like|3001|alice',
              'like',
              '3001',
              'Alice',
              'alice',
              '',
              '',
              '',
              '2026-11-19T00:00:00.000Z',
            ],
            [
              'reply|4001',
              'reply',
              '',
              'Carol',
              'carol',
              '返信の本文です',
              '4001',
              '2026-10-17T04:35:06.000Z',
              '2026-11-19T00:00:00.000Z',
            ],
            [
              'like|9999|mallory',
              'like',
              '9999',
              'Mallory',
              'mallory',
              '',
              '',
              '',
              '2026-11-19T00:00:00.000Z',
            ],
            [
              'follow||dave',
              'follow',
              '',
              'Dave',
              'dave',
              '',
              '',
              '',
              '2026-11-18T00:00:00.000Z',
            ],
            [
              'follow||erin',
              'follow',
              '',
              'Erin',
              'erin',
              '',
              '',
              '',
              '2026-11-19T00:00:00.000Z',
            ],
          ],
        });
        const detail = Code.buildSnsDetailFromSheet_();
        expect(Object.keys(detail.x.reactions)).toEqual(['3001']);
        expect(detail.x.reactions['3001']).toHaveLength(1);
        expect(detail.x.reactions['3001'][0].actor_username).toBe('alice');
        expect(detail.x.unattributed_reactions).toHaveLength(1);
        expect(detail.x.unattributed_reactions[0].kind).toBe('reply');
        expect(detail.x.unattributed_reactions[0].text).toBe('返信の本文です');
        expect(
          detail.x.recent_follows.map((entry) => entry.actor_username)
        ).toEqual(['erin', 'dave']);
      });

      it('leaves reactions null while the tab does not exist', () => {
        serveTabs({
          account: [
            Code.SNS_HISTORY_ACCOUNT_COLUMNS,
            accountRow({
              collected_at: '2026-11-19T00:00:00.000Z',
              x_followers: 321,
            }),
          ],
        });
        const detail = Code.buildSnsDetailFromSheet_();
        expect(detail.x.reactions).toBeNull();
        expect(detail.x.unattributed_reactions).toBeNull();
        expect(detail.x.recent_follows).toBeNull();
      });
    });
  });

});
