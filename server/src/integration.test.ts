import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type {
  ChatMessage,
  ChatStreamEvent,
  ChatToolCall,
  GalleryPage,
  GenerateResponse,
  GenerationRecord,
  ImportResult,
  ImportScanResult,
  ImportBrowseResult,
  InputScanResult,
  MonitorSnapshot,
  QueueEntry,
  QueueState,
  ServerEvent,
  StatusResponse,
  StudyDetail,
  StudyPreview,
  StudyShot,
  StudyShotImage,
  StudyStats,
  SystemPrompt,
  WorkflowDetail,
  WorkflowScanResult,
} from '@latent/shared';
import {
  sd15Txt2Img,
  sd15Txt2ImgUi,
  uiFormatWorkflow,
  withTextPreview,
} from '@latent/shared/fixtures';

import Database from 'better-sqlite3';

import { buildApp } from './app.js';
import { Store } from './db.js';
import { Vault } from './vault.js';
import { createMockComfy } from './mock/comfy.js';
import { createMockLlama } from './mock/llama.js';
import { renderPlaceholder } from './mock/png.js';
import { withPngText } from './images/png.js';

/**
 * End-to-end coverage of the server against the mock ComfyUI: import a
 * workflow, generate, watch the live events, and find the result in the
 * gallery. This is the closest thing to a real run that works without a GPU.
 */

let mock: ReturnType<typeof createMockComfy>;
let built: Awaited<ReturnType<typeof buildApp>>;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let baseUrl: string;
let dataDir: string;

/** Session cookie obtained by claiming the test server during setup. */
let cookie = '';

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(init?.headers ?? {}),
    },
  });

/** `Response.json()` is `unknown`; tests know the shape they asked for. */
const json = async <T>(response: Response | Promise<Response>): Promise<T> =>
  (await (await response).json()) as T;

/**
 * Poll until `check` yields a value. The check may be async — it is awaited
 * each round, so a promise is never mistaken for a truthy result.
 */
async function waitFor<T>(
  check: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  // Slow enough that the server's 100ms progress coalescing actually emits
  // intermediate frames, fast enough to keep the suite quick.
  mock = createMockComfy({ stepDelayMs: 15, logLevel: 'silent' });
  const mockAddress = await mock.listen(0);

  dataDir = mkdtempSync(join(tmpdir(), 'latent-test-'));

  built = await buildApp({
    comfyUrl: mockAddress,
    dbPath: join(dataDir, 'test.db'),
    dataDir,
    webDir: join(dataDir, 'no-web'),
    password: null,
    logLevel: 'silent',
  });
  app = built.app;

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind a port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Auth is mandatory now: claim the fresh server before anything else works.
  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  });
  if (!setup.ok) throw new Error(`Setup failed: ${setup.status}`);
  cookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';

  // The upstream socket connects asynchronously at boot.
  await waitFor(
    async () => (await json<StatusResponse>(api('/api/status'))).comfyOnline || null,
    10_000,
  );
}, 30_000);

afterAll(async () => {
  await app?.close();
  await mock?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('status', () => {
  it('reports a reachable ComfyUI with its devices', async () => {
    const status = (await (await api('/api/status')).json()) as StatusResponse;
    expect(status.comfyOnline).toBe(true);
    expect(status.comfyVersion).toContain('mock');
    expect(status.authRequired).toBe(true);
    expect(status.setupRequired).toBe(false);
    expect(status.activeConnectionName).toBe('Default');
    expect(status.devices[0]?.vramTotal).toBeGreaterThan(0);
  });
});

describe('workflow import', () => {
  /**
   * The file ComfyUI saves by itself, rather than an "Export (API)".
   *
   * That is what is sitting in `user/default/workflows`, so it is what an
   * import has to accept — the alternative was asking the user to re-export
   * every workflow they already had.
   */
  it('converts a workflow saved in the editor format', async () => {
    const response = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Editor format', graph: sd15Txt2ImgUi }),
    });
    expect(response.status).toBe(201);

    const detail = await json<WorkflowDetail>(response);
    expect(detail.graph['3']?.class_type).toBe('KSampler');
    // Positional widget values walked against /object_info, with the seed's
    // "after generate" control skipped.
    expect(detail.graph['3']?.inputs.steps).toBe(20);
    expect(detail.graph['3']?.inputs.cfg).toBe(8);
    expect(detail.graph['3']?.inputs.sampler_name).toBe('euler');
    expect(detail.graph['3']?.inputs.model).toEqual(['4', 0]);
  });

  it('rejects an editor-format graph that produces no image', async () => {
    const response = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'No output', graph: uiFormatWorkflow }),
    });
    expect(response.status).toBe(400);
    expect((await json<{ error: string }>(response)).error).toMatch(/output node/);
  });

  it('rejects an unnamed workflow', async () => {
    const response = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '  ', graph: sd15Txt2Img }),
    });
    expect(response.status).toBe(400);
  });

  it('imports an API workflow and builds a form from the live object_info', async () => {
    const response = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'SD1.5 txt2img', graph: sd15Txt2Img }),
    });
    expect(response.status).toBe(201);

    const detail = (await response.json()) as WorkflowDetail;
    expect(detail.name).toBe('SD1.5 txt2img');

    const prompt = detail.schema.fields.find((f) => f.role === 'prompt');
    expect(prompt?.id).toBe('6.text');

    // Option lists must come from the server we are actually talking to.
    const checkpoint = detail.schema.fields.find((f) => f.role === 'model');
    expect(checkpoint?.options).toContain('sd_xl_base_1.0.safetensors');
  });

  it('persists form overrides across reads', async () => {
    const list = (await (await api('/api/workflows')).json()) as { id: string }[];
    const id = list[0]?.id as string;

    await api(`/api/workflows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ overrides: { '9.filename_prefix': { label: 'File name', group: 'main' } } }),
    });

    const detail = (await (await api(`/api/workflows/${id}`)).json()) as WorkflowDetail;
    const field = detail.schema.fields.find((f) => f.id === '9.filename_prefix');
    expect(field?.label).toBe('File name');
    expect(field?.group).toBe('main');
  });
});

describe('generation', () => {
  let workflowId: string;
  let socket: WebSocket;
  const events: ServerEvent[] = [];
  let previewFrames = 0;

  beforeAll(async () => {
    const list = (await (await api('/api/workflows')).json()) as { id: string }[];
    workflowId = list[0]?.id as string;

    socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/ws`, { headers: { cookie } });
    socket.binaryType = 'nodebuffer';
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        previewFrames += 1;
        return;
      }
      events.push(JSON.parse(String(data)) as ServerEvent);
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
  });

  afterAll(() => socket?.close());

  it('sends a snapshot immediately on connect, so a reconnecting phone is correct at once', () => {
    const snapshot = events.find((event) => event.type === 'snapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot?.data).toHaveProperty('comfyOnline');
  });

  it('runs a prompt through to a stored, image-bearing result', async () => {
    const response = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        workflowId,
        values: { '6.text': 'a lighthouse in a storm', '3.steps': 20 },
        randomizeSeeds: true,
      }),
    });
    expect(response.status).toBe(202);

    const { generationIds } = (await response.json()) as { generationIds: string[] };
    const generationId = generationIds[0] as string;
    expect(generationId).toBeTruthy();

    const completed = await waitFor(() =>
      events
        .filter((event): event is Extract<ServerEvent, { type: 'generation' }> => event.type === 'generation')
        .find((event) => event.data.id === generationId && event.data.status === 'completed'),
    );

    expect(completed.data.title).toBe('a lighthouse in a storm');
    expect(completed.data.images.length).toBeGreaterThan(0);
    expect(completed.data.error).toBeNull();

    // The seed that was actually submitted is recorded, not the one in the form.
    expect(Object.keys(completed.data.seeds)).toContain('3.seed');
  });

  it('reports live progress while the sampler runs', () => {
    const stateEvents = events.filter(
      (event): event is Extract<ServerEvent, { type: 'state' }> => event.type === 'state',
    );
    const withJob = stateEvents.filter((event) => event.data.job !== null);
    expect(withJob.length).toBeGreaterThan(0);
    expect(withJob.some((event) => (event.data.job?.progress ?? 0) > 0)).toBe(true);
    expect(withJob.some((event) => event.data.job?.nodeTitle !== null)).toBe(true);
  });

  /**
   * Regression: ComfyUI can emit `execution_start` before the /prompt response
   * reaches us, so the running job was briefly created with no title and the UI
   * showed "Untitled" for the whole run.
   */
  it('labels the running job with its prompt, even when execution starts first', () => {
    const titles = events
      .filter((event): event is Extract<ServerEvent, { type: 'state' }> => event.type === 'state')
      .map((event) => event.data.job?.title)
      .filter((title): title is string => Boolean(title));

    expect(titles.length).toBeGreaterThan(0);
    expect(titles).toContain('a lighthouse in a storm');
    expect(titles).not.toContain('Untitled');
  });

  it('relays binary preview frames to the browser', () => {
    expect(previewFrames).toBeGreaterThan(0);
  });

  it('lists the result in the gallery and serves its image bytes', async () => {
    const page = (await (await api('/api/gallery')).json()) as GalleryPage;
    expect(page.items.length).toBeGreaterThan(0);

    const record = page.items[0] as GenerationRecord;
    const image = record.images[0];
    expect(image).toBeDefined();

    const params = new URLSearchParams({
      filename: image!.filename,
      subfolder: image!.subfolder,
      type: image!.type,
    });
    const view = await api(`/api/view?${params}`);
    expect(view.status).toBe(200);
    expect(view.headers.get('content-type')).toBe('image/png');

    const bytes = Buffer.from(await view.arrayBuffer());
    // PNG magic number — proves real image data reached the client.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('copies a result back into ComfyUI inputs for img2img and upscale', async () => {
    const page = (await (await api('/api/gallery')).json()) as GalleryPage;
    const image = page.items[0]?.images[0];
    expect(image).toBeDefined();

    const response = await api('/api/images/to-input', {
      method: 'POST',
      body: JSON.stringify(image),
    });
    expect(response.status).toBe(200);

    const uploaded = (await response.json()) as { name: string; type: string };
    expect(uploaded.type).toBe('input');
    expect(uploaded.name).toContain('latent_');
  });

  it('surfaces ComfyUI validation errors instead of a bare failure', async () => {
    const broken = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Broken',
        graph: { '1': { class_type: 'NodeThatDoesNotExist', inputs: { foo: 1 } } },
      }),
    });
    const brokenId = ((await broken.json()) as WorkflowDetail).id;

    const response = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ workflowId: brokenId, values: {} }),
    });
    expect(response.status).toBe(502);
    expect((await json<{ error: string }>(response)).error).toMatch(/NodeThatDoesNotExist/);
  });

  it('rejects a path traversal attempt on the image proxy', async () => {
    const response = await api('/api/view?filename=../../etc/passwd');
    expect(response.status).toBe(400);
  });

  it('404s a missing workflow rather than 500ing', async () => {
    const response = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'does-not-exist', values: {} }),
    });
    expect(response.status).toBe(404);
  });
});

describe('queue', () => {
  it('reports queued jobs and clears them', async () => {
    const list = (await (await api('/api/workflows')).json()) as { id: string; name: string }[];
    const workflow = list.find((w) => w.name === 'SD1.5 txt2img');

    await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow?.id,
        values: { '6.text': 'queue test', '3.steps': 40 },
        batchCount: 3,
      }),
    });

    const queue = await waitFor(async () => {
      const state = (await (await api('/api/queue')).json()) as QueueState;
      return state.running.length + state.pending.length > 1 ? state : null;
    });
    expect(queue.running.length + queue.pending.length).toBeGreaterThan(1);
    expect([...queue.running, ...queue.pending][0]?.title).toBe('queue test');

    await api('/api/queue', { method: 'DELETE' });
    await api('/api/queue/interrupt', { method: 'POST' });

    const drained = await waitFor(async () => {
      const state = (await (await api('/api/queue')).json()) as QueueState;
      return state.running.length + state.pending.length === 0 ? state : null;
    });
    expect(drained.pending).toHaveLength(0);
  }, 30_000);

  /**
   * The queue exists to let you cancel the *right* job. Three items sharing one
   * prompt are indistinguishable without their values, and picking wrongly is
   * the failure this guards against.
   */
  it('carries each job\'s settings, so one of several can be picked out and removed', async () => {
    const list = await json<{ id: string; name: string }[]>(api('/api/workflows'));
    const workflow = list.find((w) => w.name === 'SD1.5 txt2img');

    await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow?.id,
        values: { '6.text': 'identical prompt', '3.steps': 40, '3.cfg': 9.5 },
        batchCount: 3,
        randomizeSeeds: true,
      }),
    });

    const queue = await waitFor(async () => {
      const state = await json<QueueState>(api('/api/queue'));
      return state.pending.length >= 2 ? state : null;
    });

    const entry = queue.pending[0] as QueueEntry;
    expect(entry.params.length).toBeGreaterThan(0);

    const summary = new Map(entry.params.map((item) => [item.label, item.value]));
    expect(summary.get('Steps')).toBe('40');
    expect(summary.get('CFG')).toBe('9.5');
    // The prompt is the entry's title; repeating it as a parameter would be noise.
    expect(entry.params.some((item) => item.value.includes('identical prompt'))).toBe(false);

    // Enough of it is promoted to fit a summary line, and not all of it.
    const promoted = entry.params.filter((item) => item.primary);
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.length).toBeLessThanOrEqual(entry.params.length);

    // Each item in a batch gets its own seed, which is often the only thing
    // telling two queued jobs apart — so it has to be in the summary.
    const seeds = queue.pending.map(
      (item) => item.params.find((param) => param.label === 'Seed')?.value,
    );
    expect(new Set(seeds).size).toBe(seeds.length);

    // And removing that one specific job leaves the others alone.
    const before = queue.pending.length;
    const removed = await api(`/api/queue/${entry.promptId}`, { method: 'DELETE' });
    expect(removed.status).toBeLessThan(300);

    const after = await waitFor(async () => {
      const state = await json<QueueState>(api('/api/queue'));
      return state.pending.every((item) => item.promptId !== entry.promptId) ? state : null;
    });
    expect(after.pending.length).toBe(before - 1);

    await api('/api/queue', { method: 'DELETE' });
    await api('/api/queue/interrupt', { method: 'POST' });
    await waitFor(async () => {
      const state = await json<QueueState>(api('/api/queue'));
      return state.running.length + state.pending.length === 0 ? state : null;
    });
  }, 30_000);

  /**
   * Cancelling used to leave a "cancelled" tombstone in the gallery, so clearing
   * a queue of eight put eight dead cards at the top of your pictures.
   */
  it('leaves no gallery entry behind for a run that was cancelled before it made anything', async () => {
    const list = await json<{ id: string; name: string }[]>(api('/api/workflows'));
    const workflow = list.find((w) => w.name === 'SD1.5 txt2img');

    await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow?.id,
        values: { '6.text': 'never to be seen', '3.steps': 40 },
        batchCount: 3,
      }),
    });

    await waitFor(async () => {
      const state = await json<QueueState>(api('/api/queue'));
      return state.pending.length >= 2 ? state : null;
    });

    await api('/api/queue', { method: 'DELETE' });
    await api('/api/queue/interrupt', { method: 'POST' });

    // The rows are marked cancelled in the database — the runs did happen, and
    // the record of them is deliberately kept…
    const cancelled = await waitFor(() => {
      const db = new Database(join(dataDir, 'test.db'), { readonly: true });
      try {
        const rows = db
          .prepare("SELECT status FROM generations WHERE title = 'never to be seen'")
          .all() as { status: string }[];
        return rows.length > 0 && rows.every((row) => row.status === 'cancelled') ? rows : null;
      } finally {
        db.close();
      }
    });
    expect(cancelled.length).toBeGreaterThan(0);

    // …and none of them shows up as a picture.
    const page = await json<GalleryPage>(api('/api/gallery?limit=100'));
    const titles = page.items.map((item) => item.title);
    expect(titles).not.toContain('never to be seen');
    expect(page.items.some((item) => item.status === 'cancelled')).toBe(false);
  }, 30_000);
});

