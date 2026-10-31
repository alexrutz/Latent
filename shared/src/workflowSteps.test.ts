import { describe, expect, it } from 'vitest';

import type { ApiWorkflow } from './comfyTypes.js';
import { objectInfoFixture as objectInfo } from './fixtures/objectInfo.js';
import { img2img, sd15Txt2Img } from './fixtures/workflows.js';
import { trimDefinitions, workflowSteps } from './workflowSteps.js';

/** Each step's node types; sorted, since the order within a step is the next test's. */
const titles = (steps: ReturnType<typeof workflowSteps>['steps']) =>
  steps.map((step) => step.map((node) => node.classType).sort());

describe('a workflow as the order it runs in', () => {
  it('puts each node one step after the latest thing it reads', () => {
    const { steps } = workflowSteps(sd15Txt2Img, objectInfo);
    expect(titles(steps)).toEqual([
      ['CheckpointLoaderSimple', 'EmptyLatentImage'],
      ['CLIPTextEncode', 'CLIPTextEncode'],
      ['KSampler'],
      ['VAEDecode'],
      ['SaveImage'],
    ]);
    // Everything a node reads ran in an earlier step.
    const stepOf = new Map(
      steps.flatMap((step, index) => step.map((node) => [node.id, index] as const)),
    );
    for (const step of steps) {
      for (const node of step) {
        for (const input of node.inputs) {
          if (input.from) expect(stepOf.get(input.from.id)!).toBeLessThan(stepOf.get(node.id)!);
        }
      }
    }
  });

  it('says where each input comes from, and what the values are', () => {
    const sampler = workflowSteps(sd15Txt2Img, objectInfo).steps[2]![0]!;
    expect(sampler.title).toBe('KSampler');
    expect(sampler.inputs.find((input) => input.name === 'model')?.from).toEqual({
      id: '4',
      title: 'Load Checkpoint',
      output: 'MODEL',
    });
    expect(sampler.values.find((value) => value.name === 'steps')?.value).toBe('20');
    expect(sampler.values.find((value) => value.name === 'sampler_name')?.value).toBe('euler');
    expect(sampler.feeds).toEqual([{ id: '8', title: 'VAE Decode' }]);
  });

  it('keeps a long value whole, for the card to wrap', () => {
    const wordy = structuredClone(sd15Txt2Img);
    wordy['6']!.inputs.text = 'a '.repeat(200).trim();
    const encode = workflowSteps(wordy, objectInfo)
      .steps.flat()
      .find((node) => node.id === '6')!;
    expect(encode.values.find((value) => value.name === 'text')?.value).toHaveLength(399);
  });

  it('orders a step by what it reads, so a chain reads straight across', () => {
    const { steps } = workflowSteps(img2img, objectInfo);
    // The loaders first, in the order of what reads them; the encode beside them.
    expect(steps[0]!.map((node) => node.classType).sort()).toEqual([
      'CheckpointLoaderSimple',
      'LoadImage',
    ]);
    expect(steps.flat()).toHaveLength(Object.keys(img2img).length);
  });

  it('draws a node ComfyUI does not describe from the graph alone', () => {
    const custom: ApiWorkflow = {
      ...structuredClone(sd15Txt2Img),
      '20': { class_type: 'Some.Sharpen', inputs: { image: ['8', 0], amount: 0.25 } },
    };
    custom['9']!.inputs.images = ['20', 0];
    const node = workflowSteps(custom, objectInfo)
      .steps.flat()
      .find((entry) => entry.id === '20')!;
    expect(node.known).toBe(false);
    expect(node.inputs[0]?.from?.title).toBe('VAE Decode');
    expect(node.values).toEqual([{ name: 'amount', value: '0.25' }]);
  });

  it('copes with an empty graph', () => {
    expect(workflowSteps({}, objectInfo)).toEqual({ steps: [] });
  });
});

describe('the definitions the view is sent', () => {
  it('keeps only the nodes in the graph, without their option lists', () => {
    const trimmed = trimDefinitions(sd15Txt2Img, objectInfo);
    expect(Object.keys(trimmed).sort()).toEqual(
      [...new Set(Object.values(sd15Txt2Img).map((node) => node.class_type))].sort(),
    );
    expect((trimmed.CheckpointLoaderSimple?.input?.required?.ckpt_name as unknown[])[0]).toEqual(
      [],
    );
    // Still read the same.
    expect(workflowSteps(sd15Txt2Img, trimmed)).toEqual(workflowSteps(sd15Txt2Img, objectInfo));
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
