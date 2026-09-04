import { describe, expect, it } from 'vitest';

import {
  applyArrangement,
  clearOwnOrder,
  hasOwnOrder,
  patchArranged,
  placeField,
  poolFields,
  reorderArrangement,
  unplaceField,
  type FieldArrangement,
} from './fieldArrangement.js';
import { applyOverrides } from './paramSchema.js';
import { planFormRuns } from './formRuns.js';
import type { ParamField, ParamSchema } from './paramTypes.js';

/** A field with only what the arrangement and the layout actually read. */
function field(partial: Partial<ParamField> & { inputName: string }): ParamField {
  const nodeId = partial.nodeId ?? '1';
  return {
    id: `${nodeId}.${partial.inputName}`,
    nodeId,
    inputName: partial.inputName,
    classType: 'KSampler',
    nodeTitle: 'Sampler',
    label: partial.inputName,
    role: 'other',
    control: 'int',
    defaultValue: 0,
    group: 'main',
    hidden: false,
    order: 0,
    unknownNodeType: false,
    ...partial,
  } as ParamField;
}

function schemaOf(fields: ParamField[]): ParamSchema {
  return {
    version: 1,
    fields: fields.map((entry, index) => ({ ...entry, order: entry.order || index })),
    outputNodeIds: ['9'],
    capabilities: { img2img: false, seeded: false, video: false, audio: false },
    missingNodeTypes: [],
  };
}

const names = (schema: ParamSchema) => schema.fields.map((entry) => entry.inputName);

describe('applying the general arrangement', () => {
  it('copies the attributes onto every field of that name', () => {
    const schema = schemaOf([
      field({ inputName: 'duration', nodeId: '3' }),
      field({ inputName: 'duration', nodeId: '7' }),
      field({ inputName: 'steps', nodeId: '3' }),
    ]);

    const arranged = applyArrangement(schema, [
      { name: 'duration', group: 'advanced', width: 'half', label: 'Length' },
    ]);

    const durations = arranged.fields.filter((entry) => entry.inputName === 'duration');
    expect(durations).toHaveLength(2);
    for (const entry of durations) {
      expect(entry.group).toBe('advanced');
      expect(entry.width).toBe('half');
      expect(entry.label).toBe('Length');
    }
    // And says nothing about the field it does not name.
    expect(arranged.fields.find((entry) => entry.inputName === 'steps')?.group).toBe('main');
  });

  it('orders the named fields, and leaves the rest behind them', () => {
    const schema = schemaOf([
      field({ inputName: 'seed' }),
      field({ inputName: 'steps' }),
      field({ inputName: 'cfg' }),
      field({ inputName: 'denoise' }),
    ]);

    expect(names(applyArrangement(schema, [{ name: 'cfg' }, { name: 'steps' }]))).toEqual([
      'cfg',
      'steps',
      'seed',
      'denoise',
    ]);
  });

  it('is a set of opinions, not a template: absent fields are simply absent', () => {
    const schema = schemaOf([field({ inputName: 'steps' }), field({ inputName: 'cfg' })]);
    const arrangement: FieldArrangement = [
      { name: 'duration' },
      { name: 'cfg' },
      { name: 'fps' },
      { name: 'steps' },
    ];

    expect(names(applyArrangement(schema, arrangement))).toEqual(['cfg', 'steps']);
  });

  it('keeps the groups apart, whatever order it is given', () => {
    const schema = schemaOf([
      field({ inputName: 'steps', group: 'advanced' }),
      field({ inputName: 'cfg', group: 'main' }),
    ]);

    const arranged = applyArrangement(schema, [{ name: 'steps' }, { name: 'cfg' }]);
    expect(names(arranged)).toEqual(['cfg', 'steps']);
    // Renumbered from zero within each group, which is the number line the
    // per-workflow overrides are written on.
    expect(arranged.fields.map((entry) => entry.order)).toEqual([0, 0]);
  });

  it('does nothing at all when there is no arrangement', () => {
    const schema = schemaOf([field({ inputName: 'steps' }), field({ inputName: 'cfg' })]);
    expect(applyArrangement(schema, [])).toBe(schema);
  });

  /*
   * The precedence the whole feature rests on. Anything set by hand for one
   * workflow has to survive a general opinion about the same field, or every
   * arrangement is a quiet way of undoing somebody's careful work.
   */
  it('yields to a workflow that has its own opinion', () => {
    const schema = schemaOf([field({ inputName: 'duration', nodeId: '3' })]);
    const arrangement: FieldArrangement = [{ name: 'duration', group: 'advanced', width: 'half' }];

    const both = applyOverrides(applyArrangement(schema, arrangement), {
      '3.duration': { group: 'main' },
    });

    const duration = both.fields[0]!;
    expect(duration.group).toBe('main'); // the workflow's own
    expect(duration.width).toBe('half'); // still the arrangement's
  });

  it('turns off img2img when the arrangement hides every image input', () => {
    const schema = schemaOf([field({ inputName: 'image', role: 'image_input' })]);
    expect(applyArrangement(schema, [{ name: 'image' }]).capabilities.img2img).toBe(true);
    expect(applyArrangement(schema, [{ name: 'image', hidden: true }]).capabilities.img2img).toBe(
      false,
    );
  });
});