describe('generation statistics', () => {
  /**
   * The ETA has to come from the server: it is where the progress events land,
   * so every client agrees and a phone that reconnects mid-run gets the real
   * numbers instead of starting its own stopwatch from zero.
   */
  it('measures per-step timing and an ETA while the sampler runs', async () => {
    const list = await json<{ id: string; name: string }[]>(api('/api/workflows'));
    const workflow = list.find((w) => w.name === 'SD1.5 txt2img');

    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/ws`, { headers: { cookie } });
    const states: Extract<ServerEvent, { type: 'state' | 'snapshot' }>[] = [];
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(String(data)) as ServerEvent;
      if (event.type === 'state' || event.type === 'snapshot') states.push(event);
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    try {
      await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow?.id,
          // Enough steps that the mock's 15ms delay adds up to a measurable rate.
          values: { '6.text': 'stats please', '3.steps': 30 },
        }),
      });

      const timed = await waitFor(() =>
        states.find(
          (event) =>
            event.data.job?.title === 'stats please' &&
            event.data.job.stats.msPerStep !== null &&
            event.data.job.stats.etaMs !== null,
        ),
      );

      const stats = timed.data.job!.stats;
      expect(stats.msPerStep).toBeGreaterThan(0);
      expect(stats.etaMs).toBeGreaterThanOrEqual(0);
      expect(stats.stepsRemaining).toBeGreaterThan(0);
      expect(stats.elapsedMs).toBeGreaterThan(0);
      // The graph is counted too, so the panel can say where in it we are.
      expect(stats.nodesTotal).toBeGreaterThan(0);

      /*
       * The ETA must be the remaining steps at the measured rate. Checked as a
       * loose band, not an equality: it is derived from wall-clock timings on a
       * shared CI box, and pinning it exactly would only ever produce a flaky
       * test that says nothing about correctness.
       */
      const expected = stats.stepsRemaining * (stats.msPerStep as number);
      expect(stats.etaMs).toBeLessThanOrEqual(expected + 1);

      // And a finished run leaves a yardstick for the next one.
      await waitFor(() => states.find((event) => event.data.job === null && states.length > 3));
      await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow?.id,
          values: { '6.text': 'stats again', '3.steps': 10 },
        }),
      });
      const second = await waitFor(() =>
        states.find(
          (event) => event.data.job?.title === 'stats again' && event.data.job.stats.lastRunMs !== null,
        ),
      );
      expect(second.data.job!.stats.lastRunMs).toBeGreaterThan(0);
    } finally {
      socket.close();
      await api('/api/queue', { method: 'DELETE' });
      await api('/api/queue/interrupt', { method: 'POST' });
    }
  }, 40_000);
});

describe('recovering from a ComfyUI restart', () => {
  /**
   * Regression: the live `comfyOnline` flag comes from the upstream event
   * socket. If that socket is mid-backoff, the app used to show ComfyUI as
   * offline — and disable the Generate button — long after ComfyUI was back.
   */
  it('comes back online without waiting out the reconnect backoff', async () => {
    // Claim a port, then free it, so the server starts with nothing to talk to.
    const probe = createMockComfy({ logLevel: 'silent' });
    const probeAddress = await probe.listen(0);
    const port = Number(new URL(probeAddress).port);
    await probe.close();

    const dir = mkdtempSync(join(tmpdir(), 'latent-restart-'));
    const built = await buildApp({
      comfyUrl: `http://127.0.0.1:${port}`,
      dbPath: join(dir, 'restart.db'),
      dataDir: dir,
      webDir: join(dir, 'no-web'),
      password: null,
      logLevel: 'silent',
    });

    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const address = built.app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const claim = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'restart-password' }),
    });
    const restartCookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';
    const status = () =>
      fetch(`${url}/api/status`, { headers: { cookie: restartCookie } }).then(
        (r) => r.json() as Promise<StatusResponse>,
      );

    let late: ReturnType<typeof createMockComfy> | null = null;
    try {
      // Nothing is listening yet.
      expect((await status()).comfyOnline).toBe(false);

      // Let the socket fail a few times so it is genuinely in backoff.
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      late = createMockComfy({ logLevel: 'silent' });
      await late.listen(port);

      // Polling status is what a phone does on wake; it must pull the socket
      // back up rather than leaving the UI stale.
      const online = await waitFor(async () => {
        const current = await status();
        return current.comfyOnline ? current : null;
      }, 10_000);
      expect(online.comfyOnline).toBe(true);

      // And the live state — what the UI actually renders — must agree.
      const socket = new WebSocket(`${url.replace('http', 'ws')}/api/ws`, {
        headers: { cookie: restartCookie },
      });
      const snapshot = await new Promise<{ data: { comfyOnline: boolean } }>((resolve, reject) => {
        socket.once('message', (data) => resolve(JSON.parse(String(data))));
        socket.once('error', reject);
      });
      expect(snapshot.data.comfyOnline).toBe(true);
      socket.close();
    } finally {
      await built.app.close();
      await late?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});


/** Boot an isolated server for tests that need their own auth or connection state. */
async function bootIsolated(overrides: Parameters<typeof buildApp>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'latent-iso-'));
  const built = await buildApp({
    comfyUrl: 'http://127.0.0.1:1',
    dbPath: join(dir, 'iso.db'),
    dataDir: dir,
    // Each isolated server gets its own archive. Sharing one would let two
    // different master keys write to the same content-addressed path.
    archiveDir: join(dir, 'archive'),
    webDir: join(dir, 'no-web'),
    password: null,
    logLevel: 'silent',
    ...overrides,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const { cookie: sessionCookie, ...rest } = init;
    return fetch(`${url}${path}`, {
      ...rest,
      headers: {
        ...(rest.body ? { 'content-type': 'application/json' } : {}),
        ...(sessionCookie ? { cookie: sessionCookie } : {}),
        ...(rest.headers ?? {}),
      },
    });
  };

  return {
    url,
    call,
    async dispose() {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('first-run setup', () => {
  it('locks everything until someone claims the server, then lets only them back in', async () => {
    const server = await bootIsolated();
    try {
      // Before setup, status is the one thing that answers — the client needs
      // it to know whether to render the setup screen or the login screen.
      const initial = (await (await server.call('/api/status')).json()) as StatusResponse;
      expect(initial.setupRequired).toBe(true);
      expect(initial.authRequired).toBe(true);
      expect(initial.authenticated).toBe(false);
      expect(initial.comfyUrl).toBe('');

      expect((await server.call('/api/workflows')).status).toBe(401);
      expect((await server.call('/api/gallery')).status).toBe(401);

      // Logging in is meaningless before a password exists.
      const earlyLogin = await server.call('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'anything' }),
      });
      expect(earlyLogin.status).toBe(409);

      // Too short is rejected rather than silently accepted.
      const weak = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'abc' }),
      });
      expect(weak.status).toBe(409);

      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });
      expect(claim.status).toBe(200);
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect(cookie).toContain('latent_session');

      // The claim window is one-shot: a second person cannot take the server.
      const secondClaim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'my password now' }),
      });
      expect(secondClaim.status).toBe(409);

      // The claimer is logged in; everyone else still is not.
      expect((await server.call('/api/workflows', { cookie })).status).toBe(200);
      expect((await server.call('/api/workflows')).status).toBe(401);

      const badLogin = await server.call('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'wrong' }),
      });
      expect(badLogin.status).toBe(401);

      const login = await server.call('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });
      expect(login.status).toBe(200);
    } finally {
      await server.dispose();
    }
  }, 30_000);

  it('skips the claim window entirely when LATENT_PASSWORD is set', async () => {
    const server = await bootIsolated({ password: 'from-the-environment' });
    try {
      const status = (await (await server.call('/api/status')).json()) as StatusResponse;
      expect(status.setupRequired).toBe(false);

      const login = await server.call('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'from-the-environment' }),
      });
      expect(login.status).toBe(200);
    } finally {
      await server.dispose();
    }
  }, 30_000);

  it('refuses an unauthenticated websocket upgrade', async () => {
    const server = await bootIsolated();
    try {
      await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'socket test' }),
      });

      // The auth hook rejects during the HTTP handshake, so it never becomes a
      // WebSocket at all — the client sees a 401, not a close frame.
      const socket = new WebSocket(`${server.url.replace('http', 'ws')}/api/ws`);
      const failure = await new Promise<Error>((resolve, reject) => {
        socket.once('error', resolve);
        socket.once('open', () => reject(new Error('socket opened without authentication')));
        setTimeout(() => reject(new Error('socket neither opened nor failed')), 5_000);
      });
      expect(failure.message).toContain('401');
    } finally {
      await server.dispose();
    }
  }, 30_000);
});

describe('authenticated remote connections (the vast.ai path)', () => {
  it('diagnoses a wrong token, then connects once it is right', async () => {
    // A mock that behaves like vast.ai's proxy: every route needs the token.
    const guarded = createMockComfy({ requireToken: 'web-password-123', logLevel: 'silent' });
    const guardedUrl = await guarded.listen(0);
    const server = await bootIsolated();

    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'connection test' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      // No credentials at all: reaching it is not the same as being allowed in.
      const anonymous = await server.call('/api/connections/test', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ name: 'vast', url: guardedUrl, authMode: 'none' }),
      });
      expect(((await anonymous.json()) as { outcome: string }).outcome).toBe('unauthorized');

      // Wrong token: same diagnosis, and the message names WEB_PASSWORD so the
      // user knows where to look on the vast.ai side.
      const wrong = await server.call('/api/connections/test', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'vast',
          url: guardedUrl,
          authMode: 'bearer',
          secret: 'not-the-token',
        }),
      });
      const wrongResult = (await wrong.json()) as { outcome: string; message: string };
      expect(wrongResult.outcome).toBe('unauthorized');
      expect(wrongResult.message).toMatch(/WEB_PASSWORD/);

      // Right token, bearer scheme.
      const good = await server.call('/api/connections/test', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'vast',
          url: guardedUrl,
          authMode: 'bearer',
          secret: 'web-password-123',
        }),
      });
      const goodResult = (await good.json()) as { outcome: string; comfyVersion: string };
      expect(goodResult.outcome).toBe('ok');
      expect(goodResult.comfyVersion).toContain('mock');

      // Basic auth as `vastai:<token>` is the other scheme the proxy accepts.
      const basic = await server.call('/api/connections/test', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'vast',
          url: guardedUrl,
          authMode: 'basic',
          username: 'vastai',
          secret: 'web-password-123',
        }),
      });
      expect(((await basic.json()) as { outcome: string }).outcome).toBe('ok');

      // A dead address is reported as unreachable, not as an auth problem.
      const dead = await server.call('/api/connections/test', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ name: 'nope', url: 'http://127.0.0.1:1', authMode: 'none' }),
      });
      expect(((await dead.json()) as { outcome: string }).outcome).toBe('unreachable');
    } finally {
      await server.dispose();
      await guarded.close();
    }
  }, 30_000);

  it('switches a running server to a different ComfyUI without a restart', async () => {
    const guarded = createMockComfy({ requireToken: 'token-a', logLevel: 'silent' });
    const guardedUrl = await guarded.listen(0);
    const server = await bootIsolated();

    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'switching test' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      // Boot seeded a "Default" connection from COMFY_URL, which points nowhere.
      const seeded = (await (
        await server.call('/api/connections', { cookie })
      ).json()) as { id: string; name: string; isActive: boolean }[];
      expect(seeded).toHaveLength(1);
      expect(seeded[0]?.name).toBe('Default');
      expect(seeded[0]?.isActive).toBe(true);

      const created = await server.call('/api/connections', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          name: 'Rented GPU',
          url: guardedUrl,
          authMode: 'bearer',
          secret: 'token-a',
        }),
      });
      expect(created.status).toBe(201);
      const connection = (await created.json()) as { id: string; hasSecret: boolean };

      // The token must never come back out of the API.
      expect(connection.hasSecret).toBe(true);
      expect(JSON.stringify(connection)).not.toContain('token-a');

      await server.call(`/api/connections/${connection.id}/activate`, { method: 'POST', cookie });

      const online = await waitFor(async () => {
        const status = (await (
          await server.call('/api/status', { cookie })
        ).json()) as StatusResponse;
        return status.comfyOnline ? status : null;
      }, 10_000);

      expect(online.activeConnectionName).toBe('Rented GPU');
      expect(online.comfyVersion).toContain('mock');

      // The active connection cannot be deleted out from under the app.
      const deleteActive = await server.call(`/api/connections/${connection.id}`, {
        method: 'DELETE',
        cookie,
      });
      expect(deleteActive.status).toBe(409);
    } finally {
      await server.dispose();
      await guarded.close();
    }
  }, 30_000);
});

describe('ratings survive the instance being destroyed', () => {
  /**
   * The reason the archive exists. A rented vast.ai box is deleted when you are
   * done with it, taking its output directory — and every image you liked — with
   * it. Rating an image copies the bytes onto the machine running Latent.
   *
   * This test reproduces exactly that: rate an image, then shut ComfyUI down
   * entirely and confirm the gallery still works.
   */
  it('keeps serving a rated image after ComfyUI is gone', async () => {
    const ephemeral = createMockComfy({ stepDelayMs: 2, logLevel: 'silent' });
    const ephemeralUrl = await ephemeral.listen(0);
    const server = await bootIsolated({ comfyUrl: ephemeralUrl });
    let closed = false;

    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'archive test' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      await waitFor(async () => {
        const status = (await (
          await server.call('/api/status', { cookie })
        ).json()) as StatusResponse;
        return status.comfyOnline || null;
      }, 10_000);

      const workflow = (await (
        await server.call('/api/workflows', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ name: 'archive', graph: sd15Txt2Img }),
        })
      ).json()) as WorkflowDetail;

      await server.call('/api/generate', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          workflowId: workflow.id,
          values: { '6.text': 'a keeper', '3.steps': 4 },
        }),
      });

      const finished = await waitFor(async () => {
        const page = (await (
          await server.call('/api/gallery', { cookie })
        ).json()) as GalleryPage;
        const record = page.items[0];
        return record && record.status === 'completed' && record.images.length > 0 ? record : null;
      }, 20_000);

      const image = finished.images[0] as GenerationRecord['images'][number];
      expect(image.rating).toBe(0);
      expect(image.archived).toBe(false);

      // Rate it — which is what triggers the local copy.
      const rated = (await (
        await server.call(`/api/gallery/${finished.id}/rating`, {
          method: 'PUT',
          cookie,
          body: JSON.stringify({ image, rating: 5 }),
        })
      ).json()) as GenerationRecord;

      expect(rated.images[0]?.rating).toBe(5);
      expect(rated.images[0]?.archived).toBe(true);

      // Now destroy the instance, exactly as ending a vast.ai rental would.
      await ephemeral.close();
      closed = true;

      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
      });
      const view = await server.call(`/api/view?${params}`, { cookie });

      expect(view.status).toBe(200);
      expect(view.headers.get('x-latent-source')).toBe('archive');

      const bytes = Buffer.from(await view.arrayBuffer());
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      // And it is still listed, including under the rated-only filter.
      const ratedOnly = (await (
        await server.call('/api/gallery?minRating=4', { cookie })
      ).json()) as GalleryPage;
      expect(ratedOnly.items.map((item) => item.id)).toContain(finished.id);

      // An unrated image from the same dead instance is correctly gone.
      const stats = (await (
        await server.call('/api/archive/stats', { cookie })
      ).json()) as { images: number; bytes: number };
      expect(stats.images).toBe(1);
      expect(stats.bytes).toBeGreaterThan(0);
    } finally {
      await server.dispose();
      if (!closed) await ephemeral.close();
    }
  }, 40_000);
});

