import { describe, expect, it } from 'vitest';

import type { PromptBlock } from './apiTypes.js';
import {
  composeRandomPrompt,
  DEFAULT_RANDOM_PROMPT_CONFIG,
  normaliseRandomPromptConfig,
  pickRandomBlocks,
  randomPromptPool,
  rollRandomPrompt,
  type RandomPromptConfig,
} from './randomPrompt.js';

function block(
  id: string,
  name: string,
  text: string,
  category = '',
  position = 0,
): PromptBlock {
  return { id, name, text, category, position, createdAt: 0 };
}

/** Deterministic RNG: replays a fixed sequence, then repeats its last value. */
function rng(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

const library = [
  block('a', 'Golden hour', 'warm rim light, long shadows', 'Lighting', 0),
  block('b', 'Blue hour', 'cool ambient light', 'Lighting', 1),
  block('c', '35mm', 'shot on 35mm, shallow depth of field', 'Camera', 2),
  block('d', 'Ilford', 'black and white film grain', 'Film', 3),
];

const config = (patch: Partial<RandomPromptConfig> = {}): RandomPromptConfig => ({
  ...DEFAULT_RANDOM_PROMPT_CONFIG,
  enabled: true,
  ...patch,
});

describe('normaliseRandomPromptConfig', () => {
  it('fills in a config from nothing', () => {
    expect(normaliseRandomPromptConfig(undefined)).toEqual(DEFAULT_RANDOM_PROMPT_CONFIG);
  });

  it('swaps a reversed range rather than rejecting it', () => {
    const result = normaliseRandomPromptConfig({ minBlocks: 5, maxBlocks: 2 });
    expect(result.minBlocks).toBe(2);
    expect(result.maxBlocks).toBe(5);
  });

  it('survives values that were hand-edited into nonsense', () => {
    const result = normaliseRandomPromptConfig({
      enabled: 'yes',
      blockIds: ['a', '', 'a', 7, null],
      minBlocks: 'lots',
      maxBlocks: 1e9,
    });
    // A truthy non-boolean is not `true`; only an explicit boolean enables it.
    expect(result.enabled).toBe(false);
    expect(result.blockIds).toEqual(['a']);
    expect(result.minBlocks).toBe(2);
    // Bounded, so a bad number cannot build a 500-part prompt.
    expect(result.maxBlocks).toBe(24);
  });

  it('treats the two coherence options as opt-out, not opt-in', () => {
    // A config stored before these fields existed must keep the sane behaviour.
    const older = normaliseRandomPromptConfig({ enabled: true, minBlocks: 1, maxBlocks: 1 });
    expect(older.keepTyped).toBe(true);
    expect(older.onePerGroup).toBe(true);
  });
});

describe('randomPromptPool', () => {
  it('is the whole library when no pool is set', () => {
    expect(randomPromptPool(library, config())).toHaveLength(4);
  });

  it('narrows to the chosen blocks', () => {
    expect(randomPromptPool(library, config({ blockIds: ['b', 'd'] })).map((b) => b.id)).toEqual([
      'b',
      'd',
    ]);
  });

  it('ignores ids for blocks that have since been deleted', () => {
    const pool = randomPromptPool(library, config({ blockIds: ['a', 'gone'] }));
    expect(pool.map((b) => b.id)).toEqual(['a']);
  });
});

describe('pickRandomBlocks', () => {
  it('draws between the configured bounds', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const drawn = pickRandomBlocks(library, config({ minBlocks: 1, maxBlocks: 2, onePerGroup: false }), '', () =>
        ((seed * 37) % 100) / 100,
      );
      expect(drawn.length).toBeGreaterThanOrEqual(1);
      expect(drawn.length).toBeLessThanOrEqual(2);
    }
  });

  /**
   * The reason groups exist. Two lighting blocks in one prompt fight each other,
   * and the groups already in the library are what stops that happening.
   */
  it('takes at most one block per group', () => {
    const drawn = pickRandomBlocks(library, config({ minBlocks: 4, maxBlocks: 4 }), '', rng(0.99));
    const groups = drawn.map((b) => b.category);
    expect(new Set(groups).size).toBe(groups.length);
    // Lighting has two candidates, so a four-block draw can only reach three.
    expect(drawn).toHaveLength(3);
  });

  it('lets ungrouped blocks coexist, since nothing says they conflict', () => {
    const loose = [
      block('x', 'One', 'one', '', 0),
      block('y', 'Two', 'two', '', 1),
      block('z', 'Three', 'three', '', 2),
    ];
    const drawn = pickRandomBlocks(loose, config({ minBlocks: 3, maxBlocks: 3 }), '', rng(0.5));
    expect(drawn).toHaveLength(3);
  });

  it('never draws a block whose text is already typed', () => {
    const drawn = pickRandomBlocks(
      library,
      config({ minBlocks: 4, maxBlocks: 4, onePerGroup: false }),
      'a portrait, warm rim light, long shadows',
      rng(0.5),
    );
    expect(drawn.map((b) => b.id)).not.toContain('a');
  });

  it('reinstates the library order, so the prompt reads the way you arranged it', () => {
    const drawn = pickRandomBlocks(
      library,
      config({ minBlocks: 4, maxBlocks: 4, onePerGroup: false }),
      '',
      rng(0.9, 0.1, 0.7, 0.3),
    );
    expect(drawn.map((b) => b.position)).toEqual([...drawn.map((b) => b.position)].sort((a, b) => a - b));
  });

  it('draws nothing from an empty pool instead of throwing', () => {
    expect(pickRandomBlocks([], config())).toEqual([]);
    expect(pickRandomBlocks(library, config({ blockIds: ['nope'] }))).toEqual([]);
  });

  it('skips blocks with no text', () => {
    const drawn = pickRandomBlocks(
      [block('empty', 'Empty', '   ', 'X', 0)],
      config({ minBlocks: 1, maxBlocks: 1 }),
    );
    expect(drawn).toEqual([]);
  });

  it('clamps a draw larger than the pool', () => {
    const drawn = pickRandomBlocks(
      library,
      config({ minBlocks: 10, maxBlocks: 10, onePerGroup: false }),
      '',
      rng(0.5),
    );
    expect(drawn).toHaveLength(4);
  });
});

