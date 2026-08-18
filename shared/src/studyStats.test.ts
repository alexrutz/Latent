import { describe, expect, it } from 'vitest';

import type { CategoricalFactor, NumericFactor } from './studyPlan.js';
import {
  analyseStudy,
  averageRanks,
  describeSignificance,
  kruskalWallis,
  levelLabel,
  spearman,
  spearmanP,
  type RatedShot,
} from './studyStats.js';

/**
 * Statistics that are wrong still print. That is what makes this file the most
 * important one in the module: a correlation off by a tie correction produces a
 * confident, plausible, wrong answer about which parameter to change, and
 * nothing about the screen would look broken.
 *
 * So every figure is checked against one worked out independently — by hand
 * where the arithmetic is short, and against a closed form where the
 * distribution has one.
 */

const steps: NumericFactor = {
  kind: 'numeric',
  key: 'steps',
  label: 'Steps',
  min: 10,
  max: 40,
  quantise: { mode: 'interval', step: 10 },
  distribution: 'uniform',
  integer: true,
  cost: 0,
};

const model: CategoricalFactor = {
  kind: 'categorical',
  key: 'model',
  label: 'Model',
  levels: ['a.safetensors', 'b.safetensors'],
  cost: 3,
};

describe('ranking with ties', () => {
  it('ranks distinct values one to n', () => {
    expect(averageRanks([10, 30, 20])).toEqual([1, 3, 2]);
  });

  /**
   * The correction the whole analysis depends on. Three rating levels across
   * forty shots is ties in blocks of a dozen; ranking them by arrival order
   * would invent an ordering that is not in the data.
   */
  it('gives tied values their shared average rank', () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(averageRanks([5, 5, 5])).toEqual([2, 2, 2]);
    expect(averageRanks([1, 1, 2, 2])).toEqual([1.5, 1.5, 3.5, 3.5]);
  });
});

