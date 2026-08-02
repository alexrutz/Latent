import { describe, expect, it } from 'vitest';

import {
  applyOverrides,
  applyParams,
  assertApiWorkflow,
  buildParamSchema,
  defaultValues,
  findFieldByRole,
  isNodeLink,
  WorkflowFormatError,
} from './paramSchema.js';
import { objectInfoFixture } from './fixtures/objectInfo.js';
import {
  combinedConditioning,
  img2img,
  sd15Txt2Img,
  sdxlBaseRefiner,
  uiFormatWorkflow,
  unknownCustomNodes,
  upscale,
} from './fixtures/workflows.js';
import type { ParamField, ParamRole } from './paramTypes.js';

const build = (wf: Parameters<typeof buildParamSchema>[0]) =>
  buildParamSchema(wf, objectInfoFixture);

const byRole = (fields: ParamField[], role: ParamRole) => fields.filter((f) => f.role === role);
const byId = (fields: ParamField[], id: string) => fields.find((f) => f.id === id);

describe('isNodeLink', () => {
  it('recognises link tuples and rejects look-alikes', () => {
    expect(isNodeLink(['4', 0])).toBe(true);
    expect(isNodeLink([4, 1])).toBe(true);
    expect(isNodeLink(['a', 'b'])).toBe(false);
    expect(isNodeLink([1, 2, 3])).toBe(false);
    expect(isNodeLink('4,0')).toBe(false);
    expect(isNodeLink(null)).toBe(false);
  });
});

describe('assertApiWorkflow', () => {
  it('accepts an API-format workflow', () => {
    expect(Object.keys(assertApiWorkflow(sd15Txt2Img))).toContain('3');
  });

  it('tells the user exactly what to do when given a UI-format export', () => {
    expect(() => assertApiWorkflow(uiFormatWorkflow)).toThrow(WorkflowFormatError);
    expect(() => assertApiWorkflow(uiFormatWorkflow)).toThrow(/Export \(API\)/);
  });

  it('unwraps a graph nested under `prompt`', () => {
    const unwrapped = assertApiWorkflow({ prompt: sd15Txt2Img });
    expect(unwrapped['3']?.class_type).toBe('KSampler');
  });

  it('rejects non-objects, empty graphs and nodes without class_type', () => {
    expect(() => assertApiWorkflow(null)).toThrow(WorkflowFormatError);
    expect(() => assertApiWorkflow([1, 2])).toThrow(WorkflowFormatError);
    expect(() => assertApiWorkflow({})).toThrow(/empty/);
    expect(() => assertApiWorkflow({ '1': { inputs: {} } })).toThrow(/class_type/);
  });
});

