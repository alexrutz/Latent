/**
 * The models installed on the ComfyUI machine, and the words each one wants.
 *
 * A LoRA does a fraction of what it can without its trigger words, and those
 * words live on the page you downloaded it from — which is not open, on a
 * phone, at the moment you are writing a prompt. So in practice they are typed
 * from memory or not at all, and the LoRA quietly underperforms in a way that
 * looks like the LoRA being disappointing.
 *
 * Three places the words can come from, and the whole point of this module is
 * that they are ranked rather than merged:
 *
 * 1. **Yours.** Typed in the Models tab, and always right, because you typed
 *    them after using the thing.
 * 2. **Civitai's**, from the creator — `trainedWords` on the model version,
 *    looked up by the file's SHA256.
 * 3. **The file's own header**, which for a kohya-trained LoRA holds the tag
 *    frequencies it was trained on. Not the same as trigger words, often close
 *    enough, and the only source that works with no network at all.
 *
 * Ranked rather than merged because a merge produces a prompt fragment nobody
 * wrote: the creator's two words plus thirty training tags is not a prompt, it
 * is a word cloud. One source wins, and the others stay visible so you can see
 * what you are overriding.
 */

/** The folders worth a library. Both are what `/object_info` names them. */
export type ModelFolder = 'loras' | 'checkpoints';

export const MODEL_FOLDERS: ModelFolder[] = ['loras', 'checkpoints'];

/** One model file, as its own header describes it. */
export interface ModelFile {
  /** Exactly what a `<lora:…>` tag takes, and what `/object_info` offers. */
  name: string;
  size: number | null;
  modified: number | null;
  /** What it was trained on, commonest first. See the module note. */
  trainedTags: string[];
  baseModel: string | null;
  title: string | null;
  description: string | null;
  networkDim: string | null;
  networkAlpha: string | null;
  clipSkip: string | null;
  trainImages: string | null;
  /** False for a `.ckpt`, a truncated download, or a header with nothing in it. */
  hasMetadata: boolean;
}

/** What Civitai says about a file, keyed by its hash. */
export interface CivitaiInfo {
  modelId: number | null;
  versionId: number | null;
  name: string | null;
  versionName: string | null;
  baseModel: string | null;
  /** The creator's own trigger words. The reason this lookup exists. */
  trainedWords: string[];
  /** The version notes, as plain text — Civitai sends HTML. */
  description: string | null;
  /** The page, so "where did this come from" is one tap. */
  url: string | null;
  fetchedAt: number;
}

/** What Latent knows about a model beyond what the file says. */
export interface ModelNote {
  folder: ModelFolder;
  name: string;
  /** Your own words. Empty means "no opinion", not "no words". */
  triggerWords: string[];
  /** How to use it: the weight it likes, what it fights with, when to reach for it. */
  notes: string;
  /** The strength a `<lora:…>` tag gets when this one is added. */
  strength: number | null;
  civitai: CivitaiInfo | null;
  sha256: string | null;
  updatedAt: number;
}

/** A model with everything known about it, ready to list. */
export interface ModelSummary extends ModelFile {
  folder: ModelFolder;
  note: ModelNote | null;
  /** The words to actually use. See `resolveWords`. */
  words: string[];
  /** Which of the three they came from, so the screen can say. */
  wordsFrom: WordSource;
}

export type WordSource = 'yours' | 'civitai' | 'trained' | 'none';

/** The default a LoRA gets when nothing has been said about it. */
export const DEFAULT_LORA_STRENGTH = 0.8;

/**
 * Which words to use, and where they came from.
 *
 * Yours, then the creator's, then the file's own — first non-empty wins. See
 * the module note for why this is a ranking and not a merge.
 */
export function resolveWords(
  file: Pick<ModelFile, 'trainedTags'>,
  note: ModelNote | null | undefined,
): { words: string[]; from: WordSource } {
  const yours = (note?.triggerWords ?? []).filter((word) => word.trim() !== '');
  if (yours.length > 0) return { words: yours, from: 'yours' };

  const civitai = (note?.civitai?.trainedWords ?? []).filter((word) => word.trim() !== '');
  if (civitai.length > 0) return { words: civitai, from: 'civitai' };

  const trained = (file.trainedTags ?? []).filter((word) => word.trim() !== '');
  if (trained.length > 0) return { words: trained, from: 'trained' };

  return { words: [], from: 'none' };
}

/**
 * The strength to give a LoRA when it is added to a prompt.
 *
 * Yours if you set one. Not inferred from anything else: a LoRA's own header
 * records the alpha it was *trained* with, which is not the weight it wants at
 * inference and reading it as one would be a confident wrong answer.
 */
export function strengthFor(note: ModelNote | null | undefined): number {
  const stored = note?.strength;
  return typeof stored === 'number' && Number.isFinite(stored) ? stored : DEFAULT_LORA_STRENGTH;
}

/**
 * Add words to a prompt without repeating what is already in it.
 *
 * The check is on the whole word, case-insensitively, because "a woman" is
 * already there when the prompt says "A woman walks" and adding it again is how
 * a prompt ends up reading like a stutter. Order is preserved: the prompt keeps
 * its shape and the new words follow it.
 */
export function addWords(prompt: string, words: string[]): string {
  const existing = prompt.toLowerCase();
  const wanted = words
    .map((word) => word.trim())
    .filter((word) => word !== '' && !containsWord(existing, word.toLowerCase()));

  if (wanted.length === 0) return prompt;
  const trimmed = prompt.trim();
  if (trimmed === '') return wanted.join(', ');
  // A prompt already ending in a comma is being continued, not punctuated.
  return /[,;]$/.test(trimmed)
    ? `${trimmed} ${wanted.join(', ')}`
    : `${trimmed}, ${wanted.join(', ')}`;
}

/**
 * Whether a phrase is already in the prompt, on word boundaries.
 *
 * Substring alone would call "cat" present in "delicate", and skipping a
 * trigger word because a longer word happens to contain it is a failure nobody
 * would ever diagnose.
 */
function containsWord(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + needle.length] ?? '';
    if (!isWordish(before) && !isWordish(after)) return true;
    from = at + 1;
  }
}

function isWordish(character: string): boolean {
  return character !== '' && /[\p{L}\p{N}_]/u.test(character);
}

/**
 * Strip Civitai's HTML down to something a phone can show.
 *
 * Their descriptions are a rich-text field: paragraphs, links, the occasional
 * embedded image. None of that belongs in a note under a LoRA's name, and
 * rendering it would mean rendering arbitrary HTML from a public site into the
 * app — so it is reduced to text here, on the way in, and stored as text.
 */
export function plainText(html: string | null | undefined, limit = 1200): string | null {
  if (typeof html !== 'string' || html.trim() === '') return null;

  const text = html
    // Breaks and block ends become newlines before the tags go, or every
    // paragraph runs into the next one.
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    // A blank line between paragraphs, one between list items: the difference
    // is what makes a description scannable rather than a wall.
    .replace(/<\/\s*(p|div|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\/\s*li\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text === '') return null;
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}
