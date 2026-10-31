import { describe, expect, it } from 'vitest';

import type { ObjectInfo } from './comfyTypes.js';
import { sd15Txt2Img } from './fixtures/workflows.js';
import { GRAPH_METRICS, graphView, slotColor, slotY, trimDefinitions } from './graphView.js';

const defs: ObjectInfo = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [['a.safetensors', 'b.safetensors']] } },
    output: ['MODEL', 'CLIP', 'VAE'],
    output_name: ['MODEL', 'CLIP', 'VAE'],
    display_name: 'Load Checkpoint',
  },
  CLIPTextEncode: {
    input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } },
    output: ['CONDITIONING'],
    display_name: 'CLIP Text Encode (Prompt)',
  },
  EmptyLatentImage: {
    input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } },
    output: ['LATENT'],
    display_name: 'Empty Latent Image',
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT'],
        steps: ['INT'],
        cfg: ['FLOAT'],
        sampler_name: [['euler', 'dpmpp_2m']],
        scheduler: [['normal', 'karras']],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT'],
      },
    },
    input_order: {
      required: [
        'model',
        'seed',
        'steps',
        'cfg',
        'sampler_name',
        'scheduler',
        'positive',
        'negative',
        'latent_image',
        'denoise',
      ],
    },
    output: ['LATENT'],
    display_name: 'KSampler',
  },
  VAEDecode: {
    input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
    output: ['IMAGE'],
    display_name: 'VAE Decode',
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } },
    output: [],
    output_node: true,
    display_name: 'Save Image',
  },
};

describe('drawing a workflow as the editor does', () => {
  const view = graphView(sd15Txt2Img, defs);
  const node = (id: string) => view.nodes.find((entry) => entry.id === id)!;

  it('draws every node, with sockets and widgets where the editor puts them', () => {
    expect(view.nodes).toHaveLength(Object.keys(sd15Txt2Img).length);
    const sampler = node('3');
    expect(sampler.title).toBe('KSampler');
    // Wired inputs are sockets, in the definition's order; values are widgets.
    expect(sampler.inputs.map((input) => input.name)).toEqual([
      'model',
      'positive',
      'negative',
      'latent_image',
    ]);
    expect(sampler.widgets.map((widget) => widget.name)).toEqual([
      'seed',
      'steps',
      'cfg',
      'sampler_name',
      'scheduler',
      'denoise',
    ]);
    expect(sampler.widgets.find((widget) => widget.name === 'cfg')?.value).toBe('8');
    expect(sampler.outputs).toEqual([{ name: 'LATENT', type: 'LATENT' }]);
    expect(sampler.height).toBe(
      GRAPH_METRICS.title + 4 * GRAPH_METRICS.slot + 6 * GRAPH_METRICS.widget + GRAPH_METRICS.pad,
    );
  });

  it('lays out left to right, every link running forwards', () => {
    for (const link of view.links) {
      expect(node(link.from).x).toBeLessThan(node(link.to).x);
    }
    expect(node('4').x).toBe(0);
    expect(node('9').x).toBeGreaterThan(node('8').x);
  });

  it('never overlaps two nodes', () => {
    for (const a of view.nodes) {
      for (const b of view.nodes) {
        if (a === b) continue;
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `${a.title} and ${b.title}`).toBe(true);
      }
    }
    expect(Math.min(...view.nodes.map((entry) => entry.y))).toBe(0);
  });

  it('colours a link by what it carries', () => {
    const model = view.links.find((link) => link.from === '4' && link.to === '3');
    expect(model?.type).toBe('MODEL');
    expect(slotColor('MODEL')).toBe('#B39DDB');
    expect(slotColor('LATENT')).toBe('#FF9CF9');
    expect(slotColor('SOMETHING_NEW')).toBe('#9A9');
    // Drawn from the output row to the input row.
    const sampler = node('3');
    expect(slotY(sampler, model!.toSlot)).toBe(
      sampler.y + GRAPH_METRICS.title + GRAPH_METRICS.slot / 2,
    );
  });

  it('draws a node ComfyUI does not describe from the graph alone', () => {
    const custom = structuredClone(sd15Txt2Img);
    custom['20'] = { class_type: 'Some.Sharpen', inputs: { image: ['8', 0], amount: 0.25 } };
    custom['9']!.inputs.images = ['20', 0];
    const drawn = graphView(custom, defs).nodes.find((entry) => entry.id === '20')!;
    expect(drawn.known).toBe(false);
    expect(drawn.inputs).toEqual([{ name: 'image', type: '*', link: { from: '8', slot: 0 } }]);
    expect(drawn.widgets).toEqual([{ name: 'amount', value: '0.25' }]);
    // Typed by what reads it.
    expect(drawn.outputs).toEqual([{ name: 'IMAGE', type: 'IMAGE' }]);
  });

  it('shortens a long value to fit the node', () => {
    const wordy = structuredClone(sd15Txt2Img);
    wordy['6']!.inputs.text = 'a '.repeat(200);
    const drawn = graphView(wordy, defs).nodes.find((entry) => entry.id === '6')!;
    expect(drawn.width).toBeLessThanOrEqual(GRAPH_METRICS.maxWidth);
    expect(drawn.widgets[0]!.value.endsWith('…')).toBe(true);
  });

  it('copes with an empty graph', () => {
    expect(graphView({}, defs)).toEqual({ nodes: [], links: [], width: 0, height: 0 });
  });
});

describe('the definitions the view is sent', () => {
  it('keeps only the nodes in the graph, without their option lists', () => {
    const trimmed = trimDefinitions(sd15Txt2Img, {
      ...defs,
      Unused: { input: {}, output: [] },
    });
    expect(Object.keys(trimmed).sort()).toEqual(
      [
        'CLIPTextEncode',
        'CheckpointLoaderSimple',
        'EmptyLatentImage',
        'KSampler',
        'SaveImage',
        'VAEDecode',
      ].sort(),
    );
    expect(trimmed.CheckpointLoaderSimple?.input?.required?.ckpt_name).toEqual([[]]);
    expect(trimmed.KSampler?.input?.required?.steps).toEqual(['INT']);
    // Still drawn the same.
    const before = graphView(sd15Txt2Img, defs);
    const after = graphView(sd15Txt2Img, trimmed);
    expect(after.nodes.map((entry) => entry.inputs)).toEqual(
      before.nodes.map((entry) => entry.inputs),
    );
  });

  it('empties the newer combo form too', () => {
    const trimmed = trimDefinitions(
      { '1': { class_type: 'New', inputs: {} } },
      {
        New: {
          input: { required: { pick: ['COMBO', { options: ['a', 'b'], default: 'a' }] } },
          output: [],
        },
      },
    );
    expect(trimmed.New?.input?.required?.pick).toEqual(['COMBO', { options: [], default: 'a' }]);
  });
});
