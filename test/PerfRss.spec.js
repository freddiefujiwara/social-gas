import { describe, it, expect } from 'vitest';
import * as Code from '../src/Code.js';

// The performance highlights RSS (action=perf_rss): one item
// per delivery slot (06:00 / 12:30 / 20:30 JST), computed on
// the fly from the history tabs. These tests pin the slot
// arithmetic, the snapshot picking and the item wording; the
// token gate reuses the comments feed's and is covered there.
describe('Performance highlights RSS', () => {
  const accountRow = (collected_at, figures) =>
    Object.assign(
      {
        collected_at,
        total_followers: null,
        ig_followers: null,
        threads_followers: null,
        youtube_subscribers: null,
        x_followers: null,
        views_30d: null,
        x_api_balance_usd: null,
      },
      figures
    );

  // 2026-11-16 05:20 JST / 20:20 JST, 2026-11-17 05:20 JST.
  const accountRows = [
    accountRow('2026-11-15T20:20:00.000Z', {
      total_followers: 4193,
      ig_followers: 2086,
      threads_followers: 254,
      youtube_subscribers: 12,
      x_followers: 1841,
      views_30d: 556017,
      x_api_balance_usd: 40.75,
    }),
    accountRow('2026-11-16T11:20:00.000Z', {
      total_followers: 4206,
      ig_followers: 2098,
      threads_followers: 255,
      youtube_subscribers: 12,
      x_followers: 1841,
      views_30d: 564698,
      x_api_balance_usd: 39.89,
    }),
    accountRow('2026-11-16T20:20:00.000Z', {
      total_followers: 4215,
      ig_followers: 2105,
      threads_followers: 256,
      youtube_subscribers: 12,
      x_followers: 1842,
      views_30d: 570000,
      x_api_balance_usd: 39.69,
    }),
  ];

  describe('perfRssSlots_', () => {
    it('starts at today’s morning slot just after 06:00 JST', () => {
      const slots = Code.perfRssSlots_(Date.parse('2026-11-17T06:05:00+09:00'), 3);
      expect(slots.map((slot) => slot.dateKey + '-' + slot.key)).toEqual([
        '2026-11-17-morning',
        '2026-11-16-evening',
        '2026-11-16-noon',
      ]);
      expect(slots[0].atMs).toBe(Date.parse('2026-11-17T06:00:00+09:00'));
    });

    it('falls back to yesterday’s evening slot before 06:00 JST', () => {
      const slots = Code.perfRssSlots_(Date.parse('2026-11-17T05:59:00+09:00'), 2);
      expect(slots.map((slot) => slot.dateKey + '-' + slot.key)).toEqual([
        '2026-11-16-evening',
        '2026-11-16-noon',
      ]);
    });
  });

  describe('perfSnapshotAt_', () => {
    it('picks the newest row at or before the instant', () => {
      const snap = Code.perfSnapshotAt_(
        accountRows,
        Date.parse('2026-11-17T06:00:00+09:00')
      );
      expect(snap.total).toBe(4215);
      expect(snap.balance).toBe(39.69);
    });

    it('returns null when no row predates the instant', () => {
      expect(
        Code.perfSnapshotAt_(accountRows, Date.parse('2026-11-15T00:00:00+09:00'))
      ).toBeNull();
    });
  });

  describe('buildPerfHighlightItem_', () => {
    const data = {
      accountRows,
      blogDailyRows: [
        { date: '2026-11-15', views: 30 },
        { date: '2026-11-16', views: 48 },
        { date: '2026-11-17', views: 5 },
      ],
      blogPostRows: [
        { path: '/blog/a', title: '記事A', views_28d: 100 },
        { path: '/blog/b', title: '記事B', views_28d: 250 },
      ],
      mediaRows: [
        {
          posted_at: '2026-11-16T15:00:00.000Z',
          caption: '新しいリール\n詳しい説明',
        },
        {
          posted_at: '2026-11-15T15:00:00.000Z',
          caption: '前の投稿',
        },
      ],
    };

    it('builds the morning item from the slot snapshots', () => {
      const slots = Code.perfRssSlots_(Date.parse('2026-11-17T06:05:00+09:00'), 2);
      const item = Code.buildPerfHighlightItem_(slots[0], slots[1], data);
      expect(item.title).toBe('11月17日 朝のハイライト');
      expect(item.guid).toBe('perf-2026-11-17-morning');
      expect(item.pubDate).toBe('Mon, 16 Nov 2026 21:00:00 GMT');
      expect(item.descriptionHtml).toContain('SNS延べフォロワー数: 4,215人（前日比 +22）');
      expect(item.descriptionHtml).toContain('Instagram 2,105人');
      expect(item.descriptionHtml).toContain(
        'Instagram 過去30日の再生回数: 570,000回（前回配信から +5,302回）'
      );
      expect(item.descriptionHtml).toContain('ブログ（11月16日）: 表示 48回');
      expect(item.descriptionHtml).toContain('よく読まれている記事: 記事B（28日で 250回）');
      expect(item.descriptionHtml).toContain('X クレジット残高: $39.69');
      expect(item.descriptionHtml).toContain('新規投稿: 新しいリール');
      expect(item.descriptionHtml).not.toContain('前の投稿');
    });

    it('returns null when no snapshot predates the slot', () => {
      const slots = Code.perfRssSlots_(Date.parse('2026-11-17T06:05:00+09:00'), 1);
      const item = Code.buildPerfHighlightItem_(slots[0], null, {
        accountRows: [],
        blogDailyRows: [],
        blogPostRows: [],
        mediaRows: [],
      });
      expect(item).toBeNull();
    });
  });

  describe('buildPerfRss_', () => {
    it('renders items with stable guids and escaped titles', () => {
      const xml = Code.buildPerfRss_([
        {
          title: '11月17日 朝のハイライト',
          guid: 'perf-2026-11-17-morning',
          pubDate: 'Mon, 16 Nov 2026 21:00:00 GMT',
          descriptionHtml: 'SNS延べフォロワー数: 4,215人',
        },
      ]);
      expect(xml).toContain('<title>SNSハイライト（@freddiefujiwara）</title>');
      expect(xml).toContain('<guid isPermaLink="false">perf-2026-11-17-morning</guid>');
      expect(xml).toContain('<pubDate>Mon, 16 Nov 2026 21:00:00 GMT</pubDate>');
      expect(xml).toContain('<description>SNS延べフォロワー数: 4,215人</description>');
    });

    it('renders an empty channel for no items', () => {
      const xml = Code.buildPerfRss_([]);
      expect(xml).toContain('<channel>');
      expect(xml).not.toContain('<item>');
    });
  });
});
