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

/**
 * Typed client for ComfyUI's HTTP API.
 *
 * Recent ComfyUI builds mirror every route under `/api`, older ones only serve
 * them at the root. We probe once and remember which prefix answers, so the same
 * binary works against both.
 */
export class ComfyClient {
  private prefix: string | null = null;
  private probing: Promise<string> | null = null;

  constructor(readonly baseUrl: string) {}

  /** Resolve (and cache) the route prefix this server uses. */
  async resolvePrefix(): Promise<string> {
    if (this.prefix !== null) return this.prefix;
    if (this.probing) return this.probing;

    this.probing = (async () => {
      for (const candidate of ['/api', '']) {
        try {
          const response = await fetch(`${this.baseUrl}${candidate}/system_stats`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok) {
            void response.body?.cancel();
            this.prefix = candidate;
            return candidate;
          }
        } catch {
          // Try the next candidate.
        }
      }
      // Nothing answered. Don't cache — the server may just not be up yet.
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

  private async request(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
  ): Promise<Response> {
    const { query, ...rest } = init;
    const url = await this.url(path, query);

    let response: Response;
    try {
      response = await fetch(url, {
        ...rest,
        signal: rest.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      this.resetPrefix();
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

  queue(): Promise<QueueResponse> {
    return this.json<QueueResponse>('/queue');
  }

  history(maxItems = 64): Promise<HistoryResponse> {
    return this.json<HistoryResponse>('/history', { query: { max_items: maxItems } });
  }

  historyFor(promptId: string): Promise<HistoryResponse> {
    return this.json<HistoryResponse>(`/history/${encodeURIComponent(promptId)}`);
  }

  submit(workflow: ApiWorkflow, clientId: string, extra?: Record<string, unknown>): Promise<PromptResponse> {
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

  /** Returns the raw response so the caller can stream image bytes straight through. */
  view(params: ViewParams): Promise<Response> {
    return this.request('/view', {
      query: {
        filename: params.filename,
        subfolder: params.subfolder ?? '',
        type: params.type ?? 'output',
        preview: params.preview,
      },
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
