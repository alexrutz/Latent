import { describe, expect, it } from 'vitest';

import {
  findEditOrigins,
  originTagOf,
  referenceOrigin,
  splitInputImage,
} from './editOrigin.js';
import { objectInfoFixture } from './fixtures/objectInfo.js';
import { editWithReference, img2img, sd15Txt2Img } from './fixtures/workflows.js';
import { buildParamSchema } from './paramSchema.js';

const edit = buildParamSchema(editWithReference, objectInfoFixture);
const plainImg2Img = buildParamSchema(img2img, objectInfoFixture);
const txt2img = buildParamSchema(sd15Txt2Img, objectInfoFixture);

describe('the tag in a node title', () => {
  it('reads the bracketed word, whatever the case', () => {
    expect(originTagOf('Input Image [Reference]')).toBe('reference');
    expect(originTagOf('Input Image [CONTEXT]')).toBe('context');
    expect(originTagOf('Input Image [ reference ]')).toBe('reference');
  });

  it('takes the last group, so brackets used for something else still work', () => {
    expect(originTagOf('LoadImage (batch) [2] [Reference]')).toBe('reference');
  });

  it('is nothing at all for an untagged title', () => {
    expect(originTagOf('Load Image')).toBeNull();
    expect(originTagOf('Input Image []')).toBeNull();
  });
});

describe('splitting a LoadImage value', () => {
  it('keeps a bare filename as one', () => {
    expect(splitInputImage('portrait.png')).toEqual({ filename: 'portrait.png', subfolder: '' });
  });

  it('splits the subfolder ComfyUI addresses an upload by', () => {
    expect(splitInputImage('poses/standing.png')).toEqual({
      filename: 'standing.png',
      subfolder: 'poses',
    });
  });

  it('takes the annotation off a value copied out of ComfyUI', () => {
    expect(splitInputImage('portrait.png [input]')).toEqual({
      filename: 'portrait.png',
      subfolder: '',
    });
  });

  it('refuses a path that climbs out of the input directory', () => {
    expect(splitInputImage('../../etc/passwd')).toBeNull();
    expect(splitInputImage('/etc/passwd')).toBeNull();
  });

  it('is nothing for an empty value', () => {
    expect(splitInputImage('   ')).toBeNull();
  });
});

describe('finding what an edit was made from', () => {
  it('reads both pictures, reference first', () => {
    expect(findEditOrigins(edit, {})).toEqual([
      {
        role: 'reference',
        fieldId: '1.image',
        nodeTitle: 'Input Image [Reference]',
        filename: 'example.png',
        subfolder: '',
      },
      {
        role: 'context',
        fieldId: '2.image',
        nodeTitle: 'Input Image [Context]',
        filename: 'standing.png',
        subfolder: 'poses',
      },
    ]);
  });

  it('follows what was actually submitted, not what the graph shipped with', () => {
    const origins = findEditOrigins(edit, { '1.image': 'latent_abc_photo.jpg' });
    expect(referenceOrigin(origins)?.filename).toBe('latent_abc_photo.jpg');
  });

  /*
   * The whole reason this is a lookup and not an assumption. An edit workflow
   * that has not been labelled has not said which of its pictures is the
   * origin, and a plain img2img has one input that may be anything at all.
   */
  it('finds nothing in a workflow whose image inputs are untitled', () => {
    expect(findEditOrigins(plainImg2Img, {})).toEqual([]);
  });

  it('finds nothing in a workflow with no picture going in', () => {
    expect(findEditOrigins(txt2img, {})).toEqual([]);
  });

  it('drops an input whose picture was cleared', () => {
    expect(findEditOrigins(edit, { '1.image': '', '2.image': '' })).toEqual([]);
  });

  it('has no reference when only the context is tagged', () => {
    const contextOnly = buildParamSchema(
      { ...editWithReference, '1': { ...editWithReference['1']!, _meta: { title: 'Load Image' } } },
      objectInfoFixture,
    );
    const origins = findEditOrigins(contextOnly, {});
    expect(origins.map((origin) => origin.role)).toEqual(['context']);
    expect(referenceOrigin(origins)).toBeNull();
  });
});
