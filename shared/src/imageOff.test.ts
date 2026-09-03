import { describe, expect, it } from 'vitest';

import { applyImageOff, imageOffNodes, switchableImageNodes } from './imageOff.js';
import { buildParamSchema } from './paramSchema.js';
import { objectInfoFixture } from './fixtures/objectInfo.js';
import { img2img, sd15Txt2Img } from './fixtures/workflows.js';
import type { ApiWorkflow, ObjectInfo } from './comfyTypes.js';

/**
 * Running the same workflow without its picture.
 *
 * A graph is a fixed set of links, so once a loader is wired in every run sends
 * a picture — there is no value you can type that means "not this time". These
 * are the rules of the switch that replaces dragging the link off.
 */

const build = (wf: ApiWorkflow) => buildParamSchema(wf, objectInfoFixture);

describe('which pictures can be switched off', () => {
  it('offers one for a loader something actually reads', () => {
    expect(switchableImageNodes(build(img2img), img2img)).toEqual(['1']);
  });

  it('offers none where there is no picture at all', () => {
    expect(switchableImageNodes(build(sd15Txt2Img), sd15Txt2Img)).toEqual([]);
  });

  it('offers none for a loader nothing is wired to', () => {
    // A switch for it would be a control with no effect: the node is already
    // doing nothing, because nothing reads it.
    const orphaned: ApiWorkflow = {
      ...sd15Txt2Img,
      '99': { class_type: 'LoadImage', inputs: { image: 'stray.png' } },
    };
    expect(switchableImageNodes(build(orphaned), orphaned)).toEqual([]);
  });
});

describe('the switch on the form', () => {
  it('appears beside the picture it governs', () => {
    const schema = build(img2img);
    const field = schema.fields.find((entry) => entry.id === '1.__image');
    expect(field).toMatchObject({ control: 'boolean', nodeId: '1', group: 'main' });
    // On by default: a workflow with a picture wired in was built to use it.
    expect(field?.defaultValue).toBe(true);

    const picture = schema.fields.find((entry) => entry.id === '1.image')!;
    expect(field!.order).toBe(picture.order + 1);
  });

  it('is only counted off when it was actually switched off', () => {
    const schema = build(img2img);
    // Absent means on — a preset from last month has no opinion about it, and
    // the picture it was built around should keep arriving.
    expect(imageOffNodes(schema, {})).toEqual([]);
    expect(imageOffNodes(schema, { '1.__image': true })).toEqual([]);
    expect(imageOffNodes(schema, { '1.__image': false })).toEqual(['1']);
  });
});

describe('taking the picture out of the graph', () => {
  /** `VAEEncode.pixels` is required; a chat node's `image` is not. */
  const optionalConsumer: ObjectInfo = {
    Chat: { input: { required: { text: ['STRING'] }, optional: { image: ['IMAGE'] } } },
    LoadImage: { input: { required: { image: ['STRING', { image_upload: true }] } } },
  };

  const withOptional: ApiWorkflow = {
    '1': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
    '2': { class_type: 'Chat', inputs: { text: 'hello', image: ['1', 0] } },
  };

  it('removes the link, and leaves everything else alone', () => {
    const { workflow, error } = applyImageOff(withOptional, ['1'], optionalConsumer);
    expect(error).toBeUndefined();
    // The consumer sees an input that is simply not there — exactly what it
    // would see if nothing had ever been connected.
    expect(workflow['2']!.inputs).toEqual({ text: 'hello' });
    // The loader is untouched; it is merely unreachable, so it never runs.
    expect(workflow['1']).toEqual(withOptional['1']);
  });

  it('does not touch the graph it was given', () => {
    applyImageOff(withOptional, ['1'], optionalConsumer);
    expect(withOptional['2']!.inputs.image).toEqual(['1', 0]);
  });

  it('changes nothing when nothing is switched off', () => {
    const { workflow } = applyImageOff(withOptional, [], optionalConsumer);
    expect(workflow).toBe(withOptional);
  });

  it('refuses when the picture is required, and says which node needs it', () => {
    /*
     * Checked here rather than left to ComfyUI, which answers a missing
     * required input with an error naming the input and not the switch that
     * caused it — true, and no help to somebody who just turned something off.
     */
    const { workflow, error } = applyImageOff(img2img, ['1'], objectInfoFixture);
    expect(error).toContain('VAEEncode');
    expect(error).toContain('pixels');
    // And nothing is changed on the way to refusing.
    expect(workflow).toBe(img2img);
  });

  it('unplugs every link into the same picture, not just the first', () => {
    const twice: ApiWorkflow = {
      '1': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
      '2': { class_type: 'Chat', inputs: { text: 'a', image: ['1', 0] } },
      '3': { class_type: 'Chat', inputs: { text: 'b', image: ['1', 0] } },
    };
    const { workflow } = applyImageOff(twice, ['1'], optionalConsumer);
    expect(workflow['2']!.inputs.image).toBeUndefined();
    expect(workflow['3']!.inputs.image).toBeUndefined();
  });

  it('unplugs anyway when the node type is unknown', () => {
    // Refusing a switch that would probably have worked is the worse failure:
    // ComfyUI's own error is then the honest one.
    const { workflow, error } = applyImageOff(withOptional, ['1'], {});
    expect(error).toBeUndefined();
    expect(workflow['2']!.inputs.image).toBeUndefined();
  });
});
