import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import type {
  AppSettings,
  GenerationRecord,
  ComfyImageRef,
  FavoriteSort,
  FieldOverrides,
  GallerySort,
  GenerateRequest,
  ImportRequest,
  ParamValues,
  PromptBlockInput,
  RandomPromptConfig,
  StudyRating,
  SystemPromptInput,
  TileSpan,
  UpdateStudyRequest,
} from '@latent/shared';

import { useLiveStore } from '../state/live';
import { noteMeasured } from '../state/measured';
import { api } from './client';

export const queryKeys = {
  status: ['status'] as const,
  workflows: ['workflows'] as const,
  poolFields: ['workflow-fields'] as const,
  models: (folder: string) => ['models', folder] as const,
  workflow: (id: string) => ['workflow', id] as const,
  gallery: (workflowId?: string | null) => ['gallery', workflowId ?? 'all'] as const,
  settings: ['settings'] as const,
  connections: ['connections'] as const,
  favorites: ['favorites'] as const,
  promptBlocks: ['prompt-blocks'] as const,
  systemPrompts: ['system-prompts'] as const,
  taste: ['taste'] as const,
  promptMode: ['prompt-mode'] as const,
  variationPresets: ['variation-presets'] as const,
  importScan: ['import-scan'] as const,
  importBrowse: (path: string) => ['import-browse', path] as const,
  presets: (workflowId: string) => ['presets', workflowId] as const,
  layouts: (workflowId: string) => ['layouts', workflowId] as const,
  archiveStats: ['archive-stats'] as const,
  studies: ['studies'] as const,
  study: (id: string) => ['study', id] as const,
  studyFields: (id: string) => ['study-fields', id] as const,
  studyPreview: (id: string) => ['study-preview', id] as const,
  studyNext: (id: string) => ['study-next', id] as const,
  studyStats: (id: string) => ['study-stats', id] as const,
};

export function useStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: api.status,
    // The connection pill should notice a ComfyUI restart without a reload.
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useWorkflows() {
  return useQuery({ queryKey: queryKeys.workflows, queryFn: api.listWorkflows });
}

export function useWorkflow(id: string | null) {
  return useQuery({
    queryKey: queryKeys.workflow(id ?? ''),
    queryFn: () => api.getWorkflow(id as string),
    enabled: Boolean(id),
  });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: api.settings });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.updateSettings(patch),
    onSuccess: (settings, patch) => {
      client.setQueryData(queryKeys.settings, settings);
      /*
       * The general arrangement is not only a setting — it is a layer of every
       * workflow's form, resolved on the server. Change it and every schema
       * already in the cache is describing a form that no longer exists, which
       * showed up as the editor reopening on the arrangement before last.
       */
      if ('fieldArrangement' in patch) {
        void client.invalidateQueries({ queryKey: ['workflow'] });
        void client.invalidateQueries({ queryKey: queryKeys.workflows });
      }
    },
  });
}

export function useImportWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, graph }: { name: string; graph: unknown }) =>
      api.createWorkflow(name, graph),
    onSuccess: (detail) => {
      client.setQueryData(queryKeys.workflow(detail.id), detail);
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
    },
  });
}

export function useDeleteWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
      void client.invalidateQueries({ queryKey: ['gallery'] });
    },
  });
}

export function useRescanWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rescanWorkflow(id),
    onSuccess: (detail) => client.setQueryData(queryKeys.workflow(detail.id), detail),
  });
}

/**
 * Only the workflows chosen to appear in the generate picker.
 *
 * Reading a whole ComfyUI installation finds everything anybody ever saved,
 * which is the right thing to import and the wrong thing to scroll through
 * before every render. Settings is where the switch lives.
 */
export function useVisibleWorkflows() {
  const query = useWorkflows();
  return useMemo(
    () => ({ ...query, data: query.data?.filter((workflow) => workflow.visible) }),
    [query],
  );
}

/**
 * The models an Ollama node can pick from.
 *
 * Only asked for when a combo turns out to be empty, which is how those nodes
 * declare themselves — they fill the list in from the browser, and Latent is
 * not that browser.
 */
