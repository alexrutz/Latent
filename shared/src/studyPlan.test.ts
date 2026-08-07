import { describe, expect, it } from 'vitest';

import {
  drawShots,
  factorLevels,
  levelsOf,
  makeRng,
  orderShots,
  planStudy,
  shapeDraw,
  switchCounts,
  type CategoricalFactor,
  type NumericFactor,
} from './studyPlan.js';

/**
 * The plan is the part of a study that cannot be checked by looking at it.
 *
 * A sampler that quietly correlates two factors, or a draw that never visits
 * the bottom of a range, produces a study that runs perfectly and answers the
 * question wrongly — and you would not find out. So the properties are asserted
 * directly: coverage, balance, independence, reproducibility, and the ordering
 * that makes the thing affordable to run.
 */

const steps: NumericFactor = {
  kind: 'numeric',
  key: '3.steps',
  label: 'Steps',
  min: 10,
  max: 50,
  quantise: { mode: 'interval', step: 10 },
  distribution: 'uniform',
  integer: true,
  cost: 0,
};

const model: CategoricalFactor = {
  kind: 'categorical',
  key: '4.ckpt_name',
  label: 'Model',
  levels: ['sd15.safetensors', 'sdxl.safetensors', 'flux.safetensors'],
  cost: 3,
};

describe('the seeded generator', () => {
  it('gives the same sequence twice', () => {
    const a = Array.from({ length: 8 }, makeRng(42));
    const b = Array.from({ length: 8 }, makeRng(42));
    expect(a).toEqual(b);
  });

  it('gives a different sequence for a different seed', () => {
    expect(Array.from({ length: 8 }, makeRng(1))).not.toEqual(
      Array.from({ length: 8 }, makeRng(2)),
    );
  });

  it('stays inside the unit interval', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 2000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  /**
   * The failure mode that makes a sampler useless without ever looking broken:
   * a generator whose output drifts. Each tenth of the interval should get
   * about a tenth of 10000 draws.
   */
  it('spreads evenly enough to sample with', () => {
    const rng = makeRng(99);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i += 1) buckets[Math.floor(rng() * 10)] += 1;
    for (const count of buckets) expect(count).toBeGreaterThan(800);
  });
});

describe('shaping a draw across a range', () => {
  it('spreads a uniform draw across the whole range', () => {
    expect(shapeDraw(0, 10, 50, 'uniform')).toBe(10);
    expect(shapeDraw(0.5, 10, 50, 'uniform')).toBe(30);
    expect(shapeDraw(0.999999999, 10, 50, 'uniform')).toBeCloseTo(50, 6);
  });

  /** Every shape has to stay inside the bounds — a study of 10–50 means 10–50. */
  it('never leaves the bounds, whatever the shape', () => {
    for (const distribution of ['uniform', 'normal', 'log-uniform', 'triangular'] as const) {
      for (let i = 0; i <= 100; i += 1) {
        const value = shapeDraw(i / 100, 10, 50, distribution);
        expect(value).toBeGreaterThanOrEqual(10);
        expect(value).toBeLessThanOrEqual(50);
      }
    }
  });

  it('centres a normal draw on the middle, and lets the middle be moved', () => {
    expect(shapeDraw(0.5, 0, 100, 'normal')).toBeCloseTo(50, 6);

    /*
     * Moved off centre, the median is *not* the centre — truncating a normal
     * at 0 when it is centred on 20 cuts away more of the left tail than of
     * the right, which pulls the median up. So what is asserted is the pull
     * itself: the mass moves to the bottom of the range and stays inside it.
     */
    const drawn = Array.from({ length: 999 }, (_, i) =>
      shapeDraw((i + 1) / 1000, 0, 100, 'normal', { centre: 20 }),
    );
    const mean = drawn.reduce((sum, value) => sum + value, 0) / drawn.length;
    expect(mean).toBeGreaterThan(20);
    expect(mean).toBeLessThan(30);
    expect(drawn.filter((value) => value < 40).length).toBeGreaterThan(850);
  });

  /**
   * The reason the normal option exists: most of the shots land near the
   * middle instead of being spread flat.
   */
  it('puts most of a normal draw near the centre', () => {
    let inner = 0;
    for (let i = 1; i < 1000; i += 1) {
      const value = shapeDraw(i / 1000, 0, 60, 'normal');
      if (value > 20 && value < 40) inner += 1;
    }
    // Two thirds of the mass within one standard deviation, and σ is a sixth
    // of the range — so a third of the range holds far more than a third.
    expect(inner).toBeGreaterThan(600);
  });

  /**
   * The reason the log-uniform option exists: a flat draw over 4–100 spends
   * nine tenths of its shots above 12, where the pictures all look the same.
   */
  it('gives the small end of a log-uniform range a fair share', () => {
    let low = 0;
    for (let i = 1; i < 1000; i += 1) {
      if (shapeDraw(i / 1000, 4, 100, 'log-uniform') < 20) low += 1;
    }
    expect(low).toBeGreaterThan(450);
    // The same count under a uniform draw, for contrast.
    let flat = 0;
    for (let i = 1; i < 1000; i += 1) {
      if (shapeDraw(i / 1000, 4, 100, 'uniform') < 20) flat += 1;
    }
    expect(flat).toBeLessThan(200);
  });

  /** A range crossing zero has no logarithm, and must not produce NaN. */
  it('handles a log-uniform range that includes zero', () => {
    for (let i = 0; i <= 20; i += 1) {
      const value = shapeDraw(i / 20, -5, 5, 'log-uniform');
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThanOrEqual(5);
    }
  });

  it('peaks a triangular draw where it is told to', () => {
    let near = 0;
    for (let i = 1; i < 1000; i += 1) {
      const value = shapeDraw(i / 1000, 0, 100, 'triangular', { centre: 80 });
      if (value > 70 && value < 90) near += 1;
    }
    expect(near).toBeGreaterThan(250);
  });

  it('returns the bound when there is no range', () => {
    expect(shapeDraw(0.7, 20, 20, 'normal')).toBe(20);
  });
});

