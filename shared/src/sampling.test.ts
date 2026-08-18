import { describe, expect, it } from 'vitest';

import {
  defaultSampling,
  SAMPLING_GROUPS,
  SAMPLING_PARAMS,
  samplingOverrides,
} from './apiTypes.js';

/**
 * Sampling is opt-in, one parameter at a time.
 *
 * The thing worth guarding is the *empty* case: an untouched install has to put
 * nothing at all in the request, because the model server was launched with the
 * sampling its model wants and anything sent from here silently overrides it.
 * That is a property nobody would notice breaking — the replies would just
 * quietly get worse.
 */

describe('what an untouched install sends', () => {
  it('is nothing', () => {
    expect(samplingOverrides(defaultSampling())).toEqual({});
  });

  it('is nothing for settings written before any of this existed', () => {
    expect(samplingOverrides(undefined)).toEqual({});
    expect(samplingOverrides({})).toEqual({});
  });

  it('starts every parameter at the value llama.cpp would have used', () => {
    const sampling = defaultSampling();
    for (const param of SAMPLING_PARAMS) {
      expect(sampling[param.key]).toEqual({ on: false, value: param.value });
    }
  });
});

describe('what a switched-on parameter sends', () => {
  it('is only the ones switched on', () => {
    const sampling = defaultSampling();
    sampling.temperature = { on: true, value: 0.4 };
    sampling.min_p = { on: true, value: 0.08 };
    // Carries a value, but is off — so it stays out of the request.
    sampling.top_k = { on: false, value: 20 };

    expect(samplingOverrides(sampling)).toEqual({ temperature: 0.4, min_p: 0.08 });
  });

  it('clamps to what the parameter allows', () => {
    const sampling = defaultSampling();
    // Settings are stored as JSON and edited by hand often enough that the
    // sanitising cannot live only in the dialog's slider.
    sampling.temperature = { on: true, value: 99 };
    sampling.top_p = { on: true, value: -1 };

    expect(samplingOverrides(sampling)).toEqual({ temperature: 2, top_p: 0 });
  });

  it('rounds the ones that count things', () => {
    const sampling = defaultSampling();
    sampling.top_k = { on: true, value: 40.6 };
    sampling.mirostat = { on: true, value: 1.2 };
    sampling.min_p = { on: true, value: 0.055 };

    // Whole numbers where the step is whole; untouched where it is not.
    expect(samplingOverrides(sampling)).toEqual({ top_k: 41, mirostat: 1, min_p: 0.055 });
  });

  it('leaves out a value that is not a number at all', () => {
    const sampling = defaultSampling();
    sampling.temperature = { on: true, value: Number.NaN };
    expect(samplingOverrides(sampling)).toEqual({});
  });
});

describe('the parameter list itself', () => {
  it('names each parameter once', () => {
    const keys = SAMPLING_PARAMS.map((param) => param.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts every parameter in a group the dialog draws', () => {
    const groups = new Set(SAMPLING_GROUPS.map((group) => group.key));
    for (const param of SAMPLING_PARAMS) {
      expect(groups.has(param.group)).toBe(true);
    }
  });

  it('starts each one inside its own range', () => {
    for (const param of SAMPLING_PARAMS) {
      expect(param.min).toBeLessThan(param.max);
      expect(param.value).toBeGreaterThanOrEqual(param.min);
      expect(param.value).toBeLessThanOrEqual(param.max);
    }
  });
});