describe('workflow presets', () => {
  it('saves a set of values and hands them back intact', async () => {
    const server = await bootIsolated();
    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'preset test' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      const workflow = (await (
        await server.call('/api/workflows', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ name: 'presets', graph: sd15Txt2Img }),
        })
      ).json()) as WorkflowDetail;

      const values = { '3.steps': 35, '3.cfg': 6.5, '6.text': 'a preset prompt' };
      const created = await server.call(`/api/workflows/${workflow.id}/presets`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({ name: 'Quality', values }),
      });
      expect(created.status).toBe(201);

      const list = (await (
        await server.call(`/api/workflows/${workflow.id}/presets`, { cookie })
      ).json()) as { id: string; name: string; values: Record<string, unknown> }[];
      expect(list).toHaveLength(1);
      expect(list[0]?.values).toEqual(values);

      // Saving the same name again replaces it rather than duplicating.
      await server.call(`/api/workflows/${workflow.id}/presets`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({ name: 'Quality', values: { '3.steps': 50 } }),
      });
      const afterOverwrite = (await (
        await server.call(`/api/workflows/${workflow.id}/presets`, { cookie })
      ).json()) as { id: string; values: Record<string, unknown> }[];
      expect(afterOverwrite).toHaveLength(1);
      expect(afterOverwrite[0]?.values).toEqual({ '3.steps': 50 });

      await server.call(`/api/presets/${afterOverwrite[0]?.id}`, { method: 'DELETE', cookie });
      const emptied = (await (
        await server.call(`/api/workflows/${workflow.id}/presets`, { cookie })
      ).json()) as unknown[];
      expect(emptied).toHaveLength(0);
    } finally {
      await server.dispose();
    }
  }, 30_000);
});

describe('terminal', () => {
  it('does not exist unless it was explicitly enabled', async () => {
    const server = await bootIsolated();
    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'terminal off' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      const status = (await (
        await server.call('/api/status', { cookie })
      ).json()) as StatusResponse;
      expect(status.terminalEnabled).toBe(false);

      const socket = new WebSocket(`${server.url.replace('http', 'ws')}/api/terminal/ws`, {
        headers: { cookie },
      });
      const failure = await new Promise<Error>((resolve, reject) => {
        socket.once('error', resolve);
        socket.once('open', () => reject(new Error('terminal opened while disabled')));
        setTimeout(() => reject(new Error('no response')), 5_000);
      });
      expect(failure.message).toMatch(/404/);
    } finally {
      await server.dispose();
    }
  }, 30_000);

  it('refuses an unauthenticated connection when enabled', async () => {
    const server = await bootIsolated({ terminalEnabled: true });
    try {
      await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'terminal on' }),
      });

      const socket = new WebSocket(`${server.url.replace('http', 'ws')}/api/terminal/ws`);
      const failure = await new Promise<Error>((resolve, reject) => {
        socket.once('error', resolve);
        socket.once('open', () => reject(new Error('terminal opened without authentication')));
        setTimeout(() => reject(new Error('no response')), 5_000);
      });
      expect(failure.message).toContain('401');
    } finally {
      await server.dispose();
    }
  }, 30_000);
});

describe('database migrations', () => {
  /**
   * v1 shipped without a migration runner, so its databases carry
   * `user_version = 0` while already having the tables. Opening one must adopt
   * it and add what is new — not fail, and not require the user to start over.
   */
  it('upgrades a v1 database in place, keeping its data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-v1-'));
    const path = join(dir, 'v1.db');

    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE workflows (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, graph_json TEXT NOT NULL,
        schema_json TEXT NOT NULL, overrides_json TEXT NOT NULL DEFAULT '{}',
        last_values_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE generations (
        id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL UNIQUE, workflow_id TEXT,
        workflow_name TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        values_json TEXT NOT NULL DEFAULT '{}', seeds_json TEXT NOT NULL DEFAULT '{}',
        title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, completed_at INTEGER);
      CREATE TABLE images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL, filename TEXT NOT NULL,
        subfolder TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'output',
        UNIQUE (generation_id, filename, subfolder, type));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    legacy.prepare("INSERT INTO workflows VALUES ('w1','Old workflow','{}','{}','{}','{}',1,1)").run();
    legacy
      .prepare(
        `INSERT INTO generations (id, prompt_id, workflow_id, workflow_name, status, created_at)
         VALUES ('g1','p1','w1','Old workflow','completed',1)`,
      )
      .run();
    legacy.prepare("INSERT INTO images (generation_id, node_id, filename) VALUES ('g1','9','old.png')").run();
    expect(Number(legacy.pragma('user_version', { simple: true }))).toBe(0);
    legacy.close();

    try {
      const store = new Store(path);
      expect(store.schemaVersion).toBeGreaterThan(0);

      // Nothing lost.
      expect(store.listWorkflows().map((w) => w.name)).toEqual(['Old workflow']);
      const page = store.listGenerations({ limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.images).toHaveLength(1);

      // New columns arrive with sane defaults on existing rows.
      expect(page.items[0]?.images[0]).toMatchObject({ rating: 0, archived: false });

      // And the new tables are usable.
      expect(store.countConnections()).toBe(0);
      expect(store.archiveStats()).toEqual({ images: 0, bytes: 0 });

      // Re-opening must be a no-op, not a repeated ALTER TABLE.
      const version = store.schemaVersion;
      store.close();

      const reopened = new Store(path);
      expect(reopened.schemaVersion).toBe(version);
      expect(reopened.listGenerations({ limit: 10 }).items).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('encrypted archive', () => {
  /**
   * The archive holds pictures on a disk indefinitely, so the bytes on that disk
   * must be useless without the password — that is the whole point of the
   * feature. These tests read the actual files, not the API.
   */
  it('writes ciphertext to disk and needs a sign-in to read it back', async () => {
    const comfy = createMockComfy({ stepDelayMs: 2, logLevel: 'silent' });
    const comfyUrl = await comfy.listen(0);
    const dir = mkdtempSync(join(tmpdir(), 'latent-vault-'));

    const built = await buildApp({
      comfyUrl,
      dbPath: join(dir, 'vault.db'),
      dataDir: dir,
      archiveDir: join(dir, 'archive'),
      webDir: join(dir, 'no-web'),
      password: null,
      logLevel: 'silent',
    });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const address = built.app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
      const { cookie: sessionCookie, ...rest } = init;
      return fetch(`${url}${path}`, {
        ...rest,
        headers: {
          ...(rest.body ? { 'content-type': 'application/json' } : {}),
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
          ...(rest.headers ?? {}),
        },
      });
    };

    try {
      const claim = await call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'vault password' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      await waitFor(async () => {
        const status = (await (await call('/api/status', { cookie })).json()) as StatusResponse;
        return status.comfyOnline || null;
      }, 10_000);

      const workflow = (await (
        await call('/api/workflows', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ name: 'vault', graph: sd15Txt2Img }),
        })
      ).json()) as WorkflowDetail;

      await call('/api/generate', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          workflowId: workflow.id,
          values: { '6.text': 'a secret', '3.steps': 4 },
        }),
      });

      const finished = await waitFor(async () => {
        const page = (await (await call('/api/gallery', { cookie })).json()) as GalleryPage;
        const record = page.items[0];
        return record && record.status === 'completed' && record.images.length > 0 ? record : null;
      }, 20_000);

      const image = finished.images[0] as GenerationRecord['images'][number];
      const rated = (await (
        await call(`/api/gallery/${finished.id}/rating`, {
          method: 'PUT',
          cookie,
          body: JSON.stringify({ image, rating: 5 }),
        })
      ).json()) as GenerationRecord;

      expect(rated.images[0]?.archived).toBe(true);
      // A thumbnail is stored too, so the grid never pulls a full-size image.
      expect(rated.images[0]?.hasThumbnail).toBe(true);
      expect(rated.images[0]?.width).toBeGreaterThan(0);

      // Every byte on disk must be ciphertext — no PNG headers anywhere.
      const files = readdirSync(join(dir, 'archive'), { recursive: true }) as string[];
      const stored = files
        .map((name) => join(dir, 'archive', String(name)))
        .filter((candidate) => statSync(candidate).isFile());
      expect(stored.length).toBeGreaterThan(0);

      for (const file of stored) {
        const bytes = readFileSync(file);
        expect(bytes.subarray(0, 6).toString()).toBe('LTNTv1');
        // The PNG signature must not appear anywhere in the ciphertext.
        expect(bytes.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
      }

      // Through the API, with a session, it decrypts fine.
      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
      });
      const view = await call(`/api/view?${params}`, { cookie });
      expect(view.status).toBe(200);
      expect(view.headers.get('x-latent-source')).toBe('archive');
      expect(Buffer.from(await view.arrayBuffer()).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      // Asking for a preview serves the small copy, not the full image.
      const thumb = await call(`/api/view?${params}&preview=webp;70`, { cookie });
      expect(thumb.headers.get('x-latent-source')).toBe('archive-thumb');
      const thumbBytes = Buffer.from(await thumb.arrayBuffer());
      expect(thumbBytes.length).toBeLessThan(Number(view.headers.get('content-length') ?? 1e9));

      /*
       * Now the part that matters: restart the server. The key was only ever in
       * memory, so the archive comes back sealed and stays that way until
       * somebody signs in — which is exactly "not visible even with access to
       * the PC".
       */
      await built.app.close();
      await comfy.close();

      const restarted = await buildApp({
        comfyUrl,
        dbPath: join(dir, 'vault.db'),
        dataDir: dir,
        archiveDir: join(dir, 'archive'),
        webDir: join(dir, 'no-web'),
        password: null,
        logLevel: 'silent',
      });
      await restarted.app.listen({ port: 0, host: '127.0.0.1' });
      const restartedAddress = restarted.app.server.address();
      const restartedUrl = `http://127.0.0.1:${
        typeof restartedAddress === 'object' && restartedAddress ? restartedAddress.port : 0
      }`;

      try {
        const status = (await (await fetch(`${restartedUrl}/api/status`)).json()) as StatusResponse;
        expect(status.archiveLocked).toBe(true);

        // A stolen session cookie is not enough — the key is not there.
        const locked = await fetch(`${restartedUrl}/api/view?${params}`, { headers: { cookie } });
        expect(locked.status).toBe(423);

        // The wrong password does not unlock it either.
        await fetch(`${restartedUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'not the password' }),
        });
        expect((await fetch(`${restartedUrl}/api/view?${params}`, { headers: { cookie } })).status).toBe(423);

        // The right one does.
        const login = await fetch(`${restartedUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'vault password' }),
        });
        const freshCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
        const unlocked = await fetch(`${restartedUrl}/api/view?${params}`, {
          headers: { cookie: freshCookie },
        });
        expect(unlocked.status).toBe(200);

        // And the metadata survived encryption, so the settings are still there.
        const page = (await (
          await fetch(`${restartedUrl}/api/gallery`, { headers: { cookie: freshCookie } })
        ).json()) as GalleryPage;
        expect(page.items[0]?.title).toBe('a secret');
        expect(Object.keys(page.items[0]?.seeds ?? {})).toContain('3.seed');
      } finally {
        await restarted.app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps images readable after a password change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-rekey-'));
    try {
      const store = new Store(join(dir, 'rekey.db'));
      const vault = new Vault(store);

      vault.initialise('first password');
      const secret = Buffer.from('the original pixels');
      const sealed = vault.encrypt(secret);

      expect(vault.rewrap('first password', 'second password')).toBe(true);
      vault.lock();

      // The old password is now useless…
      expect(vault.unlock('first password')).toBe(false);
      // …and the new one reads the file written under the old one, because
      // re-keying rewraps the master key rather than re-encrypting anything.
      expect(vault.unlock('second password')).toBe(true);
      expect(vault.decrypt(sealed).toString()).toBe('the original pixels');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('folder import', () => {
  it('scans a folder tree, imports into the encrypted archive, and refuses to escape it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-import-'));
    const outputs = join(dir, 'outputs');
    mkdirSync(join(outputs, 'nested'), { recursive: true });

    // Two real PNGs, one in a subfolder, plus a non-image that must be ignored.
    writeFileSync(join(outputs, 'first.png'), renderPlaceholder(800, 600, 'first'));
    writeFileSync(join(outputs, 'nested', 'second.png'), renderPlaceholder(400, 800, 'second'));
    writeFileSync(join(outputs, 'notes.txt'), 'not an image');
    // And a secret outside the root, to prove traversal is blocked.
    writeFileSync(join(dir, 'outside.png'), renderPlaceholder(16, 16, 'outside'));

    // A reachable ComfyUI, so "send to img2img" has somewhere to upload to.
    const comfy = createMockComfy({ logLevel: 'silent' });
    const comfyUrl = await comfy.listen(0);

    const server = await bootIsolated({
      comfyUrl,
      dbPath: join(dir, 'import.db'),
      dataDir: dir,
      archiveDir: join(dir, 'archive'),
      webDir: join(dir, 'no-web'),
    });

    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'import password' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      // Nothing configured yet.
      const before = (await (
        await server.call('/api/import/scan', { cookie })
      ).json()) as ImportScanResult;
      expect(before.ok).toBe(false);

      await server.call('/api/settings', {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ importRoot: outputs }),
      });

      const scan = (await (
        await server.call('/api/import/scan', { cookie })
      ).json()) as ImportScanResult;
      expect(scan.ok).toBe(true);
      expect(scan.files.map((file) => file.path).sort()).toEqual([
        'first.png',
        'nested/second.png',
      ]);

      // Dimensions come from the file headers, so the grid can shape tiles
      // before anything is downloaded.
      const first = scan.files.find((file) => file.path === 'first.png');
      expect(first).toMatchObject({ width: 800, height: 600, imported: false });

      const result = (await (
        await server.call('/api/import', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ paths: ['first.png', 'nested/second.png'], rating: 4 }),
        })
      ).json()) as ImportResult;
      expect(result).toMatchObject({ imported: 2, skipped: 0 });
      expect(result.failed).toEqual([]);

      // They arrive as ordinary, rated gallery entries.
      const page = (await (
        await server.call('/api/gallery?minRating=4', { cookie })
      ).json()) as GalleryPage;
      expect(page.items).toHaveLength(2);
      expect(page.items.every((item) => item.source === 'import')).toBe(true);
      expect(page.items[0]?.images[0]?.archived).toBe(true);

      // And their bytes went into the encrypted store like everything else.
      const archived = readdirSync(join(dir, 'archive'), { recursive: true }) as string[];
      const files = archived
        .map((name) => join(dir, 'archive', String(name)))
        .filter((candidate) => statSync(candidate).isFile());
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(readFileSync(file).subarray(0, 6).toString()).toBe('LTNTv1');
      }

      // Re-importing is a no-op rather than a duplicate.
      const again = (await (
        await server.call('/api/import', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ paths: ['first.png'] }),
        })
      ).json()) as ImportResult;
      expect(again).toMatchObject({ imported: 0, skipped: 1 });

      // The scan now marks them, so the UI can grey them out.
      const rescan = (await (
        await server.call('/api/import/scan', { cookie })
      ).json()) as ImportScanResult;
      expect(rescan.files.every((file) => file.imported)).toBe(true);

      /*
       * Regression: imported images carry `type=import`, which the image proxy
       * used to reject outright — so an imported gallery was a grid of
       * "missing" tiles and a broken viewer. They must serve from the archive.
       */
      const imported = page.items.find((item) => item.images[0]?.filename === 'first.png');
      const importedImage = imported?.images[0];
      expect(importedImage?.type).toBe('import');

      const viewParams = new URLSearchParams({
        filename: importedImage!.filename,
        subfolder: importedImage!.subfolder,
        type: importedImage!.type,
      });

      const full = await server.call(`/api/view?${viewParams}`, { cookie });
      expect(full.status).toBe(200);
      expect(full.headers.get('x-latent-source')).toBe('archive');
      expect(Buffer.from(await full.arrayBuffer()).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      // …and a preview request gets the small copy, not the original. The
      // thumbnail is generated locally, since a scanned folder has no ComfyUI
      // to ask for one.
      expect(importedImage?.hasThumbnail).toBe(true);
      const preview = await server.call(`/api/view?${viewParams}&preview=webp;70`, { cookie });
      expect(preview.status).toBe(200);
      expect(preview.headers.get('x-latent-source')).toBe('archive-thumb');
      const thumbBytes = Buffer.from(await preview.arrayBuffer());
      expect(thumbBytes.length).toBeLessThan(full.headers.get('content-length') ? Number(full.headers.get('content-length')) : 1e9);

      // Sending an imported image to img2img must work too: ComfyUI has never
      // seen the file, so the bytes have to come from the archive.
      const toInput = await server.call('/api/images/to-input', {
        method: 'POST',
        cookie,
        body: JSON.stringify(importedImage),
      });
      expect(toInput.status).toBe(200);
      expect(((await toInput.json()) as { type: string }).type).toBe('input');

      /*
       * The important one: an authenticated caller must not be able to read
       * files outside the configured folder by asking nicely.
       */
      const escape = (await (
        await server.call('/api/import', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ paths: ['../outside.png', '/etc/hostname'] }),
        })
      ).json()) as ImportResult;
      expect(escape.imported).toBe(0);
      expect(escape.failed).toHaveLength(2);
      expect(escape.failed.every((entry) => /outside the import folder/.test(entry.reason))).toBe(true);
    } finally {
      await server.dispose();
      await comfy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('form layouts', () => {
  /**
   * A workflow used to have exactly one set of field overrides, so arranging the
   * form one way destroyed any other arrangement. Layouts are named snapshots.
   */
  it('saves, switches between and deletes named arrangements', async () => {
    const server = await bootIsolated();
    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'layout password' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      const workflow = (await (
        await server.call('/api/workflows', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ name: 'layouts', graph: sd15Txt2Img }),
        })
      ).json()) as WorkflowDetail;
      expect(workflow.layouts).toEqual([]);
      expect(workflow.activeLayoutId).toBeNull();

      // Arrange the form one way, then keep it.
      await server.call(`/api/workflows/${workflow.id}`, {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ overrides: { '3.denoise': { hidden: true } } }),
      });
      const minimal = (await (
        await server.call(`/api/workflows/${workflow.id}/layouts`, {
          method: 'POST',
          cookie,
          body: JSON.stringify({ name: 'Quick draft' }),
        })
      ).json()) as { id: string; overrides: Record<string, unknown>; isActive: boolean };

      // Saving snapshots what was on screen, and makes it the active layout.
      expect(minimal.overrides).toEqual({ '3.denoise': { hidden: true } });
      expect(minimal.isActive).toBe(true);

      // Arrange it a different way and keep that too.
      await server.call(`/api/workflows/${workflow.id}`, {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({
          overrides: { '9.filename_prefix': { group: 'main', label: 'File name' } },
        }),
      });
      const full = (await (
        await server.call(`/api/workflows/${workflow.id}/layouts`, {
          method: 'POST',
          cookie,
          body: JSON.stringify({ name: 'Everything' }),
        })
      ).json()) as { id: string };

      // Both survive — that is the entire point.
      const detail = (await (
        await server.call(`/api/workflows/${workflow.id}`, { cookie })
      ).json()) as WorkflowDetail;
      expect(detail.layouts.map((layout) => layout.name).sort()).toEqual([
        'Everything',
        'Quick draft',
      ]);
      expect(detail.activeLayoutId).toBe(full.id);

      // Switching back applies that arrangement to the live form.
      await server.call(`/api/workflows/${workflow.id}/layouts/${minimal.id}/activate`, {
        method: 'POST',
        cookie,
      });
      const switched = (await (
        await server.call(`/api/workflows/${workflow.id}`, { cookie })
      ).json()) as WorkflowDetail;

      expect(switched.activeLayoutId).toBe(minimal.id);
      expect(switched.overrides).toEqual({ '3.denoise': { hidden: true } });
      // And the schema handed to the client reflects it.
      expect(switched.schema.fields.find((field) => field.id === '3.denoise')?.hidden).toBe(true);

      // Saving under an existing name replaces it rather than duplicating.
      await server.call(`/api/workflows/${workflow.id}/layouts`, {
        method: 'POST',
        cookie,
        body: JSON.stringify({ name: 'Quick draft', overrides: {} }),
      });
      const afterOverwrite = (await (
        await server.call(`/api/workflows/${workflow.id}/layouts`, { cookie })
      ).json()) as { id: string; name: string }[];
      expect(afterOverwrite).toHaveLength(2);

      // Deleting a layout removes the saved arrangement but leaves the form
      // exactly as it currently looks. Silently reverting the visible form would
      // be a surprising amount of destruction for a delete button.
      const beforeDelete = (await (
        await server.call(`/api/workflows/${workflow.id}`, { cookie })
      ).json()) as WorkflowDetail;

      await server.call(`/api/workflows/${workflow.id}/layouts/${minimal.id}`, {
        method: 'DELETE',
        cookie,
      });
      const afterDelete = (await (
        await server.call(`/api/workflows/${workflow.id}`, { cookie })
      ).json()) as WorkflowDetail;

      expect(afterDelete.layouts.map((layout) => layout.name)).toEqual(['Everything']);
      expect(afterDelete.overrides).toEqual(beforeDelete.overrides);
      expect(afterDelete.activeLayoutId).toBeNull();

      // Layouts belong to their workflow and cannot be reached through another.
      const other = (await (
        await server.call('/api/workflows', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ name: 'other', graph: sd15Txt2Img }),
        })
      ).json()) as WorkflowDetail;
      const crossWorkflow = await server.call(
        `/api/workflows/${other.id}/layouts/${full.id}/activate`,
        { method: 'POST', cookie },
      );
      expect(crossWorkflow.status).toBe(404);
    } finally {
      await server.dispose();
    }
  }, 30_000);
});

