import { describe, expect, it } from 'vitest';

import {
  applyBypass,
  bypassableNodes,
  bypassedNodes,
  bypassFieldId,
  bypassSlotIndex,
  typesConnect,
} from './bypass.js';
import type { ApiWorkflow, ObjectInfo } from './comfyTypes.js';
import { applyParams, buildParamSchema } from './paramSchema.js';

/** Just enough of /object_info to wire a model through two LoRAs and an upscale. */
const objectInfo: ObjectInfo = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['model.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
  LoraLoader: {
    input: {
      required: {
        model: ['MODEL'],
        clip: ['CLIP'],
        lora_name: [['style.safetensors']],
        strength_model: ['FLOAT', { default: 1 }],
        strength_clip: ['FLOAT', { default: 1 }],
      },
    },
    output: ['MODEL', 'CLIP'],
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    output: ['CONDITIONING'],
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0 }],
        positive: ['CONDITIONING'],
        latent_image: ['LATENT'],
      },
    },
    output: ['LATENT'],
  },
  EmptyLatentImage: { input: { required: { width: ['INT', { default: 512 }] } }, output: ['LATENT'] },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
  ImageScaleBy: {
    input: { required: { image: ['IMAGE'], scale_by: ['FLOAT', { default: 2 }] } },
    output: ['IMAGE'],
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'out' }] } },
    output: [],
    output_node: true,
  },
};

const graph = (): ApiWorkflow => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '2': { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['1', 1], lora_name: 'a', strength_model: 1, strength_clip: 1 }, _meta: { title: 'Style LoRA' } },
  '3': { class_type: 'LoraLoader', inputs: { model: ['2', 0], clip: ['2', 1], lora_name: 'b', strength_model: 1, strength_clip: 1 } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['3', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512 } },
  '6': { class_type: 'KSampler', inputs: { model: ['3', 0], seed: 1, positive: ['4', 0], latent_image: ['5', 0] } },
  '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
  '8': { class_type: 'ImageScaleBy', inputs: { image: ['7', 0], scale_by: 2 }, _meta: { title: 'Upscale' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'out' } },
});

describe('which input stands in for an output', () => {
  it('follows ComfyUI’s order of preference', () => {
    const inputs = [{ type: 'MODEL' }, { type: 'CLIP' }, { type: 'FLOAT' }];
    // The same position, when it fits both ways.
    expect(bypassSlotIndex(inputs, 1, 'CLIP', 'CLIP')).toBe(1);
    // Otherwise the first of exactly the wanted type.
    expect(bypassSlotIndex([{ type: 'CLIP' }, { type: 'MODEL' }], 0, 'MODEL', 'MODEL')).toBe(1);
    // Anything at all: the same slot, or the first.
    expect(bypassSlotIndex(inputs, 5, 'X', '*')).toBe(0);
    // Nothing that fits.
    expect(bypassSlotIndex(inputs, 0, 'IMAGE', 'IMAGE')).toBe(-1);
  });

  it('matches types as LiteGraph does', () => {
    expect(typesConnect('IMAGE', 'image')).toBe(true);
    expect(typesConnect('IMAGE,MASK', 'MASK')).toBe(true);
    expect(typesConnect('*', 'LATENT')).toBe(true);
    expect(typesConnect('MODEL', 'CLIP')).toBe(false);
  });
});

describe('cutting bypassed nodes out', () => {
  it('hands a skipped LoRA’s model and clip straight on', () => {
    const { workflow, error } = applyBypass(graph(), ['3'], objectInfo);
    expect(error).toBeUndefined();
    expect(workflow['3']).toBeUndefined();
    expect(workflow['6']?.inputs.model).toEqual(['2', 0]);
    expect(workflow['4']?.inputs.clip).toEqual(['2', 1]);
  });

  it('goes through several in a row', () => {
    const { workflow } = applyBypass(graph(), ['2', '3'], objectInfo);
    expect(workflow['6']?.inputs.model).toEqual(['1', 0]);
    expect(workflow['4']?.inputs.clip).toEqual(['1', 1]);
  });

  it('skips an upscale, the picture going straight to the save', () => {
    const { workflow } = applyBypass(graph(), ['8'], objectInfo);
    expect(workflow['9']?.inputs.images).toEqual(['7', 0]);
  });

  it('refuses, naming the switch, when nothing can stand in for a required input', () => {
    // A decode has no picture to hand on, so the upscale after it would have nothing.
    const { workflow, error } = applyBypass(graph(), ['7'], objectInfo);
    expect(error).toMatch(/Bypassing "VAEDecode"/);
    expect(error).toMatch(/'image'/);
    expect(workflow['7']).toBeDefined(); // untouched
  });

  it('refuses when nothing is left that saves a picture', () => {
    const { error } = applyBypass(graph(), ['9'], objectInfo);
    expect(error).toMatch(/nothing is left that saves a picture/);
  });

  it('never touches the stored graph', () => {
    const stored = graph();
    applyBypass(stored, ['3'], objectInfo);
    expect(stored['3']).toBeDefined();
    expect(stored['6']?.inputs.model).toEqual(['3', 0]);
  });
});

describe('the Bypass switch in the form', () => {
  it('is offered on nodes that can pass something through, and only those', () => {
    expect(bypassableNodes(graph(), objectInfo)).toEqual(['2', '3', '6', '8']);
  });

  it('is always offered on a node bypassed in the editor, and starts on there', () => {
    const marked = graph();
    marked['7']!._meta = { bypassed: true };
    expect(bypassableNodes(marked, objectInfo)).toContain('7');

    const schema = buildParamSchema(marked, objectInfo);
    const field = schema.fields.find((entry) => entry.id === bypassFieldId('7'));
    expect(field?.defaultValue).toBe(true);
    expect(bypassedNodes(schema, {})).toEqual(['7']);
    expect(bypassedNodes(schema, { [bypassFieldId('7')]: false })).toEqual([]);
  });

  it('sits in Advanced under its node, labelled as a bypass', () => {
    const schema = buildParamSchema(graph(), objectInfo);
    const field = schema.fields.find((entry) => entry.id === bypassFieldId('2'));
    expect(field).toMatchObject({ group: 'advanced', control: 'boolean', defaultValue: false });
    expect(field?.label).toMatch(/^Bypass/);
  });

  it('is never written into the graph as an input', () => {
    const schema = buildParamSchema(graph(), objectInfo);
    const { workflow } = applyParams(graph(), schema, { [bypassFieldId('2')]: true });
    expect(Object.keys(workflow['2']!.inputs)).not.toContain('__bypass');
  });
});
