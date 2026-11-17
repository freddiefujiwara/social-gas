import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

// The Instagram DM feed: the hourly collection resolves the
// Facebook Page linked to the Instagram account, scans its
// recent conversations, upserts the received messages into
// ig_dm (dedupe by message id), and serves them through
// comments_rss&source=instagram_dm behind the shared token.
describe('Instagram DM collection and RSS', () => {
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

  const T1 = '2026-11-17T01:00:00.000Z';
  const PAGE_ID = '111222333';
  const IG_ID = '17841401041540002';

  const accountsPage = (pages) => ({
    data: pages,
  });
  const linkedPage = {
    id: PAGE_ID,
    access_token: 'page-token',
    instagram_business_account: { id: IG_ID },
  };

  const routeFetches = ({ conversations = [], messagesByConv = {} } = {}) => {
    fetchHandler = (url) => {
      if (url.includes('/me/accounts')) {
        return res(200, accountsPage([linkedPage]));
      }
      if (url.includes('/' + PAGE_ID + '/conversations')) {
        return res(200, {
          data: conversations.map((id) => ({ id })),
        });
      }
      const match = url.match(/\/([A-Za-z0-9_]+)\/messages\?/);
      if (match && messagesByConv[match[1]]) {
        return res(200, { data: messagesByConv[match[1]] });
      }
      throw new Error('unexpected fetch: ' + url);
    };
  };

  const dm = (id, fromId, fromExtra, text, created) => ({
    id,
    created_time: created,
    from: { id: fromId, ...fromExtra },
    message: text,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    store = { META_ACCESS_TOKEN: 'user-token' };
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

  describe('resolveInstagramPage_', () => {
    it('returns the page linked to the main Instagram account', () => {
      fetchHandler = (url) => {
        expect(url).toContain('/me/accounts');
        return res(
          200,
          accountsPage([
            { id: '999', access_token: 'other', instagram_business_account: { id: '42' } },
            linkedPage,
          ])
        );
      };
      expect(Code.resolveInstagramPage_('user-token')).toEqual({
        pageId: PAGE_ID,
        pageToken: 'page-token',
        error: null,
      });
    });

    it('reports when no page is linked to the account', () => {
      fetchHandler = () => res(200, accountsPage([{ id: '999' }]));
      const page = Code.resolveInstagramPage_('user-token');
      expect(page.pageId).toBeNull();
      expect(page.error).toContain('no linked page');
    });

    it('encodes the nested fields value so UrlFetchApp accepts the URL', () => {
      // Regression: UrlFetchApp.fetch throws "Invalid argument" on
      // a URL with literal braces, which killed the /me/accounts
      // call before any request was sent.
      fetchHandler = (url) => {
        expect(url).toContain('/me/accounts');
        expect(url).toContain('instagram_business_account%7Bid%7D');
        expect(url).not.toContain('{');
        expect(url).not.toContain('}');
        return res(200, accountsPage([linkedPage]));
      };
      expect(Code.resolveInstagramPage_('user-token').error).toBeNull();
    });

    it('reports the fetch reason without leaking the token', () => {
      fetchHandler = (url) => {
        throw new Error('Invalid argument: ' + url);
      };
      const page = Code.resolveInstagramPage_('user-token');
      expect(page.pageId).toBeNull();
      expect(page.error).toContain('fetch exception (Error)');
      expect(page.error).toContain('Invalid argument');
      expect(page.error).not.toContain('user-token');
      expect(page.error).not.toContain('access_token');
    });
  });

  describe('parseInstagramDmMessages_', () => {
    it('keeps received messages only, with the attachment placeholder', () => {
      const parsed = Code.parseInstagramDmMessages_(
        {
          data: [
            dm('m1', 'user-a', { username: 'alice' }, 'こんにちは', '2026-11-17T00:10:00+0000'),
            dm('m2', PAGE_ID, { username: 'freddiefujiwara' }, '自分の送信', '2026-11-17T00:11:00+0000'),
            dm('m3', IG_ID, { username: 'freddiefujiwara' }, '自分の送信2', '2026-11-17T00:12:00+0000'),
            dm('m4', 'user-b', { name: 'Bob' }, undefined, '2026-11-17T00:13:00+0000'),
          ],
        },
        PAGE_ID
      );
      expect(parsed).toEqual([
        {
          id: 'm1',
          username: 'alice',
          text: 'こんにちは',
          posted_at: '2026-11-17T00:10:00+0000',
        },
        {
          id: 'm4',
          username: 'Bob',
          text: '（添付メッセージ）',
          posted_at: '2026-11-17T00:13:00+0000',
        },
      ]);
    });
  });

  describe('collectInstagramDm_', () => {
    it('stores received messages and dedupes them on the next run', () => {
      routeFetches({
        conversations: ['conv1'],
        messagesByConv: {
          conv1: [
            dm('m1', 'user-a', { username: 'alice' }, 'はじめまして', '2026-11-17T00:10:00+0000'),
            dm('m2', PAGE_ID, {}, '返信済み', '2026-11-17T00:20:00+0000'),
          ],
        },
      });
      const first = Code.collectInstagramDm_(spreadsheet, T1);
      expect(first).toEqual({ stored: 1, error: null });
      expect(sheets.ig_dm.rows).toEqual([
        Code.SNS_HISTORY_IG_DM_COLUMNS,
        [
          'm1',
          'conv1',
          'alice',
          'はじめまして',
          '2026-11-17T00:10:00+0000',
          'https://www.instagram.com/direct/inbox/',
          T1,
        ],
      ]);
      const second = Code.collectInstagramDm_(spreadsheet, T1);
      expect(second).toEqual({ stored: 0, error: null });
      expect(sheets.ig_dm.rows).toHaveLength(2);
    });

    it('encodes the nested from fields value in the messages URL', () => {
      // Same UrlFetchApp "Invalid argument" regression as the
      // /me/accounts call: literal braces in the URL throw
      // before any request is sent.
      routeFetches({
        conversations: ['conv1'],
        messagesByConv: {
          conv1: [
            dm('m1', 'user-a', { username: 'alice' }, 'はじめまして', '2026-11-17T00:10:00+0000'),
          ],
        },
      });
      const result = Code.collectInstagramDm_(spreadsheet, T1);
      expect(result).toEqual({ stored: 1, error: null });
      const messagesUrl = fetchCalls.find((call) =>
        call.url.includes('/conv1/messages')
      ).url;
      expect(messagesUrl).toContain('from%7Bid%2Cusername%2Cname%7D');
      expect(messagesUrl).not.toContain('{');
      expect(messagesUrl).not.toContain('}');
    });

    it('imports only the last 48 hours on the first-ever run', () => {
      routeFetches({
        conversations: ['conv1'],
        messagesByConv: {
          conv1: [
            dm('m-old', 'user-a', { username: 'alice' }, '先週の連絡', '2026-11-10T00:00:00+0000'),
            dm('m-new', 'user-a', { username: 'alice' }, '昨日の連絡', '2026-11-16T12:00:00+0000'),
          ],
        },
      });
      const result = Code.collectInstagramDm_(spreadsheet, T1);
      expect(result).toEqual({ stored: 1, error: null });
      expect(sheets.ig_dm.rows[1][0]).toBe('m-new');
    });

    it('stores an older message once the tab has rows (no first-run window)', () => {
      seedTab('ig_dm', Code.SNS_HISTORY_IG_DM_COLUMNS, [
        ['m0', 'conv1', 'alice', '既存', '2026-11-16T00:00:00+0000', 'https://www.instagram.com/direct/inbox/', T1],
      ]);
      routeFetches({
        conversations: ['conv1'],
        messagesByConv: {
          conv1: [
            dm('m-old', 'user-a', { username: 'alice' }, '未保存の古い連絡', '2026-11-10T00:00:00+0000'),
          ],
        },
      });
      const result = Code.collectInstagramDm_(spreadsheet, T1);
      expect(result).toEqual({ stored: 1, error: null });
    });

    it('degrades to an error summary when the page cannot be resolved', () => {
      fetchHandler = (url) => {
        if (url.includes('/me/accounts')) {
          return res(200, accountsPage([]));
        }
        throw new Error('conversations must not be fetched');
      };
      const result = Code.collectInstagramDm_(spreadsheet, T1);
      expect(result.stored).toBe(0);
      expect(result.error).toContain('no linked page');
    });

    it('keeps collecting other conversations when one fetch fails', () => {
      fetchHandler = (url) => {
        if (url.includes('/me/accounts')) {
          return res(200, accountsPage([linkedPage]));
        }
        if (url.includes('/' + PAGE_ID + '/conversations')) {
          return res(200, { data: [{ id: 'conv-bad' }, { id: 'conv-ok' }] });
        }
        if (url.includes('/conv-bad/messages')) {
          return res(400, { error: { message: 'boom', code: 100 } });
        }
        if (url.includes('/conv-ok/messages')) {
          return res(200, {
            data: [dm('m1', 'user-a', { username: 'alice' }, '届いた分', '2026-11-17T00:10:00+0000')],
          });
        }
        throw new Error('unexpected fetch: ' + url);
      };
      const result = Code.collectInstagramDm_(spreadsheet, T1);
      expect(result.stored).toBe(1);
      expect(result.error).toContain('conv-bad');
    });
  });

  describe('serveCommentsRss_ source=instagram_dm', () => {
    it('serves the stored DMs as XML to the matching token', () => {
      store.COMMENTS_RSS_TOKEN = 'rss-token';
      store.SNS_HISTORY_SHEET_ID = 'history-sheet-id';
      seedTab('ig_dm', Code.SNS_HISTORY_IG_DM_COLUMNS, [
        ['m1', 'conv1', 'alice', 'はじめまして', '2026-11-17T00:10:00+0000', 'https://www.instagram.com/direct/inbox/', T1],
      ]);
      const out = Code.doGet({
        parameter: { action: 'comments_rss', source: 'instagram_dm', token: 'rss-token' },
        headers: {},
      });
      expect(out.mimeType).toBe('text/xml');
      expect(out.text).toContain('<title>Instagram DM（@freddiefujiwara）</title>');
      expect(out.text).toContain('@alice: はじめまして');
      expect(out.text).toContain('<guid isPermaLink="false">m1</guid>');
    });
  });
});
