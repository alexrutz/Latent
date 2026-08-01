import { describe, expect, it } from 'vitest';

import { buildParamSchema } from './paramSchema.js';
import { objectInfoFixture } from './fixtures/objectInfo.js';
import { img2img, sd15Txt2Img } from './fixtures/workflows.js';
import { matchPrompt, parsePromptMetadata, valuesFromPrompt } from './promptMatch.js';
import type { ApiWorkflow } from './comfyTypes.js';

const candidate = (id: string, name: string, graph: ApiWorkflow) => ({
  id,
  name,
  graph,
  schema: buildParamSchema(graph, objectInfoFixture),
});

/** The graph as it comes back out of a saved PNG: same shape, other values. */
function asSaved(graph: ApiWorkflow, changes: Record<string, Record<string, unknown>>): ApiWorkflow {
  const copy: ApiWorkflow = JSON.parse(JSON.stringify(graph));
  for (const [nodeId, inputs] of Object.entries(changes)) {
    Object.assign((copy[nodeId] as { inputs: Record<string, unknown> }).inputs, inputs);
  }
  return copy;
}

describe('matchPrompt', () => {
  it('recognises the workflow an image came from and reads its settings back', () => {
    const saved = asSaved(sd15Txt2Img, {
      '3': { steps: 33, cfg: 6.5, seed: 42 },
      '6': { text: 'a lighthouse in a storm' },
    });

    const match = matchPrompt(saved, [
      candidate('a', 'img2img', img2img),
      candidate('b', 'sd15', sd15Txt2Img),
    ]);

    expect(match?.workflowId).toBe('b');
    expect(match?.score).toBe(1);
    expect(match?.values['3.steps']).toBe(33);
    expect(match?.values['3.cfg']).toBe(6.5);
    expect(match?.values['6.text']).toBe('a lighthouse in a storm');
  });

  it('does not match a graph that merely numbers its nodes the same way', () => {
    const impostor: ApiWorkflow = {};
    for (const id of Object.keys(sd15Txt2Img)) {
      impostor[id] = { class_type: 'SomethingElse', inputs: {} };
    }
    expect(matchPrompt(impostor, [candidate('b', 'sd15', sd15Txt2Img)])).toBeNull();
  });

  it('accepts a graph that has extra nodes around the same workflow', () => {
    const extended = { ...sd15Txt2Img, '99': { class_type: 'SaveImage', inputs: {} } };
    const match = matchPrompt(extended, [candidate('b', 'sd15', sd15Txt2Img)]);
    expect(match?.workflowId).toBe('b');
  });

  it('prefers the closest of two similar workflows', () => {
    const nearly = { ...sd15Txt2Img, '5': { class_type: 'EmptyLatentImageAlt', inputs: {} } };
    const match = matchPrompt(sd15Txt2Img, [
      candidate('near', 'nearly', nearly),
      candidate('exact', 'exact', sd15Txt2Img),
    ]);
    expect(match?.workflowId).toBe('exact');
  });

  it('leaves wired inputs out of the values', () => {
    const schema = buildParamSchema(sd15Txt2Img, objectInfoFixture);
    const values = valuesFromPrompt(schema, sd15Txt2Img);

    // `model` on the sampler is a link, not a widget.
    expect(values['3.model']).toBeUndefined();
    expect(values['3.steps']).toBe(20);
  });
});

describe('parsePromptMetadata', () => {
  it('reads the graph ComfyUI writes into a PNG', () => {
    const parsed = parsePromptMetadata({ prompt: JSON.stringify(sd15Txt2Img) });
    expect(parsed?.['3']?.class_type).toBe('KSampler');
  });

  it('ignores text that is not a graph', () => {
    expect(parsePromptMetadata({ prompt: 'a lighthouse' })).toBeNull();
    expect(parsePromptMetadata({ prompt: '{"a":1}' })).toBeNull();
    expect(parsePromptMetadata({ parameters: JSON.stringify(sd15Txt2Img) })).toBeNull();
    expect(parsePromptMetadata({})).toBeNull();
  });
});
