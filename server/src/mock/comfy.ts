import { randomUUID } from 'node:crypto';

import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type RouteHandlerMethod } from 'fastify';
import type { WebSocket } from 'ws';

import { BINARY_EVENT_PREVIEW_IMAGE, BINARY_IMAGE_TYPE_PNG, isNodeLink } from '@latent/shared';
import type { ApiWorkflow, ComfyImageRef, HistoryEntry } from '@latent/shared';
import { CHECKPOINTS, LORAS, objectInfoFixture, UPSCALE_MODELS } from '@latent/shared/fixtures';

import { renderPlaceholder } from './png.js';

/**
 * A stand-in for a real ComfyUI server.
 *
 * It implements the routes and the WebSocket event sequence that Latent depends
 * on, closely enough that the whole app — import, generate, live progress,
 * gallery, queue, uploads — can be exercised end to end without a GPU. It is a
 * development and test tool, never part of a production deployment.
 */

interface QueuedPrompt {
  promptId: string;
  number: number;
  clientId: string;
  workflow: ApiWorkflow;
}

export interface MockComfyOptions {
  /** Milliseconds per simulated sampler step. Lower is faster. */
  stepDelayMs?: number;
  /** Emit binary preview frames while sampling. */
  previews?: boolean;
  logLevel?: string;
  /**
   * Demand `Authorization: Bearer <token>` (or Basic `vastai:<token>`), the way
   * a vast.ai instance behind its Caddy proxy does. Exercises the whole
   * authenticated-connection path without renting a GPU.
   */
  requireToken?: string;
  /**
   * Longest side of a rendered output.
   *
   * Raised by tests that care what happens to a big picture — an upscaled
   * 4000×4000 is what makes a gallery grid unsurvivable, and the default here
   * is deliberately small enough that nothing needs shrinking.
   */
  outputSize?: number;
}