describe('random prompt mode', () => {
  /**
   * Find the shared test workflow, importing it if this block is being run on its
   * own — `vitest -t` skips the describe that would otherwise have created it.
   */
  async function txt2imgWorkflowId(): Promise<string> {
    const workflows = await json<{ id: string; name: string }[]>(api('/api/workflows'));
    const existing = workflows.find((w) => w.name === 'SD1.5 txt2img');
    if (existing) return existing.id;

    const created = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'SD1.5 txt2img', graph: sd15Txt2Img }),
      }),
    );
    return created.id;
  }

  /**
   * The whole point is a batch that varies. The draw therefore has to happen on
   * the server, once per queued item — a browser rolling once would send the same
   * prompt eight times, which is precisely what this replaces.
   */
  it('draws a different prompt for every item in a batch', async () => {
    const workflowId = await txt2imgWorkflowId();

    // A library with three groups, so one-per-group has something to enforce.
    const library = [
      { name: 'Golden hour', category: 'Lighting', text: 'warm rim light' },
      { name: 'Blue hour', category: 'Lighting', text: 'cool ambient light' },
      { name: '35mm', category: 'Camera', text: 'shot on 35mm' },
      { name: 'Ilford', category: 'Film', text: 'black and white grain' },
    ];
    const created: string[] = [];
    for (const block of library) {
      const response = await api('/api/prompt-blocks', {
        method: 'POST',
        body: JSON.stringify(block),
      });
      created.push(((await response.json()) as { id: string }).id);
    }

    try {
      const config = await json<{ enabled: boolean; minBlocks: number }>(
        api('/api/prompt-mode', {
          method: 'PATCH',
          body: JSON.stringify({ enabled: true, minBlocks: 2, maxBlocks: 2, keepTyped: true }),
        }),
      );
      expect(config.enabled).toBe(true);
      expect(config.minBlocks).toBe(2);

      await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId,
          values: { '6.text': 'a lighthouse', '3.steps': 40 },
          batchCount: 6,
        }),
      });

      const queue = await waitFor(async () => {
        const state = await json<QueueState>(api('/api/queue'));
        return state.running.length + state.pending.length >= 3 ? state : null;
      });

      const entries = [...queue.running, ...queue.pending];
      const titles = entries.map((entry) => entry.title);

      // Each title keeps the typed prompt and gains drawn phrases.
      for (const title of titles) {
        expect(title.startsWith('a lighthouse')).toBe(true);
        expect(title.length).toBeGreaterThan('a lighthouse'.length);
      }

      // …and they are not all the same, which is the entire feature.
      expect(new Set(titles).size).toBeGreaterThan(1);

      /*
       * One block per group: two lighting phrases must never land together.
       * Checked on every item, because a single lucky draw proves nothing.
       */
      for (const title of titles) {
        const lighting = ['warm rim light', 'cool ambient light'].filter((phrase) =>
          title.includes(phrase),
        );
        expect(lighting.length).toBeLessThanOrEqual(1);
      }

      // The drawn prompt is what got submitted, so it is what the history records
      // — otherwise a result you liked could never be reproduced.
      const page = await json<GalleryPage>(api('/api/gallery?limit=100'));
      const stored = page.items.find((item) => item.title === titles[0]);
      expect(stored).toBeDefined();
      expect(String(stored?.values['6.text'])).toBe(stored?.title);
    } finally {
      await api('/api/queue', { method: 'DELETE' });
      await api('/api/queue/interrupt', { method: 'POST' });
      await api('/api/prompt-mode', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false, blockIds: [] }),
      });
      for (const id of created) await api(`/api/prompt-blocks/${id}`, { method: 'DELETE' });
      await waitFor(async () => {
        const state = await json<QueueState>(api('/api/queue'));
        return state.running.length + state.pending.length === 0 ? state : null;
      });
    }
  }, 40_000);

  it('narrows the draw to a chosen pool, and leaves the prompt alone when the pool is empty', async () => {
    const workflowId = await txt2imgWorkflowId();

    const only = ((await (
      await api('/api/prompt-blocks', {
        method: 'POST',
        body: JSON.stringify({ name: 'Only this', category: 'Style', text: 'the only phrase' }),
      })
    ).json()) as { id: string }).id;
    const other = ((await (
      await api('/api/prompt-blocks', {
        method: 'POST',
        body: JSON.stringify({ name: 'Not this', category: 'Style', text: 'never drawn' }),
      })
    ).json()) as { id: string }).id;

    try {
      await api('/api/prompt-mode', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true, minBlocks: 1, maxBlocks: 1, blockIds: [only] }),
      });

      // The preview uses the same code path as a submit, so it is worth asserting.
      const preview = await json<{ pool: number; rolls: { prompt: string }[] }>(
        api('/api/prompt-mode/preview', {
          method: 'POST',
          body: JSON.stringify({ base: 'a portrait' }),
        }),
      );
      expect(preview.pool).toBe(1);
      for (const roll of preview.rolls) {
        expect(roll.prompt).toBe('a portrait, the only phrase');
        expect(roll.prompt).not.toContain('never drawn');
      }

      /*
       * A pool narrowed to nothing must submit the typed prompt untouched. The
       * alternative — a blank prompt — is never what anyone meant.
       */
      await api('/api/prompt-mode', {
        method: 'PATCH',
        body: JSON.stringify({ blockIds: ['no-such-block'], keepTyped: false }),
      });
      const empty = await json<{ pool: number; rolls: { prompt: string }[] }>(
        api('/api/prompt-mode/preview', {
          method: 'POST',
          body: JSON.stringify({ base: 'untouched' }),
        }),
      );
      expect(empty.pool).toBe(0);
      expect(empty.rolls.every((roll) => roll.prompt === 'untouched')).toBe(true);

      await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId,
          values: { '6.text': 'untouched', '3.steps': 40 },
        }),
      });
      const queued = await waitFor(async () => {
        const state = await json<QueueState>(api('/api/queue'));
        const all = [...state.running, ...state.pending];
        return all.length > 0 ? all : null;
      });
      expect(queued[0]?.title).toBe('untouched');
    } finally {
      await api('/api/queue', { method: 'DELETE' });
      await api('/api/queue/interrupt', { method: 'POST' });
      await api('/api/prompt-mode', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false, blockIds: [] }),
      });
      for (const id of [only, other]) await api(`/api/prompt-blocks/${id}`, { method: 'DELETE' });
      await waitFor(async () => {
        const state = await json<QueueState>(api('/api/queue'));
        return state.running.length + state.pending.length === 0 ? state : null;
      });
    }
  }, 40_000);

  it('leaves the prompt alone when the mode is off', async () => {
    const workflowId = await txt2imgWorkflowId();

    const id = ((await (
      await api('/api/prompt-blocks', {
        method: 'POST',
        body: JSON.stringify({ name: 'Idle', text: 'should not appear' }),
      })
    ).json()) as { id: string }).id;

    try {
      const config = await json<{ enabled: boolean }>(api('/api/prompt-mode'));
      expect(config.enabled).toBe(false);

      await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId,
          values: { '6.text': 'exactly this', '3.steps': 40 },
        }),
      });
      const queued = await waitFor(async () => {
        const state = await json<QueueState>(api('/api/queue'));
        const all = [...state.running, ...state.pending];
        return all.length > 0 ? all : null;
      });
      expect(queued[0]?.title).toBe('exactly this');
    } finally {
      await api('/api/queue', { method: 'DELETE' });
      await api('/api/queue/interrupt', { method: 'POST' });
      await api(`/api/prompt-blocks/${id}`, { method: 'DELETE' });
      await waitFor(async () => {
        const state = await json<QueueState>(api('/api/queue'));
        return state.running.length + state.pending.length === 0 ? state : null;
      });
    }
  }, 30_000);
});

