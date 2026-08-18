import { describe, expect, it } from 'vitest';

import { objectInfoFixture } from './fixtures/objectInfo.js';
import { sd15Txt2Img, sd15Txt2ImgUi } from './fixtures/workflows.js';
import { isUiWorkflow, uiToApiWorkflow, UiWorkflowError } from './uiWorkflow.js';
import type { UiWorkflow } from './uiWorkflow.js';

const ui = sd15Txt2ImgUi as unknown as UiWorkflow;

/** The API graph without the `_meta` titles, which the editor names differently. */
function bare(graph: Record<string, { class_type: string; inputs: unknown }>) {
  return Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [id, { class_type: node.class_type, inputs: node.inputs }]),
  );
}

describe('uiToApiWorkflow', () => {
  it('converts the editor format into the graph ComfyUI runs', () => {
    const converted = uiToApiWorkflow(ui, objectInfoFixture);
    expect(bare(converted)).toEqual(bare(sd15Txt2Img));
  });

  it('reads the widget values positionally, skipping the seed control', () => {
    const sampler = uiToApiWorkflow(ui, objectInfoFixture)['3'];
    expect(sampler?.inputs.seed).toBe(156680208700286);
    expect(sampler?.inputs.steps).toBe(20);
    expect(sampler?.inputs.cfg).toBe(8);
    expect(sampler?.inputs.sampler_name).toBe('euler');
    expect(sampler?.inputs.scheduler).toBe('normal');
    expect(sampler?.inputs.denoise).toBe(1);
    // 'randomize' is the editor's own control, not a field the API has.
    expect(Object.values(sampler?.inputs ?? {})).not.toContain('randomize');
  });

  it('keeps a widget that was dragged out into a socket as a connection', () => {
    const dragged: UiWorkflow = JSON.parse(JSON.stringify(ui));
    const sampler = dragged.nodes.find((node) => node.id === 3)!;
    // `steps` promoted to an input, so it is missing from the positional list.
    sampler.inputs!.push({ name: 'steps', type: 'INT', link: 20, widget: { name: 'steps' } });
    sampler.widgets_values = [156680208700286, 'randomize', 8, 'euler', 'normal', 1];
    dragged.links!.push([20, 5, 0, 3, 4, 'INT']);

    const converted = uiToApiWorkflow(dragged, objectInfoFixture)['3'];
    expect(converted?.inputs.steps).toEqual(['5', 0]);
    // Everything after it still lines up.
    expect(converted?.inputs.cfg).toBe(8);
    expect(converted?.inputs.sampler_name).toBe('euler');
  });

  it('follows a reroute back to what actually produces the value', () => {
    const rerouted: UiWorkflow = JSON.parse(JSON.stringify(ui));
    rerouted.nodes.push({
      id: 50,
      type: 'Reroute',
      inputs: [{ name: '', type: '*', link: 1 }],
    } as never);
    // The sampler now takes its model from the reroute instead.
    rerouted.nodes.find((node) => node.id === 3)!.inputs![0]!.link = 51;
    rerouted.links!.push([51, 50, 0, 3, 0, 'MODEL']);

    const converted = uiToApiWorkflow(rerouted, objectInfoFixture);
    expect(converted['3']?.inputs.model).toEqual(['4', 0]);
    expect(converted['50']).toBeUndefined();
  });

  it('leaves out nodes that are muted or bypassed, and notes', () => {
    const muted: UiWorkflow = JSON.parse(JSON.stringify(ui));
    // Saving switched off, previewing switched on — which is how a graph
    // usually looks while somebody is still deciding.
    muted.nodes.find((node) => node.id === 9)!.mode = 4;
    muted.nodes.push({
      id: 61,
      type: 'PreviewImage',
      inputs: [{ name: 'images', type: 'IMAGE', link: 9 }],
    } as never);
    muted.nodes.push({ id: 60, type: 'Note', widgets_values: ['a reminder'] } as never);

    const converted = uiToApiWorkflow(muted, objectInfoFixture);
    expect(converted['9']).toBeUndefined();
    expect(converted['60']).toBeUndefined();
    expect(converted['61']).toBeDefined();
    expect(converted['3']).toBeDefined();
  });

  it('says which node is missing rather than importing a broken graph', () => {
    const custom: UiWorkflow = JSON.parse(JSON.stringify(ui));
    custom.nodes.push({ id: 70, type: 'SomeCustomNode', widgets_values: [] } as never);

    expect(() => uiToApiWorkflow(custom, objectInfoFixture)).toThrow(UiWorkflowError);
    expect(() => uiToApiWorkflow(custom, objectInfoFixture)).toThrow(/SomeCustomNode/);
  });

  it('recognises which of the two formats a file is', () => {
    expect(isUiWorkflow(ui)).toBe(true);
    expect(isUiWorkflow(sd15Txt2Img)).toBe(false);
    expect(isUiWorkflow(null)).toBe(false);
  });
});

describe('what a workflow has to contain', () => {
  it('refuses a graph with nothing that produces an image', () => {
    const headless = {
      nodes: [{ id: 3, type: 'KSampler', widgets_values: [] }],
      links: [],
    } as unknown as UiWorkflow;

    expect(() => uiToApiWorkflow(headless, objectInfoFixture)).toThrow(/no output node/);
  });
});

/**
 * Nodes that keep a widget their own JavaScript manages.
 *
 * The LoRA managers and the Ollama nodes both do it: `/object_info` declares
 * the input, but the editor stores its value somewhere other than
 * `widgets_values`, so the positional list is shorter than the widget list.
 * Stopping at the end of it left those inputs out of the converted graph
 * entirely, and ComfyUI answers a prompt missing a required input with
 * "Required input is missing: text" and drops the output.
 */
describe('a positional list shorter than the widgets', () => {
  const objectInfo: ObjectInfo = {
    'Lora Loader (LoraManager)': {
      input: {
        required: {
          lora_name: [['a.safetensors', 'b.safetensors'], {}],
          strength: ['FLOAT', { default: 1 }],
          text: ['STRING', { multiline: true, default: '' }],
        },
      },
      output: ['MODEL', 'CLIP'],
      output_node: false,
    },
    SaveImage: {
      input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', { default: 'out' }] } },
      output: [],
      output_node: true,
    },
  };

  it('fills the rest from what /object_info declares', () => {
    const ui = {
      nodes: [
        {
          id: 168,
          type: 'Lora Loader (LoraManager)',
          // Only the first widget was saved; `text` lives in the node's own
          // properties, which the editor does not put in this list.
          widgets_values: ['b.safetensors'],
        },
        { id: 106, type: 'SaveImage', widgets_values: ['run'] },
      ],
      links: [],
    };

    const api = uiToApiWorkflow(ui, objectInfo);

    expect(api['168']?.inputs.lora_name).toBe('b.safetensors');
    // Present, not missing — which is the whole point.
    expect(api['168']?.inputs.strength).toBe(1);
    expect(api['168']?.inputs).toHaveProperty('text');
    expect(api['168']?.inputs.text).toBe('');
  });

  it('takes a combo default from its first option when none is declared', () => {
    const ui = {
      nodes: [
        { id: 168, type: 'Lora Loader (LoraManager)', widgets_values: [] },
        { id: 106, type: 'SaveImage', widgets_values: ['run'] },
      ],
      links: [],
    };

    expect(uiToApiWorkflow(ui, objectInfo)['168']?.inputs.lora_name).toBe('a.safetensors');
  });
});
