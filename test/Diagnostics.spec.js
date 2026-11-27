import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debugSnsInsights, debugThreadsFollowers, debugThreadsPosts } from '../src/diagnostics.js';

const TOKEN = 'dummy-token +/==';
const log = () => Logger.log.mock.calls.flat().join('\n');
const response = (status, body) => ({
  getResponseCode: () => status,
  getContentText: () => JSON.stringify(body),
});

describe('manual SNS diagnostics', () => {
  beforeEach(() => {
    vi.stubGlobal('PropertiesService', {
      getScriptProperties: () => ({
        getProperty: (key) => key === 'META_ACCESS_TOKEN' || key === 'META_THREADS_ACCESS_TOKEN' ? TOKEN : null,
      }),
    });
    vi.stubGlobal('UrlFetchApp', { fetch: vi.fn() });
    vi.stubGlobal('Logger', { log: vi.fn() });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('redacts tokens in raw Instagram responses and the errors-only summary', () => {
    UrlFetchApp.fetch.mockReturnValue(response(400, {
      error: { code: 190, message: 'Rejected ' + TOKEN + ' / ' + encodeURIComponent(TOKEN) },
    }));

    debugSnsInsights();

    expect(UrlFetchApp.fetch).toHaveBeenCalledTimes(6);
    expect(UrlFetchApp.fetch.mock.calls.every(([url]) => url.endsWith('&access_token=' + encodeURIComponent(TOKEN)))).toBe(true);
    expect(log()).toContain('HTTP 400 code=190: Rejected <redacted> / <redacted>');
    expect(log()).not.toContain(TOKEN);
    expect(log()).not.toContain(encodeURIComponent(TOKEN));
  });

  it('logs the failure type, not the URL or message, when a Threads fetch throws', () => {
    UrlFetchApp.fetch.mockImplementation((url) => { throw new Error('request failed: ' + url); });

    debugThreadsFollowers();

    expect(log()).toContain('access_token=<redacted>');
    expect(log()).toContain('fetch exception (Error)');
    expect(log()).not.toContain('request failed');
    expect(log()).not.toContain(encodeURIComponent(TOKEN));
  });

  it('also redacts a token in the parsed Threads post log', () => {
    UrlFetchApp.fetch
      .mockReturnValueOnce(response(200, { data: [] }))
      .mockReturnValueOnce(response(200, { data: [{ id: 'post-1', text: TOKEN }] }))
      .mockReturnValueOnce(response(200, { data: [] }));

    debugThreadsPosts();

    const parsedLog = Logger.log.mock.calls.flat().find((line) => line.startsWith('first post entry: '));
    expect(parsedLog).toContain('<redacted>');
    expect(log()).not.toContain(TOKEN);
    expect(UrlFetchApp.fetch).toHaveBeenCalledTimes(3);
  });
});
