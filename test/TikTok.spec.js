import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Code from '../src/Code.js';

// TikTok joins the collection through its official Display API:
// the app credentials and the OAuth refresh token live in the
// Script Properties, the hourly collection refreshes the
// short-lived access token when needed and reads the account
// totals plus the newest videos. These tests pin the caller
// side: the token flow, the request shapes, the response
// mapping into the snapshot / history / read shapes, and the
// failure behaviour (nulls plus a summary, never a throw).
describe('TikTok via the Display API', () => {
  let store;
  let fetchHandler;
  let nowSpy;

  const NOW = Date.parse('2026-11-09T00:00:00.000Z');

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
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
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
    delete global.YouTube;
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  const configureCredentials = () => {
    store.TIKTOK_CLIENT_KEY = 'client-key';
    store.TIKTOK_CLIENT_SECRET = 'client-secret';
    store.TIKTOK_REFRESH_TOKEN = 'refresh-token';
  };

  const configureValidToken = () => {
    configureCredentials();
    store.TIKTOK_ACCESS_TOKEN = 'access-token';
    store.TIKTOK_ACCESS_TOKEN_EXPIRES_AT = String(NOW + 60 * 60 * 1000);
  };

  // The user-info response as the statistics-only request
  // returns it: no basic fields, hence no username — the code
  // falls back to the recorded TIKTOK_USERNAME for the video
  // URLs (see the fetchTikTokAccountDetail_ tests).
  const USER_INFO = {
    data: {
      user: {
        follower_count: 1234,
        following_count: 56,
        likes_count: 7890,
        video_count: 42,
      },
    },
    error: { code: 'ok', message: '', log_id: 'log-1' },
  };

  const VIDEO_LIST = {
    data: {
      videos: [
        {
          id: 7123456789,
          create_time: 1762473600,
          title: '川口の歌',
          duration: 95,
          view_count: 5000,
          like_count: 300,
          comment_count: 40,
          share_count: 12,
          cover_image_url: 'https://example.com/covers/7123456789.jpg',
        },
        {
          id: 7123456790,
          create_time: 1762387200,
          title: '数字が欠けた動画',
          duration: null,
          view_count: null,
          like_count: 3,
          comment_count: 0,
          share_count: 0,
        },
      ],
      cursor: 1762387200,
      has_more: false,
    },
    error: { code: 'ok', message: '', log_id: 'log-2' },
  };

  const routeTikTokApi = (overrides = {}) => {
    fetchHandler = (url) => {
      if (url.startsWith('https://open.tiktokapis.com/v2/oauth/token/')) {
        return overrides.token
          ? overrides.token(url)
          : res(200, {
              access_token: 'new-access-token',
              expires_in: 86400,
              refresh_token: 'new-refresh-token',
              open_id: 'open-id-1',
              scope: 'user.info.basic,user.info.stats,video.list,video.upload',
              token_type: 'Bearer',
            });
      }
      if (url.startsWith('https://open.tiktokapis.com/v2/user/info/')) {
        return overrides.userInfo
          ? overrides.userInfo(url)
          : res(200, USER_INFO);
      }
      if (url.startsWith('https://open.tiktokapis.com/v2/video/list/')) {
        return overrides.videoList
          ? overrides.videoList(url)
          : res(200, VIDEO_LIST);
      }
      throw new Error('unexpected fetch: ' + url);
    };
  };

  describe('fetchTikTokAccountDetail_', () => {
    it('reads as all nulls with an error while the credentials are unset, without fetching', () => {
      const detail = Code.fetchTikTokAccountDetail_();
      expect(detail).toEqual({
        followers: null,
        following: null,
        total_likes: null,
        video_count: null,
        username: null,
        recent_videos: null,
        tiktok_error: expect.stringContaining('not configured'),
      });
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('maps the user info and the video list with a still-valid access token', () => {
      configureValidToken();
      // The statistics-only response carries no username: the
      // recorded one supplies it (and the video URLs).
      store.TIKTOK_USERNAME = 'freddiefujiwara';
      routeTikTokApi();

      const detail = Code.fetchTikTokAccountDetail_();

      expect(detail.followers).toBe(1234);
      expect(detail.following).toBe(56);
      expect(detail.total_likes).toBe(7890);
      expect(detail.video_count).toBe(42);
      expect(detail.username).toBe('freddiefujiwara');
      expect(detail.tiktok_error).toBeNull();
      expect(detail.recent_videos).toEqual([
        {
          id: '7123456789',
          title: '川口の歌',
          published_at: new Date(1762473600 * 1000).toISOString(),
          views: 5000,
          likes: 300,
          comments: 40,
          shares: 12,
          duration_sec: 95,
          cover_url: 'https://example.com/covers/7123456789.jpg',
          url: 'https://www.tiktok.com/@freddiefujiwara/video/7123456789',
        },
        {
          id: '7123456790',
          title: '数字が欠けた動画',
          published_at: new Date(1762387200 * 1000).toISOString(),
          views: null,
          likes: 3,
          comments: 0,
          shares: 0,
          duration_sec: null,
          cover_url: null,
          url: 'https://www.tiktok.com/@freddiefujiwara/video/7123456790',
        },
      ]);
      // The recorded username is untouched: the response
      // carried none to record.
      expect(store.TIKTOK_USERNAME).toBe('freddiefujiwara');
      // No token call: the stored access token is still valid.
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(2);
      const [userUrl, userOptions] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(userUrl).toBe(
        'https://open.tiktokapis.com/v2/user/info/?fields=' +
          encodeURIComponent(
            'follower_count,following_count,likes_count,video_count'
          )
      );
      expect(userOptions.headers).toEqual({
        Authorization: 'Bearer access-token',
      });
      const [listUrl, listOptions] = global.UrlFetchApp.fetch.mock.calls[1];
      expect(listUrl).toBe(
        'https://open.tiktokapis.com/v2/video/list/?fields=' +
          encodeURIComponent(
            'id,create_time,title,duration,view_count,like_count,comment_count,share_count,cover_image_url'
          )
      );
      expect(listOptions.method).toBe('post');
      expect(listOptions.contentType).toBe('application/json');
      expect(JSON.parse(listOptions.payload)).toEqual({ max_count: 20 });
    });

    it('uses and records a username the response does carry', () => {
      configureValidToken();
      store.TIKTOK_USERNAME = 'recorded-name';
      routeTikTokApi({
        userInfo: () =>
          res(200, {
            data: {
              user: {
                username: 'responder-name',
                follower_count: 1234,
                following_count: 56,
                likes_count: 7890,
                video_count: 42,
              },
            },
            error: { code: 'ok', message: '', log_id: 'log-6' },
          }),
      });

      const detail = Code.fetchTikTokAccountDetail_();

      expect(detail.username).toBe('responder-name');
      expect(store.TIKTOK_USERNAME).toBe('responder-name');
      expect(detail.recent_videos[0].url).toBe(
        'https://www.tiktok.com/@responder-name/video/7123456789'
      );
    });

    it('leaves the username and the video URLs null while none was ever recorded', () => {
      configureValidToken();
      routeTikTokApi();

      const detail = Code.fetchTikTokAccountDetail_();

      expect(detail.followers).toBe(1234);
      expect(detail.username).toBeNull();
      expect(detail.recent_videos).toHaveLength(2);
      expect(detail.recent_videos[0].url).toBeNull();
      expect(detail.tiktok_error).toBeNull();
    });

    it('refreshes an expired access token first and stores the rotated pair', () => {
      configureCredentials();
      store.TIKTOK_ACCESS_TOKEN = 'stale-token';
      store.TIKTOK_ACCESS_TOKEN_EXPIRES_AT = String(NOW - 1000);
      routeTikTokApi();

      const detail = Code.fetchTikTokAccountDetail_();

      expect(detail.followers).toBe(1234);
      expect(store.TIKTOK_ACCESS_TOKEN).toBe('new-access-token');
      expect(store.TIKTOK_REFRESH_TOKEN).toBe('new-refresh-token');
      expect(store.TIKTOK_ACCESS_TOKEN_EXPIRES_AT).toBe(
        String(NOW + 86400 * 1000)
      );
      const [tokenUrl, tokenOptions] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(tokenUrl).toBe('https://open.tiktokapis.com/v2/oauth/token/');
      expect(tokenOptions.method).toBe('post');
      expect(tokenOptions.payload).toEqual({
        client_key: 'client-key',
        client_secret: 'client-secret',
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token',
      });
      // The API calls ride the refreshed token.
      const [, userOptions] = global.UrlFetchApp.fetch.mock.calls[1];
      expect(userOptions.headers).toEqual({
        Authorization: 'Bearer new-access-token',
      });
    });

    it('refreshes when no access token is stored at all', () => {
      configureCredentials();
      routeTikTokApi();
      const detail = Code.fetchTikTokAccountDetail_();
      expect(detail.followers).toBe(1234);
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(3);
    });

    it('reports the refresh failure and stops when the token endpoint refuses', () => {
      configureCredentials();
      routeTikTokApi({
        token: () =>
          res(401, {
            error: {
              code: 'invalid_refresh_token',
              message: 'The refresh token is invalid.',
              log_id: 'log-3',
            },
          }),
      });

      const detail = Code.fetchTikTokAccountDetail_();

      expect(detail.followers).toBeNull();
      expect(detail.recent_videos).toBeNull();
      expect(detail.tiktok_error).toContain('token refresh');
      expect(detail.tiktok_error).toContain('invalid_refresh_token');
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
    });

    it('fails the two halves independently: user info down, videos up', () => {
      configureValidToken();
      routeTikTokApi({
        userInfo: () =>
          res(403, {
            error: {
              code: 'scope_not_authorized',
              message: 'Scope not authorized.',
              log_id: 'log-4',
            },
          }),
      });

      const detail = Code.fetchTikTokAccountDetail_();

      expect(detail.followers).toBeNull();
      expect(detail.username).toBeNull();
      expect(detail.recent_videos).toHaveLength(2);
      // Without a username the watch URLs cannot be built.
      expect(detail.recent_videos[0].url).toBeNull();
      expect(detail.recent_videos[0].views).toBe(5000);
      expect(detail.tiktok_error).toContain('user info');
      expect(detail.tiktok_error).toContain('scope_not_authorized');
    });

    it('fails the two halves independently: videos down, user info up', () => {
      configureValidToken();
      routeTikTokApi({
        videoList: () => {
          throw new Error('network down');
        },
      });

      const detail = Code.fetchTikTokAccountDetail_();

      expect(detail.followers).toBe(1234);
      expect(detail.recent_videos).toBeNull();
      expect(detail.tiktok_error).toContain('recent videos');
    });
  });

  describe('bootstrapTikTokToken and the authorize URL', () => {
    it('builds the authorize URL from the client key', () => {
      store.TIKTOK_CLIENT_KEY = 'client-key';
      const url = Code.tikTokAuthorizeUrl_();
      expect(url).toBe(
        'https://www.tiktok.com/v2/auth/authorize/?client_key=client-key' +
          '&scope=user.info.basic,user.info.stats,video.list,video.upload' +
          '&response_type=code' +
          '&redirect_uri=' +
          encodeURIComponent(
            'https://script.google.com/macros/s/AKfycbypis7IqAtM2u0_h7ysiZ5UgztUEwNYJ1zPMnr8IbTBXiyfiapfRMtD_9CxVpc5G8YVzQ/exec'
          ) +
          '&state=social-gas'
      );
      expect(Code.logTikTokAuthorizeUrl()).toBe(url);
    });

    it('has no authorize URL while the client key is unset', () => {
      expect(Code.tikTokAuthorizeUrl_()).toBe('');
      expect(Code.logTikTokAuthorizeUrl()).toBe('');
    });

    it('does nothing while TIKTOK_AUTH_CODE is unset', () => {
      configureCredentials();
      expect(Code.bootstrapTikTokToken()).toBe(false);
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('exchanges the stored code and stores the first token pair', () => {
      configureCredentials();
      delete store.TIKTOK_REFRESH_TOKEN;
      store.TIKTOK_AUTH_CODE = 'auth-code-1';
      routeTikTokApi();

      expect(Code.bootstrapTikTokToken()).toBe(true);

      const [tokenUrl, tokenOptions] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(tokenUrl).toBe('https://open.tiktokapis.com/v2/oauth/token/');
      expect(tokenOptions.payload).toEqual({
        client_key: 'client-key',
        client_secret: 'client-secret',
        grant_type: 'authorization_code',
        code: 'auth-code-1',
        redirect_uri:
          'https://script.google.com/macros/s/AKfycbypis7IqAtM2u0_h7ysiZ5UgztUEwNYJ1zPMnr8IbTBXiyfiapfRMtD_9CxVpc5G8YVzQ/exec',
      });
      expect(store.TIKTOK_ACCESS_TOKEN).toBe('new-access-token');
      expect(store.TIKTOK_REFRESH_TOKEN).toBe('new-refresh-token');
      expect(store.TIKTOK_ACCESS_TOKEN_EXPIRES_AT).toBe(
        String(NOW + 86400 * 1000)
      );
      expect(store.TIKTOK_AUTH_CODE).toBeUndefined();
    });

    it('keeps the code and reports failure when the exchange is refused', () => {
      configureCredentials();
      store.TIKTOK_AUTH_CODE = 'auth-code-1';
      routeTikTokApi({
        token: () =>
          res(400, {
            error: {
              code: 'invalid_code',
              message: 'The code is invalid.',
              log_id: 'log-5',
            },
          }),
      });

      expect(Code.bootstrapTikTokToken()).toBe(false);
      expect(store.TIKTOK_AUTH_CODE).toBe('auth-code-1');
      expect(store.TIKTOK_ACCESS_TOKEN).toBeUndefined();
    });
  });

  describe('handleTikTokOAuthCallback_', () => {
    it('stores the code as TIKTOK_AUTH_CODE', () => {
      expect(Code.handleTikTokOAuthCallback_('dummy-code')).toBe(true);
      expect(store.TIKTOK_AUTH_CODE).toBe('dummy-code');
    });

    it('stores nothing and returns false without a code', () => {
      expect(Code.handleTikTokOAuthCallback_('')).toBe(false);
      expect(Code.handleTikTokOAuthCallback_(null)).toBe(false);
      expect(Code.handleTikTokOAuthCallback_(undefined)).toBe(false);
      expect(store.TIKTOK_AUTH_CODE).toBeUndefined();
    });

    it('feeds bootstrapTikTokToken: a stored callback code exchanges normally', () => {
      configureCredentials();
      delete store.TIKTOK_REFRESH_TOKEN;
      expect(Code.handleTikTokOAuthCallback_('dummy-code')).toBe(true);
      routeTikTokApi();

      expect(Code.bootstrapTikTokToken()).toBe(true);

      const [, tokenOptions] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(tokenOptions.payload.code).toBe('dummy-code');
      expect(store.TIKTOK_AUTH_CODE).toBeUndefined();
      expect(store.TIKTOK_REFRESH_TOKEN).toBe('new-refresh-token');
    });
  });

  describe('collection and the public projection', () => {
    it('lands in the snapshot via collectSnsCounts', () => {
      configureValidToken();
      routeTikTokApi();

      const snapshot = Code.collectSnsCounts();

      expect(snapshot.tiktok).toEqual({
        followers: 1234,
        following: 56,
        total_likes: 7890,
        video_count: 42,
        recent_videos: [
          expect.objectContaining({ id: '7123456789', views: 5000 }),
          expect.objectContaining({ id: '7123456790', views: null }),
        ],
        tiktok_error: null,
      });
      expect(JSON.parse(store.SNS_COUNTS_SNAPSHOT).tiktok).toEqual(
        snapshot.tiktok
      );
    });

    it('projects only the follower count into sns_counts', () => {
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify({
        collected_at: '2026-11-09T00:00:00.000Z',
        tiktok: { followers: 1234, total_likes: 7890, video_count: 42 },
      });
      const response = Code.buildSnsCountsResponse_();
      expect(response.tiktok).toEqual({ followers: 1234 });
    });

    it('reads the empty detail shape with a tiktok section', () => {
      expect(Code.buildEmptySnsDetail_().tiktok).toEqual({
        followers: null,
        following: null,
        total_likes: null,
        video_count: null,
        recent_videos: null,
        tiktok_error: null,
      });
    });
  });

  describe('history rows', () => {
    const snapshotWithTikTok = () => ({
      collected_at: '2026-11-09T00:00:00.000Z',
      instagram: { freddiefujiwara: 2000 },
      threads: { followers: 252 },
      youtube: { subscribers: 10 },
      tiktok: {
        followers: 1234,
        following: 56,
        total_likes: 7890,
        video_count: 42,
        recent_videos: [
          {
            id: '7123456789',
            title: '川口の歌',
            published_at: '2025-11-07T00:00:00.000Z',
            views: 5000,
            likes: 300,
            comments: 40,
            shares: 12,
            duration_sec: 95,
            cover_url: 'https://example.com/covers/7123456789.jpg',
            url: 'https://www.tiktok.com/@freddiefujiwara/video/7123456789',
          },
        ],
        tiktok_error: null,
      },
    });

    it('appends the TikTok totals at the end of the account row, outside total_followers', () => {
      const row = Code.buildSnsHistoryAccountRow_(snapshotWithTikTok());
      expect(row).toHaveLength(Code.SNS_HISTORY_ACCOUNT_COLUMNS.length);
      const totalIndex =
        Code.SNS_HISTORY_ACCOUNT_COLUMNS.indexOf('total_followers');
      // 2000 + 252 + 10: the TikTok followers are NOT summed in.
      expect(row[totalIndex]).toBe(2262);
      const columns = Code.SNS_HISTORY_ACCOUNT_COLUMNS;
      expect(row[columns.indexOf('tiktok_followers')]).toBe(1234);
      expect(row[columns.indexOf('tiktok_total_likes')]).toBe(7890);
      expect(row[columns.indexOf('tiktok_video_count')]).toBe(42);
      expect(row[columns.indexOf('tiktok_following')]).toBe(56);
      expect(columns.slice(-4)).toEqual([
        'tiktok_followers',
        'tiktok_total_likes',
        'tiktok_video_count',
        'tiktok_following',
      ]);
    });

    it('builds one tiktok_media row per video, without the derived URL', () => {
      expect(
        Code.buildSnsHistoryTikTokMediaRows_(snapshotWithTikTok())
      ).toEqual([
        [
          '2026-11-09T00:00:00.000Z',
          '7123456789',
          '2025-11-07T00:00:00.000Z',
          '川口の歌',
          5000,
          300,
          40,
          12,
          95,
          'https://example.com/covers/7123456789.jpg',
        ],
      ]);
      expect(Code.SNS_HISTORY_TIKTOK_MEDIA_COLUMNS.slice(-2)).toEqual([
        'duration_sec',
        'cover_url',
      ]);
      expect(
        Code.buildSnsHistoryTikTokMediaRows_({
          tiktok: { recent_videos: null },
        })
      ).toEqual([]);
      expect(Code.buildSnsHistoryTikTokMediaRows_({})).toEqual([]);
    });

    it('upserts tiktok_media by video id on appendSnsHistory_', () => {
      serveTabs({});
      Code.appendSnsHistory_(snapshotWithTikTok());
      expect(sheets.tiktok_media.rows[0]).toEqual(
        Code.SNS_HISTORY_TIKTOK_MEDIA_COLUMNS
      );
      expect(sheets.tiktok_media.rows).toHaveLength(2);

      const second = snapshotWithTikTok();
      second.collected_at = '2026-11-09T01:00:00.000Z';
      second.tiktok.recent_videos[0].views = 6000;
      Code.appendSnsHistory_(second);
      // One row per video, carrying the fresh values.
      expect(sheets.tiktok_media.rows).toHaveLength(2);
      expect(sheets.tiktok_media.rows[1][0]).toBe('2026-11-09T01:00:00.000Z');
      expect(sheets.tiktok_media.rows[1][4]).toBe(6000);
      // The cover URL rides the appended last cell.
      const coverIndex =
        Code.SNS_HISTORY_TIKTOK_MEDIA_COLUMNS.indexOf('cover_url');
      expect(sheets.tiktok_media.rows[1]).toHaveLength(
        Code.SNS_HISTORY_TIKTOK_MEDIA_COLUMNS.length
      );
      expect(sheets.tiktok_media.rows[1][coverIndex]).toBe(
        'https://example.com/covers/7123456789.jpg'
      );
    });
  });

  describe('sns_detail scopes', () => {
    it('accepts tiktok as a platform scope', () => {
      expect(Code.normalizeSnsDetailScope_('tiktok')).toBe('tiktok');
      expect(Code.SNS_DETAIL_VARIANT_SCOPES).toContain('tiktok');
    });

    it('trims the tiktok top videos in the overview scope', () => {
      const detail = Code.buildEmptySnsDetail_();
      detail.tiktok.followers = 1234;
      detail.tiktok.recent_videos = [
        { title: 'a', url: 'https://example.com/a', views: 10, likes: 1 },
        { title: 'b', url: 'https://example.com/b', views: 99, likes: 2 },
        { title: 'c', url: 'https://example.com/c', views: 50, likes: 3 },
        { title: 'd', url: 'https://example.com/d', views: 1, likes: 4 },
      ];
      const shaped = Code.shapeSnsDetail_(detail, 'overview');
      expect(shaped.tiktok.followers).toBe(1234);
      expect(shaped.tiktok.recent_videos).toEqual([
        { title: 'b', url: 'https://example.com/b', views: 99 },
        { title: 'c', url: 'https://example.com/c', views: 50 },
        { title: 'a', url: 'https://example.com/a', views: 10 },
      ]);
    });

    it('serves only the tiktok section for the tiktok scope', () => {
      const snapshot = {
        collected_at: '2026-11-09T00:00:00.000Z',
        tiktok: {
          followers: 1234,
          following: 56,
          total_likes: 7890,
          video_count: 42,
          recent_videos: [],
          tiktok_error: null,
        },
      };
      store.SNS_COUNTS_SNAPSHOT = JSON.stringify(snapshot);
      const response = Code.buildSnsDetailResponse_('tiktok');
      expect(response.detail_scope).toBe('tiktok');
      expect(response.tiktok).toEqual(snapshot.tiktok);
      expect('youtube' in response).toBe(false);
      expect('instagram' in response).toBe(false);
    });
  });

  describe('sheet-built detail', () => {
    const accountRow = (values) =>
      Code.SNS_HISTORY_ACCOUNT_COLUMNS.map((column) =>
        column in values ? values[column] : ''
      );

    it('assembles the tiktok section from the account row and tiktok_media', () => {
      store.TIKTOK_USERNAME = 'freddiefujiwara';
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-09T06:00:00.000Z',
            tiktok_followers: 1234,
            tiktok_following: 56,
            tiktok_total_likes: 7890,
            tiktok_video_count: 42,
          }),
        ],
        tiktok_media: [
          Code.SNS_HISTORY_TIKTOK_MEDIA_COLUMNS,
          [
            '2026-11-09T06:00:00.000Z',
            '7123456789',
            '2025-11-07T00:00:00.000Z',
            '川口の歌',
            5000,
            300,
            40,
            12,
            95,
            'https://example.com/covers/7123456789.jpg',
          ],
          [
            '2026-11-09T06:00:00.000Z',
            '7123456790',
            '2025-11-08T00:00:00.000Z',
            '新しい動画',
            100,
            3,
            0,
            0,
            '',
            '',
          ],
        ],
      });

      const detail = Code.buildSnsDetailFromSheet_();

      expect(detail.tiktok.followers).toBe(1234);
      expect(detail.tiktok.following).toBe(56);
      expect(detail.tiktok.total_likes).toBe(7890);
      expect(detail.tiktok.video_count).toBe(42);
      // Newest first, URLs rebuilt from the recorded username.
      expect(detail.tiktok.recent_videos).toEqual([
        {
          id: '7123456790',
          title: '新しい動画',
          published_at: '2025-11-08T00:00:00.000Z',
          views: 100,
          likes: 3,
          comments: 0,
          shares: 0,
          duration_sec: null,
          cover_url: null,
          url: 'https://www.tiktok.com/@freddiefujiwara/video/7123456790',
        },
        {
          id: '7123456789',
          title: '川口の歌',
          published_at: '2025-11-07T00:00:00.000Z',
          views: 5000,
          likes: 300,
          comments: 40,
          shares: 12,
          duration_sec: 95,
          cover_url: 'https://example.com/covers/7123456789.jpg',
          url: 'https://www.tiktok.com/@freddiefujiwara/video/7123456789',
        },
      ]);
    });

    it('keeps recent_videos null while the tiktok_media tab does not exist', () => {
      serveTabs({
        account: [
          Code.SNS_HISTORY_ACCOUNT_COLUMNS,
          accountRow({
            collected_at: '2026-11-09T06:00:00.000Z',
            tiktok_followers: 1234,
          }),
        ],
      });

      const detail = Code.buildSnsDetailFromSheet_();

      expect(detail.tiktok.followers).toBe(1234);
      expect(detail.tiktok.recent_videos).toBeNull();
    });

    it('round-trips the following count and the cover URLs: fetch, store, read back', () => {
      configureValidToken();
      store.TIKTOK_USERNAME = 'freddiefujiwara';
      routeTikTokApi();
      const fetched = Code.fetchTikTokAccountDetail_();

      serveTabs({});
      Code.appendSnsHistory_({
        collected_at: '2026-11-09T06:00:00.000Z',
        tiktok: fetched,
      });

      const detail = Code.buildSnsDetailFromSheet_();

      expect(detail.tiktok.followers).toBe(1234);
      expect(detail.tiktok.following).toBe(56);
      expect(detail.tiktok.total_likes).toBe(7890);
      expect(detail.tiktok.video_count).toBe(42);
      const byId = Object.fromEntries(
        detail.tiktok.recent_videos.map((video) => [video.id, video])
      );
      expect(byId['7123456789'].cover_url).toBe(
        'https://example.com/covers/7123456789.jpg'
      );
      // The video whose API response carried no cover stays null.
      expect(byId['7123456790'].cover_url).toBeNull();
    });
  });

  describe('draft upload (Content Posting API)', () => {
    const INIT_OK = {
      data: {
        publish_id: 'publish-1',
        upload_url: 'https://example.com/upload/publish-1',
      },
      error: { code: 'ok', message: '', log_id: 'log-up-1' },
    };
    const STATUS_INBOX = {
      data: { status: 'SEND_TO_USER_INBOX' },
      error: { code: 'ok', message: '', log_id: 'log-up-2' },
    };

    let sleepSpy;

    beforeEach(() => {
      sleepSpy = vi.fn();
      global.Utilities = {
        sleep: sleepSpy,
        newBlob: vi.fn((bytes, contentType) => ({
          bytes,
          contentType,
          getBytes: () => bytes,
        })),
      };
    });

    afterEach(() => {
      delete global.Utilities;
      delete global.DriveApp;
    });

    const routeUploadApi = (overrides = {}) => {
      fetchHandler = (url, options) => {
        if (
          url.startsWith(
            'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/'
          )
        ) {
          return overrides.init
            ? overrides.init(url, options)
            : res(200, INIT_OK);
        }
        if (url.startsWith('https://example.com/upload/')) {
          return overrides.put ? overrides.put(url, options) : res(201, '');
        }
        if (
          url.startsWith(
            'https://open.tiktokapis.com/v2/post/publish/status/fetch/'
          )
        ) {
          return overrides.status
            ? overrides.status(url, options)
            : res(200, STATUS_INBOX);
        }
        throw new Error('unexpected fetch: ' + url);
      };
    };

    const dummyBytes = (size) =>
      Array.from({ length: size }, (_, i) => i % 251);

    it('asks for the video.upload scope in the authorize URL', () => {
      store.TIKTOK_CLIENT_KEY = 'client-key';
      expect(Code.tikTokAuthorizeUrl_()).toContain('video.upload');
    });

    it('uploads a small video as a single chunk and returns the publish id', () => {
      configureValidToken();
      routeUploadApi();

      const result = Code.uploadTikTokDraftBytes_(dummyBytes(2048));

      expect(result).toEqual({
        publish_id: 'publish-1',
        status: 'SEND_TO_USER_INBOX',
      });
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(3);
      const [initUrl, initOptions] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(initUrl).toBe(
        'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/'
      );
      expect(initOptions.method).toBe('post');
      expect(initOptions.contentType).toBe('application/json');
      expect(initOptions.headers).toEqual({
        Authorization: 'Bearer access-token',
      });
      expect(JSON.parse(initOptions.payload)).toEqual({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: 2048,
          chunk_size: 2048,
          total_chunk_count: 1,
        },
      });
      const [putUrl, putOptions] = global.UrlFetchApp.fetch.mock.calls[1];
      expect(putUrl).toBe('https://example.com/upload/publish-1');
      expect(putOptions.method).toBe('put');
      // No manual Content-Length (UrlFetchApp forbids it); the
      // chunk travels as a Blob carrying the video/mp4 type.
      expect(putOptions.headers).toEqual({
        'Content-Range': 'bytes 0-2047/2048',
      });
      expect(putOptions.payload.contentType).toBe('video/mp4');
      expect(putOptions.payload.getBytes()).toHaveLength(2048);
      const [statusUrl, statusOptions] =
        global.UrlFetchApp.fetch.mock.calls[2];
      expect(statusUrl).toBe(
        'https://open.tiktokapis.com/v2/post/publish/status/fetch/'
      );
      expect(JSON.parse(statusOptions.payload)).toEqual({
        publish_id: 'publish-1',
      });
      // The first status check already found the video in the
      // inbox: no polling sleep was needed.
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('splits a 64MB video into 10MB chunks with per-chunk ranges', () => {
      configureValidToken();
      let putCount = 0;
      let statusCount = 0;
      routeUploadApi({
        put: () => {
          putCount += 1;
          // 206 for the interim chunks, 201 for the final one.
          return res(putCount < 6 ? 206 : 201, '');
        },
        status: () => {
          statusCount += 1;
          return statusCount < 2
            ? res(200, {
                data: { status: 'PROCESSING_UPLOAD' },
                error: { code: 'ok', message: '', log_id: 'log-up-3' },
              })
            : res(200, STATUS_INBOX);
        },
      });

      const size = 64 * 1024 * 1024;
      const result = Code.uploadTikTokDraftBytes_(new Uint8Array(size));

      expect(result).toEqual({
        publish_id: 'publish-1',
        status: 'SEND_TO_USER_INBOX',
      });
      const [, initOptions] = global.UrlFetchApp.fetch.mock.calls[0];
      expect(JSON.parse(initOptions.payload)).toEqual({
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: 67108864,
          chunk_size: 10485760,
          total_chunk_count: 6,
        },
      });
      const putCalls = global.UrlFetchApp.fetch.mock.calls.filter(([url]) =>
        url.startsWith('https://example.com/upload/')
      );
      expect(putCalls).toHaveLength(6);
      expect(
        putCalls.map(([, options]) => options.headers['Content-Range'])
      ).toEqual([
        'bytes 0-10485759/67108864',
        'bytes 10485760-20971519/67108864',
        'bytes 20971520-31457279/67108864',
        'bytes 31457280-41943039/67108864',
        'bytes 41943040-52428799/67108864',
        'bytes 52428800-67108863/67108864',
      ]);
      expect(
        putCalls.map(([, options]) => options.payload.getBytes().length)
      ).toEqual([
        10485760, 10485760, 10485760, 10485760, 10485760, 14680064,
      ]);
      // One PROCESSING_UPLOAD read before the inbox took the
      // video: exactly one 5-second poll sleep.
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(5000);
    });

    it('retries a chunk PUT that dies with a fetch exception', () => {
      configureValidToken();
      let putAttempts = 0;
      routeUploadApi({
        put: () => {
          putAttempts++;
          if (putAttempts < 3) {
            throw new Error('dummy network failure');
          }
          return res(201, '');
        },
      });

      const result = Code.uploadTikTokDraftBytes_(dummyBytes(2048));

      expect(result).toEqual({
        publish_id: 'publish-1',
        status: 'SEND_TO_USER_INBOX',
      });
      expect(putAttempts).toBe(3);
    });

    it('throws a status-stage error carrying the fail_reason on FAILED', () => {
      configureValidToken();
      routeUploadApi({
        status: () =>
          res(200, {
            data: { status: 'FAILED', fail_reason: 'dummy_fail_reason' },
            error: { code: 'ok', message: '', log_id: 'log-up-4' },
          }),
      });

      expect(() => Code.uploadTikTokDraftBytes_(dummyBytes(100))).toThrow(
        /failed at status: publish FAILED \(dummy_fail_reason\)/
      );
    });

    it('throws an init-stage error and uploads nothing when init is refused', () => {
      configureValidToken();
      routeUploadApi({
        init: () =>
          res(403, {
            error: {
              code: 'scope_not_authorized',
              message: 'Scope not authorized.',
              log_id: 'log-up-5',
            },
          }),
      });

      expect(() => Code.uploadTikTokDraftBytes_(dummyBytes(100))).toThrow(
        /failed at init: HTTP 403 code=scope_not_authorized/
      );
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
    });

    it('throws an upload-stage error when a chunk PUT fails', () => {
      configureValidToken();
      routeUploadApi({
        put: () =>
          res(500, {
            error: {
              code: 'dummy_error',
              message: 'Dummy failure.',
              log_id: 'log-up-6',
            },
          }),
      });

      expect(() => Code.uploadTikTokDraftBytes_(dummyBytes(100))).toThrow(
        /failed at upload \(chunk 1 of 1\): HTTP 500 code=dummy_error/
      );
    });

    it('throws a status-stage error when the inbox never takes the video', () => {
      configureValidToken();
      routeUploadApi({
        status: () =>
          res(200, {
            data: { status: 'PROCESSING_UPLOAD' },
            error: { code: 'ok', message: '', log_id: 'log-up-7' },
          }),
      });

      expect(() => Code.uploadTikTokDraftBytes_(dummyBytes(100))).toThrow(
        /failed at status: no SEND_TO_USER_INBOX after 12 checks/
      );
      const statusCalls = global.UrlFetchApp.fetch.mock.calls.filter(
        ([url]) => url.includes('/post/publish/status/fetch/')
      );
      expect(statusCalls).toHaveLength(12);
      expect(sleepSpy).toHaveBeenCalledTimes(11);
    });

    it('downloads the video bytes from Drive in uploadTikTokDraftFromDrive', () => {
      configureValidToken();
      routeUploadApi();
      const bytes = dummyBytes(512);
      global.ScriptApp = { getOAuthToken: vi.fn(() => 'oauth-token') };
      const route = fetchHandler;
      fetchHandler = (url, options) => {
        if (
          url.startsWith('https://www.googleapis.com/drive/v3/files/')
        ) {
          return {
            getResponseCode: () => 200,
            getContent: () => bytes,
            getContentText: () => '',
          };
        }
        return route(url, options);
      };

      const result = Code.uploadTikTokDraftFromDrive('dummy-file-id');

      expect(result).toEqual({
        publish_id: 'publish-1',
        status: 'SEND_TO_USER_INBOX',
      });
      const [driveUrl, driveOptions] =
        global.UrlFetchApp.fetch.mock.calls[0];
      expect(driveUrl).toBe(
        'https://www.googleapis.com/drive/v3/files/dummy-file-id?alt=media'
      );
      expect(driveOptions.headers.Authorization).toBe('Bearer oauth-token');
      const putCall = global.UrlFetchApp.fetch.mock.calls.find(([url]) =>
        url.startsWith('https://example.com/upload/')
      );
      expect(putCall[1].payload.getBytes()).toEqual(bytes);
      delete global.ScriptApp;
    });
  });
});
