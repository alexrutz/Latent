import { describe, expect, it } from 'vitest';

import {
  advanceBatch,
  advanceBatches,
  batchLength,
  batchPosition,
  pruneBatches,
} from './inputBatch.js';

describe('advanceBatch', () => {
  const list = ['a.png', 'b.png', 'c.png'];

  it('moves to the next entry', () => {
    expect(advanceBatch(list, 'a.png')).toBe('b.png');
    expect(advanceBatch(list, 'b.png')).toBe('c.png');
  });

  it('wraps at the end rather than stopping', () => {
    expect(advanceBatch(list, 'c.png')).toBe('a.png');
  });

  it('gives a list of one the same picture again', () => {
    expect(advanceBatch(['only.png'], 'only.png')).toBe('only.png');
  });

  it('leaves the slot alone when there is no list', () => {
    expect(advanceBatch([], 'held.png')).toBe('held.png');
    expect(advanceBatch([], null)).toBeNull();
  });

  it('starts at the beginning when the slot holds something else', () => {
    expect(advanceBatch(list, 'picked-by-hand.png')).toBe('a.png');
    expect(advanceBatch(list, null)).toBe('a.png');
  });
});

describe('advanceBatches', () => {
  it('moves every batched slot on together', () => {
    const values = { '3.image': 'a.png', '9.image': 'x.png', '4.steps': 20 };
    const next = advanceBatches(values, {
      '3.image': ['a.png', 'b.png'],
      '9.image': ['x.png', 'y.png'],
    });

    expect(next['3.image']).toBe('b.png');
    expect(next['9.image']).toBe('y.png');
    // Untouched, and still the same kind of thing it was.
    expect(next['4.steps']).toBe(20);
  });

  it('leaves the values object identical when nothing moves', () => {
    const values = { '3.image': 'only.png' };
    expect(advanceBatches(values, { '3.image': ['only.png'] })).toBe(values);
    expect(advanceBatches(values, {})).toBe(values);
  });

  it('ignores a slot whose list is empty', () => {
    const values = { '3.image': 'held.png' };
    expect(advanceBatches(values, { '3.image': [] })['3.image']).toBe('held.png');
  });

  it('wraps two lists of different lengths independently', () => {
    let values: Record<string, unknown> = { a: '1', b: 'x' };
    const batches = { a: ['1', '2', '3'], b: ['x', 'y'] };

    // Six runs brings both back to where they started, which is the point of
    // wrapping each list on its own rather than pairing them off once.
    for (let run = 0; run < 6; run += 1) values = advanceBatches(values, batches);
    expect(values).toEqual({ a: '1', b: 'x' });
  });
});

describe('batchLength', () => {
  it('is the longest list, not the total', () => {
    expect(batchLength({ a: ['1', '2', '3', '4'], b: ['x', 'y'] })).toBe(4);
  });

  it('is zero with nothing set', () => {
    expect(batchLength({})).toBe(0);
    expect(batchLength({ a: [] })).toBe(0);
  });
});

describe('batchPosition', () => {
  it('counts from one', () => {
    expect(batchPosition(['a', 'b', 'c'], 'a')).toBe(1);
    expect(batchPosition(['a', 'b', 'c'], 'c')).toBe(3);
  });

  it('is zero for a picture that is not in the list', () => {
    expect(batchPosition(['a', 'b'], 'z')).toBe(0);
    expect(batchPosition(['a', 'b'], null)).toBe(0);
  });
});

describe('pruneBatches', () => {
  it('drops the slots whose list was emptied', () => {
    expect(pruneBatches({ a: ['1'], b: [] })).toEqual({ a: ['1'] });
  });
});