describe('buildParamSchema — SD1.5 txt2img', () => {
  const schema = build(sd15Txt2Img);

  it('never offers a linked input as an editable field', () => {
    expect(byId(schema.fields, '3.model')).toBeUndefined();
    expect(byId(schema.fields, '3.positive')).toBeUndefined();
    expect(byId(schema.fields, '8.samples')).toBeUndefined();
  });

  it('separates the positive prompt from the negative by which sampler input it feeds', () => {
    const positive = byRole(schema.fields, 'prompt');
    const negative = byRole(schema.fields, 'negative_prompt');
    expect(positive.map((f) => f.id)).toEqual(['6.text']);
    expect(negative.map((f) => f.id)).toEqual(['7.text']);
    expect(positive[0]?.defaultValue).toBe('beautiful scenery nature glass bottle landscape');
    expect(negative[0]?.defaultValue).toBe('text, watermark');
  });

  it('renders multiline STRING inputs as textareas', () => {
    expect(byId(schema.fields, '6.text')?.control).toBe('textarea');
    expect(byId(schema.fields, '6.text')?.multiline).toBe(true);
  });

  it('types numbers from object_info, including min/max/step', () => {
    const steps = byId(schema.fields, '3.steps');
    expect(steps).toMatchObject({ control: 'int', min: 1, max: 10000, role: 'steps' });

    const cfg = byId(schema.fields, '3.cfg');
    expect(cfg).toMatchObject({ control: 'float', min: 0, max: 100, step: 0.1, role: 'cfg' });
  });

  it('turns combos into dropdowns and picks up the installed model list', () => {
    const sampler = byId(schema.fields, '3.sampler_name');
    expect(sampler?.control).toBe('combo');
    expect(sampler?.options).toContain('dpmpp_2m');

    const ckpt = byId(schema.fields, '4.ckpt_name');
    expect(ckpt?.role).toBe('model');
    expect(ckpt?.control).toBe('combo');
    expect(ckpt?.options).toContain('sd_xl_base_1.0.safetensors');
  });

  it('clamps seed ranges that exceed JS safe integers', () => {
    const seed = byId(schema.fields, '3.seed');
    expect(seed?.role).toBe('seed');
    expect(seed?.max).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('puts recognised roles on the main screen in a fixed order', () => {
    const main = schema.fields.filter((f) => f.group === 'main').map((f) => f.role);
    expect(main).toEqual([
      'prompt',
      'negative_prompt',
      'model',
      'width',
      'height',
      'batch_size',
      'steps',
      'cfg',
      'sampler',
      'scheduler',
      'denoise',
      'seed',
    ]);
  });

  it('keeps unrecognised inputs rather than dropping them', () => {
    const prefix = byId(schema.fields, '9.filename_prefix');
    expect(prefix).toMatchObject({ group: 'advanced', role: 'other', control: 'text' });
  });

  it('finds the output node and reports capabilities', () => {
    expect(schema.outputNodeIds).toEqual(['9']);
    expect(schema.capabilities).toEqual({ img2img: false, seeded: true });
    expect(schema.missingNodeTypes).toEqual([]);
  });
});

describe('buildParamSchema — SDXL base + refiner', () => {
  const schema = build(sdxlBaseRefiner);

  it('disambiguates duplicate labels using the node title', () => {
    const stepFields = schema.fields.filter((f) => f.inputName === 'steps');
    expect(stepFields).toHaveLength(2);
    expect(stepFields.map((f) => f.label).sort()).toEqual([
      'Steps · Base sampler',
      'Steps · Refiner sampler',
    ]);
  });

  it('treats noise_seed as a seed', () => {
    expect(byId(schema.fields, '10.noise_seed')?.role).toBe('seed');
    expect(byId(schema.fields, '11.noise_seed')?.role).toBe('seed');
  });

  it('classifies both samplers\' prompts', () => {
    expect(byRole(schema.fields, 'prompt').map((f) => f.id).sort()).toEqual(['15.text', '6.text']);
    expect(byRole(schema.fields, 'negative_prompt').map((f) => f.id).sort()).toEqual([
      '16.text',
      '7.text',
    ]);
  });
});

describe('buildParamSchema — img2img and upscale', () => {
  it('detects the image input and flags the workflow img2img-capable', () => {
    const schema = build(img2img);
    const image = findFieldByRole(schema, 'image_input');
    expect(image).toMatchObject({ id: '1.image', control: 'image' });
    expect(schema.capabilities.img2img).toBe(true);
  });

  it('handles a prompt-free, sampler-free upscale graph', () => {
    const schema = build(upscale);
    expect(byRole(schema.fields, 'prompt')).toHaveLength(0);
    expect(schema.capabilities).toEqual({ img2img: true, seeded: false });
    expect(byId(schema.fields, '2.model_name')?.role).toBe('model');
    expect(schema.outputNodeIds).toEqual(['4']);
  });
});

describe('buildParamSchema — prompts behind ConditioningCombine', () => {
  it('walks backwards through conditioning nodes to find both prompt texts', () => {
    const schema = build(combinedConditioning);
    expect(byRole(schema.fields, 'prompt').map((f) => f.id).sort()).toEqual(['2.text', '3.text']);
    expect(byRole(schema.fields, 'negative_prompt').map((f) => f.id)).toEqual(['5.text']);
  });
});

describe('buildParamSchema — unknown custom nodes', () => {
  const schema = build(unknownCustomNodes);

  it('reports which node types it could not resolve', () => {
    expect(schema.missingNodeTypes).toEqual(['SuperSecretSamplerXL']);
  });

  it('still exposes every input, typed from the literal value', () => {
    expect(byId(schema.fields, '1.iterations')).toMatchObject({
      control: 'int',
      unknownNodeType: true,
    });
    expect(byId(schema.fields, '1.magic_strength')?.control).toBe('float');
    expect(byId(schema.fields, '1.mode')?.control).toBe('text');
    expect(byId(schema.fields, '1.enabled')?.control).toBe('boolean');
  });

  it('still recognises roles by input name', () => {
    expect(byId(schema.fields, '1.seed')?.role).toBe('seed');
    expect(schema.capabilities.seeded).toBe(true);
  });

  it('marks known nodes in the same graph as known', () => {
    expect(byId(schema.fields, '2.ckpt_name')?.unknownNodeType).toBe(false);
  });
});

describe('soft slider ranges', () => {
  const schema = build(sd15Txt2Img);

  /**
   * The reason this exists: object_info says steps go to 10000, so a slider
   * spanning it moves ~40 steps per pixel on a phone and cannot select 25.
   */
  it('narrows steps and cfg to the range people actually work in', () => {
    expect(byId(schema.fields, '3.steps')).toMatchObject({ min: 1, max: 10000, softMin: 1, softMax: 60 });
    expect(byId(schema.fields, '3.cfg')).toMatchObject({ min: 0, max: 100, softMin: 1, softMax: 20 });
  });

  it('keeps the hard limits available alongside the soft ones', () => {
    const steps = byId(schema.fields, '3.steps');
    expect(steps?.max).toBe(10000);
    expect(steps?.softMax).toBeLessThan(steps?.max as number);
  });

  it('gives dimensions a usable range', () => {
    expect(byId(schema.fields, '5.width')).toMatchObject({ softMin: 256, softMax: 2048 });
    expect(byId(schema.fields, '5.height')).toMatchObject({ softMin: 256, softMax: 2048 });
  });

  it('leaves an already-tight range alone', () => {
    // denoise is 0..1 — nothing to improve on.
    const denoise = byId(schema.fields, '3.denoise');
    expect(denoise?.softMin).toBe(0);
    expect(denoise?.softMax).toBe(1);
  });

  it('gives a seed no soft range, since it gets dice rather than a slider', () => {
    expect(byId(schema.fields, '3.seed')?.softMin).toBeUndefined();
    expect(byId(schema.fields, '3.seed')?.softMax).toBeUndefined();
  });

  it('never widens beyond what the node accepts', () => {
    for (const field of schema.fields) {
      if (field.softMin !== undefined && field.min !== undefined) {
        expect(field.softMin).toBeGreaterThanOrEqual(field.min);
      }
      if (field.softMax !== undefined && field.max !== undefined) {
        expect(field.softMax).toBeLessThanOrEqual(field.max);
      }
    }
  });

  it('centres a window on the default for an unrecognised wide-ranged input', () => {
    const custom = buildParamSchema(
      { '1': { class_type: 'Mystery', inputs: { wobble: 12 } } },
      { Mystery: { input: { required: { wobble: ['INT', { min: 0, max: 1_000_000 }] } } } },
    );
    const field = byId(custom.fields, '1.wobble');
    expect(field?.softMin).toBe(0); // clamped to the hard minimum
    expect(field?.softMax).toBe(36);
  });

  it('gives LoRA strengths a sensible range', () => {
    const withLora = buildParamSchema(
      {
        '1': {
          class_type: 'LoraLoader',
          inputs: { lora_name: 'pixel_art_xl.safetensors', strength_model: 1, strength_clip: 1 },
        },
      },
      objectInfoFixture,
    );
    expect(byId(withLora.fields, '1.strength_model')).toMatchObject({ softMin: -1, softMax: 2 });
  });

  it('gives text controls no numeric range at all', () => {
    expect(byId(schema.fields, '6.text')?.softMin).toBeUndefined();
    expect(byId(schema.fields, '4.ckpt_name')?.softMax).toBeUndefined();
  });
});

describe('LoRA text fields', () => {
  it('detects a free-text field carrying lora tags and promotes it to the main screen', () => {
    const wf = {
      '1': {
        class_type: 'WanVideoSampler',
        inputs: { high_noise_lora: '<lora:detail:0.8>', steps: 20 },
      },
    };
    const schema = buildParamSchema(wf, {});
    const field = byId(schema.fields, '1.high_noise_lora');
    expect(field?.role).toBe('lora_text');
    expect(field?.group).toBe('main');
  });

  it('detects a lora-named text field even before any tag is typed', () => {
    const schema = buildParamSchema(
      { '1': { class_type: 'Custom', inputs: { lora_stack: '' } } },
      {},
    );
    expect(byId(schema.fields, '1.lora_stack')?.role).toBe('lora_text');
  });

  it('does not steal a real lora_name dropdown', () => {
    const schema = buildParamSchema(
      { '1': { class_type: 'LoraLoader', inputs: { lora_name: 'pixel_art_xl.safetensors' } } },
      objectInfoFixture,
    );
    // Still a combo of installed files, not a tag editor.
    expect(byId(schema.fields, '1.lora_name')).toMatchObject({ role: 'lora', control: 'combo' });
  });

  it('leaves an ordinary prompt as a prompt even when it contains tags', () => {
    const schema = build(sd15Txt2Img);
    expect(byId(schema.fields, '6.text')?.role).toBe('prompt');
  });
});

describe('applyOverrides', () => {
  const schema = build(sd15Txt2Img);

  it('renames, regroups, hides and reorders without touching the source schema', () => {
    const result = applyOverrides(schema, {
      '9.filename_prefix': { label: 'File name', group: 'main', order: 0 },
      '3.denoise': { hidden: true },
    });

    expect(byId(result.fields, '9.filename_prefix')).toMatchObject({
      label: 'File name',
      group: 'main',
    });
    expect(byId(result.fields, '3.denoise')?.hidden).toBe(true);
    // Original untouched.
    expect(byId(schema.fields, '9.filename_prefix')?.group).toBe('advanced');
  });

  it('recomputes capabilities when the only image field is hidden', () => {
    const withImage = build(img2img);
    expect(withImage.capabilities.img2img).toBe(true);
    const hidden = applyOverrides(withImage, { '1.image': { hidden: true } });
    expect(hidden.capabilities.img2img).toBe(false);
  });

  it('sorts main fields ahead of advanced ones', () => {
    const result = applyOverrides(schema, {});
    const firstAdvanced = result.fields.findIndex((f) => f.group === 'advanced');
    const lastMain = result.fields.map((f) => f.group).lastIndexOf('main');
    expect(lastMain).toBeLessThan(firstAdvanced);
  });
});

describe('applyParams', () => {
  const schema = build(sd15Txt2Img);

  it('writes values into a copy, leaving the stored workflow untouched', () => {
    const { workflow } = applyParams(sd15Txt2Img, schema, {
      '6.text': 'a red fox in snow',
      '3.steps': 30,
    });

    expect(workflow['6']?.inputs.text).toBe('a red fox in snow');
    expect(workflow['3']?.inputs.steps).toBe(30);
    expect(sd15Txt2Img['6']?.inputs.text).toBe('beautiful scenery nature glass bottle landscape');
    expect(sd15Txt2Img['3']?.inputs.steps).toBe(20);
  });

  it('preserves links between nodes', () => {
    const { workflow } = applyParams(sd15Txt2Img, schema, {});
    expect(workflow['3']?.inputs.model).toEqual(['4', 0]);
    expect(workflow['9']?.inputs.images).toEqual(['8', 0]);
  });

  it('coerces strings from form inputs to the numeric types the graph expects', () => {
    const { workflow } = applyParams(sd15Txt2Img, schema, {
      '3.steps': '35' as unknown as number,
      '3.cfg': '6.5' as unknown as number,
    });
    expect(workflow['3']?.inputs.steps).toBe(35);
    expect(workflow['3']?.inputs.cfg).toBe(6.5);
  });

  it('clamps out-of-range numbers instead of sending them to ComfyUI', () => {
    const { workflow } = applyParams(sd15Txt2Img, schema, { '3.steps': 999999, '3.cfg': -5 });
    expect(workflow['3']?.inputs.steps).toBe(10000);
    expect(workflow['3']?.inputs.cfg).toBe(0);
  });

  it('falls back to the default when a value cannot be parsed', () => {
    const { workflow } = applyParams(sd15Txt2Img, schema, {
      '3.steps': 'not a number' as unknown as number,
    });
    expect(workflow['3']?.inputs.steps).toBe(20);
  });

  it('keeps the given seed when not randomising, and reports it', () => {
    const { workflow, seeds } = applyParams(sd15Txt2Img, schema, { '3.seed': 12345 });
    expect(workflow['3']?.inputs.seed).toBe(12345);
    expect(seeds['3.seed']).toBe(12345);
  });

  it('rolls a new seed when randomising, within the field range', () => {
    const { workflow, seeds } = applyParams(
      sd15Txt2Img,
      schema,
      { '3.seed': 12345 },
      { randomizeSeeds: true, random: () => 0.5 },
    );
    const seed = workflow['3']?.inputs.seed as number;
    expect(seed).not.toBe(12345);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(seeds['3.seed']).toBe(seed);
  });

  it('honours a locked seed while randomising the others', () => {
    const sdxl = build(sdxlBaseRefiner);
    const { workflow } = applyParams(
      sdxlBaseRefiner,
      sdxl,
      { '10.noise_seed': 111, '11.noise_seed': 222 },
      { randomizeSeeds: true, lockedSeedFields: ['11.noise_seed'], random: () => 0.25 },
    );
    expect(workflow['11']?.inputs.noise_seed).toBe(222);
    expect(workflow['10']?.inputs.noise_seed).not.toBe(111);
  });

  it('ignores values for fields that are not in the schema', () => {
    const { workflow } = applyParams(sd15Txt2Img, schema, { '99.nope': 'x' });
    expect(workflow['99']).toBeUndefined();
  });

  it('round-trips defaults back to the original graph', () => {
    const { workflow } = applyParams(sd15Txt2Img, schema, defaultValues(schema));
    expect(workflow).toEqual(sd15Txt2Img);
  });
});

describe('buildParamSchema without object_info', () => {
  it('degrades gracefully when the ComfyUI server is unreachable', () => {
    const schema = buildParamSchema(sd15Txt2Img, {});
    expect(schema.fields.length).toBeGreaterThan(0);
    expect(byId(schema.fields, '6.text')?.role).toBe('prompt');
    expect(byId(schema.fields, '3.steps')?.control).toBe('int');
    // SaveImage is still found by class name even with no definitions.
    expect(schema.outputNodeIds).toEqual(['9']);
    expect(schema.missingNodeTypes.length).toBeGreaterThan(0);
  });
});

/**
 * A LoRA loader's own text is not the prompt.
 *
 * Several of them carry one — trigger words, a tag string — and it sits in the
 * conditioning chain, so walking back from the sampler's `positive` input finds
 * it. Calling it a prompt put it under the prompt box and, far worse, handed it
 * to the random draw, which would then overwrite a LoRA's trigger words with a
 * landscape.
 */
describe('text on a LoRA loader', () => {
  const graph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
    '2': {
      class_type: 'LoraTagLoader',
      inputs: { text: 'ohwx style, masterpiece', model: ['1', 0], clip: ['1', 1] },
    },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'a lighthouse', clip: ['2', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 1] } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: 1,
        steps: 20,
        cfg: 8,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['2', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['6', 0],
      },
    },
    '6': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['5', 0] } },
  };

  it('is a LoRA field, not a prompt the draw may overwrite', () => {
    const schema = buildParamSchema(graph, {});

    expect(byId(schema.fields, '2.text')).toMatchObject({ role: 'lora_text' });
    // The actual prompt is still found, and it is the only one.
    expect(schema.fields.filter((field) => field.role === 'prompt').map((f) => f.id)).toEqual([
      '3.text',
    ]);
  });
});
