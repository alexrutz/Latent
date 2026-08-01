import type { PromptBlock } from './apiTypes.js';
import { normaliseRandomParams, type RandomParamRule } from './randomParams.js';
import { addFragment, promptContainsFragment } from './promptFragments.js';

/**
 * Building a prompt from a random draw of saved blocks.
 *
 * The point is variation you did not have to think of. Once you have a library of
 * phrases, the interesting thing to do with it is not picking four by hand — it is
 * letting the machine pick four and seeing what comes out, over and over, without
 * touching the keyboard between runs.
 *
 * Two decisions shape the whole design:
 *
 * 1. **The draw happens once per queued item, on the server.** Rolling in the
 *    browser would give a batch of eight the same prompt eight times, which is
 *    the opposite of what this is for.
 * 2. **At most one block per group, by default.** Blocks are grouped (Lighting,
 *    Camera, Style), and two lighting blocks in one prompt fight each other. The
 *    groups you already made are the constraint that keeps a random prompt
 *    coherent instead of mush.
 *
 * Pure: no I/O, no React, and the RNG is injected so tests are deterministic.
 */

export interface RandomPromptConfig {
  /** Whether a queued run draws its prompt instead of using what is typed. */
  enabled: boolean;
  /**
   * Block ids the draw is narrowed to. Empty means the whole library.
   *
   * Ids rather than names, and unknown ids are simply ignored — deleting a block
   * must not break a saved pool.
   */
  blockIds: string[];
  /** How many blocks go into one prompt. Inclusive. */
  minBlocks: number;
  maxBlocks: number;
  /** Keep what is typed and add to it, rather than replacing it entirely. */
  keepTyped: boolean;
  /**
   * Default limit for a group that has no explicit one: at most one block, or
   * unlimited. The starting point, not the last word — see `groupLimits`.
   */
  onePerGroup: boolean;
  /**
   * Per-group override: how many blocks that group may contribute. `0` means no
   * limit.
   *
   * Groups do not all behave the same way. Exactly one block should describe the
   * *place*, or the picture is set in two countries at once — but three blocks
   * describing the *atmosphere* stack up perfectly well, and forbidding that
   * throws away most of the variation the mode exists to produce. Keyed by the
   * group name, lower-cased, so renaming case does not orphan the setting.
   */
  groupLimits: Record<string, number>;
  /**
   * Numeric parameters to draw from a range, alongside the prompt.
   *
   * Lives here, in what the name still calls the *prompt* config, because the two
   * are one setup in use: "this kind of picture, made this way". They are saved,
   * loaded and switched on together, so splitting them into two stored objects
   * would only create a way for them to disagree.
   */
  params: RandomParamRule[];
  /**
   * Blocks appended to every prompt, drawn or typed.
   *
   * The phrases that improve more or less any picture — a quality tail, a
   * house style — are not variation, they are part of what you always ask for,
   * and retyping or re-tapping them every time is exactly the tedium blocks
   * exist to remove. Applied whether or not the random draw is switched on.
   */
  alwaysBlockIds: string[];
}

export const DEFAULT_RANDOM_PROMPT_CONFIG: RandomPromptConfig = {
  enabled: false,
  blockIds: [],
  minBlocks: 2,
  maxBlocks: 4,
  keepTyped: true,
  onePerGroup: true,
  groupLimits: {},
  params: [],
  alwaysBlockIds: [],
};

/** Blocks with no group at all, which never exclude one another by default. */
export const UNGROUPED_KEY = '';

/**
 * How many blocks this group may contribute. `0` means no limit.
 *
 * An explicit per-group setting always wins. Without one, a named group follows
 * the global default, and ungrouped blocks are unlimited — nothing about them
 * says they conflict.
 */
export function groupLimitFor(config: RandomPromptConfig, group: string): number {
  const key = normaliseGroupKey(group);
  const explicit = config.groupLimits[key];
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return Math.max(0, explicit);
  if (key === UNGROUPED_KEY) return 0;
  return config.onePerGroup ? 1 : 0;
}

export function normaliseGroupKey(group: string): string {
  return group.trim().toLowerCase();
}

/** Sanity bound on the draw size, so a bad value cannot build a 500-part prompt. */
const MAX_BLOCKS_PER_PROMPT = 24;

/**
 * Coerce whatever came out of the database or off the wire into a usable config.
 *
 * Called on both read and write. A stored value can predate a field, and a
 * hand-edited one can be nonsense; neither should be able to crash a render.
 */
