import type { WidgetValue } from './comfyTypes.js';
import { factorLevels, type StudyFactor } from './studyPlan.js';

/**
 * Working out which parameters actually mattered.
 *
 * The ratings are ordinal — bad, middling, good — with enormous numbers of
 * ties, and the factor values are a mixture of numbers and names. That rules
 * out the obvious tools: a Pearson correlation on three-valued data is
 * meaningless, and a t-test between "sd15" and "flux" is not a thing.
 *
 * So: rank statistics throughout. Spearman for numeric factors, Kruskal–Wallis
 * for categorical ones, both with the tie corrections that three rating levels
 * make compulsory rather than optional. Everything here is pure, and every
 * figure it reports is tested against one worked by hand.
 */

/** What a tap on the picture means. Ordinal, and deliberately only three. */
export type StudyRating = 1 | 2 | 3;

export const RATING_LABELS: Record<StudyRating, string> = {
  3: 'Good',
  2: 'Middling',
  1: 'Poor',
};

/** One rated shot, reduced to what the statistics need. */
export interface RatedShot {
  values: Record<string, WidgetValue>;
  rating: StudyRating;
}

/* ------------------------------------------------------------------ */
/* Ranks                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ranks, with ties sharing their average.
 *
 * The correction is the whole game here. Forty shots rated across three levels
 * means ties in blocks of a dozen; ranking them 1,2,3… by arrival order would
 * invent an ordering that is not in the data and hand back a correlation drawn
 * from it.
 */
export function averageRanks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && (order[j + 1] as { value: number }).value === (order[i] as { value: number }).value) {
      j += 1;
    }
    // Ranks are one-based, and a run from i to j shares their mean.
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[(order[k] as { index: number }).index] = shared;
    i = j + 1;
  }
  return ranks;
}

/** Σ(t³ − t) over each group of tied values, the term both tests correct with. */
function tieTerm(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) total += count ** 3 - count;
  return total;
}

/* ------------------------------------------------------------------ */
/* Per-factor results                                                  */
/* ------------------------------------------------------------------ */

/** The mean rating at one level of a factor, with how sure we are of it. */
export interface LevelSummary {
  level: WidgetValue;
  label: string;
  count: number;
  mean: number;
  /** Standard error of that mean. `null` when a single shot gives no spread. */
  stderr: number | null;
}

export interface FactorResult {
  key: string;
  label: string;
  kind: 'numeric' | 'categorical';
  /** Shots that carried this factor and have been rated. */
  n: number;
  levels: LevelSummary[];
  /**
   * Spearman's ρ, for numeric factors: −1 to 1, where positive means "more of
   * this rated better". `null` for categorical factors, where an ordering of
   * the levels would have to be invented before a correlation could exist.
   */
  rho: number | null;
  /**
   * The test statistic's p-value: roughly, how often noise alone would produce
   * an effect this large. Small means the factor is probably doing something.
   */
  p: number | null;
  /** Which test produced `p`, so the read-out can say so. */
  test: 'spearman' | 'kruskal-wallis' | null;
  /**
   * One number for "how much did this matter", comparable across both kinds,
   * used to rank the factors. |ρ| for numeric; for categorical, the spread of
   * level means over the range a rating can take.
   */
  effect: number;
  /** The best and worst level by mean rating, when there is a difference. */
  best: LevelSummary | null;
  worst: LevelSummary | null;
}

export interface StudyStats {
  rated: number;
  unrated: number;
  /** How many shots got each rating. */
  distribution: Record<StudyRating, number>;
  meanRating: number;
  /** Every factor, most influential first. */
  factors: FactorResult[];
}

/* ------------------------------------------------------------------ */
/* The tests                                                           */
/* ------------------------------------------------------------------ */

/**
 * Spearman's rank correlation, tie-corrected.
 *
 * Computed as Pearson's r over the average ranks rather than by the `1 −
 * 6Σd²/n(n²−1)` shortcut — that shortcut is only valid without ties, and this
 * data is nothing but ties.
 */
export function spearman(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;

  const ra = averageRanks(a);
  const rb = averageRanks(b);
  const n = ra.length;
  const meanA = ra.reduce((sum, value) => sum + value, 0) / n;
  const meanB = rb.reduce((sum, value) => sum + value, 0) / n;

  let top = 0;
  let leftSq = 0;
  let rightSq = 0;
  for (let i = 0; i < n; i += 1) {
    const left = (ra[i] as number) - meanA;
    const right = (rb[i] as number) - meanB;
    top += left * right;
    leftSq += left * left;
    rightSq += right * right;
  }

  // No spread on one side — every shot rated the same, or one level only.
  if (leftSq === 0 || rightSq === 0) return null;
  return top / Math.sqrt(leftSq * rightSq);
}

