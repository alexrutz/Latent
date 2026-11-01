import type { FastifyBaseLogger } from 'fastify';

import { advanceBatches, batchLength } from '@latent/shared';
import type { GenerateRequest } from '@latent/shared';

import type { Store } from './db.js';
import type { Orchestrator } from './orchestrator.js';
import { queueBatch } from './routes/generate.js';
import type { AppContext } from './routes/context.js';

/**
 * Generating until told to stop.
 *
 * The point is a session where the machine keeps working and you keep looking:
 * with the prompt drawn from blocks and parameters varied per run, every batch
 * is a different picture, and queueing eight at a time then coming back is a
 * poor substitute for it.
 *
 * It lives on the server, and it has to. A phone locks its screen within a
 * minute; the browser suspends the tab, timers stop, and a loop in the client
 * would stop with them — leaving the GPU you are renting idle for exactly as
 * long as you were not looking at it.
 *
 * "Generate" while it is running does not queue anything. It updates the stored
 * settings, and the *next* run — the one after whatever is already in flight —
 * uses them. That is what makes it a dial rather than a button: change the
 * prompt, watch the change arrive a picture later, change it again.
 */

/** How long to wait before topping the queue up again after a failure. */
const BACKOFF_MS = 15_000;
/** How often the queue is checked. Cheap: it reads state the socket already keeps. */
const TICK_MS = 2_000;

export interface EndlessState {
  enabled: boolean;
  /** The settings the next run will use. Null when it has never been started. */
  request: GenerateRequest | null;
  /** Runs queued since it was switched on, for the UI to show. */
  queued: number;
  /** Why it stopped by itself, when it did. */
  message?: string;
}

const SETTING_KEY = 'endless';

export class Endless {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private pausedUntil = 0;
  private queued = 0;
  private message: string | undefined;

  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly ctx: () => AppContext,
    private readonly log: FastifyBaseLogger,
  ) {}

  get state(): EndlessState {
    const stored = readRequest(this.store);
    return {
      enabled: this.timer !== null,
      request: stored,
      queued: this.queued,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  /**
   * Start, or update the settings of a run already going.
   *
   * Updating deliberately does not queue anything: whatever is in flight
   * finishes as it was submitted, and the change shows up in the run after it.
   */
  set(request: GenerateRequest, enabled: boolean): EndlessState {
    this.store.setSecretSetting(SETTING_KEY, JSON.stringify(request));
    this.message = undefined;

    if (!enabled) {
      this.stop();
      return this.state;
    }

    if (!this.timer) {
      this.queued = 0;
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
      this.log.info('Endless generation on');
    }
    return this.state;
  }

  /** A round, and the settings stored again with the picture lists moved on. */
  private async queueRound(request: GenerateRequest): Promise<Outcome> {
    const before = this.store.getSecretSetting(SETTING_KEY);
    const { outcome, next } = await queueThroughLists(request, (one) =>
      queueBatch(this.ctx(), one),
    );
    // Changed while this was queueing — Generate pressed mid-round — wins.
    if (next !== request && this.store.getSecretSetting(SETTING_KEY) === before) {
      this.store.setSecretSetting(SETTING_KEY, JSON.stringify(next));
    }
    return outcome;
  }

  stop(reason?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info(`Endless generation off${reason ? `: ${reason}` : ''}`);
    }
    this.message = reason;
    this.busy = false;
  }

  /**
   * Keep one batch in the queue and no more.
   *
   * Topping up only when the queue has drained is what makes a settings change
   * take effect on the next picture rather than in ten minutes: a deep queue
   * would be full of runs submitted under the old values.
   */
  private async tick(): Promise<void> {
    if (this.busy || !this.timer) return;
    if (Date.now() < this.pausedUntil) return;

    const live = this.orchestrator.getState();
    if (!live.comfyOnline) return;
    if (live.job || live.queueRemaining > 0) return;

    const request = readRequest(this.store);
    if (!request?.workflowId) {
      this.stop('nothing was set up to run');
      return;
    }

    this.busy = true;
    try {
      const outcome = await this.queueRound(request);

      if ('notFound' in outcome) {
        this.stop('that workflow has been deleted');
        return;
      }
      if (outcome.error && outcome.generationIds.length === 0) {
        /*
         * A failure that repeats forever is worse than stopping: an invalid
         * graph would fill the gallery with failures at one every two seconds.
         * Back off once, and give up if it happens again.
         */
        if (this.pausedUntil > 0) {
          this.stop(outcome.error);
          return;
        }
        this.pausedUntil = Date.now() + BACKOFF_MS;
        this.log.warn(`Endless generation paused: ${outcome.error}`);
        return;
      }

      this.pausedUntil = 0;
      this.queued += outcome.generationIds.length;
    } catch (error) {
      this.log.warn({ err: error }, 'Endless generation could not queue a run');
      this.pausedUntil = Date.now() + BACKOFF_MS;
    } finally {
      this.busy = false;
    }
  }
}

/*
 * One round: the batch, and the picture lists moved on.
 *
 * With a list of pictures in a slot, each run takes the next one — as the form
 * does when it queues — so "make four" is four runs of a picture each rather
 * than four of the same. The settings are stored again with the lists moved on,
 * so the next round starts where this one stopped; unless they were changed
 * while this round was queueing, in which case the change wins.
 */
type Outcome = Awaited<ReturnType<typeof queueBatch>>;

export async function queueThroughLists(
  request: GenerateRequest,
  queue: (request: GenerateRequest) => Promise<Outcome>,
): Promise<{ outcome: Outcome; next: GenerateRequest }> {
  const lists = request.batchInputs ?? {};
  const count = Math.max(1, request.batchCount ?? 1);
  if (batchLength(lists) === 0) return { outcome: await queue(request), next: request };

  // A list of one is the ordinary case: one request, the server's own batch.
  const stepping = batchLength(lists) > 1 && count > 1;
  const runs = stepping ? count : 1;
  let values = request.values;
  let outcome: Outcome | null = null;
  const generationIds: string[] = [];
  const promptIds: string[] = [];

  for (let run = 0; run < runs; run += 1) {
    const one = await queue({ ...request, values, batchCount: stepping ? 1 : count });
    if ('notFound' in one) return { outcome: one, next: request };
    generationIds.push(...one.generationIds);
    promptIds.push(...one.promptIds);
    outcome = one;
    if (one.generationIds.length === 0) break;
    values = advanceBatches(values, lists);
    if (one.error) break;
  }

  return {
    outcome: { ...(outcome as Exclude<Outcome, { notFound: true }>), generationIds, promptIds },
    next: { ...request, values },
  };
}

/** The stored setup, or null when it has never been started or is unreadable. */
function readRequest(store: Store): GenerateRequest | null {
  const raw = store.getSecretSetting(SETTING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GenerateRequest;
  } catch {
    return null;
  }
}
