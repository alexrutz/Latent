import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';

import type { AppSettings, GenerateRequest } from '@latent/shared';

import { useLiveStore } from '../state/live';
import { api } from './client';

export const queryKeys = {
  status: ['status'] as const,
  workflows: ['workflows'] as const,
  workflow: (id: string) => ['workflow', id] as const,
  gallery: (workflowId?: string | null) => ['gallery', workflowId ?? 'all'] as const,
  settings: ['settings'] as const,
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

export function useGallery(workflowId?: string | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.gallery(workflowId),
    queryFn: ({ pageParam }) =>
      api.gallery({ cursor: pageParam as string | null, limit: 30, workflowId }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
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
