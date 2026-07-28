import type {
  AppSettings,
  ComfyImageRef,
  GalleryPage,
  GenerateRequest,
  GenerateResponse,
  GenerationRecord,
  QueueState,
  StatusResponse,
  UploadImageResponse,
  WorkflowDetail,
  WorkflowSummary,
} from '@latent/shared';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    // The server sends `{ error }` for everything it handles; fall back to the
    // status text for anything that got past it (a proxy error, say).
    let message = response.statusText || `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Build the proxied URL for an image held by ComfyUI. */
export function imageUrl(image: ComfyImageRef, preview?: string): string {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  });
  if (preview) params.set('preview', preview);
  return `/api/view?${params.toString()}`;
}

/** A downscaled variant, so a gallery grid doesn't pull full-size PNGs. */
export function thumbnailUrl(image: ComfyImageRef): string {
  return imageUrl(image, 'webp;70');
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),

  login: (password: string) =>
    request<{ ok: true }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  listWorkflows: () => request<WorkflowSummary[]>('/api/workflows'),

  getWorkflow: (id: string) => request<WorkflowDetail>(`/api/workflows/${id}`),

  createWorkflow: (name: string, graph: unknown) =>
    request<WorkflowDetail>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name, graph }),
    }),

  updateWorkflow: (id: string, patch: Parameters<typeof JSON.stringify>[0]) =>
    request<WorkflowDetail>(`/api/workflows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  rescanWorkflow: (id: string) =>
    request<WorkflowDetail>(`/api/workflows/${id}/rescan`, { method: 'POST' }),

  deleteWorkflow: (id: string) => request<void>(`/api/workflows/${id}`, { method: 'DELETE' }),

  generate: (body: GenerateRequest) =>
    request<GenerateResponse>('/api/generate', { method: 'POST', body: JSON.stringify(body) }),

  queue: () => request<QueueState>('/api/queue'),

  interrupt: () => request<void>('/api/queue/interrupt', { method: 'POST' }),

  cancel: (promptId: string) =>
    request<void>(`/api/queue/${encodeURIComponent(promptId)}`, { method: 'DELETE' }),

  clearQueue: () => request<void>('/api/queue', { method: 'DELETE' }),

  gallery: (params: { cursor?: string | null; limit?: number; workflowId?: string | null } = {}) => {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.workflowId) query.set('workflowId', params.workflowId);
    const suffix = query.toString();
    return request<GalleryPage>(`/api/gallery${suffix ? `?${suffix}` : ''}`);
  },

  generation: (id: string) => request<GenerationRecord>(`/api/gallery/${id}`),

  deleteGeneration: (id: string) => request<void>(`/api/gallery/${id}`, { method: 'DELETE' }),

  upload: (file: File) => {
    const form = new FormData();
    form.append('image', file, file.name);
    return request<UploadImageResponse>('/api/upload', { method: 'POST', body: form });
  },

  /** Copy an output image into ComfyUI's input directory (img2img / upscale). */
  toInput: (image: ComfyImageRef) =>
    request<UploadImageResponse>('/api/images/to-input', {
      method: 'POST',
      body: JSON.stringify(image),
    }),

  settings: () => request<AppSettings>('/api/settings'),

  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
};
