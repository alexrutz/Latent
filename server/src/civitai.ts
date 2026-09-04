import { plainText } from '@latent/shared';
import type { CivitaiInfo } from '@latent/shared';

/**
 * Asking Civitai what a file you already have actually is.
 *
 * One endpoint, `GET /api/v1/model-versions/by-hash/{sha256}`, which is the
 * only one worth having: it identifies a local file without downloading
 * anything and answers with the thing the file itself cannot tell you — the
 * creator's own **trigger words**, and their notes on how to use it.
 *
 * Keyed by hash rather than by name because names are what people rename. A
 * LoRA saved as `mystyle_v2_FINAL.safetensors` is unrecognisable by name and
 * exact by hash, and the hash is what Civitai indexes.
 *
 * No API key. This endpoint is public, and the whole point of the feature is
 * that it works on a fresh install with nothing configured — an account to set
 * up before a LoRA shows its trigger words would be a feature nobody reaches.
 */

const BASE = 'https://civitai.com/api/v1';

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(`${BASE}/model-versions/by-hash/${hash}`, {
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
    throw new CivitaiError('Civitai does not have that file.', true);
  }
  if (response.status === 429) {
    throw new CivitaiError('Civitai is rate-limiting this server. Try again in a minute.');
  }
  if (!response.ok) {
    throw new CivitaiError(`Civitai answered ${response.status}.`);
  }

  let body: VersionResponse;
  try {
    body = (await response.json()) as VersionResponse;
  } catch {
    throw new CivitaiError('Civitai sent something that is not JSON.');
  }

  return toInfo(body);
}

/**
 * The response, reduced to what Latent stores.
 *
 * Deliberately narrow. The full response carries image lists, download URLs,
 * file sizes and availability windows, none of which belong in a note under a
 * LoRA's name — and storing a whole third-party response shape is how a schema
 * ends up owned by somebody else's API.
 */
export function toInfo(body: VersionResponse): CivitaiInfo {
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
    name: body.model?.name ?? null,
    versionName: body.name ?? null,
    baseModel: body.baseModel ?? null,
    trainedWords: words,
    // Their description is a rich-text field; it is reduced to text on the way
    // in so nothing downstream has to decide whether to render a stranger's
    // HTML. See `plainText`.
    description: plainText(body.description),
    url: modelId
      ? `https://civitai.com/models/${modelId}${versionId ? `?modelVersionId=${versionId}` : ''}`
      : null,
    fetchedAt: Date.now(),
  };
}