describe('input image folder', () => {
  /**
   * The mirror of the output importer. Nothing here writes to the folder or the
   * database — the only outward action is copying a chosen file into ComfyUI,
   * which happens server-side so the bytes never travel to the phone.
   */
  it('lists a folder, serves small previews, and copies a choice into ComfyUI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-inputs-'));
    const inputs = join(dir, 'refs');
    mkdirSync(join(inputs, 'nested'), { recursive: true });

    writeFileSync(join(inputs, 'beach.png'), renderPlaceholder(800, 600, 'beach'));
    writeFileSync(join(inputs, 'nested', 'sketch.png'), renderPlaceholder(600, 800, 'sketch'));
    writeFileSync(join(inputs, 'notes.txt'), 'not an image');
    // A secret outside the root, to prove traversal is refused.
    writeFileSync(join(dir, 'secret.png'), renderPlaceholder(16, 16, 'secret'));

    const comfy = createMockComfy({ logLevel: 'silent' });
    const comfyUrl = await comfy.listen(0);
    const server = await bootIsolated({ comfyUrl, dbPath: join(dir, 'inputs.db'), dataDir: dir });

    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'input password' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      // Nothing configured yet: say so rather than pretending the folder is empty.
      const before = (await (
        await server.call('/api/input-images', { cookie })
      ).json()) as InputScanResult;
      expect(before.ok).toBe(false);
      expect(before.message).toMatch(/No input folder/i);

      await server.call('/api/settings', {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ inputRoot: inputs }),
      });

      const scan = (await (
        await server.call('/api/input-images', { cookie })
      ).json()) as InputScanResult;
      expect(scan.ok).toBe(true);
      const paths = scan.files.map((file) => file.path).sort();
      expect(paths).toEqual(['beach.png', 'nested/sketch.png']);
      // Sizes are read from the header, so the picker can shape its grid.
      expect(scan.files.find((f) => f.path === 'beach.png')?.width).toBe(800);

      // The preview is genuinely smaller than the original.
      const full = await server.call('/api/input-images/file?path=beach.png', { cookie });
      expect(full.status).toBe(200);
      const fullBytes = Buffer.from(await full.arrayBuffer());

      const preview = await server.call('/api/input-images/file?path=beach.png&preview=1', {
        cookie,
      });
      expect(preview.status).toBe(200);
      const previewBytes = Buffer.from(await preview.arrayBuffer());
      expect(previewBytes.length).toBeLessThan(fullBytes.length);

      // Using one copies it into ComfyUI's input directory, ready for LoadImage.
      const used = await server.call('/api/input-images/use', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ path: 'nested/sketch.png' }),
      });
      expect(used.status).toBe(200);
      const uploaded = (await used.json()) as { name: string; type: string };
      expect(uploaded.type).toBe('input');
      expect(uploaded.name).toContain('sketch');

      // And that upload really is fetchable from ComfyUI afterwards.
      const back = await server.call(
        `/api/view?filename=${encodeURIComponent(uploaded.name)}&type=input`,
        { cookie },
      );
      expect(back.status).toBe(200);

      /*
       * The one that matters: an authenticated caller must not be able to read
       * files outside the configured folder by asking nicely.
       */
      for (const escape of ['../secret.png', '/etc/hostname', 'nested/../../secret.png']) {
        const denied = await server.call(
          `/api/input-images/file?path=${encodeURIComponent(escape)}`,
          { cookie },
        );
        expect(denied.status).toBe(404);

        const deniedUse = await server.call('/api/input-images/use', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ path: escape }),
        });
        expect(deniedUse.status).toBe(404);
      }

      // Unauthenticated callers get nothing at all.
      const anonymous = await server.call('/api/input-images');
      expect(anonymous.status).toBe(401);
    } finally {
      await server.dispose();
      await comfy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('parameter variation', () => {
  async function workflowId(): Promise<string> {
    const workflows = await json<{ id: string; name: string }[]>(api('/api/workflows'));
    const existing = workflows.find((w) => w.name === 'SD1.5 txt2img');
    if (existing) return existing.id;
    const created = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'SD1.5 txt2img', graph: sd15Txt2Img }),
      }),
    );
    return created.id;
  }

  async function reset() {
    await api('/api/queue', { method: 'DELETE' });
    await api('/api/queue/interrupt', { method: 'POST' });
    await api('/api/prompt-mode', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false, params: [], blockIds: [] }),
    });
    await waitFor(async () => {
      const state = await json<QueueState>(api('/api/queue'));
      return state.running.length + state.pending.length === 0 ? state : null;
    });
  }

  /**
   * A step sweep across a batch is the single most common thing anyone does by
   * hand with a queue. Every queued item must draw its own value.
   */
  it('draws a value per queued item, only from the range and interval given', async () => {
    const id = await workflowId();
    try {
      await api('/api/prompt-mode', {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: true,
          params: [{ key: '3.steps', label: 'Steps', min: 20, max: 40, step: 10 }],
        }),
      });

      await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: id,
          values: { '6.text': 'a sweep', '3.steps': 5 },
          batchCount: 6,
        }),
      });

      const queue = await waitFor(async () => {
        const state = await json<QueueState>(api('/api/queue'));
        return state.running.length + state.pending.length >= 3 ? state : null;
      });

      const drawn = [...queue.running, ...queue.pending].map((entry) =>
        Number(entry.params.find((param) => param.label === 'Steps')?.value),
      );
      expect(drawn.length).toBeGreaterThan(2);

      // Only the discrete candidates the rule allows, never the typed 5.
      for (const value of drawn) expect([20, 30, 40]).toContain(value);
      expect(drawn).not.toContain(5);

      // The prompt is untouched: only the parameter was being varied.
      expect([...queue.running, ...queue.pending].every((e) => e.title === 'a sweep')).toBe(true);
    } finally {
      await reset();
    }
  }, 40_000);

  it('leaves parameters alone when the mode is off', async () => {
    const id = await workflowId();
    try {
      // Rules are stored, but the master switch is off.
      await api('/api/prompt-mode', {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: false,
          params: [{ key: '3.steps', label: 'Steps', min: 20, max: 40, step: 10 }],
        }),
      });

      await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: id,
          values: { '6.text': 'untouched', '3.steps': 7 },
        }),
      });

      const queued = await waitFor(async () => {
        const state = await json<QueueState>(api('/api/queue'));
        const all = [...state.running, ...state.pending];
        return all.length > 0 ? all : null;
      });
      expect(queued[0]?.params.find((param) => param.label === 'Steps')?.value).toBe('7');
    } finally {
      await reset();
    }
  }, 30_000);

  /**
   * Prompt draw and parameter draw are one setup in use, so they save and load
   * together — otherwise the two halves can silently disagree.
   */
  it('saves and reloads the whole setup as one named thing', async () => {
    const block = ((await (
      await api('/api/prompt-blocks', {
        method: 'POST',
        body: JSON.stringify({ name: 'Moody', category: 'Mood', text: 'heavy clouds' }),
      })
    ).json()) as { id: string }).id;

    try {
      await api('/api/prompt-mode', {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: true,
          blockIds: [block],
          minBlocks: 1,
          maxBlocks: 1,
          groupLimits: { mood: 2 },
          params: [{ key: '3.cfg', label: 'CFG', min: 4, max: 9, step: 1 }],
        }),
      });

      const saved = await json<{ id: string; name: string }>(
        api('/api/prompt-mode/presets', {
          method: 'POST',
          body: JSON.stringify({ name: 'Moody landscapes' }),
        }),
      );
      expect(saved.name).toBe('Moody landscapes');

      // Wander away from it entirely.
      await api('/api/prompt-mode', {
        method: 'PATCH',
        body: JSON.stringify({ blockIds: [], minBlocks: 4, maxBlocks: 4, groupLimits: {}, params: [] }),
      });

      const restored = await json<{
        blockIds: string[];
        minBlocks: number;
        groupLimits: Record<string, number>;
        params: { key: string; step: number }[];
        enabled: boolean;
      }>(api(`/api/prompt-mode/presets/${saved.id}/apply`, { method: 'POST' }));

      // Everything comes back together: pool, limits and parameter ranges.
      expect(restored.blockIds).toEqual([block]);
      expect(restored.minBlocks).toBe(1);
      expect(restored.groupLimits).toEqual({ mood: 2 });
      expect(restored.params).toEqual([{ key: '3.cfg', label: 'CFG', min: 4, max: 9, step: 1 }]);

      // Saving under the same name replaces rather than duplicating.
      await api('/api/prompt-mode/presets', {
        method: 'POST',
        body: JSON.stringify({ name: 'Moody landscapes' }),
      });
      const list = await json<{ id: string }[]>(api('/api/prompt-mode/presets'));
      expect(list).toHaveLength(1);

      const removed = await api(`/api/prompt-mode/presets/${list[0]!.id}`, { method: 'DELETE' });
      expect(removed.status).toBe(204);
      expect(await json<unknown[]>(api('/api/prompt-mode/presets'))).toHaveLength(0);
    } finally {
      await api(`/api/prompt-blocks/${block}`, { method: 'DELETE' });
      await reset();
    }
  }, 30_000);
});

/**
 * The output that is words rather than pixels.
 *
 * A "preview as text" node is how a workflow reports what it decided, and a
 * client that only looks for images throws that away — which is what this one
 * used to do.
 */
describe('text outputs', () => {
  it('records what a preview-as-text node printed and hands it to the gallery', async () => {
    const created = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'with text preview', graph: withTextPreview }),
      }),
    );

    try {
      const response = await api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: created.id,
          values: { '6.text': 'says what it did', '3.steps': 4 },
        }),
      });
      const { generationIds } = await json<{ generationIds: string[] }>(response);
      const id = generationIds[0] as string;

      const record = await waitFor(async () => {
        const current = await json<GenerationRecord>(api(`/api/gallery/${id}`));
        return current.status === 'completed' ? current : null;
      });

      expect(record.texts.length).toBeGreaterThan(0);
      // Kept with the node that said it, so a graph with several is readable.
      expect(record.texts[0]?.nodeTitle).toBe('What ran');
      expect(record.texts[0]?.text).toMatch(/steps=4/);
      // And the pictures still arrived: text is in addition, not instead.
      expect(record.images.length).toBeGreaterThan(0);
    } finally {
      await api(`/api/workflows/${created.id}`, { method: 'DELETE' });
    }
  }, 30_000);
});

/**
 * The resource and event history behind the Monitor tab.
 *
 * The two halves have to line up in time: a VRAM curve is decoration without
 * "this is where the run started" next to it.
 */
describe('monitor history', () => {
  it('samples the hardware and marks the queue events on the same timeline', async () => {
    const list = await json<{ id: string }[]>(api('/api/workflows'));
    const workflowId = list[0]?.id as string;

    const response = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        workflowId,
        values: { '6.text': 'watched by the monitor', '3.steps': 6 },
      }),
    });
    const { generationIds } = await json<{ generationIds: string[] }>(response);
    const id = generationIds[0] as string;

    await waitFor(async () => {
      const record = await json<GenerationRecord>(api(`/api/gallery/${id}`));
      return record.status === 'completed' ? record : null;
    });

    const snapshot = await waitFor(async () => {
      const current = await json<MonitorSnapshot>(api('/api/monitor'));
      return current.samples.length > 0 ? current : null;
    });

    // VRAM is the one figure every ComfyUI reports.
    expect(snapshot.sources.vram).toBe(true);
    expect(snapshot.deviceName).toContain('Mock GPU');
    expect(snapshot.samples[0]?.vramUsed).toBeGreaterThan(0);

    const kinds = snapshot.events.map((event) => event.kind);
    expect(kinds).toContain('queued');
    expect(kinds).toContain('started');
    expect(kinds).toContain('completed');

    // Named by the run: the buffer holds everything since boot, so the label is
    // how you tell one run's marks from another's.
    expect(
      snapshot.events.some(
        (event) => event.kind === 'started' && event.label === 'watched by the monitor',
      ),
    ).toBe(true);

    // `since` is what makes polling from a phone cheap: nothing repeats.
    const newest = Math.max(
      ...snapshot.samples.map((sample) => sample.at),
      ...snapshot.events.map((event) => event.at),
    );
    const delta = await json<MonitorSnapshot>(api(`/api/monitor?since=${newest}`));
    expect(delta.samples.every((sample) => sample.at > newest)).toBe(true);
    expect(delta.events.every((event) => event.at > newest)).toBe(true);
  }, 30_000);
});

/**
 * The settings files that live above the project.
 *
 * The whole point is surviving the project directory being deleted, so the test
 * does exactly that: build one server, arrange things, throw its database away,
 * and build another one pointed at the same files.
 */
describe('portable settings files', () => {
  it('writes the arrangement beside the project and reads it back into a fresh install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'latent-state-'));
    const stateDir = join(root, 'above');
    const first = join(root, 'one');
    const second = join(root, 'two');

    const boot = async (dir: string) => {
      const built = await buildApp({
        comfyUrl: 'http://127.0.0.1:1',
        dbPath: join(dir, 'latent.db'),
        dataDir: dir,
        stateDir,
        webDir: join(dir, 'no-web'),
        password: 'state-password',
        logLevel: 'silent',
      });
      await built.app.listen({ port: 0, host: '127.0.0.1' });
      const address = built.app.server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      return { built, url: `http://127.0.0.1:${address.port}` };
    };

    const call = (url: string, path: string, init?: RequestInit) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: {
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          cookie: cookieFor(url),
          ...(init?.headers ?? {}),
        },
      });

    const sessions = new Map<string, string>();
    const cookieFor = (url: string) => sessions.get(url) ?? '';
    const signIn = async (url: string) => {
      const response = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'state-password' }),
      });
      sessions.set(url, response.headers.get('set-cookie')?.split(';')[0] ?? '');
    };

    const one = await boot(first);
    try {
      await signIn(one.url);
      await call(one.url, '/api/prompt-blocks', {
        method: 'POST',
        body: JSON.stringify({ name: 'Golden hour', category: 'Lighting', text: 'warm rim light' }),
      });
      await call(one.url, '/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ importRoot: '/somewhere/outputs' }),
      });

      // The mirror runs on a timer; the shutdown hook flushes it.
      one.built.ctx.stateFiles.flush();

      const files = readdirSync(stateDir);
      expect(files).toContain('latent-settings.json');
      expect(files).toContain('latent-prompt-blocks.json');
    } finally {
      await one.built.app.close();
    }

    // The clean restart: a brand new database, only the files above it survive.
    rmSync(first, { recursive: true, force: true });

    const two = await boot(second);
    try {
      await signIn(two.url);
      const blocks = await json<{ name: string; category: string }[]>(
        call(two.url, '/api/prompt-blocks'),
      );
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.name).toBe('Golden hour');
      expect(blocks[0]?.category).toBe('Lighting');

      const settings = await json<{ importRoot: string | null }>(call(two.url, '/api/settings'));
      expect(settings.importRoot).toBe('/somewhere/outputs');
    } finally {
      await two.built.app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * Losing ComfyUI mid-queue.
 *
 * The normal case on a rented box, and the one that used to leave the app
 * describing a machine that no longer existed: a queue badge that never cleared
 * and gallery placeholders for pictures that were never going to arrive.
 */
describe('losing the connection with work outstanding', () => {
  it('resolves jobs that vanished while ComfyUI was away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-drop-'));
    const stray = createMockComfy({ stepDelayMs: 5, logLevel: 'silent' });
    const strayAddress = await stray.listen(0);

    const built = await buildApp({
      comfyUrl: strayAddress,
      dbPath: join(dir, 'latent.db'),
      dataDir: dir,
      webDir: join(dir, 'no-web'),
      password: 'drop-password',
      logLevel: 'silent',
    });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const address = built.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const url = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'drop-password' }),
    });
    const session = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const call = (path: string, init?: RequestInit) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: {
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          cookie: session,
          ...(init?.headers ?? {}),
        },
      });

    try {
      const workflow = await json<WorkflowDetail>(
        call('/api/workflows', {
          method: 'POST',
          body: JSON.stringify({ name: 'dropped', graph: sd15Txt2Img }),
        }),
      );

      const queued = await json<{ generationIds: string[] }>(
        call('/api/generate', {
          method: 'POST',
          body: JSON.stringify({
            workflowId: workflow.id,
            values: { '6.text': 'about to be orphaned', '3.steps': 4 },
          }),
        }),
      );
      const id = queued.generationIds[0] as string;

      /*
       * Pull the box out from under it, and take the history with it — this is
       * an instance being destroyed, not a process being restarted.
       */
      await stray.close();
      const replacement = createMockComfy({ stepDelayMs: 5, logLevel: 'silent' });
      await replacement.listen(Number(new URL(strayAddress).port));

      try {
        const resolved = await waitFor(
          async () => {
            const record = await json<GenerationRecord>(call(`/api/gallery/${id}`));
            return record.status !== 'queued' && record.status !== 'running' ? record : null;
          },
          40_000,
        );

        // Nothing to recover, so it is gone — and a run that is gone must not
        // sit in the gallery as a placeholder forever.
        expect(resolved.status).toBe('cancelled');
        expect(resolved.error).toMatch(/connection|unreachable/i);

        const gallery = await json<GalleryPage>(call('/api/gallery?limit=50'));
        expect(gallery.items.some((item) => item.id === id)).toBe(false);
      } finally {
        await replacement.close();
      }
    } finally {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Keeping, deleting, and the cleanup that makes both worth having.
 */
describe('keeping and sweeping', () => {
  it('keeps what was asked for and deletes the rest once it is old enough', async () => {
    const list = await json<{ id: string }[]>(api('/api/workflows'));
    const workflowId = list[0]?.id as string;

    const ids: string[] = [];
    for (const prompt of ['keep me', 'bin me']) {
      const response = await json<{ generationIds: string[] }>(
        api('/api/generate', {
          method: 'POST',
          body: JSON.stringify({ workflowId, values: { '6.text': prompt, '3.steps': 3 } }),
        }),
      );
      ids.push(response.generationIds[0] as string);
    }

    const records = [] as GenerationRecord[];
    for (const id of ids) {
      records.push(
        await waitFor(async () => {
          const record = await json<GenerationRecord>(api(`/api/gallery/${id}`));
          return record.status === 'completed' && record.images.length > 0 ? record : null;
        }),
      );
    }

    // Kept without a rating: the point of the button.
    const kept = await json<GenerationRecord>(
      api(`/api/gallery/${records[0]!.id}/keep`, {
        method: 'PUT',
        body: JSON.stringify({ image: records[0]!.images[0], kept: true }),
      }),
    );
    expect(kept.images[0]?.kept).toBe(true);
    expect(kept.images[0]?.rating).toBe(0);
    // Keeping copies the bytes locally, exactly as rating does.
    expect(kept.images[0]?.archived).toBe(true);

    // Sweep everything older than nothing at all, so both are candidates.
    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ autoDeleteHours: 0.0001 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const removed = built.ctx.sweeper.run();
    expect(removed).toBeGreaterThan(0);

    expect((await api(`/api/gallery/${records[0]!.id}`)).status).toBe(200);
    expect((await api(`/api/gallery/${records[1]!.id}`)).status).toBe(404);

    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ autoDeleteHours: null }),
    });
  }, 40_000);

  it('deletes a single picture, and the run with it when it was the last one', async () => {
    const list = await json<{ id: string }[]>(api('/api/workflows'));
    const workflowId = list[0]?.id as string;

    const response = await json<{ generationIds: string[] }>(
      api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ workflowId, values: { '6.text': 'delete me', '3.steps': 3 } }),
      }),
    );
    const id = response.generationIds[0] as string;

    const record = await waitFor(async () => {
      const current = await json<GenerationRecord>(api(`/api/gallery/${id}`));
      return current.status === 'completed' && current.images.length > 0 ? current : null;
    });

    const image = record.images[0]!;
    const params = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
    });
    const deleted = await api(`/api/gallery/${id}/image?${params.toString()}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    expect((await api(`/api/gallery/${id}`)).status).toBe(404);
  }, 40_000);
});

/**
 * The import browser, and the settings an image carries with it.
 */
describe('browsing an output folder', () => {
  it('walks it a level at a time and recovers the workflow from the metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-browse-'));
    const outputs = join(dir, 'outputs');
    mkdirSync(join(outputs, '2026-07-30'), { recursive: true });

    // One plain picture, and one with the graph ComfyUI would have written.
    writeFileSync(join(outputs, 'loose.png'), renderPlaceholder(64, 64, 'loose'));
    const withGraph = withPngText(
      renderPlaceholder(64, 64, 'graph'),
      'prompt',
      JSON.stringify({
        ...sd15Txt2Img,
        '3': { ...sd15Txt2Img['3'], inputs: { ...sd15Txt2Img['3']!.inputs, steps: 27 } },
        '6': { ...sd15Txt2Img['6'], inputs: { ...sd15Txt2Img['6']!.inputs, text: 'recovered prompt' } },
      }),
    );
    writeFileSync(join(outputs, '2026-07-30', 'made-here.png'), withGraph);

    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ importRoot: outputs }),
    });

    try {
      const root = await json<ImportBrowseResult>(api('/api/import/browse'));
      expect(root.ok).toBe(true);
      expect(root.parent).toBeNull();
      expect(root.files.map((file) => file.name)).toEqual(['loose.png']);
      expect(root.folders).toHaveLength(1);
      expect(root.folders[0]?.name).toBe('2026-07-30');
      // The count is what makes a folder worth opening — or not.
      expect(root.folders[0]?.images).toBe(1);

      const inside = await json<ImportBrowseResult>(
        api('/api/import/browse?path=2026-07-30'),
      );
      expect(inside.parent).toBe('');
      expect(inside.files.map((file) => file.name)).toEqual(['made-here.png']);

      // A whole folder in one request rather than a list of paths from a phone.
      const outcome = await json<ImportResult>(
        api('/api/import', {
          method: 'POST',
          body: JSON.stringify({ folder: '2026-07-30', recursive: true }),
        }),
      );
      expect(outcome.imported).toBe(1);

      const gallery = await json<GalleryPage>(api('/api/gallery?limit=50'));
      const imported = gallery.items.find((item) => item.source === 'import');
      expect(imported).toBeDefined();

      // The whole point: an imported picture knows what made it, so "reuse
      // these settings" has something to reuse.
      expect(imported?.workflowId).toBeTruthy();
      expect(imported?.title).toBe('recovered prompt');
      expect(imported?.values['3.steps']).toBe(27);
      expect(imported?.values['6.text']).toBe('recovered prompt');
    } finally {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ importRoot: null }) });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * One folder for the whole installation.
 *
 * Asking for the output directory, the input directory and every workflow file
 * separately was asking the same question three times. This is the shape a
 * stock ComfyUI actually has, so the test builds one.
 */
describe('reading a ComfyUI installation', () => {
  it('finds the workflows, imports them hidden, and derives the output folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-comfy-'));
    const workflows = join(dir, 'user', 'default', 'workflows');
    mkdirSync(workflows, { recursive: true });
    mkdirSync(join(dir, 'output'), { recursive: true });

    /*
     * What the editor saves, what "Export (API)" saves, and something broken —
     * all carrying the prefix, because the scan only takes marked files now.
     * The unmarked one below is the control.
     */
    writeFileSync(join(workflows, 'API_editor.json'), JSON.stringify(sd15Txt2ImgUi));
    writeFileSync(join(workflows, 'API_api-export.json'), JSON.stringify(sd15Txt2Img));
    writeFileSync(join(workflows, 'API_broken.json'), '{ not json');
    writeFileSync(join(workflows, 'unmarked.json'), JSON.stringify(sd15Txt2Img));
    writeFileSync(join(dir, 'output', 'old.png'), renderPlaceholder(32, 32, 'old'));

    const before = await json<WorkflowDetail[]>(api('/api/workflows'));

    try {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ comfyRoot: dir }) });

      const result = await json<{
        ok: boolean;
        imported: number;
        skipped: number;
        failed: { path: string; reason: string }[];
      }>(api('/api/workflows/scan', { method: 'POST' }));

      expect(result.ok).toBe(true);
      expect(result.imported).toBe(2);
      expect(result.failed.map((failure) => failure.path)).toEqual(['API_broken.json']);

      const after = await json<WorkflowDetail[]>(api('/api/workflows'));
      const found = after.filter((workflow) => !before.some((old) => old.id === workflow.id));
      // Named without the marker, and the unmarked file was left where it was.
      expect(found.map((workflow) => workflow.name).sort()).toEqual(['api-export', 'editor']);

      // Hidden on arrival: a whole installation's worth of workflows is the
      // right thing to import and the wrong thing to scroll through.
      expect(found.every((workflow) => workflow.visible === false)).toBe(true);
      expect(found.every((workflow) => workflow.sourcePath?.startsWith(workflows))).toBe(true);

      // Running it again finds the same files and imports nothing twice.
      const again = await json<{ imported: number; skipped: number }>(
        api('/api/workflows/scan', { method: 'POST' }),
      );
      expect(again.imported).toBe(0);
      // The two already here, plus the unmarked one that is skipped every time.
      expect(again.skipped).toBe(3);

      const chosen = found[0]!;
      const updated = await json<WorkflowDetail>(
        api(`/api/workflows/${chosen.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ visible: true }),
        }),
      );
      expect(updated.visible).toBe(true);

      // The output folder follows from the root, with nothing else entered.
      const scan = await json<ImportScanResult>(api('/api/import/scan'));
      expect(scan.ok).toBe(true);
      expect(scan.files.map((file) => file.name)).toEqual(['old.png']);
    } finally {
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ comfyRoot: null }) });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * The settings files hold connection secrets and the whole prompt library, in a
 * directory chosen because it does not get deleted. So they are encrypted, and
 * this checks that what lands on disk really is unreadable — and that it still
 * survives the clean restart the files exist for.
 */