describe('composeRandomPrompt', () => {
  it('appends to what is typed', () => {
    const result = composeRandomPrompt('a portrait', [library[0]!, library[2]!], true);
    expect(result).toBe(
      'a portrait, warm rim light, long shadows, shot on 35mm, shallow depth of field',
    );
  });

  it('replaces what is typed when told to', () => {
    expect(composeRandomPrompt('a portrait', [library[1]!], false)).toBe('cool ambient light');
  });

  /**
   * Replacing with nothing would submit a blank prompt — which is never what
   * anyone meant by "build it from my blocks".
   */
  it('keeps the typed prompt when the draw came up empty, even in replace mode', () => {
    expect(composeRandomPrompt('a portrait', [], false)).toBe('a portrait');
  });

  it('does not duplicate a phrase the typed prompt already has', () => {
    const result = composeRandomPrompt('cool ambient light, a portrait', [library[1]!], true);
    expect(result).toBe('cool ambient light, a portrait');
  });
});

describe('rollRandomPrompt', () => {
  it('reports which blocks it used, so a good result can be traced back', () => {
    const roll = rollRandomPrompt(library, config({ minBlocks: 2, maxBlocks: 2 }), 'a portrait', rng(0.4));
    expect(roll.blocks).toHaveLength(2);
    for (const used of roll.blocks) expect(roll.prompt).toContain(used.text.split(',')[0]!.trim());
    expect(roll.prompt.startsWith('a portrait')).toBe(true);
  });

  it('produces different prompts on different draws — the entire point', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      seen.add(rollRandomPrompt(library, config({ minBlocks: 1, maxBlocks: 2 }), '').prompt);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