export function useOllamaModels(workflowId: string | null, nodeId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['ollama-models', workflowId, nodeId] as const,
    queryFn: () => api.ollamaModels(workflowId as string, nodeId),
    enabled: enabled && Boolean(workflowId),
    staleTime: 60_000,
    retry: false,
  });
}

/** Import every workflow saved in the configured ComfyUI installation. */
export function useScanWorkflows() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.scanWorkflows(),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.workflows }),
  });
}

export function useUpdateWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.updateWorkflow(id, patch),
    onSuccess: (detail) => {
      client.setQueryData(queryKeys.workflow(detail.id), detail);
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
    },
  });
}

/** Endless generation: the settings the next run will use. */
export function useEndless() {
  return useQuery({
    queryKey: ['endless'] as const,
    queryFn: api.endless,
    // The runner stops itself on a repeated failure, and the button has to say
    // so without the user reloading.
    refetchInterval: 10_000,
  });
}

export function useSetEndless() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateRequest & { enabled: boolean }) => api.setEndless(body),
    onSuccess: (state) => client.setQueryData(['endless'], state),
  });
}

export function useGenerate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateRequest) => api.generate(body),
    onSuccess: () => {
      // The queued record shows up immediately as a placeholder card.
      void client.invalidateQueries({ queryKey: ['gallery'] });
    },
  });
}

export function useGallery(
  options: { workflowId?: string | null; minRating?: number; sort?: GallerySort } = {},
) {
  const { workflowId, minRating = 0, sort = 'newest' } = options;
  return useInfiniteQuery({
    queryKey: [...queryKeys.gallery(workflowId), minRating, sort],
    queryFn: ({ pageParam }) =>
      api.gallery({ cursor: pageParam as string | null, limit: 30, workflowId, minRating, sort }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * Whether the model server is there, and what it has loaded.
 *
 * Fetched rather than waited for: in router mode the list of models *is* the
 * choice, and a picker that only appears after you press Check is a picker
 * nobody finds. Not retried, because the honest answer to "no model server" is
 * to say so once.
 */
export function useChatStatus() {
  return useQuery({
    queryKey: ['chat', 'status'],
    queryFn: api.chatStatus,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * One run, followed until it finishes.
 *
 * Polled rather than driven off the live socket because the caller is the chat
 * transcript, which shows runs from any point in the conversation — including
 * ones started days ago, whose events are long gone. Polling stops the moment
 * the run reaches a terminal state, so a finished conversation is idle.
 */
export function useGeneration(id: string | null) {
  return useQuery({
    queryKey: ['generation', id],
    queryFn: () => api.generation(id as string),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 2_000 : false;
    },
  });
}

/**
 * Several runs at once, for a screen that shows a column of them.
 *
 * The chat's viewer swipes across every picture in the conversation rather than
 * across one run's batch — they are the last things generated, in the order
 * they were made, which is exactly the list you want to move through. That
 * needs all their records at once, and one hook per message is not something a
 * list can do.
 */
export function useGenerations(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ['generation', id] as const,
      queryFn: () => api.generation(id),
      refetchInterval: (query: { state: { data?: GenerationRecord } }) => {
        const status = query.state.data?.status;
        return status === 'queued' || status === 'running' ? 2_000 : false;
      },
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export function useConnections() {
  return useQuery({ queryKey: queryKeys.connections, queryFn: api.connections });
}

/** Any connection change can retarget the whole app, so refresh broadly. */
function useConnectionMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.connections });
      void client.invalidateQueries({ queryKey: queryKeys.status });
      // Model lists and every workflow's option set belong to the old endpoint.
      void client.invalidateQueries({ queryKey: ['workflow'] });
      void client.invalidateQueries({ queryKey: ['loras'] });
      // Including the model server's: the chat's reachability and its list of
      // models are answers about whichever connection is now in use.
      void client.invalidateQueries({ queryKey: ['chat', 'status'] });
    },
  });
}

export const useCreateConnection = () => useConnectionMutation(api.createConnection);
export const useActivateConnection = () => useConnectionMutation(api.activateConnection);
export const useDeleteConnection = () => useConnectionMutation(api.deleteConnection);
export const useUpdateConnection = () =>
  useConnectionMutation(
    ({ id, patch }: { id: string; patch: Parameters<typeof api.updateConnection>[1] }) =>
      api.updateConnection(id, patch),
  );

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export function usePresets(workflowId: string | null) {
  return useQuery({
    queryKey: queryKeys.presets(workflowId ?? ''),
    queryFn: () => api.presets(workflowId as string),
    enabled: Boolean(workflowId),
  });
}

export function useSavePreset(workflowId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, values }: { name: string; values: ParamValues }) =>
      api.savePreset(workflowId as string, name, values),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: queryKeys.presets(workflowId ?? '') }),
  });
}