describe('encrypted settings files', () => {
  it('writes ciphertext and reads it back after a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'latent-crypt-'));
    const stateDir = join(root, 'above');

    const boot = async (dir: string, password: string) => {
      const instance = await buildApp({
        comfyUrl: 'http://127.0.0.1:1',
        dbPath: join(dir, 'latent.db'),
        dataDir: dir,
        stateDir,
        webDir: join(dir, 'no-web'),
        password,
        logLevel: 'silent',
      });
      await instance.app.listen({ port: 0, host: '127.0.0.1' });
      const address = instance.app.server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      return { instance, url: `http://127.0.0.1:${address.port}` };
    };

    const signIn = async (url: string, password: string) => {
      const response = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      return response.headers.get('set-cookie')?.split(';')[0] ?? '';
    };

    const one = await boot(join(root, 'one'), 'file-password');
    try {
      const session = await signIn(one.url, 'file-password');
      await fetch(`${one.url}/api/prompt-blocks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: session },
        body: JSON.stringify({ name: 'Secret block', category: 'Style', text: 'unmistakable' }),
      });
      one.instance.ctx.stateFiles.flush();

      const raw = readFileSync(join(stateDir, 'latent-prompt-blocks.json'), 'utf8');
      expect(raw).not.toContain('unmistakable');
      expect(raw).not.toContain('Secret block');

      const envelope = JSON.parse(raw) as { latent: string; kdf: { name: string } };
      expect(envelope.latent).toBe('encrypted');
      expect(envelope.kdf.name).toBe('scrypt');
    } finally {
      await one.instance.app.close();
    }

    // The clean restart the files exist for: a new database, same password.
    rmSync(join(root, 'one'), { recursive: true, force: true });

    const two = await boot(join(root, 'two'), 'file-password');
    try {
      const session = await signIn(two.url, 'file-password');
      const blocks = await json<{ name: string }[]>(
        fetch(`${two.url}/api/prompt-blocks`, { headers: { cookie: session } }),
      );
      expect(blocks.map((block) => block.name)).toContain('Secret block');
    } finally {
      await two.instance.app.close();
    }

    // And with the wrong password the file stays sealed — and, crucially, is
    // not overwritten, so the right password still recovers it later.
    const beforeBytes = readFileSync(join(stateDir, 'latent-prompt-blocks.json'));
    const three = await boot(join(root, 'three'), 'a-different-password');
    try {
      const session = await signIn(three.url, 'a-different-password');
      const blocks = await json<{ name: string }[]>(
        fetch(`${three.url}/api/prompt-blocks`, { headers: { cookie: session } }),
      );
      expect(blocks).toHaveLength(0);
      three.instance.ctx.stateFiles.flush();
      expect(readFileSync(join(stateDir, 'latent-prompt-blocks.json'))).toEqual(beforeBytes);
    } finally {
      await three.instance.app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * The picture a thumbnail belongs to.
 *
 * `/api/view` used to resolve an image by filename, subfolder and type and take
 * whichever row was newest. Those three are not a key — ComfyUI restarts its
 * counter when an output folder is emptied, and two imported folders routinely
 * hold the same name — so two rows sharing a name meant both of them served the
 * newer one's bytes. That is how a thumbnail comes to open a different picture
 * than the one it showed.
 *
 * Its own server and its own archive: the shared fixture is written to by tests
 * that build their own `Vault` over it, and an image encrypted under one key and
 * read under another fails for a reason that has nothing to do with this.
 */
describe('images with the same name', () => {
  it('serves each one its own bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-collide-'));
    const instance = await buildApp({
      comfyUrl: 'http://127.0.0.1:1',
      dbPath: join(dir, 'latent.db'),
      dataDir: dir,
      stateDir: join(dir, 'state'),
      webDir: join(dir, 'no-web'),
      password: 'collide-password',
      logLevel: 'silent',
    });
    await instance.app.listen({ port: 0, host: '127.0.0.1' });
    const address = instance.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const url = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'collide-password' }),
    });
    const session = login.headers.get('set-cookie')?.split(';')[0] ?? '';

    try {
      // Same name, same (empty) subfolder, same type — the collision itself.
      const first = instance.ctx.store.insertImportedImage({
        generationId: randomUUID(),
        promptId: 'import:one',
        title: 'the older one',
        filename: 'ComfyUI_00001_.png',
        subfolder: '',
        modifiedAt: Date.now(),
      });
      const second = instance.ctx.store.insertImportedImage({
        generationId: randomUUID(),
        promptId: 'import:two',
        title: 'the newer one',
        filename: 'ComfyUI_00001_.png',
        subfolder: '',
        modifiedAt: Date.now(),
      });

      // Visibly different pictures, so a mix-up cannot pass by looking similar.
      const olderBytes = renderPlaceholder(64, 64, 'older');
      const newerBytes = renderPlaceholder(64, 64, 'newer');
      await instance.ctx.archive.storeBytes(first, 'ComfyUI_00001_.png', olderBytes);
      await instance.ctx.archive.storeBytes(second, 'ComfyUI_00001_.png', newerBytes);

      const fetchOne = async (id: number) => {
        const response = await fetch(
          `${url}/api/view?filename=ComfyUI_00001_.png&subfolder=&type=import&id=${id}`,
          { headers: { cookie: session } },
        );
        expect(response.status).toBe(200);
        return Buffer.from(await response.arrayBuffer());
      };

      expect(await fetchOne(first)).toEqual(olderBytes);
      expect(await fetchOne(second)).toEqual(newerBytes);

      // And the gallery hands the client the id that makes that possible.
      const gallery = await json<GalleryPage>(
        fetch(`${url}/api/gallery?limit=100`, { headers: { cookie: session } }),
      );
      const older = gallery.items.find((item) => item.title === 'the older one');
      expect(older?.images[0]?.id).toBe(first);
    } finally {
      await instance.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * A clean start with the archive kept.
 *
 * The whole reason the archive lives outside the project is that you can delete
 * the project. Doing so takes the database — and with it the master key — so
 * every file already in the archive was encrypted under a key the new install
 * does not have. Archive paths are content-addressed, so re-importing the same
 * picture lands on the same path, and "the file is already there" used to be
 * treated as "nothing to do": the row was stored pointing at bytes nobody could
 * ever decrypt again.
 */
describe('re-importing after the database is thrown away', () => {
  it('rewrites archive files it can no longer read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'latent-restart-'));
    const archiveDir = join(root, 'archive');
    const picture = renderPlaceholder(64, 64, 'kept across the restart');

    const boot = async (dir: string, password: string) => {
      const instance = await buildApp({
        comfyUrl: 'http://127.0.0.1:1',
        dbPath: join(dir, 'latent.db'),
        dataDir: dir,
        // Deliberately shared, which is the situation being tested.
        archiveDir,
        stateDir: join(dir, 'state'),
        webDir: join(dir, 'no-web'),
        password,
        logLevel: 'silent',
      });
      await instance.app.listen({ port: 0, host: '127.0.0.1' });
      const address = instance.app.server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      return { instance, url: `http://127.0.0.1:${address.port}` };
    };

    const store = async (built: Awaited<ReturnType<typeof boot>>, title: string) => {
      const imageId = built.instance.ctx.store.insertImportedImage({
        generationId: randomUUID(),
        promptId: `import:${title}`,
        title,
        filename: 'keeper.png',
        subfolder: '',
        modifiedAt: Date.now(),
      });
      await built.instance.ctx.archive.storeBytes(imageId, 'keeper.png', picture);
      return imageId;
    };

    const one = await boot(join(root, 'one'), 'first-password');
    try {
      await store(one, 'before');
    } finally {
      await one.instance.app.close();
    }

    // The clean start: the project's database is gone, the archive is not.
    rmSync(join(root, 'one'), { recursive: true, force: true });

    const two = await boot(join(root, 'two'), 'second-password');
    try {
      const imageId = await store(two, 'after');

      const login = await fetch(`${two.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'second-password' }),
      });
      const session = login.headers.get('set-cookie')?.split(';')[0] ?? '';

      const response = await fetch(
        `${two.url}/api/view?filename=keeper.png&subfolder=&type=import&id=${imageId}`,
        { headers: { cookie: session } },
      );
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(picture);
    } finally {
      await two.instance.app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * Generating until told to stop.
 *
 * It runs on the server because a phone locks its screen inside a minute and a
 * suspended tab cannot top up a queue. The two things worth pinning down: it
 * keeps queueing without anybody asking, and "Generate" while it is on changes
 * the settings rather than adding to the queue.
 */
describe('endless generation', () => {
  it('keeps the queue fed, and takes new settings for the next run', async () => {
    // `/api/workflows` is summaries; the graph comes with the detail.
    const summaries = await json<{ id: string }[]>(api('/api/workflows'));
    let workflow: WorkflowDetail | undefined;
    for (const summary of summaries) {
      const detail = await json<WorkflowDetail>(api(`/api/workflows/${summary.id}`));
      if (detail.graph['6']) {
        workflow = detail;
        break;
      }
    }
    expect(workflow).toBeDefined();

    const before = await json<GalleryPage>(api('/api/gallery?limit=100'));

    await api('/api/generate/endless', {
      method: 'PUT',
      body: JSON.stringify({
        workflowId: workflow!.id,
        values: { '6.text': 'endless one' },
        randomizeSeeds: true,
        batchCount: 1,
        enabled: true,
      }),
    });

    try {
      // Left alone, it queues runs by itself — more than the one a tap would.
      const queuedTwo = await waitFor(async () => {
        const gallery = await json<GalleryPage>(api('/api/gallery?limit=100'));
        const made = gallery.items.filter((item) => item.title === 'endless one');
        return made.length >= 2 ? made.length : null;
      }, 60_000);
      expect(queuedTwo).toBeGreaterThanOrEqual(2);

      const state = await json<{ enabled: boolean; queued: number }>(
        api('/api/generate/endless'),
      );
      expect(state.enabled).toBe(true);
      expect(state.queued).toBeGreaterThanOrEqual(2);

      // Changing the settings does not queue anything itself; the next run uses them.
      await api('/api/generate/endless', {
        method: 'PUT',
        body: JSON.stringify({
          workflowId: workflow!.id,
          values: { '6.text': 'endless two' },
          randomizeSeeds: true,
          batchCount: 1,
          enabled: true,
        }),
      });

      const switched = await waitFor(async () => {
        const gallery = await json<GalleryPage>(api('/api/gallery?limit=100'));
        return gallery.items.some((item) => item.title === 'endless two') || null;
      }, 60_000);
      expect(switched).toBe(true);
    } finally {
      await api('/api/generate/endless', {
        method: 'PUT',
        body: JSON.stringify({ workflowId: workflow!.id, values: {}, enabled: false }),
      });
      await api('/api/queue/interrupt', { method: 'POST' });
    }

    // Switched off, it stops adding to the gallery.
    const stopped = await json<{ enabled: boolean }>(api('/api/generate/endless'));
    expect(stopped.enabled).toBe(false);
    expect(before.items.length).toBeGreaterThanOrEqual(0);
  }, 120_000);
});

/**
 * What Generate does about work already queued.
 *
 * Which one is right depends on how you are working, so it is a setting rather
 * than a decision made for you: building a batch up to compare later wants the
 * queue kept, iterating on a prompt wants it gone.
 */
describe('gallery ordering', () => {
  /**
   * Five runs, one image each, at known times and known ratings — built
   * directly against the store because the point is the SQL, not the pipeline.
   *
   * `created_at` comes from `Date.now()` on insert, so five runs made in a
   * loop share a millisecond and there is no ordering to test. A second
   * connection stamps them apart afterwards.
   */
  function seedStore(path: string): Store {
    const store = new Store(path);
    const at: Record<string, number> = { g1: 1000, g2: 2000, g3: 3000, g4: 4000, g5: 5000 };
    const stars: Record<string, number> = { g1: 5, g2: 0, g3: 3, g4: 0, g5: 1 };

    for (const id of Object.keys(at)) {
      store.insertGeneration({
        id,
        promptId: `p-${id}`,
        workflowId: null,
        workflowName: 'ordering',
        title: id,
        values: {},
        seeds: {},
      });
      store.setGenerationStatus(`p-${id}`, 'completed');
      store.addImages(`p-${id}`, '9', [{ filename: `${id}.png`, subfolder: '', type: 'output' }]);

      const image = store.getGeneration(id)?.images[0];
      if (image && stars[id]) store.setImageRating(image.id, stars[id] as number);
    }

    const stamp = new Database(path);
    const update = stamp.prepare('UPDATE generations SET created_at = ? WHERE id = ?');
    for (const [id, time] of Object.entries(at)) update.run(time, id);
    stamp.close();

    return store;
  }

  /** Walk the whole gallery a page at a time, the way the phone does. */
  function pageThrough(store: Store, sort: 'newest' | 'oldest' | 'rating', limit: number) {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 20; guard += 1) {
      const page: ReturnType<Store['listGenerations']> = store.listGenerations({
        limit,
        cursor,
        sort,
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return seen;
  }

  it('orders by newest, oldest and best rating, and pages in each direction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-sort-'));
    const store = seedStore(join(dir, 'sort.db'));

    try {
      expect(pageThrough(store, 'newest', 10)).toEqual(['g5', 'g4', 'g3', 'g2', 'g1']);
      expect(pageThrough(store, 'oldest', 10)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);

      // Best rating first; ties fall back to newest, so the two unrated runs
      // come back in time order rather than whatever the table felt like.
      expect(pageThrough(store, 'rating', 10)).toEqual(['g1', 'g3', 'g5', 'g4', 'g2']);

      /*
       * The part that actually breaks: a cursor written for one ordering has
       * to be compared in that ordering's direction. Paging two at a time must
       * produce the same list as asking for all five, with nothing repeated
       * and nothing skipped.
       */
      expect(pageThrough(store, 'newest', 2)).toEqual(['g5', 'g4', 'g3', 'g2', 'g1']);
      expect(pageThrough(store, 'oldest', 2)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
      expect(pageThrough(store, 'rating', 2)).toEqual(['g1', 'g3', 'g5', 'g4', 'g2']);

      // An unknown ordering is somebody's typo, and must not empty the gallery.
      expect(store.listGenerations({ limit: 10 }).items.map((item) => item.id)).toEqual([
        'g5',
        'g4',
        'g3',
        'g2',
        'g1',
      ]);

      // Sorting and filtering are independent.
      const rated = store.listGenerations({ limit: 10, minRating: 3, sort: 'oldest' });
      expect(rated.items.map((item) => item.id)).toEqual(['g1', 'g3']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an ordering it does not know rather than passing it to SQL', async () => {
    const page = await json<GalleryPage>(api('/api/gallery?sort=; DROP TABLE generations'));
    expect(Array.isArray(page.items)).toBe(true);

    const known = await json<GalleryPage>(api('/api/gallery?sort=oldest'));
    expect(Array.isArray(known.items)).toBe(true);
  });
});

describe('which workflows a scan takes', () => {
  /**
   * The prefix is what makes reading a whole installation usable.
   *
   * An install that has been used for a while holds dozens of experiments, and
   * a scan that imports all of them produces a list nobody can find anything
   * in. Marking the handful meant for the phone costs one rename each.
   */
  it('takes only the marked files, and drops the marker from the name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'latent-prefix-'));
    const workflows = join(root, 'user', 'default', 'workflows');
    mkdirSync(join(workflows, 'portraits'), { recursive: true });
    // A folder carrying the prefix must not sweep in what is inside it.
    mkdirSync(join(workflows, 'API_scratch'), { recursive: true });

    const graph = JSON.stringify(sd15Txt2Img);
    writeFileSync(join(workflows, 'API_basic.json'), graph);
    writeFileSync(join(workflows, 'portraits', 'API_closeup.json'), graph);
    writeFileSync(join(workflows, 'experiment.json'), graph);
    writeFileSync(join(workflows, 'API_scratch', 'wip.json'), graph);

    const server = await bootIsolated({ comfyUrl: baseUrl });
    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'prefix test' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      await server.call('/api/settings', {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ comfyRoot: root }),
      });

      const scan = (await (
        await server.call('/api/workflows/scan', { method: 'POST', cookie })
      ).json()) as WorkflowScanResult;
      expect(scan.ok).toBe(true);
      expect(scan.imported).toBe(2);

      const names = ((await (
        await server.call('/api/workflows', { cookie })
      ).json()) as { name: string }[])
        .map((workflow) => workflow.name)
        .sort();

      // The marker is gone from the name; the folder it lived in is not.
      expect(names).toEqual(['basic', 'portraits/closeup']);
    } finally {
      await server.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  /**
   * A folder full of workflows and nothing imported is the confusing outcome,
   * so it has to say why rather than "no workflow files in that folder".
   */
  it('explains an empty scan caused by the prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'latent-prefix-none-'));
    const workflows = join(root, 'user', 'default', 'workflows');
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, 'nothing-marked.json'), JSON.stringify(sd15Txt2Img));

    const server = await bootIsolated({ comfyUrl: baseUrl });
    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'prefix test' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';
      await server.call('/api/settings', {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ comfyRoot: root }),
      });

      const scan = (await (
        await server.call('/api/workflows/scan', { method: 'POST', cookie })
      ).json()) as WorkflowScanResult;
      expect(scan.imported).toBe(0);
      expect(scan.message).toContain('API_');
    } finally {
      await server.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  /** Clearing the prefix goes back to reading everything, as installs did before. */
  it('takes everything when the prefix is cleared', async () => {
    const root = mkdtempSync(join(tmpdir(), 'latent-prefix-off-'));
    const workflows = join(root, 'user', 'default', 'workflows');
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, 'plain.json'), JSON.stringify(sd15Txt2Img));
    writeFileSync(join(workflows, 'API_marked.json'), JSON.stringify(sd15Txt2Img));

    const server = await bootIsolated({ comfyUrl: baseUrl });
    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'prefix test' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';
      await server.call('/api/settings', {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ comfyRoot: root, workflowPrefix: '' }),
      });

      const scan = (await (
        await server.call('/api/workflows/scan', { method: 'POST', cookie })
      ).json()) as WorkflowScanResult;
      expect(scan.imported).toBe(2);

      const names = ((await (
        await server.call('/api/workflows', { cookie })
      ).json()) as { name: string }[])
        .map((workflow) => workflow.name)
        .sort();
      // Nothing stripped either, since there is no marker to strip.
      expect(names).toEqual(['API_marked', 'plain']);
    } finally {
      await server.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('parameter studies', () => {
  /**
   * The whole loop, against a real workflow and a real ComfyUI: set up a
   * study, run it, rate what it made, and read the analysis back.
   *
   * The sampler and the statistics are unit-tested to death elsewhere. What
   * this covers is everything between them — the plan surviving in the
   * database, the runner walking it, the pictures being kept out of the
   * gallery, and the one door back into it.
   */
  it('plans, renders, rates and analyses — without touching the gallery', async () => {
    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'study subject', graph: sd15Txt2Img }),
      }),
    );

    const study = await json<StudyDetail>(
      api('/api/studies', {
        method: 'POST',
        body: JSON.stringify({ name: 'steps and sampler', workflowId: workflow.id }),
      }),
    );
    expect(study.status).toBe('draft');
    // The workflow's own last values come along, so the prompt is already set.
    expect(Object.keys(study.base).length).toBeGreaterThan(0);

    const factors = [
      {
        kind: 'numeric',
        key: '3.steps',
        label: 'Steps',
        min: 2,
        max: 4,
        quantise: { mode: 'interval', step: 1 },
        distribution: 'uniform',
        integer: true,
        cost: 0,
      },
      {
        kind: 'categorical',
        key: '3.sampler_name',
        label: 'Sampler',
        levels: ['euler', 'ddim'],
        cost: 3,
      },
    ];

    const configured = await json<StudyDetail>(
      api(`/api/studies/${study.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ factors, shotCount: 6, sampling: 'lhs' }),
      }),
    );
    expect(configured.shotCount).toBe(6);
    expect(configured.factors).toHaveLength(2);

    /*
     * The preview is what makes the cost of a choice visible before paying it.
     * Two samplers over six shots means the expensive factor changes once.
     */
    const preview = await json<StudyPreview>(api(`/api/studies/${study.id}/preview`));
    expect(preview.shots).toBe(6);
    expect(preview.switches.find((entry) => entry.key === '3.sampler_name')?.switches).toBe(1);

    await api(`/api/studies/${study.id}/start`, { method: 'POST' });

    // The runner walks the plan on its own, keeping the queue shallow.
    const finished = await waitFor(async () => {
      const detail = (await (await api(`/api/studies/${study.id}`)).json()) as StudyDetail;
      return detail.rendered === 6 ? detail : null;
    }, 90_000);
    expect(finished.status).toBe('rating');
    expect(finished.failed).toBe(0);

    /*
     * The point of the whole `source` column: six near-identical frames, and
     * the gallery shows none of them.
     */
    const gallery = (await (await api('/api/gallery?limit=100')).json()) as GalleryPage;
    expect(gallery.items.filter((item) => item.workflowName === 'study subject')).toHaveLength(0);

    // Rate every shot, taking whatever the server offers — which is random.
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const response = await api(`/api/studies/${study.id}/next`);
      expect(response.status).toBe(200);
      const next = (await response.json()) as StudyShotImage;
      expect(next.image.filename).toBeTruthy();
      expect(seen.has(next.shot.id)).toBe(false);
      seen.add(next.shot.id);

      // Better ratings for more steps, so the analysis has something to find.
      const steps = Number(next.shot.values['3.steps']);
      await api(`/api/studies/${study.id}/shots/${next.shot.id}/rating`, {
        method: 'PUT',
        body: JSON.stringify({ rating: steps >= 4 ? 3 : steps >= 3 ? 2 : 1 }),
      });
    }

    // Nothing left to rate, and saying so is a 204 rather than an error.
    expect((await api(`/api/studies/${study.id}/next`)).status).toBe(204);

    const stats = (await (await api(`/api/studies/${study.id}/stats`)).json()) as StudyStats;
    expect(stats.rated).toBe(6);
    expect(stats.unrated).toBe(0);

    const steps = stats.factors.find((factor) => factor.key === '3.steps');
    expect(steps?.test).toBe('spearman');
    // Ratings were made to rise with the step count, so it must find that.
    expect(steps?.rho ?? 0).toBeGreaterThan(0.8);

    const sampler = stats.factors.find((factor) => factor.key === '3.sampler_name');
    expect(sampler?.test).toBe('kruskal-wallis');
    expect(sampler?.rho).toBeNull();

    /*
     * The door out. One picture is worth keeping, and keeping it puts the run
     * into the gallery and the favourites — with the bytes archived, so it
     * survives the instance that made it going away.
     */
    const keeper = [...seen][0] as string;
    const kept = await api(`/api/studies/${study.id}/shots/${keeper}/keep`, { method: 'POST' });
    expect(kept.status).toBe(201);

    const favorites = (await (await api('/api/favorites')).json()) as { generationId: string }[];
    expect(favorites).toHaveLength(1);

    const after = (await (await api('/api/gallery?limit=100')).json()) as GalleryPage;
    const promoted = after.items.filter((item) => item.workflowName === 'study subject');
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.source).toBe('comfy');
    expect(promoted[0]?.images[0]?.archived).toBe(true);

    // And the other five are still hidden.
    expect(after.items.length).toBe(gallery.items.length + 1);
  }, 120_000);

  /**
   * Pausing has to be resumable, and resuming has to continue the same plan.
   *
   * The failure this guards against is a resume that re-draws: every picture
   * already rendered would be thrown away, and a study interrupted twice would
   * never finish at all.
   */
  it('keeps its place across a pause', async () => {
    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'pause subject', graph: sd15Txt2Img }),
      }),
    );

    const study = await json<StudyDetail>(
      api('/api/studies', {
        method: 'POST',
        body: JSON.stringify({ name: 'pausable', workflowId: workflow.id }),
      }),
    );

    await api(`/api/studies/${study.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        shotCount: 8,
        factors: [
          {
            kind: 'numeric',
            key: '3.steps',
            label: 'Steps',
            min: 2,
            max: 3,
            quantise: { mode: 'interval', step: 1 },
            distribution: 'uniform',
            integer: true,
            cost: 0,
          },
        ],
      }),
    });

    await api(`/api/studies/${study.id}/start`, { method: 'POST' });

    // Let a couple land, then stop.
    await waitFor(async () => {
      const detail = (await (await api(`/api/studies/${study.id}`)).json()) as StudyDetail;
      return detail.rendered >= 1 ? detail : null;
    }, 60_000);

    const paused = await json<StudyDetail>(
      api(`/api/studies/${study.id}/pause`, { method: 'POST' }),
    );
    expect(paused.status).toBe('paused');

    const shotsAtPause = (await (
      await api(`/api/studies/${study.id}/shots`)
    ).json()) as StudyShot[];
    const ids = shotsAtPause.map((shot) => shot.id).join(',');
    const doneAtPause = shotsAtPause.filter((shot) => shot.status === 'done');
    expect(doneAtPause.length).toBeGreaterThan(0);

    await api(`/api/studies/${study.id}/start`, { method: 'POST' });

    const resumed = (await (await api(`/api/studies/${study.id}/shots`)).json()) as StudyShot[];
    // Same shots, same ids, same order: the plan was not re-drawn.
    expect(resumed.map((shot) => shot.id).join(',')).toBe(ids);
    // And nothing already rendered was reset to pending.
    for (const shot of doneAtPause) {
      expect(resumed.find((entry) => entry.id === shot.id)?.status).toBe('done');
    }

    await api(`/api/studies/${study.id}/pause`, { method: 'POST' });
  }, 120_000);

  /** Deleting a study takes its pictures with it, but not the one you kept. */
  it('cleans up after itself', async () => {
    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'disposable', graph: sd15Txt2Img }),
      }),
    );

    const study = await json<StudyDetail>(
      api('/api/studies', {
        method: 'POST',
        body: JSON.stringify({ name: 'disposable', workflowId: workflow.id }),
      }),
    );

    await api(`/api/studies/${study.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        shotCount: 2,
        factors: [
          {
            kind: 'numeric',
            key: '3.steps',
            label: 'Steps',
            min: 2,
            max: 3,
            quantise: { mode: 'interval', step: 1 },
            distribution: 'uniform',
            integer: true,
            cost: 0,
          },
        ],
      }),
    });
    await api(`/api/studies/${study.id}/start`, { method: 'POST' });

    await waitFor(async () => {
      const detail = (await (await api(`/api/studies/${study.id}`)).json()) as StudyDetail;
      return detail.rendered === 2 ? detail : null;
    }, 60_000);

    const shots = (await (await api(`/api/studies/${study.id}/shots`)).json()) as StudyShot[];
    const keeper = shots.find((shot) => shot.status === 'done');
    expect(keeper).toBeDefined();
    await api(`/api/studies/${study.id}/shots/${keeper?.id}/keep`, { method: 'POST' });

    const before = (await (await api('/api/gallery?limit=100')).json()) as GalleryPage;
    await api(`/api/studies/${study.id}`, { method: 'DELETE' });

    expect((await api(`/api/studies/${study.id}`)).status).toBe(404);

    // The kept picture is a gallery entry now, and survives its study.
    const after = (await (await api('/api/gallery?limit=100')).json()) as GalleryPage;
    expect(after.items.filter((item) => item.workflowName === 'disposable')).toHaveLength(1);
    expect(after.items.length).toBe(before.items.length);
  }, 120_000);

  /**
   * The factors arrive as opaque JSON and go straight into a sampler that will
   * happily be asked for a range of NaN in steps of zero.
   */
  it('refuses nonsense factors rather than planning nothing', async () => {
    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'sanitised', graph: sd15Txt2Img }),
      }),
    );
    const study = await json<StudyDetail>(
      api('/api/studies', {
        method: 'POST',
        body: JSON.stringify({ name: 'sanitised', workflowId: workflow.id }),
      }),
    );

    const patched = await json<StudyDetail>(
      api(`/api/studies/${study.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          factors: [
            { kind: 'numeric', key: '3.steps', min: 'abc', max: 40 },
            { kind: 'categorical', key: '3.sampler_name', levels: [] },
            { kind: 'numeric', key: '', min: 1, max: 2 },
            {
              kind: 'numeric',
              key: '3.cfg',
              label: 'CFG',
              min: 1,
              max: 12,
              quantise: { mode: 'interval', step: -5 },
              distribution: 'nonsense',
              cost: 99,
            },
          ],
        }),
      }),
    );

    // Only the repairable one survives, and it is repaired rather than trusted.
    expect(patched.factors).toHaveLength(1);
    const cfg = patched.factors[0] as {
      key: string;
      quantise: { step: number };
      distribution: string;
      cost: number;
    };
    expect(cfg.key).toBe('3.cfg');
    expect(cfg.quantise.step).toBeGreaterThan(0);
    expect(cfg.distribution).toBe('uniform');
    expect(cfg.cost).toBeLessThanOrEqual(5);

    // A study with nothing valid to vary will not start.
    await api(`/api/studies/${study.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ factors: [{ kind: 'categorical', key: 'x', levels: [] }] }),
    });
    const refused = await api(`/api/studies/${study.id}/start`, { method: 'POST' });
    expect(refused.status).toBe(400);
  }, 60_000);
});

