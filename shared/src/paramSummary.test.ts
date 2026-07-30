import { describe, expect, it } from 'vitest';

import { buildParamSummary, primaryParams } from './paramSummary.js';
import type { ParamField, ParamSchema } from './paramTypes.js';

/**
 * The queue screen leans on this to answer one question: "which of these eight
 * jobs is the one I want to cancel?" Everything below is a way that question
 * gets answered wrongly.
 */

function field(partial: Partial<ParamField> & Pick<ParamField, 'id' | 'role'>): ParamField {
  return {
    nodeId: partial.id.split('.')[0] ?? '1',
    inputName: partial.id.split('.')[1] ?? 'value',
    classType: 'KSampler',
    nodeTitle: 'KSampler',
    label: partial.inputName ?? partial.id,
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
  return { fields, missingNodeTypes: [], nodeCount: fields.length };
}

describe('buildParamSummary', () => {
  const schema = schemaOf([
    field({ id: '1.text', role: 'prompt', label: 'Prompt', control: 'textarea' }),
    field({ id: '2.text', role: 'negative_prompt', label: 'Negative', control: 'textarea' }),
    field({ id: '3.steps', role: 'steps', label: 'Steps' }),
    field({ id: '3.cfg', role: 'cfg', label: 'CFG', control: 'float' }),
    field({ id: '3.sampler_name', role: 'sampler', label: 'Sampler', control: 'combo' }),
    field({ id: '3.seed', role: 'seed', label: 'Seed' }),
    field({ id: '9.gizmo', role: 'other', label: 'Gizmo' }),
  ]);

  it('keeps every field except the prompts, which are already the title', () => {
    const summary = buildParamSummary(schema, {
      '1.text': 'a fox',
      '2.text': 'blurry',
      '3.steps': 20,
      '3.cfg': 7.5,
      '3.sampler_name': 'euler',
      '3.seed': 42,
      '9.gizmo': 3,
    });

    expect(summary.map((item) => item.key)).toEqual([
      '3.steps',
      '3.cfg',
      '3.sampler_name',
      '3.seed',
      '9.gizmo',
    ]);
  });

  it('promotes the identifying values and leaves the rest for the detail view', () => {
    const summary = buildParamSummary(schema, { '3.steps': 20, '9.gizmo': 3 });
    expect(primaryParams(summary).map((item) => item.label)).toContain('Steps');
    expect(primaryParams(summary).map((item) => item.label)).not.toContain('Gizmo');
  });

  /**
   * Regression: the seed used to be last in the promotion order and got cut by
   * the cap, which broke the one case the summary exists for — a batch of eight
   * where the seed is the *only* difference.
   */
  it('always promotes the seed, even in a workflow with every other setting', () => {
    const everything = schemaOf(
      (
        [
          'steps',
          'cfg',
          'sampler',
          'scheduler',
          'denoise',
          'width',
          'height',
          'batch_size',
          'model',
          'vae',
          'lora',
          'seed',
        ] as const
      ).map((role, index) => field({ id: `${index}.${role}`, role, label: role, defaultValue: 1 })),
    );

    expect(primaryParams(buildParamSummary(everything, {})).map((item) => item.label)).toContain(
      'seed',
    );
  });

  it('orders the summary by what identifies a job, not by graph order', () => {
    // The schema lists steps before cfg before sampler; a graph written in
    // another order must still produce the same reading order.
    const reordered = schemaOf([
      field({ id: '3.sampler_name', role: 'sampler', label: 'Sampler', control: 'combo' }),
      field({ id: '3.cfg', role: 'cfg', label: 'CFG', control: 'float' }),
      field({ id: '3.steps', role: 'steps', label: 'Steps' }),
    ]);
    const summary = buildParamSummary(reordered, {});
    expect(summary.map((item) => item.label)).toEqual(['Steps', 'CFG', 'Sampler']);
  });

  it('falls back to the default for a value the user never touched', () => {
    const summary = buildParamSummary(
      schemaOf([field({ id: '3.steps', role: 'steps', label: 'Steps', defaultValue: 25 })]),
      {},
    );
    expect(summary[0]).toMatchObject({ label: 'Steps', value: '25' });
  });

  it('renders values the way they read, not the way they are stored', () => {
    const mixed = schemaOf([
      field({ id: '3.cfg', role: 'cfg', label: 'CFG', control: 'float' }),
      field({ id: '4.enabled', role: 'other', label: 'Enabled', control: 'boolean' }),
      field({ id: '5.note', role: 'other', label: 'Note', control: 'text' }),
    ]);

    const summary = buildParamSummary(mixed, {
      // Float noise from a slider must not become a wall of digits.
      '3.cfg': 7.500000000001,
      '4.enabled': true,
      // Newlines would break the one-line layout.
      '5.note': 'first\n  second',
    });

    expect(summary.find((item) => item.key === '3.cfg')?.value).toBe('7.5');
    expect(summary.find((item) => item.key === '4.enabled')?.value).toBe('on');
    expect(summary.find((item) => item.key === '5.note')?.value).toBe('first second');
  });

  it('truncates a long value rather than shipping it once per queue entry', () => {
    const long = 'x'.repeat(500);
    const summary = buildParamSummary(
      schemaOf([field({ id: '5.tags', role: 'other', label: 'Tags', control: 'text' })]),
      { '5.tags': long },
    );
    expect(summary[0]!.value).toHaveLength(80);
    expect(summary[0]!.value.endsWith('…')).toBe(true);
  });

  it('drops empty values instead of listing a blank line', () => {
    const summary = buildParamSummary(
      schemaOf([field({ id: '5.note', role: 'other', label: 'Note', control: 'text' })]),
      { '5.note': '   ' },
    );
    expect(summary).toHaveLength(0);
  });

  it('caps how many values are promoted, so a pathological graph cannot flood the card', () => {
    // Twenty sampler nodes, i.e. twenty of every promotable role.
    const many = schemaOf(
      Array.from({ length: 20 }, (_unused, node) =>
        (['steps', 'cfg', 'sampler', 'seed'] as const).map((role, index) =>
          field({ id: `${node}_${index}.${role}`, role, label: `${role}${node}`, defaultValue: 1 }),
        ),
      ).flat(),
    );

    const summary = buildParamSummary(many, {});
    expect(summary.length).toBe(80);
    expect(primaryParams(summary)).toHaveLength(10);
  });

  it('never promotes a hidden field — it is not on screen to be compared', () => {
    const summary = buildParamSummary(
      schemaOf([field({ id: '3.steps', role: 'steps', label: 'Steps', hidden: true, defaultValue: 20 })]),
      {},
    );
    expect(summary[0]!.primary).toBe(false);
  });
});
