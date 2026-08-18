import { create } from 'zustand';

import type { ParamValues } from '@latent/shared';

/** What is set up on the Generate screen for one workflow, ready to submit. */
export interface FormDraft {
  values: ParamValues;
  /** Seed fields the user pinned, so a run reproduces rather than varies. */
  lockedSeeds: string[];
  batchCount: number;
}

interface DraftStore {
  drafts: Record<string, FormDraft>;
  set: (workflowId: string, draft: FormDraft) => void;
  patch: (workflowId: string, change: Partial<FormDraft>) => void;
  clear: (workflowId: string) => void;
}

const STORAGE_KEY = 'latent.formDrafts';

/**
 * The Generate form's values, held outside the screen that renders them.
 *
 * React Router unmounts a route when you leave it, so component state was being
 * destroyed by a trip to the gallery and rebuilt from the workflow's *last
 * submitted* values — which looked exactly like the app quietly reverting
 * settings behind your back. Nothing about "what I am about to render" belongs
 * to a screen; it belongs to the workflow, and it outlives looking at something
 * else.
 *
 * Persisted, so closing a PWA to answer a message does not lose it either. Keyed
 * by workflow id, and entries for workflows that no longer exist are dropped on
 * load rather than accumulating forever.
 */
export const useFormDrafts = create<DraftStore>((set) => ({
  drafts: load(),
  set: (workflowId, draft) =>
    set((state) => save({ ...state.drafts, [workflowId]: draft })),
  patch: (workflowId, change) =>
    set((state) => {
      const current = state.drafts[workflowId];
      if (!current) return state;
      return save({ ...state.drafts, [workflowId]: { ...current, ...change } });
    }),
  clear: (workflowId) =>
    set((state) => {
      if (!(workflowId in state.drafts)) return state;
      const next = { ...state.drafts };
      delete next[workflowId];
      return save(next);
    }),
}));

/** Forget drafts for workflows that are gone, so storage cannot grow forever. */
export function pruneDrafts(workflowIds: string[]): void {
  const known = new Set(workflowIds);
  const current = useFormDrafts.getState().drafts;
  const stale = Object.keys(current).filter((id) => !known.has(id));
  if (stale.length === 0) return;
  for (const id of stale) useFormDrafts.getState().clear(id);
}

function save(drafts: Record<string, FormDraft>): { drafts: Record<string, FormDraft> } {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* Private browsing or a full quota: the in-memory copy still works. */
  }
  return { drafts };
}

function load(): Record<string, FormDraft> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, FormDraft>)
      : {};
  } catch {
    return {};
  }
}
