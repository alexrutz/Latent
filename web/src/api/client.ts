import type {
  AppSettings,
  ArchiveStats,
  ComfyImageRef,
  Favorite,
  FavoriteSort,
  FieldOverrides,
  FormLayout,
  ImportBrowseResult,
  ImportRequest,
  ImportResult,
  ImportScanResult,
  InputScanResult,
  MonitorSnapshot,
  PromptBlock,
  PromptBlockInput,
  RandomPromptConfig,
  RandomPromptRoll,
  TileSpan,
  VariationPreset,
  ConnectionInput,
  ConnectionSummary,
  ConnectionTestResult,
  EndlessState,
  GalleryPage,
  GenerateRequest,
  GenerateResponse,
  GenerationRecord,
  ParamValues,
  QueueState,
  StatusResponse,
  UploadImageResponse,
  WorkflowDetail,
  WorkflowPreset,
  WorkflowScanResult,
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

/**
 * Build the proxied URL for an image.
 *
 * `id` is passed whenever the caller has one, and it is what actually resolves
 * the picture: name, subfolder and type do not identify a stored image — two
 * imported folders can hold the same file name, and ComfyUI restarts its
 * counter when an output folder is emptied. Without the id the server has to
 * guess, and guessing is how a thumbnail comes to belong to a different picture
 * than the one it opens.
 *
 * The name is still sent, because a live preview arriving over the socket has
 * no row yet and can only be fetched upstream.
 */
export function imageUrl(image: ComfyImageRef & { id?: number }, preview?: string): string {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  });
  if (typeof image.id === 'number') params.set('id', String(image.id));
  if (preview) params.set('preview', preview);
  return `/api/view?${params.toString()}`;
}

/** A downscaled variant, so a gallery grid doesn't pull full-size PNGs. */
export function thumbnailUrl(image: ComfyImageRef & { id?: number }): string {
  return imageUrl(image, 'webp;70');
}