/**
 * The gap-closing half of it.
 *
 * An arrangement written against every workflow will always be missing pieces
 * in any one of them. What must not happen is a hole where the absent field
 * would have been.
 */
describe('a workflow missing half of a pair', () => {
  const halves = (inputNames: string[]) =>
    schemaOf(inputNames.map((name) => field({ inputName: name, width: 'half' })));

  it('closes the gap rather than leaving one', () => {
    const arrangement: FieldArrangement = [
      { name: 'steps' },
      { name: 'duration' },
      { name: 'cfg' },
      { name: 'fps' },
    ];

    // A workflow with all four: two rows of two.
    const all = applyArrangement(halves(['steps', 'duration', 'cfg', 'fps']), arrangement);
    expect(planFormRuns(all.fields).map((run) => run.fields.length)).toEqual([4]);

    // One without the video fields still packs, rather than leaving the gaps
    // where `duration` and `fps` would have been.
    const some = applyArrangement(halves(['steps', 'cfg']), arrangement);
    expect(names(some)).toEqual(['steps', 'cfg']);
    const runs = planFormRuns(some.fields);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe('chips');
    expect(runs[0]!.fields.map((entry) => entry.inputName)).toEqual(['steps', 'cfg']);
  });
});

describe('the pool of every field in use', () => {
  it('counts workflows, not fields, and puts the widespread ones first', () => {
    const pool = poolFields([
      schemaOf([
        field({ inputName: 'steps', nodeId: '3', label: 'Steps' }),
        field({ inputName: 'steps', nodeId: '4', label: 'Steps' }),
        field({ inputName: 'duration', label: 'Duration', classType: 'WanVideo' }),
      ]),
      schemaOf([field({ inputName: 'steps', label: 'Steps' })]),
    ]);

    expect(pool.map((entry) => [entry.name, entry.workflows])).toEqual([
      ['steps', 2],
      ['duration', 1],
    ]);
    expect(pool[1]?.classes).toEqual(['WanVideo']);
  });

  /*
   * Which fields can be asked "slider or points". Every one of them has to be
   * a number, not just one: a name used for a number here and a string there
   * gets no input-mode choice, because an answer applying to both would be an
   * answer to a question one of them cannot be asked.
   */
  it('marks a field numeric only when every workflow agrees it is', () => {
    const pool = poolFields([
      schemaOf([
        field({ inputName: 'steps', control: 'int' }),
        field({ inputName: 'cfg', control: 'float' }),
        field({ inputName: 'sampler', control: 'combo' }),
      ]),
      schemaOf([
        field({ inputName: 'steps', control: 'int' }),
        // The same name, holding text in this one.
        field({ inputName: 'cfg', control: 'text' }),
      ]),
    ]);

    const numeric = Object.fromEntries(pool.map((entry) => [entry.name, entry.numeric]));
    expect(numeric).toEqual({ steps: true, cfg: false, sampler: false });
  });

  it('names a field by the label most of them derive for it', () => {
    const pool = poolFields([
      schemaOf([field({ inputName: 'cfg', label: 'CFG' })]),
      schemaOf([field({ inputName: 'cfg', label: 'CFG' })]),
      schemaOf([field({ inputName: 'cfg', label: 'Guidance' })]),
    ]);
    expect(pool[0]?.label).toBe('CFG');
  });
});

describe('editing the arrangement', () => {
  it('places a field once, however many times it is asked', () => {
    const once = placeField([], 'steps');
    expect(placeField(once, 'steps')).toBe(once);
    expect(once).toEqual([{ name: 'steps' }]);
  });

  it('takes one out again', () => {
    expect(unplaceField([{ name: 'steps' }, { name: 'cfg' }], 'steps')).toEqual([{ name: 'cfg' }]);
  });

  it('patches attributes without moving anything', () => {
    const before: FieldArrangement = [{ name: 'steps' }, { name: 'cfg' }];
    const after = patchArranged(before, 'cfg', { width: 'half' });
    expect(after.map((entry) => entry.name)).toEqual(['steps', 'cfg']);
    expect(after[1]).toEqual({ name: 'cfg', width: 'half' });
  });

  it('reorders without losing what the caller did not mention', () => {
    const before: FieldArrangement = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(reorderArrangement(before, ['c', 'a']).map((entry) => entry.name)).toEqual([
      'c',
      'a',
      'b',
    ]);
    // A name it does not hold is not invented.
    expect(reorderArrangement(before, ['z']).map((entry) => entry.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('a workflow that has its own order', () => {
  it('is recognised, and can be handed back to the arrangement', () => {
    expect(hasOwnOrder({})).toBe(false);
    expect(hasOwnOrder({ '3.steps': { hidden: true } })).toBe(false);
    expect(hasOwnOrder({ '3.steps': { order: 2 } })).toBe(true);

    expect(
      clearOwnOrder({
        '3.steps': { order: 2 },
        '3.cfg': { order: 1, label: 'Guidance' },
      }),
    ).toEqual({ '3.cfg': { label: 'Guidance' } });
  });
});