export function useDeletePreset(workflowId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePreset(id),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: queryKeys.presets(workflowId ?? '') }),
  });
}

/* ------------------------------------------------------------------ */
/* Ratings                                                             */
/* ------------------------------------------------------------------ */

export function useRateImage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      generationId,
      image,
      rating,
    }: {
      generationId: string;
      image: ComfyImageRef;
      rating: number;
    }) => api.rateImage(generationId, image, rating),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['gallery'] });
      void client.invalidateQueries({ queryKey: queryKeys.archiveStats });
    },
  });
}

export function useArchiveStats() {
  return useQuery({ queryKey: queryKeys.archiveStats, queryFn: api.archiveStats });
}

/**
 * Keep cached data in step with the live socket.
 *
 * Without this, finishing a generation would leave a stale gallery until the
 * user pulled to refresh — the app would feel like it had missed the result it
 * just showed them completing.
 */
export function useLiveCacheSync(): void {
  const client = useQueryClient();
  const lastGeneration = useLiveStore((state) => state.lastGeneration);
  const socketConnected = useLiveStore((state) => state.socketConnected);

  useEffect(() => {
    if (!lastGeneration) return;
    void client.invalidateQueries({ queryKey: ['gallery'] });
  }, [lastGeneration, client]);

  /*
   * Catch up on everything that happened while nobody was watching.
   *
   * The socket is the source of truth *while it is connected*. It is not a
   * record of what it missed: a phone that locks its screen drops the
   * connection, the runs in flight finish without anybody hearing about it, and
   * on reconnect the server sends a snapshot of the live state — the job, the
   * queue — but no `generation` events for work that ended in the meantime. So
   * the gallery kept its placeholders and went on saying "rendering" about
   * pictures that were finished and sitting on disk, until some other screen
   * happened to refetch it.
   *
   * Reconnecting and becoming visible are exactly the two moments the client
   * may have missed something, so both refetch the history.
   */
  useEffect(() => {
    // The queue comes over the socket and the snapshot carries it, so only the
    // history — which the snapshot does not include — needs asking for.
    const refresh = () => void client.invalidateQueries({ queryKey: ['gallery'] });

    if (socketConnected) refresh();

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [socketConnected, client]);
}

/** Used after login so every screen refetches with the new session. */
export function resetAllQueries(client: QueryClient): void {
  void client.invalidateQueries();
}

/* ------------------------------------------------------------------ */
/* Grid metadata                                                       */
/* ------------------------------------------------------------------ */

export function useSetTileSpan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      generationId,
      image,
      span,
    }: {
      generationId: string;
      image: ComfyImageRef;
      span: TileSpan | null;
    }) => api.setTileSpan(generationId, image, span),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['gallery'] }),
  });
}

/**
 * Report a measured image size back to the server.
 *
 * Fire-and-forget on purpose: it is an optimisation for the *next* visit, and a
 * failure should never surface as an error over a picture that loaded fine.
 */
/**
 * Images already told the server their size, so it never has to be asked twice.
 *
 * Module-level rather than per-component: the gallery unmounts and remounts as
 * you move between tabs, and re-reporting a hundred sizes each time is pure
 * waste on a mobile connection.
 */
const reportedSizes = new Set<string>();

/**
 * Tell the server an image's real pixel size.
 *
 * Deliberately **not** a React Query mutation. As one it re-rendered the whole
 * gallery on every state change, and lazy-loaded thumbnails fire this
 * continuously while you scroll — a hundred images meant a hundred full-grid
 * re-renders, which is exactly what made a long scroll stutter.
 *
 * Fire-and-forget: it is an optimisation for the *next* visit, and a failure must
 * never surface as an error over a picture that loaded perfectly.
 */
