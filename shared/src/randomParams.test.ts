import { describe, expect, it } from 'vitest';

import {
  candidateValues,
  defaultRuleFor,
  drawRandomParams,
  fieldPointValues,
  MAX_CANDIDATES,
  nearestPoint,
  normaliseRandomParams,
  overlayChoices,
  shortLabels,
  usesPointLine,
  variableFields,
  type RandomParamRule,
} from './randomParams.js';
import type { ParamField, ParamSchema } from './paramTypes.js';

function field(partial: Partial<ParamField> & Pick<ParamField, 'id'>): ParamField {
  return {
    nodeId: '3',
    inputName: 'steps',
    classType: 'KSampler',
    nodeTitle: 'KSampler',
    label: 'Steps',
    role: 'steps',
    control: 'int',
    defaultValue: 20,
    group: 'main',
    hidden: false,
    order: 0,
    unknownNodeType: false,
    ...partial,
  } as ParamField;
}

const schemaOf = (fields: ParamField[]): ParamSchema => ({
  fields,
  missingNodeTypes: [],
  nodeCount: fields.length,
});

const rule = (patch: Partial<RandomParamRule> = {}): RandomParamRule => ({
  key: '3.steps',
  label: 'Steps',
  min: 20,
  max: 40,
  step: 5,
  ...patch,
});

describe('candidateValues', () => {
  it('walks the range in steps, inclusive of both ends when they line up', () => {
    expect(candidateValues(rule())).toEqual([20, 25, 30, 35, 40]);
  });

  it('stops before overshooting a range the step does not divide', () => {
    expect(candidateValues(rule({ min: 1, max: 10, step: 4 }))).toEqual([1, 5, 9]);
  });

  /**
   * Naive accumulation walks 7.5 → 8.000000000000002, which then lands in the
   * recorded settings and makes two identical runs look different.
   */
  it('keeps fractional steps exact', () => {
    expect(candidateValues(rule({ min: 6, max: 8, step: 0.5 }))).toEqual([6, 6.5, 7, 7.5, 8]);
    expect(candidateValues(rule({ min: 0, max: 1, step: 0.1 }))).toEqual([
      0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
    ]);
  });

  it('accepts a reversed range rather than producing nothing', () => {
    expect(candidateValues(rule({ min: 40, max: 20, step: 10 }))).toEqual([20, 30, 40]);
  });

  it('falls back to a single value for a step that cannot advance', () => {
    expect(candidateValues(rule({ step: 0 }))).toEqual([20]);
    expect(candidateValues(rule({ step: -1 }))).toEqual([20]);
  });

  it('caps a range that would otherwise produce thousands of values', () => {
    expect(candidateValues(rule({ min: 0, max: 10_000, step: 0.01 }))).toHaveLength(
      MAX_CANDIDATES,
    );
  });
});