describe('the queue policy', () => {
  it('appends, clears what is waiting, or starts over', async () => {
    const summaries = await json<{ id: string }[]>(api('/api/workflows'));
    let workflow: WorkflowDetail | undefined;
    for (const summary of summaries) {
      const detail = await json<WorkflowDetail>(api(`/api/workflows/${summary.id}`));
      if (detail.graph['6']) {
        workflow = detail;
        break;
      }
    }
    expect(workflow).toBeDefined();

    const queue = async (title: string, batchCount = 4) =>
      json<GenerateResponse>(
        api('/api/generate', {
          method: 'POST',
          body: JSON.stringify({
            workflowId: workflow!.id,
            values: { '6.text': title },
            randomizeSeeds: true,
            batchCount,
          }),
        }),
      );

    const pendingCount = async () => {
      const state = await json<QueueState>(api('/api/queue'));
      return state.pending.length + state.running.length;
    };

    try {
      // Appending is the default: the second batch lines up behind the first.
      await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ queuePolicy: 'append' }) });
      await queue('policy append a');
      const afterFirst = await pendingCount();
      await queue('policy append b');
      expect(await pendingCount()).toBeGreaterThan(afterFirst);

      // Clearing drops what was waiting, so the queue does not keep growing.
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ queuePolicy: 'clear-pending' }),
      });
      await queue('policy clear');
      const afterClear = await waitFor(async () => {
        const count = await pendingCount();
        return count <= 5 ? count : null;
      }, 20_000);
      expect(afterClear).toBeLessThanOrEqual(5);

      /*
       * Nothing from before survives in the queue. Deliberately not asserting
       * how *many* were cancelled: against a mock that renders in milliseconds
       * the earlier batches may legitimately have finished on their own, and a
       * count would then be measuring the mock's speed rather than the policy.
       */
      // `pending` only: the picture being rendered is exactly what this policy
      // promises to leave alone — stopping that one is what `replace` is for.
      const state = await json<QueueState>(api('/api/queue'));
      expect(state.pending.every((entry) => entry.title.startsWith('policy clear'))).toBe(true);
    } finally {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ queuePolicy: 'append' }),
      });
      await api('/api/queue/interrupt', { method: 'POST' });
    }
  }, 60_000);
});

