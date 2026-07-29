import { create } from 'zustand';

import type { GenerationRecord, LiveState, QueueState, ServerEvent } from '@latent/shared';

interface LiveStore {
  /** Our own socket to the Latent server. */
  socketConnected: boolean;
  live: LiveState;
  queue: QueueState;
  /** Object URL of the most recent sampler preview frame. */
  previewUrl: string | null;
  /** Generations that changed, so screens can react without polling. */
  lastGeneration: GenerationRecord | null;
  /**
   * The run that just finished, held so the result stays on screen.
   *
   * Without this the progress sheet unmounts the instant the job clears — which
   * is precisely the moment the user wants to look at the picture they were
   * waiting for. Cleared only when they dismiss it or the next job starts.
   */
  finished: GenerationRecord | null;

  applyEvent: (event: ServerEvent) => void;
  setPreview: (blob: Blob) => void;
  clearPreview: () => void;
  dismissFinished: () => void;
  setSocketConnected: (connected: boolean) => void;
}

const initialLive: LiveState = {
  connected: false,
  comfyOnline: false,
  queueRemaining: 0,
  job: null,
  lastError: null,
};

export const useLiveStore = create<LiveStore>((set, get) => ({
  socketConnected: false,
  live: initialLive,
  queue: { running: [], pending: [] },
  previewUrl: null,
  lastGeneration: null,
  finished: null,

  applyEvent: (event) => {
    switch (event.type) {
      case 'snapshot':
      case 'state': {
        const previous = get().live;
        const jobChanged = previous.job?.promptId !== event.data.job?.promptId;
        // A new job (or no job) invalidates the preview from the last one.
        if (jobChanged) get().clearPreview();
        // A new run supersedes the previous result on screen.
        if (event.data.job && jobChanged) set({ finished: null });
        set({ live: event.data });
        break;
      }
      case 'queue':
        set({ queue: event.data });
        break;
      case 'generation': {
        const record = event.data;
        set({ lastGeneration: record });

        // Hold on to a run that has just ended so the UI can show its result
        // rather than snapping back to the form.
        const wasWatching = get().live.job?.promptId === record.promptId;
        const ended =
          record.status === 'completed' ||
          record.status === 'failed' ||
          record.status === 'cancelled';
        if (ended && (wasWatching || get().finished?.id === record.id)) {
          set({ finished: record });
        }
        break;
      }
      default:
        break;
    }
  },

  dismissFinished: () => set({ finished: null }),

  setPreview: (blob) => {
    const previous = get().previewUrl;
    const url = URL.createObjectURL(blob);
    set({ previewUrl: url });
    // Previews arrive several times a second; without this the tab leaks a
    // blob per frame.
    if (previous) URL.revokeObjectURL(previous);
  },

  clearPreview: () => {
    const previous = get().previewUrl;
    if (previous) URL.revokeObjectURL(previous);
    set({ previewUrl: null });
  },

  setSocketConnected: (connected) =>
    set((state) => ({
      socketConnected: connected,
      live: connected ? state.live : { ...state.live, connected: false },
    })),
}));

/** Convenience selectors — subscribing narrowly keeps re-renders cheap. */
export const selectJob = (state: LiveStore) => state.live.job;
export const selectComfyOnline = (state: LiveStore) => state.live.comfyOnline;
export const selectQueue = (state: LiveStore) => state.queue;
