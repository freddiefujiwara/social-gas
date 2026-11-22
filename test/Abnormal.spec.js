import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Code from '../src/Code.js';

// Abnormal-case tests: the pure shaping / aggregation / RSS
// functions fed with deformed versions of what actually arrives
// from outside — Meta Graph API JSON (IG / Threads insights,
// comments, DMs), GA4 report rows, the X wire payloads, and
// Sheets history cells. The recurring defect family across the
// fleet: a bare Number() coercion reads null / '' / whitespace /
// booleans / arrays as real counts (0, 1, the element), and a
// value whose toString is not a function (producible via JSON,
// e.g. {"toString":[]}) makes String() / Number() / Date.parse
// throw, letting one deformed row kill a whole feed or
// aggregation. The contract asserted here: deformed values read
// as absent (null / skipped / empty), never as invented numbers,
// and never by throwing.
const evil = () => JSON.parse('{"toString":[]}');

describe('snsHistoryNumberCell_ reads only real numbers', () => {
  const num = Code.snsHistoryNumberCell_;
  it('keeps finite numbers and numeric strings', () => {
    expect(num(42)).toBe(42);
    expect(num(0)).toBe(0);
    expect(num(-3.5)).toBe(-3.5);
    expect(num('42')).toBe(42);
    expect(num(' 42 ')).toBe(42);
    expect(num('1e3')).toBe(1000);
  });
  it('reads absent and non-numeric values as null', () => {
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(NaN)).toBeNull();
    expect(num(Infinity)).toBeNull();
  });
  it('does not coerce booleans, arrays, whitespace or Dates into counts', () => {
    expect(num(true)).toBeNull();
    expect(num(false)).toBeNull();
    expect(num([65])).toBeNull();
    expect(num([])).toBeNull();
    expect(num('  ')).toBeNull();
    expect(num(new Date(0))).toBeNull();
    expect(num({})).toBeNull();
  });
  it('never throws on an unstringifiable cell', () => {
    expect(() => num(evil())).not.toThrow();
    expect(num(evil())).toBeNull();
  });
});

describe('historyTextOrNull_ is a total text boundary', () => {
  const text = Code.historyTextOrNull_;
  it('keeps strings and stringifies scalar cells', () => {
    expect(text('abc')).toBe('abc');
    expect(text(42)).toBe('42');
    expect(text(true)).toBe('true');
    expect(typeof text(new Date(0))).toBe('string');
  });
  it('reads empty as null', () => {
    expect(text(null)).toBeNull();
    expect(text(undefined)).toBeNull();
    expect(text('')).toBeNull();
  });
  it('does not leak non-scalar cells as "[object Object]" or "1,2"', () => {
    expect(text({})).toBeNull();
    expect(text([1, 2])).toBeNull();
  });
  it('never throws on an unstringifiable cell', () => {
    expect(() => text(evil())).not.toThrow();
    expect(text(evil())).toBeNull();
  });
});

