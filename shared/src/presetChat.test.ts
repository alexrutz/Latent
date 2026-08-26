import { describe, expect, it } from 'vitest';

import { objectInfoFixture } from './fixtures/objectInfo.js';
import { withLlamaServer, withPresetChat, sd15Txt2Img } from './fixtures/workflows.js';
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

  it('hides the per-slot model box with the rest of its slot', () => {
    /*
     * `model_N` arrived with router mode: each slot can name the model it wants
     * from a server serving several. It hides with its slot, the way the node's
     * own extension hides it.
     */
    const shaped = applyPresetChat(schema, {});
    expect(field(`${NODE}.model_3`, shaped)?.hidden).toBeFalsy();
    expect(field(`${NODE}.model_4`, shaped)?.hidden).toBe(true);
    expect(field(`${NODE}.model_6`, shaped)?.hidden).toBe(true);
  });

  it('leaves the model box out of the slot naming', () => {
    /*
     * It is a text field, so labelling it with the slot's name would hand it to
     * the system-prompt matching — and a prompt called "Rewrite" would be
     * written into that slot's *model* box rather than its instructions.
     */
    const shaped = applyPresetChat(schema, {});
    expect(field(`${NODE}.model_1`, shaped)?.label).not.toBe('Rewrite');

    const filled = applySystemPrompts(shaped, {}, [
      { id: 'p1', name: 'Rewrite', text: 'One vivid paragraph.', createdAt: 0 },
    ]);
    expect(filled[`${NODE}.system_1`]).toBe('One vivid paragraph.');
    expect(filled[`${NODE}.model_1`]).toBeUndefined();
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

describe('the image controls every chat node now carries', () => {
  /*
   * comfyllama gave each chat node an optional `image` with a size and a
   * quality beside it. The two knobs are widgets, so an "export (API)" writes
   * them out whether or not a picture is wired in — and on a text-only chat
   * node they are two settings that cannot change anything.
   */
  /** The same node with something wired to `image`, and the switch as given. */
  const wiredTo = (useImage: boolean) =>
    buildParamSchema(
      {
        ...withPresetChat,
        '22': {
          ...withPresetChat['22']!,
          inputs: { ...withPresetChat['22']!.inputs, image: ['9', 0], use_image: useImage },
        },
      },
      objectInfoFixture,
    );

  it('hides them when no picture is connected', () => {
    expect(field('22.image_max_size')?.hidden).toBe(true);
    expect(field('22.image_quality')?.hidden).toBe(true);
    // The switch too: it switches off a picture that was never coming.
    expect(field('22.use_image')?.hidden).toBe(true);
  });

  it('shows them as soon as one is', () => {
    const wired = wiredTo(true);
    expect(field('22.image_max_size', wired)?.hidden).toBe(false);
    expect(field('22.image_quality', wired)?.hidden).toBe(false);
    expect(field('22.use_image', wired)?.hidden).toBe(false);
  });

  /*
   * The switch is the point of contact between the two halves of this repo:
   * comfyllama can ignore a connected image, and the form has to say so rather
   * than offering an encoding setting for a picture that is not being sent.
   */
  it('drops the encoding controls again when the picture is switched off', () => {
    const off = wiredTo(false);
    expect(field('22.image_max_size', off)?.hidden).toBe(true);
    expect(field('22.image_quality', off)?.hidden).toBe(true);
  });

  it('keeps the switch itself, because it is what turns the picture back on', () => {
    expect(field('22.use_image', wiredTo(false))?.hidden).toBe(false);
  });
});

/**
 * Two ways to the same three numbers, and a form that shows one of them.
 *
 * The Sampler Settings node sets temperature, top_p and top_k either one at a
 * time or all at once from an `intensity` slider. In ComfyUI a web extension
 * keeps the halves in step live; there is none here, and the node is quite
 * clear about which half is deciding, so the form follows that rather than
 * offering both and letting one of them do nothing.
 */
describe('the sampler node’s two ways of setting the same values', () => {
  /** The node with the slider on or off, everything else as exported. */
  const withSlider = (on: boolean) =>
    buildParamSchema(
      {
        ...withPresetChat,
        '23': {
          ...withPresetChat['23']!,
          inputs: { ...withPresetChat['23']!.inputs, use_intensity: on },
        },
      },
      objectInfoFixture,
    );

  it('hides the slider and its ranges while the values are set one by one', () => {
    const off = withSlider(false);
    expect(field('23.intensity', off)?.hidden).toBe(true);
    expect(field('23.temperature_min', off)?.hidden).toBe(true);
    expect(field('23.top_k_max', off)?.hidden).toBe(true);
    // And the three values are the whole story, so they stay.
    expect(field('23.temperature', off)?.hidden).toBe(false);
    expect(field('23.top_k', off)?.hidden).toBe(false);
  });

  it('hides the three values while the slider is deciding them', () => {
    const on = withSlider(true);
    expect(field('23.temperature', on)?.hidden).toBe(true);
    expect(field('23.top_p', on)?.hidden).toBe(true);
    expect(field('23.top_k', on)?.hidden).toBe(true);
    // Their switches with them: the node forces those on, so they are not
    // choices anybody is making.
    expect(field('23.use_temperature', on)?.hidden).toBe(true);
    expect(field('23.use_top_k', on)?.hidden).toBe(true);
  });

  it('shows the slider and its ranges instead', () => {
    const on = withSlider(true);
    expect(field('23.intensity', on)?.hidden).toBe(false);
    expect(field('23.temperature_min', on)?.hidden).toBe(false);
    expect(field('23.temperature_max', on)?.hidden).toBe(false);
    expect(field('23.top_p_min', on)?.hidden).toBe(false);
    expect(field('23.top_k_max', on)?.hidden).toBe(false);
  });

  it('never hides the switch that moves between the two', () => {
    expect(field('23.use_intensity', withSlider(true))?.hidden).toBe(false);
    expect(field('23.use_intensity', withSlider(false))?.hidden).toBe(false);
  });

  it('leaves every other sampler setting alone either way', () => {
    for (const on of [true, false]) {
      const schema = withSlider(on);
      expect(field('23.repeat_penalty', schema)?.hidden).toBe(false);
      expect(field('23.use_mirostat', schema)?.hidden).toBe(false);
      expect(field('23.stop_sequences', schema)?.hidden).toBe(false);
    }
  });

  /*
   * The rule is about this node, not about the names. `temperature` and
   * `top_p` are on every generation node too, where nothing hides them.
   */
  it('does not reach into the chat nodes that share those input names', () => {
    const chat = buildParamSchema(
      {
        ...withLlamaServer,
        '21': {
          ...withLlamaServer['21']!,
          // A generation node has its own temperature and top_p, and its own
          // `intensity` would mean nothing — there is no slider on it.
          inputs: { ...withLlamaServer['21']!.inputs, temperature: 0.7, top_p: 0.95 },
        },
      },
      objectInfoFixture,
    );

    const shared = chat.fields.filter((entry) => ['temperature', 'top_p'].includes(entry.inputName));
    expect(shared).toHaveLength(2);
    for (const entry of shared) expect(entry.hidden).not.toBe(true);
  });
});
