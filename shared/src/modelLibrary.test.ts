import { describe, expect, it } from 'vitest';

import {
  addWords,
  DEFAULT_LORA_STRENGTH,
  plainText,
  resolveWords,
  strengthFor,
  type ModelNote,
} from './modelLibrary.js';

const note = (partial: Partial<ModelNote>): ModelNote => ({
  folder: 'loras',
  name: 'style.safetensors',
  triggerWords: [],
  notes: '',
  strength: null,
  civitai: null,
  sha256: null,
  updatedAt: 0,
  ...partial,
});

describe('which words a model gets', () => {
  const file = { trainedTags: ['a woman', 'red jacket'] };

  it('prefers the ones you typed', () => {
    const yours = note({
      triggerWords: ['my own phrasing'],
      civitai: {
        modelId: 1,
        versionId: 2,
        name: null,
        versionName: null,
        baseModel: null,
        trainedWords: ['creator words'],
        description: null,
        url: null,
        fetchedAt: 0,
      },
    });
    expect(resolveWords(file, yours)).toEqual({ words: ['my own phrasing'], from: 'yours' });
  });

  it('falls back to the creator, then to the file itself', () => {
    const fromCivitai = note({
      civitai: {
        modelId: 1,
        versionId: 2,
        name: null,
        versionName: null,
        baseModel: null,
        trainedWords: ['creator words'],
        description: null,
        url: null,
        fetchedAt: 0,
      },
    });
    expect(resolveWords(file, fromCivitai)).toEqual({ words: ['creator words'], from: 'civitai' });
    expect(resolveWords(file, note({}))).toEqual({
      words: ['a woman', 'red jacket'],
      from: 'trained',
    });
    expect(resolveWords(file, null)).toEqual({ words: ['a woman', 'red jacket'], from: 'trained' });
  });

  it('says so rather than guessing when there is nothing', () => {
    expect(resolveWords({ trainedTags: [] }, null)).toEqual({ words: [], from: 'none' });
  });

  /*
   * A ranking, not a merge. Two creator words plus thirty training tags is not
   * a prompt, it is a word cloud, and it would be pasted into somebody's prompt.
   */
  it('never mixes two sources together', () => {
    const both = note({ triggerWords: ['mine'] });
    expect(resolveWords(file, both).words).toEqual(['mine']);
  });

  it('ignores blank entries left behind by an editor', () => {
    expect(resolveWords(file, note({ triggerWords: ['', '  '] })).from).toBe('trained');
  });
});

describe('the strength a LoRA is added at', () => {
  it('uses yours when you set one', () => {
    expect(strengthFor(note({ strength: 0.45 }))).toBe(0.45);
    expect(strengthFor(note({ strength: 0 }))).toBe(0);
  });

  it('falls back to the default, never to the training alpha', () => {
    expect(strengthFor(note({}))).toBe(DEFAULT_LORA_STRENGTH);
    expect(strengthFor(null)).toBe(DEFAULT_LORA_STRENGTH);
  });
});

describe('adding words to a prompt', () => {
  it('appends them, keeping the prompt in front', () => {
    expect(addWords('a lighthouse', ['storm', 'dusk'])).toBe('a lighthouse, storm, dusk');
  });

  it('starts the prompt when there is none', () => {
    expect(addWords('', ['storm'])).toBe('storm');
    expect(addWords('   ', ['storm'])).toBe('storm');
  });

  it('does not repeat what is already there, whatever the case', () => {
    expect(addWords('A Woman walks past', ['a woman', 'red jacket'])).toBe(
      'A Woman walks past, red jacket',
    );
    expect(addWords('storm', ['storm'])).toBe('storm');
  });

  /*
   * The failure nobody would ever diagnose: a trigger word silently skipped
   * because a longer word happens to contain it.
   */
  it('matches whole words, so "cat" is not found inside "delicate"', () => {
    expect(addWords('a delicate thing', ['cat'])).toBe('a delicate thing, cat');
    expect(addWords('scattered light', ['cat'])).toBe('scattered light, cat');
    // And a phrase that genuinely is there is still recognised.
    expect(addWords('one cat, two', ['cat'])).toBe('one cat, two');
  });

  it('continues a prompt that already ends in a comma', () => {
    expect(addWords('a lighthouse,', ['storm'])).toBe('a lighthouse, storm');
  });

  it('leaves the prompt alone when it has everything already', () => {
    expect(addWords('a woman in a red jacket', ['a woman'])).toBe('a woman in a red jacket');
  });
});

describe('reducing Civitai’s HTML to text', () => {
  it('keeps the words and the paragraph breaks', () => {
    expect(plainText('<p>Use at <strong>0.7</strong>.</p><p>Works with SDXL.</p>')).toBe(
      'Use at 0.7.\n\nWorks with SDXL.',
    );
  });

  it('turns a list into something readable', () => {
    expect(plainText('<ul><li>one</li><li>two</li></ul>')).toBe('• one\n• two');
  });

  it('unescapes the entities that survive', () => {
    expect(plainText('a &amp; b &quot;c&quot; &#39;d&#39; &lt;e&gt;')).toBe('a & b "c" \'d\' <e>');
  });

  it('is nothing for nothing', () => {
    expect(plainText(null)).toBeNull();
    expect(plainText('')).toBeNull();
    expect(plainText('<p></p>')).toBeNull();
  });

  it('truncates rather than pasting an essay under a name', () => {
    const long = plainText(`<p>${'word '.repeat(500)}</p>`, 50);
    // The limit plus the ellipsis, and less when the cut landed on a space.
    expect(long!.length).toBeLessThanOrEqual(51);
    expect(long!.length).toBeGreaterThan(40);
    expect(long?.endsWith('…')).toBe(true);
  });
});
