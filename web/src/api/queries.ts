import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';

import type {
  AppSettings,
  ComfyImageRef,
  FavoriteSort,
  FieldOverrides,
  GenerateRequest,
  ImportRequest,
  ParamValues,
  PromptBlockInput,
  RandomPromptConfig,
  TileSpan,
} from '@latent/shared';

import { useLiveStore } from '../state/live';
import { api } from './client';

export const queryKeys = {
  status: ['status'] as const,
  workflows: ['workflows'] as const,
  workflow: (id: string) => ['workflow', id] as const,
  gallery: (workflowId?: string | null) => ['gallery', workflowId ?? 'all'] as const,
  settings: ['settings'] as const,
  connections: ['connections'] as const,
  favorites: ['favorites'] as const,
  promptBlocks: ['prompt-blocks'] as const,
  promptMode: ['prompt-mode'] as const,
  variationPresets: ['variation-presets'] as const,
  importScan: ['import-scan'] as const,
  importBrowse: (path: string) => ['import-browse', path] as const,
  presets: (workflowId: string) => ['presets', workflowId] as const,
  layouts: (workflowId: string) => ['layouts', workflowId] as const,
  archiveStats: ['archive-stats'] as const,
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
    onSuccess: (settings) => client.setQueryData(queryKeys.settings, settings),
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

export function useGallery(options: { workflowId?: string | null; minRating?: number } = {}) {
  const { workflowId, minRating = 0 } = options;
  return useInfiniteQuery({
    queryKey: [...queryKeys.gallery(workflowId), minRating],
    queryFn: ({ pageParam }) =>
      api.gallery({ cursor: pageParam as string | null, limit: 30, workflowId, minRating }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
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
    },
  });
}

export const useCreateConnection = () => useConnectionMutation(api.createConnection);
export const useActivateConnection = () => useConnectionMutation(api.activateConnection);
export const useDeleteConnection = () => useConnectionMutation(api.deleteConnection);
export const useUpdateConnection = () =>
  useConnectionMutation(({ id, patch }: { id: string; patch: Parameters<typeof api.updateConnection>[1] }) =>
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

  useEffect(() => {
    if (!lastGeneration) return;
    void client.invalidateQueries({ queryKey: ['gallery'] });
  }, [lastGeneration, client]);
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
  useFavoriteMutation(({ generationId, image, note }: { generationId: string; image: ComfyImageRef; note?: string }) =>
    api.addFavorite(generationId, image, note),
  );

export const useUpdateFavorite = () =>
  useFavoriteMutation(({ id, patch }: { id: string; patch: { rating?: number; note?: string | null } }) =>
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
function useLayoutMutation<TArgs>(workflowId: string | null, fn: (args: TArgs) => Promise<unknown>) {
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
  useLayoutMutation(workflowId, ({ name, overrides }: { name: string; overrides?: FieldOverrides }) =>
    api.saveLayout(workflowId as string, name, overrides),
  );

export const useActivateLayout = (workflowId: string | null) =>
  useLayoutMutation(workflowId, (id: string) => api.activateLayout(workflowId as string, id));

export const useDeleteLayout = (workflowId: string | null) =>
  useLayoutMutation(workflowId, (id: string) => api.deleteLayout(workflowId as string, id));
