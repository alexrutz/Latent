import type { ParamSummaryItem } from './apiTypes.js';
import type { ParamField, ParamSchema, ParamValues } from './paramTypes.js';

/**
 * Drawing numeric parameters from a range, alongside the random prompt.
 *
 * A random prompt varies *what* is in the picture; this varies *how it is made*.
 * Sweeping CFG from 4 to 9 in steps of 1 across a batch of eight is the single
 * most common thing anyone does by hand with a queue, and it is tedious in
 * exactly the way a phone makes worse.
 *
 * Discrete by design. A continuous range would give 7.318294 and make two runs
 * impossible to compare; a range plus an interval gives a small set of values you
 * can actually reason about, and the UI shows that set so there is no guessing
 * what a rule will do.
 */

export interface RandomParamRule {
  /** Field id, e.g. `3.steps`. */
  key: string;
  /** Label as it was when the rule was made, for display if the field is gone. */
  label: string;
  min: number;
  max: number;
  /** Distance between candidates. Zero or less means "only `min`". */
  step: number;
}

/**
 * Ceiling on how many candidates one rule may produce.
 *
 * Guards against a range of 0–10000 with a step of 0.01 turning into a hundred
 * thousand element array on every submit. Well past any useful sweep.
 */
export const MAX_CANDIDATES = 64;

/**
 * The values a rule can actually produce, in order.
 *
 * Rounded to the step's own precision: floating-point addition otherwise walks
 * 7.5 → 8.000000000000002, which then shows up in the recorded settings and
 * makes two identical runs look different.
 */
export function candidateValues(rule: RandomParamRule): number[] {
  const min = Math.min(rule.min, rule.max);
  const max = Math.max(rule.min, rule.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (!Number.isFinite(rule.step) || rule.step <= 0) return [min];

  const decimals = decimalsOf(rule.step);
  const values: number[] = [];
  for (let i = 0; values.length < MAX_CANDIDATES; i += 1) {
    const value = round(min + i * rule.step, decimals);
    if (value > max + Number.EPSILON) break;
    values.push(value);
  }
  return values.length > 0 ? values : [min];
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(text.length - dot - 1, 6);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Coerce a stored or wire-format rule list into something safe to run. */
export function normaliseRandomParams(raw: unknown): RandomParamRule[] {
  if (!Array.isArray(raw)) return [];

  const rules: RandomParamRule[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<Record<keyof RandomParamRule, unknown>>;

    const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
    // One rule per field: two rules for `3.steps` would silently fight, with the
    // last one written winning and no way to see why.
    if (key === '' || seen.has(key)) continue;

    const min = Number(candidate.min);
    const max = Number(candidate.max);
    const step = Number(candidate.step);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;

    seen.add(key);
    rules.push({
      key,
      label: typeof candidate.label === 'string' && candidate.label ? candidate.label : key,
      min: Math.min(min, max),
      max: Math.max(min, max),
      step: Number.isFinite(step) && step > 0 ? step : 1,
    });
  }

  return rules;
}

/**
 * Draw one value for each rule.
 *
 * Rules naming a field the workflow does not have are skipped rather than
 * written blindly: a rule outlives the workflow it was made for, and injecting
 * `3.steps` into a graph with no node 3 would be rejected by ComfyUI with a
 * message about a field the user never touched.
 */
export function drawRandomParams(
  schema: ParamSchema,
  rules: RandomParamRule[],
  random: () => number = Math.random,
): ParamValues {
  const byId = new Map(schema.fields.map((field) => [field.id, field]));
  const drawn: ParamValues = {};

  for (const rule of rules) {
    const field = byId.get(rule.key);
    if (!field) continue;

    const values = candidateValues(rule);
    if (values.length === 0) continue;

    const picked = values[Math.floor(random() * values.length)] ?? values[0]!;
    drawn[rule.key] = clampToField(picked, field);
  }

  return drawn;
}

/** Respect the node's own limits, so a rule can never submit an invalid graph. */
function clampToField(value: number, field: ParamField): number {
  let result = value;
  if (typeof field.min === 'number') result = Math.max(result, field.min);
  if (typeof field.max === 'number') result = Math.min(result, field.max);
  return field.control === 'int' ? Math.round(result) : result;
}

/** Fields a rule can sensibly be made for: the numeric ones. */
export function variableFields(schema: ParamSchema): ParamField[] {
  return schema.fields.filter(
    (field) => field.control === 'int' || field.control === 'float',
  );
}

/** A starting rule for a field, using the range the slider already uses. */
export function defaultRuleFor(field: ParamField): RandomParamRule {
  const min = field.softMin ?? field.min ?? 0;
  const max = field.softMax ?? field.max ?? min + 10;
  const span = Math.abs(max - min);

  // Aim for a handful of candidates rather than a hundred: a sweep you can hold
  // in your head is the point.
  const rough = span / 8;
  const step =
    field.control === 'int'
      ? Math.max(1, Math.round(rough))
      : Math.max(0.05, Math.round(rough * 20) / 20);

  return { key: field.id, label: field.label, min, max, step };
}

/* ------------------------------------------------------------------ */
/* Short labels for on-image overlays                                  */
/* ------------------------------------------------------------------ */

/**
 * Two-letter-ish abbreviations for a chosen set of parameters, disambiguated.
 *
 * A thumbnail has room for `St20 C8`, not `Steps 20 CFG 8`. Naively taking two
 * letters collides immediately — Steps, Seed and Sampler all become "Se"/"St" —
 * so each label is lengthened only as far as it needs to be to stay distinct
 * within the set actually on screen.
 */
export function shortLabels(labels: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const label of labels) {
    const cleaned = label.replace(/[^A-Za-z0-9]/g, '');
    if (cleaned === '') {
      result[label] = '?';
      continue;
    }

    let length = Math.min(2, cleaned.length);
    let candidate = format(cleaned, length);

    // Grow until it no longer collides with one already assigned.
    while (
      length < cleaned.length &&
      Object.entries(result).some(([other, value]) => other !== label && value === candidate)
    ) {
      length += 1;
      candidate = format(cleaned, length);
    }

    result[label] = candidate;
  }

  return result;
}

function format(cleaned: string, length: number): string {
  const slice = cleaned.slice(0, length);
  return slice.charAt(0).toUpperCase() + slice.slice(1).toLowerCase();
}

/**
 * The parameters an overlay can offer, gathered from what is on screen.
 *
 * Driven by the recorded summaries rather than the workflow: the gallery holds
 * results from several workflows at once, and the useful list is the union of
 * what those runs actually recorded.
 */
export function overlayChoices(summaries: ParamSummaryItem[][]): { key: string; label: string }[] {
  const byKey = new Map<string, string>();
  for (const summary of summaries) {
    for (const item of summary) {
      if (!byKey.has(item.key)) byKey.set(item.key, item.label);
    }
  }
  return [...byKey.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
