import type { ApiWorkflow } from '@latent/shared';

/**
 * The model list for an Ollama node.
 *
 * The nodes that talk to Ollama declare their `model` widget as an *empty*
 * combo and fill it in from the browser, using a JavaScript extension that
 * queries Ollama directly. Latent never loads that extension, so the list
 * arrives empty and the picker has nothing in it — which is exactly what
 * "nothing matches" was reporting, quite correctly and quite uselessly.
 *
 * So we ask Ollama ourselves. The address comes from the node's own `url`
 * widget, because that is the one the graph will actually use at render time.
 */

const DEFAULT_URL = 'http://127.0.0.1:11434';
const TIMEOUT_MS = 4_000;

export interface OllamaModelsResult {
  ok: boolean;
  /** Where it looked, after any rewriting. */
  url: string;
  models: string[];
  message?: string;
}

/** The `url` widget on a node, if it has one that looks like an address. */
export function ollamaUrlFor(graph: ApiWorkflow, nodeId: string): string {
  const node = graph[nodeId];
  for (const name of ['url', 'ollama_url', 'base_url', 'endpoint']) {
    const value = node?.inputs?.[name];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  return DEFAULT_URL;
}

/**
 * Point a loopback address at the machine ComfyUI runs on.
 *
 * A workflow saying `127.0.0.1:11434` means "the Ollama next to ComfyUI". When
 * ComfyUI is a rented box and Latent is at home, taking that literally asks the
 * wrong machine — Latent's own localhost — and gets a confident empty answer.
 * The host ComfyUI is reachable at is the best guess available, and it is
 * usually right, because the two are normally installed together.
 */
export function resolveOllamaUrl(nodeUrl: string, comfyUrl: string): string {
  let target: URL;
  try {
    target = new URL(nodeUrl);
  } catch {
    return DEFAULT_URL;
  }

  const loopback = /^(127\.|localhost$|\[?::1\]?$|0\.0\.0\.0$)/i.test(target.hostname);
  if (!loopback) return target.toString();

  try {
    const comfy = new URL(comfyUrl);
    if (!/^(127\.|localhost$|\[?::1\]?$)/i.test(comfy.hostname)) {
      target.hostname = comfy.hostname;
      target.protocol = comfy.protocol;
    }
  } catch {
    // An unparseable connection URL: leave the node's address alone.
  }
  return target.toString();
}

export async function fetchOllamaModels(
  nodeUrl: string,
  comfyUrl: string,
): Promise<OllamaModelsResult> {
  const url = resolveOllamaUrl(nodeUrl, comfyUrl);
  const endpoint = new URL('/api/tags', url).toString();

  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, url, models: [], message: `Ollama answered ${response.status}.` };
    }

    const body = (await response.json()) as { models?: { name?: unknown; model?: unknown }[] };
    const models = (body.models ?? [])
      .map((entry) => (typeof entry.name === 'string' ? entry.name : entry.model))
      .filter((name): name is string => typeof name === 'string' && name !== '');

    return { ok: true, url, models: [...new Set(models)].sort() };
  } catch {
    return {
      ok: false,
      url,
      models: [],
      message: `No answer from Ollama at ${url}. Type the model name instead.`,
    };
  }
}
