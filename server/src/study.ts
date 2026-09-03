import type { FastifyBaseLogger } from 'fastify';

import {
  applyModelServer,
  applyOverrides,
  applyImageOff,
  applyParams,
  imageOffNodes,
  applyPresetActive,
  applyPresetChat,
  buildParamSummary,
} from '@latent/shared';
import type { ModelServerTarget, ParamValues } from '@latent/shared';

import type { Store } from './db.js';
import type { Orchestrator } from './orchestrator.js';
import { deriveTitle } from './routes/context.js';

/**
 * Running a parameter study's first phase.
 *
 * The same shape as endless generation, and for the same reason: this is a
 * stretch of unattended work measured in hours, and a phone locks its screen
 * within a minute. Anything driving it from the browser stops the moment the
 * tab is suspended, which would leave a rented GPU idle for exactly as long as
 * nobody was looking at it.
 *
 * What it adds over endless mode is *position*. Endless generation is a switch
 * that never ends; a study is a finite list that has to be worked through in
 * its planned order, survive being paused on Tuesday and resumed on Thursday,
 * and never render the same shot twice. So the plan lives in the database, one
 * row per shot, and this walks it.
 */

/** How often the queue is looked at. Cheap — it reads state the socket keeps. */
const TICK_MS = 2_000;

/**
 * How many shots to keep in ComfyUI's queue at once.
 *
 * Not one, because a queue that empties between shots wastes the seconds
 * between a picture finishing and the next prompt arriving — and over a
 * thousand shots those seconds are an hour. Not many, because everything
 * already submitted has to finish before a pause takes effect, and a pause
 * that takes ten minutes is not a pause.
 */
const QUEUE_DEPTH = 2;

/** How long to wait after a failure before trying the next shot. */
const BACKOFF_MS = 15_000;

export interface StudyRunState {
  studyId: string | null;
  running: boolean;
  /** Why it stopped by itself, when it did. */
  message?: string;
}