describe('the values a factor can take', () => {
  it('walks a range in whole steps', () => {
    expect(levelsOf(steps)).toEqual([10, 20, 30, 40, 50]);
  });

  it('spaces a sample count evenly, endpoints included', () => {
    expect(
      levelsOf({ ...steps, min: 0, max: 100, quantise: { mode: 'samples', count: 5 } }),
    ).toEqual([0, 25, 50, 75, 100]);
  });

  /** The float walk that makes two identical shots look like two levels. */
  it('rounds away the drift a float walk accumulates', () => {
    const levels = levelsOf({
      ...steps,
      min: 1,
      max: 2,
      quantise: { mode: 'interval', step: 0.1 },
      integer: false,
    });
    expect(levels).toEqual([1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2]);
  });

  it('caps a range that would produce thousands of levels', () => {
    const levels = levelsOf({
      ...steps,
      min: 0,
      max: 10_000,
      quantise: { mode: 'interval', step: 0.01 },
      integer: false,
    });
    expect(levels.length).toBeLessThanOrEqual(64);
  });

  it('gives a categorical factor its own levels', () => {
    expect(factorLevels(model)).toEqual(model.levels);
  });
});

describe('drawing the shots', () => {
  const setup = { factors: [steps, model], shots: 30, sampling: 'lhs' as const, seed: 5 };

  it('draws one value per factor per shot, from the level set', () => {
    const shots = drawShots(setup);
    expect(shots).toHaveLength(30);
    for (const shot of shots) {
      expect(levelsOf(steps)).toContain(shot['3.steps']);
      expect(model.levels).toContain(shot['4.ckpt_name']);
    }
  });

  it('draws the same plan from the same seed, and a different one otherwise', () => {
    expect(drawShots(setup)).toEqual(drawShots(setup));
    expect(drawShots(setup)).not.toEqual(drawShots({ ...setup, seed: 6 }));
  });

  /**
   * What Latin hypercube is *for*. Thirty shots over five levels should visit
   * each level, and roughly equally — the coverage a simple random draw of the
   * same size routinely fails to give.
   */
  it('visits every level of every factor, in balance', () => {
    const shots = drawShots(setup);
    const counts = new Map<number, number>();
    for (const shot of shots) {
      const value = shot['3.steps'] as number;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(3);
      expect(count).toBeLessThanOrEqual(9);
    }
  });

  /** Three models over thirty shots: exactly ten each, because the strata divide. */
  it('gives each categorical level an equal share when the counts divide', () => {
    const counts = new Map<string, number>();
    for (const shot of drawShots(setup)) {
      const value = String(shot['4.ckpt_name']);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([10, 10, 10]);
  });

  /**
   * The property the whole analysis rests on. If steps and model moved
   * together, the statistics could not tell which of them caused the change —
   * and every conclusion the module printed would be worthless.
   */
  it('draws the factors close to uncorrelated', () => {
    const shots = drawShots({
      factors: [
        steps,
        { ...steps, key: '3.cfg', label: 'CFG', min: 1, max: 12, quantise: { mode: 'interval', step: 1 } },
      ],
      shots: 200,
      sampling: 'lhs',
      seed: 11,
    });

    const a = shots.map((shot) => shot['3.steps'] as number);
    const b = shots.map((shot) => shot['3.cfg'] as number);
    expect(Math.abs(pearson(a, b))).toBeLessThan(0.2);
  });

  it('draws simple random samples too, still from the level set', () => {
    const shots = drawShots({ ...setup, sampling: 'random' });
    expect(shots).toHaveLength(30);
    for (const shot of shots) expect(levelsOf(steps)).toContain(shot['3.steps']);
  });

  it('caps a shot count that would queue a week of work', () => {
    expect(drawShots({ ...setup, shots: 99_999 }).length).toBeLessThanOrEqual(2000);
  });

  it('draws nothing for a factor with no levels at all', () => {
    const shots = drawShots({
      factors: [{ ...model, levels: [] }],
      shots: 4,
      sampling: 'lhs',
      seed: 1,
    });
    expect(shots).toEqual([{}, {}, {}, {}]);
  });
});

describe('ordering the shots to run', () => {
  /**
   * The reason this step exists at all: 30 shots over 3 models should load 3
   * models, not 30.
   */
  it('groups the expensive factor so it changes as rarely as possible', () => {
    const plan = planStudy({ factors: [steps, model], shots: 30, sampling: 'lhs', seed: 5 });
    const switches = switchCounts(plan, [steps, model]);
    const modelSwitches = switches.find((entry) => entry.key === '4.ckpt_name')?.switches ?? 0;

    // Three blocks means two changes, and no more.
    expect(modelSwitches).toBe(2);
  });

  it('keeps the blocks in the order the levels were listed', () => {
    const plan = planStudy({ factors: [steps, model], shots: 30, sampling: 'lhs', seed: 5 });
    const seen: string[] = [];
    for (const shot of plan) {
      const value = String(shot['4.ckpt_name']);
      if (seen[seen.length - 1] !== value) seen.push(value);
    }
    expect(seen).toEqual(model.levels.map(String));
  });

  /**
   * Grading, not just a flag. A study varying model *and* resolution should
   * finish every resolution within a model before touching the next model.
   */
  it('nests a cheaper blocking factor inside a dearer one', () => {
    const size: NumericFactor = {
      ...steps,
      key: '5.width',
      label: 'Width',
      min: 512,
      max: 1024,
      quantise: { mode: 'interval', step: 512 },
      cost: 1,
    };
    const plan = planStudy({
      factors: [steps, size, model],
      shots: 24,
      sampling: 'lhs',
      seed: 3,
    });

    const blocks = plan.map((shot) => `${shot['4.ckpt_name']}/${shot['5.width']}`);
    // Every block appears as one contiguous run, never revisited.
    const runs: string[] = [];
    for (const block of blocks) if (runs[runs.length - 1] !== block) runs.push(block);
    expect(new Set(runs).size).toBe(runs.length);

    // And the model is the outer loop, not the inner one.
    const modelSwitches = switchCounts(plan, [model])[0]?.switches ?? 0;
    const widthSwitches = switchCounts(plan, [size])[0]?.switches ?? 0;
    expect(modelSwitches).toBeLessThan(widthSwitches);
  });

  /**
   * The deliberate limit of the blocking, and the reason cheap factors are
   * left alone: a study you stop at 60% has still sampled them fairly.
   */
  it('leaves a cost-free factor in its drawn order', () => {
    const drawn = drawShots({ factors: [steps], shots: 20, sampling: 'lhs', seed: 8 });
    expect(orderShots(drawn, [steps])).toEqual(drawn);
  });

  it('leaves everything alone when nothing is marked expensive', () => {
    const drawn = drawShots({ factors: [steps, { ...model, cost: 0 }], shots: 12, sampling: 'lhs', seed: 2 });
    expect(orderShots(drawn, [steps, { ...model, cost: 0 }])).toEqual(drawn);
  });

  it('counts the switches it will cost to run the plan', () => {
    const plan = [
      { m: 'a', s: 1 },
      { m: 'a', s: 2 },
      { m: 'b', s: 1 },
    ];
    const factors: CategoricalFactor[] = [
      { kind: 'categorical', key: 'm', label: 'Model', levels: ['a', 'b'], cost: 3 },
      { kind: 'categorical', key: 's', label: 'Steps', levels: [1, 2], cost: 0 },
    ];
    expect(switchCounts(plan, factors)).toEqual([
      { key: 'm', label: 'Model', switches: 1 },
      { key: 's', label: 'Steps', switches: 2 },
    ]);
  });
});

/** Plain Pearson, only for asserting that two drawn columns are unrelated. */
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;
  let top = 0;
  let leftSq = 0;
  let rightSq = 0;
  for (let i = 0; i < n; i += 1) {
    const left = (a[i] as number) - meanA;
    const right = (b[i] as number) - meanB;
    top += left * right;
    leftSq += left * left;
    rightSq += right * right;
  }
  return top / Math.sqrt(leftSq * rightSq);
}
