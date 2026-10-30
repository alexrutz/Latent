import { describe, expect, it } from 'vitest';

import {
  advanceBatch,
  advanceBatches,
  batchLength,
  batchPosition,
  pruneBatches,
  queueThroughBatch,
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

describe('queueThroughBatch', () => {
  const batches = { image: ['a.png', 'b.png', 'c.png', 'd.png'] };

  it('moves the slot on once per queued run', async () => {
    const sent: unknown[] = [];
    const outcome = await queueThroughBatch({ image: 'a.png' }, batches, 3, async (values) => {
      sent.push(values.image);
    });
    expect(sent).toEqual(['a.png', 'b.png', 'c.png']);
    expect(outcome).toEqual({ values: { image: 'd.png' }, queued: 3, error: null });
  });

  /*
   * The case this exists for. The third of four failing used to throw the
   * progress away, leaving the form on the first picture with two runs
   * already queued — so the next Generate made those two again.
   */
  it('keeps the progress when a run part way through fails', async () => {
    const failure = new Error('ComfyUI went away');
    let calls = 0;
    const outcome = await queueThroughBatch({ image: 'a.png' }, batches, 4, async () => {
      calls += 1;
      if (calls === 3) throw failure;
    });
    // Two queued, so the slot holds the third: the one that did not go.
    expect(outcome).toEqual({ values: { image: 'c.png' }, queued: 2, error: failure });
  });

  it('leaves the values alone when the first run fails', async () => {
    const values = { image: 'a.png' };
    const outcome = await queueThroughBatch(values, batches, 2, async () => {
      throw new Error('no');
    });
    expect(outcome.values).toBe(values);
    expect(outcome.queued).toBe(0);
  });
});