export function reportImageDimensions(image: ComfyImageRef, width: number, height: number): void {
  // Kept here first, whatever the server makes of it: the grid lays a tile out
  // at the shape of its picture, and waiting for a refetch to learn a size this
  // browser has already measured means the pictures you just made are square
  // for a while. See `state/measured`.
  noteMeasured(image, width, height);

  const key = `${image.type}/${image.subfolder}/${image.filename}`;
  if (reportedSizes.has(key)) return;
  reportedSizes.add(key);

  void api.reportDimensions(image, width, height).catch(() => {
    // Allow a retry on the next load rather than silently never trying again.
    reportedSizes.delete(key);
  });
}

export function useKeepImage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      generationId,
      image,
      kept,
    }: {
      generationId: string;
      image: ComfyImageRef;
      kept: boolean;
    }) => api.keepImage(generationId, image, kept),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['gallery'] });
      void client.invalidateQueries({ queryKey: queryKeys.archiveStats });
    },
  });
}

export function useDeleteImage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ generationId, image }: { generationId: string; image: ComfyImageRef }) =>
      api.deleteImage(generationId, image),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['gallery'] });
      void client.invalidateQueries({ queryKey: queryKeys.archiveStats });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Favourites                                                          */
/* ------------------------------------------------------------------ */

export function useFavorites(sort: FavoriteSort = 'rating') {
  return useQuery({
    queryKey: [...queryKeys.favorites, sort],
    queryFn: () => api.favorites(sort),
  });
}

function useFavoriteMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.favorites });
      // Favouriting archives the image, so its gallery row changed too.
      void client.invalidateQueries({ queryKey: ['gallery'] });
    },
  });
}

export const useAddFavorite = () =>
  useFavoriteMutation(
    ({
      generationId,
      image,
      note,
    }: {
      generationId: string;
      image: ComfyImageRef;
      note?: string;
    }) => api.addFavorite(generationId, image, note),
  );

export const useUpdateFavorite = () =>
  useFavoriteMutation(
    ({ id, patch }: { id: string; patch: { rating?: number; note?: string | null } }) =>
      api.updateFavorite(id, patch),
  );

export const useDeleteFavorite = () => useFavoriteMutation((id: string) => api.deleteFavorite(id));

/* ------------------------------------------------------------------ */
/* Prompt building blocks                                              */
/* ------------------------------------------------------------------ */

export function usePromptBlocks() {
  return useQuery({ queryKey: queryKeys.promptBlocks, queryFn: api.promptBlocks });
}

function usePromptBlockMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.promptBlocks }),
  });
}

export const useCreatePromptBlock = () =>
  usePromptBlockMutation((input: PromptBlockInput) => api.createPromptBlock(input));

export const useUpdatePromptBlock = () =>
  usePromptBlockMutation(({ id, input }: { id: string; input: Partial<PromptBlockInput> }) =>
    api.updatePromptBlock(id, input),
  );

export const useDeletePromptBlock = () =>
  usePromptBlockMutation((id: string) => api.deletePromptBlock(id));

export const useReorderPromptBlocks = () =>
  usePromptBlockMutation((ids: string[]) => api.reorderPromptBlocks(ids));

/* ------------------------------------------------------------------ */
/* What you like                                                       */
/* ------------------------------------------------------------------ */

/**
 * The notes, decrypted by the server.
 *
 * Not retried on failure: the interesting failure is a locked vault, and
 * hammering a 423 four times does not open it. The sheet says so instead.
 */
export function useTaste(enabled = true) {
  return useQuery({ queryKey: queryKeys.taste, queryFn: api.taste, enabled, retry: false });
}

function useTasteMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.taste }),
  });
}

export const useCreateTasteCategory = () =>
  useTasteMutation((name: string) => api.createTasteCategory(name));

export const useUpdateTasteCategory = () =>
  useTasteMutation(({ id, patch }: { id: string; patch: { name?: string; active?: boolean } }) =>
    api.updateTasteCategory(id, patch),
  );

export const useDeleteTasteCategory = () =>
  useTasteMutation((id: string) => api.deleteTasteCategory(id));

export const useReorderTasteCategories = () =>
  useTasteMutation((ids: string[]) => api.reorderTasteCategories(ids));

