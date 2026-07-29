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
  GenerateRequest,
  ParamValues,
  PromptBlockInput,
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
  importScan: ['import-scan'] as const,
  presets: (workflowId: string) => ['presets', workflowId] as const,
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
export function useReportDimensions() {
  return useMutation({
    mutationFn: ({
      image,
      width,
      height,
    }: {
      image: ComfyImageRef;
      width: number;
      height: number;
    }) => api.reportDimensions(image, width, height),
    onError: () => undefined,
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

export function useImportFiles() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ paths, rating }: { paths: string[]; rating?: number }) =>
      api.importFiles(paths, rating ?? 0),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.importScan });
      void client.invalidateQueries({ queryKey: ['gallery'] });
      void client.invalidateQueries({ queryKey: queryKeys.archiveStats });
    },
  });
}