export interface MockComfy {
  app: FastifyInstance;
  listen(port: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

const OUTPUT_SIZE = 384;
const PREVIEW_SIZE = 96;

export function createMockComfy(options: MockComfyOptions = {}): MockComfy {
  const outputSize = options.outputSize ?? OUTPUT_SIZE;
  const stepDelayMs = options.stepDelayMs ?? 35;
  const previewsEnabled = options.previews ?? true;

  const app = Fastify({ logger: { level: options.logLevel ?? 'warn' } });
  const requiredToken = options.requireToken ?? null;

  /** Accepts either scheme vast.ai's proxy supports. */
  function tokenAccepted(header: string | undefined): boolean {
    if (!requiredToken) return true;
    if (!header) return false;

    if (header.startsWith('Bearer ')) return header.slice(7) === requiredToken;
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      return separator >= 0 && decoded.slice(separator + 1) === requiredToken;
    }
    return false;
  }

  const sockets = new Map<string, Set<WebSocket>>();
  const pending: QueuedPrompt[] = [];
  const history = new Map<string, HistoryEntry>();
  /** Images this mock has "produced" or had uploaded, keyed by `type/subfolder/filename`. */
  const files = new Map<string, Buffer>();

  let running: QueuedPrompt | null = null;
  let interrupted = false;
  let promptCounter = 0;
  let draining = false;

  /* ---------------------------------------------------------------- */
  /* WebSocket plumbing                                                */
  /* ---------------------------------------------------------------- */

  function send(clientId: string, type: string, data: unknown): void {
    const payload = JSON.stringify({ type, data });
    for (const socket of sockets.get(clientId) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  function sendBinary(clientId: string, image: Buffer): void {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(BINARY_EVENT_PREVIEW_IMAGE, 0);
    header.writeUInt32BE(BINARY_IMAGE_TYPE_PNG, 4);
    const frame = Buffer.concat([header, image]);
    for (const socket of sockets.get(clientId) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(frame, { binary: true });
    }
  }

  /** ComfyUI broadcasts queue depth to every client, not just the submitter. */
  function broadcastStatus(): void {
    const remaining = pending.length + (running ? 1 : 0);
    const payload = JSON.stringify({
      type: 'status',
      data: { status: { exec_info: { queue_remaining: remaining } } },
    });
    for (const set of sockets.values()) {
      for (const socket of set) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ---------------------------------------------------------------- */
  /* Execution simulation                                              */
  /* ---------------------------------------------------------------- */

  /** Rough topological order: a node runs after the nodes it links to. */
  function executionOrder(workflow: ApiWorkflow): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const visit = (nodeId: string, stack: Set<string>): void => {
      if (visited.has(nodeId) || stack.has(nodeId)) return;
      stack.add(nodeId);
      const node = workflow[nodeId];
      if (node) {
        for (const value of Object.values(node.inputs ?? {})) {
          if (isNodeLink(value)) visit(String(value[0]), stack);
        }
      }
      stack.delete(nodeId);
      visited.add(nodeId);
      order.push(nodeId);
    };

    for (const nodeId of Object.keys(workflow)) visit(nodeId, new Set());
    return order;
  }

  function seedOf(workflow: ApiWorkflow): string {
    const parts: string[] = [];
    for (const node of Object.values(workflow)) {
      for (const [name, value] of Object.entries(node.inputs ?? {})) {
        if ((name === 'seed' || name === 'noise_seed') && typeof value === 'number') {
          parts.push(String(value));
        }
        if ((name === 'text' || name === 'prompt') && typeof value === 'string') {
          parts.push(value);
        }
      }
    }
    return parts.join('|') || 'default';
  }

  async function execute(job: QueuedPrompt): Promise<void> {
    const { promptId, clientId, workflow } = job;
    const seed = seedOf(workflow);
    const order = executionOrder(workflow);
    const outputs: HistoryEntry['outputs'] = {};

    send(clientId, 'execution_start', { prompt_id: promptId, timestamp: Date.now() });
    send(clientId, 'execution_cached', { prompt_id: promptId, nodes: [], timestamp: Date.now() });

    for (const nodeId of order) {
      if (interrupted) break;
      const node = workflow[nodeId];
      if (!node) continue;

      send(clientId, 'executing', { prompt_id: promptId, node: nodeId });

      const steps = typeof node.inputs?.steps === 'number' ? node.inputs.steps : 0;
      if (steps > 0) {
        // A sampler: report per-step progress and stream previews, as ComfyUI does.
        for (let step = 1; step <= steps; step += 1) {
          if (interrupted) break;
          await sleep(stepDelayMs);
          send(clientId, 'progress', {
            prompt_id: promptId,
            node: nodeId,
            value: step,
            max: steps,
          });
          if (previewsEnabled && step % 2 === 0) {
            sendBinary(
              clientId,
              renderPlaceholder(PREVIEW_SIZE, PREVIEW_SIZE, seed, step / steps),
            );
          }
        }
      } else {
        await sleep(Math.min(stepDelayMs, 20));
      }

      if (interrupted) break;

      // Text previews are output nodes too, but they emit words, not pictures.
      const isTextNode = /^(PreviewAny|ShowText)/.test(node.class_type);
      const isOutput =
        !isTextNode &&
        (objectInfoFixture[node.class_type]?.output_node === true ||
          /^(SaveImage|PreviewImage)/.test(node.class_type));

      if (isOutput) {
        const batch = typeof findBatchSize(workflow) === 'number' ? findBatchSize(workflow) : 1;
        const size = findOutputSize(workflow);
        const images: ComfyImageRef[] = [];
        for (let i = 0; i < batch; i += 1) {
          /*
           * Numbered from *this* job, not the live counter. Reading the shared
           * counter here named two prompts of one batch identically, because
           * both were submitted before either finished executing — real ComfyUI
           * never repeats an output filename, and neither should the mock.
           */
          const filename = `Latent_${String(job.number).padStart(5, '0')}_${nodeId}_${i}.png`;
          files.set(
            `output//${filename}`,
            renderPlaceholder(size, size, `${seed}#${i}`),
          );
          images.push({ filename, subfolder: '', type: 'output' });
        }
        outputs[nodeId] = { images };
        send(clientId, 'executed', { prompt_id: promptId, node: nodeId, output: { images } });
      }

      /*
       * A "preview as text" node: an output with words in it and no pictures.
       * Real graphs use these to report what they decided, and a client that
       * only looks for images never sees them.
       */
      if (isTextNode) {
        // Reports on the *prompt*, the way a real preview node reports on
        // whatever it is wired to — this node has no settings of its own.
        const sampler = Object.values(workflow).find(
          (candidate) => typeof candidate.inputs?.steps === 'number',
        );
        const text = `seed=${seed} steps=${sampler?.inputs?.steps ?? 0}`;
        outputs[nodeId] = { text: [text] };
        send(clientId, 'executed', { prompt_id: promptId, node: nodeId, output: { text: [text] } });
      }
    }

    if (interrupted) {
      send(clientId, 'execution_interrupted', { prompt_id: promptId, node_id: null });
      history.set(promptId, {
        prompt: [0, promptId, workflow, {}, []],
        outputs,
        status: { status_str: 'error', completed: false, messages: [] },
      });
      return;
    }

    // End of prompt: ComfyUI sends `executing: null` and then execution_success.
    send(clientId, 'executing', { prompt_id: promptId, node: null });
    send(clientId, 'execution_success', { prompt_id: promptId, timestamp: Date.now() });
    /*
     * The graph that ran, the way ComfyUI records it: `[number, id, prompt,
     * extra_data, outputs_to_execute]`. Latent does not read it, but a test
     * asking what was actually submitted has nowhere else to look.
     */
    history.set(promptId, {
      prompt: [0, promptId, workflow, {}, []],
      outputs,
      status: { status_str: 'success', completed: true, messages: [] },
    });
  }

  function findBatchSize(workflow: ApiWorkflow): number {
    for (const node of Object.values(workflow)) {
      const value = node.inputs?.batch_size;
      if (typeof value === 'number' && value > 0) return Math.min(value, 8);
    }
    return 1;
  }

  /**
   * The size the graph asked for, when it asked for a bigger one.
   *
   * Real ComfyUI produces an output the size of its latent, and a test about
   * what happens to a *big* picture has no other way to ask for one — the
   * default here is deliberately small, because every pixel is drawn in
   * JavaScript and a suite full of megapixel renders is a slow suite. Only ever
   * upwards, so nothing that does not ask is affected. Capped, because a typo
   * in a workflow should not hang the mock.
   */
  function findOutputSize(workflow: ApiWorkflow): number {
    let largest = outputSize;
    for (const node of Object.values(workflow)) {
      for (const key of ['width', 'height'] as const) {
        const value = node.inputs?.[key];
        if (typeof value === 'number' && value > largest) largest = Math.min(value, 4096);
      }
    }
    return largest;
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        const job = pending.shift();
        if (!job) break;
        running = job;
        interrupted = false;
        broadcastStatus();
        await execute(job);
        running = null;
        broadcastStatus();
      }
    } finally {
      draining = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Routes (registered at both `/x` and `/api/x`, like recent ComfyUI) */
  /* ---------------------------------------------------------------- */

  function route(method: 'GET' | 'POST', path: string, handler: RouteHandlerMethod): void {
    app.route({ method, url: path, handler });
    app.route({ method, url: `/api${path}`, handler });
  }

  const registerRoutes = async (): Promise<void> => {
    await app.register(fastifyMultipart);
    await app.register(fastifyWebsocket);

    // The proxy in front of a real vast.ai instance guards every route,
    // WebSocket upgrade included.
    app.addHook('onRequest', async (request, reply) => {
      if (tokenAccepted(request.headers.authorization)) return;
      await reply.code(401).send({ error: 'unauthorized' });
    });

    app.get('/ws', { websocket: true }, (socket, request) => {
      const clientId = String((request.query as { clientId?: string }).clientId ?? randomUUID());
      let set = sockets.get(clientId);
      if (!set) {
        set = new Set();
        sockets.set(clientId, set);
      }
      set.add(socket);

      socket.send(JSON.stringify({ type: 'status', data: { sid: clientId } }));
      broadcastStatus();

      socket.on('close', () => {
        set?.delete(socket);
        if (set && set.size === 0) sockets.delete(clientId);
      });
    });

    route('GET', '/object_info', async () => objectInfoFixture);

    route('GET', '/models/:folder', async (request, reply) => {
      const { folder } = request.params as { folder: string };
      if (folder === 'loras') return LORAS;
      if (folder === 'checkpoints') return CHECKPOINTS;
      if (folder === 'upscale_models') return UPSCALE_MODELS;
      return reply.code(404).send({ error: 'unknown model folder' });
    });

    route('GET', '/object_info/:classType', async (request, reply) => {
      const { classType } = request.params as { classType: string };
      const def = objectInfoFixture[classType];
      if (!def) return reply.code(404).send({ error: 'Unknown node type' });
      return { [classType]: def };
    });

    /*
     * VRAM moves with the work, as it does on a real box: a model is resident
     * while a prompt runs and the memory comes back afterwards. A flat reading
     * would make the monitor look like it worked without ever proving it.
     */
    route('GET', '/system_stats', async () => {
      const busy = running !== null;
      return {
        system: {
          os: 'posix',
          comfyui_version: '0.3.27-mock',
          python_version: '3.11.0 (mock)',
          ram_total: 32 * 1024 ** 3,
          ram_free: (busy ? 12 : 18) * 1024 ** 3,
        },
        devices: [
          {
            name: 'Mock GPU (no hardware)',
            type: 'cuda',
            vram_total: 24 * 1024 ** 3,
            vram_free: (busy ? 9 : 20) * 1024 ** 3,
          },
        ],
      };
    });

    route('POST', '/prompt', async (request, reply) => {
      const body = request.body as {
        prompt?: ApiWorkflow;
        client_id?: string;
        extra_data?: unknown;
      };

      if (!body?.prompt || typeof body.prompt !== 'object') {
        return reply.code(400).send({ error: { message: 'No prompt provided' } });
      }

      // Mimic ComfyUI's validation error shape so error handling is exercised.
      for (const [nodeId, node] of Object.entries(body.prompt)) {
        if (!node?.class_type) {
          return reply.code(400).send({
            error: { type: 'invalid_prompt', message: 'Cannot execute because a node is missing a class_type.' },
            node_errors: {
              [nodeId]: { errors: [{ message: 'Missing class_type', details: '' }] },
            },
          });
        }
        if (!objectInfoFixture[node.class_type]) {
          return reply.code(400).send({
            error: { type: 'invalid_prompt', message: 'Prompt has an unknown node type.' },
            node_errors: {
              [nodeId]: {
                errors: [
                  { message: `Node type not found: ${node.class_type}`, details: 'Install the custom node.' },
                ],
              },
            },
          });
        }
      }

      promptCounter += 1;
      const promptId = randomUUID();
      pending.push({
        promptId,
        number: promptCounter,
        clientId: body.client_id ?? 'anonymous',
        workflow: body.prompt,
      });

      broadcastStatus();
      void drain();

      return { prompt_id: promptId, number: promptCounter, node_errors: {} };
    });

    route('GET', '/queue', async () => ({
      queue_running: running ? [[running.number, running.promptId, running.workflow, {}, []]] : [],
      queue_pending: pending.map((job) => [job.number, job.promptId, job.workflow, {}, []]),
    }));

    route('POST', '/queue', async (request, reply) => {
      const body = (request.body ?? {}) as { clear?: boolean; delete?: string[] };
      if (body.clear) {
        pending.length = 0;
      } else if (Array.isArray(body.delete)) {
        for (const promptId of body.delete) {
          const index = pending.findIndex((job) => job.promptId === promptId);
          if (index >= 0) pending.splice(index, 1);
        }
      }
      broadcastStatus();
      return reply.code(200).send({});
    });

    route('POST', '/interrupt', async (_request, reply) => {
      if (running) interrupted = true;
      return reply.code(200).send({});
    });

    route('GET', '/history', async (request) => {
      const { max_items: maxItems } = request.query as { max_items?: string };
      const limit = Number(maxItems ?? 64);
      const entries = [...history.entries()].slice(-(Number.isFinite(limit) ? limit : 64));
      return Object.fromEntries(entries);
    });

    route('GET', '/history/:promptId', async (request) => {
      const { promptId } = request.params as { promptId: string };
      const entry = history.get(promptId);
      return entry ? { [promptId]: entry } : {};
    });

    route('GET', '/view', async (request, reply) => {
      const query = request.query as {
        filename?: string;
        subfolder?: string;
        type?: string;
        preview?: string;
      };
      if (!query.filename) return reply.code(400).send({ error: 'filename is required' });

      const key = `${query.type ?? 'output'}/${query.subfolder ?? ''}/${query.filename}`;
      const stored = files.get(key);
      if (!stored) return reply.code(404).send({ error: 'not found' });

      /*
       * `preview` re-encodes and does *not* resize — read the real thing:
       * ComfyUI opens the file, saves it as webp or jpeg at the given quality,
       * and every pixel stays where it was. This mock used to answer with a
       * 128×128 image, which quietly made the whole gallery look correct while
       * the real one was shipping full-size pictures to a phone.
       *
       * Real ComfyUI hands back webp; this hands back the same PNG, because
       * what matters downstream is the dimensions and there is no webp encoder
       * here to be honest with.
       */
      return reply.header('content-type', 'image/png').send(stored);
    });

    route('POST', '/upload/image', async (request, reply) => {
      const file = await (request as unknown as { file: () => Promise<{ filename: string; toBuffer(): Promise<Buffer> } | undefined> }).file();
      if (!file) return reply.code(400).send({ error: 'no image supplied' });

      const buffer = await file.toBuffer();
      const name = file.filename || `upload_${Date.now()}.png`;
      files.set(`input//${name}`, buffer);
      return { name, subfolder: '', type: 'input' };
    });
  };

  const ready = registerRoutes();

  return {
    app,
    async listen(port: number, host = '127.0.0.1') {
      await ready;
      return app.listen({ port, host });
    },
    async close() {
      await app.close();
    },
  };
}
