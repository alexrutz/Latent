import type {
  FieldPoints,
  FieldWidth,
  NumericInputMode,
  ParamField,
  ParamGroup,
  ParamSchema,
} from './paramTypes.js';

/**
 * One arrangement for every workflow, keyed by what a field is called.
 *
 * The form editor arranges *a* workflow. That is the right tool for the one
 * that needs something unusual and the wrong one for everything else, because
 * the same handful of fields turn up in every workflow anybody writes — steps,
 * cfg, the sampler, the size, a duration — and an opinion about them is an
 * opinion about all of them. "Duration matters, keep it under Advanced and half
 * a row wide" is one sentence, and before this it had to be repeated per
 * workflow and repeated again for every workflow imported afterwards.
 *
 * So the arrangement is keyed by the field's **input name** — `steps`,
 * `duration`, `cfg` — which is what the same field is called wherever it
 * appears, whatever node it hangs off and whatever id that node was given. Two
 * different nodes that both take a `duration` are, for this purpose, the same
 * field: that is the assumption the feature is, and the reason it is useful.
 *
 * Nothing here is a requirement. A workflow that has no `duration` ignores the
 * entry for one, and a workflow with its own opinion keeps it — see
 * `applyArrangement`, which runs *before* the per-workflow overrides so that
 * anything set by hand for one workflow still wins.
 */
export interface ArrangedField {
  /** The input name. `steps`, not `3.steps` — the point is that it travels. */
  name: string;
  /** What to call it, when the derived label is not what you want to read. */
  label?: string;
  group?: ParamGroup;
  hidden?: boolean;
  width?: FieldWidth;
  inputMode?: NumericInputMode;
  points?: FieldPoints;
}

/**
 * The arrangement, in order.
 *
 * A list rather than a map with positions in it, because the position *is* the
 * list: two places to store one fact is how an order and its index disagree.
 */
export type FieldArrangement = ArrangedField[];

/**
 * Apply the general arrangement to one workflow's schema.
 *
 * Two things happen, and only one of them is obvious. The attributes an entry
 * sets are copied onto every field of that name — that is the obvious one. The
 * other is the order: fields the arrangement names are put in the order it
 * names them, and everything else keeps its derived order behind them. An
 * arrangement is a running order, so anything you have not placed goes after
 * what you have.
 *
 * Fields the arrangement does not mention, and workflows missing the fields it
 * does, are simply left alone. That is what makes one arrangement usable across
 * workflows that have almost nothing in common: it is a set of opinions, not a
 * template that has to fit.
 *
 * Gaps close by themselves. Half-width fields are laid out by `planFormRuns`,
 * which merges *adjacent* ones into a row — so when a workflow is missing the
 * second half of a pair, the next half-width field moves up into the space
 * rather than leaving a hole where a field would have been.
 */
export function applyArrangement(
  schema: ParamSchema,
  arrangement: FieldArrangement = [],
): ParamSchema {
  if (arrangement.length === 0) return schema;

  const byName = new Map<string, { entry: ArrangedField; at: number }>();
  arrangement.forEach((entry, at) => {
    // First mention wins, so a list that somehow names one field twice still
    // has one answer for it rather than a different one per lookup.
    if (!byName.has(entry.name)) byName.set(entry.name, { entry, at });
  });

  const placed = schema.fields.map((field, index) => {
    const found = byName.get(field.inputName);
    if (!found) return { field: { ...field }, at: Number.MAX_SAFE_INTEGER, index };
    const { entry, at } = found;
    return {
      field: {
        ...field,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.group !== undefined ? { group: entry.group } : {}),
        ...(entry.hidden !== undefined ? { hidden: entry.hidden } : {}),
        ...(entry.width !== undefined ? { width: entry.width } : {}),
        ...(entry.inputMode !== undefined ? { inputMode: entry.inputMode } : {}),
        ...(entry.points !== undefined ? { points: entry.points } : {}),
      },
      at,
      index,
    };
  });

  /*
   * Sorted by the arrangement, then by where the field already was.
   *
   * The second half matters as much as the first: two fields the arrangement
   * says nothing about must not swap places just because they were compared,
   * and `index` — their position in the schema as derived — is the tie-break
   * that keeps the sort stable across engines that do not promise it.
   */
  placed.sort((a, b) => {
    const group = groupRank(a.field.group) - groupRank(b.field.group);
    if (group !== 0) return group;
    if (a.at !== b.at) return a.at - b.at;
    if (a.field.order !== b.field.order) return a.field.order - b.field.order;
    return a.index - b.index;
  });

  /*
   * Renumbered from zero within each group.
   *
   * `order` is a position, and the per-workflow overrides that come next write
   * positions counted the same way — 0, 1, 2 within a group, which is what the
   * editor produces when something is dragged. Leaving the derived numbers here
   * would put two different number lines in one comparison.
   */
  const counts: Record<string, number> = {};
  const fields: ParamField[] = placed.map(({ field }) => {
    const next = counts[field.group] ?? 0;
    counts[field.group] = next + 1;
    return { ...field, order: next };
  });

  return {
    ...schema,
    fields,
    capabilities: {
      ...schema.capabilities,
      // Hiding the image input from every workflow at once still has to stop
      // those workflows offering to accept a picture.
      img2img: fields.some((field) => field.role === 'image_input' && !field.hidden),
      seeded: fields.some((field) => field.role === 'seed' && !field.hidden),
    },
  };
}

