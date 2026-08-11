import { describe, expect, it } from 'vitest';

import { objectInfoFixture } from './fixtures/objectInfo.js';
import { withPresetChat, sd15Txt2Img } from './fixtures/workflows.js';
import { applyParams, buildParamSchema } from './paramSchema.js';
import {
  applyPresetActive,
  applyPresetChat,
  PRESET_PASSTHROUGH,
  presetChatNodeIds,
  resolveActive,
  slotCountOf,
  slotNames,
} from './presetChat.js';
import { applySystemPrompts } from './systemPrompts.js';
import type { ParamField, ParamValues } from './paramTypes.js';

const schema = buildParamSchema(withPresetChat, objectInfoFixture);
const plain = buildParamSchema(sd15Txt2Img, objectInfoFixture);

const NODE = '22';
const field = (id: string, from = schema): ParamField | undefined =>
  from.fields.find((candidate) => candidate.id === id);

describe('presetChatNodeIds', () => {
  it('finds the preset-chat node', () => {
    expect(presetChatNodeIds(schema)).toEqual([NODE]);
  });

  it('is empty for a workflow without one', () => {
    expect(presetChatNodeIds(plain)).toEqual([]);
  });
});

describe('slot names', () => {
  it('reads them from the exported graph when nothing has been typed', () => {
    expect(slotNames(schema, {}, NODE)).toEqual(['Rewrite', 'Caption', 'Preset 3']);
  });

  it('follows what the form holds', () => {
    const values: ParamValues = { [`${NODE}.name_2`]: 'Summarise' };
    expect(slotNames(schema, values, NODE)).toEqual(['Rewrite', 'Summarise', 'Preset 3']);
  });

  it('falls back for a slot renamed to nothing', () => {
    expect(slotNames(schema, { [`${NODE}.name_1`]: '   ' }, NODE)).toEqual([
      'Preset 1',
      'Caption',
      'Preset 3',
    ]);
  });

  it('clamps the count the way the node does', () => {
    expect(slotCountOf(schema, { [`${NODE}.slot_count`]: 0 }, NODE)).toBe(1);
    expect(slotCountOf(schema, { [`${NODE}.slot_count`]: 99 }, NODE)).toBe(6);
    expect(slotCountOf(schema, { [`${NODE}.slot_count`]: 'nonsense' }, NODE)).toBe(1);
  });
});

describe('applyPresetChat', () => {
  it('leaves a workflow without the node untouched', () => {
    expect(applyPresetChat(plain, {})).toBe(plain);
  });

  it('offers the slot names in the picker, passthrough first', () => {
    const shaped = applyPresetChat(schema, {});
    expect(field(`${NODE}.active`, shaped)?.options).toEqual([
      'passthrough',
      'Rewrite',
      'Caption',
      'Preset 3',
    ]);
  });

  it('hides the slots above slot_count', () => {
    const shaped = applyPresetChat(schema, {});
    expect(field(`${NODE}.system_3`, shaped)?.hidden).toBeFalsy();
    expect(field(`${NODE}.name_4`, shaped)?.hidden).toBe(true);
    expect(field(`${NODE}.system_6`, shaped)?.hidden).toBe(true);
  });

  it('reveals more slots when the count goes up', () => {
    const shaped = applyPresetChat(schema, { [`${NODE}.slot_count`]: 5 });
    expect(field(`${NODE}.system_5`, shaped)?.hidden).toBeFalsy();
    expect(field(`${NODE}.system_6`, shaped)?.hidden).toBe(true);
    expect(field(`${NODE}.active`, shaped)?.options).toHaveLength(6);
  });

  it('labels each system prompt with its slot name', () => {
    const shaped = applyPresetChat(schema, {});
    expect(field(`${NODE}.system_1`, shaped)?.label).toBe('Rewrite');
    expect(field(`${NODE}.system_2`, shaped)?.label).toBe('Caption');
    // Never renamed, so it keeps the label derived from the input name.
    expect(field(`${NODE}.system_3`, shaped)?.label).toBe('Preset 3');
  });

  it('keeps a label the form editor set', () => {
    const renamed = {
      ...schema,
      fields: schema.fields.map((candidate) =>
        candidate.id === `${NODE}.system_1` ? { ...candidate, label: 'House style' } : candidate,
      ),
    };
    expect(field(`${NODE}.system_1`, applyPresetChat(renamed, {}))?.label).toBe('House style');
  });

  it('lets a saved system prompt reach the slot named after it', () => {
    const shaped = applyPresetChat(schema, {});
    const filled = applySystemPrompts(shaped, {}, [
      { id: 'p1', name: 'Caption', text: 'One sentence, no adjectives.', createdAt: 0 },
    ]);
    expect(filled[`${NODE}.system_2`]).toBe('One sentence, no adjectives.');
    expect(filled[`${NODE}.system_1`]).toBeUndefined();
  });
});