export const useCreateTasteEntry = () =>
  useTasteMutation((input: { text: string; categoryId: string | null; always?: boolean }) =>
    api.createTasteEntry(input),
  );

export const useUpdateTasteEntry = () =>
  useTasteMutation(
    ({
      id,
      patch,
    }: {
      id: string;
      patch: { text?: string; active?: boolean; always?: boolean; categoryId?: string | null };
    }) => api.updateTasteEntry(id, patch),
  );

export const useDeleteTasteEntry = () => useTasteMutation((id: string) => api.deleteTasteEntry(id));

/* ------------------------------------------------------------------ */
/* System prompts                                                      */
/* ------------------------------------------------------------------ */

export function useSystemPrompts() {
  return useQuery({ queryKey: queryKeys.systemPrompts, queryFn: api.systemPrompts });
}

function useSystemPromptMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.systemPrompts });
      // Deleting the one the chat was using clears that setting server-side.
      void client.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export const useCreateSystemPrompt = () =>
  useSystemPromptMutation((input: SystemPromptInput) => api.createSystemPrompt(input));

export const useUpdateSystemPrompt = () =>
  useSystemPromptMutation(({ id, input }: { id: string; input: Partial<SystemPromptInput> }) =>
    api.updateSystemPrompt(id, input),
  );

export const useDeleteSystemPrompt = () =>
  useSystemPromptMutation((id: string) => api.deleteSystemPrompt(id));

/* ------------------------------------------------------------------ */
/* Random prompt mode                                                  */
/* ------------------------------------------------------------------ */

export function usePromptMode() {
  return useQuery({ queryKey: queryKeys.promptMode, queryFn: api.promptMode });
}

export function useVariationPresets() {
  return useQuery({ queryKey: queryKeys.variationPresets, queryFn: api.variationPresets });
}

/** Save, load and delete the whole variation setup as one named thing. */
export function useVariationPresetMutations() {
  const client = useQueryClient();
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: queryKeys.variationPresets });
    void client.invalidateQueries({ queryKey: queryKeys.promptMode });
  };

  return {
    save: useMutation({
      mutationFn: (name: string) => api.saveVariationPreset(name),
      onSuccess: invalidate,
    }),
    apply: useMutation({
      mutationFn: (id: string) => api.applyVariationPreset(id),
      onSuccess: (config) => {
        client.setQueryData(queryKeys.promptMode, config);
        invalidate();
      },
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.deleteVariationPreset(id),
      onSuccess: invalidate,
    }),
  };
}

export function useUpdatePromptMode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<RandomPromptConfig>) => api.updatePromptMode(patch),
    // The server normalises the config, so trust its answer over the patch.
    onSuccess: (config) => client.setQueryData(queryKeys.promptMode, config),
  });
}

/* ------------------------------------------------------------------ */
/* Folder import                                                       */
/* ------------------------------------------------------------------ */

export function useImportScan(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.importScan,
    queryFn: api.scanImportFolder,
    enabled,
    // A folder of thousands of files is not something to re-walk casually.
    staleTime: 60_000,
  });
}

/** One folder of the import tree. Cheap enough to re-read on every step. */
export function useImportBrowse(path: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.importBrowse(path),
    queryFn: () => api.browseImport(path),
    enabled,
    staleTime: 30_000,
  });
}

export function useImportFiles() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportRequest) => api.importFiles(body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.importScan });
      void client.invalidateQueries({ queryKey: ['import-browse'] });
      void client.invalidateQueries({ queryKey: ['gallery'] });
      void client.invalidateQueries({ queryKey: queryKeys.archiveStats });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Form layouts                                                        */
/* ------------------------------------------------------------------ */

export function useLayouts(workflowId: string | null) {
  return useQuery({
    queryKey: queryKeys.layouts(workflowId ?? ''),
    queryFn: () => api.layouts(workflowId as string),
    enabled: Boolean(workflowId),
  });
}

/**
 * Any layout change rewrites the workflow's live overrides, so the form itself
 * has to be refetched — not just the list of layouts.
 */
function useLayoutMutation<TArgs>(
  workflowId: string | null,
  fn: (args: TArgs) => Promise<unknown>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.layouts(workflowId ?? '') });
      void client.invalidateQueries({ queryKey: queryKeys.workflow(workflowId ?? '') });
    },
  });
}

