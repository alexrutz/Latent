import { applyArrangement, applyOverrides } from '@latent/shared';
import type { FieldOverrides, ParamSchema } from '@latent/shared';

import type { Store } from './db.js';

/**
 * The schema as the form actually shows it.
 *
 * Three layers, innermost first: what the graph and `/object_info` imply, then
 * the general arrangement that applies to every workflow, then whatever was
 * set by hand for this one. The order is the precedence — the outermost layer
 * wins — and it is the whole contract of the arrangement: a general opinion
 * fills in where a workflow has none, and never overwrites one it has.
 *
 * In one function because there are four places that need the answer — the
 * form the client draws, the graph a run is built from, a study's shots, and a
 * study's field list — and four copies of a three-layer composition is four
 * chances for one of them to apply two of the layers.
 */
export function resolveSchema(
  store: Store,
  schema: ParamSchema,
  overrides: FieldOverrides = {},
): ParamSchema {
  return applyOverrides(applyArrangement(schema, store.getSettings().fieldArrangement), overrides);
}
