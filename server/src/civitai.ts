import { plainText } from '@latent/shared';
import type { CivitaiExample, CivitaiInfo } from '@latent/shared';

/**
 * Asking Civitai what a file you already have actually is.
 *
 * Two endpoints, and the split between them is not where you would guess.
 * `GET /model-versions/by-hash/{sha256}` identifies a local file without
 * downloading anything, and answers with the **trigger words**, the base model,
 * a changelog and the creator's example pictures. But the thing people actually
 * read — what the model is for, what weight it likes, what it fights with —
 * hangs off `GET /models/{modelId}`, one level up. A library that fetched only
 * the first would be missing the paragraph the creator wrote to explain their
 * own model.
 *
 * The second request is allowed to fail. The trigger words are already in hand
 * by then and they are the point; losing the prose is a smaller library, not a
 * failed lookup.
 *
 * Keyed by hash rather than by name because names are what people rename. A
 * LoRA saved as `mystyle_v2_FINAL.safetensors` is unrecognisable by name and
 * exact by hash, and the hash is what Civitai indexes.
 *
 * No API key. This endpoint is public, and the whole point of the feature is
 * that it works on a fresh install with nothing configured — an account to set
 * up before a LoRA shows its trigger words would be a feature nobody reaches.
 */

/**
 * Where to ask.
 *
 * Overridable so the end-to-end suite can point it at a stand-in — the real
 * thing is a public service on the internet, and a test suite that depends on
 * one is a test suite that fails when somebody else's site is slow. The same
 * seam serves anybody running a mirror.
 */
const BASE = process.env.LATENT_CIVITAI_BASE ?? 'https://civitai.com/api/v1';

/** Long enough for a slow response, short enough not to hang a lookup queue. */
const TIMEOUT_MS = 12_000;

export class CivitaiError extends Error {
  override name = 'CivitaiError';
  constructor(
    message: string,
    /** True when the file is simply not on Civitai — a normal answer, not a fault. */
    readonly notFound = false,
  ) {
    super(message);
  }
}

/** The parts of a model-version response worth keeping. */
interface VersionResponse {
  id?: number;
  modelId?: number;
  name?: string;
  baseModel?: string;
  description?: string;
  trainedWords?: unknown;
  model?: { name?: string; type?: string };
  images?: unknown;
}

/** The parts of a *model* response worth keeping. See `CivitaiInfo`. */
interface ModelResponse {
  name?: string;
  description?: string;
  type?: string;
  tags?: unknown;
  creator?: { username?: string };
}

/** How many example pictures are kept. */
const MAX_EXAMPLES = 8;

/** Hosts an example image may come from, so the proxy cannot be pointed anywhere. */
export const IMAGE_HOSTS = ['image.civitai.com', 'imagecache.civitai.com'];

/**
 * Whether a URL is an example image we are willing to fetch.
 *
 * This is the whole security of the proxy route. Without it, `/api/models/
 * example?url=…` is a machine that fetches whatever anybody names from inside
 * the network Latent runs in — the classic shape of a server-side request
 * forgery. An allowlist of hostnames, matched exactly, and https only.
 *
 * `LATENT_CIVITAI_IMAGE_ORIGIN` adds one origin for the end-to-end suite, whose
 * stand-in obviously is not on Civitai's CDN. It is an origin rather than a
 * hostname so that setting it cannot quietly permit plain http to a real host.
 */
export function isExampleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && IMAGE_HOSTS.includes(parsed.hostname)) return true;
    const extra = process.env.LATENT_CIVITAI_IMAGE_ORIGIN;
    return Boolean(extra) && parsed.origin === extra;
  } catch {
    return false;
  }
}

/**
 * What Civitai knows about one file.
 *
 * Throws `CivitaiError` with `notFound` set when the hash is unknown there,
 * which is the commonest outcome for anything trained at home and is not an
 * error the caller should log as one.
 */
