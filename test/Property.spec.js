import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as Code from '../src/Code.js';

// Property-based tests (fast-check) for the pure shaping /
// aggregation / RSS functions. The generated domains mirror
// what can actually arrive from outside: arbitrary JSON values
// from the Meta / GA4 / X APIs and arbitrary Sheets cell values.
// Two domain notes:
//  - The unstringifiable object {"toString":[]} is a legitimate
//    JSON-domain member (JSON.parse produces it) and is included
//    explicitly in the junk generator: it is the value that made
//    String() / Number() throw across the fleet.
//  - fc.date is used with noInvalidDate so the harness itself
//    never hands the code an Invalid Date it did not ask for;
//    text generators use grapheme-safe alphabets where a lone
//    surrogate cannot occur in real API text — except for
//    escapeXmlText_, whose whole job is to sanitize text, so it
//    is fed fc.string() unrestricted (lone surrogates included).
const evil = () => JSON.parse('{"toString":[]}');

const junkValue = fc.oneof(
  fc.string(),
  fc.double(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.record({ value: fc.integer() }),
  fc.constantFrom(evil())
);

// A value that can arrive as an insights / wire "value" field.
const wireValue = fc.oneof(
  fc.integer({ min: 0, max: 100000 }),
  fc.double({ min: 0, max: 100000, noNaN: true }),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { maxLength: 2 }),
  fc.constantFrom(evil())
);

const insightsPayload = fc.record({
  data: fc.array(
    fc.record({
      total_value: fc.record({ value: wireValue }),
      values: fc.array(fc.record({ value: wireValue }), { maxLength: 4 }),
    }),
    { maxLength: 2 }
  ),
});

const isAbsentOrFinite = (v) =>
  v === null || (typeof v === 'number' && Number.isFinite(v));