/**
 * Two-sided p-value for ρ, via the usual t approximation.
 *
 * Approximate, and honestly so: exact Spearman tables exist for small n and
 * this is not them. At the sizes a study produces — tens to hundreds of rated
 * shots — the approximation is close enough to tell "probably real" from
 * "probably noise", which is the only question being asked.
 */
export function spearmanP(rho: number, n: number): number | null {
  if (n < 4) return null;
  const denominator = 1 - rho * rho;
  if (denominator <= 0) return 0;
  const t = rho * Math.sqrt((n - 2) / denominator);
  return studentTwoSided(Math.abs(t), n - 2);
}

/**
 * Kruskal–Wallis H: does *any* of these levels differ from the others?
 *
 * The rank-based one-way ANOVA. For a model list there is no meaningful order,
 * so a correlation cannot be formed — but "these four checkpoints do not all
 * perform the same" is exactly the question, and this answers it.
 */
export function kruskalWallis(groups: number[][]): { h: number; df: number; p: number } | null {
  const present = groups.filter((group) => group.length > 0);
  if (present.length < 2) return null;

  const all = present.flat();
  const n = all.length;
  if (n < 3) return null;

  const ranks = averageRanks(all);
  let offset = 0;
  let sum = 0;
  for (const group of present) {
    const groupRanks = ranks.slice(offset, offset + group.length);
    const total = groupRanks.reduce((acc, value) => acc + value, 0);
    sum += (total * total) / group.length;
    offset += group.length;
  }

  let h = (12 / (n * (n + 1))) * sum - 3 * (n + 1);

  // Tie correction. Without it, three rating levels across a hundred shots
  // deflate H badly enough to hide a real effect.
  const correction = 1 - tieTerm(all) / (n ** 3 - n);
  if (correction > 0) h /= correction;

  const df = present.length - 1;
  return { h, df, p: chiSquareUpper(h, df) };
}

/* ------------------------------------------------------------------ */
/* Distribution tails                                                  */
/* ------------------------------------------------------------------ */

/** Two-sided tail of Student's t, through the incomplete beta function. */
function studentTwoSided(t: number, df: number): number {
  if (df <= 0) return 1;
  const x = df / (df + t * t);
  return clampP(incompleteBeta(x, df / 2, 0.5));
}

/**
 * Upper tail of χ², through the regularised incomplete gamma function.
 *
 * Series below the transition point, continued fraction above it — the
 * standard split, because the series converges slowly exactly where the
 * fraction converges fast.
 */
function chiSquareUpper(x: number, df: number): number {
  if (!(x > 0)) return 1;
  return clampP(1 - lowerGamma(df / 2, x / 2));
}

function clampP(p: number): number {
  return Math.min(Math.max(p, 0), 1);
}

/** ln Γ(x), Lanczos. */
function lnGamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
    0.001208650973866179, -0.000005395239384953,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    series += (g[j] as number) / y;
  }
  return -tmp + Math.log((2.5066282746310007 * series) / x);
}

/** P(a, x): the regularised lower incomplete gamma function. */
function lowerGamma(a: number, x: number): number {
  if (x < 0 || a <= 0) return 0;
  if (x === 0) return 0;

  if (x < a + 1) {
    // Series representation.
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }

  // Continued fraction for the upper tail, subtracted.
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** I_x(a, b): the regularised incomplete beta function, by continued fraction. */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );

  /*
   * Lentz's method, on whichever side converges. `front` is symmetric under
   * swapping (a, x) with (b, 1 − x) — the same product of logs either way — so
   * the mirrored branch reuses it rather than recomputing it.
   */
  if (x < (a + 1) / (a + b + 2)) return (front * betaFraction(x, a, b)) / a;
  return 1 - (front * betaFraction(1 - x, b, a)) / b;
}

