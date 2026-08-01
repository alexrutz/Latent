import { create } from 'zustand';

import type { GenerationRecord, LiveState, QueueState, ServerEvent } from '@latent/shared';

interface LiveStore {
  /** Our own socket to the Latent server. */
  socketConnected: boolean;
  live: LiveState;
  /**
   * When this client received the current `live` (its own clock).
   *
   * The job's ETA is measured on the server and arrives once per sampler step,
   * which for a slow model is every few seconds — long enough for a static
   * countdown to look frozen. Interpolating needs a start point, and it has to be
   * a local one: the server's timestamps come from a different clock, and on a
   * rented box that clock can be minutes off.
   */
  liveAt: number;
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
  liveAt: 0,
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
        /*
         * The finished result deliberately survives the next job starting.
         *
         * Clearing it here is what made a batch unwatchable: item one finished,
         * item two started in the same breath, and the picture was replaced by
         * an empty frame before anyone could look at it. It stays until
         * something better replaces it — the next finished run, or a preview
         * frame from the one now sampling.
         */
        set({ live: event.data, liveAt: Date.now() });
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
        //
        // Cancelling is excluded on purpose. You already know what happened —
        // you did it — so a card announcing the run you just stopped is noise,
        // and it used to say "Done" over an empty frame.
        const wasWatching = get().live.job?.promptId === record.promptId;
        const ended = record.status === 'completed' || record.status === 'failed';
        if (record.status === 'cancelled' && get().finished?.id === record.id) {
          set({ finished: null });
        } else if (ended && (wasWatching || get().finished?.id === record.id)) {
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