export class StudyRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private pausedUntil = 0;
  private studyId: string | null = null;
  private message: string | undefined;

  /** Where the model server is, for any llama-server node in the graph. */
  private modelServer(): ModelServerTarget | null {
    const active = this.store.getActiveConnection('llama');
    if (!active) return null;
    return {
      url: active.url,
      authMode: active.authMode,
      username: active.username,
      secret: active.secret,
    };
  }

  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly log: FastifyBaseLogger,
  ) {}

  get state(): StudyRunState {
    return {
      studyId: this.studyId,
      running: this.timer !== null,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  /**
   * Start, or carry on, rendering a study.
   *
   * One at a time, and asking for a second stops the first. Two studies
   * sharing a GPU would interleave their model switches, which is precisely
   * the cost the plan's ordering exists to avoid.
   */
  start(studyId: string): StudyRunState {
    if (this.studyId && this.studyId !== studyId) this.pause();

    const stranded = this.store.requeueStranded(studyId);
    if (stranded > 0) this.log.info(`Study ${studyId}: ${stranded} stranded shots requeued`);

    this.studyId = studyId;
    this.message = undefined;
    this.store.updateStudy(studyId, { status: 'running' });

    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
    }
    return this.state;
  }

  /**
   * Stop, keeping everything rendered so far.
   *
   * Deliberately does not clear ComfyUI's queue: the shots already submitted
   * are already paid for, and throwing them away to make "paused" instant
   * would waste work for no gain. They land, they are recorded, and nothing
   * further is submitted.
   */
  pause(reason?: string): StudyRunState {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.studyId) {
      const study = this.store.getStudy(this.studyId);
      if (study?.status === 'running') {
        this.store.updateStudy(this.studyId, { status: 'paused' });
      }
    }
    this.message = reason;
    this.busy = false;
    this.pausedUntil = 0;
    return this.state;
  }

  /**
   * Called as each run settles, to move its shot on.
   *
   * Also where a study ends. The moment the last shot lands it turns itself
   * over to the rating phase — making that a button would mean a study that
   * finished overnight sits there saying "running" until somebody presses it.
   */
  onGenerationSettled(generationId: string, ok: boolean): void {
    const shot = this.store.findShotByGeneration(generationId);
    if (!shot) return;

    this.store.setShotStatus(shot.id, ok ? 'done' : 'failed');

    const study = this.store.getStudy(shot.studyId);
    if (!study || study.status !== 'running') return;
    if (this.store.nextPendingShots(shot.studyId, 1).length > 0) return;

    this.store.updateStudy(shot.studyId, { status: 'rating' });
    if (this.studyId === shot.studyId) this.pause();
    this.log.info(`Study ${shot.studyId} finished rendering`);
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.timer || !this.studyId) return;
    if (Date.now() < this.pausedUntil) return;

    const live = this.orchestrator.getState();
    if (!live.comfyOnline) return;

    // Keep the queue shallow. Anything already waiting is a shot of ours.
    const outstanding = live.queueRemaining + (live.job ? 1 : 0);
    if (outstanding >= QUEUE_DEPTH) return;

    const studyId = this.studyId;
    const study = this.store.getStudy(studyId);
    if (!study) {
      this.pause('that study has been deleted');
      return;
    }

    const shots = this.store.nextPendingShots(studyId, QUEUE_DEPTH - outstanding);
    // Everything is submitted and the last few are in flight. The move to the
    // rating phase happens in `onGenerationSettled`, when they land.
    if (shots.length === 0) return;

    const detail = study.workflowId ? this.store.getWorkflow(study.workflowId) : null;
    if (!detail) {
      this.pause('that workflow has been deleted');
      return;
    }

    this.busy = true;
    try {
      // Reshaped against the study's own base, which is where its preset-chat
      // slots were named — the same schema the setup screen was filled against.
      const schema = applyOverrides(applyPresetChat(detail.schema, study.base), detail.overrides);

      for (const shot of shots) {
        /*
         * The drawn factor values on top of everything typed on the setup
         * screen. The order matters: the base holds the prompt and the
         * settings being held constant, and a factor must always win — that is
         * what makes it the thing being varied.
         */
        const values: ParamValues = applyPresetActive(schema, {
          ...study.base,
          ...shot.values,
        });
        const title = deriveTitle(schema, values, `${study.name} #${shot.ordinal + 1}`);

        /*
         * Seeds are held fixed unless the study varies them.
         *
         * A study asks what one parameter does. Re-rolling the seed every shot
         * answers a different question — what the *seed* does — and its effect
         * is larger than most of what is being measured, so it would swamp
         * every correlation the second phase computes. Anyone who genuinely
         * wants seed variation adds it as a factor, where the analysis
         * accounts for it.
         */
        const { workflow, seeds } = applyParams(detail.graph, schema, values, {
          randomizeSeeds: false,
          lockedSeedFields: [],
        });

        const submitted = { ...values, ...seeds };
        const result = await this.orchestrator.submit({
          // A study runs the same graph hundreds of times; a llama-server node
          // in it wants the same address the rest of the app is using.
          /*
           * A picture the form switched off stays off for every shot.
           *
           * Without the node definitions here, so a study that unplugs a
           * required input is refused by ComfyUI rather than by us — a study
           * is set up once and run hundreds of times, and the first shot
           * failing says the same thing.
           */
          graph: applyImageOff(
            applyModelServer(workflow, this.modelServer()),
            imageOffNodes(schema, values),
          ).workflow,
          workflowId: detail.id,
          workflowName: detail.name,
          title,
          values: submitted,
          seeds,
          params: buildParamSummary(schema, submitted),
          // What keeps a study's output out of the gallery.
          source: 'study',
        });

        this.store.setShotStatus(shot.id, 'queued', result.generationId);
      }
      this.pausedUntil = 0;
    } catch (error) {
      /*
       * Back off rather than stop. A study is long, and a transient failure —
       * ComfyUI restarting, a model briefly unavailable — should cost fifteen
       * seconds, not the rest of the run. A permanent one repeats every
       * fifteen seconds, which is visible in the log and in the failed count
       * on screen.
       */
      this.log.warn({ err: error }, 'Study could not queue a shot');
      this.pausedUntil = Date.now() + BACKOFF_MS;
    } finally {
      this.busy = false;
    }
  }
}