describe('escapeXmlText_ output is always feed-safe', () => {
  const esc = Code.escapeXmlText_;
  it('escapes the five specials', () => {
    expect(esc('<a & "b" \'c\'>')).toBe(
      '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;'
    );
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('42');
  });
  it('strips C0 control characters other than tab / LF / CR', () => {
    expect(esc('a\u0001\u0008\u000b\u000c\u001fb')).toBe('ab');
    expect(esc('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });
  it('leaves no lone surrogates behind', () => {
    const out = esc('\ud800x\udc00');
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
    expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
    // A well-formed pair survives untouched.
    expect(esc('🎉')).toBe('🎉');
  });
  it('never throws on an unstringifiable value', () => {
    expect(() => esc(evil())).not.toThrow();
    expect(esc(evil())).toBe('');
  });
});

describe('buildCommentsRss_ survives deformed rows', () => {
  const build = Code.buildCommentsRss_;
  const good = {
    id: 'c1',
    username: 'alice',
    text: 'hello',
    posted_at: '2026-11-19T01:02:03.000Z',
    permalink: 'https://example.com/c1',
  };
  it('builds an empty channel feed for non-array rows', () => {
    for (const rows of [null, undefined, 'nope', 42, {}]) {
      const xml = build('instagram', rows);
      expect(xml).toContain('<channel>');
      expect(xml).not.toContain('<item>');
    }
  });
  it('skips null and non-object entries instead of killing the feed', () => {
    const xml = build('instagram', [null, 42, 'x', good]);
    expect(xml).toContain('<item>');
    expect(xml).toContain('hello');
  });
  it('coerces scalar text fields instead of throwing on .slice', () => {
    const xml = build('instagram', [{ ...good, text: 42, username: 7 }]);
    expect(xml).toContain('42');
    expect(xml).toContain('@7:');
  });
  it('treats unstringifiable text fields as empty, unstringifiable id as no id', () => {
    const xml = build('instagram', [
      { ...good, id: 'c2', text: evil(), username: evil() },
    ]);
    expect(xml).toContain('<item>');
    const skipped = build('instagram', [{ ...good, id: evil() }]);
    expect(skipped).not.toContain('<item>');
  });
  it('skips rows whose posted_at cannot be read as an instant', () => {
    expect(build('instagram', [{ ...good, posted_at: evil() }])).not.toContain(
      '<item>'
    );
    expect(
      build('instagram', [{ ...good, posted_at: 'not a date' }])
    ).not.toContain('<item>');
  });
  it('falls back to the channel link for an unreadable permalink', () => {
    const xml = build('instagram', [{ ...good, permalink: evil() }]);
    expect(xml).toContain('https://www.instagram.com/freddiefujiwara/');
  });
  it('never splits a surrogate pair at the title truncation', () => {
    const text = 'a'.repeat(59) + '🎉' + 'b'.repeat(10);
    const xml = build('instagram', [{ ...good, text }]);
    const title = xml.split('<title>')[2].split('</title>')[0];
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(title)).toBe(false);
    expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(title)).toBe(false);
  });
  it('keeps the valid items when one row in the middle is deformed', () => {
    const xml = build('instagram', [
      good,
      { id: 'bad', username: 'x', text: 't', posted_at: evil(), permalink: '' },
      { ...good, id: 'c3', posted_at: '2026-11-20T01:02:03.000Z' },
    ]);
    expect((xml.match(/<item>/g) || []).length).toBe(2);
  });
});

describe('insights value readers treat missing values as absent, not zero', () => {
  it('parseInsightsTotalValue_', () => {
    const read = Code.parseInsightsTotalValue_;
    expect(read({ data: [{ total_value: { value: 9 } }] })).toBe(9);
    expect(read({ data: [{ total_value: { value: '9' } }] })).toBe(9);
    expect(read({ data: [{ total_value: { value: null } }] })).toBeNull();
    expect(read({ data: [{ total_value: { value: '' } }] })).toBeNull();
    expect(read({ data: [{ total_value: { value: '  ' } }] })).toBeNull();
    expect(read({ data: [{ total_value: { value: true } }] })).toBeNull();
    expect(read({ data: [{ total_value: { value: [5] } }] })).toBeNull();
    expect(read({ data: [{ total_value: { value: evil() } }] })).toBeNull();
  });
  it('parseInsightsDailySum_ only sums reported values', () => {
    const sum = Code.parseInsightsDailySum_;
    expect(sum({ data: [{ values: [{ value: 1 }, { value: 2 }] }] })).toBe(3);
    expect(sum({ data: [{ values: [{ value: null }] }] })).toBeNull();
    expect(sum({ data: [{ values: [{ value: '' }] }] })).toBeNull();
    expect(sum({ data: [{ values: [{ value: true }] }] })).toBeNull();
    expect(sum({ data: [{ values: [{ value: [5] }] }] })).toBeNull();
    expect(
      sum({ data: [{ values: [{ value: null }, { value: 4 }] }] })
    ).toBe(4);
  });
  it('parseViewsDailyTotal_ falls through to the daily values', () => {
    const read = Code.parseViewsDailyTotal_;
    expect(
      read({ data: [{ total_value: { value: null }, values: [{ value: 5 }] }] })
    ).toBe(5);
    expect(read({ data: [{ values: [{ value: null }] }] })).toBeNull();
    expect(read({ data: [{ total_value: { value: true } }] })).toBeNull();
  });
  it('parseViewsBreakdown_ derives the total from the parts when unreported', () => {
    const read = Code.parseViewsBreakdown_;
    const data = {
      data: [
        {
          total_value: {
            value: null,
            breakdowns: [
              {
                dimension_keys: ['follow_type'],
                results: [
                  { dimension_values: ['FOLLOWER'], value: 30 },
                  { dimension_values: ['NON_FOLLOWER'], value: 70 },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(read(data)).toEqual({ total: 100, follower: 30, nonFollower: 70 });
    const nullRow = {
      data: [
        {
          total_value: {
            value: 5,
            breakdowns: [
              {
                dimension_keys: ['follow_type'],
                results: [{ dimension_values: ['FOLLOWER'], value: null }],
              },
            ],
          },
        },
      ],
    };
    expect(read(nullRow)).toBeNull();
  });
  it('threadsInsightEntryTotal_ falls through and stays null', () => {
    const read = Code.threadsInsightEntryTotal_;
    expect(read({ total_value: { value: null }, values: [{ value: 5 }] })).toBe(
      5
    );
    expect(read({ values: [{ value: null }] })).toBeNull();
    expect(read({ values: [{ value: '' }] })).toBeNull();
    expect(read({ total_value: { value: [5] } })).toBeNull();
  });
  it('parseThreadsMediaInsights_ omits metrics that reported nothing', () => {
    const read = Code.parseThreadsMediaInsights_;
    expect(read({ data: [{ name: 'views', values: [{ value: null }] }] })).toEqual(
      {}
    );
    expect(read({ data: [{ name: 'views', values: [{ value: '' }] }] })).toEqual(
      {}
    );
    expect(
      read({ data: [{ name: 'views', values: [{ value: true }] }] })
    ).toEqual({});
    expect(read({ data: [{ name: 'views', values: [{ value: 12 }] }] })).toEqual({
      views: 12,
    });
  });
  it('parseMediaInsights_ omits metrics that reported nothing', () => {
    const read = Code.parseMediaInsights_;
    expect(read({ data: [{ name: 'views', values: [{ value: null }] }] })).toEqual(
      {}
    );
    expect(read({ data: [{ name: 'views', values: [{ value: '' }] }] })).toEqual(
      {}
    );
    expect(
      read({ data: [{ name: 'views', values: [{ value: [5] }] }] })
    ).toEqual({});
    expect(read({ data: [{ name: 'views', values: [{ value: 12 }] }] })).toEqual({
      views: 12,
    });
  });
  it('parseFollowsBreakdown_ leaves unreported sides null', () => {
    const read = Code.parseFollowsBreakdown_;
    const data = {
      data: [
        {
          total_value: {
            breakdowns: [
              {
                dimension_keys: ['follow_type'],
                results: [
                  { dimension_values: ['FOLLOWER'], value: null },
                  { dimension_values: ['NON_FOLLOWER'], value: 3 },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(read(data)).toEqual({ follows: null, unfollows: 3 });
  });
});

describe('follower count readers treat missing counts as absent', () => {
  it('parseThreadsFollowersCount_', () => {
    const read = Code.parseThreadsFollowersCount_;
    expect(read({ data: [{ values: [{ value: 100 }] }] })).toBe(100);
    expect(read({ data: [{ values: [{ value: null }] }] })).toBeNull();
    expect(read({ data: [{ values: [{ value: '' }] }] })).toBeNull();
    expect(read({ data: [{ values: [{ value: true }] }] })).toBeNull();
    expect(read({ data: [{ values: [{ value: [5] }] }] })).toBeNull();
    // A null total_value must not shadow a reported daily value.
    expect(
      read({
        data: [{ total_value: { value: null }, values: [{ value: 7 }] }],
      })
    ).toBe(7);
  });

  describe('fetch-based readers (UrlFetchApp stubbed)', () => {
    let store;
    const res = (status, body) => ({
      getResponseCode: () => status,
      getContentText: () =>
        typeof body === 'string' ? body : JSON.stringify(body),
    });
    beforeEach(() => {
      store = { META_ACCESS_TOKEN: 'token' };
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
    });
    afterEach(() => {
      delete global.PropertiesService;
      delete global.UrlFetchApp;
    });
    it('fetchGraphFollowersCount_ reads only real counts', () => {
      const fetchWith = (body) => {
        global.UrlFetchApp = { fetch: vi.fn(() => res(200, body)) };
        return Code.fetchGraphFollowersCount_('https://example.com/x');
      };
      expect(fetchWith({ followers_count: 123 })).toBe(123);
      expect(fetchWith({ followers_count: '123' })).toBe(123);
      expect(fetchWith({ followers_count: null })).toBeNull();
      expect(fetchWith({ followers_count: '' })).toBeNull();
      expect(fetchWith({ followers_count: true })).toBeNull();
      expect(fetchWith({ followers_count: [5] })).toBeNull();
    });
    it('fetchInstagramMediaCount_ reads only real counts', () => {
      const fetchWith = (body) => {
        global.UrlFetchApp = { fetch: vi.fn(() => res(200, body)) };
        return Code.fetchInstagramMediaCount_();
      };
      expect(fetchWith({ media_count: 45 })).toBe(45);
      expect(fetchWith({ media_count: null })).toBeNull();
      expect(fetchWith({ media_count: '' })).toBeNull();
      expect(fetchWith({ media_count: true })).toBeNull();
      expect(fetchWith({ media_count: [5] })).toBeNull();
    });
  });
});

describe('xWireNumberOrNull_ reads the X wire strictly', () => {
  const num = Code.xWireNumberOrNull_;
  it('keeps numbers and numeric strings', () => {
    expect(num(42)).toBe(42);
    expect(num('42')).toBe(42);
    expect(num(0)).toBe(0);
  });
  it('reads deformed wire values as null instead of coercing them', () => {
    expect(num('')).toBeNull();
    expect(num('  ')).toBeNull();
    expect(num(true)).toBeNull();
    expect(num([5])).toBeNull();
    expect(num([])).toBeNull();
    expect(num({})).toBeNull();
  });
  it('never throws on an unstringifiable wire value', () => {
    expect(() => num(evil())).not.toThrow();
    expect(num(evil())).toBeNull();
  });
});

describe('rankTopArticles_ survives deformed GA4 rows', () => {
  const id = '1tn5P1vB1jnKHSay_FC2AEtNxH0gQZ3_jffRnHuz4YpM';
  const row = (path, views) => ({
    dimensionValues: [{ value: path }],
    metricValues: [{ value: views }],
  });
  it('skips null and non-object rows', () => {
    expect(Code.rankTopArticles_([null, 42, 'x', row('/' + id, '10')], 10)).toEqual([
      { id, views: 10 },
    ]);
  });
  it('reads a non-array rows argument as empty', () => {
    expect(Code.rankTopArticles_(null, 10)).toEqual([]);
    expect(Code.rankTopArticles_('nope', 10)).toEqual([]);
    expect(Code.rankTopArticles_({}, 10)).toEqual([]);
  });
});

describe('comment parsers keep their shape on deformed API items', () => {
  const allStrings = (obj, keys) =>
    keys.every((key) => typeof obj[key] === 'string');
  it('parseInstagramComments_', () => {
    const out = Code.parseInstagramComments_({
      data: [
        { id: evil(), username: 'a', text: 't', timestamp: '2026-11-19T00:00:00Z' },
        { id: 'ok', username: evil(), text: evil(), timestamp: '2026-11-19T00:00:00Z' },
        null,
        { id: 'ok2', replies: { data: [{ id: evil(), text: 'r' }] } },
      ],
    });
    out.forEach((comment) => {
      expect(allStrings(comment, ['id', 'parent_id', 'username', 'text'])).toBe(
        true
      );
    });
  });
  it('parseThreadsConversation_', () => {
    const out = Code.parseThreadsConversation_(
      {
        data: [
          { id: evil(), username: evil(), text: evil(), timestamp: '2026-11-19T00:00:00Z', permalink: 'https://example.com' },
          { id: 'ok', username: 'bob', text: 'hi', timestamp: '2026-11-19T00:00:00Z' },
        ],
      },
      'post1'
    );
    out.forEach((reply) => {
      expect(allStrings(reply, ['id', 'username', 'text'])).toBe(true);
    });
  });
  it('parseInstagramDmMessages_', () => {
    const out = Code.parseInstagramDmMessages_(
      {
        data: [
          { id: evil(), from: { id: 'u1', username: evil() }, message: evil(), created_time: '2026-11-19T00:00:00Z' },
          { id: 'ok', from: { id: 'u2', username: 'carol' }, message: 'hi', created_time: '2026-11-19T00:00:00Z' },
        ],
      },
      'page1'
    );
    out.forEach((message) => {
      expect(allStrings(message, ['id', 'username', 'text'])).toBe(true);
    });
  });
});

describe('compareTimestampDesc_ never throws on junk timestamps', () => {
  const cmp = Code.compareTimestampDesc_;
  it('orders parseable instants newest first', () => {
    expect(cmp('2026-11-19T00:00:00Z', '2026-11-20T00:00:00Z')).toBeGreaterThan(0);
    expect(cmp('2026-11-20T00:00:00Z', '2026-11-19T00:00:00Z')).toBeLessThan(0);
    expect(cmp(null, null)).toBe(0);
    expect(cmp(undefined, '')).toBe(0);
  });
  it('survives unstringifiable values on either side', () => {
    expect(() => cmp(evil(), '2026-11-19T00:00:00Z')).not.toThrow();
    expect(() => cmp('2026-11-19T00:00:00Z', evil())).not.toThrow();
    expect(() => cmp(evil(), evil())).not.toThrow();
  });
});

describe('perf RSS builders survive deformed history rows', () => {
  it('perfSnapshotAt_ skips null rows and reads string counts as absent', () => {
    const snap = Code.perfSnapshotAt_(
      [
        null,
        { collected_at: '2026-11-19T00:00:00.000Z', total_followers: '500' },
        { collected_at: '2026-11-19T01:00:00.000Z', total_followers: 500 },
      ],
      Date.parse('2026-11-19T02:00:00.000Z')
    );
    expect(snap.total).toBe(500);
    const stringOnly = Code.perfSnapshotAt_(
      [{ collected_at: '2026-11-19T00:00:00.000Z', total_followers: '500' }],
      Date.parse('2026-11-19T02:00:00.000Z')
    );
    expect(stringOnly.total).toBeNull();
  });
  it('buildPerfHighlightItem_ is not killed by an unstringifiable caption', () => {
    const slot = {
      key: 'morning',
      label: '朝',
      dateKey: '2026-11-20',
      atMs: Date.parse('2026-11-20T06:00:00+09:00'),
    };
    const data = {
      accountRows: [
        {
          collected_at: '2026-11-19T20:00:00.000Z',
          total_followers: 100,
          ig_followers: 50,
        },
      ],
      mediaRows: [
        { posted_at: '2026-11-19T10:00:00.000Z', caption: evil(), views: 5 },
      ],
      blogDailyRows: [],
      blogPostRows: [],
      blogPostsDailyRows: [],
      dailyRows: [],
      threadsMediaRows: [],
      youtubeMediaRows: [],
      xMediaRows: [],
    };
    let item = null;
    expect(() => {
      item = Code.buildPerfHighlightItem_(slot, null, data);
    }).not.toThrow();
    expect(item).not.toBeNull();
  });
  it('buildPerfRss_ escapes item fields and skips shapeless items', () => {
    const xml = Code.buildPerfRss_([
      null,
      { guid: '', pubDate: 'x' },
      {
        guid: 'g1',
        pubDate: 'Thu, 20 Nov 2026 00:00:00 GMT',
        title: '<b>&',
        descriptionText: 'd',
      },
    ]);
    expect((xml.match(/<item>/g) || []).length).toBe(1);
    expect(xml).toContain('&lt;b&gt;&amp;');
  });
});

describe('JST day windows reject roll-over date keys', () => {
  it('jstDayWindowSec_ returns null for a day that does not exist', () => {
    expect(Code.jstDayWindowSec_('2026-02-30')).toBeNull();
    expect(Code.jstDayWindowSec_('2026-02-29')).toBeNull();
    expect(Code.jstDayWindowSec_('2024-02-29')).not.toBeNull();
    const win = Code.jstDayWindowSec_('2026-11-20');
    expect(win.until - win.since).toBe(86399);
  });
});
