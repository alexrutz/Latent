import { describe, expect, it } from 'vitest';

import type { PromptBlock } from './apiTypes.js';
import {
  composeRandomPrompt,
  DEFAULT_RANDOM_PROMPT_CONFIG,
  groupLimitFor,
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
    expect(older.groupLimits).toEqual({});
  });

  it('lower-cases group keys and drops limits that make no sense', () => {
    const result = normaliseRandomPromptConfig({
      groupLimits: { ' Place ': 1, ATMOSPHERE: '3', Broken: 'lots', Negative: -2 },
    });
    expect(result.groupLimits).toEqual({ place: 1, atmosphere: 3 });
  });

  it('ignores a groupLimits that is not an object', () => {
    expect(normaliseRandomPromptConfig({ groupLimits: ['nope'] }).groupLimits).toEqual({});
    expect(normaliseRandomPromptConfig({ groupLimits: 5 }).groupLimits).toEqual({});
  });
});

describe('groupLimitFor', () => {
  it('follows the global default for a group with no setting', () => {
    expect(groupLimitFor(config({ onePerGroup: true }), 'Lighting')).toBe(1);
    expect(groupLimitFor(config({ onePerGroup: false }), 'Lighting')).toBe(0);
  });

  it('lets an explicit setting beat the default in both directions', () => {
    expect(groupLimitFor(config({ onePerGroup: true, groupLimits: { mood: 3 } }), 'Mood')).toBe(3);
    expect(groupLimitFor(config({ onePerGroup: false, groupLimits: { place: 1 } }), 'Place')).toBe(1);
  });

  it('leaves ungrouped blocks unlimited unless told otherwise', () => {
    expect(groupLimitFor(config({ onePerGroup: true }), '')).toBe(0);
    expect(groupLimitFor(config({ groupLimits: { '': 2 } }), '')).toBe(2);
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

  /**
   * The distinction the per-group limit exists for: exactly one block should say
   * where the picture is, while several can say what it feels like.
   */
  it('honours a per-group limit over the global default', () => {
    const scene = [
      block('p1', 'Iceland', 'a black sand beach', 'Place', 0),
      block('p2', 'Kyoto', 'a temple garden', 'Place', 1),
      block('a1', 'Misty', 'low fog', 'Atmosphere', 2),
      block('a2', 'Brooding', 'heavy clouds', 'Atmosphere', 3),
      block('a3', 'Still', 'not a breath of wind', 'Atmosphere', 4),
    ];

    const drawn = pickRandomBlocks(
      scene,
      // Global default is one per group; Atmosphere is allowed three.
      config({ minBlocks: 5, maxBlocks: 5, groupLimits: { atmosphere: 3 } }),
      '',
      rng(0.5),
    );

    const places = drawn.filter((b) => b.category === 'Place');
    const atmosphere = drawn.filter((b) => b.category === 'Atmosphere');
    expect(places).toHaveLength(1);
    expect(atmosphere).toHaveLength(3);
  });

  it('treats a group limit of zero as no limit at all', () => {
    const scene = [
      block('a1', 'One', 'one', 'Atmosphere', 0),
      block('a2', 'Two', 'two', 'Atmosphere', 1),
      block('a3', 'Three', 'three', 'Atmosphere', 2),
    ];
    const drawn = pickRandomBlocks(
      scene,
      config({ minBlocks: 3, maxBlocks: 3, groupLimits: { atmosphere: 0 } }),
      '',
      rng(0.5),
    );
    expect(drawn).toHaveLength(3);
  });

  it('matches a group whatever case it was typed in', () => {
    const scene = [
      block('p1', 'A', 'a', 'Place', 0),
      block('p2', 'B', 'b', 'PLACE', 1),
      block('p3', 'C', 'c', 'place', 2),
    ];
    const drawn = pickRandomBlocks(
      scene,
      config({ minBlocks: 3, maxBlocks: 3, groupLimits: { Place: 1 } }),
      '',
      rng(0.5),
    );
    expect(drawn).toHaveLength(1);
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

describe('an unlimited draw', () => {
  const library = [
    { id: '1', name: 'a', category: 'Mood', text: 'one', position: 0, createdAt: 0 },
    { id: '2', name: 'b', category: 'Place', text: 'two', position: 1, createdAt: 0 },
    { id: '3', name: 'c', category: 'Camera', text: 'three', position: 2, createdAt: 0 },
  ];

  it('takes everything the pool and the group limits allow', () => {
    const config = normaliseRandomPromptConfig({
      enabled: true,
      minBlocks: 1,
      maxBlocks: 0,
      onePerGroup: true,
    });
    expect(config.maxBlocks).toBe(0);

    // A lifted ceiling is still a range: one to all three.
    const sizes = new Set<number>();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      sizes.add(pickRandomBlocks(library, config, '').length);
    }
    expect(Math.max(...sizes)).toBe(3);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1);
  });

  it('takes all of them when the floor is unlimited too', () => {
    const config = normaliseRandomPromptConfig({
      enabled: true,
      minBlocks: 0,
      maxBlocks: 0,
      onePerGroup: true,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(pickRandomBlocks(library, config, '')).toHaveLength(3);
    }
  });

  it('still respects the group limits when unlimited', () => {
    const sameGroup = library.map((block) => ({ ...block, category: 'Mood' }));
    const config = normaliseRandomPromptConfig({
      enabled: true,
      minBlocks: 1,
      maxBlocks: 0,
      onePerGroup: true,
    });
    // One per group is one, however many the draw is allowed to take.
    expect(pickRandomBlocks(sameGroup, config, '')).toHaveLength(1);
  });
});
