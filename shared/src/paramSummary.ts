import type { ParamSummaryItem } from './apiTypes.js';
import type { WidgetValue } from './comfyTypes.js';
import type { ParamRole, ParamSchema, ParamValues } from './paramTypes.js';

/**
 * Turn a submitted value set into something readable in a queue listing.
 *
 * The queue is where you go to kill a job you no longer want, and doing that
 * needs you to tell eight otherwise-identical entries apart. A prompt alone is
 * not enough — queueing the same prompt at three step counts is the normal way
 * to work — so each entry carries the values it was actually given.
 *
 * Computed at submit time and stored with the generation: the workflow's form
 * can be re-arranged or deleted later, and this has to keep describing what was
 * run rather than what the workflow looks like now.
 */

/**
 * Reading order for the whole summary.
 *
 * Fixed rather than following the graph, so the same values sit in the same
 * places whichever workflow produced them — which is the only way a column of
 * queue cards can be compared by eye.
 */
const ROLE_ORDER: ParamRole[] = [
  'steps',
  'cfg',
  'sampler',
  'scheduler',
  'denoise',
  'seed',
  'width',
  'height',
  'aspect_ratio',
  'megapixels',
  'batch_size',
  'model',
  'lora',
  'lora_text',
  'vae',
  'image_input',
];

/**
 * What the collapsed card shows.
 *
 * Not the prompt — it is already the entry's title. Emphatically the seed: a
 * batch of eight differs *only* by seed, which is exactly the case where you
 * need to pick one out, so leaving it off made the card useless for the job it
 * exists to do. Scheduler, denoise and batch size are real settings but rarely
 * what distinguishes two queued jobs, so they wait behind the toggle.
 */
const PRIMARY_ROLES: ParamRole[] = [
  'steps',
  'cfg',
  'sampler',
  'seed',
  'width',
  'height',
  // The other way a workflow says how big the picture is; a card that shows
  // neither shape nor size says nothing about the picture at all.
  'aspect_ratio',
  'megapixels',
  'model',
];

/** Never worth a line of their own in a summary. */
const SKIPPED_ROLES: ParamRole[] = ['prompt', 'negative_prompt'];

/** A guard against a pathological graph, not a design constraint. */
const PRIMARY_LIMIT = 10;

export function buildParamSummary(
  schema: ParamSchema,
  values: ParamValues,
): ParamSummaryItem[] {
  const items: ParamSummaryItem[] = [];

  for (const field of schema.fields) {
    if (SKIPPED_ROLES.includes(field.role)) continue;

    // Fall back to the field's default: a value the user never touched was still
    // what the job ran with.
    const raw = field.id in values ? values[field.id] : field.defaultValue;
    const value = formatValue(raw);
    if (value === '') continue;

    items.push({
      key: field.id,
      label: field.label,
      value,
      primary: PRIMARY_ROLES.includes(field.role) && !field.hidden,
    });
  }

  items.sort((a, b) => rank(schema, a) - rank(schema, b));

  // A 40-input workflow would otherwise put 30 chips on the collapsed row.
  let promoted = 0;
  for (const item of items) {
    if (!item.primary) continue;
    promoted += 1;
    if (promoted > PRIMARY_LIMIT) item.primary = false;
  }

  return items;
}

function rank(schema: ParamSchema, item: ParamSummaryItem): number {
  const field = schema.fields.find((candidate) => candidate.id === item.key);
  const index = field ? ROLE_ORDER.indexOf(field.role) : -1;
  // A role we have no opinion about keeps its schema order, after the known ones.
  return index >= 0 ? index : ROLE_ORDER.length + (field?.order ?? 0);
}

/**
 * Render a widget value as a short string.
 *
 * Long text is truncated rather than dropped: a LoRA tag string is worth seeing
 * the start of, and a 2000-character prompt is not worth sending to the client
 * once per queue entry.
 */
function formatValue(value: WidgetValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') {
    // Trim float noise: 7.5 stays 7.5, 7.500000001 does not become a novel.
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }

  const text = String(value).trim().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** The values a compact summary line should show, in order. */
export function primaryParams(params: ParamSummaryItem[]): ParamSummaryItem[] {
  return params.filter((item) => item.primary);
}

/**
 * The naming convention for "preview as text" nodes.
 *
 * A workflow can print several things — a rewritten prompt, a caption, the
 * reasoning that produced either — and until the node says which is which they
 * are an undifferentiated list of paragraphs. Titling one
 * `rewrite prompt [thinking]` says both what it is and which half of a model's
 * output it carries, so the gallery can label it rather than dumping it.
 */
export type TextOutputKind = 'thinking' | 'answer';

export interface TextOutputName {
  /** The part before the bracket, e.g. `rewrite prompt`. */
  name: string;
  /** `null` when the title follows no convention, which is fine. */
  kind: TextOutputKind | null;
}

export function parseTextOutputName(title: string): TextOutputName {
  const match = /^(.*?)\s*\[(thinking|answer)\]\s*$/i.exec(title.trim());
  if (!match) return { name: title.trim(), kind: null };
  return {
    name: (match[1] ?? '').trim() || title.trim(),
    kind: match[2]!.toLowerCase() as TextOutputKind,
  };
}

/**
 * A label for one text output: the name, with the kind only when there is one.
 *
 * `rewrite prompt [thinking]` reads as "rewrite prompt · thinking" — the same
 * information without the punctuation of a filename.
 */
export function textOutputLabel(title: string): string {
  const parsed = parseTextOutputName(title);
  return parsed.kind ? `${parsed.name} · ${parsed.kind}` : parsed.name;
}
