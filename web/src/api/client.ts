import type {
  ParamSchema,
  CreateStudyRequest,
  StudyDetail,
  StudyPreview,
  StudyRating,
  StudyShot,
  StudyShotImage,
  StudyStats,
  StudySummary,
  UpdateStudyRequest,
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
  BrowseListing,
  BrowseRoot,
  InputScanResult,
  MonitorSnapshot,
  PromptBlock,
  PromptBlockInput,
  RandomPromptConfig,
  RandomPromptRoll,
  SystemPrompt,
  SystemPromptInput,
  TasteCategory,
  TasteEntry,
  TasteProfile,
  TileSpan,
  VariationPreset,
  ConnectionInput,
  ConnectionSummary,
  ConnectionTestResult,
  ChatConversation,
  ChatAttachment,
  ChatConversationDetail,
  ChatRun,
  EndlessState,
  ProposedBlock,
  GalleryPage,
  GallerySort,
  GenerateRequest,
  GenerateResponse,
  GenerationRecord,
  ParamValues,
  QueueState,
  RegionFraction,
  StatusResponse,
  UpdateRun,
  UpdateStatus,
  UploadImageResponse,
  WorkflowDetail,
  WorkflowPreset,
  WorkflowScanResult,
  WorkflowSummary,
  PoolField,
  ModelFolder,
  ModelNote,
  ModelSummary,
} from '@latent/shared';
import { regionKey } from '@latent/shared';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Told when the server says the archive is sealed.
 *
 * 423 is not an error the calling screen can do anything about — it is the same
 * answer everywhere, and the only response to it is a password. Routing it to
 * one place means the dialog opens the moment it happens rather than at the
 * next poll of `/api/status`.
 */
let onArchiveLocked: (() => void) | null = null;

export function setArchiveLockedHandler(handler: (() => void) | null): void {
  onArchiveLocked = handler;
}

/**
 * The passes for the screens that ask for the password a second time.
 *
 * In memory and nowhere else: not `localStorage`, not a cookie. The whole point
 * of asking again at those screens is that a reload, a new tab or a phone
 * picked up tomorrow has to ask again, and anything that survives those would
 * be the lock quietly unlocking itself.
 *
 * A table rather than a variable each, so that a pass can only ever be sent on
 * the paths it was bought for — a pass for one screen is not a credential to
 * spray across every request the app makes — and so adding a third gate is a
 * row rather than another branch inside the header spread.
 */
const GATES = {
  taste: { prefix: '/api/taste', header: 'x-latent-taste' },
  update: { prefix: '/api/update', header: 'x-latent-update' },
} as const;

type GateName = keyof typeof GATES;

const tickets: Record<GateName, string | null> = { taste: null, update: null };

export function setTasteTicket(ticket: string | null): void {
  tickets.taste = ticket;
}

export function setUpdateTicket(ticket: string | null): void {
  tickets.update = ticket;
}

function gateHeaders(path: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, gate] of Object.entries(GATES) as [GateName, (typeof GATES)[GateName]][]) {
    const ticket = tickets[name];
    if (ticket && path.startsWith(gate.prefix)) headers[gate.header] = ticket;
  }
  return headers;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...gateHeaders(path),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    if (response.status === 423) onArchiveLocked?.();
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

/**
 * A downscaled variant, so a grid never pulls full-size pictures.
 *
 * The one way to ask for a small image. Latent's own server makes it — asking
 * ComfyUI for `preview=` gets a re-encoded file at the *original* dimensions,
 * which the browser then decodes to 64 MB of bitmap for a 4000×4000 output and
 * a gigabyte for a screenful of them.
 */
export function thumbnailUrl(image: ComfyImageRef & { id?: number }): string {
  return imageUrl(image, 'webp;70');
}

/**
 * The picture at the size this screen can show, optionally only one part of it.
 *
 * What the viewer opens. `box` is in device pixels — the viewport times the
 * pixel ratio — and `region` is the part of the picture being looked at, as
 * fractions of it, which is how zooming gets detail without ever fetching the
 * whole frame. Fractions rather than pixels because the browser is looking at a
 * copy and does not know how big the file is; see `regionFraction`.
 */
export function viewUrl(
  image: ComfyImageRef & { id?: number },
  box: { width: number; height: number },
  region?: RegionFraction | null,
): string {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
    fit: `${Math.round(box.width)}x${Math.round(box.height)}`,
  });
  if (typeof image.id === 'number') params.set('id', String(image.id));
  if (region) params.set('crop', regionKey(region));
  return `/api/view?${params.toString()}`;
}

