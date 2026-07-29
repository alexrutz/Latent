import { describe, expect, it } from 'vitest';

import {
  formatLoraTag,
  hasLoraTags,
  parseLoraTags,
  removeLoraTag,
  serializeLoraTags,
  updateLoraTag,
} from './loraTags.js';

describe('hasLoraTags', () => {
  it('recognises tags and ignores look-alikes', () => {
    expect(hasLoraTags('a castle <lora:style:0.8>')).toBe(true);
    expect(hasLoraTags('a castle')).toBe(false);
    expect(hasLoraTags('<not-a-lora:style:0.8>')).toBe(false);
    expect(hasLoraTags('lora:style:0.8')).toBe(false);
  });

  it('is not affected by a previous call (no lastIndex leakage)', () => {
    const text = '<lora:a:1>';
    expect(hasLoraTags(text)).toBe(true);
    expect(hasLoraTags(text)).toBe(true);
    expect(hasLoraTags(text)).toBe(true);
  });
});

describe('parseLoraTags', () => {
  it('pulls a single tag out and leaves the prose behind', () => {
    const result = parseLoraTags('a misty forest <lora:filmGrain:0.65>');
    expect(result.tags).toEqual([{ name: 'filmGrain', strength: 0.65 }]);
    expect(result.text).toBe('a misty forest');
    expect(result.hasTags).toBe(true);
  });

  it('handles several tags anywhere in the text', () => {
    const result = parseLoraTags('<lora:a:1> a castle <lora:b:0.5> at dusk');
    expect(result.tags).toEqual([
      { name: 'a', strength: 1 },
      { name: 'b', strength: 0.5 },
    ]);
    expect(result.text).toBe('a castle at dusk');
  });

  it('reads a separate CLIP strength, but only when it differs', () => {
    expect(parseLoraTags('<lora:x:0.8:0.4>').tags[0]).toEqual({
      name: 'x',
      strength: 0.8,
      clipStrength: 0.4,
    });
    // A redundant CLIP strength would show a pointless second slider.
    expect(parseLoraTags('<lora:x:0.8:0.8>').tags[0]).toEqual({ name: 'x', strength: 0.8 });
  });

  it('accepts negative and bare-decimal strengths', () => {
    expect(parseLoraTags('<lora:x:-0.3>').tags[0]?.strength).toBe(-0.3);
    expect(parseLoraTags('<lora:x:.5>').tags[0]?.strength).toBe(0.5);
    expect(parseLoraTags('<lora:x:2>').tags[0]?.strength).toBe(2);
  });

  it('keeps names containing paths and file extensions intact', () => {
    expect(parseLoraTags('<lora:styles/pixel_art_xl.safetensors:1>').tags[0]?.name).toBe(
      'styles/pixel_art_xl.safetensors',
    );
  });

  it('leaves malformed tags alone rather than mangling them', () => {
    const result = parseLoraTags('a castle <lora:broken> and <lora::0.5>');
    expect(result.tags).toEqual([]);
    expect(result.text).toBe('a castle <lora:broken> and <lora::0.5>');
    expect(result.hasTags).toBe(false);
  });

  it('tidies the whitespace and commas a removed tag leaves behind', () => {
    expect(parseLoraTags('a castle, <lora:a:1>, at dusk').text).toBe('a castle, at dusk');
    expect(parseLoraTags('<lora:a:1>').text).toBe('');
    expect(parseLoraTags('  <lora:a:1>  sunset  ').text).toBe('sunset');
  });

  it('survives non-string input', () => {
    expect(parseLoraTags(undefined as unknown as string).tags).toEqual([]);
    expect(parseLoraTags(null as unknown as string).text).toBe('');
  });
});

describe('formatLoraTag', () => {
  it('renders a tag, trimming pointless trailing zeros', () => {
    expect(formatLoraTag({ name: 'x', strength: 0.8 })).toBe('<lora:x:0.8>');
    expect(formatLoraTag({ name: 'x', strength: 1 })).toBe('<lora:x:1>');
    expect(formatLoraTag({ name: 'x', strength: 0.8, clipStrength: 0.4 })).toBe('<lora:x:0.8:0.4>');
  });

  it('omits a CLIP strength equal to the model strength', () => {
    expect(formatLoraTag({ name: 'x', strength: 0.5, clipStrength: 0.5 })).toBe('<lora:x:0.5>');
  });
});

describe('serializeLoraTags', () => {
  it('appends tags after the prose', () => {
    expect(serializeLoraTags('a castle', [{ name: 'a', strength: 1 }])).toBe(
      'a castle <lora:a:1>',
    );
  });

  it('replaces existing tags rather than accumulating them', () => {
    const original = 'a castle <lora:old:1>';
    expect(serializeLoraTags(original, [{ name: 'new', strength: 0.5 }])).toBe(
      'a castle <lora:new:0.5>',
    );
  });

  it('removes every tag when the list is emptied', () => {
    expect(serializeLoraTags('a castle <lora:a:1> <lora:b:1>', [])).toBe('a castle');
  });

  it('round-trips: parse then serialize is a no-op on canonical text', () => {
    const text = 'a castle at dusk <lora:a:0.8> <lora:b:0.5:0.2>';
    const { tags, text: prose } = parseLoraTags(text);
    expect(serializeLoraTags(prose, tags)).toBe(text);
  });

  it('preserves prose when there was never a tag', () => {
    expect(serializeLoraTags('just words', [])).toBe('just words');
  });
});

describe('tag list helpers', () => {
  const tags = [
    { name: 'a', strength: 1 },
    { name: 'b', strength: 0.5 },
  ];

  it('updates one tag without touching the others or the source array', () => {
    const next = updateLoraTag(tags, 1, { strength: 0.9 });
    expect(next).toEqual([
      { name: 'a', strength: 1 },
      { name: 'b', strength: 0.9 },
    ]);
    expect(tags[1]?.strength).toBe(0.5);
  });

  it('removes by index', () => {
    expect(removeLoraTag(tags, 0)).toEqual([{ name: 'b', strength: 0.5 }]);
  });
});
