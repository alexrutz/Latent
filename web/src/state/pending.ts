import { create } from 'zustand';

import type { ParamValues } from '@latent/shared';

/**
 * A one-shot handoff between screens.
 *
 * "Re-run these settings", "Send to img2img" and "Upscale" all mean: open the
 * Generate tab preloaded with something. Routing state would survive a back
 * navigation and silently re-apply itself, so this is consumed exactly once.
 */
export interface PendingSetup {
  workflowId: string;
  values?: ParamValues;
  /** Written into the workflow's image input once the schema is known. */
  imageFilename?: string;
  /** Roll a new seed rather than reusing the recorded one. */
  freshSeed?: boolean;
  /**
   * Text to write into whatever fields play these roles.
   *
   * By role rather than by field id, because this is the one handoff that
   * crosses *between* workflows — "try this prompt in the other graph" — and
   * the other graph's prompt field has a different id. Everything in `values`
   * is keyed by the source workflow's ids and only makes sense within it.
   */
  promptText?: { positive?: string; negative?: string };
}

interface PendingStore {
  pending: PendingSetup | null;
  setPending: (setup: PendingSetup) => void;
  consume: () => PendingSetup | null;
}

export const usePendingStore = create<PendingStore>((set, get) => ({
  pending: null,
  setPending: (setup) => set({ pending: setup }),
  consume: () => {
    const current = get().pending;
    if (current) set({ pending: null });
    return current;
  },
}));
