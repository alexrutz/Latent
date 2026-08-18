import type { WidgetValue } from './comfyTypes.js';

/**
 * Planning a parameter study.
 *
 * The random module varies parameters to keep a session interesting. This does
 * the opposite: it varies them *systematically*, so that afterwards you can say
 * which of them actually mattered. That difference is the whole design.
 *
 * Everything here is pure and seeded. A plan drawn from the same setup and the
 * same seed is the same plan — which is what makes a study you interrupted on
 * Tuesday resumable on Thursday, and what makes any of this testable.
 */

/* ------------------------------------------------------------------ */
/* Random numbers                                                      */
/* ------------------------------------------------------------------ */

/**
 * A seeded generator, because `Math.random()` cannot be reproduced.
 *
 * mulberry32: thirty-two bits of state, one multiply and a few shifts per
 * draw. It is not cryptographic and does not need to be — what it needs is to
 * give the same sequence twice and to have no visible structure in low
 * dimensions, which the usual `sin(seed)` trick badly fails at.
 */
export function makeRng(seed: number): () => number {
  let state = (seed | 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Distributions                                                       */
/* ------------------------------------------------------------------ */

/**
 * How the draws are spread across a numeric factor's range.
 *
 * Each is an inverse CDF over the unit interval, which is what lets the same
 * code serve both sampling methods: Latin hypercube supplies stratified
 * uniforms, simple random supplies plain ones, and the shape is applied after.
 */
export type StudyDistribution = 'uniform' | 'normal' | 'log-uniform' | 'triangular';

export const DISTRIBUTIONS: { value: StudyDistribution; label: string; hint: string }[] = [
  { value: 'uniform', label: 'Uniform', hint: 'every value equally likely' },
  { value: 'normal', label: 'Normal', hint: 'clustered around the middle' },
  {
    value: 'log-uniform',
    label: 'Log-uniform',
    hint: 'even across orders of magnitude',
  },
  { value: 'triangular', label: 'Triangular', hint: 'peaked at a value you choose' },
];

/**
 * The inverse normal CDF, by Acklam's rational approximation.
 *
 * Accurate to about 1.15e-9 across the whole interval, which is far more than a
 * study needs and much less code than an error-function implementation. Used
 * rather than summing uniforms, because a Box–Muller or twelve-uniform normal
 * cannot be driven by a *single* stratified draw — and losing the
 * stratification is losing the point of Latin hypercube sampling.
 */
function probit(p: number): number {
  const [a1, a2, a3, a4, a5, a6] = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const [b1, b2, b3, b4, b5] = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const [c1, c2, c3, c4, c5, c6] = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const [d1, d2, d3, d4] = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
  ];

  /** Where the central rational approximation gives way to the tail one. */
  const BREAK = 0.02425;
  const clamped = Math.min(Math.max(p, 1e-12), 1 - 1e-12);

  const tail = (q: number) =>
    (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
    ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);

  if (clamped < BREAK) return tail(Math.sqrt(-2 * Math.log(clamped)));
  if (clamped > 1 - BREAK) return -tail(Math.sqrt(-2 * Math.log(1 - clamped)));

  const q = clamped - 0.5;
  const r = q * q;
  return (
    ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) /
    (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
  );
}

/**
 * Map a uniform draw in `[0, 1)` onto `[min, max]` with the given shape.
 *
 * Every shape is truncated to the bounds rather than merely centred on them.
 * A study asks "what happens between 10 and 60 steps"; a normal tail that
 * wanders to 90 is not an answer to that question, it is a different study.
 */
export function shapeDraw(
  u: number,
  min: number,
  max: number,
  distribution: StudyDistribution,
  options: { centre?: number; spread?: number } = {},
): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (!(high > low)) return low;

  const unit = Math.min(Math.max(u, 0), 0.999999999);

  switch (distribution) {
    case 'uniform':
      return low + unit * (high - low);

    case 'normal': {
      /*
       * Truncated by inverting only the part of the normal CDF that lies
       * inside the bounds, rather than by drawing and rejecting. Rejection
       * would need an unknown number of draws per shot, which breaks the
       * one-stratum-one-value contract Latin hypercube sampling depends on.
       */
      const centre = clampTo(options.centre ?? (low + high) / 2, low, high);
      // Default: the bounds sit three standard deviations out, so almost all
      // of the untruncated mass is inside them and the truncation barely bites.
      const sigma = Math.max((options.spread ?? 1 / 6) * (high - low), 1e-9);
      const lowP = normalCdf((low - centre) / sigma);
      const highP = normalCdf((high - centre) / sigma);
      const value = centre + sigma * probit(lowP + unit * (highP - lowP));
      return clampTo(value, low, high);
    }

    case 'log-uniform': {
      /*
       * For anything spanning orders of magnitude, where a flat draw spends
       * nine tenths of its shots in the top decade. Steps from 4 to 100 is the
       * usual case: the interesting differences are between 4 and 12, and a
       * uniform draw almost never looks there.
       *
       * Shifted when the range touches or crosses zero, since the log of a
       * non-positive number is not available and refusing the setting outright
       * would be a worse answer than sampling the shifted range.
       */
      const shift = low > 0 ? 0 : 1 - low;
      const a = Math.log(low + shift);
      const b = Math.log(high + shift);
      return clampTo(Math.exp(a + unit * (b - a)) - shift, low, high);
    }

    case 'triangular': {
      const mode = clampTo(options.centre ?? (low + high) / 2, low, high);
      const span = high - low;
      const split = (mode - low) / span;
      return unit < split
        ? low + Math.sqrt(unit * span * (mode - low))
        : high - Math.sqrt((1 - unit) * span * (high - mode));
    }

    default:
      return low + unit * (high - low);
  }
}