export function normaliseRandomPromptConfig(raw: unknown): RandomPromptConfig {
  const input = (raw ?? {}) as Partial<Record<keyof RandomPromptConfig, unknown>>;

  const min = clampCount(input.minBlocks, DEFAULT_RANDOM_PROMPT_CONFIG.minBlocks);
  const max = clampCount(input.maxBlocks, DEFAULT_RANDOM_PROMPT_CONFIG.maxBlocks);

  return {
    enabled: input.enabled === true,
    alwaysBlockIds: Array.isArray(input.alwaysBlockIds)
      ? [
          ...new Set(
            input.alwaysBlockIds.filter((id): id is string => typeof id === 'string' && id !== ''),
          ),
        ]
      : DEFAULT_RANDOM_PROMPT_CONFIG.alwaysBlockIds,
    blockIds: Array.isArray(input.blockIds)
      ? [...new Set(input.blockIds.filter((id): id is string => typeof id === 'string' && id !== ''))]
      : [],
    // Swapped rather than rejected: "between 4 and 2" plainly means 2 to 4.
    minBlocks: Math.min(min, max),
    maxBlocks: Math.max(min, max),
    keepTyped: input.keepTyped !== false,
    onePerGroup: input.onePerGroup !== false,
    groupLimits: normaliseGroupLimits(input.groupLimits),
    params: normaliseRandomParams(input.params),
  };
}

function normaliseGroupLimits(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const limits: Record<string, number> = {};
  for (const [group, value] of Object.entries(raw as Record<string, unknown>)) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    limits[normaliseGroupKey(group)] = Math.min(Math.round(numeric), MAX_BLOCKS_PER_PROMPT);
  }
  return limits;
}

function clampCount(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), 0), MAX_BLOCKS_PER_PROMPT);
}

/** The blocks eligible for a draw, after the pool has been narrowed. */
export function randomPromptPool(
  blocks: PromptBlock[],
  config: RandomPromptConfig,
): PromptBlock[] {
  if (config.blockIds.length === 0) return blocks;
  const wanted = new Set(config.blockIds);
  return blocks.filter((block) => wanted.has(block.id));
}

/**
 * Draw the blocks for one prompt.
 *
 * `base` is what is already typed: anything it already contains is excluded, so a
 * draw never appends a phrase that is sitting there twenty characters earlier.
 */
export function pickRandomBlocks(
  blocks: PromptBlock[],
  config: RandomPromptConfig,
  base = '',
  random: () => number = Math.random,
): PromptBlock[] {
  const pool = randomPromptPool(blocks, config).filter(
    (block) => block.text.trim() !== '' && !promptContainsFragment(base, block.text),
  );
  if (pool.length === 0) return [];

  const shuffled = shuffle(pool, random);

  /*
   * Apply each group's limit. One block may describe the place; several may
   * describe the atmosphere. Which is which is the user's call, per group.
   */
  const candidates: PromptBlock[] = [];
  const used = new Map<string, number>();
  for (const block of shuffled) {
    const key = normaliseGroupKey(block.category);
    const limit = groupLimitFor(config, key);
    if (limit > 0) {
      const count = used.get(key) ?? 0;
      if (count >= limit) continue;
      used.set(key, count + 1);
    }
    candidates.push(block);
  }

  const span = config.maxBlocks - config.minBlocks + 1;
  const wanted = config.minBlocks + Math.floor(random() * span);
  const count = Math.min(Math.max(wanted, 0), candidates.length);

  /*
   * Selection is random; arrangement is not. The library's own order is
   * reinstated so the prompt reads the way you organised it — subject before
   * lighting before camera — rather than shuffling the meaning too.
   */
  return candidates.slice(0, count).sort((a, b) => a.position - b.position);
}

/**
 * Fold drawn blocks into a prompt.
 *
 * Kept separate from the draw so a workflow with two prompt fields (SDXL base and
 * refiner) can apply the *same* draw to each field's own text, instead of
 * describing two different pictures.
 */
export function composeRandomPrompt(
  base: string,
  drawn: PromptBlock[],
  keepTyped: boolean,
): string {
  /*
   * An empty draw keeps whatever was typed, even when told to replace it. The
   * alternative is submitting a blank prompt because the pool was empty, which is
   * never what anyone meant.
   */
  if (drawn.length === 0) return base;

  let prompt = keepTyped ? base : '';
  for (const block of drawn) prompt = addFragment(prompt, block.text);
  return prompt;
}

/**
 * Append the blocks that go on every prompt.
 *
 * Separate from the draw and applied after it: these are not variation, they
 * are the part of the request that never changes, and they have to land whether
 * the prompt was typed by hand or drawn. Already-present text is left alone, so
 * running twice cannot double a phrase.
 */
export function appendAlwaysBlocks(
  prompt: string,
  blocks: PromptBlock[],
  config: RandomPromptConfig,
): string {
  if (config.alwaysBlockIds.length === 0) return prompt;
  const wanted = new Set(config.alwaysBlockIds);

  let next = prompt;
  for (const block of blocks) {
    if (wanted.has(block.id)) next = addFragment(next, block.text);
  }
  return next;
}

export interface RandomPromptRoll {
  prompt: string;
  blocks: PromptBlock[];
}

/** Draw and compose in one step, for a single prompt field or a preview. */
export function rollRandomPrompt(
  blocks: PromptBlock[],
  config: RandomPromptConfig,
  base = '',
  random: () => number = Math.random,
): RandomPromptRoll {
  const drawn = pickRandomBlocks(blocks, config, base, random);
  return { prompt: composeRandomPrompt(base, drawn, config.keepTyped), blocks: drawn };
}

/** Fisher–Yates, so every ordering is equally likely and the RNG is injectable. */
function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}
