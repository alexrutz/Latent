import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { objectInfoFixture } from './objectInfo.js';
import type { ObjectInfo } from '../apiTypes.js';

/**
 * The fixture against the nodes it stands in for.
 *
 * `comfyllama/` is vendored into this repo so the two can be changed together.
 * Latent builds its forms from ComfyUI's `/object_info`, and its tests build
 * them from `objectInfoFixture` — a hand-written copy of what those nodes
 * declare. Hand-written copies drift, and this one drifts silently: the tests
 * go on passing against a definition nobody has any more, and the first sign is
 * a form on a phone with a control that does nothing, or a missing one that
 * should have been there.
 *
 * So the nodes are asked. Only what Latent actually depends on is compared —
 * which inputs exist, in which section, in which order — not tooltips or
 * defaults, which change often and change nothing here. Order matters because
 * ComfyUI stores widget values positionally: a widget that moved is a saved
 * workflow whose values have all shifted by one.
 *
 * Skipped where there is no Python, so `npm test` still runs on a machine that
 * only has Node.
 */

const SCRIPT = fileURLToPath(new URL('../../../scripts/comfyllama-object-info.py', import.meta.url));

function realDefinitions(): ObjectInfo | null {
  for (const python of ['python3', 'python']) {
    try {
      const out = execFileSync(python, [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return JSON.parse(out) as ObjectInfo;
    } catch {
      continue;
    }
  }
  return null;
}

const real = realDefinitions();

/** The comfyllama classes the fixture claims to describe. */
const covered = Object.keys(objectInfoFixture).filter((name) => real && name in real);

describe.skipIf(real === null)('the fixture matches the vendored comfyllama nodes', () => {
  it('describes nodes that actually exist', () => {
    // A guard on the guard: if this ever finds nothing, the comparison below
    // would pass by describing nothing at all.
    expect(covered.length).toBeGreaterThan(0);
  });

  for (const section of ['required', 'optional'] as const) {
    it(`lists the same ${section} inputs, in the same order`, () => {
      for (const name of covered) {
        const mine = Object.keys(objectInfoFixture[name]?.input?.[section] ?? {});
        const theirs = Object.keys(real?.[name]?.input?.[section] ?? {});
        // The fixture is allowed to be a subset — it exists to exercise Latent,
        // not to restate every node — but what it does list must be in the
        // node, and in the node's order.
        expect({ node: name, inputs: mine }).toEqual({
          node: name,
          inputs: theirs.filter((input) => mine.includes(input)),
        });
      }
    });
  }

  it('agrees on what each node gives back', () => {
    for (const name of covered) {
      expect({ node: name, output: objectInfoFixture[name]?.output }).toEqual({
        node: name,
        output: real?.[name]?.output,
      });
    }
  });

  /*
   * The switch is why this file exists.
   *
   * It is appended after the encoding controls rather than put in front of
   * them, so that an already-saved ComfyUI workflow's positional widget values
   * do not all shift by one. Latent's form hides the two encoding controls
   * while it is off, so the two ends have to agree it is there at all.
   */
  it('carries the image switch on every chat node that takes a picture', () => {
    /*
     * An optional picture *and* the controls for encoding it. Both, because
     * either alone now names a node that has no switch and should not.
     *
     * The empty-latent node takes an optional picture too — to borrow a size
     * from — and has no encoding to govern, so nothing to switch. The vision
     * node has the encoding and no switch either, the other way round: its
     * picture is required, because sending one is what the node is for.
     */
    const chatNodes = Object.keys(real ?? {}).filter((name) => {
      const optional = real?.[name]?.input?.optional ?? {};
      return 'image' in optional && 'image_quality' in optional;
    });
    expect(chatNodes.length).toBeGreaterThan(0);
    for (const name of chatNodes) {
      const optional = Object.keys(real?.[name]?.input?.optional ?? {});
      // After the encoding controls it governs, not in front of them — and not
      // necessarily last overall, since anything added since is appended after
      // it for the same positional reason.
      expect({
        node: name,
        after: optional.indexOf('use_image') > optional.indexOf('image_quality'),
      }).toEqual({ node: name, after: true });
    }
  });
});