describe('resolveActive', () => {
  it('keeps a name that is still in use', () => {
    expect(resolveActive(schema, {}, NODE, 'Caption')).toBe('Caption');
  });

  it('matches without regard to case or padding', () => {
    expect(resolveActive(schema, {}, NODE, '  rewrite ')).toBe('Rewrite');
  });

  it('reads a trailing number as the slot at that position', () => {
    expect(resolveActive(schema, {}, NODE, 'Preset 2')).toBe('Caption');
  });

  it('falls back to passthrough for a name nobody has', () => {
    expect(resolveActive(schema, {}, NODE, 'Translate')).toBe(PRESET_PASSTHROUGH);
  });

  it('falls back when the slot has been put out of reach', () => {
    const values = { [`${NODE}.slot_count`]: 1 };
    expect(resolveActive(schema, values, NODE, 'Caption')).toBe(PRESET_PASSTHROUGH);
  });

  it('treats the node’s own aliases as passthrough', () => {
    for (const alias of ['', 'none', 'OFF', 'bypass', 'direct']) {
      expect(resolveActive(schema, {}, NODE, alias)).toBe(PRESET_PASSTHROUGH);
    }
  });
});

describe('applyPresetActive', () => {
  it('returns the same values when there is nothing to settle', () => {
    const values = { [`${NODE}.active`]: 'Rewrite' };
    expect(applyPresetActive(schema, values)).toBe(values);
  });

  it('returns the same object for a workflow without the node', () => {
    const values = { '3.steps': 20 };
    expect(applyPresetActive(plain, values)).toBe(values);
  });

  it('settles a picker left on a renamed slot', () => {
    const values: ParamValues = { [`${NODE}.name_1`]: 'Expand', [`${NODE}.active`]: 'Rewrite' };
    // "Rewrite" is gone, but it was slot 1 and the trailing-number rule does not
    // apply, so the safe answer is the one that always runs.
    expect(applyPresetActive(schema, values)[`${NODE}.active`]).toBe(PRESET_PASSTHROUGH);
  });

  it('settles a picker left above a shrunken slot_count', () => {
    const values: ParamValues = { [`${NODE}.slot_count`]: 1, [`${NODE}.active`]: 'Caption' };
    expect(applyPresetActive(schema, values)[`${NODE}.active`]).toBe(PRESET_PASSTHROUGH);
  });

  it('leaves everything else alone', () => {
    const values: ParamValues = { [`${NODE}.slot_count`]: 1, [`${NODE}.active`]: 'Caption' };
    expect(applyPresetActive(schema, values)[`${NODE}.slot_count`]).toBe(1);
  });
});

describe('the aspect-ratio latent', () => {
  it('offers the ratios as a picker', () => {
    const ratio = field('5.aspect_ratio');
    expect(ratio?.control).toBe('combo');
    expect(ratio?.role).toBe('aspect_ratio');
    expect(ratio?.options).toContain('16:9');
  });

  it('keeps a combo of numbers as a picker rather than a text box', () => {
    const divisible = field('5.divisible_by');
    expect(divisible?.control).toBe('combo');
    expect(divisible?.options).toEqual(['8', '16', '32', '64']);
    expect(divisible?.numericOptions).toBe(true);
  });

  it('submits the number the node declared, not its text', () => {
    const { workflow } = applyParams(
      withPresetChat,
      schema,
      { '5.divisible_by': '32', '5.aspect_ratio': '16:9' },
      { randomizeSeeds: false, lockedSeedFields: [] },
    );
    expect(workflow['5']!.inputs.divisible_by).toBe(32);
    expect(workflow['5']!.inputs.aspect_ratio).toBe('16:9');
  });

  it('falls back to the graph’s own value for a choice that is not a number', () => {
    const { workflow } = applyParams(
      withPresetChat,
      schema,
      { '5.divisible_by': 'auto' },
      { randomizeSeeds: false, lockedSeedFields: [] },
    );
    expect(workflow['5']!.inputs.divisible_by).toBe(64);
  });

  it('gives megapixels a slider people can aim with', () => {
    const megapixels = field('5.megapixels');
    expect(megapixels?.softMin).toBe(0.25);
    expect(megapixels?.softMax).toBe(4);
  });
});