describe('normaliseRandomParams', () => {
  it('drops anything that is not a usable rule', () => {
    expect(
      normaliseRandomParams([
        null,
        'nope',
        { key: '', min: 1, max: 2 },
        { key: '3.cfg', min: 'x', max: 2 },
        { key: '3.steps', min: 1, max: 5 },
      ]),
    ).toEqual([{ key: '3.steps', label: '3.steps', min: 1, max: 5, step: 1 }]);
  });

  it('keeps only the first rule for a field', () => {
    // Two rules for one field would fight silently, last-write-wins.
    const rules = normaliseRandomParams([
      { key: '3.steps', min: 1, max: 5, step: 1 },
      { key: '3.steps', min: 90, max: 99, step: 1 },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.max).toBe(5);
  });

  it('orders a reversed range and repairs a nonsense step', () => {
    const rules = normaliseRandomParams([{ key: 'a', min: 9, max: 2, step: -4 }]);
    expect(rules[0]).toMatchObject({ min: 2, max: 9, step: 1 });
  });

  it('ignores a value that is not an array at all', () => {
    expect(normaliseRandomParams({ key: 'a' })).toEqual([]);
    expect(normaliseRandomParams(undefined)).toEqual([]);
  });
});

describe('drawRandomParams', () => {
  const schema = schemaOf([
    field({ id: '3.steps', label: 'Steps', control: 'int', min: 1, max: 100 }),
    field({ id: '3.cfg', label: 'CFG', control: 'float', min: 0, max: 30 }),
  ]);

  it('draws a value that is one of the candidates', () => {
    for (let i = 0; i < 25; i += 1) {
      const drawn = drawRandomParams(schema, [rule()], () => (i * 0.037) % 1);
      expect([20, 25, 30, 35, 40]).toContain(drawn['3.steps']);
    }
  });

  it('draws each rule independently', () => {
    const drawn = drawRandomParams(
      schema,
      [rule(), rule({ key: '3.cfg', label: 'CFG', min: 4, max: 9, step: 1 })],
      () => 0.99,
    );
    expect(drawn['3.steps']).toBe(40);
    expect(drawn['3.cfg']).toBe(9);
  });

  /**
   * A rule outlives the workflow it was made for. Writing `3.steps` into a graph
   * with no node 3 would be rejected by ComfyUI, naming a field the user never
   * touched.
   */
  it('skips a rule whose field the workflow does not have', () => {
    expect(drawRandomParams(schema, [rule({ key: '99.nope' })], () => 0.5)).toEqual({});
  });

  it('never exceeds the limits the node itself declares', () => {
    const tight = schemaOf([field({ id: '3.steps', control: 'int', min: 1, max: 24 })]);
    const drawn = drawRandomParams(tight, [rule({ min: 20, max: 100, step: 10 })], () => 0.99);
    expect(drawn['3.steps']).toBeLessThanOrEqual(24);
  });

  it('keeps an integer field integral even from a fractional rule', () => {
    const drawn = drawRandomParams(schema, [rule({ min: 20, max: 21, step: 0.5 })], () => 0.5);
    expect(Number.isInteger(drawn['3.steps'])).toBe(true);
  });
});

describe('variableFields and defaultRuleFor', () => {
  it('offers only the numeric fields', () => {
    const schema = schemaOf([
      field({ id: 'a', control: 'int' }),
      field({ id: 'b', control: 'float' }),
      field({ id: 'c', control: 'textarea' }),
      field({ id: 'd', control: 'combo' }),
    ]);
    expect(variableFields(schema).map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('starts from the range the slider already uses, with a handful of steps', () => {
    const made = defaultRuleFor(
      field({ id: '3.steps', label: 'Steps', control: 'int', min: 1, max: 10000, softMin: 1, softMax: 60 }),
    );
    expect(made).toMatchObject({ key: '3.steps', min: 1, max: 60 });
    expect(candidateValues(made).length).toBeGreaterThan(2);
    expect(candidateValues(made).length).toBeLessThanOrEqual(12);
  });

  it('gives a float field a fractional step rather than rounding it to 1', () => {
    const made = defaultRuleFor(
      field({ id: '3.denoise', label: 'Denoise', control: 'float', softMin: 0, softMax: 1 }),
    );
    expect(made.step).toBeLessThan(1);
    expect(candidateValues(made).length).toBeGreaterThan(2);
  });
});

describe('point lines', () => {
  it('only applies to numeric fields that asked for it', () => {
    expect(usesPointLine(field({ id: 'a', inputMode: 'points', control: 'int' }))).toBe(true);
    expect(usesPointLine(field({ id: 'a', inputMode: 'points', control: 'float' }))).toBe(true);
    // A combo or a prompt has nothing to put on a number line.
    expect(usesPointLine(field({ id: 'a', inputMode: 'points', control: 'combo' }))).toBe(false);
    expect(usesPointLine(field({ id: 'a', control: 'int' }))).toBe(false);
  });

  it('uses the configured range when there is one', () => {
    const configured = field({ id: 'a', points: { min: 10, max: 30, step: 10 } });
    expect(fieldPointValues(configured)).toEqual([10, 20, 30]);
  });

  /**
   * Switching a field to a point line must immediately produce something usable,
   * not an empty row waiting for three numbers.
   */
  it('falls back to a usable line derived from the field itself', () => {
    const values = fieldPointValues(
      field({ id: 'a', control: 'int', softMin: 1, softMax: 60, min: 1, max: 10000 }),
    );
    expect(values.length).toBeGreaterThan(2);
    expect(values.length).toBeLessThanOrEqual(12);
    expect(values[0]).toBe(1);
  });

  it('finds the nearest point, so a value from elsewhere still reads as selected', () => {
    // A preset, a reused result or a random draw can land between two points.
    expect(nearestPoint([20, 30, 40], 33)).toBe(30);
    expect(nearestPoint([20, 30, 40], 36)).toBe(40);
    expect(nearestPoint([20, 30, 40], 5)).toBe(20);
    expect(nearestPoint([20, 30, 40], 999)).toBe(40);
    expect(nearestPoint([], 10)).toBeNull();
  });
});

describe('shortLabels', () => {
  it('abbreviates to two letters when that is enough', () => {
    expect(shortLabels(['Steps', 'CFG'])).toEqual({ Steps: 'St', CFG: 'Cf' });
  });

  it('leaves labels that already differ at two letters alone', () => {
    // Steps, Seed and Sampler all start "S" but diverge at the second letter.
    expect(shortLabels(['Steps', 'Seed', 'Sampler'])).toEqual({
      Steps: 'St',
      Seed: 'Se',
      Sampler: 'Sa',
    });
  });

  /** "Seed" and "Sequence" are identical for two letters — the reason this exists. */
  it('lengthens only as far as needed to stay distinct', () => {
    const labels = shortLabels(['Seed', 'Sequence', 'Sensitivity']);
    expect(new Set(Object.values(labels)).size).toBe(3);
    expect(labels['Seed']).toBe('Se');
    expect(labels['Sequence']).toBe('Seq');
    expect(labels['Sensitivity']).toBe('Sen');
  });

  it('gives up gracefully rather than looping when a label runs out of letters', () => {
    // "Se" cannot be lengthened; it must still get *some* label.
    const labels = shortLabels(['Seed', 'Se']);
    expect(labels['Seed']).toBe('Se');
    expect(labels['Se']).toBe('Se');
  });

  it('ignores punctuation and copes with a label made only of it', () => {
    expect(shortLabels(['C.F.G'])).toEqual({ 'C.F.G': 'Cf' });
    expect(shortLabels(['···'])).toEqual({ '···': '?' });
  });
});

describe('overlayChoices', () => {
  it('is the union of what the visible runs actually recorded', () => {
    const choices = overlayChoices([
      [{ key: '3.steps', label: 'Steps', value: '20', primary: true }],
      [
        { key: '3.steps', label: 'Steps', value: '30', primary: true },
        { key: '3.cfg', label: 'CFG', value: '8', primary: true },
      ],
    ]);
    expect(choices).toEqual([
      { key: '3.cfg', label: 'CFG' },
      { key: '3.steps', label: 'Steps' },
    ]);
  });

  it('is empty when nothing recorded a summary', () => {
    expect(overlayChoices([[], []])).toEqual([]);
  });
});
