import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';

import type {
  ApiWorkflow,
  ComfyExecutedMessage,
  ComfyExecutingMessage,
  ComfyExecutionCachedMessage,
  ComfyExecutionErrorMessage,
  ComfyExecutionStartMessage,
  ComfyProgressMessage,
  ComfyImageRef,
  ComfyStatusMessage,
  ComfyWsMessage,
  JobStats,
  LiveState,
  ObjectInfo,
  ParamSummaryItem,
  ParamValues,
  QueueEntry,
  QueueState,
} from '@latent/shared';

import { ComfyClient } from './comfy/client.js';
import type { ConnectionConfig } from './comfy/connection.js';
import { ComfySocket } from './comfy/socket.js';
import type { Store } from './db.js';
import { Hub } from './hub.js';
import { Monitor } from './monitor.js';

/** How often live state is pushed while a sampler is running. */
const STATE_THROTTLE_MS = 100;
/** How long a cached `/object_info` response stays fresh. */
const OBJECT_INFO_TTL_MS = 60_000;
/**
 * How long ComfyUI may be unreachable before its jobs are declared lost.
 *
 * Long enough to ride out a reconnect, short enough that the queue badge and
 * the progress bar stop describing a machine that is no longer there.
 */
const OFFLINE_GRACE_MS = 25_000;
/** How often to check that outstanding jobs still exist upstream. */
const RECONCILE_INTERVAL_MS = 60_000;
/**
 * How long a submitted prompt gets before it may be declared missing.
 *
 * ComfyUI can take a moment to admit a prompt exists; judging one younger than
 * this would cancel the job that was just started.
 */
const SETTLE_MS = 10_000;

interface TrackedPrompt {
  generationId: string;
  title: string;
  workflowName: string;
  /** Node ids in the submitted graph, for graph-level progress. */
  nodeIds: Set<string>;
  nodeTitles: Map<string, string>;
  executed: Set<string>;
  finished: boolean;
  /** What the job was submitted with, for the queue listing. */
  params: ParamSummaryItem[];
}

/**
 * Step timing for the sampler pass currently running.
 *
 * Reset whenever a new node starts reporting progress: a two-sampler workflow
 * runs at two different speeds, and averaging across both would give an ETA
 * that is wrong for each of them.
 */
interface StepTiming {
  /** When the pass's first progress event arrived. */
  firstAt: number;
  /** Step number at `firstAt` — usually 1, not always. */
  firstStep: number;
  lastAt: number;
  lastStep: number;
}

function emptyStats(): JobStats {
  return {
    elapsedMs: 0,
    msPerStep: null,
    etaMs: null,
    stepsRemaining: 0,
    nodesDone: 0,
    nodesTotal: 0,
    nodeElapsedMs: 0,
    lastRunMs: null,
  };
}

/** Output keys that carry bytes rather than words. */
const BINARY_OUTPUT_KEYS = new Set(['images', 'gifs', 'audio', 'video', 'latents', 'masks']);

/**
 * Every string a node produced, whatever it chose to call the field.
 *
 * There is no convention here: the core preview node uses `text`, others use
 * `string` or `value`, and a custom node can use anything. Rather than keep a
 * list of node types that will always be out of date, take any array of plain
 * values that is not one of the known binary payloads.
 */
function collectTexts(output: Record<string, unknown> | undefined): string[] {
  if (!output) return [];
  const found: string[] = [];

  for (const [key, value] of Object.entries(output)) {
    if (BINARY_OUTPUT_KEYS.has(key) || !Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim() !== '') found.push(entry);
      else if (typeof entry === 'number' || typeof entry === 'boolean') found.push(String(entry));
    }
  }

  return found;
}

/**
 * The images a finished prompt left in ComfyUI's history, by node.
 *
 * Used when a run completed while this app was not listening: the WebSocket
 * events are gone, but the history still knows what was produced.
 */
function collectHistoryImages(entry: {
  outputs?: Record<string, { images?: ComfyImageRef[] }>;
}): [string, ComfyImageRef[]][] {
  const found: [string, ComfyImageRef[]][] = [];

  for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
    const images = (output?.images ?? [])
      // `temp` is a live preview, not a result.
      .filter((image) => image.type !== 'temp')
      .map((image) => ({
        filename: image.filename,
        subfolder: image.subfolder ?? '',
        type: image.type ?? 'output',
      }));
    if (images.length > 0) found.push([nodeId, images]);
  }

  return found;
}