/**
 * The chat module, against a stand-in for llama.cpp.
 *
 * Three things are worth pinning down and none of them is the model: that a
 * reply streams and is stored, that a tool call reaches the client as something
 * to decide about, and that accepting one actually does the thing — writes the
 * blocks, or queues the prompt.
 */
/**
 * Instructions kept outside the workflow that needs them.
 *
 * The point of the whole feature: a paragraph of rules for a captioner lives in
 * one named place, and every workflow with a field of that name gets it — so
 * changing the wording is three taps rather than an export from ComfyUI.
 */
describe('system prompts', () => {
  it('fills a workflow’s text field with the prompt named after it', async () => {
    // The same graph, with one text node titled after the prompt below.
    const graph = JSON.parse(JSON.stringify(sd15Txt2Img)) as typeof sd15Txt2Img;
    (graph['7'] as { _meta?: { title: string } })._meta = { title: 'Caption rules' };

    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'Named text field', graph }),
      }),
    );

    const created = await api('/api/system-prompts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Caption rules', text: 'Describe only what is there.' }),
    });
    expect(created.status).toBe(201);
    const prompt = await json<SystemPrompt>(created);

    try {
      // A second one under the same name is an ambiguity, not a convenience.
      const duplicate = await api('/api/system-prompts', {
        method: 'POST',
        body: JSON.stringify({ name: 'caption RULES', text: 'other' }),
      });
      expect(duplicate.status).toBe(409);

      const { generationIds } = await json<GenerateResponse>(
        api('/api/generate', {
          method: 'POST',
          body: JSON.stringify({
            workflowId: workflow.id,
            // Deliberately typed here too: the library wins, which is what
            // "the prompts are taken out of the workflow" has to mean.
            values: { '6.text': 'a lighthouse', '7.text': 'whatever was exported' },
          }),
        }),
      );

      const record = await json<GenerationRecord>(api(`/api/gallery/${generationIds[0]}`));
      expect(record.values['7.text']).toBe('Describe only what is there.');
      // Nothing else is touched.
      expect(record.values['6.text']).toBe('a lighthouse');
    } finally {
      await api(`/api/system-prompts/${prompt.id}`, { method: 'DELETE' });
    }
  }, 30_000);

  it('leaves the workflow’s own text alone once the prompt is gone', async () => {
    const list = await json<SystemPrompt[]>(api('/api/system-prompts'));
    expect(list.some((entry) => entry.name === 'Caption rules')).toBe(false);
  });
});

/**
 * One list, two kinds of server.
 *
 * The thing worth pinning down is that they do not stand each other down:
 * choosing a model server must leave ComfyUI exactly where it was.
 */
describe('connections of both kinds', () => {
  it('keeps a ComfyUI and a model server active at the same time', async () => {
    const before = await json<StatusResponse>(api('/api/status'));
    expect(before.comfyOnline).toBe(true);

    const created = await api('/api/connections', {
      method: 'POST',
      body: JSON.stringify({ kind: 'llama', name: 'Some model server', url: 'http://127.0.0.1:1' }),
    });
    expect(created.status).toBe(201);
    const connection = await json<{ id: string; kind: string; isActive: boolean }>(created);
    // First of its kind, so it is in use without being asked to be.
    expect(connection.kind).toBe('llama');
    expect(connection.isActive).toBe(true);

    const listed = await json<{ id: string; kind: string; isActive: boolean }[]>(
      api('/api/connections'),
    );
    const comfy = listed.filter((entry) => entry.kind === 'comfy');
    expect(comfy.some((entry) => entry.isActive)).toBe(true);

    // And the chat now reports that address rather than one of its own.
    const status = await json<{ baseUrl: string }>(api('/api/chat/status'));
    expect(status.baseUrl).toBe('http://127.0.0.1:1');

    await api(`/api/connections/${connection.id}`, { method: 'DELETE' });
  }, 30_000);
});

describe('chat', () => {
  /**
   * Point the chat at a stand-in model server.
   *
   * A connection like any other now, rather than an address inside the chat
   * settings — which is the whole point of the change: one list, one dialog,
   * one way of saying "talk to this box".
   */
  const useLlama = async (url: string): Promise<string> => {
    const created = await json<{ id: string }>(
      api('/api/connections', {
        method: 'POST',
        body: JSON.stringify({ kind: 'llama', name: `Model server ${url}`, url }),
      }),
    );
    await api(`/api/connections/${created.id}/activate`, { method: 'POST' });
    return created.id;
  };

  /** Read a server-sent stream to the end and hand back the events. */
  const readStream = async (response: Response): Promise<ChatStreamEvent[]> => {
    expect(response.status).toBe(200);
    const text = await response.text();
    return text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data:'))
      .map((frame) => JSON.parse(frame.slice(5).trim()) as ChatStreamEvent);
  };

  it('streams a reply, keeps the reasoning apart, and stores both', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ chat: { thinking: true } }),
      });

      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      // Both ways a real build sends reasoning, in one reply.
      llama.script({
        reasoning: 'They want something calm.',
        inlineThinking: ' And blue.',
        content: 'How about a harbour at dawn?',
      });

      const events = await readStream(
        await api(`/api/chat/conversations/${chat.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: 'suggest something' }),
        }),
      );

      const said = events
        .filter((event): event is { type: 'content'; text: string } => event.type === 'content')
        .map((event) => event.text)
        .join('');
      const thought = events
        .filter((event): event is { type: 'thinking'; text: string } => event.type === 'thinking')
        .map((event) => event.text)
        .join('');

      expect(said).toBe('How about a harbour at dawn?');
      expect(thought).toBe('They want something calm. And blue.');
      // The `<think>` tags themselves never reach the answer.
      expect(said).not.toContain('think');

      const stored = await json<{ title: string; messages: ChatMessage[] }>(
        api(`/api/chat/conversations/${chat.id}`),
      );
      expect(stored.title).toBe('suggest something');
      expect(stored.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(stored.messages[1]?.content).toBe('How about a harbour at dawn?');
      expect(stored.messages[1]?.thinking).toContain('calm');

      // Reasoning is deliberately not fed back — it is working, not record.
      llama.script({ content: 'Sure.' });
      await readStream(
        await api(`/api/chat/conversations/${chat.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: 'again' }),
        }),
      );
      const sent = llama.requests[1] as { messages: { role: string; content: unknown }[] };
      expect(JSON.stringify(sent.messages)).not.toContain('calm');
      expect(sent.messages[0]?.role).toBe('system');
    } finally {
      await llama.close();
    }
  }, 30_000);

  it('turns a block proposal into blocks, keeping only what was kept', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      llama.script({
        content: 'Here are three.',
        toolCall: {
          name: 'prompt_blocks',
          arguments: {
            reason: 'Lighting you keep asking for.',
            blocks: [
              { action: 'add', name: 'Golden hour', category: 'Lighting', text: 'warm rim light' },
              { action: 'add', name: 'Overcast', category: 'Lighting', text: 'flat grey sky' },
              { action: 'add', name: 'Nonsense', category: '', text: 'ignore me' },
            ],
          },
        },
      });

      const events = await readStream(
        await api(`/api/chat/conversations/${chat.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: 'block ideas please' }),
        }),
      );

      const call = events.find(
        (event): event is { type: 'tool'; call: ChatToolCall } => event.type === 'tool',
      );
      expect(call?.call.tool).toBe('prompt_blocks');
      const messageId = events.find(
        (event): event is { type: 'done'; messageId: string } => event.type === 'done',
      )?.messageId;
      expect(messageId).toBeTruthy();

      const before = await json<{ id: string }[]>(api('/api/prompt-blocks'));

      // Two of the three, and one of them corrected on the way through.
      await api(`/api/chat/conversations/${chat.id}/tool`, {
        method: 'POST',
        body: JSON.stringify({
          messageId,
          decision: 'accepted',
          blocks: [
            { action: 'add', name: 'Golden hour', category: 'Lighting', text: 'warm rim light' },
            { action: 'add', name: 'Overcast', category: 'Lighting', text: 'flat grey daylight' },
          ],
        }),
      });

      const after = await json<{ name: string; text: string }[]>(api('/api/prompt-blocks'));
      expect(after.length).toBe(before.length + 2);
      // The edited text is what was saved, not what the model proposed.
      expect(after.find((block) => block.name === 'Overcast')?.text).toBe('flat grey daylight');
      expect(after.some((block) => block.name === 'Nonsense')).toBe(false);

      // And the model is told, as a `tool` message it can read.
      const stored = await json<{ messages: ChatMessage[] }>(
        api(`/api/chat/conversations/${chat.id}`),
      );
      const toolMessage = stored.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toContain('2 added');
      expect(
        stored.messages.find((message) => message.id === messageId)?.toolResult?.decision,
      ).toBe('accepted');
    } finally {
      await llama.close();
    }
  }, 30_000);

  it('refuses to decide the same tool call twice', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      llama.script({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn, soft light', reason: 'Calm and blue.' },
        },
      });

      const events = await readStream(
        await api(`/api/chat/conversations/${chat.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: 'build me a prompt' }),
        }),
      );
      const messageId = events.find(
        (event): event is { type: 'done'; messageId: string } => event.type === 'done',
      )?.messageId;

      const first = await api(`/api/chat/conversations/${chat.id}/tool`, {
        method: 'POST',
        body: JSON.stringify({ messageId, decision: 'rejected' }),
      });
      expect(first.status).toBe(200);

      // A double tap, or two phones, must not queue the same thing twice.
      const second = await api(`/api/chat/conversations/${chat.id}/tool`, {
        method: 'POST',
        body: JSON.stringify({ messageId, decision: 'accepted' }),
      });
      expect(second.status).toBe(409);
    } finally {
      await llama.close();
    }
  }, 30_000);

  it('says plainly when the model server is not there', async () => {
    await useLlama('http://127.0.0.1:1');

    const status = await json<{ ok: boolean; message?: string }>(api('/api/chat/status'));
    expect(status.ok).toBe(false);
    expect(status.message).toBeTruthy();

    const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
    const response = await api(`/api/chat/conversations/${chat.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    });

    // The stream opens and reports the failure inside it, rather than a bare
    // 502 the chat screen would have to translate.
    const events = await readStream(response);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  }, 30_000);
});
