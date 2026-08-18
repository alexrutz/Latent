import { describe, expect, it } from 'vitest';

import {
  contentTypeOf,
  formatDuration,
  isVideoOutputClass,
  mediaKindFor,
  mediaKindOf,
  playsInVideoElement,
  producesVideo,
} from './media.js';

describe('what an output is', () => {
  it('reads the file, not the key it arrived under', () => {
    // Core ComfyUI files a rendered video under `images`, so the key says
    // nothing; the extension is the one thing every node pack is honest about.
    expect(mediaKindOf('LTXV_00001.webm')).toBe('video');
    expect(mediaKindOf('LTXV_00001.mp4')).toBe('video');
    expect(mediaKindOf('ComfyUI_00001_.png')).toBe('image');
    expect(mediaKindOf('upscaled.JPEG')).toBe('image');
    // No extension at all is a picture, which is what everything was before.
    expect(mediaKindOf('mystery')).toBe('image');
  });

  it('believes a node that names its own format', () => {
    expect(mediaKindFor('clip.mkv2', 'video/h264-mp4')).toBe('video');
    expect(mediaKindFor('render.png', 'image/png')).toBe('image');
  });

  /**
   * A GIF moves and is still drawn by an `<img>`.
   *
   * So it is a video for every decision about handling — no still-image
   * resizing, no img2img, a badge on the tile — and an image for how it is put
   * on screen. Handing one to a `<video>` element shows nothing at all.
   */
  it('separates what moves from what needs a video element', () => {
    expect(mediaKindOf('anim.gif')).toBe('video');
    expect(playsInVideoElement('anim.gif')).toBe(false);
    expect(playsInVideoElement('clip.webm')).toBe(true);
    expect(playsInVideoElement('still.png')).toBe(false);
  });

  it('serves each container as itself', () => {
    expect(contentTypeOf('a.webm')).toBe('video/webm');
    expect(contentTypeOf('a.mp4')).toBe('video/mp4');
    expect(contentTypeOf('a.gif')).toBe('image/gif');
    expect(contentTypeOf('a.jpg')).toBe('image/jpeg');
    expect(contentTypeOf('a.png')).toBe('image/png');
  });
});

describe('how long it runs', () => {
  it('counts seconds for a clip and clock time for anything longer', () => {
    expect(formatDuration(4000)).toBe('4s');
    expect(formatDuration(59_400)).toBe('59s');
    expect(formatDuration(67_000)).toBe('1:07');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  it('says nothing when nothing has measured it', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});

describe('a workflow that ends in a clip', () => {
  it('recognises the savers, whichever pack they come from', () => {
    expect(isVideoOutputClass('SaveWEBM')).toBe(true);
    expect(isVideoOutputClass('SaveVideo')).toBe(true);
    expect(isVideoOutputClass('VHS_VideoCombine')).toBe(true);
    expect(isVideoOutputClass('SaveAnimatedWEBP')).toBe(true);
    expect(isVideoOutputClass('SaveImage')).toBe(false);
    expect(isVideoOutputClass('PreviewImage')).toBe(false);
  });

  it('answers for a whole graph, before anything has run', () => {
    expect(
      producesVideo({ '1': { class_type: 'KSampler' }, '2': { class_type: 'SaveWEBM' } }),
    ).toBe(true);
    expect(
      producesVideo({ '1': { class_type: 'KSampler' }, '2': { class_type: 'SaveImage' } }),
    ).toBe(false);
    expect(producesVideo({})).toBe(false);
  });
});
