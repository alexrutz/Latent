import { Agent } from 'undici';

import type {
  ApiWorkflow,
  ComfyImageRef,
  HistoryResponse,
  ObjectInfo,
  PromptResponse,
  QueueResponse,
  SystemStats,
  UploadImageResponse,
} from '@latent/shared';

import { authHeaders, type ConnectionConfig } from './connection.js';

export class ComfyError extends Error {
  override name = 'ComfyError';
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export interface ViewParams extends ComfyImageRef {
  /** e.g. `webp;70` — a server-side resized thumbnail on builds that support it. */
  preview?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** A TLS error, as opposed to the server simply not being there. */
export function isSelfSignedError(error: unknown): boolean {
  const codes = [
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ];
  const seen = new Set<unknown>();

  for (
    let current: unknown = error;
    current && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current);
    const code = (current as { code?: string }).code;
    if (code && codes.includes(code)) return true;
    const message = (current as { message?: string }).message ?? '';
    if (/self.signed certificate|unable to verify the first certificate/i.test(message))
      return true;
  }
  return false;
}

/**
 * Typed client for ComfyUI's HTTP API.
 *
 * Recent ComfyUI builds mirror every route under `/api`, older ones only serve
 * them at the root. We probe once and remember which prefix answers, so the same
 * binary works against both.
 *
 * Auth headers and TLS behaviour come from the `ConnectionConfig`, so a local
 * box and a token-protected vast.ai instance with a self-signed certificate are
 * the same code path.
 */
export class ComfyClient {
  private prefix: string | null = null;
  private probing: Promise<string> | null = null;
  private readonly dispatcher: Agent | undefined;
  readonly baseUrl: string;

  constructor(readonly connection: ConnectionConfig) {
    this.baseUrl = connection.url;
    // Only built when the user explicitly opted in for this connection —
    // vast.ai serves a self-signed certificate when ENABLE_HTTPS=true, and
    // there is no other way to reach it.
    this.dispatcher = connection.allowSelfSigned
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  private get headers(): Record<string, string> {
    return authHeaders(this.connection);
  }

  /** Release the TLS agent's sockets when a connection is swapped out. */
  async close(): Promise<void> {
    await this.dispatcher?.close().catch(() => undefined);
  }

  /** Resolve (and cache) the route prefix this server uses. */
  async resolvePrefix(): Promise<string> {
    if (this.prefix !== null) return this.prefix;
    if (this.probing) return this.probing;

    this.probing = (async () => {
      let lastError: unknown;
      let sawUnauthorized = false;

      for (const candidate of ['/api', '']) {
        try {
          const response = await fetch(
            `${this.baseUrl}${candidate}/system_stats`,
            this.init({ signal: AbortSignal.timeout(8_000) }),
          );
          if (response.ok) {
            void response.body?.cancel();
            this.prefix = candidate;
            return candidate;
          }
          // 401/403 means we reached something that wants credentials — a very
          // different problem from "nothing is listening", and worth saying so.
          if (response.status === 401 || response.status === 403) sawUnauthorized = true;
          void response.body?.cancel();
        } catch (error) {
          lastError = error;
        }
      }

      // Nothing answered. Don't cache — the server may just not be up yet.
      if (sawUnauthorized) {
        throw new ComfyError(`ComfyUI at ${this.baseUrl} rejected our credentials`, 401);
      }
      if (isSelfSignedError(lastError)) {
        throw new ComfyError(
          `${this.baseUrl} uses a self-signed certificate. Enable "Allow self-signed certificate" on this connection.`,
        );
      }
      throw new ComfyError(`Cannot reach ComfyUI at ${this.baseUrl}`);
    })();

    try {
      return await this.probing;
    } finally {
      this.probing = null;
    }
  }

  /** Forget the cached prefix so the next call re-probes (used on reconnect). */
  resetPrefix(): void {
    this.prefix = null;
  }

  async url(path: string, query?: Record<string, string | number | undefined>): Promise<string> {
    const prefix = await this.resolvePrefix();
    const url = new URL(`${this.baseUrl}${prefix}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Add this connection's auth header and TLS dispatcher to a fetch init.
   *
   * `dispatcher` is undici's, and Node's global fetch *is* undici — it honours
   * the field even though the DOM `RequestInit` type does not describe it.
   */
  private init(rest: RequestInit = {}): RequestInit {
    // `Omit` then widen: @types/node declares `dispatcher` with its own bundled
    // undici types, which are structurally incompatible with the `undici`
    // package's own `Agent`. They are the same object at runtime.
    const init: Omit<RequestInit, 'dispatcher'> & { dispatcher?: unknown } = {
      ...rest,
      headers: { ...this.headers, ...((rest.headers as Record<string, string>) ?? {}) },
    };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    return init as RequestInit;
  }

  private async request(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
  ): Promise<Response> {
    const { query, ...rest } = init;
    const url = await this.url(path, query);

    let response: Response;
    try {
      response = await fetch(
        url,
        this.init({ ...rest, signal: rest.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) }),
      );
    } catch (cause) {
      this.resetPrefix();
      if (isSelfSignedError(cause)) {
        throw new ComfyError(
          'ComfyUI is using a self-signed certificate. Enable "Allow self-signed certificate" on this connection.',
        );
      }
      throw new ComfyError(
        `Request to ComfyUI failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let detail: unknown = body;
      try {
        detail = JSON.parse(body);
      } catch {
        // Keep the raw text.
      }
      throw new ComfyError(
        `ComfyUI returned ${response.status} for ${path}`,
        response.status,
        detail,
      );
    }

    return response;
  }

  private async json<T>(path: string, init?: Parameters<ComfyClient['request']>[1]): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  /* ---------------------------------------------------------------- */

  objectInfo(): Promise<ObjectInfo> {
    // Large payload (megabytes on a server with many custom nodes).
    return this.json<ObjectInfo>('/object_info', { signal: AbortSignal.timeout(60_000) });
  }

  systemStats(): Promise<SystemStats> {
    return this.json<SystemStats>('/system_stats');
  }

  /**
   * Files in one of ComfyUI's model directories, e.g. `loras`.
   *
   * Older builds don't serve `/models/{folder}`; the caller falls back to
   * reading the option list out of `/object_info`.
   */
  models(folder: string): Promise<string[]> {
    return this.json<string[]>(`/models/${encodeURIComponent(folder)}`);
  }

  queue(): Promise<QueueResponse> {
    return this.json<QueueResponse>('/queue');
  }

  history(maxItems = 64): Promise<HistoryResponse> {
    return this.json<HistoryResponse>('/history', { query: { max_items: maxItems } });
  }

  historyFor(promptId: string): Promise<HistoryResponse> {
    return this.json<HistoryResponse>(`/history/${encodeURIComponent(promptId)}`);
  }

  submit(
    workflow: ApiWorkflow,
    clientId: string,
    extra?: Record<string, unknown>,
  ): Promise<PromptResponse> {
    return this.json<PromptResponse>('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId, extra_data: extra ?? {} }),
    });
  }

