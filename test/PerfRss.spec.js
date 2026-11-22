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
    accountRow('2026-11-15T14:20:00.000Z', {
      total_followers: 4190,
      ig_followers: 2080,
      threads_followers: 253,
      youtube_subscribers: 12,
      x_followers: 1841,
      views_30d: 550000,
      x_api_balance_usd: 40.9,
    }),
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
    accountRow('2026-11-17T02:20:00.000Z', {
      total_followers: 4222,
      ig_followers: 2107,
      threads_followers: 256,
      youtube_subscribers: 12,
      x_followers: 1847,
      views_30d: 572709,
      x_api_balance_usd: 39.41,
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
        // The generic SPA-shell title outranks both on views
        // and must still be skipped.
        { path: '/blog/c', title: '藤原史和｜川口を歩くQAエンジニア', views_28d: 458 },
      ],
      mediaRows: [
        {
          posted_at: '2026-11-16T15:00:00.000Z',
          caption: '新しいリール\n詳しい説明',
        },
        {
          posted_at: '2026-11-15T15:00:00.000Z',
          caption: '前の投稿',
          views: 100,
          saves: 1,
          shares: 0,
        },
        {
          posted_at: '2026-11-16T03:00:00+0000',
          caption: '昨日のリールA',
          views: 5000,
          saves: 250,
          shares: 40,
          avg_watch_sec: 10,
          duration_sec: 20,
        },
        {
          posted_at: '2026-11-16T10:00:00+0000',
          caption: '昨日のリールB',
          views: 1200,
          saves: 12,
          shares: 3,
          avg_watch_sec: 5,
          duration_sec: 25,
        },
      ],
      dailyRows: [{ date: '2026-11-16', follows: 25, unfollows: 7 }],
      threadsMediaRows: [
        {
          posted_at: '2026-11-16T02:00:00+0000',
          text: '昨日のThreads投稿',
          views: 300,
          replies: 2,
        },
        {
          posted_at: '2026-11-16T05:00:00+0000',
          text: 'もう1件の投稿',
          views: 120,
          replies: 0,
        },
      ],
      youtubeMediaRows: [
        { published_at: '2026-11-16T04:00:00Z', title: '昨日の動画', views: 88 },
      ],
      xMediaRows: [
        { posted_at: '2026-11-16T01:00:00.000Z', text: '昨日のポスト', views: 450 },
      ],
      blogPostsDailyRows: [
        { date: '2026-11-16', path: '/blog/b', title: '記事B', views: 120 },
        { date: '2026-11-16', path: '/blog/a', title: '記事A', views: 30 },
        { date: '2026-11-16', path: '/blog/c2', title: '記事C', views: 25 },
        { date: '2026-11-16', path: '/blog/d', title: '記事D', views: 10 },
        { date: '2026-11-16', path: '/blog/e', title: '記事E', views: 8 },
        { date: '2026-11-16', path: '/blog/f', title: '記事F', views: 5 },
        {
          date: '2026-11-16',
          path: '/blog/g',
          title: '藤原史和｜川口を歩くQAエンジニア',
          views: 200,
        },
        { date: '2026-11-15', path: '/blog/z', title: '一昨日の記事Z', views: 999 },
      ],
    };

    it('builds the morning item: compact summary, separator, full detail', () => {
      const slots = Code.perfRssSlots_(Date.parse('2026-11-17T06:05:00+09:00'), 2);
      const item = Code.buildPerfHighlightItem_(slots[0], slots[1], data);
      expect(item.title).toBe('11月17日 朝のハイライト');
      expect(item.guid).toBe('perf-2026-11-17-morning');
      expect(item.pubDate).toBe('Mon, 16 Nov 2026 21:00:00 GMT');
      const summary = item.descriptionText.split('\n')[0];
      expect(summary).toBe(
        '延べ4,215人(+22) / IG2,105 Th256 YT12 X1,842 / 再生570,000回(+5,302) / ' +
          'ブログ(11/16)48回 / X残高$39.69 / 人気記事: 記事B 250回'
      );
      expect(summary.length).toBeLessThanOrEqual(Code.PERF_RSS_SUMMARY_CHARS);
      // The new-post segment is the lowest priority in the
      // compact summary and drops off when the budget runs
      // out — but the full detail below the separator always
      // carries it.
      expect(summary).not.toContain('新しいリール');
      expect(item.descriptionText).toContain('\n-------\n');
      expect(item.descriptionText).toContain(
        'SNS延べフォロワー数: 4,215人（前日比 +22）'
      );
      expect(item.descriptionText).toContain(
        '内訳: Instagram 2,105人 / Threads 256人 / YouTube 12人 / X 1,842人'
      );
      expect(item.descriptionText).toContain(
        'Instagram 過去30日の再生回数: 570,000回（前回配信から +5,302回）'
      );
      expect(item.descriptionText).toContain('ブログ（11月16日）: 表示 48回');
      expect(item.descriptionText).toContain(
        'よく読まれている記事: 記事B（28日で 250回）'
      );
      expect(item.descriptionText).toContain('X クレジット残高: $39.69');
      expect(item.descriptionText).toContain('新規投稿: 新しいリール');
      expect(item.descriptionText).not.toContain('新規投稿: 前の投稿');
      // Per-channel "yesterday" sections follow the summary.
      expect(item.descriptionText).toContain('【Instagram 昨日（11月16日）】');
      expect(item.descriptionText).toContain('フォロワー +18（フォロー 25 / 解除 7）');
      expect(item.descriptionText).toContain('投稿 3件（再生順）');
      expect(item.descriptionText).toContain('・前の投稿: 再生100回 / 保存1 / シェア0');
      expect(item.descriptionText).toContain(
        '・昨日のリールA: 再生5,000回 / 保存250 / シェア40 / 視聴率50%'
      );
      expect(item.descriptionText).toContain(
        '・昨日のリールB: 再生1,200回 / 保存12 / シェア3 / 視聴率20%'
      );
      expect(item.descriptionText).toContain('保存率トップ: 昨日のリールA（5.0%）');
      expect(item.descriptionText).toContain('【Threads 昨日（11月16日）】');
      expect(item.descriptionText).toContain('フォロワー +2');
      expect(item.descriptionText).toContain(
        '投稿 2件 / 最多表示: 昨日のThreads投稿（表示300回・返信2）'
      );
      expect(item.descriptionText).toContain('【YouTube 昨日（11月16日）】');
      expect(item.descriptionText).toContain('登録者 ±0');
      expect(item.descriptionText).toContain('新規動画: 昨日の動画（再生88回）');
      expect(item.descriptionText).toContain('【X 昨日（11月16日）】');
      expect(item.descriptionText).toContain(
        'ポスト 1件 / 最多表示: 昨日のポスト（表示450回）'
      );
      expect(item.descriptionText).toContain('クレジット消費: $1.01（残高 $39.89）');
      expect(item.descriptionText).toContain('【ブログ 昨日（11月16日）】');
      expect(item.descriptionText).toContain('表示 48回（前日比 +18）');
      expect(item.descriptionText).toContain('昨日の記事トップ5');
      expect(item.descriptionText).toContain('1. 記事B（120回）');
      expect(item.descriptionText).toContain('2. 記事A（30回）');
      expect(item.descriptionText).toContain('3. 記事C（25回）');
      expect(item.descriptionText).toContain('4. 記事D（10回）');
      expect(item.descriptionText).toContain('5. 記事E（8回）');
      expect(item.descriptionText).not.toContain('記事F');
      expect(item.descriptionText).not.toContain('一昨日の記事Z');
    });

    it('builds the noon item as a diff against the morning slot', () => {
      const slots = Code.perfRssSlots_(Date.parse('2026-11-17T13:05:00+09:00'), 2);
      const item = Code.buildPerfHighlightItem_(slots[0], slots[1], data);
      expect(item.title).toBe('11月17日 昼のハイライト');
      expect(item.guid).toBe('perf-2026-11-17-noon');
      expect(item.pubDate).toBe('Tue, 17 Nov 2026 03:30:00 GMT');
      expect(item.descriptionText.split('\n')[0]).toBe(
        '延べ4,222人(+7) / IG2,107 Th256 YT12 X1,847 / 再生572,709回(+2,709) / ' +
          'ブログ(本日)5回 / X残高$39.41'
      );
      expect(item.descriptionText).toContain(
        'SNS延べフォロワー数: 4,222人（前回配信から +7）'
      );
      expect(item.descriptionText).toContain(
        '内訳: Instagram 2,107人（+2） / Threads 256人（±0） / YouTube 12人（±0） / X 1,847人（+5）'
      );
      expect(item.descriptionText).toContain(
        'Instagram 過去30日の再生回数: 572,709回（前回配信から +2,709回）'
      );
      expect(item.descriptionText).toContain('ブログ（本日・途中経過）: 表示 5回');
      expect(item.descriptionText).toContain(
        'X クレジット消費（前回配信から）: $0.28（残高 $39.41）'
      );
      // Morning-only parts stay out of the diff items.
      expect(item.descriptionText).not.toContain('【');
      expect(item.descriptionText).not.toContain('よく読まれている記事');
      expect(item.descriptionText).not.toContain('昨日の記事トップ');
    });

    it('includes a new post in the compact summary when the budget has room', () => {
      const slots = Code.perfRssSlots_(Date.parse('2026-11-17T06:05:00+09:00'), 2);
      const item = Code.buildPerfHighlightItem_(
        slots[0],
        slots[1],
        Object.assign({}, data, { blogPostRows: [] })
      );
      expect(item.descriptionText.split('\n')[0]).toContain('新規: 新しいリール');
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
          descriptionText: '延べ4,215人(+22)',
        },
      ]);
      expect(xml).toContain('<title>SNSハイライト（@freddiefujiwara）</title>');
      expect(xml).toContain('<guid isPermaLink="false">perf-2026-11-17-morning</guid>');
      expect(xml).toContain('<pubDate>Mon, 16 Nov 2026 21:00:00 GMT</pubDate>');
      expect(xml).toContain('<description>延べ4,215人(+22)</description>');
    });

    it('renders an empty channel for no items', () => {
      const xml = Code.buildPerfRss_([]);
      expect(xml).toContain('<channel>');
      expect(xml).not.toContain('<item>');
    });
  });
});