function emptyState(): LiveState {
  return {
    connected: true,
    comfyOnline: false,
    queueRemaining: 0,
    job: null,
    lastError: null,
  };
}

/**
 * Owns everything stateful: the upstream ComfyUI connection, the live job, and
 * the write side of the generation history.
 *
 * Routes stay thin — they validate input and call in here.
 */
export class Orchestrator {
  private currentClient: ComfyClient;
  private currentSocket: ComfySocket;
  private connection: ConnectionConfig;
  readonly hub = new Hub();
  private readonly clientId = randomUUID();

  private state: LiveState;
  private readonly tracked = new Map<string, TrackedPrompt>();
  private queueState: QueueState = { running: [], pending: [] };

  private objectInfoCache: { value: ObjectInfo; fetchedAt: number } | null = null;
  private objectInfoInFlight: Promise<ObjectInfo> | null = null;

  /**
   * Submits whose `/prompt` response hasn't come back yet.
   *
   * ComfyUI can start executing — and tell us about it — before it answers the
   * HTTP request that queued the work, so `execution_start` regularly arrives
   * for a prompt id we have never seen. These let the job be labelled correctly
   * from its very first frame instead of flashing "Untitled".
   */
  private readonly inFlightSubmits: { title: string; workflowName: string }[] = [];

  /** Timing for the sampler pass in progress, and when the current node began. */
  private stepTiming: StepTiming | null = null;
  private nodeStartedAt = 0;
  /** Duration of the last run that finished, so the next one has a yardstick. */
  private lastRunMs: number | null = null;

  private offlineTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  /**
   * Set by `stop()`. Reconciliation is asynchronous, so a shutdown can land
   * between the queue request and the database write that follows it.
   */
  private stopped = false;

  private stateDirty = false;
  private stateTimer: NodeJS.Timeout | null = null;
  private queueRefreshTimer: NodeJS.Timeout | null = null;

  /**
   * The resource and event history.
   *
   * Owned here because this is the only place that knows both what the machine
   * is doing and what it is doing it for — a chart of VRAM with no idea which
   * node was running is decoration.
   */
  readonly monitor: Monitor;

  constructor(
    private readonly store: Store,
    connection: ConnectionConfig,
    private readonly log: FastifyBaseLogger,
  ) {
    this.connection = connection;
    this.currentClient = new ComfyClient(connection);
    this.currentSocket = new ComfySocket(connection, this.clientId);
    this.state = emptyState();
    this.monitor = new Monitor(
      () => this.currentClient,
      () => ({
        busy: this.state.job !== null,
        queueRemaining: this.state.queueRemaining,
        stepsPerSecond: this.stepsPerSecond(),
      }),
    );
  }

  /** Sampler speed right now, for the timeline. */
  private stepsPerSecond(): number | null {
    const perStep = this.state.job?.stats.msPerStep ?? null;
    return perStep !== null && perStep > 0 ? 1000 / perStep : null;
  }

  /** The active endpoint's REST client. Replaced wholesale when switching. */
  get client(): ComfyClient {
    return this.currentClient;
  }

  private get socket(): ComfySocket {
    return this.currentSocket;
  }

  get activeConnection(): ConnectionConfig {
    return this.connection;
  }

