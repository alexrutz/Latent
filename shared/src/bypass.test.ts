import { describe, expect, it } from 'vitest';

import {
  applyBypass,
  bypassableNodes,
  bypassedNodes,
  bypassFieldId,
  bypassGroup,
  bypassSlotIndex,
  isBypassField,
  typesConnect,
  withBypassSwitches,
} from './bypass.js';
import type { ApiWorkflow, ObjectInfo } from './comfyTypes.js';
import { applyOverrides, applyParams, buildParamSchema } from './paramSchema.js';

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
  EmptyLatentImage: {
    input: { required: { width: ['INT', { default: 512 }] } },
    output: ['LATENT'],
  },
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
  '2': {
    class_type: 'LoraLoader',
    inputs: {
      model: ['1', 0],
      clip: ['1', 1],
      lora_name: 'a',
      strength_model: 1,
      strength_clip: 1,
    },
    _meta: { title: 'Style LoRA' },
  },
  '3': {
    class_type: 'LoraLoader',
    inputs: {
      model: ['2', 0],
      clip: ['2', 1],
      lora_name: 'b',
      strength_model: 1,
      strength_clip: 1,
    },
  },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['3', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512 } },
  '6': {
    class_type: 'KSampler',
    inputs: { model: ['3', 0], seed: 1, positive: ['4', 0], latent_image: ['5', 0] },
  },
  '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
  '8': {
    class_type: 'ImageScaleBy',
    inputs: { image: ['7', 0], scale_by: 2 },
    _meta: { title: 'Upscale' },
  },
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
  it('is offered on every node, as the editor offers it', () => {
    // The decode, the save and the loader too: whether a bypass leaves the
    // graph runnable is asked when it is used, not by withholding the switch.
    expect(bypassableNodes(graph(), objectInfo)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    expect(bypassableNodes(graph())).toHaveLength(9);
    const schema = buildParamSchema(graph(), objectInfo);
    expect(schema.fields.filter(isBypassField).map((field) => field.nodeId)).toHaveLength(9);
  });

  it('refuses a bypass that leaves a needed input empty, naming the node', () => {
    const { error, workflow } = applyBypass(graph(), ['7'], objectInfo);
    expect(error).toMatch(/VAEDecode/);
    expect(error).toMatch(/Upscale without its 'image'/);
    expect(workflow['7']).toBeDefined();
    expect(applyBypass(graph(), ['9'], objectInfo).error).toMatch(/nothing is left that saves/);
  });

  it('passes a node ComfyUI does not describe straight through', () => {
    const custom = graph();
    custom['10'] = {
      class_type: 'SomeCustomPack.Sharpen',
      inputs: { image: ['8', 0], amount: 0.5 },
    };
    custom['9']!.inputs.images = ['10', 0];
    const { workflow, error } = applyBypass(custom, ['10'], objectInfo);
    expect(error).toBeUndefined();
    expect(workflow['10']).toBeUndefined();
    expect(workflow['9']!.inputs.images).toEqual(['8', 0]);
  });

  it('is added to a form stored before every node had one, without moving anything', () => {
    const fresh = buildParamSchema(graph(), objectInfo);
    // A form from an older version: switches on 2 and 3 only, one of them
    // renamed in the form editor.
    const old = {
      ...fresh,
      fields: fresh.fields
        .filter((field) => !isBypassField(field) || ['2', '3'].includes(field.nodeId))
        .map((field) =>
          field.id === bypassFieldId('2') ? { ...field, label: 'Skip style' } : field,
        ),
    };
    const upgraded = withBypassSwitches(old, graph());
    const switches = upgraded.fields.filter(isBypassField);
    expect(switches.map((field) => field.nodeId).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
    expect(switches.find((field) => field.nodeId === '2')?.label).toBe('Skip style');
    // Everything that was there keeps its place.
    for (const field of old.fields) {
      expect(upgraded.fields.find((entry) => entry.id === field.id)?.order).toBe(field.order);
    }
    // First among its node's advanced settings, where it has some.
    for (const nodeId of ['1', '4', '5', '6', '7', '8', '9']) {
      const own = upgraded.fields.filter(
        (field) => field.nodeId === nodeId && field.group === 'advanced',
      );
      const first = own.reduce((a, b) => (b.order < a.order ? b : a));
      expect(isBypassField(first)).toBe(true);
    }
    // Nothing to add: the same schema back.
    expect(withBypassSwitches(upgraded, graph())).toBe(upgraded);
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

  it('is never a control on the form, whatever a form edit once said', () => {
    const schema = buildParamSchema(graph(), objectInfo);
    expect(schema.fields.filter(isBypassField).every((field) => field.hidden)).toBe(true);
    // An older version showed them, and its form editor could store that.
    const shown = {
      ...schema,
      fields: schema.fields.map((field) =>
        isBypassField(field) ? { ...field, hidden: false } : field,
      ),
    };
    expect(
      withBypassSwitches(shown, graph())
        .fields.filter(isBypassField)
        .every((field) => field.hidden),
    ).toBe(true);
    const overridden = applyOverrides(schema, {
      [bypassFieldId('2')]: { hidden: false, group: 'main' },
    });
    expect(overridden.fields.find((field) => field.id === bypassFieldId('2'))?.hidden).toBe(true);
  });

  it('is never written into the graph as an input', () => {
    const schema = buildParamSchema(graph(), objectInfo);
    const { workflow } = applyParams(graph(), schema, { [bypassFieldId('2')]: true });
    expect(Object.keys(workflow['2']!.inputs)).not.toContain('__bypass');
  });
});

describe('bypassing a picture with its encode', () => {
  it('takes the VAE Encode a picture feeds, and only that', async () => {
    const { loadImageFromFolder, img2img } = await import('./fixtures/workflows.js');
    // The loader feeds the encode and a save; only the encode goes with it.
    expect(bypassGroup(loadImageFromFolder, '1').sort()).toEqual(['1', '3']);
    expect(bypassGroup(img2img, '1').sort()).toEqual(['1', '3']);
  });

  it('takes whatever lies between the picture and its encode', () => {
    const chain: ApiWorkflow = {
      '1': { class_type: 'LoadImageFromFolder', inputs: { image: 'a.png' } },
      '2': { class_type: 'ImageScale', inputs: { image: ['1', 0], width: 512 } },
      '3': { class_type: 'VAEEncodeTiled', inputs: { pixels: ['2', 0], vae: ['9', 2] } },
      '4': { class_type: 'PreviewImage', inputs: { images: ['2', 0] } },
      '9': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm' } },
    };
    expect(bypassGroup(chain, '1').sort()).toEqual(['1', '2', '3']);
  });

  it('is the picture alone when no encode follows', () => {
    const plain: ApiWorkflow = {
      '1': { class_type: 'LoadImageFromFolder', inputs: { image: 'a.png' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    };
    expect(bypassGroup(plain, '1')).toEqual(['1']);
  });
});