describe("Spearman's rank correlation", () => {
  it('is 1 for a perfectly increasing relationship, and −1 for the reverse', () => {
    expect(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1, 10);
  });

  /**
   * Worked by hand. a = [1,1,2,3] ranks to [1.5,1.5,3,4], b = [1,2,3,4] ranks
   * to itself; both mean 2.5. Σdev·dev = 4.5, Σdev² = 4.5 and 5, so
   * ρ = 4.5/√22.5 = 0.9486833.
   *
   * The un-corrected shortcut formula gives 0.9 here, which is how you tell
   * the two implementations apart.
   */
  it('corrects for ties rather than using the shortcut formula', () => {
    expect(spearman([1, 1, 2, 3], [1, 2, 3, 4])).toBeCloseTo(0.9486833, 6);
  });

  it('has nothing to say when one side never varies', () => {
    expect(spearman([1, 2, 3, 4], [2, 2, 2, 2])).toBeNull();
  });

  it('has nothing to say about two points', () => {
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  /**
   * Against the closed form of Student's t with two degrees of freedom, where
   * the two-sided tail is exactly 1 − t/√(2+t²). Four rated shots is the
   * smallest study this will speak about at all, and it is also the one place
   * the incomplete beta can be checked without a table.
   *
   * Swept across t rather than checked at one point, because a continued
   * fraction that converges at t = 1 and not at t = 4 is the failure worth
   * catching.
   */
  it('turns ρ into a p-value that matches the t distribution', () => {
    for (const t of [0, 0.5, 1, 2, 4]) {
      // Invert t = ρ√((n−2)/(1−ρ²)) at n = 4, so df = 2.
      const rho = Math.sqrt((t * t) / (2 + t * t));
      expect(spearmanP(rho, 4)).toBeCloseTo(1 - t / Math.sqrt(2 + t * t), 6);
    }
  });

  it('calls a perfect correlation certain, and no correlation even odds', () => {
    expect(spearmanP(1, 20)).toBe(0);
    expect(spearmanP(0, 20)).toBeCloseTo(1, 10);
  });
});

describe('Kruskal–Wallis across levels', () => {
  /**
   * The textbook case, worked through: three groups of three, ranks 1–9, rank
   * sums 6, 15 and 24. H = (12/90)·279 − 30 = 7.2 with two degrees of freedom.
   *
   * And for df = 2 the χ² upper tail has a closed form — e^(−H/2) — so the
   * p-value is exactly e^(−3.6) = 0.0273237, with no table to trust.
   */
  it('matches a hand-computed H and an exact tail', () => {
    const result = kruskalWallis([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    expect(result?.h).toBeCloseTo(7.2, 10);
    expect(result?.df).toBe(2);
    expect(result?.p).toBeCloseTo(Math.exp(-3.6), 8);
  });

  /** Identical groups cannot differ, so H is zero and nothing is significant. */
  it('reports no effect when the groups are the same', () => {
    const result = kruskalWallis([
      [2, 2, 2],
      [2, 2, 2],
    ]);
    expect(result?.h).toBeCloseTo(0, 10);
    expect(result?.p).toBeCloseTo(1, 10);
  });

  /**
   * The tie correction, isolated — and it is worth the arithmetic, because
   * this is exactly the shape real rating data has.
   *
   * Two groups of three, split perfectly 1s against 3s. Ranks are 2,2,2 and
   * 5,5,5, so the rank sums are 6 and 15 and the raw H is
   * (12/42)·87 − 21 = 3.857143. Every value is tied in a group of three, so
   * Σ(t³−t) = 48 against n³−n = 210, and dividing by 1 − 48/210 lifts H to
   * exactly 5.
   *
   * Without the correction the module would report 3.86 for two groups that
   * do not overlap at all, and under-call a factor that plainly matters.
   */
  it('inflates H to account for ties, rather than ignoring them', () => {
    const result = kruskalWallis([
      [1, 1, 1],
      [3, 3, 3],
    ]);
    expect(result?.h).toBeCloseTo(5, 6);
    expect(result?.df).toBe(1);
  });

  it('declines a single group, having nothing to compare it with', () => {
    expect(kruskalWallis([[1, 2, 3]])).toBeNull();
    expect(kruskalWallis([[1, 2, 3], []])).toBeNull();
  });
});

describe('reading a level back', () => {
  it('drops the folder and the extension from a checkpoint', () => {
    expect(levelLabel('SDXL/juggernaut_v9.safetensors')).toBe('juggernaut_v9');
    expect(levelLabel('sd15.ckpt')).toBe('sd15');
  });

  it('leaves a number and a plain name alone', () => {
    expect(levelLabel(30)).toBe('30');
    expect(levelLabel('euler_ancestral')).toBe('euler_ancestral');
  });
});

describe('analysing a whole study', () => {
  /** Ratings that rise with the step count, perfectly and without noise. */
  function risingWithSteps(): RatedShot[] {
    const shots: RatedShot[] = [];
    for (let i = 0; i < 6; i += 1) {
      shots.push({ values: { steps: 10 }, rating: 1 });
      shots.push({ values: { steps: 20 }, rating: 2 });
      shots.push({ values: { steps: 40 }, rating: 3 });
    }
    return shots;
  }

  it('counts what was rated and what is left', () => {
    const stats = analyseStudy(risingWithSteps(), [steps], 7);
    expect(stats.rated).toBe(18);
    expect(stats.unrated).toBe(7);
    expect(stats.distribution).toEqual({ 1: 6, 2: 6, 3: 6 });
    expect(stats.meanRating).toBeCloseTo(2, 10);
  });

  it('finds a numeric factor that drives the rating', () => {
    const factor = analyseStudy(risingWithSteps(), [steps]).factors[0];
    expect(factor?.kind).toBe('numeric');
    expect(factor?.rho).toBeCloseTo(1, 6);
    expect(factor?.test).toBe('spearman');
    expect(factor?.p).toBe(0);
    expect(factor?.best?.level).toBe(40);
    expect(factor?.worst?.level).toBe(10);
  });

  it('reports the mean rating and its uncertainty at each level', () => {
    const factor = analyseStudy(risingWithSteps(), [steps]).factors[0];
    const level = factor?.levels.find((entry) => entry.level === 20);
    expect(level?.count).toBe(6);
    expect(level?.mean).toBeCloseTo(2, 10);
    // Every observation identical, so the mean has no spread at all.
    expect(level?.stderr).toBeCloseTo(0, 10);
  });

  /** A level nobody rated is listed as untried rather than quietly dropped. */
  it('keeps a declared level that never came up', () => {
    const factor = analyseStudy(risingWithSteps(), [steps]).factors[0];
    const untried = factor?.levels.find((entry) => entry.level === 30);
    expect(untried).toBeDefined();
    expect(untried?.count).toBe(0);
    expect(untried?.stderr).toBeNull();
  });

  it('tests a categorical factor across its levels instead of correlating it', () => {
    const shots: RatedShot[] = [];
    for (let i = 0; i < 5; i += 1) {
      shots.push({ values: { model: 'a.safetensors' }, rating: 3 });
      shots.push({ values: { model: 'b.safetensors' }, rating: 1 });
    }

    const factor = analyseStudy(shots, [model]).factors[0];
    expect(factor?.kind).toBe('categorical');
    expect(factor?.rho).toBeNull();
    expect(factor?.test).toBe('kruskal-wallis');
    expect(factor?.p).toBeLessThan(0.01);
    expect(factor?.best?.label).toBe('a');
    expect(factor?.worst?.label).toBe('b');
    // Two rating points apart, on a scale where two points is the whole range.
    expect(factor?.effect).toBeCloseTo(1, 10);
  });

  /**
   * The question the screen exists to answer: of the things you varied, which
   * one should you go and change? A factor that did nothing must not outrank
   * one that did.
   */
  it('ranks the factor that mattered above the one that did not', () => {
    const cfg: NumericFactor = { ...steps, key: 'cfg', label: 'CFG', min: 1, max: 12 };
    const shots: RatedShot[] = [];
    for (let i = 0; i < 12; i += 1) {
      shots.push({
        values: { steps: i < 6 ? 10 : 40, cfg: i % 2 === 0 ? 1 : 12 },
        rating: i < 6 ? 1 : 3,
      });
    }

    const stats = analyseStudy(shots, [cfg, steps]);
    expect(stats.factors[0]?.key).toBe('steps');
    expect(stats.factors[1]?.key).toBe('cfg');
    expect(stats.factors[1]?.effect).toBeCloseTo(0, 6);
  });

  it('survives a study nobody has rated yet', () => {
    const stats = analyseStudy([], [steps, model], 40);
    expect(stats.rated).toBe(0);
    expect(stats.meanRating).toBe(0);
    expect(stats.factors).toHaveLength(2);
    for (const factor of stats.factors) {
      expect(factor.p).toBeNull();
      expect(factor.effect).toBe(0);
      expect(factor.best).toBeNull();
    }
  });

  /** A factor added to the setup after the plan was drawn carries no shots. */
  it('handles a factor no shot actually varied', () => {
    const factor = analyseStudy(risingWithSteps(), [model]).factors[0];
    expect(factor?.n).toBe(0);
    expect(factor?.test).toBeNull();
  });
});

describe('saying what a p-value means', () => {
  it('refuses to draw a conclusion from too few shots', () => {
    expect(describeSignificance(0.001, 5)).toBe('too few rated shots to say');
  });

  it('grades the rest, and says so plainly', () => {
    expect(describeSignificance(0.001, 40)).toBe('almost certainly real');
    expect(describeSignificance(0.03, 40)).toBe('probably real');
    expect(describeSignificance(0.1, 40)).toBe('a hint, no more');
    expect(describeSignificance(0.6, 40)).toBe('no more than noise');
    expect(describeSignificance(null, 40)).toBe('not enough variation to tell');
  });
});