/** A file in the configured input folder. `preview` keeps a picker grid cheap. */
export function inputImageUrl(path: string, preview = false): string {
  const params = new URLSearchParams({ path });
  if (preview) params.set('preview', '1');
  return `/api/input-images/file?${params.toString()}`;
}

/** A thumbnail of a picture sitting in a browsable folder on the ComfyUI machine. */
export function browseThumbUrl(reference: string): string {
  const cut = reference.indexOf('/');
  if (cut < 0) return '';
  const params = new URLSearchParams({
    root: reference.slice(0, cut),
    path: reference.slice(cut + 1),
  });
  return `/api/browse/thumb?${params.toString()}`;
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

  /** Re-enter the password to unseal the archive after a server restart. */
  unlockArchive: (password: string) =>
    request<{ ok: true }>('/api/auth/unlock', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

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

  deleteConnection: (id: string) => request<void>(`/api/connections/${id}`, { method: 'DELETE' }),

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

  /**
   * Hand back a frame of a video, and how long it runs.
   *
   * The server cannot decode an mp4 — see `lib/poster` — so the browser that is
   * playing it supplies the still every grid tile and every picker needs.
   */
  reportPoster: (image: ComfyImageRef, poster: string | null, durationMs?: number) =>
    request<void>('/api/images/poster', {
      method: 'PUT',
      body: JSON.stringify({
        image,
        ...(poster ? { poster } : {}),
        ...(durationMs ? { durationMs } : {}),
      }),
    }),

  /* ---------------------------------------------------------------- */
  /* Favourites                                                        */
  /* ---------------------------------------------------------------- */

  favorites: (sort: FavoriteSort = 'rating') => request<Favorite[]>(`/api/favorites?sort=${sort}`),

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

  /* ---------------------------------------------------------------- */
  /* What you like                                                     */
  /* ---------------------------------------------------------------- */

  taste: () => request<TasteProfile>('/api/taste'),

  /** Buy a pass with the app password, and get the notes with it. */
  unlockTaste: (password: string) =>
    request<{ ticket: string; profile: TasteProfile }>('/api/taste/unlock', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  /** Hand the pass back, which is what closing the screen does. */
  lockTaste: () => request<void>('/api/taste/lock', { method: 'POST' }),

  createTasteCategory: (name: string) =>
    request<TasteCategory>('/api/taste/categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  updateTasteCategory: (id: string, patch: { name?: string; active?: boolean }) =>
    request<TasteCategory>(`/api/taste/categories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteTasteCategory: (id: string) =>
    request<void>(`/api/taste/categories/${id}`, { method: 'DELETE' }),

  reorderTasteCategories: (ids: string[]) =>
    request<TasteProfile>('/api/taste/categories/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  createTasteEntry: (input: { text: string; categoryId: string | null; always?: boolean }) =>
    request<TasteEntry>('/api/taste/entries', { method: 'POST', body: JSON.stringify(input) }),

  updateTasteEntry: (
    id: string,
    patch: { text?: string; active?: boolean; always?: boolean; categoryId?: string | null },
  ) =>
    request<TasteEntry>(`/api/taste/entries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteTasteEntry: (id: string) => request<void>(`/api/taste/entries/${id}`, { method: 'DELETE' }),

  /* ---------------------------------------------------------------- */
  /* Updating Latent itself                                            */
  /* ---------------------------------------------------------------- */

  /** State plus whatever log lines happened after `since`. */
  updateStatus: (since = 0) => request<UpdateStatus>(`/api/update?since=${since}`),

  /** Ask the remote what it has. The only part that touches the network. */
  checkForUpdate: () => request<UpdateStatus>('/api/update/check', { method: 'POST' }),

  unlockUpdate: (password: string) =>
    request<{ ticket: string; status: UpdateStatus }>('/api/update/unlock', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  lockUpdate: () => request<void>('/api/update/lock', { method: 'POST' }),

  /** Returns as soon as it has started; watch `updateStatus` for the rest. */
  runUpdate: () =>
    request<{ run: UpdateRun; status: UpdateStatus }>('/api/update/run', { method: 'POST' }),

  /**
   * Replace the running process.
   *
   * `force` overrules the guess about whether anything would start Latent
   * again — the detection is a guess, and not being able to overrule it would
   * be the more annoying of the two failures.
   */
  restartForUpdate: (force = false) =>
    request<{ ok: true }>('/api/update/restart', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  /* ---------------------------------------------------------------- */
  /* System prompts                                                    */
  /* ---------------------------------------------------------------- */

  systemPrompts: () => request<SystemPrompt[]>('/api/system-prompts'),

  createSystemPrompt: (input: SystemPromptInput) =>
    request<SystemPrompt>('/api/system-prompts', { method: 'POST', body: JSON.stringify(input) }),

  updateSystemPrompt: (id: string, input: Partial<SystemPromptInput>) =>
    request<SystemPrompt>(`/api/system-prompts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteSystemPrompt: (id: string) =>
    request<void>(`/api/system-prompts/${id}`, { method: 'DELETE' }),

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

  /* ---------------------------------------------------------------- */
  /* Browsing folders on the ComfyUI machine                           */
  /* ---------------------------------------------------------------- */

  browseRoots: () => request<{ roots: BrowseRoot[] }>('/api/browse/roots'),

  browseFolder: (params: {
    root: string;
    path?: string;
    q?: string;
    sort?: string;
    order?: string;
    recursive?: boolean;
    /** Pictures, clips or sound: a slot only ever shows what it can use. */
    kind?: string;
  }) => {
    const query = new URLSearchParams({
      root: params.root,
      path: params.path ?? '',
      q: params.q ?? '',
      sort: params.sort ?? 'date',
      order: params.order ?? 'desc',
      recursive: params.recursive ? 'true' : '',
      kind: params.kind ?? 'image',
    });
    return request<BrowseListing>(`/api/browse/list?${query.toString()}`);
  },

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

  /** Every distinct field across the workflows in use, for the arrangement. */
  poolFields: () => request<PoolField[]>('/api/workflows/fields'),

  /* ---------------------------------------------------------------- */
  /* The model library                                                 */
  /* ---------------------------------------------------------------- */

  listModels: (folder: ModelFolder) =>
    request<{ folder: ModelFolder; models: ModelSummary[]; warning: string | null }>(
      `/api/models?folder=${folder}`,
    ),

  saveModelNote: (
    folder: ModelFolder,
    name: string,
    patch: Partial<Pick<ModelNote, 'triggerWords' | 'notes' | 'strength'>>,
  ) =>
    request<ModelNote>(`/api/models/${folder}/${encodeURIComponent(name)}/note`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  /** Hash the file and ask Civitai what it is. Slow, so it is a button. */
  lookupModel: (folder: ModelFolder, name: string) =>
    request<ModelNote>(`/api/models/${folder}/${encodeURIComponent(name)}/lookup`, {
      method: 'POST',
    }),

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

  /* ---------------------------------------------------------------- */
  /* Chat                                                              */
  /* ---------------------------------------------------------------- */

  chatStatus: () =>
    request<{ ok: boolean; baseUrl: string; models: string[]; message?: string }>(
      '/api/chat/status',
    ),

  /** Latent's own instructions, so Settings can show and restore them. */
  chatDefaultPrompt: () => request<{ prompt: string }>('/api/chat/prompt'),

  chats: () => request<ChatConversation[]>('/api/chat/conversations'),

  createChat: () => request<ChatConversation>('/api/chat/conversations', { method: 'POST' }),

  /** The transcript, and what the conversation is currently doing. */
  chat: (id: string) =>
    request<ChatConversationDetail & { run: ChatRun }>(`/api/chat/conversations/${id}`),

  deleteChat: (id: string) => request<void>(`/api/chat/conversations/${id}`, { method: 'DELETE' }),

  /*
   * The intents.
   *
   * Each one says what somebody wants; none of them says how. What follows —
   * the reply, accepting a proposal, queueing the render, the turn that judges
   * it, the next wandering round — is the server's, and happens whether or not
   * this page is still open. See `server/src/chat/engine.ts`.
   */

  say: (id: string, body: { content: string; attachments?: ChatAttachment[] }) =>
    request<{ ok: true }>(`/api/chat/conversations/${id}/say`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  askForPrompt: (id: string, body: { fresh?: boolean; instant?: boolean } = {}) =>
    request<{ ok: true }>(`/api/chat/conversations/${id}/prompt`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  setWandering: (id: string, on: boolean) =>
    request<{ ok: true }>(`/api/chat/conversations/${id}/wander`, {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),

  /**
   * Carry on by itself, and take up whatever is waiting.
   *
   * Writes the setting server-side rather than being paired with a settings
   * patch here: two writes for one switch is how the strip and the loop came to
   * disagree about whether a run was autonomous.
   */
  setAutonomous: (id: string, on: boolean) =>
    request<{ ok: true }>(`/api/chat/conversations/${id}/autonomous`, {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),

  decideTool: (
    id: string,
    body: {
      messageId: string;
      decision: 'accepted' | 'rejected';
      blocks?: ProposedBlock[];
      note?: string;
      prompt?: string;
      workflowId?: string;
    },
  ) =>
    request<{ ok: true }>(`/api/chat/conversations/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  stopChat: (id: string) =>
    request<{ ok: true }>(`/api/chat/conversations/${id}/stop`, { method: 'POST' }),

  /**
   * A render is on screen.
   *
   * The one thing the server still waits for a browser to say. The point of the
   * sequence is that you see a picture before the model is told anything about
   * it, and only this side knows when that happened.
   */
  notePictureShown: (id: string, generationId: string) =>
    request<void>(`/api/chat/conversations/${id}/shown`, {
      method: 'POST',
      body: JSON.stringify({ generationId }),
    }),

  /** Run a prompt from further up the conversation again. */
  rerunPrompt: (id: string, body: { messageId: string; prompt?: string; workflowId?: string }) =>
    request<{ ok: true; messageId: string; generationId: string | null }>(
      `/api/chat/conversations/${id}/rerun`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  /** Drop everything after a message, keeping the message itself. */
  rewindChat: (id: string, messageId: string) =>
    request<{ ok: true; removed: number }>(`/api/chat/conversations/${id}/rewind`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),

  /** Fetch the picture for a favourite whose copy never got made. */
  archiveFavorite: (id: string) =>
    request<Favorite>(`/api/favorites/${id}/archive`, { method: 'POST' }),

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
      sort?: GallerySort;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.workflowId) query.set('workflowId', params.workflowId);
    if (params.minRating) query.set('minRating', String(params.minRating));
    if (params.sort && params.sort !== 'newest') query.set('sort', params.sort);
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

  /* ---------------------------------------------------------------- */
  /* Parameter studies                                                 */
  /* ---------------------------------------------------------------- */

  studies: () => request<StudySummary[]>('/api/studies'),

  study: (id: string) => request<StudyDetail>(`/api/studies/${id}`),

  createStudy: (body: CreateStudyRequest) =>
    request<StudyDetail>('/api/studies', { method: 'POST', body: JSON.stringify(body) }),

  updateStudy: (id: string, patch: UpdateStudyRequest) =>
    request<StudyDetail>(`/api/studies/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteStudy: (id: string) => request<void>(`/api/studies/${id}`, { method: 'DELETE' }),

  /** The schema of the study's workflow: every field, as a candidate to vary. */
  studyFields: (id: string) => request<ParamSchema>(`/api/studies/${id}/fields`),

  studyPreview: (id: string) => request<StudyPreview>(`/api/studies/${id}/preview`),

  startStudy: (id: string) => request<StudyDetail>(`/api/studies/${id}/start`, { method: 'POST' }),

  pauseStudy: (id: string) => request<StudyDetail>(`/api/studies/${id}/pause`, { method: 'POST' }),

  finishStudy: (id: string) =>
    request<StudyDetail>(`/api/studies/${id}/finish`, { method: 'POST' }),

  /**
   * The next picture to judge — or nothing, when everything is rated.
   *
   * "Nothing left" is a real answer rather than an error, so the server's 204
   * becomes `null` rather than throwing at a screen that would have to catch
   * it. Explicitly `null` and not the `undefined` a 204 gives, because a query
   * that resolves to `undefined` is an error in TanStack Query.
   */
  nextStudyShot: async (id: string) =>
    (await request<StudyShotImage | undefined>(`/api/studies/${id}/next`)) ?? null,

  rateStudyShot: (studyId: string, shotId: string, rating: StudyRating | null) =>
    request<StudyShot>(`/api/studies/${studyId}/shots/${shotId}/rating`, {
      method: 'PUT',
      body: JSON.stringify({ rating }),
    }),

  /** Move one shot into the gallery and the favourites. */
  keepStudyShot: (studyId: string, shotId: string) =>
    request<Favorite>(`/api/studies/${studyId}/shots/${shotId}/keep`, { method: 'POST' }),

  studyStats: (id: string) => request<StudyStats>(`/api/studies/${id}/stats`),

  settings: () => request<AppSettings>('/api/settings'),

  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
};