  /**
   * Retarget at a different ComfyUI without restarting the process.
   *
   * Everything endpoint-specific has to go: the socket, the route-prefix probe,
   * and the cached `/object_info` — model lists on the new box are a different
   * set of files, and serving the old ones would silently offer checkpoints that
   * do not exist there.
   */
  async switchConnection(next: ConnectionConfig): Promise<void> {
    this.log.info(`Switching ComfyUI connection to ${next.name} (${next.url})`);

    this.currentSocket.stop();
    this.currentSocket.removeAllListeners();
    await this.currentClient.close();

    this.connection = next;
    this.currentClient = new ComfyClient(next);
    this.currentSocket = new ComfySocket(next, this.clientId);

    this.objectInfoCache = null;
    this.objectInfoInFlight = null;
    this.queueState = { running: [], pending: [] };
    this.state = { ...emptyState(), job: null };

    this.bindSocket();
    this.currentSocket.start();
    // A different endpoint is a different machine: its VRAM curve has nothing
    // to do with the last one's.
    this.monitor.reset();
    this.monitor.record('online', `Switched to ${next.name}`);
    this.pushState(true);
    this.hub.broadcast({ type: 'queue', data: this.queueState });
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  start(): void {
    const stale = this.store.failStaleGenerations();
    if (stale > 0) {
      this.log.warn(`Marked ${stale} interrupted generation(s) as failed after restart`);
    }

    this.bindSocket();
    this.socket.start();
    this.monitor.start();

    /*
     * A slow sweep for anything the events missed.
     *
     * The socket can stay up while individual messages are lost — ComfyUI
     * restarting behind a proxy that keeps the connection open, for one — and
     * the query is free when nothing is outstanding.
     */
    this.reconcileTimer = setInterval(() => {
      if (this.stopped || !this.state.comfyOnline) return;
      if (this.store.listUnfinished(10_000).length === 0) return;
      void this.refreshQueue().then(() => this.reconcile());
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
  }

  /** Attach handlers to whichever socket is current. Re-run on every switch. */
  private bindSocket(): void {
    this.socket.on('open', () => {
      this.log.info('Connected to ComfyUI');
      this.client.resetPrefix();
      const wasOffline = !this.state.comfyOnline;
      this.state.comfyOnline = true;
      this.state.lastError = null;
      if (this.offlineTimer) clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
      if (wasOffline) this.monitor.record('online', 'ComfyUI connected');
      this.pushState(true);
      // Whatever happened while we were not listening has to be worked out from
      // the queue and the history, not assumed.
      void this.refreshQueue().then(() => this.reconcile());
    });

    this.socket.on('close', () => {
      this.log.warn('Lost connection to ComfyUI — retrying');
      if (this.state.comfyOnline) this.monitor.record('offline', 'ComfyUI unreachable');
      this.state.comfyOnline = false;
      this.pushState(true);
      this.startOfflineCountdown();
    });

    this.socket.on('error', (error) => {
      this.state.lastError = error.message;
      this.log.debug({ err: error }, 'ComfyUI socket error');
    });

    this.socket.on('message', (message) => this.onComfyMessage(message));
    this.socket.on('preview', (frame) => this.hub.broadcastBinary(frame.data));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket.stop();
    this.monitor.stop();
    await this.currentClient.close();
    this.hub.closeAll();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.queueRefreshTimer) clearTimeout(this.queueRefreshTimer);
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
  }

  /* ---------------------------------------------------------------- */
  /* Client connections                                                */
  /* ---------------------------------------------------------------- */

  /** Bring a newly connected browser fully up to date in one message. */
  attachClient(socket: WebSocket): void {
    this.hub.add(socket);
    this.hub.send(socket, { type: 'snapshot', data: this.state });
    this.hub.send(socket, { type: 'queue', data: this.queueState });
    // Someone is looking at the app — this is the moment to stop waiting out a
    // backoff and find out whether ComfyUI came back.
    this.ensureConnected();
  }

  /**
   * Ask the upstream socket to retry now rather than on its backoff schedule.
   * Safe to call often; it is a no-op when already connected or connecting.
   */
  ensureConnected(): void {
    this.socket.reconnectNow();
  }

  getState(): LiveState {
    return this.state;
  }

  getQueueState(): QueueState {
    return this.queueState;
  }

  /* ---------------------------------------------------------------- */
  /* object_info (cached — it is large and rarely changes)              */
  /* ---------------------------------------------------------------- */

  async objectInfo(force = false): Promise<ObjectInfo> {
    const cached = this.objectInfoCache;
    if (!force && cached && Date.now() - cached.fetchedAt < OBJECT_INFO_TTL_MS) {
      return cached.value;
    }
    if (this.objectInfoInFlight) return this.objectInfoInFlight;

    this.objectInfoInFlight = this.client
      .objectInfo()
      .then((value) => {
        this.objectInfoCache = { value, fetchedAt: Date.now() };
        return value;
      })
      .finally(() => {
        this.objectInfoInFlight = null;
      });

    try {
      return await this.objectInfoInFlight;
    } catch (error) {
      // Falling back to the last known definitions beats failing an import
      // outright — the schema engine degrades gracefully without them.
      if (cached) {
        this.log.warn('Using cached /object_info — ComfyUI is unreachable');
        return cached.value;
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Submitting work                                                   */
  /* ---------------------------------------------------------------- */

  async submit(input: {
    graph: ApiWorkflow;
    workflowId: string | null;
    workflowName: string;
    title: string;
    values: ParamValues;
    seeds: Record<string, number>;
    /** Readable summary of the submitted values, for the queue listing. */
    params?: ParamSummaryItem[];
    /** `study` keeps the run out of the gallery. See `Store.insertGeneration`. */
    source?: 'comfy' | 'study';
  }): Promise<{ generationId: string; promptId: string }> {
    const inFlight = { title: input.title, workflowName: input.workflowName };
    this.inFlightSubmits.push(inFlight);

    let response;
    try {
      response = await this.client.submit(input.graph, this.clientId, {
        // Surfaces in ComfyUI's own UI so a job queued from a phone is identifiable.
        extra_pnginfo: { latent: { workflow: input.workflowName } },
      });
    } finally {
      const index = this.inFlightSubmits.indexOf(inFlight);
      if (index >= 0) this.inFlightSubmits.splice(index, 1);
    }

    if (!response.prompt_id) {
      throw new Error('ComfyUI accepted the prompt but returned no prompt_id');
    }

    const generationId = randomUUID();
    const params = input.params ?? [];
    this.store.insertGeneration({
      id: generationId,
      promptId: response.prompt_id,
      workflowId: input.workflowId,
      workflowName: input.workflowName,
      title: input.title,
      values: input.values,
      seeds: input.seeds,
      params,
      source: input.source ?? 'comfy',
    });

    const nodeTitles = new Map<string, string>();
    for (const [nodeId, node] of Object.entries(input.graph)) {
      nodeTitles.set(nodeId, node._meta?.title ?? node.class_type);
    }

    this.tracked.set(response.prompt_id, {
      generationId,
      title: input.title,
      workflowName: input.workflowName,
      nodeIds: new Set(Object.keys(input.graph)),
      nodeTitles,
      executed: new Set(),
      finished: false,
      params,
    });

    this.monitor.record('queued', input.title, input.workflowName, response.prompt_id);

    // ComfyUI often starts executing before this HTTP response lands, so
    // `execution_start` can arrive while the prompt is still unknown here.
    // When that happens the job was created without a title or a generation to
    // attach to — fill it in now instead of showing "Untitled" for the run.
    if (this.state.job?.promptId === response.prompt_id) {
      this.state.job.generationId = generationId;
      this.state.job.title = input.title;
      this.state.job.nodeTitle =
        (this.state.job.nodeId && nodeTitles.get(this.state.job.nodeId)) ?? this.state.job.nodeTitle;
      this.store.setGenerationStatus(response.prompt_id, 'running');
      this.pushState(true);
    }

    this.scheduleQueueRefresh();
    this.emitGeneration(response.prompt_id);

    return { generationId, promptId: response.prompt_id };
  }

  async interrupt(): Promise<void> {
    await this.client.interrupt();
    this.scheduleQueueRefresh();
  }

  async cancel(promptId: string): Promise<void> {
    // A prompt that is already running can only be stopped with /interrupt;
    // one still pending is removed from the queue.
    const isRunning = this.queueState.running.some((entry) => entry.promptId === promptId);
    if (isRunning) {
      await this.client.interrupt();
    } else {
      await this.client.deleteQueued([promptId]);
      this.markFinished(promptId, 'cancelled', null);
    }
    this.scheduleQueueRefresh();
  }

  async clearQueue(): Promise<void> {
    const pending = [...this.queueState.pending];
    await this.client.clearQueue();
    for (const entry of pending) this.markFinished(entry.promptId, 'cancelled', null);
    this.scheduleQueueRefresh();
  }

  /* ---------------------------------------------------------------- */
  /* Upstream event handling                                           */
  /* ---------------------------------------------------------------- */

  private onComfyMessage(message: ComfyWsMessage): void {
    switch (message.type) {
      case 'status':
        this.onStatus(message as ComfyStatusMessage);
        break;
      case 'execution_start':
        this.onExecutionStart(message as ComfyExecutionStartMessage);
        break;
      case 'execution_cached':
        this.onExecutionCached(message as ComfyExecutionCachedMessage);
        break;
      case 'executing':
        this.onExecuting(message as ComfyExecutingMessage);
        break;
      case 'progress':
        this.onProgress(message as ComfyProgressMessage);
        break;
      case 'executed':
        this.onExecuted(message as ComfyExecutedMessage);
        break;
      case 'execution_success':
        this.finishPrompt(
          (message.data as { prompt_id?: string } | undefined)?.prompt_id,
          'completed',
          null,
        );
        break;
      case 'execution_error':
        this.onExecutionError(message as ComfyExecutionErrorMessage);
        break;
      case 'execution_interrupted':
        this.finishPrompt(
          (message.data as { prompt_id?: string } | undefined)?.prompt_id,
          'cancelled',
          null,
        );
        break;
      default:
        // Extensions publish their own message types on the same socket; the
        // monitor takes the ones it recognises and ignores the rest.
        this.monitor.absorb(message.type, (message as { data?: unknown }).data);
        break;
    }
  }

  private onStatus(message: ComfyStatusMessage): void {
    const remaining = message.data?.status?.exec_info?.queue_remaining ?? 0;
    if (remaining !== this.state.queueRemaining) {
      this.state.queueRemaining = remaining;
      this.scheduleQueueRefresh();
      this.pushState(true);
    }
  }

  private onExecutionStart(message: ComfyExecutionStartMessage): void {
    const promptId = message.data.prompt_id;
    const tracked = this.tracked.get(promptId);
    // Unknown prompt + a submit in flight means this is almost certainly ours,
    // just faster than its own HTTP response. Otherwise it was queued from
    // ComfyUI's own UI and we genuinely have no name for it.
    const inFlight = this.inFlightSubmits[0];

    this.stepTiming = null;
    this.nodeStartedAt = Date.now();

    this.state.job = {
      promptId,
      generationId: tracked?.generationId ?? null,
      title: tracked?.title ?? inFlight?.title ?? 'Queued in ComfyUI',
      nodeId: null,
      nodeTitle: null,
      progress: 0,
      progressMax: 0,
      graphProgress: 0,
      startedAt: Date.now(),
      stats: { ...emptyStats(), lastRunMs: this.lastRunMs },
    };
    this.updateStats();
    this.monitor.record('started', this.state.job.title, undefined, promptId);

    this.store.setGenerationStatus(promptId, 'running');
    this.emitGeneration(promptId);
    this.pushState(true);
  }

  private onExecutionCached(message: ComfyExecutionCachedMessage): void {
    const tracked = this.tracked.get(message.data.prompt_id);
    if (!tracked) return;
    for (const nodeId of message.data.nodes ?? []) tracked.executed.add(nodeId);
    this.updateGraphProgress(message.data.prompt_id);
  }

  private onExecuting(message: ComfyExecutingMessage): void {
    const { node, prompt_id: promptId } = message.data;

    // `node: null` is ComfyUI's end-of-prompt signal. Older builds send only
    // this and never `execution_success`, so it must finish the job too.
    if (node === null) {
      this.finishPrompt(promptId ?? this.state.job?.promptId, 'completed', null);
      return;
    }

    if (!this.state.job) return;
    const tracked = promptId ? this.tracked.get(promptId) : undefined;
    this.state.job.nodeId = node;
    this.state.job.nodeTitle = tracked?.nodeTitles.get(node) ?? node;
    this.monitor.record('node', this.state.job.nodeTitle, undefined, promptId ?? null);
    this.state.job.progress = 0;
    this.state.job.progressMax = 0;
    // A different node samples at a different speed, so the running average
    // starts over rather than blending two passes into one wrong ETA.
    this.stepTiming = null;
    this.nodeStartedAt = Date.now();
    this.updateStats();
    this.pushState(true);
  }

  private onProgress(message: ComfyProgressMessage): void {
    if (!this.state.job) return;
    const step = message.data.value ?? 0;
    this.state.job.progress = step;
    this.state.job.progressMax = message.data.max ?? 0;

    const now = Date.now();
    if (!this.stepTiming || step < this.stepTiming.lastStep) {
      // First step of the pass, or the counter went backwards because a new pass
      // began without an `executing` in between.
      this.stepTiming = { firstAt: now, firstStep: step, lastAt: now, lastStep: step };
    } else {
      this.stepTiming.lastAt = now;
      this.stepTiming.lastStep = step;
    }

    this.updateStats();
    this.pushState();
  }

  /**
   * Recompute the running job's timing.
   *
   * The per-step mean is measured from the *second* step onwards: the first
   * includes model loading, VAE setup and CUDA warm-up, which on a cold vast.ai
   * box can be twenty seconds and would poison the estimate for the whole run.
   */
  private updateStats(): void {
    const job = this.state.job;
    if (!job) return;

    const now = Date.now();
    const timing = this.stepTiming;
    const stepsCounted = timing ? timing.lastStep - timing.firstStep : 0;

    const msPerStep =
      timing && stepsCounted > 0 ? (timing.lastAt - timing.firstAt) / stepsCounted : null;

    const stepsRemaining = job.progressMax > 0 ? Math.max(0, job.progressMax - job.progress) : 0;

    job.stats = {
      elapsedMs: now - job.startedAt,
      msPerStep,
      // Count the time already spent waiting on the step in flight, so a stalled
      // run's ETA grows instead of sitting still and lying about it.
      etaMs:
        msPerStep !== null && stepsRemaining > 0
          ? Math.max(0, stepsRemaining * msPerStep - (now - (timing?.lastAt ?? now)))
          : null,
      stepsRemaining,
      nodesDone: this.tracked.get(job.promptId)?.executed.size ?? 0,
      nodesTotal: this.tracked.get(job.promptId)?.nodeIds.size ?? 0,
      nodeElapsedMs: this.nodeStartedAt > 0 ? now - this.nodeStartedAt : 0,
      lastRunMs: this.lastRunMs,
    };
  }

  private onExecuted(message: ComfyExecutedMessage): void {
    const { prompt_id: promptId, node, output } = message.data;
    const tracked = this.tracked.get(promptId);
    if (tracked) {
      tracked.executed.add(node);
      this.updateGraphProgress(promptId);
    }

    /*
     * Text before images.
     *
     * A "preview as text" node produces an output with no pictures in it, and
     * returning early on that — which is what this used to do — meant the one
     * kind of output that exists purely to tell you what happened was the one
     * kind thrown away.
     */
    const texts = collectTexts(output);
    if (texts.length > 0) {
      const nodeTitle = tracked?.nodeTitles.get(node) ?? `Node ${node}`;
      this.store.addTextOutputs(
        promptId,
        texts.map((text) => ({ nodeId: node, nodeTitle, text })),
      );
      for (const text of texts) this.monitor.record('text', nodeTitle, text, promptId);
      this.emitGeneration(promptId);
    }

    const images = output?.images ?? [];
    if (images.length === 0) return;

    // `temp` images are ComfyUI's in-flight previews, not results.
    const results: ComfyImageRef[] = images
      .filter((image) => image.type !== 'temp')
      .map((image) => ({
        filename: image.filename,
        subfolder: image.subfolder ?? '',
        type: image.type ?? 'output',
      }));
    if (results.length === 0) return;

    this.store.addImages(promptId, node, results);
    this.emitGeneration(promptId);
  }

  private onExecutionError(message: ComfyExecutionErrorMessage): void {
    const detail =
      message.data.exception_message ??
      message.data.exception_type ??
      'ComfyUI reported an execution error';
    const nodeType = message.data.node_type;
    this.finishPrompt(
      message.data.prompt_id,
      'failed',
      nodeType ? `${nodeType}: ${detail}` : detail,
    );
  }

  private updateGraphProgress(promptId: string): void {
    const tracked = this.tracked.get(promptId);
    if (!tracked || !this.state.job || this.state.job.promptId !== promptId) return;
    const total = tracked.nodeIds.size || 1;
    this.state.job.graphProgress = Math.min(1, tracked.executed.size / total);
    this.updateStats();
  }

  private finishPrompt(
    promptId: string | undefined,
    status: 'completed' | 'failed' | 'cancelled',
    error: string | null,
  ): void {
    if (!promptId) return;
    this.markFinished(promptId, status, error);

    if (this.state.job?.promptId === promptId) {
      // Only a run that actually got to the end is a useful yardstick for the
      // next one; a cancelled or failed run says nothing about how long this
      // workflow takes.
      if (status === 'completed') this.lastRunMs = Date.now() - this.state.job.startedAt;
      this.state.job = null;
      this.stepTiming = null;
      this.nodeStartedAt = 0;
    }
    this.state.lastError = status === 'failed' ? error : null;
    this.scheduleQueueRefresh();
    this.pushState(true);
  }

  /**
   * Called once per run as it settles, with whether it produced anything.
   *
   * Set by whoever needs it — today the study runner, which has to know the
   * moment a shot lands so it can queue the next and, when it was the last,
   * turn the study over to its rating phase by itself. A callback rather than
   * a subscription to the event hub because this is server-internal
   * bookkeeping, not something a client should be able to miss by having
   * closed its tab.
   */
  onSettled: ((generationId: string, ok: boolean) => void) | null = null;

  /** Idempotent: ComfyUI can send both `executing:null` and `execution_success`. */
  private markFinished(
    promptId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error: string | null,
  ): void {
    const tracked = this.tracked.get(promptId);
    if (tracked?.finished) return;
    if (tracked) tracked.finished = true;

    this.monitor.record(status, tracked?.title ?? 'Run', error ?? undefined, promptId);

    const existing = this.store.getGenerationByPromptId(promptId);
    if (!existing) return; // Queued from ComfyUI's own UI — nothing to record.

    this.store.setGenerationStatus(promptId, status, error);
    this.emitGeneration(promptId);
    this.onSettled?.(existing.id, status === 'completed');

    // Keep the map from growing without bound over a long-running server.
    setTimeout(() => this.tracked.delete(promptId), 60_000).unref?.();
  }

  private emitGeneration(promptId: string): void {
    const record = this.store.getGenerationByPromptId(promptId);
    if (record) this.hub.broadcast({ type: 'generation', data: record });
  }

  /* ---------------------------------------------------------------- */
  /* Queue                                                             */
  /* ---------------------------------------------------------------- */

  private scheduleQueueRefresh(): void {
    if (this.queueRefreshTimer) return;
    this.queueRefreshTimer = setTimeout(() => {
      this.queueRefreshTimer = null;
      void this.refreshQueue();
    }, 200);
    this.queueRefreshTimer.unref?.();
  }

  /**
   * Work out what actually happened to jobs we lost sight of.
   *
   * A dropped connection is the normal case, not an edge case: the box is
   * rented, the wifi moves, ComfyUI gets restarted to install a node. Whatever
   * the reason, this app is left believing several runs are still queued, and
   * neither the queue badge nor the gallery placeholders go away on their own —
   * they used to sit there forever.
   *
   * The queue and the history between them are the truth. Still queued: leave
   * it. Finished while we were away: take the images. Neither: it is gone, and
   * saying so is what makes the placeholder disappear.
   */
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    // A prompt submitted seconds ago may not be in the queue yet; cancelling it
    // here would be this bug in reverse.
    const unfinished = this.store.listUnfinished(SETTLE_MS);
    if (unfinished.length === 0) {
      /*
       * Something is outstanding, it is just too new to judge. Come back when it
       * is old enough rather than leaving it for the slow sweep — this is the
       * common case, because a connection usually drops seconds after a submit,
       * not minutes.
       */
      const youngest = this.store.listUnfinished()[0];
      if (youngest) this.scheduleSettledReconcile(youngest.createdAt);
      return;
    }

    const live = new Set<string>();
    for (const entry of [...this.queueState.running, ...this.queueState.pending]) {
      live.add(entry.promptId);
    }

    let history: Awaited<ReturnType<ComfyClient['history']>> = {};
    try {
      history = await this.client.history(200);
    } catch (error) {
      // Without the history we cannot tell "finished" from "gone", and guessing
      // would throw away images. Try again on the next reconnect.
      this.log.debug({ err: error }, 'Could not read the ComfyUI history');
      return;
    }

    if (this.stopped) return;

    for (const record of unfinished) {
      if (live.has(record.promptId)) continue;

      const entry = history[record.promptId];
      if (entry) {
        const images = collectHistoryImages(entry);
        if (images.length > 0) {
          for (const [nodeId, refs] of images) this.store.addImages(record.promptId, nodeId, refs);
        }
        const failed = entry.status?.status_str === 'error';
        this.store.setGenerationStatus(
          record.promptId,
          failed ? 'failed' : 'completed',
          failed ? 'ComfyUI reported an error while this app was disconnected.' : null,
        );
        this.log.info(`Recovered ${record.promptId} from the ComfyUI history`);
      } else {
        this.store.setGenerationStatus(
          record.promptId,
          'cancelled',
          'Lost when the connection to ComfyUI dropped.',
        );
      }

      this.emitGeneration(record.promptId);
      this.tracked.delete(record.promptId);
    }

    // The badge counts what ComfyUI says is waiting, which after all that is
    // whatever the refreshed queue holds.
    const remaining = this.queueState.running.length + this.queueState.pending.length;
    if (remaining !== this.state.queueRemaining) {
      this.state.queueRemaining = remaining;
      this.pushState(true);
    }
  }

  /** Come back to a job that was too new to judge, once it is old enough. */
  private scheduleSettledReconcile(createdAt: number): void {
    if (this.settleTimer || this.stopped) return;
    const wait = Math.max(1_000, createdAt + SETTLE_MS - Date.now() + 500);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.stopped) return;
      void this.refreshQueue().then(() => this.reconcile());
    }, wait);
    this.settleTimer.unref?.();
  }

  /**
   * Give up on the run in progress once the connection has been gone a while.
   *
   * Not immediately: a socket blip during a render is common and reconnects in
   * a second or two, and blanking the bar every time would be worse than the
   * bug. But a bar that says "sampling, 40% done" twenty seconds after the box
   * stopped existing is a lie.
   */
  private startOfflineCountdown(): void {
    if (this.offlineTimer) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.stopped || this.state.comfyOnline) return;

      const stale = this.store.listUnfinished();
      for (const record of stale) {
        this.store.setGenerationStatus(
          record.promptId,
          'cancelled',
          'ComfyUI became unreachable while this was queued.',
        );
        this.emitGeneration(record.promptId);
        this.tracked.delete(record.promptId);
      }
      if (stale.length > 0) {
        this.log.warn(`Gave up on ${stale.length} job(s) after losing ComfyUI`);
      }

      this.state.job = null;
      this.state.queueRemaining = 0;
      this.queueState = { running: [], pending: [] };
      this.stepTiming = null;
      this.nodeStartedAt = 0;
      this.hub.broadcast({ type: 'queue', data: this.queueState });
      this.pushState(true);
    }, OFFLINE_GRACE_MS);
    this.offlineTimer.unref?.();
  }

  async refreshQueue(): Promise<QueueState> {
    try {
      const queue = await this.client.queue();
      this.queueState = {
        running: (queue.queue_running ?? []).map((item) => this.toQueueEntry(item, true)),
        pending: (queue.queue_pending ?? []).map((item) => this.toQueueEntry(item, false)),
      };
      this.hub.broadcast({ type: 'queue', data: this.queueState });
    } catch (error) {
      this.log.debug({ err: error }, 'Could not refresh the ComfyUI queue');
    }
    return this.queueState;
  }

  private toQueueEntry(item: unknown, running: boolean): QueueEntry {
    const [number, promptId] = Array.isArray(item) ? item : [0, ''];
    const id = String(promptId ?? '');
    const tracked = this.tracked.get(id);
    // The stored record is needed for `createdAt` and, after a restart, for
    // everything — the in-memory map does not survive one, but the queue does.
    const record = this.store.getGenerationByPromptId(id);

    return {
      promptId: id,
      number: typeof number === 'number' ? number : 0,
      running,
      // Jobs queued from ComfyUI's own UI have no record here; label them so
      // it's obvious they didn't come from this app.
      title: tracked?.title ?? record?.title ?? 'Queued in ComfyUI',
      workflowName: tracked?.workflowName ?? record?.workflowName ?? '—',
      createdAt: record?.createdAt ?? null,
      params: tracked?.params ?? record?.params ?? [],
    };
  }

  /* ---------------------------------------------------------------- */
  /* State broadcasting                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Progress events arrive per sampler step — far faster than any phone needs
   * to repaint. Coalesce them, but push transitions (node changed, job
   * finished) immediately so the UI never feels laggy.
   */
  private pushState(immediate = false): void {
    if (immediate) {
      if (this.stateTimer) {
        clearTimeout(this.stateTimer);
        this.stateTimer = null;
      }
      this.stateDirty = false;
      this.hub.broadcast({ type: 'state', data: this.state });
      return;
    }

    this.stateDirty = true;
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (!this.stateDirty) return;
      this.stateDirty = false;
      this.hub.broadcast({ type: 'state', data: this.state });
    }, STATE_THROTTLE_MS);
    this.stateTimer.unref?.();
  }
}
