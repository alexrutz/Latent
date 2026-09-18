import { describe, expect, it } from 'vitest';

import {
  dayKeyOf,
  dayLabelOf,
  groupByDay,
  isRecentDay,
  previewEveryOf,
  previewOf,
} from './daySections.js';

/** A local timestamp, so the tests mean the same thing in every timezone. */
const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month - 1, day, hour).getTime();

const NOW = at(2026, 3, 14, 9);

describe('dayKeyOf', () => {
  it('puts two times on the same day under one key', () => {
    expect(dayKeyOf(at(2026, 3, 14, 1))).toBe(dayKeyOf(at(2026, 3, 14, 23)));
  });

  it('separates days that are an hour apart across midnight', () => {
    expect(dayKeyOf(at(2026, 3, 14, 23))).not.toBe(dayKeyOf(at(2026, 3, 15, 0)));
  });
});

describe('dayLabelOf', () => {
  it('names the two days worth naming', () => {
    expect(dayLabelOf(at(2026, 3, 14, 3), NOW)).toBe('Today');
    expect(dayLabelOf(at(2026, 3, 13, 22), NOW)).toBe('Yesterday');
  });

  it('dates the rest, and only carries a year when it is not this one', () => {
    expect(dayLabelOf(at(2026, 3, 1), NOW)).not.toMatch(/2026/);
    expect(dayLabelOf(at(2025, 12, 1), NOW)).toMatch(/2025/);
  });
});

describe('isRecentDay', () => {
  it('holds today and yesterday open and nothing else', () => {
    expect(isRecentDay(dayKeyOf(at(2026, 3, 14)), NOW)).toBe(true);
    expect(isRecentDay(dayKeyOf(at(2026, 3, 13)), NOW)).toBe(true);
    expect(isRecentDay(dayKeyOf(at(2026, 3, 12)), NOW)).toBe(false);
  });

  it('still spans a month boundary', () => {
    const firstOfMarch = at(2026, 3, 1, 9);
    expect(isRecentDay(dayKeyOf(at(2026, 2, 28)), firstOfMarch)).toBe(true);
  });
});

describe('groupByDay', () => {
  const made = (time: number) => ({ createdAt: time });

  it('cuts a newest-first list into days, newest section first', () => {
    const sections = groupByDay(
      [made(at(2026, 3, 14, 10)), made(at(2026, 3, 14, 8)), made(at(2026, 3, 12, 20))],
      (item) => item.createdAt,
      NOW,
    );

    expect(sections.map((section) => section.label)).toEqual(['Today', expect.any(String)]);
    expect(sections[0]!.items).toHaveLength(2);
    expect(sections[1]!.items).toHaveLength(1);
  });

  it('keeps an oldest-first list oldest-first rather than re-sorting it', () => {
    const sections = groupByDay(
      [made(at(2026, 3, 12)), made(at(2026, 3, 13)), made(at(2026, 3, 14))],
      (item) => item.createdAt,
      NOW,
    );

    expect(sections.map((section) => section.label).slice(-2)).toEqual(['Yesterday', 'Today']);
  });

  it('gives an empty list no sections at all', () => {
    expect(groupByDay([], (item: { createdAt: number }) => item.createdAt, NOW)).toEqual([]);
  });
});

describe('previewOf', () => {
  const plain = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ index, rating: 0 }));

  it('takes every n-th item, starting at the first', () => {
    const preview = previewOf(plain(21), 5, (item) => item.rating > 0);
    expect(preview.map((item) => item.index)).toEqual([0, 5, 10, 15, 20]);
  });

  it('always keeps a rated item, wherever it falls', () => {
    const items = plain(10);
    items[3]!.rating = 5;
    items[7]!.rating = 1;

    const preview = previewOf(items, 5, (item) => item.rating > 0);
    expect(preview.map((item) => item.index)).toEqual([0, 3, 5, 7]);
  });

  it('shows a rated item on the stride once, not twice', () => {
    const items = plain(6);
    items[0]!.rating = 4;
    expect(previewOf(items, 5, (item) => item.rating > 0)).toHaveLength(2);
  });

  it('shows a day shorter than the stride as its first item', () => {
    expect(previewOf(plain(3), 20, () => false).map((item) => item.index)).toEqual([0]);
  });

  it('shows everything when the stride is one, or nonsense', () => {
    expect(previewOf(plain(4), 1, () => false)).toHaveLength(4);
    expect(previewOf(plain(4), 0, () => false)).toHaveLength(4);
    expect(previewOf(plain(4), -3, () => false)).toHaveLength(4);
  });

  it('leaves the source list alone', () => {
    const items = plain(4);
    previewOf(items, 2, () => false);
    expect(items).toHaveLength(4);
  });
});

describe('previewEveryOf', () => {
  it('takes a sensible number as it stands', () => {
    expect(previewEveryOf(20, 5)).toBe(20);
  });

  it('falls back when there is nothing usable', () => {
    expect(previewEveryOf(undefined, 5)).toBe(5);
    expect(previewEveryOf('not a number', 20)).toBe(20);
  });

  it('never returns a stride that would empty the preview', () => {
    expect(previewEveryOf(0, 5)).toBe(1);
    expect(previewEveryOf(-10, 5)).toBe(1);
  });

  it('reads a number that arrived as text', () => {
    expect(previewEveryOf('12', 5)).toBe(12);
  });
});
