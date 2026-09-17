import { describe, expect, it } from 'vitest';

import { DEDICATED_ROLES, groupByNode, isChip, isSizeable, planFormRuns } from './formRuns.js';
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

/**
 * Advanced, cut into the nodes its settings came from.
 *
 * Thirty inputs in one flat run of chips are thirty unrelated words — and the
 * same word twice, on two different nodes, with nothing on screen saying which
 * is which. The heading is the missing half of the label.
 */
describe('grouping the advanced list by node', () => {
  const shape = (groups: ReturnType<typeof groupByNode>) =>
    groups.map((group) => `${group.title}:${group.fields.map((f) => f.id).join(',')}`);

  it('gathers each node’s fields under one heading', () => {
    expect(
      shape(
        groupByNode([
          field({ id: '1.a', nodeId: '1', nodeTitle: 'Sampler' }),
          field({ id: '2.a', nodeId: '2', nodeTitle: 'Upscaler' }),
          field({ id: '1.b', nodeId: '1', nodeTitle: 'Sampler' }),
        ]),
      ),
    ).toEqual(['Sampler:1.a,1.b', 'Upscaler:2.a']);
  });

  it('orders the groups by where each one first appears', () => {
    /*
     * The arrangement's own order, not the node ids': a field dragged to the
     * top of Advanced takes its node's heading with it, which is the only
     * behaviour that can be explained in a sentence.
     */
    const groups = groupByNode([
      field({ id: '9.a', nodeId: '9', nodeTitle: 'Last' }),
      field({ id: '3.a', nodeId: '3', nodeTitle: 'Middle' }),
      field({ id: '9.b', nodeId: '9', nodeTitle: 'Last' }),
      field({ id: '1.a', nodeId: '1', nodeTitle: 'First' }),
    ]);
    expect(groups.map((group) => group.title)).toEqual(['Last', 'Middle', 'First']);
  });

  it('tells two nodes with the same title apart', () => {
    // Two KSamplers in one graph is normal, and a heading that cannot
    // distinguish them is worse than no heading at all.
    expect(
      shape(
        groupByNode([
          field({ id: '4.steps', nodeId: '4', nodeTitle: 'KSampler' }),
          field({ id: '7.steps', nodeId: '7', nodeTitle: 'KSampler' }),
        ]),
      ),
    ).toEqual(['KSampler #4:4.steps', 'KSampler #7:7.steps']);
  });

  it('leaves a title that does not clash alone', () => {
    // `#7` on every heading in a graph with no clashes would be noise.
    const groups = groupByNode([
      field({ id: '4.steps', nodeId: '4', nodeTitle: 'KSampler' }),
      field({ id: '7.scale', nodeId: '7', nodeTitle: 'Upscaler' }),
    ]);
    expect(groups.map((group) => group.title)).toEqual(['KSampler', 'Upscaler']);
  });

  it('falls back to the class, then the id, for a node with no title', () => {
    expect(
      groupByNode([field({ nodeId: '5', nodeTitle: '', classType: 'KSampler' })])[0]?.title,
    ).toBe('KSampler');
    expect(groupByNode([field({ nodeId: '5', nodeTitle: '', classType: '' })])[0]?.title).toBe('5');
  });

  it('has nothing to say about an empty list', () => {
    expect(groupByNode([])).toEqual([]);
  });
});