function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 300; m += 1) {
    const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + even * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + even / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;

    const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + odd * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + odd / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;

    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* Putting it together                                                 */
/* ------------------------------------------------------------------ */

/** How a level prints. Numbers as themselves; a checkpoint without its path. */
export function levelLabel(value: WidgetValue): string {
  const text = String(value);
  const leaf = text.split(/[/\\]/).pop() ?? text;
  return leaf.replace(/\.(safetensors|ckpt|pt|pth|sft)$/i, '');
}

/** Everything the results screen shows, from the rated shots and the setup. */
export function analyseStudy(
  shots: RatedShot[],
  factors: StudyFactor[],
  unrated = 0,
): StudyStats {
  const distribution: Record<StudyRating, number> = { 1: 0, 2: 0, 3: 0 };
  for (const shot of shots) distribution[shot.rating] += 1;

  const meanRating =
    shots.length === 0
      ? 0
      : shots.reduce((sum, shot) => sum + shot.rating, 0) / shots.length;

  const results = factors.map((factor) => analyseFactor(shots, factor));

  return {
    rated: shots.length,
    unrated,
    distribution,
    meanRating,
    /*
     * Ranked by effect, because the one thing anyone wants from this screen is
     * "which knob should I turn". A factor with no measurable effect is still
     * listed — knowing that CFG did nothing is a result — but it goes last.
     */
    factors: results.sort((a, b) => b.effect - a.effect || a.label.localeCompare(b.label)),
  };
}

function analyseFactor(shots: RatedShot[], factor: StudyFactor): FactorResult {
  const present = shots.filter((shot) => shot.values[factor.key] !== undefined);

  /*
   * The declared levels lead, so the read-out lists them in the order they
   * were set up and shows an untried level as untried rather than omitting it.
   * Anything drawn that is not in the list is appended — a factor edited after
   * the plan was made would otherwise silently drop shots.
   */
  const declared = factorLevels(factor).map(String);
  const seen = new Map<string, WidgetValue>();
  for (const level of factorLevels(factor)) seen.set(String(level), level);
  for (const shot of present) {
    const value = shot.values[factor.key] as WidgetValue;
    if (!seen.has(String(value))) seen.set(String(value), value);
  }
  const order = [...declared, ...[...seen.keys()].filter((key) => !declared.includes(key))];

  const grouped = new Map<string, number[]>();
  for (const shot of present) {
    const key = String(shot.values[factor.key]);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(shot.rating);
    else grouped.set(key, [shot.rating]);
  }

  const levels: LevelSummary[] = order.map((key) => {
    const ratings = grouped.get(key) ?? [];
    const count = ratings.length;
    const mean = count === 0 ? 0 : ratings.reduce((sum, value) => sum + value, 0) / count;
    return {
      level: seen.get(key) as WidgetValue,
      label: levelLabel(seen.get(key) as WidgetValue),
      count,
      mean,
      stderr: count > 1 ? standardError(ratings, mean) : null,
    };
  });

  const tried = levels.filter((level) => level.count > 0);
  const base: Omit<FactorResult, 'rho' | 'p' | 'test' | 'effect'> = {
    key: factor.key,
    label: factor.label,
    kind: factor.kind,
    n: present.length,
    levels,
    best: null,
    worst: null,
  };

  if (tried.length > 1) {
    const sorted = [...tried].sort((a, b) => b.mean - a.mean);
    base.best = sorted[0] ?? null;
    base.worst = sorted[sorted.length - 1] ?? null;
  }

  if (factor.kind === 'numeric') {
    const xs = present.map((shot) => Number(shot.values[factor.key]));
    const ys = present.map((shot) => shot.rating as number);
    const rho = spearman(xs, ys);
    return {
      ...base,
      rho,
      p: rho === null ? null : spearmanP(rho, present.length),
      test: rho === null ? null : 'spearman',
      effect: rho === null ? 0 : Math.abs(rho),
    };
  }

  const groups = tried.map((level) => grouped.get(String(level.level)) ?? []);
  const test = kruskalWallis(groups);
  /*
   * The spread of the level means, as a fraction of the two points a rating
   * can move. Not a correlation, but on the same 0–1 scale as |ρ|, which is
   * what makes the two kinds of factor rankable against each other.
   */
  const spread =
    tried.length > 1
      ? (Math.max(...tried.map((level) => level.mean)) -
          Math.min(...tried.map((level) => level.mean))) /
        2
      : 0;

  return {
    ...base,
    rho: null,
    p: test?.p ?? null,
    test: test ? 'kruskal-wallis' : null,
    effect: spread,
  };
}

function standardError(values: number[], mean: number): number {
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

/**
 * How a p-value should be read, in words.
 *
 * A bare `p = 0.03` on a phone screen is a number most people will either
 * over- or under-read, and the honest summary is short enough to print.
 */
export function describeSignificance(p: number | null, n: number): string {
  if (p === null) return 'not enough variation to tell';
  if (n < 12) return 'too few rated shots to say';
  if (p < 0.01) return 'almost certainly real';
  if (p < 0.05) return 'probably real';
  if (p < 0.15) return 'a hint, no more';
  return 'no more than noise';
}