  async interrupt(): Promise<void> {
    await this.request('/interrupt', { method: 'POST' });
  }

  async deleteQueued(promptIds: string[]): Promise<void> {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: promptIds }),
    });
  }

  async clearQueue(): Promise<void> {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    });
  }

  /**
   * Returns the raw response so the caller can stream image bytes straight through.
   *
   * `headers` is how a byte range gets through to ComfyUI: a browser playing a
   * video asks for one part of the file at a time, and forwarding that is the
   * difference between a clip that starts immediately and one that has to be
   * downloaded whole before the first frame.
   */
  view(params: ViewParams, headers?: Record<string, string>): Promise<Response> {
    return this.request('/view', {
      query: {
        filename: params.filename,
        subfolder: params.subfolder ?? '',
        type: params.type ?? 'output',
        preview: params.preview,
      },
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(60_000),
    });
  }

  async uploadImage(
    data: Buffer | Uint8Array,
    filename: string,
    options: { subfolder?: string; type?: string; overwrite?: boolean; contentType?: string } = {},
  ): Promise<UploadImageResponse> {
    const form = new FormData();
    const bytes = data instanceof Buffer ? new Uint8Array(data) : data;
    form.append('image', new Blob([bytes], { type: options.contentType ?? 'image/png' }), filename);
    form.append('type', options.type ?? 'input');
    if (options.subfolder) form.append('subfolder', options.subfolder);
    form.append('overwrite', options.overwrite === false ? 'false' : 'true');

    return this.json<UploadImageResponse>('/upload/image', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  }

  /* ---------------------------------------------------------------- */
  /* comfyllama's folder browser                                       */
  /* ---------------------------------------------------------------- */

  /*
   * Proxied rather than reimplemented.
   *
   * Latent could scan the output folder itself — it already reads the input
   * folder off disk for the picture picker. But which folders may be browsed is
   * decided on the ComfyUI machine, by the environment it was started with, and
   * the node refuses anything outside them. A second implementation here would
   * be a second answer to that question, and the way it would fail is by
   * offering a picture the node then declines to load.
   */

  browseRoots(): Promise<{ roots: { key: string; path: string }[] }> {
    return this.json('/comfyllama/browse/roots');
  }

  browseList(query: Record<string, string | number | undefined>): Promise<unknown> {
    return this.json('/comfyllama/browse/list', { query });
  }

  /** The raw thumbnail response, to be piped through without re-encoding. */
  browseThumbnail(root: string, path: string): Promise<Response> {
    return this.request('/comfyllama/browse/thumb', { query: { root, path } });
  }

  /** True when the server answered a cheap request. Used for the status pill. */
  async ping(): Promise<boolean> {
    try {
      await this.systemStats();
      return true;
    } catch {
      return false;
    }
  }
}
