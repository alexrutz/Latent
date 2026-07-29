import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';

import type { AppSettings, ComfyImageRef, GenerateRequest, ParamValues } from '@latent/shared';

import { useLiveStore } from '../state/live';
import { api } from './client';

export const queryKeys = {
  status: ['status'] as const,
  workflows: ['workflows'] as const,
  workflow: (id: string) => ['workflow', id] as const,
  gallery: (workflowId?: string | null) => ['gallery', workflowId ?? 'all'] as const,
  settings: ['settings'] as const,
  connections: ['connections'] as const,
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