/** A file in the configured input folder. `preview` keeps a picker grid cheap. */
export function inputImageUrl(path: string, preview = false): string {
  const params = new URLSearchParams({ path });
  if (preview) params.set('preview', '1');
  return `/api/input-images/file?${params.toString()}`;
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),

  /** Claim an unconfigured server by choosing its password. One-shot. */
  setup: (password: string) =>
    request<{ ok: true }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  login: (password: string) =>
    request<{ ok: true }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  /* ---------------------------------------------------------------- */
  /* Connections                                                       */
  /* ---------------------------------------------------------------- */

  connections: () => request<ConnectionSummary[]>('/api/connections'),

  createConnection: (input: ConnectionInput) =>
    request<ConnectionSummary>('/api/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateConnection: (id: string, input: Partial<ConnectionInput>) =>
    request<ConnectionSummary>(`/api/connections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteConnection: (id: string) =>
    request<void>(`/api/connections/${id}`, { method: 'DELETE' }),

  activateConnection: (id: string) =>
    request<ConnectionSummary[]>(`/api/connections/${id}/activate`, { method: 'POST' }),

  /** Try an endpoint before saving it, so the add form can report what's wrong. */
  testConnection: (input: ConnectionInput) =>
    request<ConnectionTestResult>('/api/connections/test', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /* ---------------------------------------------------------------- */
  /* Presets                                                           */
  /* ---------------------------------------------------------------- */

  presets: (workflowId: string) =>
    request<WorkflowPreset[]>(`/api/workflows/${workflowId}/presets`),

  savePreset: (workflowId: string, name: string, values: ParamValues) =>
    request<WorkflowPreset>(`/api/workflows/${workflowId}/presets`, {
      method: 'POST',
      body: JSON.stringify({ name, values }),
    }),

  deletePreset: (id: string) => request<void>(`/api/presets/${id}`, { method: 'DELETE' }),

  /* ---------------------------------------------------------------- */
  /* Form layouts                                                      */
  /* ---------------------------------------------------------------- */

  layouts: (workflowId: string) => request<FormLayout[]>(`/api/workflows/${workflowId}/layouts`),

  /** Omitting `overrides` snapshots the form as it currently stands. */
  saveLayout: (workflowId: string, name: string, overrides?: FieldOverrides) =>
    request<FormLayout>(`/api/workflows/${workflowId}/layouts`, {
      method: 'POST',
      body: JSON.stringify({ name, overrides }),
    }),

  activateLayout: (workflowId: string, id: string) =>
    request<FormLayout[]>(`/api/workflows/${workflowId}/layouts/${id}/activate`, {
      method: 'POST',
    }),

  deleteLayout: (workflowId: string, id: string) =>
    request<void>(`/api/workflows/${workflowId}/layouts/${id}`, { method: 'DELETE' }),

  /* ---------------------------------------------------------------- */
  /* Ratings and archive                                               */
  /* ---------------------------------------------------------------- */

  /** Rating above zero also copies the image into Latent's local archive. */
  rateImage: (generationId: string, image: ComfyImageRef, rating: number) =>
    request<GenerationRecord>(`/api/gallery/${generationId}/rating`, {
      method: 'PUT',
      body: JSON.stringify({ image, rating }),
    }),

  monitor: (since?: number) =>
    request<MonitorSnapshot>(`/api/monitor${since ? `?since=${since}` : ''}`),

  /**
   * The models an Ollama node offers. Fetched from Ollama itself, because the
   * nodes that talk to it publish an empty combo and fill it in client-side.
   */
  ollamaModels: (workflowId: string, nodeId: string) =>
    request<{ ok: boolean; url: string; models: string[]; message?: string }>(
      `/api/models/ollama?workflowId=${encodeURIComponent(workflowId)}&nodeId=${encodeURIComponent(nodeId)}`,
    ),

  archiveStats: () => request<ArchiveStats>('/api/archive/stats'),

  pruneArchive: () => request<{ removed: number }>('/api/archive/prune', { method: 'POST' }),

  loras: () => request<string[]>('/api/models/loras'),

  /** Override how many grid cells an image occupies; null returns it to auto. */
  setTileSpan: (generationId: string, image: ComfyImageRef, span: TileSpan | null) =>
    request<GenerationRecord>(`/api/gallery/${generationId}/tile`, {
      method: 'PUT',
      body: JSON.stringify({ image, span }),
    }),

  /**
   * Report an image's pixel size after the browser has loaded it, so the grid
   * can shape its tile up front next time instead of reflowing.
   */
  reportDimensions: (image: ComfyImageRef, width: number, height: number) =>
    request<void>('/api/images/dimensions', {
      method: 'PUT',
      body: JSON.stringify({ image, width, height }),
    }),

  /* ---------------------------------------------------------------- */
  /* Favourites                                                        */
  /* ---------------------------------------------------------------- */

  favorites: (sort: FavoriteSort = 'rating') =>
    request<Favorite[]>(`/api/favorites?sort=${sort}`),

  addFavorite: (generationId: string, image: ComfyImageRef, note?: string) =>
    request<Favorite>('/api/favorites', {
      method: 'POST',
      body: JSON.stringify({ generationId, image, note }),
    }),

  updateFavorite: (id: string, patch: { rating?: number; note?: string | null }) =>
    request<Favorite>(`/api/favorites/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteFavorite: (id: string) => request<void>(`/api/favorites/${id}`, { method: 'DELETE' }),

  /* ---------------------------------------------------------------- */
  /* Prompt building blocks                                            */
  /* ---------------------------------------------------------------- */

  promptBlocks: () => request<PromptBlock[]>('/api/prompt-blocks'),

  createPromptBlock: (input: PromptBlockInput) =>
    request<PromptBlock>('/api/prompt-blocks', { method: 'POST', body: JSON.stringify(input) }),

  updatePromptBlock: (id: string, input: Partial<PromptBlockInput>) =>
    request<PromptBlock>(`/api/prompt-blocks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deletePromptBlock: (id: string) =>
    request<void>(`/api/prompt-blocks/${id}`, { method: 'DELETE' }),

  reorderPromptBlocks: (ids: string[]) =>
    request<PromptBlock[]>('/api/prompt-blocks/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  promptMode: () => request<RandomPromptConfig>('/api/prompt-mode'),

  updatePromptMode: (patch: Partial<RandomPromptConfig>) =>
    request<RandomPromptConfig>('/api/prompt-mode', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  variationPresets: () => request<VariationPreset[]>('/api/prompt-mode/presets'),

  /** Omitting `config` snapshots the live setup, which is what "save this" means. */
  saveVariationPreset: (name: string, config?: RandomPromptConfig) =>
    request<VariationPreset>('/api/prompt-mode/presets', {
      method: 'POST',
      body: JSON.stringify({ name, config }),
    }),

  applyVariationPreset: (id: string) =>
    request<RandomPromptConfig>(`/api/prompt-mode/presets/${id}/apply`, { method: 'POST' }),

  deleteVariationPreset: (id: string) =>
    request<void>(`/api/prompt-mode/presets/${id}`, { method: 'DELETE' }),

  /** Example draws from the server, using the same code path as a real submit. */
  previewPromptMode: (base: string, config?: Partial<RandomPromptConfig>) =>
    request<{ pool: number; rolls: RandomPromptRoll[] }>('/api/prompt-mode/preview', {
      method: 'POST',
      body: JSON.stringify({ base, config }),
    }),

  /* ---------------------------------------------------------------- */
  /* Folder import                                                     */
  /* ---------------------------------------------------------------- */

  scanImportFolder: () => request<ImportScanResult>('/api/import/scan'),

  /* ---------------------------------------------------------------- */
  /* Input image library                                               */
  /* ---------------------------------------------------------------- */

  inputImages: () => request<InputScanResult>('/api/input-images'),

  /**
   * Copy a folder image into ComfyUI's input directory.
   *
   * Server-side, so the bytes never make the round trip to the phone — the whole
   * reason for having this rather than making you re-upload the file.
   */
  useInputImage: (path: string) =>
    request<UploadImageResponse>('/api/input-images/use', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** One level of the import tree, which is how an output folder is organised. */
  browseImport: (path = '') =>
    request<ImportBrowseResult>(
      `/api/import/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),

  importFiles: (body: ImportRequest) =>
    request<ImportResult>('/api/import', { method: 'POST', body: JSON.stringify(body) }),

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

  scanWorkflows: () => request<WorkflowScanResult>('/api/workflows/scan', { method: 'POST' }),

  rescanWorkflow: (id: string) =>
    request<WorkflowDetail>(`/api/workflows/${id}/rescan`, { method: 'POST' }),

  deleteWorkflow: (id: string) => request<void>(`/api/workflows/${id}`, { method: 'DELETE' }),

  generate: (body: GenerateRequest) =>
    request<GenerateResponse>('/api/generate', { method: 'POST', body: JSON.stringify(body) }),

  /** Endless generation: what the next run will use, and whether it is running. */
  endless: () => request<EndlessState>('/api/generate/endless'),

  setEndless: (body: GenerateRequest & { enabled: boolean }) =>
    request<EndlessState>('/api/generate/endless', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  queue: () => request<QueueState>('/api/queue'),

  interrupt: () => request<void>('/api/queue/interrupt', { method: 'POST' }),

  cancel: (promptId: string) =>
    request<void>(`/api/queue/${encodeURIComponent(promptId)}`, { method: 'DELETE' }),

  clearQueue: () => request<void>('/api/queue', { method: 'DELETE' }),

  gallery: (
    params: {
      cursor?: string | null;
      limit?: number;
      workflowId?: string | null;
      minRating?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.workflowId) query.set('workflowId', params.workflowId);
    if (params.minRating) query.set('minRating', String(params.minRating));
    const suffix = query.toString();
    return request<GalleryPage>(`/api/gallery${suffix ? `?${suffix}` : ''}`);
  },

  generation: (id: string) => request<GenerationRecord>(`/api/gallery/${id}`),

  deleteGeneration: (id: string) => request<void>(`/api/gallery/${id}`, { method: 'DELETE' }),

  /** Keep one picture indefinitely without rating it. */
  keepImage: (generationId: string, image: ComfyImageRef, kept: boolean) =>
    request<GenerationRecord>(`/api/gallery/${generationId}/keep`, {
      method: 'PUT',
      body: JSON.stringify({ image, kept }),
    }),

  /** Remove a single picture; the run goes too when it was the last one. */
  deleteImage: (generationId: string, image: ComfyImageRef) => {
    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    });
    return request<GenerationRecord | void>(
      `/api/gallery/${generationId}/image?${params.toString()}`,
      { method: 'DELETE' },
    );
  },

  upload: (file: File) => {
    const form = new FormData();
    form.append('image', file, file.name);
    return request<UploadImageResponse>('/api/upload', { method: 'POST', body: form });
  },

  /** Copy an output image into ComfyUI's input directory (img2img / upscale). */
  toInput: (image: ComfyImageRef & { id?: number }) =>
    request<UploadImageResponse>('/api/images/to-input', {
      method: 'POST',
      body: JSON.stringify(image),
    }),

  settings: () => request<AppSettings>('/api/settings'),

  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
};