describe('number readers: never throw, never invent a count', () => {
  it('snsHistoryNumberCell_', () => {
    fc.assert(
      fc.property(junkValue, (v) => {
        const out = Code.snsHistoryNumberCell_(v);
        expect(isAbsentOrFinite(out)).toBe(true);
        if (typeof v === 'number' && Number.isFinite(v)) {
          expect(out).toBe(v);
        }
      }),
      { numRuns: 100 }
    );
  });
  it('xWireNumberOrNull_', () => {
    fc.assert(
      fc.property(junkValue, (v) => {
        const out = Code.xWireNumberOrNull_(v);
        expect(isAbsentOrFinite(out)).toBe(true);
        if (typeof v === 'number' && Number.isFinite(v)) {
          expect(out).toBe(v);
        }
      }),
      { numRuns: 100 }
    );
  });
  it('parseInsightsTotalValue_ / parseInsightsDailySum_ / parseViewsDailyTotal_', () => {
    fc.assert(
      fc.property(insightsPayload, (payload) => {
        expect(isAbsentOrFinite(Code.parseInsightsTotalValue_(payload))).toBe(
          true
        );
        expect(isAbsentOrFinite(Code.parseInsightsDailySum_(payload))).toBe(
          true
        );
        expect(isAbsentOrFinite(Code.parseViewsDailyTotal_(payload))).toBe(
          true
        );
      }),
      { numRuns: 100 }
    );
  });
  it('threadsInsightEntryTotal_ / parseThreadsFollowersCount_', () => {
    fc.assert(
      fc.property(
        fc.record({
          total_value: fc.record({ value: wireValue }),
          values: fc.array(fc.record({ value: wireValue }), { maxLength: 4 }),
        }),
        (entry) => {
          expect(isAbsentOrFinite(Code.threadsInsightEntryTotal_(entry))).toBe(
            true
          );
          expect(
            isAbsentOrFinite(
              Code.parseThreadsFollowersCount_({ data: [entry] })
            )
          ).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
  it('parseInsightsDailySum_ conserves the sum of the reported values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10000 }), { maxLength: 8 }),
        (values) => {
          const payload = {
            data: [{ values: values.map((value) => ({ value })) }],
          };
          const expected = values.reduce((a, b) => a + b, 0);
          expect(Code.parseInsightsDailySum_(payload)).toBe(
            values.length ? expected : null
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('escapeXmlText_ always yields feed-safe text', () => {
  it('no raw specials, no C0 controls, no lone surrogates', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = Code.escapeXmlText_(s);
        // Every & begins one of the five entities.
        expect(/&(?!(amp|lt|gt|quot|apos);)/.test(out)).toBe(false);
        expect(/</.test(out)).toBe(false);
        expect(/>/.test(out)).toBe(false);
        expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(out)).toBe(
          false
        );
        expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
        expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

describe('buildCommentsRss_ over arbitrary stored rows', () => {
  const rowArb = fc.record({
    id: fc.oneof(fc.string(), fc.integer(), fc.constantFrom(evil())),
    username: fc.oneof(fc.string(), fc.integer(), fc.constantFrom(evil())),
    text: fc.oneof(
      fc.string(),
      fc.integer(),
      fc.constantFrom(evil()),
      fc.constant(null)
    ),
    posted_at: fc.oneof(
      fc
        .date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2030-01-01T00:00:00Z'),
          noInvalidDate: true,
        })
        .map((d) => d.toISOString()),
      fc.string(),
      fc.constantFrom(evil()),
      fc.constant(null)
    ),
    permalink: fc.oneof(fc.string(), fc.constantFrom(evil())),
  });
  it('never throws, emits only datable items, newest first, capped at 50', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 60 }), (rows) => {
        const xml = Code.buildCommentsRss_('instagram', rows);
        expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
        const dates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map(
          (m) => Date.parse(m[1])
        );
        expect(dates.length).toBeLessThanOrEqual(50);
        dates.forEach((ms) => expect(Number.isFinite(ms)).toBe(true));
        for (let i = 1; i < dates.length; i++) {
          expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
        }
        // No lone surrogates anywhere in the document.
        expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(xml)).toBe(false);
        expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(xml)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

describe('buildPerfRss_ over arbitrary items', () => {
  it('never throws and escapes every text field', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant(null),
            fc.record({
              guid: fc.string(),
              pubDate: fc.constant('Thu, 20 Nov 2026 00:00:00 GMT'),
              title: fc.string(),
              descriptionText: fc.string(),
            })
          ),
          { maxLength: 10 }
        ),
        (items) => {
          const xml = Code.buildPerfRss_(items);
          expect(xml).toContain('<channel>');
          const bodies = xml
            .split('<item>')
            .slice(1)
            .map((part) => part.split('</item>')[0]);
          bodies.forEach((body) => {
            const title = body.split('<title>')[1].split('</title>')[0];
            expect(/</.test(title)).toBe(false);
            expect(/&(?!(amp|lt|gt|quot|apos);)/.test(title)).toBe(false);
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('comment parsers always return string-shaped entries', () => {
  const itemArb = fc.record({
    id: fc.oneof(fc.string(), fc.integer(), fc.constantFrom(evil())),
    username: fc.oneof(fc.string(), fc.constantFrom(evil()), fc.constant(null)),
    text: fc.oneof(fc.string(), fc.constantFrom(evil()), fc.constant(null)),
    timestamp: fc.oneof(fc.string(), fc.constant(null)),
    like_count: wireValue,
  });
  it('parseInstagramComments_', () => {
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 10 }), (items) => {
        const out = Code.parseInstagramComments_({ data: items });
        out.forEach((comment) => {
          expect(typeof comment.id).toBe('string');
          expect(typeof comment.username).toBe('string');
          expect(typeof comment.text).toBe('string');
          expect(
            comment.like_count === null ||
              (typeof comment.like_count === 'number' &&
                Number.isFinite(comment.like_count))
          ).toBe(true);
        });
      }),
      { numRuns: 100 }
    );
  });
});

describe('compareTimestampDesc_ is a total, antisymmetric order', () => {
  it('over arbitrary junk pairs', () => {
    fc.assert(
      fc.property(junkValue, junkValue, (a, b) => {
        const ab = Code.compareTimestampDesc_(a, b);
        const ba = Code.compareTimestampDesc_(b, a);
        expect(typeof ab).toBe('number');
        expect(Math.sign(ab)).toBe(-Math.sign(ba) || 0);
      }),
      { numRuns: 100 }
    );
  });
});

describe('JST day helpers round-trip real days', () => {
  it('jstDayWindowSec_(jstDateKey_(ms)) contains the instant', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2035-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        (date) => {
          const ms = date.getTime();
          const win = Code.jstDayWindowSec_(Code.jstDateKey_(ms));
          expect(win).not.toBeNull();
          expect(win.since * 1000).toBeLessThanOrEqual(ms);
          expect(ms).toBeLessThanOrEqual(win.until * 1000 + 999);
          expect(win.until - win.since).toBe(86399);
        }
      ),
      { numRuns: 100 }
    );
  });
  it('perfRssSlots_ yields descending slots at or before now', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2035-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: 1, max: 15 }),
        (date, count) => {
          const nowMs = date.getTime();
          const slots = Code.perfRssSlots_(nowMs, count);
          expect(slots.length).toBeLessThanOrEqual(count);
          slots.forEach((slot, i) => {
            expect(slot.atMs).toBeLessThanOrEqual(nowMs);
            expect(/^\d{4}-\d{2}-\d{2}$/.test(slot.dateKey)).toBe(true);
            if (i > 0) {
              expect(slot.atMs).toBeLessThan(slots[i - 1].atMs);
            }
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('rankTopArticles_ over arbitrary GA4 rows', () => {
  it('never throws, sums per article, sorts descending, respects the limit', () => {
    const idA = '1tn5P1vB1jnKHSay_FC2AEtNxH0gQZ3_jffRnHuz4YpM';
    const idB = '1V7cXplHKbsT48EhLarl-SPHfDV-lSEafEId2OMgExkg';
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant(null),
            fc.constant(42),
            fc.record({
              dimensionValues: fc.array(
                fc.record({ value: fc.constantFrom('/' + idA, '/blog/' + idB, '/other/') }),
                { maxLength: 1 }
              ),
              metricValues: fc.array(
                fc.record({
                  value: fc.oneof(
                    fc.integer({ min: 0, max: 1000 }).map(String),
                    fc.constant(null),
                    fc.constantFrom(evil())
                  ),
                }),
                { maxLength: 1 }
              ),
            })
          ),
          { maxLength: 12 }
        ),
        fc.integer({ min: 1, max: 10 }),
        (rows, limit) => {
          const out = Code.rankTopArticles_(rows, limit);
          expect(out.length).toBeLessThanOrEqual(limit);
          out.forEach((entry, i) => {
            expect(typeof entry.views).toBe('number');
            expect(Number.isFinite(entry.views)).toBe(true);
            if (i > 0) {
              expect(entry.views).toBeLessThanOrEqual(out[i - 1].views);
            }
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