/** Φ, via the same rational approximation family as `probit`. */
function normalCdf(z: number): number {
  // Zelen & Severo 26.2.17: five terms, absolute error under 7.5e-8.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function clampTo(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/* ------------------------------------------------------------------ */
/* Factors                                                             */
/* ------------------------------------------------------------------ */

/**
 * How a numeric factor's range is cut into the values actually tried.
 *
 * Both forms produce a finite set on purpose. A continuous draw gives 7.318294
 * and 7.318301 as two separate "levels", which makes every statistic a
 * one-observation-per-level affair and tells you nothing. Levels you can count
 * are what turns a pile of pictures into an answer.
 */
export type StudyQuantise =
  /** `count` values evenly spaced from min to max, endpoints included. */
  | { mode: 'samples'; count: number }
  /** Every value reachable from min in whole steps of `step`. */
  | { mode: 'interval'; step: number };

export interface NumericFactor {
  kind: 'numeric';
  /** Field id, e.g. `3.steps`. */
  key: string;
  label: string;
  min: number;
  max: number;
  quantise: StudyQuantise;
  distribution: StudyDistribution;
  /** Where the mass sits, for normal and triangular. Defaults to the midpoint. */
  centre?: number;
  /** Normal only: standard deviation as a fraction of the range. */
  spread?: number;
  /** Round every drawn value to a whole number. */
  integer: boolean;
  /** How costly this factor is to change between shots. See `orderShots`. */
  cost: number;
}

export interface CategoricalFactor {
  kind: 'categorical';
  key: string;
  label: string;
  /** The levels to try. A model list, a sampler list, true and false. */
  levels: WidgetValue[];
  cost: number;
}

export type StudyFactor = NumericFactor | CategoricalFactor;

/** The most levels one factor may contribute, so a typo cannot make a million. */
export const MAX_LEVELS = 64;

/**
 * Every value a numeric factor can take, in ascending order.
 *
 * Rounded to the step's own precision, because floating-point addition walks
 * 7.5 → 8.000000000000002 and two shots that should share a level would then
 * be counted as two levels with one observation each.
 */
export function levelsOf(factor: NumericFactor): number[] {
  const low = Math.min(factor.min, factor.max);
  const high = Math.max(factor.min, factor.max);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [];
  if (high === low) return [low];

  const values: number[] = [];

  if (factor.quantise.mode === 'samples') {
    const count = Math.min(Math.max(Math.floor(factor.quantise.count) || 2, 2), MAX_LEVELS);
    for (let i = 0; i < count; i += 1) {
      values.push(low + ((high - low) * i) / (count - 1));
    }
  } else {
    const step = factor.quantise.step;
    if (!Number.isFinite(step) || step <= 0) return [low];
    for (let i = 0; values.length < MAX_LEVELS; i += 1) {
      const value = low + i * step;
      if (value > high + 1e-9) break;
      values.push(value);
    }
  }

  const decimals = factor.integer ? 0 : precisionOf(values);
  const rounded = values.map((value) => round(value, decimals));
  return [...new Set(rounded)];
}

/** Enough decimals to keep adjacent levels distinct, capped at six. */
function precisionOf(values: number[]): number {
  const first = values[0] ?? 0;
  const second = values[1] ?? first + 1;
  const gap = Math.abs(second - first);
  if (!(gap > 0)) return 3;
  return Math.min(Math.max(Math.ceil(-Math.log10(gap)) + 2, 0), 6);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The levels of any factor, as the values that will appear in a shot. */
export function factorLevels(factor: StudyFactor): WidgetValue[] {
  return factor.kind === 'numeric' ? levelsOf(factor) : factor.levels.slice(0, MAX_LEVELS);
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

export type StudySampling = 'lhs' | 'random';

export const SAMPLINGS: { value: StudySampling; label: string; hint: string }[] = [
  {
    value: 'lhs',
    label: 'Latin hypercube',
    hint: 'covers every part of every range',
  },
  { value: 'random', label: 'Simple random', hint: 'each shot drawn independently' },
];

/**
 * One shot's worth of drawn values, by field id.
 */
export type ShotValues = Record<string, WidgetValue>;

export interface StudySetup {
  factors: StudyFactor[];
  shots: number;
  sampling: StudySampling;
  seed: number;
}

/** Ceiling on a single study, so a slipped digit does not queue a week of work. */
export const MAX_SHOTS = 2000;

/**
 * Draw the unit-interval samples one factor needs across the whole study.
 *
 * This is where the two methods actually differ, and it is worth being precise
 * about why the default is what it is.
 *
 * **Simple random** draws each shot independently. Over enough shots it covers
 * the range, but "enough" is larger than anyone wants to render: with 40 shots
 * you routinely get a hole where nothing was tried and a clump where four
 * near-identical values were.
 *
 * **Latin hypercube** cuts the range into as many strata as there are shots and
 * takes exactly one sample from each, so every part of every range is visited
 * once — and then shuffles which shot gets which stratum. Because that shuffle
 * is drawn *per factor*, the strata of one factor land against a fresh
 * permutation of another's, which is what keeps the columns close to
 * uncorrelated. Same number of pictures, much better coverage; hence the
 * default.
 */
function unitSamples(shots: number, sampling: StudySampling, rng: () => number): number[] {
  if (sampling === 'random') {
    return Array.from({ length: shots }, () => rng());
  }

  const strata = Array.from({ length: shots }, (_, index) => index);
  // Fisher–Yates, with the seeded generator so the shuffle is reproducible.
  for (let i = strata.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [strata[i], strata[j]] = [strata[j] as number, strata[i] as number];
  }
  return strata.map((stratum) => (stratum + rng()) / shots);
}

/**
 * Draw the whole study: one set of values per shot, in the order drawn.
 *
 * The ordering that makes it cheap to run is a separate step — see
 * `orderShots` — because the two are different concerns and mixing them made
 * both impossible to check.
 */
export function drawShots(setup: StudySetup): ShotValues[] {
  const shots = Math.min(Math.max(Math.floor(setup.shots) || 1, 1), MAX_SHOTS);
  const rng = makeRng(setup.seed);
  const columns = new Map<string, WidgetValue[]>();

  for (const factor of setup.factors) {
    const levels = factorLevels(factor);
    if (levels.length === 0) continue;

    const units = unitSamples(shots, setup.sampling, rng);

    if (factor.kind === 'categorical') {
      /*
       * A level per stratum, by index. With Latin hypercube and a level count
       * that divides the shot count this gives each level exactly the same
       * number of shots — which is the balance that makes the per-level means
       * in the results worth comparing.
       */
      columns.set(
        factor.key,
        units.map((u) => levels[Math.min(Math.floor(u * levels.length), levels.length - 1)] as WidgetValue),
      );
      continue;
    }

    const numeric = levels as number[];
    const low = Math.min(factor.min, factor.max);
    const high = Math.max(factor.min, factor.max);
    columns.set(
      factor.key,
      units.map((u) => {
        const raw = shapeDraw(u, low, high, factor.distribution, {
          ...(factor.centre === undefined ? {} : { centre: factor.centre }),
          ...(factor.spread === undefined ? {} : { spread: factor.spread }),
        });
        return nearest(numeric, raw);
      }),
    );
  }

  return Array.from({ length: shots }, (_, index) => {
    const values: ShotValues = {};
    for (const [key, column] of columns) values[key] = column[index] as WidgetValue;
    return values;
  });
}

/** The level closest to a drawn value. */
function nearest(levels: number[], value: number): number {
  let best = levels[0] as number;
  let bestGap = Math.abs(value - best);
  for (const level of levels) {
    const gap = Math.abs(value - level);
    if (gap < bestGap) {
      best = level;
      bestGap = gap;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

/**
 * Put the shots in the order they should actually be rendered.
 *
 * Not the order they were drawn in. Changing the checkpoint between two shots
 * costs ten to sixty seconds of loading a multi-gigabyte file off disk and
 * pushing the previous one out of VRAM; changing the step count costs nothing.
 * A study of 200 shots over four models, run in drawn order, spends most of its
 * wall-clock time swapping models — roughly 200 loads instead of 4.
 *
 * So each factor carries a cost, and the shots are sorted by the expensive
 * factors first: every shot using the first model, then every shot using the
 * second. `cost` is a grade rather than a number of seconds, because nobody
 * knows the seconds and the only thing that matters is the order.
 *
 * Factors left at cost zero are deliberately *not* sorted on. Their drawn order
 * is random, and keeping it that way means a study stopped at 60% is still a
 * fair sample of them — which is the price of blocking the expensive ones, paid
 * where it costs least.
 */
export function orderShots(shots: ShotValues[], factors: StudyFactor[]): ShotValues[] {
  const blocking = factors
    .filter((factor) => factor.cost > 0)
    .sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
  if (blocking.length === 0) return [...shots];

  /*
   * Sorted by the level's *position*, not by the value itself: models are
   * strings whose alphabetical order means nothing, and for numbers the level
   * order is the same thing anyway. Position also keeps the blocks in the order
   * the levels were listed, which is the order the user chose.
   */
  const rank = new Map<string, Map<string, number>>();
  for (const factor of blocking) {
    const positions = new Map<string, number>();
    factorLevels(factor).forEach((level, index) => positions.set(String(level), index));
    rank.set(factor.key, positions);
  }

  return shots
    .map((values, index) => ({ values, index }))
    .sort((a, b) => {
      for (const factor of blocking) {
        const positions = rank.get(factor.key);
        const left = positions?.get(String(a.values[factor.key])) ?? -1;
        const right = positions?.get(String(b.values[factor.key])) ?? -1;
        if (left !== right) return left - right;
      }
      // Ties keep their drawn order, which is random — so the cheap factors
      // stay unsorted within a block.
      return a.index - b.index;
    })
    .map((entry) => entry.values);
}

/** Draw and order in one call, which is how it is always used. */
export function planStudy(setup: StudySetup): ShotValues[] {
  return orderShots(drawShots(setup), setup.factors);
}

/**
 * How many times the plan changes each blocking factor.
 *
 * Shown on the setup screen, because "4 model loads" and "196 model loads" is
 * the difference between an afternoon and a weekend, and it is not obvious
 * from the numbers you typed in.
 */
export function switchCounts(
  shots: ShotValues[],
  factors: StudyFactor[],
): { key: string; label: string; switches: number }[] {
  return factors.map((factor) => {
    let switches = 0;
    for (let i = 1; i < shots.length; i += 1) {
      if (String(shots[i]?.[factor.key]) !== String(shots[i - 1]?.[factor.key])) switches += 1;
    }
    return { key: factor.key, label: factor.label, switches };
  });
}