function groupRank(group: ParamGroup): number {
  return group === 'main' ? 0 : 1;
}

/** One row of the pool: a field name, and where it turns up. */
export interface PoolField {
  name: string;
  /** The label most of the workflows derive for it, for something to read. */
  label: string;
  /** How many visible workflows have a field of this name. */
  workflows: number;
  /** Node classes it hangs off, so an ambiguous name can be recognised. */
  classes: string[];
  /**
   * Whether this is a number, and so whether asking "slider or points" means
   * anything for it.
   *
   * True when *every* field of the name is numeric. A name used for a number in
   * one workflow and a string in another gets no input-mode choice, because an
   * answer that applied to both would be an answer to a question one of them
   * cannot be asked.
   */
  numeric: boolean;
}

/**
 * Every distinct field across the workflows in use, most widespread first.
 *
 * The pool is what makes the arrangement editable at all: no single workflow
 * has every field in it, so arranging them one workflow at a time could never
 * produce a general order. Sorted by how many workflows have a field, because
 * the ones worth an opinion are the ones that keep turning up.
 */
export function poolFields(schemas: ParamSchema[]): PoolField[] {
  const seen = new Map<
    string,
    { labels: Map<string, number>; classes: Set<string>; count: number; numeric: boolean }
  >();

  for (const schema of schemas) {
    // Counted once per workflow, not once per field: a graph with three
    // KSamplers has three `steps`, and it is still one workflow that has one.
    const here = new Set<string>();
    for (const field of schema.fields) {
      const entry = seen.get(field.inputName) ?? {
        labels: new Map<string, number>(),
        classes: new Set<string>(),
        count: 0,
        numeric: true,
      };
      entry.labels.set(field.label, (entry.labels.get(field.label) ?? 0) + 1);
      entry.classes.add(field.classType);
      // Every one of them, not any: see `PoolField.numeric`.
      entry.numeric &&= field.control === 'int' || field.control === 'float';
      if (!here.has(field.inputName)) {
        entry.count += 1;
        here.add(field.inputName);
      }
      seen.set(field.inputName, entry);
    }
  }

  return [...seen.entries()]
    .map(([name, entry]) => ({
      name,
      label: commonest(entry.labels) ?? name,
      workflows: entry.count,
      classes: [...entry.classes].sort(),
      numeric: entry.numeric,
    }))
    .sort((a, b) => b.workflows - a.workflows || a.label.localeCompare(b.label));
}

function commonest(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let most = 0;
  // Ties go to the alphabetically first, so the pool does not reshuffle itself
  // between two equally common labels depending on which was counted first.
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > most) {
      most = count;
      best = value;
    }
  }
  return best;
}

/** Add a field to the end of the arrangement, or leave it where it is. */
export function placeField(arrangement: FieldArrangement, name: string): FieldArrangement {
  if (arrangement.some((entry) => entry.name === name)) return arrangement;
  return [...arrangement, { name }];
}

/** Take a field out of the arrangement, so every workflow decides for itself again. */
export function unplaceField(arrangement: FieldArrangement, name: string): FieldArrangement {
  return arrangement.filter((entry) => entry.name !== name);
}

/** Change one placed field's attributes, leaving its position alone. */
export function patchArranged(
  arrangement: FieldArrangement,
  name: string,
  change: Partial<Omit<ArrangedField, 'name'>>,
): FieldArrangement {
  return arrangement.map((entry) => (entry.name === name ? { ...entry, ...change } : entry));
}

/** Put the arrangement in a given order of names, dropping any it does not hold. */
export function reorderArrangement(
  arrangement: FieldArrangement,
  names: string[],
): FieldArrangement {
  const byName = new Map(arrangement.map((entry) => [entry.name, entry]));
  const moved = names
    .map((name) => byName.get(name))
    .filter((entry): entry is ArrangedField => entry !== undefined);
  // Anything the caller did not mention keeps its place at the end rather than
  // being dropped: a reorder is not a deletion.
  const mentioned = new Set(moved.map((entry) => entry.name));
  return [...moved, ...arrangement.filter((entry) => !mentioned.has(entry.name))];
}

/**
 * Whether a workflow's own overrides are overriding the general order.
 *
 * The per-workflow editor writes a position for *every* field in a group each
 * time one is dragged, and those beat the arrangement — which is the right
 * precedence and an invisible one. Somebody who arranges the fields generally
 * and then finds one workflow ignoring it deserves to be told why, and offered
 * the one button that fixes it.
 */
export function hasOwnOrder(overrides: Record<string, { order?: number }> = {}): boolean {
  return Object.values(overrides).some((override) => override.order !== undefined);
}

/** The same overrides with every position dropped, so the arrangement decides. */
export function clearOwnOrder<T extends { order?: number }>(
  overrides: Record<string, T> = {},
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [id, override] of Object.entries(overrides)) {
    const { order: _order, ...rest } = override;
    // An override that was *only* a position is dropped entirely rather than
    // left as an empty object nobody can see the effect of.
    if (Object.keys(rest).length > 0) next[id] = rest as T;
  }
  return next;
}