export const useSaveLayout = (workflowId: string | null) =>
  useLayoutMutation(
    workflowId,
    ({ name, overrides }: { name: string; overrides?: FieldOverrides }) =>
      api.saveLayout(workflowId as string, name, overrides),
  );

export const useActivateLayout = (workflowId: string | null) =>
  useLayoutMutation(workflowId, (id: string) => api.activateLayout(workflowId as string, id));

export const useDeleteLayout = (workflowId: string | null) =>
  useLayoutMutation(workflowId, (id: string) => api.deleteLayout(workflowId as string, id));

/* ------------------------------------------------------------------ */
/* Parameter studies                                                   */
/* ------------------------------------------------------------------ */

export function useStudies() {
  return useQuery({ queryKey: queryKeys.studies, queryFn: api.studies });
}

/**
 * One study, polled while it is rendering.
 *
 * The rendering phase runs on the server and reports progress nowhere else, so
 * the screen has to ask. Only while it is actually running: polling a finished
 * study would be a request every two seconds for a number that cannot change.
 */
export function useStudy(id: string | null) {
  return useQuery({
    queryKey: queryKeys.study(id ?? ''),
    queryFn: () => api.study(id as string),
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2_000 : false),
  });
}

export function useStudyFields(id: string | null) {
  return useQuery({
    queryKey: queryKeys.studyFields(id ?? ''),
    queryFn: () => api.studyFields(id as string),
    enabled: id !== null,
  });
}

/** What the plan would cost, recomputed whenever the setup changes. */
export function useStudyPreview(id: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.studyPreview(id ?? ''),
    queryFn: () => api.studyPreview(id as string),
    enabled: id !== null && enabled,
  });
}

/**
 * The next picture to rate.
 *
 * Never served from cache: the whole point is that each one is drawn fresh at
 * random, and a cached "next" would show the same picture twice after a
 * navigation.
 */
export function useNextStudyShot(id: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.studyNext(id ?? ''),
    queryFn: () => api.nextStudyShot(id as string),
    enabled: id !== null && enabled,
    gcTime: 0,
    staleTime: 0,
  });
}

export function useStudyStats(id: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.studyStats(id ?? ''),
    queryFn: () => api.studyStats(id as string),
    enabled: id !== null && enabled,
  });
}

export function useCreateStudy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createStudy,
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.studies }),
  });
}

export function useUpdateStudy(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateStudyRequest) => api.updateStudy(id, patch),
    onSuccess: (study) => {
      client.setQueryData(queryKeys.study(id), study);
      void client.invalidateQueries({ queryKey: queryKeys.studies });
      // The plan depends on every one of these, so its costing is now stale.
      void client.invalidateQueries({ queryKey: queryKeys.studyPreview(id) });
    },
  });
}

export function useDeleteStudy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteStudy(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.studies });
      // A deleted study takes its pictures with it, and a kept one stays.
      void client.invalidateQueries({ queryKey: queryKeys.gallery() });
    },
  });
}

/** Start, pause, or declare the rendering finished. */
export function useStudyRun(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: 'start' | 'pause' | 'finish') =>
      action === 'start'
        ? api.startStudy(id)
        : action === 'pause'
          ? api.pauseStudy(id)
          : api.finishStudy(id),
    onSuccess: (study) => {
      client.setQueryData(queryKeys.study(id), study);
      void client.invalidateQueries({ queryKey: queryKeys.studies });
    },
  });
}

export function useRateStudyShot(studyId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ shotId, rating }: { shotId: string; rating: StudyRating | null }) =>
      api.rateStudyShot(studyId, shotId, rating),
    onSuccess: () => {
      // A rating changes both how many are left and what the analysis says.
      void client.invalidateQueries({ queryKey: queryKeys.studyNext(studyId) });
      void client.invalidateQueries({ queryKey: queryKeys.studyStats(studyId) });
      void client.invalidateQueries({ queryKey: queryKeys.study(studyId) });
    },
  });
}

export function useKeepStudyShot(studyId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (shotId: string) => api.keepStudyShot(studyId, shotId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.favorites });
      void client.invalidateQueries({ queryKey: queryKeys.gallery() });
    },
  });
}
