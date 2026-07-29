/**
 * Parsing and editing of prompt-style LoRA tags.
 *
 * A tag looks like `<lora:styleName:0.8>` or `<lora:styleName:0.8:0.6>` (model
 * strength, then CLIP strength). They are embedded in a text field alongside
 * ordinary prose, which is fine to type on a keyboard and miserable on a phone —
 * hence the structured editor this module backs.
 *
 * Pure: no I/O, no React. Everything here is directly unit-testable.
 */

export interface LoraTag {
  name: string;
  /** Model strength. */
  strength: number;
  /** CLIP strength, when the tag specified one separately. */
  clipStrength?: number;
}

export interface ParsedLoraText {
  tags: LoraTag[];
  /** The text with every recognised tag removed and whitespace tidied. */
  text: string;
  /** True when the source contained at least one tag. */
  hasTags: boolean;
}

/**
 * Matches `<lora:NAME:STRENGTH>` and `<lora:NAME:STRENGTH:CLIP>`.
 *
 * The name is anything up to the next colon or `>`, so paths like
 * `folder/style.safetensors` work. Strengths may be negative or decimal.
 */
const LORA_TAG = /<lora:([^:<>]+):(-?\d*\.?\d+)(?::(-?\d*\.?\d+))?>/gi;

/** Does this text contain anything we would treat as a LoRA tag? */
export function hasLoraTags(text: string): boolean {
  LORA_TAG.lastIndex = 0;
  return LORA_TAG.test(text);
}

/** Collapse the whitespace left behind after removing tags mid-sentence. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

export function parseLoraTags(input: string): ParsedLoraText {
  const source = typeof input === 'string' ? input : '';
  const tags: LoraTag[] = [];

  LORA_TAG.lastIndex = 0;
  const stripped = source.replace(LORA_TAG, (_match, name: string, strength: string, clip?: string) => {
    const parsed: LoraTag = {
      name: name.trim(),
      strength: Number(strength),
    };
    // Only record a CLIP strength when it actually differs — carrying a
    // redundant one around would make the editor show two identical sliders.
    if (clip !== undefined && Number(clip) !== parsed.strength) {
      parsed.clipStrength = Number(clip);
    }
    tags.push(parsed);
    return '';
  });

  return { tags, text: tidy(stripped), hasTags: tags.length > 0 };
}

function formatStrength(value: number): string {
  if (!Number.isFinite(value)) return '1';
  // Trim trailing zeros: `0.80` reads as hand-edited, `0.8` as intentional.
  return String(Number(value.toFixed(3)));
}

export function formatLoraTag(tag: LoraTag): string {
  const strength = formatStrength(tag.strength);
  return tag.clipStrength !== undefined && tag.clipStrength !== tag.strength
    ? `<lora:${tag.name}:${strength}:${formatStrength(tag.clipStrength)}>`
    : `<lora:${tag.name}:${strength}>`;
}

/**
 * Rewrite a text field's LoRA tags, leaving the prose intact.
 *
 * Existing tags are removed and the new set appended, so the editor is the
 * single source of truth for which LoRAs are active while whatever the user
 * typed around them survives untouched.
 */
export function serializeLoraTags(originalText: string, tags: LoraTag[]): string {
  const { text } = parseLoraTags(originalText);
  if (tags.length === 0) return text;

  const rendered = tags.map(formatLoraTag).join(' ');
  return text ? `${text} ${rendered}` : rendered;
}

/** Convenience for the editor: replace one tag by index. */
export function updateLoraTag(tags: LoraTag[], index: number, patch: Partial<LoraTag>): LoraTag[] {
  return tags.map((tag, i) => (i === index ? { ...tag, ...patch } : tag));
}

export function removeLoraTag(tags: LoraTag[], index: number): LoraTag[] {
  return tags.filter((_, i) => i !== index);
}
