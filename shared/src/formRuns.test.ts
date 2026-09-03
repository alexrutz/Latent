import { describe, expect, it } from 'vitest';

import { DEDICATED_ROLES, isChip, isSizeable, planFormRuns } from './formRuns.js';
import type { ParamField, ParamRole } from './paramTypes.js';

/**
 * How the form falls into rows.
 *
 * The generate screen draws this and the editor previews it, so every rule here
 * is one both of them obey. A preview that is almost right is worse than none —
 * the whole reason to look at it is to avoid picking the phone up.
 */

function field(overrides: Partial<ParamField> = {}): ParamField {
  return {
    id: overrides.id ?? '1.value',
    nodeId: '1',
    inputName: 'value',
    classType: 'Thing',
    nodeTitle: 'Thing',
    label: 'Value',
    role: 'other',
    control: 'int',
    defaultValue: 0,
    group: 'main',
    order: 0,
    ...overrides,
  } as ParamField;
}

const names = (runs: ReturnType<typeof planFormRuns>) =>
  runs.map((run) => `${run.kind}:${run.fields.map((f) => f.id).join(',')}`);

describe('which fields are chips', () => {
  it('treats an ordinary number or dropdown as one', () => {
    expect(isChip(field({ control: 'int' }))).toBe(true);
    expect(isChip(field({ control: 'combo' }))).toBe(true);
    expect(isChip(field({ control: 'boolean' }))).toBe(true);
  });

  it('gives the roles with a control of their own the whole row', () => {
    for (const role of DEDICATED_ROLES) {
      expect(isChip(field({ role }))).toBe(false);
    }
  });

  it('counts the folder browser among them', () => {
    /*
     * It draws the same control as an uploaded picture — an 80px preview with
     * two buttons beside it — so it needs the same whole row. Left out, it was
     * squeezed into half a row next to a number.
     */
    expect(DEDICATED_ROLES.has('folder_image')).toBe(true);
    expect(isChip(field({ role: 'folder_image', control: 'folderImage' }))).toBe(false);
  });

  it('gives a point line its own row whatever its role', () => {
    expect(isChip(field({ inputMode: 'points', control: 'int' }))).toBe(false);
    // But only when the control is actually numeric.
    expect(isChip(field({ inputMode: 'points', control: 'combo' }))).toBe(true);
  });
});

describe('gathering fields into rows', () => {
  it('puts a run of chips in one grid', () => {
    const runs = planFormRuns([field({ id: 'a' }), field({ id: 'b' }), field({ id: 'c' })]);
    expect(names(runs)).toEqual(['chips:a,b,c']);
  });

  it('breaks the run where a full-width field falls', () => {
    // Which is what preserves a dragged order: a prompt dropped into the middle
    // of four numbers splits them, rather than floating to the end.
    const runs = planFormRuns([
      field({ id: 'a' }),
      field({ id: 'p', role: 'prompt', control: 'textarea' }),
      field({ id: 'b' }),
      field({ id: 'c' }),
    ]);
    expect(names(runs)).toEqual(['chips:a', 'block:p', 'chips:b,c']);
  });

  it('never merges two full-width fields', () => {
    const runs = planFormRuns([
      field({ id: 'p', role: 'prompt' }),
      field({ id: 'n', role: 'negative_prompt' }),
    ]);
    expect(names(runs)).toEqual(['block:p', 'block:n']);
  });

  it('has nothing to say about an empty form', () => {
    expect(planFormRuns([])).toEqual([]);
  });
});

describe('which fields may choose their width', () => {
  it('offers it to a chip', () => {
    expect(isSizeable(field({ control: 'int' }))).toBe(true);
    expect(isSizeable(field({ control: 'combo' }))).toBe(true);
  });

  it('withholds it from anything that always takes the whole row', () => {
    // A switch that cannot change the outcome is worse than an absent one: it
    // invites the belief that it was tried and ignored.
    for (const role of DEDICATED_ROLES) {
      expect(isSizeable(field({ role }))).toBe(false);
    }
    for (const control of ['textarea', 'text', 'image', 'folderImage'] as const) {
      expect(isSizeable(field({ control }))).toBe(false);
    }
  });

  it('withholds it from the folder browser both ways round', () => {
    expect(isSizeable(field({ role: 'folder_image' as ParamRole }))).toBe(false);
    expect(isSizeable(field({ control: 'folderImage' }))).toBe(false);
  });
});
