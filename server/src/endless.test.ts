import { describe, expect, it } from 'vitest';

import type { GenerateRequest } from '@latent/shared';

import { queueThroughLists } from './endless.js';

/** A queue that records what it was sent and answers like a successful batch. */
function recorder(failOn?: number) {
  const sent: GenerateRequest[] = [];
  const queue = async (request: GenerateRequest) => {
    sent.push(request);
    if (failOn !== undefined && sent.length === failOn) {
      return { generationIds: [], promptIds: [], error: 'ComfyUI said no' };
    }
    const ids = Array.from({ length: request.batchCount ?? 1 }, (_, i) => `g${sent.length}.${i}`);
    return { generationIds: ids, promptIds: ids };
  };
  return { sent, queue };
}

const base: GenerateRequest = {
  workflowId: 'w',
  values: { '1.image': 'a.png', '6.text': 'a cat' },
  batchInputs: { '1.image': ['a.png', 'b.png', 'c.png'] },
  batchCount: 1,
};

describe('endless rounds through a picture list', () => {
  it('uses the picture the slot holds, and leaves the next one for the next round', async () => {
    const { sent, queue } = recorder();
    const first = await queueThroughLists(base, queue);
    expect(sent.map((request) => request.values['1.image'])).toEqual(['a.png']);
    expect(first.next.values['1.image']).toBe('b.png');

    const second = await queueThroughLists(first.next, queue);
    const third = await queueThroughLists(second.next, queue);
    await queueThroughLists(third.next, queue);
    // Round and round: a, b, c, then a again.
    expect(sent.map((request) => request.values['1.image'])).toEqual([
      'a.png',
      'b.png',
      'c.png',
      'a.png',
    ]);
    // Nothing else about the settings moves.
    expect(sent.every((request) => request.values['6.text'] === 'a cat')).toBe(true);
  });

  it('makes "queue four" one run per picture, as Generate does', async () => {
    const { sent, queue } = recorder();
    const { outcome, next } = await queueThroughLists({ ...base, batchCount: 4 }, queue);
    expect(sent.map((request) => [request.values['1.image'], request.batchCount])).toEqual([
      ['a.png', 1],
      ['b.png', 1],
      ['c.png', 1],
      ['a.png', 1],
    ]);
    expect(next.values['1.image']).toBe('b.png');
    expect('generationIds' in outcome && outcome.generationIds).toHaveLength(4);
  });

  it('stops at a run that would not queue, with the list where that run left it', async () => {
    const { sent, queue } = recorder(2);
    const { outcome, next } = await queueThroughLists({ ...base, batchCount: 4 }, queue);
    expect(sent).toHaveLength(2);
    // The first went; the second (b) did not, so b is next.
    expect(next.values['1.image']).toBe('b.png');
    expect('error' in outcome && outcome.error).toBe('ComfyUI said no');
  });

  it('is one request as before without a list, or with a list of one', async () => {
    const plain = recorder();
    const none = await queueThroughLists(
      { ...base, batchInputs: undefined, batchCount: 3 },
      plain.queue,
    );
    expect(plain.sent).toHaveLength(1);
    expect(plain.sent[0]!.batchCount).toBe(3);
    expect(none.next.values).toBe(base.values);

    const single = recorder();
    await queueThroughLists(
      { ...base, batchInputs: { '1.image': ['a.png'] }, batchCount: 3 },
      single.queue,
    );
    expect(single.sent).toHaveLength(1);
    expect(single.sent[0]!.batchCount).toBe(3);
  });
});