export async function lookupByHash(
  sha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CivitaiInfo> {
  const hash = sha256.trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new CivitaiError('That is not a SHA256 hash.');

  const version = await ask<VersionResponse>(
    `${BASE}/model-versions/by-hash/${hash}`,
    fetchImpl,
    true,
  );

  /*
   * The second request, for the half people actually read.
   *
   * The version carries trigger words and a changelog; the *model* carries the
   * explanation of what the thing is for. Failing to get it is not a failure of
   * the lookup — the trigger words are already in hand and they are the point —
   * so this one is allowed to come back empty.
   */
  let model: ModelResponse | null = null;
  if (typeof version.modelId === 'number') {
    model = await ask<ModelResponse>(`${BASE}/models/${version.modelId}`, fetchImpl, false).catch(
      () => null,
    );
  }

  return toInfo(version, model);
}

/** One request, with the failure modes named. `strict` throws on a 404. */
async function ask<T>(url: string, fetchImpl: typeof fetch, strict: boolean): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    // A box with no route to the internet is the normal case on a locked-down
    // network, and it must read as "could not ask", not as "not on Civitai".
    throw new CivitaiError(
      cause instanceof Error && cause.name === 'AbortError'
        ? 'Civitai did not answer in time.'
        : 'Could not reach Civitai.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    throw new CivitaiError('Civitai does not have that file.', strict);
  }
  if (response.status === 429) {
    throw new CivitaiError('Civitai is rate-limiting this server. Try again in a minute.');
  }
  if (!response.ok) {
    throw new CivitaiError(`Civitai answered ${response.status}.`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new CivitaiError('Civitai sent something that is not JSON.');
  }
}

/** The example pictures, with the prompt behind each where there is one. */
function toExamples(raw: unknown): CivitaiExample[] {
  if (!Array.isArray(raw)) return [];

  const examples: CivitaiExample[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const image = entry as {
      url?: unknown;
      width?: unknown;
      height?: unknown;
      nsfwLevel?: unknown;
      type?: unknown;
      meta?: { prompt?: unknown } | null;
    };

    // Videos turn up in these lists too; this is a still-image gallery, and a
    // video URL in an `<img>` is a broken picture with no explanation.
    if (typeof image.url !== 'string' || image.type === 'video') continue;

    const prompt = image.meta?.prompt;
    examples.push({
      url: image.url,
      width: typeof image.width === 'number' ? image.width : null,
      height: typeof image.height === 'number' ? image.height : null,
      nsfwLevel: typeof image.nsfwLevel === 'number' ? image.nsfwLevel : null,
      prompt: typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : null,
    });
    if (examples.length >= MAX_EXAMPLES) break;
  }
  return examples;
}

/**
 * The response, reduced to what Latent stores.
 *
 * Deliberately narrow. The full response carries image lists, download URLs,
 * file sizes and availability windows, none of which belong in a note under a
 * LoRA's name — and storing a whole third-party response shape is how a schema
 * ends up owned by somebody else's API.
 */
export function toInfo(body: VersionResponse, model: ModelResponse | null = null): CivitaiInfo {
  const words = Array.isArray(body.trainedWords)
    ? body.trainedWords
        .filter((word): word is string => typeof word === 'string')
        .map((word) => word.trim())
        .filter((word) => word !== '')
    : [];

  const modelId = typeof body.modelId === 'number' ? body.modelId : null;
  const versionId = typeof body.id === 'number' ? body.id : null;

  return {
    modelId,
    versionId,
    name: model?.name ?? body.model?.name ?? null,
    versionName: body.name ?? null,
    baseModel: body.baseModel ?? null,
    trainedWords: words,
    // Their descriptions are rich-text fields; they are reduced to text on the
    // way in so nothing downstream has to decide whether to render a stranger's
    // HTML. See `plainText`.
    description: plainText(body.description),
    // The longer limit is deliberate: this is the field creators write the
    // usage notes in, and truncating it at a changelog's length would cut off
    // the part worth reading.
    modelDescription: plainText(model?.description, 4000),
    type: model?.type ?? body.model?.type ?? null,
    creator: model?.creator?.username ?? null,
    tags: Array.isArray(model?.tags)
      ? model.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== '')
      : [],
    examples: toExamples(body.images),
    url: modelId
      ? `https://civitai.com/models/${modelId}${versionId ? `?modelVersionId=${versionId}` : ''}`
      : null,
    fetchedAt: Date.now(),
  };
}
