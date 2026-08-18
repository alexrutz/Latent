import { describe, expect, it } from 'vitest';

import { diffPrompts, hasChanges } from './promptDiff.js';

/**
 * Two paragraphs of near-identical prose are genuinely hard to compare by eye.
 * What matters here is that the marking is *correct* — a diff that highlights
 * the wrong clause is worse than none, because it is believed.
 */

/** The new prompt, as the diff reassembles it. */
const rebuild = (parts: { kind: string; text: string }[]) =>
  parts
    .filter((part) => part.kind !== 'removed')
    .map((part) => part.text)
    .join('');

describe('marking what changed', () => {
  it('marks one replaced word and leaves the rest alone', () => {
    const parts = diffPrompts('a harbour at dawn', 'a harbour at dusk');
    expect(parts).toEqual([
      { kind: 'same', text: 'a harbour at ' },
      { kind: 'removed', text: 'dawn' },
      { kind: 'added', text: 'dusk' },
    ]);
  });

  it('merges a run of new words into one highlight', () => {
    const parts = diffPrompts('a harbour', 'a quiet grey harbour');
    expect(parts.filter((part) => part.kind === 'added')).toHaveLength(1);
  });

  /*
   * The new prompt is what gets rendered with the marks on it, so it has to
   * come back character for character. The removed parts are context, and
   * deliberately do not round-trip: where the two differ only in case or
   * spacing, the new spelling is the one kept.
   */
  it('reassembles the new prompt exactly', () => {
    const previous = 'a harbour at dawn, soft light, muted colours';
    const next = 'a harbour at dusk, hard light, muted colours, one gull';
    expect(rebuild(diffPrompts(previous, next))).toBe(next);
  });

  /** A first prompt has not changed from anything. */
  it('marks nothing when there is no previous prompt', () => {
    expect(diffPrompts('', 'a harbour')).toEqual([{ kind: 'same', text: 'a harbour' }]);
    expect(hasChanges(diffPrompts('', 'a harbour'))).toBe(false);
  });

  it('marks nothing when the prompt is unchanged', () => {
    expect(hasChanges(diffPrompts('a harbour', 'a harbour'))).toBe(false);
  });

  /** Capitalising a word is not a change worth shouting about. */
  it('ignores a difference of case', () => {
    expect(hasChanges(diffPrompts('A Harbour', 'a harbour'))).toBe(false);
  });

  it('handles everything being replaced', () => {
    const parts = diffPrompts('a harbour', 'a lighthouse in fog');
    expect(rebuild(parts)).toBe('a lighthouse in fog');
    expect(hasChanges(parts)).toBe(true);
  });

  it('handles an addition at the end', () => {
    const parts = diffPrompts('a harbour', 'a harbour at dawn');
    // The trailing space belongs to `harbour`, and the new spelling of a token
    // wins — so the space is on the unchanged side, not the new one.
    expect(parts).toEqual([
      { kind: 'same', text: 'a harbour ' },
      { kind: 'added', text: 'at dawn' },
    ]);
  });
});
