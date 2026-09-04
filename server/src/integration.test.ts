import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type {
  AppInfo,
  ChatMessage,
  ChatSettings,
  ChatEvent,
  ChatRun,
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
  UpdateStatus,
  TasteCategory,
  TasteEntry,
  TasteProfile,
  WorkflowDetail,
  WorkflowScanResult,
} from '@latent/shared';
import { DEFAULT_WANDER_DRAW, defaultSampling, LATENT_API_VERSION } from '@latent/shared';
import {
  ltxVideoGguf,
  minimaxMusic,
  qwenSpeech,
  sd15Txt2Img,
  videoCombine,
  withLlamaServer,
  withPresetChat,
  sd15Txt2ImgUi,
  uiFormatWorkflow,
  withTextPreview,
} from '@latent/shared/fixtures';

import Database from 'better-sqlite3';

import { buildApp } from './app.js';
import { Store } from './db.js';
import { Taste } from './taste.js';
import { Vault, VaultLockedError } from './vault.js';
import { createMockComfy } from './mock/comfy.js';
import { createMockLlama } from './mock/llama.js';
import { readImageSize } from './images/png.js';
import { renderPlaceholderWebm } from './mock/gif.js';
import { renderPlaceholder } from './mock/png.js';
import { withPngText } from './images/png.js';

/**
 * End-to-end coverage of the server against the mock ComfyUI: import a
 * workflow, generate, watch the live events, and find the result in the
 * gallery. This is the closest thing to a real run that works without a GPU.
 */

let mock: ReturnType<typeof createMockComfy>;
/** The mock's own address, for the few tests that ask it what it received. */
let mockUrl: string;
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
  // Bigger than a thumbnail, so archiving actually has something to shrink —
  // at 384 the output *is* thumbnail-sized and the whole path is skipped.
  mock = createMockComfy({ stepDelayMs: 15, logLevel: 'silent', outputSize: 512 });
  const mockAddress = await mock.listen(0);
  mockUrl = mockAddress;

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

/**
 * Signing in from something this server did not ship.
 *
 * The web app is served by the same process it talks to, so it can hold a
 * cookie and assume the two agree about everything else. A native app is
 * installed once and meets whatever is running months later, with no cookie jar
 * worth keeping in sync — so it asks what it has reached, signs in for a token,
 * and sends that token in the header the platform already has a place for.
 */
describe('a client this server did not ship', () => {
  it('says what it is before anyone has a credential', async () => {
    const server = await bootIsolated();
    try {
      const response = await server.call('/api/app');
      expect(response.status).toBe(200);
      const info = (await response.json()) as AppInfo;

      expect(info.app).toBe('latent');
      expect(info.api.version).toBe(LATENT_API_VERSION);
      expect(info.auth.schemes).toContain('bearer');
      expect(info.auth.login).toBe('/api/auth/login');
      // An unclaimed server says so, which is what sends a client to setup.
      expect(info.auth.setupRequired).toBe(true);

      /*
       * And nothing else. This is the one route a stranger can reach, so what
       * it does *not* say is the point: nothing about the machine, the ComfyUI
       * behind it, or what is on it.
       */
      const text = JSON.stringify(info);
      expect(text).not.toContain('comfy');
      expect(text).not.toContain(server.url);
    } finally {
      await server.dispose();
    }
  }, 30_000);

  it('hands over a token when asked, and takes it back as a bearer', async () => {
    const server = await bootIsolated();
    try {
      await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });

      /*
       * Not by default. The cookie is `httpOnly` so a page cannot read it, and
       * returning the same secret in the body to every caller would hand it
       * back to exactly the script that was arranged not to see it.
       */
      const quiet = await json<{ ok: true; token?: string }>(
        server.call('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ password: 'correct horse' }),
        }),
      );
      expect(quiet.ok).toBe(true);
      expect(quiet.token).toBeUndefined();

      const issued = await json<{ ok: true; token: string }>(
        server.call('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ password: 'correct horse', issueToken: true }),
        }),
      );
      expect(typeof issued.token).toBe('string');
      expect(issued.token.length).toBeGreaterThan(16);

      const bearer = { authorization: `Bearer ${issued.token}` };
      // With no cookie anywhere: this is a client that has never had one.
      expect((await server.call('/api/workflows', { headers: bearer })).status).toBe(200);
      expect((await server.call('/api/gallery', { headers: bearer })).status).toBe(200);
      // And the status route agrees it is signed in, which is how a client
      // decides whether to show its login screen.
      const status = await json<StatusResponse>(server.call('/api/status', { headers: bearer }));
      expect(status.authenticated).toBe(true);

      // The scheme is matched without case, because clients differ.
      expect(
        (await server.call('/api/workflows', { headers: { authorization: `bearer ${issued.token}` } }))
          .status,
      ).toBe(200);

      // A wrong one, a missing one and a malformed header are all just "no".
      expect((await server.call('/api/workflows', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
      expect((await server.call('/api/workflows', { headers: { authorization: 'Bearer' } })).status).toBe(401);
      expect((await server.call('/api/workflows', { headers: { authorization: issued.token } })).status).toBe(401);
      expect((await server.call('/api/workflows')).status).toBe(401);
    } finally {
      await server.dispose();
    }
  }, 30_000);

  /*
   * The token is the password's, not a session's. There is no expiry to track
   * and no refresh to implement — and changing the password ends it, which is
   * the one revocation anybody needs on a server with one door.
   */
  it('stops working when the password changes', async () => {
    const server = await bootIsolated();
    try {
      await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });
      const { token } = await json<{ token: string }>(
        server.call('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ password: 'correct horse', issueToken: true }),
        }),
      );
      const bearer = { authorization: `Bearer ${token}` };
      expect((await server.call('/api/workflows', { headers: bearer })).status).toBe(200);

      const changed = await server.call('/api/auth/password', {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ currentPassword: 'correct horse', newPassword: 'a different one' }),
      });
      expect(changed.status).toBe(200);

      expect((await server.call('/api/workflows', { headers: bearer })).status).toBe(401);
    } finally {
      await server.dispose();
    }
  }, 30_000);

  /*
   * The notes are the one thing a signed-in client still cannot reach: they
   * want the password again, on top of any credential. A bearer token is a way
   * in, not a level of access.
   */
  it('still cannot read the notes without the password again', async () => {
    const server = await bootIsolated();
    try {
      await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });
      const { token } = await json<{ token: string }>(
        server.call('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ password: 'correct horse', issueToken: true }),
        }),
      );
      const bearer = { authorization: `Bearer ${token}` };

      // 403, not 401: signed in, and still not allowed through that door.
      expect((await server.call('/api/taste', { headers: bearer })).status).toBe(403);

      // With the pass bought the same way the app buys one, it opens.
      const opened = await json<{ ticket: string }>(
        server.call('/api/taste/unlock', {
          method: 'POST',
          headers: bearer,
          body: JSON.stringify({ password: 'correct horse' }),
        }),
      );
      const withPass = { ...bearer, 'x-latent-taste': opened.ticket };
      expect((await server.call('/api/taste', { headers: withPass })).status).toBe(200);
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
    // Bigger than a thumbnail, so one is genuinely made and encrypted.
    const comfy = createMockComfy({ stepDelayMs: 2, logLevel: 'silent', outputSize: 512 });
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

        /*
         * The session outlives the restart — the cookie is an HMAC over the
         * stored password hash — so the browser is signed in against an archive
         * that is shut, which is the state people actually meet. Re-entering
         * the password opens it without signing out.
         */
        const wrongUnlock = await fetch(`${restartedUrl}/api/auth/unlock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ password: 'not the password' }),
        });
        expect(wrongUnlock.status).toBe(401);
        expect((await fetch(`${restartedUrl}/api/view?${params}`, { headers: { cookie } })).status)
          .toBe(423);

        const unlock = await fetch(`${restartedUrl}/api/auth/unlock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ password: 'vault password' }),
        });
        expect(unlock.status).toBe(200);
        // The same cookie, now working: no new session was needed.
        expect((await fetch(`${restartedUrl}/api/view?${params}`, { headers: { cookie } })).status)
          .toBe(200);
        const afterUnlock = (await (
          await fetch(`${restartedUrl}/api/status`)
        ).json()) as StatusResponse;
        expect(afterUnlock.archiveLocked).toBe(false);

        // Unauthenticated, it is not a second front door.
        expect(
          (
            await fetch(`${restartedUrl}/api/auth/unlock`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ password: 'vault password' }),
            })
          ).status,
        ).toBe(401);

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
 * A preview is small, whatever the picture behind it is.
 *
 * ComfyUI's `/view?preview=webp;70` re-encodes the file and moves not one
 * pixel, which nobody noticed because the mock used to resize — so the gallery
 * looked right here and shipped 4000×4000 pictures to a phone in the field. A
 * browser decodes one of those to 64 MB of bitmap; a grid of them is over a
 * gigabyte, and the tab dies. Hence: its own mock, rendering big.
 */
describe('previews of a big picture', () => {
  it('never sends the gallery more pixels than a thumbnail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-thumbs-'));
    // The upscaled outputs that provoked this. Not 4000, which would spend a
    // second of the suite on rendering, but well past the thumbnail size.
    const big = createMockComfy({ stepDelayMs: 1, logLevel: 'silent', outputSize: 1024 });
    const bigUrl = await big.listen(0);

    const instance = await buildApp({
      comfyUrl: bigUrl,
      dbPath: join(dir, 'latent.db'),
      dataDir: dir,
      stateDir: join(dir, 'state'),
      webDir: join(dir, 'no-web'),
      password: 'thumbs-password',
      logLevel: 'silent',
    });
    await instance.app.listen({ port: 0, host: '127.0.0.1' });
    const address = instance.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const url = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'thumbs-password' }),
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
          body: JSON.stringify({ name: 'Big pictures', graph: sd15Txt2Img }),
        }),
      );
      const { generationIds } = await json<GenerateResponse>(
        call('/api/generate', {
          method: 'POST',
          body: JSON.stringify({ workflowId: workflow.id, values: {} }),
        }),
      );

      const image = await waitFor(async () => {
        const record = await json<GenerationRecord>(call(`/api/gallery/${generationIds[0]}`));
        return record.images[0];
      }, 20_000);

      const query =
        `filename=${encodeURIComponent(image.filename)}&subfolder=&type=output` +
        `&id=${image.id}`;

      // The picture itself is what the viewer opens, and it is untouched.
      const full = await call(`/api/view?${query}`);
      expect(readImageSize(Buffer.from(await full.arrayBuffer()))).toEqual({
        width: 1024,
        height: 1024,
      });

      // The gallery's is not.
      const preview = await call(`/api/view?${query}&preview=webp%3B70`);
      expect(preview.status).toBe(200);
      expect(preview.headers.get('x-latent-source')).toBe('derived-thumb');

      const bytes = Buffer.from(await preview.arrayBuffer());
      const size = readImageSize(bytes);
      expect(size).toEqual({ width: 384, height: 384 });
      // The decoded bitmap is what kills a browser, and this is a seventh of
      // one — the ratio a 4000×4000 output would see is a hundredth.
      expect(size!.width * size!.height).toBeLessThan(1024 * 1024 * 0.2);

      // Derived once: the second tile is answered from memory.
      const again = await call(`/api/view?${query}&preview=webp%3B70`);
      expect(Buffer.from(await again.arrayBuffer())).toEqual(bytes);
    } finally {
      await instance.app.close();
      await big.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * The viewer's own request: this rectangle, at this size.
 *
 * Opening a picture used to fetch the original — twenty megabytes for a recent
 * output, and sixty-four of bitmap once decoded, on a phone that is usually
 * also watching the next render. A screen has two million pixels; the rest is
 * fetched and thrown away.
 */
describe('views sized for the screen', () => {
  it('renders the whole picture into the box, and a zoomed part at the same size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-views-'));
    const big = createMockComfy({ stepDelayMs: 1, logLevel: 'silent', outputSize: 1024 });
    const bigUrl = await big.listen(0);

    const instance = await buildApp({
      comfyUrl: bigUrl,
      dbPath: join(dir, 'latent.db'),
      dataDir: dir,
      stateDir: join(dir, 'state'),
      webDir: join(dir, 'no-web'),
      password: 'views-password',
      logLevel: 'silent',
    });
    await instance.app.listen({ port: 0, host: '127.0.0.1' });
    const address = instance.app.server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const url = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'views-password' }),
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
          body: JSON.stringify({ name: 'Big pictures', graph: sd15Txt2Img }),
        }),
      );
      const { generationIds } = await json<GenerateResponse>(
        call('/api/generate', {
          method: 'POST',
          body: JSON.stringify({ workflowId: workflow.id, values: {} }),
        }),
      );
      const image = await waitFor(async () => {
        const record = await json<GenerationRecord>(call(`/api/gallery/${generationIds[0]}`));
        return record.images[0];
      }, 20_000);

      const query =
        `filename=${encodeURIComponent(image.filename)}&subfolder=&type=output&id=${image.id}`;

      // A portrait phone at 3x: the whole picture fits inside that box.
      const fitted = await call(`/api/view?${query}&fit=390x844`);
      expect(fitted.status).toBe(200);
      expect(fitted.headers.get('x-latent-source')).toBe('view');
      const fittedSize = readImageSize(Buffer.from(await fitted.arrayBuffer()))!;
      expect(fittedSize.width).toBe(390);
      expect(fittedSize.height).toBe(390);

      /*
       * Zoomed in: the middle quarter of the picture, asked for at the same
       * box. The point of the whole thing — more detail per pixel without the
       * frame ever being sent. The rectangle is fractions of the picture, so
       * a caller that has only ever seen a scaled copy can still name it.
       */
      const zoomed = await call(`/api/view?${query}&fit=390x844&crop=0.25,0.25,0.5,0.5`);
      const zoomedSize = readImageSize(Buffer.from(await zoomed.arrayBuffer()))!;
      expect(zoomedSize).toEqual({ width: 390, height: 390 });

      // Never enlarged: a rectangle already smaller than the box comes back at
      // its own size rather than interpolated up on this thread. 1/16th of
      // 1024 is 64.
      const tiny = await call(`/api/view?${query}&fit=390x844&crop=0.1,0.1,0.0625,0.0625`);
      expect(readImageSize(Buffer.from(await tiny.arrayBuffer()))).toEqual({
        width: 64,
        height: 64,
      });

      // Nonsense is the whole picture rather than an error: a crop is only ever
      // an optimisation, so there is nothing a failure would buy.
      const broken = await call(`/api/view?${query}&fit=390x844&crop=oops`);
      expect(readImageSize(Buffer.from(await broken.arrayBuffer()))).toEqual({
        width: 390,
        height: 390,
      });

      // And the original is still the original, for the setting that asks.
      const native = await call(`/api/view?${query}`);
      expect(readImageSize(Buffer.from(await native.arrayBuffer()))).toEqual({
        width: 1024,
        height: 1024,
      });

      /*
       * The size on record is the file's, not a thumbnail's.
       *
       * The browser used to measure this from `preview=`, which stopped being
       * the original once thumbnails were derived here — so a 1024×1024 output
       * would have been filed as 384×384. The server now notes it while it has
       * the actual bytes.
       */
      const thumbed = await call(`/api/view?${query}&preview=webp;70`);
      expect(readImageSize(Buffer.from(await thumbed.arrayBuffer()))!.width).toBe(384);
      const record = await json<GenerationRecord>(call(`/api/gallery/${generationIds[0]}`));
      expect(record.images[0]).toMatchObject({ width: 1024, height: 1024 });
    } finally {
      await instance.app.close();
      await big.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
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
      // The id is optional on the type — a favourite recorded before it existed
      // has none — but a row just written always has one.
      if (image?.id !== undefined && stars[id]) {
        store.setImageRating(image.id, stars[id] as number);
      }
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
 * The llama-server nodes, pointed at the model server Latent is already using.
 *
 * Their address is a widget, so it lives inside the workflow — and a rented box
 * gets a new one every time it is started. The point of this is that following
 * it is one edit in one place rather than one per workflow, and that the token
 * that goes with it never lands anywhere it would be stored.
 */
describe('llama-server nodes', () => {
  it('fills in the active model server, and keeps its token out of the record', async () => {
    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'Asks a llama-server', graph: withLlamaServer }),
      }),
    );

    const created = await json<{ id: string }>(
      api('/api/connections', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'llama',
          name: 'Rented model server',
          url: 'http://127.0.0.1:8189',
          authMode: 'bearer',
          secret: 'sk-should-not-be-stored',
        }),
      }),
    );
    await api(`/api/connections/${created.id}/activate`, { method: 'POST' });

    try {
      const { generationIds, promptIds } = await json<GenerateResponse>(
        api('/api/generate', {
          method: 'POST',
          body: JSON.stringify({
            workflowId: workflow.id,
            values: { '6.text': 'model server check' },
          }),
        }),
      );

      // What ComfyUI actually received, which is the only place this shows.
      const submitted = await waitFor(async () => {
        const history = (await (
          await fetch(`${mockUrl}/history/${promptIds[0]}`)
        ).json()) as Record<string, { prompt?: [number, string, Record<string, {
          inputs: Record<string, unknown>;
        }>] }>;
        return history[promptIds[0]!]?.prompt?.[2];
      }, 20_000);

      expect(submitted['20']?.inputs.base_url).toBe('http://127.0.0.1:8189');
      expect(submitted['20']?.inputs.auth).toBe('bearer');
      expect(submitted['20']?.inputs.api_key).toBe('sk-should-not-be-stored');
      // Everything else on the node is left as the workflow had it.
      expect(submitted['20']?.inputs.timeout).toBe(300);

      /*
       * And nowhere else. The recorded values are shown in the gallery and kept
       * as the workflow's last values, so a token in them would be a token in
       * two places nobody would think to clear.
       */
      const record = await json<GenerationRecord>(api(`/api/gallery/${generationIds[0]}`));
      expect(JSON.stringify(record)).not.toContain('sk-should-not-be-stored');

      const stored = await json<WorkflowDetail>(api(`/api/workflows/${workflow.id}`));
      expect(JSON.stringify(stored)).not.toContain('sk-should-not-be-stored');
      // The stored graph still says what it said: substitution is per submit.
      expect(stored.graph['20']?.inputs.base_url).toBe('http://127.0.0.1:8080');
    } finally {
      await api(`/api/connections/${created.id}`, { method: 'DELETE' });
    }
  }, 30_000);

  /**
   * The preset-chat node, whose form cannot be read off `/object_info` alone.
   *
   * Its slots are named in the graph and only `slot_count` of them exist, so a
   * picker left on one that has since been renamed names nothing — and the node
   * answers that with an error, after the job has been queued. This is the
   * settling that keeps a stale choice from costing a run.
   */
  it('settles the preset picker and submits a numeric combo as a number', async () => {
    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'Preset chat', graph: withPresetChat }),
      }),
    );

    // The slots on screen are Rewrite, Caption and Preset 3. Renaming the first
    // one leaves the stored `active` naming a preset that no longer exists.
    const { promptIds } = await json<GenerateResponse>(
      api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: workflow.id,
          values: {
            '6.text': 'a lighthouse',
            '22.name_1': 'Expand',
            '22.active': 'Rewrite',
            '5.divisible_by': '32',
          },
        }),
      }),
    );

    const submitted = await waitFor(async () => {
      const history = (await (
        await fetch(`${mockUrl}/history/${promptIds[0]}`)
      ).json()) as Record<string, { prompt?: [number, string, Record<string, {
        inputs: Record<string, unknown>;
      }>] }>;
      return history[promptIds[0]!]?.prompt?.[2];
    }, 20_000);

    expect(submitted['22']?.inputs.active).toBe('passthrough');
    expect(submitted['22']?.inputs.name_1).toBe('Expand');
    // A combo declared as numbers goes back as a number: the node matches
    // against its own list, where 32 is not "32".
    expect(submitted['5']?.inputs.divisible_by).toBe(32);
    expect(submitted['5']?.inputs.aspect_ratio).toBe('3:2');
  }, 30_000);
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
/**
 * Say what you want, and wait for the conversation to stop working.
 *
 * The routes do not stream a reply any more — they take an intent and return.
 * What follows happens on the server whether or not anybody is watching, which
 * is the whole point of the rebuild, and it means a test's "and then" is a wait
 * on the run state rather than the end of a response body.
 */
const intent = async (chatId: string, path: string, body?: unknown): Promise<ChatRun> => {
  const response = await api(`/api/chat/conversations/${chatId}/${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBeLessThan(300);
  return settled(chatId);
};

/**
 * The same, but handing back the response rather than the settled state.
 *
 * For the few tests that are about what the route *answered* — a second
 * decision on one call has to be refused, and that refusal is a status code.
 */
const intentRaw = async (chatId: string, path: string, body?: unknown): Promise<Response> => {
  const response = await api(`/api/chat/conversations/${chatId}/${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status < 300) await settled(chatId);
  return response;
};

/**
 * Until the model has been asked at least this many times.
 *
 * For the tests about a loop that does not stop on its own — an autonomous run
 * goes until it clears the threshold, and waiting for that would be waiting for
 * four renders to prove something about the first turn.
 */
const askedAtLeast = async (
  llama: ReturnType<typeof createMockLlama>,
  count: number,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (llama.requests.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`The model was asked ${llama.requests.length} times, wanted ${count}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Wandering, which does not stop on its own — so nor does `settled`.
 *
 * Start it, wait for as many rounds as the test is about, then stop it. Rounds
 * are counted as proposals stamped `fromWander`, which is the one thing every
 * round produces whether or not there is a workflow behind it to render with.
 */
const startWandering = (chatId: string) =>
  api(`/api/chat/conversations/${chatId}/wander`, {
    method: 'POST',
    body: JSON.stringify({ on: true }),
  });

const stopWandering = async (chatId: string) => {
  await api(`/api/chat/conversations/${chatId}/stop`, { method: 'POST' });
  await settled(chatId);
};

const wandered = async (
  chatId: string,
  rounds: number,
  timeoutMs = 30_000,
): Promise<ChatMessage[]> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await json<{ messages: ChatMessage[] }>(
      api(`/api/chat/conversations/${chatId}`),
    );
    const made = detail.messages.filter(
      (message) => message.toolCall?.tool === 'build_prompt' && message.toolCall.fromWander,
    );
    if (made.length >= rounds) return made;
    if (Date.now() > deadline) {
      throw new Error(`Wandering made ${made.length} rounds, wanted ${rounds}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Until it is idle, or waiting on a person. Both mean "it is not busy". */
const settled = async (chatId: string, timeoutMs = 20_000): Promise<ChatRun> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await json<{ run: ChatRun }>(api(`/api/chat/conversations/${chatId}`));
    if (detail.run.phase === 'idle' || detail.run.phase === 'awaiting') return detail.run;
    if (Date.now() > deadline) {
      throw new Error(`Conversation ${chatId} is still ${detail.run.phase}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The proposal a conversation is waiting on, and the message carrying it. */
const awaiting = async (chatId: string): Promise<ChatMessage | undefined> => {
  const detail = await json<{ messages: ChatMessage[]; run: ChatRun }>(
    api(`/api/chat/conversations/${chatId}`),
  );
  return detail.messages.find((message) => message.id === detail.run.awaiting);
};

/**
 * Watch a conversation while something happens, and collect what arrived.
 *
 * For the handful of tests that are about the stream itself rather than about
 * what was stored. Subscribes first, so nothing can be missed between the
 * intent and the first frame.
 */
const watching = async (
  chatId: string,
  during: () => Promise<unknown>,
): Promise<ChatEvent[]> => {
  const controller = new AbortController();
  const response = await api(`/api/chat/conversations/${chatId}/events`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);

  const events: ChatEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (frame.startsWith('data:')) {
            events.push(JSON.parse(frame.slice(5).trim()) as ChatEvent);
          }
        }
      }
    } catch {
      // Aborted on purpose, below.
    }
  })();

  try {
    await during();
    await settled(chatId);
  } finally {
    controller.abort();
    await pump;
  }
  return events;
};

describe('chat', () => {

  async function render(prompt: string): Promise<string> {
    const workflows = await json<{ id: string }[]>(api('/api/workflows'));
    const workflowId =
      workflows[0]?.id ??
      (
        await json<WorkflowDetail>(
          api('/api/workflows', {
            method: 'POST',
            body: JSON.stringify({ name: 'review', graph: sd15Txt2Img }),
          }),
        )
      ).id;

    const { generationIds } = await json<GenerateResponse>(
      api('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ workflowId, values: { '6.text': prompt, '3.steps': 2 } }),
      }),
    );
    const id = generationIds[0] as string;

    await waitFor(async () => {
      const record = await json<GenerationRecord>(api(`/api/gallery/${id}`));
      return record.status === 'completed' && record.images.length > 0 ? record : null;
    }, 30_000);

    return id;
  }

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

      const events = await watching(chat.id, () =>
        api(`/api/chat/conversations/${chat.id}/say`, {
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
      await intent(chat.id, 'say', { content: 'again' });
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

      const run = await intent(chat.id, 'say', { content: 'block ideas please' });

      const call = (await awaiting(chat.id))?.toolCall;
      expect(call?.tool).toBe('prompt_blocks');
      const messageId = run.awaiting;
      expect(messageId).toBeTruthy();

      const before = await json<{ id: string }[]>(api('/api/prompt-blocks'));

      // Two of the three, and one of them corrected on the way through.
      await intentRaw(chat.id, 'decide', {
          messageId,
          decision: 'accepted',
          blocks: [
            { action: 'add', name: 'Golden hour', category: 'Lighting', text: 'warm rim light' },
            { action: 'add', name: 'Overcast', category: 'Lighting', text: 'flat grey daylight' },
          ] });

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

  /**
   * The one that did not work.
   *
   * A removal had to carry the block's id, the model had never been shown one,
   * and `applyBlocks` skipped anything without one — silently, so the
   * conversation said the block was gone and the library still had it. The
   * library is in the prompt now and the name is what finds the block, so this
   * walks the whole path: what the model is told, what it sends back, what the
   * dialog is shown, and what is left in the library afterwards.
   */
  it('removes a block the model names, with no id and no text', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);

      const doomed = await json<{ id: string }>(
        api('/api/prompt-blocks', {
          method: 'POST',
          body: JSON.stringify({ name: 'Vague mood', category: 'Mood', text: 'nice vibes' }),
        }),
      );
      await api('/api/prompt-blocks', {
        method: 'POST',
        body: JSON.stringify({ name: 'Golden hour', category: 'Lighting', text: 'warm rim light' }),
      });

      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      llama.script({
        content: 'That one is doing no work.',
        toolCall: {
          name: 'prompt_blocks',
          arguments: {
            reason: 'Too vague to draw anything from.',
            // As a model that has read the library writes it: a name and a
            // group, no uuid, and nothing invented to fill a required field.
            blocks: [{ action: 'remove', name: 'Vague mood', category: 'Mood' }],
          },
        },
      });

      const run = await intent(chat.id, 'say', { content: 'anything worth throwing out?' });
      const messageId = run.awaiting;
      expect(messageId).toBeTruthy();

      // The model was shown the library, which is the only way it could name one.
      const sent = JSON.stringify(llama.requests[0]?.messages ?? []);
      expect(sent).toContain('Vague mood');
      expect(sent).toContain('warm rim light');

      // And the proposal reaching the dialog already points at the real block.
      const call = (await awaiting(chat.id))?.toolCall;
      expect(call?.tool).toBe('prompt_blocks');
      const proposed = call?.tool === 'prompt_blocks' ? call.blocks[0] : undefined;
      expect(proposed?.id).toBe(doomed.id);
      expect(proposed?.missing).toBeUndefined();
      // Described by the block itself, not by what the model guessed about it.
      expect(proposed?.text).toBe('nice vibes');

      await intentRaw(chat.id, 'decide', {
        messageId,
        decision: 'accepted',
        blocks: call?.tool === 'prompt_blocks' ? call.blocks : [],
      });

      const after = await json<{ id: string; name: string }[]>(api('/api/prompt-blocks'));
      expect(after.some((block) => block.id === doomed.id)).toBe(false);
      expect(after.some((block) => block.name === 'Golden hour')).toBe(true);

      const stored = await json<{ messages: ChatMessage[] }>(
        api(`/api/chat/conversations/${chat.id}`),
      );
      expect(stored.messages.find((message) => message.role === 'tool')?.content).toContain(
        '1 removed',
      );
    } finally {
      await llama.close();
    }
  }, 30_000);

  it('says so when a removal names nothing in the library', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      llama.script({
        toolCall: {
          name: 'prompt_blocks',
          arguments: {
            reason: 'Cleaning up.',
            blocks: [{ action: 'remove', name: 'Never existed', category: 'Mood' }],
          },
        },
      });

      const run = await intent(chat.id, 'say', { content: 'tidy the library' });
      const messageId = run.awaiting;

      const call = (await awaiting(chat.id))?.toolCall;
      const proposed = call?.tool === 'prompt_blocks' ? call.blocks[0] : undefined;
      expect(proposed?.missing).toBe(true);

      const before = await json<{ id: string }[]>(api('/api/prompt-blocks'));

      await intentRaw(chat.id, 'decide', {
        messageId,
        decision: 'accepted',
        blocks: call?.tool === 'prompt_blocks' ? call.blocks : [],
      });

      // Nothing was touched, and the model is told why rather than being left
      // to read "the user kept none of them" as a refusal and try again.
      expect((await json<{ id: string }[]>(api('/api/prompt-blocks'))).length).toBe(before.length);
      const stored = await json<{ messages: ChatMessage[] }>(
        api(`/api/chat/conversations/${chat.id}`),
      );
      const toolMessage = stored.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.content).toContain('Could not find');
      expect(toolMessage?.content).toContain('Never existed');
    } finally {
      await llama.close();
    }
  }, 30_000);

  it('changes a block in place instead of adding a second one like it', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      // A name nothing else in this file uses: two blocks called the same thing
      // are deliberately left unresolved, which is a different test.
      const existing = await json<{ id: string }>(
        api('/api/prompt-blocks', {
          method: 'POST',
          body: JSON.stringify({ name: 'Storm light', category: 'Lighting', text: 'grey' }),
        }),
      );
      const before = await json<{ id: string }[]>(api('/api/prompt-blocks'));

      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      llama.script({
        toolCall: {
          name: 'prompt_blocks',
          arguments: {
            reason: 'Sharper wording.',
            blocks: [
              {
                action: 'update',
                name: 'Storm light',
                category: 'Lighting',
                text: 'flat grey daylight, no shadows',
              },
            ],
          },
        },
      });

      const run = await intent(chat.id, 'say', { content: 'improve storm light' });
      const call = (await awaiting(chat.id))?.toolCall;

      await intentRaw(chat.id, 'decide', {
        messageId: run.awaiting,
        decision: 'accepted',
        blocks: call?.tool === 'prompt_blocks' ? call.blocks : [],
      });

      const after = await json<{ id: string; name: string; text: string }[]>(
        api('/api/prompt-blocks'),
      );
      // The old fault: no id meant this fell through to an insert.
      expect(after.length).toBe(before.length);
      expect(after.find((block) => block.id === existing.id)?.text).toBe(
        'flat grey daylight, no shadows',
      );
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

      const run = await intent(chat.id, 'say', { content: 'build me a prompt' });
      const messageId = run.awaiting;

      const first = await intentRaw(chat.id, 'decide', { messageId, decision: 'rejected' });
      expect(first.status).toBe(200);

      // A double tap, or two phones, must not queue the same thing twice.
      const second = await intentRaw(chat.id, 'decide', { messageId, decision: 'accepted' });
      expect(second.status).toBe(409);
    } finally {
      await llama.close();
    }
  }, 30_000);

  /**
   * The ✦ button, which says nothing and asks for everything.
   *
   * It adds no turn of its own, so without help the request ends on the
   * assistant's own last message — and a model asked to speak straight after
   * itself repeats what it just said, which is what the button looked like it
   * was doing.
   */
  it('asks for a prompt as an instruction rather than as a bare continuation', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      llama.script({ content: 'A harbour at dawn, then.' });
      await intent(chat.id, 'say', { content: 'something calm' });

      llama.script({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn, soft light', reason: 'Calm and blue.' },
        },
      });
      /*
       * What the button does with the answer is the setting's business and
       * another test's; this one is about what the turn asking for it *said*.
       */
      await intent(chat.id, 'prompt');

      const sent = llama.requests[1] as {
        messages: { role: string; content: string }[];
        tool_choice?: { function?: { name?: string } };
        tools?: { function: { name: string } }[];
      };

      // The tool is forced, and it is the only one on offer.
      expect(sent.tool_choice?.function?.name).toBe('build_prompt');
      expect(sent.tools?.map((tool) => tool.function.name)).toEqual(['build_prompt']);

      // And the conversation ends on a turn the model can answer, rather than
      // on its own last message.
      const last = sent.messages[sent.messages.length - 1]!;
      expect(last.role).toBe('user');
      expect(last.content).toContain('build_prompt');
      expect(last.content).not.toContain('A harbour at dawn, then.');
    } finally {
      await llama.close();
    }
  }, 30_000);

  /**
   * Showing the model what its prompt actually produced.
   *
   * The turn after a render used to be the model talking about a picture it had
   * never seen — which it does confidently, because that is what these models
   * do. With a multimodal server there is no reason for that: hand it the
   * result and the prompt together, and the sentence becomes a judgement it is
   * in a position to make.
   */
  describe('checking the picture against the prompt', () => {
    /** Generate one picture through the real path, and hand back its run. */

    /** Get to the point where a prompt has been accepted and has rendered. */
    /**
     * A conversation with a prompt on the table, waiting to be accepted.
     *
     * It stops one step short on purpose. Accepting is now one act on the
     * server — queue the render, record the decision, wait for the picture,
     * take the turn that judges it — so whatever the test wants that judging
     * turn to say has to be scripted before the accept, not after it. Stopping
     * here is what makes that possible to write.
     */
    async function upToAPrompt(llama: ReturnType<typeof createMockLlama>, prompt: string) {
      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      // A workflow to generate through; the engine resolves it for itself.
      await render(prompt);

      llama.script({ toolCall: { name: 'build_prompt', arguments: { prompt, reason: 'Calm.' } } });
      const run = await intent(chat.id, 'say', { content: 'build me a prompt' });
      expect(run.awaiting).toBeTruthy();
      return { chatId: chat.id, messageId: run.awaiting as string };
    }

    /** Accept it, which renders it and takes the turn that judges the result. */
    const acceptAndRender = (chatId: string, messageId: string) =>
      intent(chatId, 'decide', { messageId, decision: 'accepted' });

    /** The last request's final message, which is where the review lands. */
    function lastTurn(llama: ReturnType<typeof createMockLlama>) {
      const sent = llama.requests[llama.requests.length - 1] as {
        messages: { role: string; content: unknown }[];
        tools?: { function: { name: string } }[];
      };
      return { sent, last: sent.messages[sent.messages.length - 1]! };
    }

    afterAll(async () => {
      // Back to the default, so the tests after this one see what they expect.
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            review: { enabled: true, threshold: 'balanced', keepInView: 2, askWhen: 'unsure' },
          },
        }),
      });
    });

    it('hands over the picture and the prompt, and takes back a rewrite', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            chat: { review: { enabled: true, threshold: 'balanced', askWhen: 'never' } },
          }),
        });

        const { chatId, messageId } = await upToAPrompt(llama, 'a harbour at dawn, soft light');

        llama.script({
          content: 'The light is right but there is no harbour.',
          toolCall: {
            name: 'revise_prompt',
            arguments: {
              prompt: 'a working harbour at dawn, soft light on the water',
              reason: 'The harbour itself is missing.',
              score: 4,
            },
          },
        });
        await acceptAndRender(chatId, messageId);

        const { sent, last } = lastTurn(llama);

        /*
         * The picture goes over as a picture, at the point it was made — not
         * appended to the question about it. Where it sits is what makes it
         * still there two turns later, when the change is asked for.
         */
        const shown = sent.messages.filter((message) =>
          JSON.stringify(message.content).includes('image_url'),
        );
        expect(shown).toHaveLength(1);
        const parts = shown[0]!.content as {
          type: string;
          text?: string;
          image_url?: { url: string };
        }[];
        expect(parts[0]?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
        // Small enough to be worth prefilling: a render is not sent whole.
        expect(parts[0]!.image_url!.url.length).toBeLessThan(1_500_000);
        expect(parts[1]?.text).toContain('a harbour at dawn, soft light');

        // And the question about it is the turn that ends the request, with the
        // prompt in full rather than a pointer to it.
        expect(last.role).toBe('user');
        expect(String(last.content)).toContain('a harbour at dawn, soft light');
        expect(String(last.content)).toContain('out of 10');

        // One tool on that turn: a rewrite. Not a fresh proposal on top of a
        // picture nobody has looked at yet.
        expect(sent.tools?.map((tool) => tool.function.name)).toEqual(['revise_prompt']);

        const call = (await awaiting(chatId))?.toolCall;
        expect(call?.tool).toBe('revise_prompt');
        expect(call && 'score' in call ? call.score : null).toBe(4);

        // It is a proposal like any other: stored, and waiting on the user.
        const stored = await json<{ messages: ChatMessage[] }>(
          api(`/api/chat/conversations/${chatId}`),
        );
        const proposal = stored.messages[stored.messages.length - 1];
        expect(proposal?.toolCall?.tool).toBe('revise_prompt');
        expect(proposal?.toolResult).toBeUndefined();
      } finally {
        await llama.close();
      }
    }, 60_000);

    /**
     * A group of settings keeps the fields the patch did not mention.
     *
     * The chat's settings have groups of their own now, and a client patching
     * one of them sends the fields it knows about. Before this, the rest came
     * back `undefined` — which for "how many pictures to keep in view" meant
     * every picture in the conversation, re-read on every turn.
     */
    it('keeps the rest of a settings group when part of it is patched', async () => {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: { review: { enabled: true, threshold: 'balanced', keepInView: 3 } },
        }),
      });

      // As a client that predates the field would send it.
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ chat: { review: { enabled: true, threshold: 'strict' } } }),
      });

      const settings = await json<{ chat: ChatSettings }>(api('/api/settings'));
      expect(settings.chat.review.threshold).toBe('strict');
      expect(settings.chat.review.keepInView).toBe(3);
    });

    /**
     * The picture is still there when the change is asked for.
     *
     * The point of keeping it in view: "make the sky darker" means nothing to a
     * model working from its own description of a render it saw two turns ago.
     */
    it('keeps the picture in the conversation after the turn that judged it', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            chat: { review: { enabled: true, threshold: 'never', keepInView: 2 } },
          }),
        });

        const { chatId, messageId } = await upToAPrompt(llama, 'a harbour at dawn');

        llama.script({ content: 'The light came through.' });
        await acceptAndRender(chatId, messageId);

        // Two turns later, with something else said in between.
        llama.script({ content: 'Darker it is.' });
        await intent(chatId, 'say', { content: 'make the sky darker' });

        const { sent, last } = lastTurn(llama);
        // Still in front of it, and still where it happened rather than piled
        // onto the end.
        expect(JSON.stringify(sent.messages)).toContain('image_url');
        expect(String(last.content)).toBe('make the sky darker');
        expect(JSON.stringify(last.content)).not.toContain('image_url');
      } finally {
        await llama.close();
      }
    }, 60_000);

    /**
     * A few, not all of them.
     *
     * Every picture in view is prefill on every turn from then on, so a long
     * session would spend its time re-reading its own back catalogue.
     */
    it('keeps only as many pictures as the setting allows', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            chat: { review: { enabled: true, threshold: 'never', keepInView: 1 } },
          }),
        });

        const { chatId, messageId } = await upToAPrompt(llama, 'a harbour at dawn');
        llama.script({ content: 'Right.' });
        await acceptAndRender(chatId, messageId);

        // A second prompt, accepted and rendered, in the same conversation.
        llama.script({
          toolCall: {
            name: 'build_prompt',
            arguments: { prompt: 'the same harbour at noon', reason: 'Brighter.' },
          },
        });
        const run = await intent(chatId, 'say', { content: 'now at noon' });
        const nextMessageId = run.awaiting as string;
        // Accepting renders it and takes the turn that judges it, so what that
        // turn says is scripted before the accept rather than after it.
        llama.script({ content: 'Brighter indeed.' });
        await intentRaw(chatId, 'decide', {
          messageId: nextMessageId,
          decision: 'accepted',
          prompt: 'the same harbour at noon',
        });
        await settled(chatId);

        const { sent } = lastTurn(llama);
        const shown = sent.messages.filter((message) =>
          JSON.stringify(message.content).includes('image_url'),
        );
        // One picture, and it is the one that goes with the newest prompt.
        expect(shown).toHaveLength(1);
        expect(JSON.stringify(shown[0]?.content)).toContain('the same harbour at noon');
      } finally {
        await llama.close();
      }
    }, 90_000);

    /**
     * Refusing a rewrite is an ordinary turn.
     *
     * The tool response for a refused call carries no run, so the turn after it
     * is a normal one again — tools back, no picture to judge — and the
     * conversation carries on rather than waiting on a decision already made.
     */
    it('carries on after a rewrite is refused', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            chat: { review: { enabled: true, threshold: 'balanced', keepInView: 2 } },
          }),
        });

        const { chatId, messageId } = await upToAPrompt(llama, 'a harbour at dawn');

        llama.script({
          content: 'No harbour.',
          toolCall: {
            name: 'revise_prompt',
            arguments: { prompt: 'a working harbour at dawn', reason: 'Missing.', score: 4 },
          },
        });
        const run = await acceptAndRender(chatId, messageId);
        const nextMessageId = run.awaiting as string;
        expect(nextMessageId).toBeTruthy();

        const rejected = await intentRaw(chatId, 'decide', { messageId: nextMessageId, decision: 'rejected' });
        expect(rejected.status).toBe(200);

        llama.script({ content: 'Fair enough.' });
        // The conversation carries on by itself, and lands back at rest.
        expect((await settled(chatId)).phase).toBe('idle');
      } finally {
        await llama.close();
      }
    }, 60_000);

    /**
     * Asking rather than guessing, and staying in the review to do it.
     *
     * A picture can miss for several reasons at once, and which of them to
     * chase is a matter of taste. Guessing produces a confident rewrite of the
     * wrong thing; asking costs one tap — and the turn *after* the answer is
     * still about the same picture, which is where the rewrite belongs.
     */
    /**
     * A run left to itself is not offered the question tool at all.
     *
     * The setting says "ask when unsure", and normally that is right. With
     * nobody there to answer, a question is a dialog that sits unread — so the
     * tool is withheld and the instruction says why, which is what keeps the
     * model from writing the question into its reply instead.
     */
    it('withholds the question tool while it is carrying on by itself', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            chat: {
              review: { enabled: true, threshold: 'balanced', askWhen: 'always' },
              autonomous: { enabled: true, maxRounds: 4 },
            },
          }),
        });

        /*
         * No fixture here, because with nobody to ask there is nothing to tap:
         * the proposal is accepted, rendered and judged in one go. Both turns
         * are scripted up front and the run is stopped once the second of them
         * has been asked for, which is the one this test is about.
         */
        const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
        await render('a harbour at dawn');
        llama.script({
          toolCall: {
            name: 'build_prompt',
            arguments: { prompt: 'a harbour at dawn', reason: 'Calm.' },
          },
        });
        llama.script({
          content: 'The harbour is thin.',
          toolCall: {
            name: 'revise_prompt',
            arguments: {
              prompt: 'a working harbour at dawn, boats at the quay',
              reason: 'More harbour.',
              score: 5,
            },
          },
        });
        void api(`/api/chat/conversations/${chat.id}/say`, {
          method: 'POST',
          body: JSON.stringify({ content: 'build me a prompt' }),
        });
        await askedAtLeast(llama, 2);
        const { sent, last } = lastTurn(llama);
        await api(`/api/chat/conversations/${chat.id}/stop`, { method: 'POST' });
        // Only the rewrite, even though asking is set to its most insistent
        // step — the setting is about a conversation, and this is not one.
        expect(sent.tools?.map((tool) => tool.function.name)).toEqual(['revise_prompt']);
        expect(JSON.stringify(last.content)).toContain('not answering questions');
        // The judgement it is asked for is unchanged.
        expect(JSON.stringify(last.content)).toContain('below 7 out of 10');
      } finally {
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            chat: {
              review: { enabled: true, threshold: 'balanced', askWhen: 'unsure' },
              autonomous: { enabled: false, maxRounds: 4 },
            },
          }),
        });
        await llama.close();
      }
    }, 40_000);

    /**
     * Switching it on has to mean something wherever the loop happens to be.
     *
     * The fault: the mode was read once, when a run started, and carried for
     * the rest of it — while the strip on the screen read the setting. Turn it
     * on part way through and the two said different things, so it "sometimes
     * iterated and sometimes waited" with nothing on screen to explain which.
     * A run parked on a proposal is the worst case, because being parked is
     * exactly the state with no next step to notice the change.
     */
    describe('turning it on part way through a run', () => {
      const setAutonomous = (chatId: string, on: boolean) =>
        intent(chatId, 'autonomous', { on });

      /**
       * Open the event stream and leave again.
       *
       * `watching` waits for the run to settle, which is the one thing that
       * must not happen here — the point is that arriving sets it going. So
       * this only opens the connection, which is what the server reacts to.
       */
      const lookIn = async (chatId: string): Promise<() => void> => {
        const controller = new AbortController();
        const response = await api(`/api/chat/conversations/${chatId}/events`, {
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
        void response.body?.getReader().read().catch(() => undefined);
        return () => controller.abort();
      };

      /** Wait until a proposal has been answered, however it was answered. */
      const decided = (chatId: string, messageId: string) =>
        waitFor(async () => {
          const stored = await json<{ messages: ChatMessage[] }>(
            api(`/api/chat/conversations/${chatId}`),
          );
          const message = stored.messages.find((entry) => entry.id === messageId);
          return message?.toolResult?.decision ?? null;
        });

      it('takes up the proposal that was already waiting', async () => {
        const llama = createMockLlama();
        const url = await llama.listen(0);

        try {
          await useLlama(url);
          // Off to begin with: this is a run that started as an ordinary one.
          await api('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ chat: { autonomous: { enabled: false, maxRounds: 4 } } }),
          });

          const { chatId, messageId } = await upToAPrompt(llama, 'a harbour at dawn');
          const parked = await json<{ run: ChatRun }>(api(`/api/chat/conversations/${chatId}`));
          expect(parked.run.phase).toBe('awaiting');
          expect(parked.run.mode).toBe('manual');

          const after = await setAutonomous(chatId, true);

          // The proposal is taken, not left sitting behind a truthful-looking
          // strip. Both halves: the decision is recorded and a render started.
          expect(after.phase).not.toBe('awaiting');
          expect(after.mode).toBe('auto');
          const stored = await json<{ messages: ChatMessage[] }>(
            api(`/api/chat/conversations/${chatId}`),
          );
          const decided = stored.messages.find((message) => message.id === messageId);
          expect(decided?.toolResult?.decision).toBe('accepted');

          await api(`/api/chat/conversations/${chatId}/stop`, { method: 'POST' });
        } finally {
          await api('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ chat: { autonomous: { enabled: false, maxRounds: 4 } } }),
          });
          await llama.close();
        }
      }, 40_000);

      /**
       * The same switch lives in Settings, which patches the setting and never
       * reaches this conversation. Coming back to it is the next chance to act.
       */
      it('engages on a waiting run when the switch was flipped elsewhere', async () => {
        const llama = createMockLlama();
        const url = await llama.listen(0);

        try {
          await useLlama(url);
          await api('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ chat: { autonomous: { enabled: false, maxRounds: 4 } } }),
          });

          const { chatId, messageId } = await upToAPrompt(llama, 'a quiet street');

          // Exactly what the Settings screen does: no intent, just the setting.
          await api('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ chat: { autonomous: { enabled: true, maxRounds: 4 } } }),
          });

          // Opening the conversation is what notices.
          const leave = await lookIn(chatId);
          expect(await decided(chatId, messageId)).toBe('accepted');
          leave();

          await api(`/api/chat/conversations/${chatId}/stop`, { method: 'POST' });
        } finally {
          await api('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ chat: { autonomous: { enabled: false, maxRounds: 4 } } }),
          });
          await llama.close();
        }
      }, 40_000);

      /**
       * A run that stopped because it used its budget must not make the switch
       * a no-op — pressing it then looks exactly like the fault being fixed.
       *
       * So it is staged properly: one round allowed, spent, and the run parked
       * on the rewrite it was not allowed to take. Pressing ∞ again is fresh
       * permission and picks that rewrite up.
       */
      it('picks a run back up after it has spent its rounds', async () => {
        const llama = createMockLlama();
        const url = await llama.listen(0);

        try {
          await useLlama(url);
          await api('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({
              chat: {
                review: { enabled: true, threshold: 'balanced', askWhen: 'unsure' },
                autonomous: { enabled: true, maxRounds: 1 },
              },
            }),
          });

          const chat = await json<{ id: string }>(
            api('/api/chat/conversations', { method: 'POST' }),
          );
          await render('a lighthouse in fog');
          llama.script({
            toolCall: {
              name: 'build_prompt',
              arguments: { prompt: 'a lighthouse in fog', reason: 'Quiet.' },
            },
          });
          llama.script({
            content: 'The fog is thin.',
            toolCall: {
              name: 'revise_prompt',
              arguments: { prompt: 'a lighthouse in heavy fog', reason: 'More fog.', score: 5 },
            },
          });

          // One round is allowed and taken; the rewrite after it is not.
          const spent = await intent(chat.id, 'say', { content: 'build me a prompt' });
          expect(spent.phase).toBe('awaiting');
          expect(spent.round).toBe(1);
          expect(spent.note).toContain('1 of 1');
          const parked = spent.awaiting as string;
          expect(parked).toBeTruthy();

          // Pressing it again is permission, not a repeat of a setting already
          // set — the round count starts over and the rewrite is taken.
          llama.script({ content: 'Better.' });
          await setAutonomous(chat.id, true);
          expect(await decided(chat.id, parked)).toBe('accepted');

          await api(`/api/chat/conversations/${chat.id}/stop`, { method: 'POST' });
        } finally {
          await api('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ chat: { autonomous: { enabled: false, maxRounds: 4 } } }),
          });
          await llama.close();
        }
      }, 60_000);

      it('leaves a wandering run alone, which is a different thing entirely', async () => {
        const llama = createMockLlama();
        const url = await llama.listen(0);

        try {
          await useLlama(url);
          const chat = await json<{ id: string }>(
            api('/api/chat/conversations', { method: 'POST' }),
          );
          await intent(chat.id, 'wander', { on: true });
          const after = await setAutonomous(chat.id, true);
          expect(after.mode).toBe('wander');

          await api(`/api/chat/conversations/${chat.id}/stop`, { method: 'POST' });
        } finally {
          await api('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify({ chat: { autonomous: { enabled: false, maxRounds: 4 } } }),
          });
          await llama.close();
        }
      }, 40_000);
    });

    it('asks how to improve the match, and keeps the picture for the answer', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            chat: { review: { enabled: true, threshold: 'balanced', askWhen: 'often' } },
          }),
        });

        const { chatId, messageId } = await upToAPrompt(llama, 'a harbour at dawn');

        // Both are on offer: rewrite it, or ask which way to go.
        llama.script({
          content: 'The light is right; the harbour is not really there.',
          toolCall: {
            name: 'ask_user',
            arguments: {
              questions: [
                {
                  question: 'What should the rewrite chase?',
                  options: ['More of the harbour', 'Stronger light', 'Closer framing'],
                },
              ],
              reason: 'Several things are off at once.',
            },
          },
        });
        const run = await acceptAndRender(chatId, messageId);

        const offered = (
          llama.requests[llama.requests.length - 1] as { tools?: { function: { name: string } }[] }
        ).tools?.map((tool) => tool.function.name);
        expect(offered).toEqual(['revise_prompt', 'ask_user']);

        const nextMessageId = run.awaiting as string;

        /*
         * Answering it is an ordinary tool decision — and the turn it leads to
         * is still about the picture, so what that turn says is scripted before
         * the answer rather than after it.
         */
        llama.script({
          toolCall: {
            name: 'revise_prompt',
            arguments: {
              prompt: 'a working harbour at dawn, boats at the quay',
              reason: 'More harbour, as asked.',
              score: 5,
            },
          },
        });
        await intentRaw(chatId, 'decide', {
          messageId: nextMessageId,
          decision: 'accepted',
          note: 'More of the harbour.',
        });

        /*
         * Still the same review: the picture is there and the rewrite is still
         * on offer. Without that, answering the question would have ended the
         * review and thrown away the answer's whole purpose.
         */
        const after = llama.requests[llama.requests.length - 1] as {
          messages: { content: unknown }[];
          tools?: { function: { name: string } }[];
        };
        expect(JSON.stringify(after.messages)).toContain('image_url');
        expect(after.tools?.map((tool) => tool.function.name)).toContain('revise_prompt');

        // And the model is never shown the marker Latent stamped on its call.
        expect(JSON.stringify(after.messages)).not.toContain('fromReview');
      } finally {
        await llama.close();
      }
    }, 60_000);

    /**
     * How much a prompt spells out reaches the model as instructions.
     *
     * Not a length limit anywhere in the request: it is a section of the system
     * prompt, so it applies to a system prompt somebody wrote themselves as
     * well as to Latent's own.
     */
    it('tells the model how much detail a prompt should go into', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ chat: { promptDetail: 'elaborate' } }),
        });

        const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
        llama.script({ content: 'All right.' });
        await intent(chat.id, 'say', { content: 'hello' });

        const system = (
          llama.requests[llama.requests.length - 1] as { messages: { content: string }[] }
        ).messages[0]!;
        expect(system.content).toContain('How much detail a prompt goes into');
        expect(system.content).toContain('exhaustively');

        // And the other end of the scale says something else entirely.
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ chat: { promptDetail: 'sparse' } }),
        });
        llama.script({ content: 'Fine.' });
        await intent(chat.id, 'say', { content: 'again' });
        const after = (
          llama.requests[llama.requests.length - 1] as { messages: { content: string }[] }
        ).messages[0]!;
        expect(after.content).toContain('Leave everything else open');
        expect(after.content).not.toContain('exhaustively');
      } finally {
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ chat: { promptDetail: 'balanced' } }),
        });
        await llama.close();
      }
    }, 30_000);

    /**
     * The quiet end of the scale.
     *
     * "Look at it and tell me" without "and rewrite it" is a real way to work,
     * and it is the setting that makes the feature safe to leave on: the model
     * still sees the picture, it simply has nothing to propose with.
     */
    it('shows the picture but offers no rewrite at the lowest setting', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            chat: { review: { enabled: true, threshold: 'never', askWhen: 'never' } },
          }),
        });

        const { chatId, messageId } = await upToAPrompt(llama, 'a lighthouse in a storm');

        llama.script({ content: 'It matches well enough.' });
        await acceptAndRender(chatId, messageId);

        const { sent } = lastTurn(llama);
        expect(JSON.stringify(sent.messages)).toContain('image_url');
        expect(sent.tools).toBeUndefined();
      } finally {
        await llama.close();
      }
    }, 60_000);

    it('sends no picture at all when the check is switched off', async () => {
      const llama = createMockLlama();
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ chat: { review: { enabled: false, threshold: 'balanced' } } }),
        });

        const { chatId, messageId } = await upToAPrompt(llama, 'a field of rape in flower');

        llama.script({ content: 'Hope it came out well.' });
        await acceptAndRender(chatId, messageId);

        const { sent } = lastTurn(llama);
        expect(JSON.stringify(sent.messages)).not.toContain('image_url');
        expect(sent.tools).toBeUndefined();
      } finally {
        await llama.close();
      }
    }, 60_000);

    /**
     * A text-only server, which is what a refusal actually looks like.
     *
     * `llama-server` without a vision projector answers an image with an error
     * rather than ignoring it — and this setting is on by default, so that
     * error would land on somebody who never asked for any of it. The turn is
     * asked again without the picture instead.
     */
    it('falls back to the plain turn when the server cannot take a picture', async () => {
      const llama = createMockLlama({ refuseImages: true });
      const url = await llama.listen(0);

      try {
        await useLlama(url);
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ chat: { review: { enabled: true, threshold: 'balanced' } } }),
        });

        const { chatId, messageId } = await upToAPrompt(llama, 'a red bicycle against a wall');

        llama.script({ content: 'Hope that worked.' });
        const run = await acceptAndRender(chatId, messageId);

        // The reply arrives, and nothing is reported as broken.
        const stored = await json<{ messages: ChatMessage[] }>(
          api(`/api/chat/conversations/${chatId}`),
        );
        expect(stored.messages[stored.messages.length - 1]?.content).toBe('Hope that worked.');
        expect(run.error).toBeNull();

        // The retry is the turn as it always was: no picture, no tools.
        const { sent } = lastTurn(llama);
        expect(JSON.stringify(sent.messages)).not.toContain('image_url');
        expect(sent.tools).toBeUndefined();
      } finally {
        await llama.close();
      }
    }, 60_000);
  });

  /**
   * What the model is shown of a tool call it made earlier.
   *
   * Replayed on every request from then on, so a call carrying fields the tool
   * never declared teaches it to make the same malformed call again.
   */
  it('replays a tool call as its arguments alone', async () => {
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
          arguments: { prompt: 'a harbour at dawn', reason: 'Calm and blue.' },
        },
      });
      await intent(chat.id, 'say', { content: 'build me a prompt' });

      llama.script({ content: 'Anything else?' });
      await intent(chat.id, 'say', { content: 'thanks' });

      const sent = llama.requests[1] as {
        messages: {
          role: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        }[];
      };
      const replayed = sent.messages.find((message) => message.tool_calls)?.tool_calls?.[0];
      expect(replayed?.function.name).toBe('build_prompt');
      expect(replayed?.id).toBe('call_mock_1');
      expect(JSON.parse(replayed!.function.arguments)).toEqual({
        prompt: 'a harbour at dawn',
        reason: 'Calm and blue.',
      });
    } finally {
      await llama.close();
    }
  }, 30_000);

  /**
   * The turn after a picture is a sentence, not another proposal.
   *
   * Handed its tools back the moment a render was accepted, a model opens a
   * second prompt on top of the first — before anyone has seen what the first
   * one made, which is the only thing there would be to say about it.
   */
  it('offers no tools in the turn straight after a generation', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      /*
       * With the check switched off, so the turn after the render is the plain
       * one this test is about. With it on, that turn is a review — which is a
       * turn that deliberately *does* carry one tool, and is covered above.
       */
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ chat: { review: { enabled: false } } }),
      });
      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );
      await render('a harbour at dawn');

      llama.script({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a harbour at dawn', reason: 'Calm and blue.' },
        },
      });
      const run = await intent(chat.id, 'say', { content: 'build me a prompt' });
      const messageId = run.awaiting;

      /*
       * Accepted, which starts a run — and that is what makes the next turn
       * "after a generation" rather than after any other decision. Scripted
       * first, because accepting now carries straight on into that turn.
       */
      llama.script({ content: 'That came out well.' });
      await intentRaw(chat.id, 'decide', { messageId, decision: 'accepted' });

      const sent = llama.requests[llama.requests.length - 1] as {
        tools?: unknown[];
        tool_choice?: unknown;
      };
      expect(sent.tools).toBeUndefined();
      expect(sent.tool_choice).toBeUndefined();

      // And only for that one turn: saying something else puts them back.
      llama.script({ content: 'Anything else?' });
      await intent(chat.id, 'say', { content: 'make it colder' });
      const after = llama.requests[llama.requests.length - 1] as { tools?: unknown[] };
      expect(after.tools?.length).toBeGreaterThan(0);
    } finally {
      await llama.close();
    }
  }, 30_000);

  /** A decision that started nothing is answered straight away, tools and all. */
  it('keeps its tools after a decision that did not generate anything', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      llama.script({
        toolCall: {
          name: 'ask_user',
          arguments: {
            reason: 'It changes the framing.',
            questions: [{ question: 'Portrait or landscape?', options: ['Portrait'] }],
          },
        },
      });
      const run = await intent(chat.id, 'say', { content: 'something calm' });
      const messageId = run.awaiting;

      await intentRaw(chat.id, 'decide', { messageId, decision: 'accepted', note: 'Portrait' });

      llama.script({ content: 'Portrait it is.' });
      await settled(chat.id);

      const sent = llama.requests[llama.requests.length - 1] as { tools?: unknown[] };
      expect(sent.tools?.length).toBeGreaterThan(0);
    } finally {
      await llama.close();
    }
  }, 30_000);

  /**
   * The parameter it was asked for, and nothing else.
   *
   * The failure this guards against is the one that used to be here: a full set
   * of sampling values sent every time, overriding the flags llama-server was
   * launched with — a worse answer than its own, and one nobody could see being
   * applied. So the untouched request has to stay bare.
   */
  it('sends only the sampling parameters that were switched on', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      const chat = await json<{ id: string }>(
        api('/api/chat/conversations', { method: 'POST' }),
      );

      llama.script({ content: 'Sure.' });
      await intent(chat.id, 'say', { content: 'hello' });

      const untouched = llama.requests[0] as Record<string, unknown>;
      expect(untouched.temperature).toBeUndefined();
      expect(untouched.top_p).toBeUndefined();
      expect(untouched.min_p).toBeUndefined();
      expect(untouched.seed).toBeUndefined();

      const settings = await json<{ chat: ChatSettings }>(api('/api/settings'));
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            ...settings.chat,
            sampling: {
              ...defaultSampling(),
              temperature: { on: true, value: 0.35 },
              // Out of range on purpose: the clamping cannot live only in the
              // dialog, because settings are JSON and get edited by hand.
              top_k: { on: true, value: 9999 },
              // Carries a value but is off, so it stays out of the request.
              min_p: { on: false, value: 0.2 },
            },
          },
        }),
      });

      llama.script({ content: 'Colder, then.' });
      await intent(chat.id, 'say', { content: 'make it colder' });

      const sent = llama.requests[llama.requests.length - 1] as Record<string, unknown>;
      expect(sent.temperature).toBe(0.35);
      expect(sent.top_k).toBe(200);
      expect(sent.min_p).toBeUndefined();
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
    const response = await api(`/api/chat/conversations/${chat.id}/say`, {
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    });

    // Accepted, and the failure is reported on the run rather than as a status
    // code the chat screen would have to translate.
    expect(response.status).toBeLessThan(300);
    const run = await settled(chat.id);
    expect(run.error).toBeTruthy();
  }, 30_000);
});

/**
 * Video, end to end.
 *
 * A workflow ending in a video saver is the same workflow in every other
 * respect — it is queued, watched, rated and kept exactly like one that draws a
 * picture — and the differences are all in what comes back: which key ComfyUI
 * files it under, how it is fetched, and how it is stored. Each of those is a
 * place a still-image assumption used to sit.
 */
describe('audio workflows', () => {
  /** What every RIFF/WAVE file starts with, so "did we get it" has a real answer. */
  const RIFF = Buffer.from('RIFF', 'ascii');

  async function renderTrack(name: string, graph: unknown) {
    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', { method: 'POST', body: JSON.stringify({ name, graph }) }),
    );

    await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow.id,
        values: { '5.steps': 2, '2.text': `track for ${name}` },
      }),
    });

    const record = await waitFor(async () => {
      const page = await json<GalleryPage>(api('/api/gallery'));
      const found = page.items.find((item) => item.title === `track for ${name}`);
      return found && found.status === 'completed' && found.images.length > 0 ? found : null;
    }, 20_000);

    return { workflow, record, image: record.images[0] as GenerationRecord['images'][number] };
  }

  /**
   * A music model is a picture workflow that ends in a sound.
   *
   * Everything between the prompt and the save node is the same, which is why
   * this works at all — and everything after it differs: the output arrives
   * under a key nothing was reading, it has no frame to draw, and it is played
   * by asking for the middle of the file.
   */
  it('renders a track, streams it in ranges, and keeps it as itself', async () => {
    const { workflow, record, image } = await renderTrack('MiniMax Music', minimaxMusic);

    // Known before anything has run, off the graph's save node.
    expect(workflow.capabilities.audio).toBe(true);
    expect(workflow.capabilities.video).toBe(false);
    expect(workflow.producesAudio).toBe(true);
    // And the length is a field of its own — seconds, not frames.
    const seconds = workflow.schema.fields.find((field) => field.id === '4.seconds');
    expect(seconds?.role).toBe('seconds');
    expect(seconds?.group).toBe('main');

    expect(image.kind).toBe('audio');
    expect(image.filename.endsWith('.wav')).toBe(true);

    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
      id: String(image.id),
    });

    const whole = await api(`/api/view?${query}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('audio/wav');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    const full = Buffer.from(await whole.arrayBuffer());
    expect(full.subarray(0, 4)).toEqual(RIFF);

    // Seeking is the same byte range it is for a clip.
    const part = await api(`/api/view?${query}`, { headers: { range: 'bytes=0-43' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-43/${full.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(full.subarray(0, 44));

    /*
     * There is no preview and never will be. Said once, plainly, so the grid
     * draws its card instead of asking again for every tile.
     */
    const preview = await api(`/api/view?${query}&preview=webp;70`);
    expect(preview.status).toBe(404);
    const answer = await json<{ noPoster?: boolean; kind?: string }>(preview);
    expect(answer.noPoster).toBe(true);
    expect(answer.kind).toBe('audio');

    // A sound is not an input image, and saying which it is beats a PIL error.
    const toInput = await api('/api/images/to-input', {
      method: 'POST',
      body: JSON.stringify(image),
    });
    expect(toInput.status).toBe(400);
    expect((await json<{ error: string }>(toInput)).error).toMatch(/sound/i);

    // Rating copies it here, in the clear, for the same reason a clip is: a
    // track is played by asking for the middle of the file.
    const rated = await json<GenerationRecord>(
      api(`/api/gallery/${record.id}/rating`, {
        method: 'PUT',
        body: JSON.stringify({ image, rating: 5 }),
      }),
    );
    expect(rated.images[0]?.archived).toBe(true);

    const stored = (readdirSync(join(dataDir, 'archive'), { recursive: true }) as string[])
      .filter((entry) => entry.endsWith('.wav'))
      .map((entry) => readFileSync(join(dataDir, 'archive', entry)));
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((bytes) => !Vault.isEncrypted(bytes))).toBe(true);
    expect(stored[0]?.subarray(0, 4)).toEqual(RIFF);

    const archived = await api(`/api/view?${query}`, { headers: { range: 'bytes=4-11' } });
    expect(archived.status).toBe(206);
    expect(archived.headers.get('x-latent-source')).toBe('archive');
    expect(Buffer.from(await archived.arrayBuffer())).toEqual(full.subarray(4, 12));

    /*
     * How long it runs, from the only thing that can read it: the browser
     * playing it. The same route a video's poster arrives by, with no poster.
     */
    const timed = await api('/api/images/poster', {
      method: 'PUT',
      body: JSON.stringify({ image, durationMs: 30_000 }),
    });
    expect(timed.status).toBe(204);
    const after = await json<GenerationRecord>(api(`/api/gallery/${record.id}`));
    expect(after.images[0]?.durationMs).toBe(30_000);
    // And still no thumbnail: nothing invented a picture for it.
    expect(after.images[0]?.hasThumbnail).toBe(false);
  }, 40_000);

  /** The speech models file their result the same way, in a different container. */
  it('takes a speech workflow as an audio workflow too', async () => {
    const { workflow, image } = await renderTrack('Qwen speech', qwenSpeech);
    expect(workflow.producesAudio).toBe(true);
    expect(image.kind).toBe('audio');
    // The words to say are the prompt field, which is what makes the whole
    // chat module work for speech without knowing anything about speech.
    expect(workflow.schema.fields.find((field) => field.id === '2.text')?.role).toBe('prompt');
  }, 40_000);
});

describe('video workflows', () => {
  /** The bytes a WebM starts with, so "did we get the file" has a real answer. */
  const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

  async function renderVideo(name: string, graph: unknown) {
    const workflow = await json<WorkflowDetail>(
      api('/api/workflows', { method: 'POST', body: JSON.stringify({ name, graph }) }),
    );

    await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: workflow.id,
        values: { '8.steps': 2, '4.text': `clip for ${name}` },
      }),
    });

    const record = await waitFor(async () => {
      const page = await json<GalleryPage>(api('/api/gallery'));
      const found = page.items.find((item) => item.title === `clip for ${name}`);
      return found && found.status === 'completed' && found.images.length > 0 ? found : null;
    }, 20_000);

    return { workflow, record, image: record.images[0] as GenerationRecord['images'][number] };
  }

  it('renders a clip, streams it in ranges, and keeps it as itself', async () => {
    const { workflow, record, image } = await renderVideo('LTXV GGUF', ltxVideoGguf);

    // Known to be a video workflow before anything has run, off the graph.
    expect(workflow.capabilities.video).toBe(true);
    expect(workflow.producesVideo).toBe(true);
    // And the frame count is a field of its own rather than one more integer.
    const length = workflow.schema.fields.find((field) => field.id === '6.length');
    expect(length?.role).toBe('length');
    expect(length?.group).toBe('main');
    expect(
      workflow.schema.fields.find((field) => field.id === '7.frame_rate')?.role,
    ).toBe('frame_rate');
    // A quantised model is still the model picker.
    expect(workflow.schema.fields.find((field) => field.id === '1.unet_name')?.role).toBe('model');

    expect(image.filename.endsWith('.webm')).toBe(true);
    expect(image.kind).toBe('video');

    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
      id: String(image.id),
    });

    // Whole file, as a video, and announced as seekable.
    const whole = await api(`/api/view?${query}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/webm');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    const full = Buffer.from(await whole.arrayBuffer());
    expect(full.subarray(0, 4)).toEqual(EBML);

    /*
     * The part a browser actually asks for.
     *
     * A `<video>` fetches the head of the file, then whatever the scrubber
     * lands on. Answering those with the whole clip is the difference between
     * a video that starts and one that has to be downloaded first.
     */
    const part = await api(`/api/view?${query}`, { headers: { range: 'bytes=0-127' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-127/${full.length}`);
    const head = Buffer.from(await part.arrayBuffer());
    expect(head.length).toBe(128);
    expect(head).toEqual(full.subarray(0, 128));

    // No poster yet, and the grid is told so rather than handed the clip.
    const preview = await api(`/api/view?${query}&preview=webp;70`);
    expect(preview.status).toBe(404);
    expect((await json<{ noPoster?: boolean }>(preview)).noPoster).toBe(true);

    // img2img takes a picture. Saying so beats a PIL error from ComfyUI.
    const toInput = await api('/api/images/to-input', {
      method: 'POST',
      body: JSON.stringify(image),
    });
    expect(toInput.status).toBe(400);
    expect((await json<{ error: string }>(toInput)).error).toMatch(/video/i);

    /*
     * Rating copies it here, exactly as it does for a picture — and stores it
     * in the clear, which is the one deliberate difference. Whole-file AES
     * cannot be read from the middle, and a video is watched by asking for the
     * middle.
     */
    const rated = await json<GenerationRecord>(
      api(`/api/gallery/${record.id}/rating`, {
        method: 'PUT',
        body: JSON.stringify({ image, rating: 4 }),
      }),
    );
    expect(rated.images[0]?.archived).toBe(true);

    const stored = (readdirSync(join(dataDir, 'archive'), { recursive: true }) as string[])
      .filter((entry) => entry.endsWith('.webm'))
      .map((entry) => readFileSync(join(dataDir, 'archive', entry)));
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((bytes) => !Vault.isEncrypted(bytes))).toBe(true);
    expect(stored[0]?.subarray(0, 4)).toEqual(EBML);

    // Served from the archive now, still in pieces.
    const archived = await api(`/api/view?${query}`, { headers: { range: 'bytes=8-23' } });
    expect(archived.status).toBe(206);
    expect(archived.headers.get('x-latent-source')).toBe('archive');
    expect(Buffer.from(await archived.arrayBuffer())).toEqual(full.subarray(8, 24));

    /*
     * The poster, from the only thing here that can decode a video: the browser
     * playing it. Nothing on this server has an ffmpeg, and a clip with no
     * still is a gallery tile that has to load the clip.
     */
    const poster = renderPlaceholder(64, 48, 'poster');
    const sent = await api('/api/images/poster', {
      method: 'PUT',
      body: JSON.stringify({
        image,
        poster: `data:image/png;base64,${poster.toString('base64')}`,
        durationMs: 4000,
      }),
    });
    expect(sent.status).toBe(204);

    const withPoster = await json<GenerationRecord>(api(`/api/gallery/${record.id}`));
    expect(withPoster.images[0]?.hasThumbnail).toBe(true);
    expect(withPoster.images[0]?.durationMs).toBe(4000);

    const served = await api(`/api/view?${query}&preview=webp;70`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(readImageSize(Buffer.from(await served.arrayBuffer()))).toEqual({
      width: 64,
      height: 48,
    });

    // A poster is a picture of a video, so it is encrypted like every picture.
    const posterFiles = (readdirSync(join(dataDir, 'archive'), { recursive: true }) as string[])
      .filter((entry) => entry.endsWith('_t.png'))
      .map((entry) => readFileSync(join(dataDir, 'archive', entry)));
    expect(posterFiles.every((bytes) => Vault.isEncrypted(bytes))).toBe(true);
  }, 40_000);

  /**
   * The other convention.
   *
   * VideoHelperSuite files everything it makes under `gifs`, whatever the
   * container turned out to be. A client that reads only `images` finishes the
   * run successfully and shows an empty gallery row.
   */
  /**
   * A folder of finished work has clips in it too.
   *
   * They take the streaming, unencrypted path — a directory of renders is
   * gigabytes, and none of it has any business passing through a Buffer on the
   * way to disk — while the pictures beside them are read and encrypted exactly
   * as before.
   */
  it('imports a clip from a folder without encrypting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-import-video-'));
    const outputs = join(dir, 'outputs');
    mkdirSync(outputs, { recursive: true });

    const clip = renderPlaceholderWebm('imported');
    writeFileSync(join(outputs, 'clip.webm'), clip);
    writeFileSync(join(outputs, 'still.png'), renderPlaceholder(64, 64, 'still'));

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
        body: JSON.stringify({ password: 'import a clip' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      await server.call('/api/settings', {
        method: 'PATCH',
        cookie,
        body: JSON.stringify({ importRoot: outputs }),
      });

      const scan = (await (
        await server.call('/api/import/scan', { cookie })
      ).json()) as ImportScanResult;
      expect(scan.files.map((file) => file.path).sort()).toEqual(['clip.webm', 'still.png']);

      const result = (await (
        await server.call('/api/import', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ paths: ['clip.webm', 'still.png'], rating: 5 }),
        })
      ).json()) as ImportResult;
      expect(result).toMatchObject({ imported: 2, failed: [] });

      const page = (await (await server.call('/api/gallery', { cookie })).json()) as GalleryPage;
      const imported = page.items.flatMap((item) => item.images);
      const video = imported.find((image) => image.filename === 'clip.webm');
      expect(video?.kind).toBe('video');
      expect(video?.archived).toBe(true);

      // The clip is on disk as itself; the picture beside it is not.
      const archived = (readdirSync(join(dir, 'archive'), { recursive: true }) as string[])
        .map((name) => join(dir, 'archive', String(name)))
        .filter((candidate) => statSync(candidate).isFile());
      const webm = archived.filter((file) => file.endsWith('.webm'));
      expect(webm).toHaveLength(1);
      expect(readFileSync(webm[0] as string)).toEqual(clip);
      for (const file of archived.filter((candidate) => candidate.endsWith('.png'))) {
        expect(Vault.isEncrypted(readFileSync(file))).toBe(true);
      }

      // And it plays: an imported clip lives only here, so this is the only
      // place its bytes can come from.
      const query = new URLSearchParams({
        filename: 'clip.webm',
        subfolder: '',
        type: 'import',
        id: String(video?.id),
      });
      const part = await server.call(`/api/view?${query}`, {
        cookie,
        headers: { range: 'bytes=0-15' },
      });
      expect(part.status).toBe(206);
      expect(Buffer.from(await part.arrayBuffer())).toEqual(clip.subarray(0, 16));
    } finally {
      await server.dispose();
      await comfy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('reads a clip filed under another output key', async () => {
    const { image } = await renderVideo('Video Combine', videoCombine);

    expect(image.filename.endsWith('.gif')).toBe(true);
    expect(image.kind).toBe('video');

    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
      id: String(image.id),
    });
    const response = await api(`/api/view?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');

    const bytes = Buffer.from(await response.arrayBuffer());
    // A real GIF, not a placeholder: the mock renders one so the whole path —
    // including what a browser is asked to draw — is exercised for real.
    expect(bytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
  }, 40_000);
});

/**
 * Notes about what the user likes.
 *
 * Three things worth proving here and nowhere else: that the notes survive a
 * round trip through the API, that what lands on disk is ciphertext rather than
 * a description of somebody's taste, and that the active ones — and only those
 * — reach the model.
 */
/**
 * The conversation runs on the server, and that is the point.
 *
 * Everything the chat module does across several steps — accept a proposal,
 * queue the render, wait for it, say something about it, go round again — used
 * to be a sequence the browser drove. A backgrounded tab is frozen: its open
 * streams are cut, its timers slow to a crawl, and the step between two awaits
 * never runs. So a run stopped the moment you looked at something else, and
 * regularly stopped mid-step in a state nothing could continue from.
 *
 * These are the tests for the fix, and they are all the same shape: nobody is
 * watching, and it happens anyway.
 */
describe('a conversation that nobody is watching', () => {
  const render = async (prompt: string) => {
    const workflows = await json<{ id: string }[]>(api('/api/workflows'));
    if (workflows.length === 0) {
      await api('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'unwatched', graph: sd15Txt2Img }),
      });
    }
    return prompt;
  };

  /**
   * The whole round happens with no client attached at all.
   *
   * One request in, and by the time it has settled a prompt has been proposed,
   * accepted, rendered and judged — with nothing subscribed to the event stream
   * and nothing polled from outside. That is what a frozen tab looks like from
   * the server's side, and it is now indistinguishable from an open one.
   */
  it('finishes a whole round with nothing subscribed to it', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      await render('a quiet harbour');
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            promptButton: 'generate',
            review: { enabled: false, threshold: 'balanced', keepInView: 2, askWhen: 'never' },
            autonomous: { enabled: false, maxRounds: 4 },
          },
        }),
      });

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      llama.script({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a quiet harbour', reason: 'Calm.' },
        },
      });
      llama.script({ content: 'There it is.' });

      // "Generate now", which accepts whatever comes back without asking.
      const run = await intent(chat.id, 'prompt', { instant: true });

      // Nothing is waiting on anybody, and the picture exists.
      expect(run.phase).toBe('idle');
      expect(run.awaiting).toBeNull();

      const stored = await json<{ messages: ChatMessage[] }>(
        api(`/api/chat/conversations/${chat.id}`),
      );
      const rendered = stored.messages.find((message) => message.generationId);
      expect(rendered?.prompt).toBe('a quiet harbour');
      expect(stored.messages[stored.messages.length - 1]?.content).toBe('There it is.');

      // And the render is a real one in the gallery, queued by the server.
      const record = await json<GenerationRecord>(
        api(`/api/gallery/${rendered?.generationId as string}`),
      );
      expect(record.id).toBe(rendered?.generationId);
    } finally {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            promptButton: 'dialog',
            review: { enabled: true, threshold: 'balanced', keepInView: 2, askWhen: 'unsure' },
          },
        }),
      });
      await llama.close();
    }
  }, 60_000);

  /**
   * A wandering run keeps going with nobody there, and stops when told.
   *
   * The mode this rebuild was really for: an evening of pictures is worth
   * nothing if it ends the first time you open another app. Started, left
   * entirely alone, and three rounds later it has made three of them.
   */
  it('keeps a wandering run going with nobody there', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);
    let noteId = '';

    try {
      await useLlama(url);
      await render('a wandering picture');

      // A note to draw from, bought the same way the app buys one.
      const opened = await json<{ ticket: string }>(
        api('/api/taste/unlock', {
          method: 'POST',
          body: JSON.stringify({ password: 'test-password' }),
        }),
      );
      noteId = (
        await json<{ id: string }>(
          api('/api/taste/entries', {
            method: 'POST',
            body: JSON.stringify({ text: 'low fog over water' }),
            headers: { 'x-latent-taste': opened.ticket },
          }),
        )
      ).id;

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      for (const round of [1, 2, 3, 4]) {
        llama.script({
          toolCall: {
            name: 'build_prompt',
            arguments: { prompt: `wandering ${round}`, reason: 'From the notes.' },
          },
        });
      }

      await startWandering(chat.id);
      // At least three, not exactly: the run does not pause to be counted, and
      // "it kept going" is the claim.
      const made = await wandered(chat.id, 3, 60_000);
      expect(made.length).toBeGreaterThanOrEqual(3);

      // Stopping is immediate, and it stays stopped.
      await stopWandering(chat.id);
      const after = await json<{ run: ChatRun }>(api(`/api/chat/conversations/${chat.id}`));
      expect(after.run.mode).toBe('manual');
      expect(after.run.phase).toBe('idle');
    } finally {
      const opened = await json<{ ticket: string }>(
        api('/api/taste/unlock', {
          method: 'POST',
          body: JSON.stringify({ password: 'test-password' }),
        }),
      );
      if (noteId) {
        await api(`/api/taste/entries/${noteId}`, {
          method: 'DELETE',
          headers: { 'x-latent-taste': opened.ticket },
        });
      }
      await llama.close();
    }
  }, 90_000);

  /**
   * A restart picks the run back up.
   *
   * The other thing a browser-driven loop could never survive. A wandering run
   * is meant to go all evening, and this server is restarted often — updated,
   * crashed, rebooted — so a run that quietly ended each time was a run that
   * ended most evenings. Where a conversation had got to is written down at
   * every transition, so a fresh process can read it and carry on.
   *
   * The one exception is deliberate: an ordinary reply interrupted mid-sentence
   * is *not* re-asked. Nobody wants a model answering an hour-old message on
   * its own initiative, so that one stops and says why.
   */
  it('picks a wandering run back up after a restart', async () => {
    const llama = createMockLlama();
    const llamaUrl = await llama.listen(0);
    const root = mkdtempSync(join(tmpdir(), 'latent-resume-'));
    const dir = join(root, 'data');

    const boot = async () => {
      const instance = await buildApp({
        comfyUrl: 'http://127.0.0.1:1',
        dbPath: join(dir, 'latent.db'),
        dataDir: dir,
        stateDir: join(root, 'above'),
        webDir: join(dir, 'no-web'),
        password: 'resume-password',
        logLevel: 'silent',
      });
      await instance.app.listen({ port: 0, host: '127.0.0.1' });
      const address = instance.app.server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const base = `http://127.0.0.1:${address.port}`;
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'resume-password' }),
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      const call = (path: string, init: RequestInit = {}) =>
        fetch(`${base}${path}`, {
          ...init,
          headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
        });
      return { instance, call };
    };

    const one = await boot();
    let chatId = '';
    try {
      await one.call('/api/connections', {
        method: 'POST',
        body: JSON.stringify({ kind: 'llama', name: 'model', url: llamaUrl }),
      });
      const connections = (await (await one.call('/api/connections')).json()) as {
        id: string;
        kind: string;
      }[];
      const model = connections.find((entry) => entry.kind === 'llama')!;
      await one.call(`/api/connections/${model.id}/activate`, { method: 'POST' });

      chatId = (
        (await (await one.call('/api/chat/conversations', { method: 'POST' })).json()) as {
          id: string;
        }
      ).id;

      llama.script({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'before the restart', reason: 'From the notes.' },
        },
      });
      await one.call(`/api/chat/conversations/${chatId}/wander`, {
        method: 'POST',
        body: JSON.stringify({ on: true }),
      });

      // Wait until the run is genuinely under way before pulling the plug.
      const deadline = Date.now() + 20_000;
      for (;;) {
        const detail = (await (
          await one.call(`/api/chat/conversations/${chatId}`)
        ).json()) as { run: ChatRun };
        if (detail.run.mode === 'wander') break;
        if (Date.now() > deadline) throw new Error('The run never started');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await one.instance.app.close();
    }

    // A new process, the same database, and a run it never started.
    llama.script({
      toolCall: {
        name: 'build_prompt',
        arguments: { prompt: 'after the restart', reason: 'From the notes.' },
      },
    });

    const two = await boot();
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const detail = (await (
          await two.call(`/api/chat/conversations/${chatId}`)
        ).json()) as { messages: ChatMessage[] };
        const asked = detail.messages.some(
          (message) =>
            message.toolCall?.tool === 'build_prompt' &&
            message.toolCall.prompt === 'after the restart',
        );
        if (asked) break;
        if (Date.now() > deadline) throw new Error('The run did not resume');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await two.call(`/api/chat/conversations/${chatId}/stop`, { method: 'POST' });
    } finally {
      await two.instance.app.close();
      await llama.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  /**
   * Two watchers see the same thing, and a late one is caught up.
   *
   * The other half of moving the loop: a stream that only exists while a
   * request is in flight cannot tell you about anything that happened while you
   * were away. This one opens with the present tense, so arriving late and
   * arriving early are the same path.
   */
  it('tells a client that arrives late what it missed', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));

      llama.script({ content: 'Something you did not see happen.' });
      await intent(chat.id, 'say', { content: 'say something' });

      // Subscribing afterwards still describes where the conversation is.
      const events = await watching(chat.id, async () => undefined);
      const sync = events.find((event) => event.type === 'sync');
      expect(sync).toBeTruthy();
      expect(sync?.type === 'sync' && sync.run.phase).toBe('idle');

      const stored = await json<{ messages: ChatMessage[] }>(
        api(`/api/chat/conversations/${chat.id}`),
      );
      expect(stored.messages[stored.messages.length - 1]?.content).toBe(
        'Something you did not see happen.',
      );
    } finally {
      await llama.close();
    }
  }, 30_000);
});

describe('what the user likes', () => {
  const categories: string[] = [];
  const entries: string[] = [];

  /**
   * The pass this screen's routes need, bought with the password.
   *
   * Being signed in is deliberately not enough for these: see `PasswordGate`. The
   * tests buy one the same way the app does, which is also what proves the
   * routes are shut without it.
   */
  let ticket = '';

  const taste = (path: string, init: RequestInit = {}) =>
    api(path, { ...init, headers: { ...(init.headers ?? {}), 'x-latent-taste': ticket } });

  beforeAll(async () => {
    const opened = await json<{ ticket: string }>(
      api('/api/taste/unlock', {
        method: 'POST',
        body: JSON.stringify({ password: 'test-password' }),
      }),
    );
    ticket = opened.ticket;
  });

  afterAll(async () => {
    for (const id of entries) await taste(`/api/taste/entries/${id}`, { method: 'DELETE' });
    for (const id of categories) await taste(`/api/taste/categories/${id}`, { method: 'DELETE' });
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ chat: { taste: 'hints' } }) });
  });

  it('keeps categories, notes filed under them, and notes filed under nothing', async () => {
    const colour = await json<TasteCategory>(
      taste('/api/taste/categories', { method: 'POST', body: JSON.stringify({ name: 'Colour' }) }),
    );
    categories.push(colour.id);
    expect(colour.name).toBe('Colour');
    expect(colour.active).toBe(true);

    const filed = await json<TasteEntry>(
      taste('/api/taste/entries', {
        method: 'POST',
        body: JSON.stringify({ text: 'washed-out teal', categoryId: colour.id }),
      }),
    );
    // A heading is optional by design: being made to file everything is how a
    // list like this ends up empty.
    const loose = await json<TasteEntry>(
      taste('/api/taste/entries', {
        method: 'POST',
        body: JSON.stringify({ text: 'rain at night' }),
      }),
    );
    entries.push(filed.id, loose.id);
    expect(filed.categoryId).toBe(colour.id);
    expect(loose.categoryId).toBe(null);

    const profile = await json<TasteProfile>(taste('/api/taste'));
    expect(profile.categories.map((entry) => entry.name)).toContain('Colour');
    expect(profile.entries.map((entry) => entry.text).sort()).toEqual([
      'rain at night',
      'washed-out teal',
    ]);

    // Switching one off is a tap, not a deletion: changing your mind for an
    // evening should not cost you the note.
    const off = await json<TasteEntry>(
      taste(`/api/taste/entries/${loose.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: false }),
      }),
    );
    expect(off.active).toBe(false);
    expect(off.text).toBe('rain at night');
  }, 20_000);

  /** Deleting the heading is not deleting what was written under it. */
  it('sets a category’s notes loose rather than deleting them with it', async () => {
    const temporary = await json<TasteCategory>(
      taste('/api/taste/categories', { method: 'POST', body: JSON.stringify({ name: 'Passing' }) }),
    );
    const note = await json<TasteEntry>(
      taste('/api/taste/entries', {
        method: 'POST',
        body: JSON.stringify({ text: 'brutalist stairwells', categoryId: temporary.id }),
      }),
    );
    entries.push(note.id);

    expect((await taste(`/api/taste/categories/${temporary.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );

    const profile = await json<TasteProfile>(taste('/api/taste'));
    const survivor = profile.entries.find((entry) => entry.id === note.id);
    expect(survivor?.text).toBe('brutalist stairwells');
    expect(survivor?.categoryId).toBe(null);
  }, 20_000);

  /**
   * The reason the feature is encrypted at all.
   *
   * These notes are never on screen, so nobody would notice them sitting
   * readable in a database file or a backup — which is exactly the situation
   * this test rules out.
   */
  it('writes ciphertext to the database, not words', async () => {
    const category = await json<TasteCategory>(
      taste('/api/taste/categories', {
        method: 'POST',
        body: JSON.stringify({ name: 'Distinctive heading' }),
      }),
    );
    const entry = await json<TasteEntry>(
      taste('/api/taste/entries', {
        method: 'POST',
        body: JSON.stringify({ text: 'an unmistakable phrase', categoryId: category.id }),
      }),
    );
    categories.push(category.id);
    entries.push(entry.id);

    const db = new Database(join(dataDir, 'test.db'), { readonly: true });
    try {
      const storedName = db
        .prepare<[string], { name: string }>('SELECT name FROM taste_categories WHERE id = ?')
        .get(category.id)?.name;
      const storedText = db
        .prepare<[string], { text: string }>('SELECT text FROM taste_entries WHERE id = ?')
        .get(entry.id)?.text;

      expect(storedName).toBeTruthy();
      expect(storedName).not.toContain('Distinctive heading');
      expect(storedText).not.toContain('unmistakable');
      // Latent's own envelope, so a stray plaintext row would be obvious.
      expect(Vault.isEncrypted(Buffer.from(storedText ?? '', 'base64'))).toBe(true);

      // What is *not* encrypted is what the screen needs to work while locked:
      // the order, the switches, and which heading a note is under.
      const row = db
        .prepare<[string], { active: number; category_id: string | null }>(
          'SELECT active, category_id FROM taste_entries WHERE id = ?',
        )
        .get(entry.id);
      expect(row?.active).toBe(1);
      expect(row?.category_id).toBe(category.id);
    } finally {
      db.close();
    }
  }, 20_000);

  it('puts the active notes in front of the model, and nothing else', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);

      const category = await json<TasteCategory>(
        taste('/api/taste/categories', { method: 'POST', body: JSON.stringify({ name: 'Weather' }) }),
      );
      const kept = await json<TasteEntry>(
        taste('/api/taste/entries', {
          method: 'POST',
          body: JSON.stringify({ text: 'low fog over water', categoryId: category.id }),
        }),
      );
      const silenced = await json<TasteEntry>(
        taste('/api/taste/entries', {
          method: 'POST',
          body: JSON.stringify({ text: 'bright noon sun', categoryId: category.id }),
        }),
      );
      categories.push(category.id);
      entries.push(kept.id, silenced.id);
      await taste(`/api/taste/entries/${silenced.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: false }),
      });

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      llama.script({ content: 'Right.' });
      await intent(chat.id, 'say', { content: 'give me an idea' });

      const system = (
        llama.requests[llama.requests.length - 1] as { messages: { content: string }[] }
      ).messages[0]!;
      expect(system.content).toContain('What this person likes');
      expect(system.content).toContain('low fog over water');
      expect(system.content).not.toContain('bright noon sun');
      // The rule the whole feature hangs on, at every level of the scale.
      expect(system.content).toContain('never overrule what was said');

      // Switched off, and the section is gone entirely — not present and empty,
      // which is the version a small model fills in for itself.
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ chat: { taste: 'off' } }),
      });
      llama.script({ content: 'Fine.' });
      await intent(chat.id, 'say', { content: 'again' });
      const after = (
        llama.requests[llama.requests.length - 1] as { messages: { content: string }[] }
      ).messages[0]!;
      expect(after.content).not.toContain('What this person likes');
      expect(after.content).not.toContain('low fog over water');
    } finally {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ chat: { taste: 'hints' } }),
      });
      await llama.close();
    }
  }, 30_000);

  /**
   * A pinned note overrides the scale — and only where it is relevant.
   *
   * The rest of the notes step aside the moment a picture is named, which is
   * exactly when a settled preference matters most. What keeps that from
   * turning into "work this into every prompt" is the relevance limit, which
   * goes in beside it.
   */
  it('sends a pinned note as a rule that holds, bounded by relevance', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      const pinned = await json<TasteEntry>(
        taste('/api/taste/entries', {
          method: 'POST',
          body: JSON.stringify({ text: 'never any text in the picture', always: true }),
        }),
      );
      const ordinary = await json<TasteEntry>(
        taste('/api/taste/entries', {
          method: 'POST',
          body: JSON.stringify({ text: 'low fog over water' }),
        }),
      );
      entries.push(pinned.id, ordinary.id);
      expect(pinned.always).toBe(true);
      expect(ordinary.always).toBe(false);

      // At the quietest setting the ordinary notes barely reach; the pinned one
      // reaches all the same, which is the point of the override.
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ chat: { taste: 'sparingly' } }),
      });

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      llama.script({ content: 'Right.' });
      await intent(chat.id, 'say', { content: 'a portrait of a fisherman, close up' });

      const system = (
        llama.requests[llama.requests.length - 1] as { messages: { content: string }[] }
      ).messages[0]!;
      expect(system.content).toContain('Things that always hold');
      expect(system.content).toContain('never any text in the picture');
      expect(system.content).toContain('even when they have told you exactly what they want');
      expect(system.content).toContain('only where it actually bears on the picture');
      // Listed once, as a rule — not again among the ordinary notes.
      expect(system.content.match(/never any text in the picture/g)).toHaveLength(1);

      // Unpinning puts it back among the rest.
      await taste(`/api/taste/entries/${pinned.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ always: false }),
      });
      llama.script({ content: 'Fine.' });
      await intent(chat.id, 'say', { content: 'again' });
      const after = (
        llama.requests[llama.requests.length - 1] as { messages: { content: string }[] }
      ).messages[0]!;
      expect(after.content).not.toContain('Things that always hold');
      expect(after.content).toContain('never any text in the picture');
    } finally {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ chat: { taste: 'hints' } }),
      });
      await llama.close();
    }
  }, 30_000);

  /**
   * A wandering round: the draw happens here, and says what it drew.
   *
   * The draw is the server's because the notes are encrypted here. What goes
   * back is the prompt and the handful of notes *this round* used — never the
   * profile, which stays behind the password. And what is stored is their ids,
   * not their words: a chat message is written to the database in the clear,
   * and the whole reason these notes are encrypted is that nobody would think
   * to look at them.
   */
  it('makes a picture out of a few notes, and records which ones', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);

      /*
       * A pool of exactly three, so "two were drawn" means something.
       *
       * The tests above this one leave their notes for the shared cleanup, and
       * a draw of two out of nine says nothing about how many were asked for.
       */
      const before = await json<TasteProfile>(taste('/api/taste'));
      for (const entry of before.entries) {
        await taste(`/api/taste/entries/${entry.id}`, { method: 'DELETE' });
      }

      const written = ['low fog over water', 'brutalist stairwells', 'washed-out teal'];
      for (const text of written) {
        const made = await json<TasteEntry>(
          taste('/api/taste/entries', { method: 'POST', body: JSON.stringify({ text }) }),
        );
        entries.push(made.id);
      }
      /*
       * A ceiling of two, and the caps out of the way.
       *
       * These three notes are filed under nothing, and the loose pile is one
       * heading as far as the caps are concerned — so under the default cap of
       * one per heading a round would take one of them and this would be
       * testing the cap rather than the count it is about.
       */
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            wander: {
              attributes: 2,
              sampling: 'chat',
              draw: { ...DEFAULT_WANDER_DRAW, perCategory: 0 },
            },
          },
        }),
      });

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      llama.script({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a flooded stairwell at dawn', reason: 'Drawn from the notes.' },
        },
      });
      /*
       * Wandering is a loop, so it is started and then stopped rather than
       * awaited: "one round" is a thing to catch, not a request to finish.
       */
      await startWandering(chat.id);
      const rounds = await wandered(chat.id, 1);
      await stopWandering(chat.id);

      const sent = llama.requests[0] as {
        messages: { role: string; content: string }[];
        tools?: { function: { name: string } }[];
      };
      const turn = sent.messages[sent.messages.length - 1]!;

      // Exactly the number asked for, and only from what is switched on.
      const drawn = written.filter((text) => turn.content.includes(text));
      expect(drawn).toHaveLength(2);
      expect(turn.content).toContain('drawn at random');
      // One tool, and it is the one that writes a prompt.
      expect(sent.tools?.map((tool) => tool.function.name)).toEqual(['build_prompt']);

      /*
       * And the call is stamped as a wandering one, which is what makes
       * tapping its picture open what made it rather than the viewer.
       */
      const call = rounds[0]?.toolCall;
      expect(call?.tool).toBe('build_prompt');
      expect(call?.tool === 'build_prompt' && call.fromWander).toBe(true);

      /*
       * And it says what it was made of — which is the one question an endless
       * stream raises, and one the mode used to have no answer to.
       */
      const notes = call?.tool === 'build_prompt' ? (call.wanderNotes ?? []) : [];
      expect(notes.sort()).toEqual(drawn.sort());
      // The ids are what actually went to disk; the words were put back on the
      // way out. Both halves have to be there or the round cannot avoid
      // repeating itself later.
      const ids = call?.tool === 'build_prompt' ? (call.wanderNoteIds ?? []) : [];
      expect(ids).toHaveLength(2);
      for (const id of ids) expect(entries).toContain(id);
    } finally {
      // Back to the shipped defaults, not to the numbers this test chose.
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: { wander: { attributes: 0, sampling: 'chat', draw: { ...DEFAULT_WANDER_DRAW } } },
        }),
      });
      await llama.close();
    }
  }, 30_000);

  /**
   * What the mode does out of the box: one note from each heading.
   *
   * The headings are the thing you curated — a colour heading, a films heading,
   * a mood heading — so a picture built from one of each is a picture made of
   * your list. The default used to be a flat shuffle of a fixed three, which
   * will happily take three films and no colour because one heading won the
   * toss, and then every round is three ways of saying the same thing.
   *
   * Nothing is configured here on purpose. The settings are the shipped ones,
   * and what is under test is that they are the ones that do this.
   */
  it('draws one note from each heading, with nothing configured', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);

      const before = await json<TasteProfile>(taste('/api/taste'));
      for (const entry of before.entries) {
        await taste(`/api/taste/entries/${entry.id}`, { method: 'DELETE' });
      }
      for (const category of before.categories) {
        await taste(`/api/taste/categories/${category.id}`, { method: 'DELETE' });
      }

      // Two headings with two notes each: a round that took both from one of
      // them would be the old behaviour, and is what this rules out.
      const headings: Record<string, string[]> = {
        Colour: ['washed-out teal', 'sodium orange'],
        Films: ['Portra 400', 'Ilford HP5'],
      };
      const byNote = new Map<string, string>();
      for (const [name, texts] of Object.entries(headings)) {
        const category = await json<{ id: string }>(
          taste('/api/taste/categories', { method: 'POST', body: JSON.stringify({ name }) }),
        );
        categories.push(category.id);
        for (const text of texts) {
          const made = await json<TasteEntry>(
            taste('/api/taste/entries', {
              method: 'POST',
              body: JSON.stringify({ text, categoryId: category.id }),
            }),
          );
          entries.push(made.id);
          byNote.set(text, name);
        }
      }

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      llama.script({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a teal harbour on Portra', reason: 'Drawn from the notes.' },
        },
      });

      await startWandering(chat.id);
      const rounds = await wandered(chat.id, 1);
      await stopWandering(chat.id);

      const call = rounds[0]?.toolCall;
      const notes = call?.tool === 'build_prompt' ? (call.wanderNotes ?? []) : [];

      // One from each heading: two notes, and one of them from each.
      expect(notes).toHaveLength(2);
      expect(notes.map((text) => byNote.get(text)).sort()).toEqual(['Colour', 'Films']);
    } finally {
      await llama.close();
    }
  }, 30_000);

  /**
   * Every round starts from nothing.
   *
   * The mode is a fresh draw from the notes, not a conversation, and it used to
   * be sent the whole transcript anyway — so each round wrote its prompt with
   * every earlier prompt in front of it. A model handed twenty variations on a
   * theme continues the theme: round twenty is about round nineteen, and the
   * notes it was supposedly drawn from are a footnote under a page of its own
   * work. The instruction fought that in prose, which is asking a model to
   * ignore the largest thing in its context.
   *
   * So the shape of the request is the thing under test, and it is the same
   * shape on the fourth round as on the first: a system prompt and one turn.
   */
  it('shows a wandering round nothing it has already written', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);

      const before = await json<TasteProfile>(taste('/api/taste'));
      for (const entry of before.entries) {
        await taste(`/api/taste/entries/${entry.id}`, { method: 'DELETE' });
      }
      for (const text of ['low fog over water', 'brutalist stairwells', 'washed-out teal']) {
        const made = await json<TasteEntry>(
          taste('/api/taste/entries', { method: 'POST', body: JSON.stringify({ text }) }),
        );
        entries.push(made.id);
      }

      /*
       * Something to render with, or the run stops after one round with
       * "nothing to generate with" — and one round proves nothing about what
       * the second one is shown.
       */
      const workflows = await json<{ id: string }[]>(api('/api/workflows'));
      if (workflows.length === 0) {
        await api('/api/workflows', {
          method: 'POST',
          body: JSON.stringify({ name: 'wandering', graph: sd15Txt2Img }),
        });
      }

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      // Distinct per round, so "the next one never saw it" can be asserted on
      // the words themselves rather than on a message count alone.
      const written = ['a flooded stairwell', 'a brass door in fog', 'a wet platform at night'];
      for (const prompt of written) {
        llama.script({
          toolCall: {
            name: 'build_prompt',
            arguments: { prompt, reason: 'Drawn from the notes.' },
          },
        });
      }

      /*
       * Waited on by request rather than by round.
       *
       * `wandered` counts stored messages carrying a wandering call, and an
       * accepted round stores two of those — the proposal and the tool result
       * that answers it — so asking it for three would settle after two rounds.
       * What this test is about is what the model was sent, so that is what it
       * waits for.
       */
      await startWandering(chat.id);
      const deadline = Date.now() + 20_000;
      while (llama.requests.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await stopWandering(chat.id);

      const sent = llama.requests.slice(0, 3) as {
        messages: { role: string; content: unknown }[];
      }[];
      expect(sent).toHaveLength(3);

      for (const [index, request] of sent.entries()) {
        /*
         * Two messages, always: the system prompt and the round's own
         * instruction. Growing by two a round is exactly the drift this fixes,
         * so the count is asserted rather than merely "no earlier prompt in
         * here" — a transcript that came back in some other shape would slip
         * past the looser check.
         */
        expect({ round: index, roles: request.messages.map((message) => message.role) }).toEqual({
          round: index,
          roles: ['system', 'user'],
        });
      }

      // And in particular, not a word of what the rounds before it wrote.
      for (const [index, request] of sent.entries()) {
        const text = JSON.stringify(request.messages);
        for (const earlier of written.slice(0, index)) {
          expect({ round: index, sawEarlier: text.includes(earlier) }).toEqual({
            round: index,
            sawEarlier: false,
          });
        }
      }
    } finally {
      await llama.close();
    }
  }, 30_000);

  /**
   * The rules that make the mode usable on a list anyone has curated.
   *
   * A flat shuffle treats a heading of near-synonyms and a heading of settled
   * decisions as the same thing, and the result is four ways of saying "teal"
   * in one picture and the format note never turning up. This is the whole
   * feature in one round: a heading that must be in it, a heading that must
   * not, and a cap that stops any one of them taking over.
   */
  it('draws under the rules: one heading always, one never, one at a time', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);

      // A clean slate, so what comes back names the rules rather than the
      // leftovers of whatever ran before.
      const before = await json<TasteProfile>(taste('/api/taste'));
      for (const entry of before.entries) {
        await taste(`/api/taste/entries/${entry.id}`, { method: 'DELETE' });
      }
      for (const category of before.categories) {
        await taste(`/api/taste/categories/${category.id}`, { method: 'DELETE' });
      }

      const heading = async (name: string) => {
        const made = await json<TasteCategory>(
          taste('/api/taste/categories', { method: 'POST', body: JSON.stringify({ name }) }),
        );
        categories.push(made.id);
        return made.id;
      };
      const wrote = async (categoryId: string | null, text: string) => {
        const made = await json<TasteEntry>(
          taste('/api/taste/entries', {
            method: 'POST',
            body: JSON.stringify({ text, categoryId }),
          }),
        );
        entries.push(made.id);
        return made.id;
      };

      const format = await heading('Format');
      const colour = await heading('Colour');
      const later = await heading('Ideas for later');

      await wrote(format, 'shot on 6x6 film');
      const colours = ['washed-out teal', 'sodium amber', 'cold grey-green'];
      for (const text of colours) await wrote(colour, text);
      await wrote(later, 'a lighthouse someday');

      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            wander: {
              attributes: 3,
              sampling: 'chat',
              draw: {
                perCategory: 1,
                loose: 'draw',
                pinned: 'draw',
                avoidRepeats: 0,
                categories: {
                  [format]: { role: 'always', max: 0 },
                  [later]: { role: 'off', max: 0 },
                },
              },
            },
          },
        }),
      });

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      llama.script({
        toolCall: {
          name: 'build_prompt',
          arguments: { prompt: 'a square photograph', reason: 'From the notes.' },
        },
      });
      await startWandering(chat.id);
      await wandered(chat.id, 1);
      await stopWandering(chat.id);

      const sent = llama.requests[0] as {
        messages: { role: string; content: string }[];
      };
      const turn = sent.messages[sent.messages.length - 1]!.content;

      // The heading that insists is in it.
      expect(turn).toContain('shot on 6x6 film');
      // The one switched out of wandering is not — though it is still a note,
      // and still switched on for the chat.
      expect(turn).not.toContain('a lighthouse someday');
      // And the heading of near-synonyms contributed exactly one of its three.
      expect(colours.filter((text) => turn.includes(text))).toHaveLength(1);
    } finally {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: { wander: { attributes: 3, sampling: 'chat', draw: DEFAULT_WANDER_DRAW } },
        }),
      });
      await llama.close();
    }
  }, 30_000);

  /**
   * Two rounds running, and the second one does not repeat the first.
   *
   * The fault of a long run is not repeated pictures, it is repeated notes: a
   * short list will show you the same one twice within a minute. The previous
   * round's notes are read back out of the conversation, so this survives a
   * restart — which is the only place it matters.
   */
  it('keeps the last round’s notes out of the next one', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);

      const before = await json<TasteProfile>(taste('/api/taste'));
      for (const entry of before.entries) {
        await taste(`/api/taste/entries/${entry.id}`, { method: 'DELETE' });
      }

      const written = ['low fog over water', 'brutalist stairwells', 'a wet street at night'];
      for (const text of written) {
        const made = await json<TasteEntry>(
          taste('/api/taste/entries', { method: 'POST', body: JSON.stringify({ text }) }),
        );
        entries.push(made.id);
      }

      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            wander: {
              attributes: 1,
              sampling: 'chat',
              draw: { ...DEFAULT_WANDER_DRAW, avoidRepeats: 1 },
            },
          },
        }),
      });

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      for (const round of [1, 2, 3]) {
        llama.script({
          toolCall: {
            name: 'build_prompt',
            arguments: { prompt: `round ${round}`, reason: 'From the notes.' },
          },
        });
      }

      // Three rounds of one run, rather than three runs: what is being tested
      // is what the *second* round knows about the first.
      await startWandering(chat.id);
      await wandered(chat.id, 3);
      await stopWandering(chat.id);

      const asked = llama.requests.slice(0, 3).map((request) => {
        const sent = request as { messages: { content: string }[] };
        const turn = sent.messages[sent.messages.length - 1]!.content;
        return written.find((text) => turn.includes(text)) ?? '';
      });

      // Each round drew one note, and never the one immediately before it.
      expect(asked.every((text) => text !== '')).toBe(true);
      expect(asked[1]).not.toBe(asked[0]);
      expect(asked[2]).not.toBe(asked[1]);
    } finally {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: { wander: { attributes: 3, sampling: 'chat', draw: DEFAULT_WANDER_DRAW } },
        }),
      });
      await llama.close();
    }
  }, 30_000);

  /**
   * Sampling of its own, because this is not a conversation.
   *
   * Nobody reads the words, the same few notes come round again, and a model at
   * its careful settings writes the same prompt from them every time.
   */
  it('sends the wandering run’s own sampling when it has been given one', async () => {
    const llama = createMockLlama();
    const url = await llama.listen(0);

    try {
      await useLlama(url);
      /*
       * Both ends set explicitly, because this is about them differing.
       *
       * The conversation's own sampling is whatever an earlier test left it as,
       * and "the plain turn did not send 1.4" would pass on a suite that had
       * never set anything at all.
       */
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            sampling: { ...defaultSampling(), temperature: { on: true, value: 0.2 } },
            wander: {
              attributes: 1,
              sampling: 'own',
              ownSampling: { ...defaultSampling(), temperature: { on: true, value: 1.4 } },
            },
          },
        }),
      });

      const chat = await json<{ id: string }>(api('/api/chat/conversations', { method: 'POST' }));
      llama.script({
        toolCall: { name: 'build_prompt', arguments: { prompt: 'something else', reason: 'x' } },
      });
      await startWandering(chat.id);
      await wandered(chat.id, 1);
      await stopWandering(chat.id);

      const sent = llama.requests[0] as Record<string, unknown>;
      expect(sent.temperature).toBe(1.4);

      // …and an ordinary turn is untouched by it.
      llama.script({ content: 'Fine.' });
      await intent(chat.id, 'say', { content: 'hello' });
      const plain = llama.requests[llama.requests.length - 1] as Record<string, unknown>;
      expect(plain.temperature).toBe(0.2);
    } finally {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          chat: {
            sampling: defaultSampling(),
            wander: { attributes: 3, sampling: 'chat', ownSampling: defaultSampling() },
          },
        }),
      });
      await llama.close();
    }
  }, 30_000);

  /**
   * Being signed in is not enough for this one screen.
   *
   * Everything else in the app is pictures and settings, which a phone on a
   * table shows to whoever picks it up. This is a description of a person, and
   * the reason it is encrypted on disk is that nobody would think to look at
   * it — so the door asks again, and asks the server rather than the browser.
   */
  it('refuses the notes to a session that has not given the password', async () => {
    const server = await bootIsolated();
    try {
      const claim = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });
      const cookie = claim.headers.get('set-cookie')?.split(';')[0] ?? '';

      // Signed in, and still shut — with a marker the screen can act on rather
      // than an error it would have to guess at.
      const barred = await server.call('/api/taste', { cookie });
      expect(barred.status).toBe(403);
      expect((await json<{ needsPassword?: boolean }>(barred)).needsPassword).toBe(true);

      // Writing is shut too, not merely reading.
      const refused = await server.call('/api/taste/entries', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ text: 'something private' }),
      });
      expect(refused.status).toBe(403);

      // The wrong password buys nothing.
      const wrong = await server.call('/api/taste/unlock', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ password: 'not it' }),
      });
      expect(wrong.status).toBe(401);

      const opened = await json<{ ticket: string; profile: TasteProfile }>(
        server.call('/api/taste/unlock', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ password: 'correct horse' }),
        }),
      );
      expect(opened.ticket).toBeTruthy();
      expect(opened.profile.entries).toEqual([]);

      const withTicket = (path: string, init: RequestInit & { cookie?: string } = {}) =>
        server.call(path, {
          ...init,
          cookie,
          headers: { ...(init.headers ?? {}), 'x-latent-taste': opened.ticket },
        });

      const made = await withTicket('/api/taste/entries', {
        method: 'POST',
        body: JSON.stringify({ text: 'something private' }),
      });
      expect(made.status).toBe(201);

      /*
       * And the pass ends with the session it was bought in. Signing out is
       * the moment somebody else might pick the phone up, which is the whole
       * case this screen is locked for.
       */
      await server.call('/api/auth/logout', { method: 'POST', cookie });
      const login = await server.call('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });
      const back = login.headers.get('set-cookie')?.split(';')[0] ?? '';

      const stale = await server.call('/api/taste', {
        cookie: back,
        headers: { 'x-latent-taste': opened.ticket },
      });
      expect(stale.status).toBe(403);

      // The notes themselves survived all of that.
      const again = await json<{ profile: TasteProfile }>(
        server.call('/api/taste/unlock', {
          method: 'POST',
          cookie: back,
          body: JSON.stringify({ password: 'correct horse' }),
        }),
      );
      expect(again.profile.entries[0]?.text).toBe('something private');
    } finally {
      await server.dispose();
    }
  }, 30_000);

  /**
   * With the key gone, so is the reading — and so is the writing.
   *
   * Tested against the store directly because there is no way to reach this
   * state over HTTP: every route here needs a session, and signing in is what
   * unlocks the vault. The state is reachable in a running server, though — a
   * restart with sessions still valid and nobody signed in yet — which is why
   * the routes answer 423 rather than assuming an open vault.
   */
  it('cannot read or write the notes with the vault locked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-taste-'));
    try {
      const store = new Store(join(dir, 'taste.db'));
      const vault = new Vault(store);
      const taste = new Taste(store, vault);

      vault.unlock('a password');
      const entry = taste.addEntry(randomUUID(), { categoryId: null, text: 'quiet rooms' });
      expect(taste.profile().entries[0]?.text).toBe('quiet rooms');

      vault.lock();
      expect(taste.isUnlocked).toBe(false);
      expect(() => taste.profile()).toThrow(VaultLockedError);
      expect(() => taste.addEntry(randomUUID(), { categoryId: null, text: 'more' })).toThrow(
        VaultLockedError,
      );
      // The chat would rather go without the section than fail the turn.
      expect(taste.profileOrNull()).toBe(null);

      // Nothing was lost: the same password reads it back.
      vault.unlock('a password');
      expect(taste.profile().entries.map((row) => row.id)).toEqual([entry.id]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('updating Latent itself', () => {
  /**
   * The door, not the update.
   *
   * Nothing here ever calls `/api/update/run` with a valid pass — that would
   * `git reset --hard` the working tree the tests are running from. What can be
   * checked without doing that is everything that matters most anyway: who is
   * let through, who is not, and that a refusal happens *before* anything is
   * touched. The run itself is covered in `update.test.ts`, where git and npm
   * are scripted rather than real.
   */
  const claim = async (server: Awaited<ReturnType<typeof bootIsolated>>) => {
    const response = await server.call('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password: 'correct horse' }),
    });
    return response.headers.get('set-cookie')?.split(';')[0] ?? '';
  };

  it('tells a signed-in session what is installed without asking for the password again', async () => {
    const server = await bootIsolated();
    try {
      const cookie = await claim(server);

      // Signed in first, like everything else under /api.
      expect((await server.call('/api/update')).status).toBe(401);

      const status = await json<UpdateStatus>(server.call('/api/update', { cookie }));
      // Reading is not the guarded part: the screen has to be able to draw
      // before there is anything to ask a password for.
      expect(status.checkout).toBeTruthy();
      expect(status.supervisor.kind).toBeTruthy();
      expect(status.cursor).toBe(0);
      expect(status.run).toBeNull();
    } finally {
      await server.dispose();
    }
  }, 30_000);

  it('will not install or restart for a session that has only signed in', async () => {
    const server = await bootIsolated();
    try {
      const cookie = await claim(server);

      for (const path of ['/api/update/run', '/api/update/restart']) {
        const barred = await server.call(path, { method: 'POST', cookie });
        expect(barred.status).toBe(403);
        // A marker rather than a 401, so the screen asks for the password
        // instead of concluding the session died and throwing somebody back to
        // a sign-in they do not need.
        expect((await json<{ needsPassword?: boolean }>(barred)).needsPassword).toBe(true);
      }
    } finally {
      await server.dispose();
    }
  }, 30_000);

  it('sells the pass for the right password and nothing else', async () => {
    const server = await bootIsolated();
    try {
      const cookie = await claim(server);

      const wrong = await server.call('/api/update/unlock', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ password: 'not it' }),
      });
      expect(wrong.status).toBe(401);

      const opened = await json<{ ticket: string; status: UpdateStatus }>(
        server.call('/api/update/unlock', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ password: 'correct horse' }),
        }),
      );
      expect(opened.ticket).toBeTruthy();
      expect(opened.status.checkout).toBeTruthy();

      /*
       * Past the door, and refused for a reason that is about the machine
       * rather than about permission: nothing has been installed, so there is
       * nothing a restart would pick up. This is also the guard that makes the
       * test safe — it answers before anything is stopped.
       */
      const pointless = await server.call('/api/update/restart', {
        method: 'POST',
        cookie,
        headers: { 'x-latent-update': opened.ticket },
      });
      expect(pointless.status).toBe(409);
      expect((await json<{ error: string }>(pointless)).error).toContain('Nothing has been installed');
    } finally {
      await server.dispose();
    }
  }, 30_000);

  it('keeps the two books of passes apart', async () => {
    const server = await bootIsolated();
    try {
      const cookie = await claim(server);

      const forTaste = await json<{ ticket: string }>(
        server.call('/api/taste/unlock', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ password: 'correct horse' }),
        }),
      );
      const forUpdate = await json<{ ticket: string }>(
        server.call('/api/update/unlock', {
          method: 'POST',
          cookie,
          body: JSON.stringify({ password: 'correct horse' }),
        }),
      );

      // A pass for the notes is not a pass to replace the running code.
      const crossed = await server.call('/api/update/run', {
        method: 'POST',
        cookie,
        headers: { 'x-latent-update': forTaste.ticket },
      });
      expect(crossed.status).toBe(403);

      // And the reverse: closing the notes must not lock an update out of its
      // own progress, which is what one shared book would have done.
      await server.call('/api/taste/lock', {
        method: 'POST',
        cookie,
        headers: { 'x-latent-taste': forTaste.ticket },
      });
      const stillGood = await server.call('/api/update/restart', {
        method: 'POST',
        cookie,
        headers: { 'x-latent-update': forUpdate.ticket },
      });
      // 409 rather than 403: through the door, and refused on the merits.
      expect(stillGood.status).toBe(409);
    } finally {
      await server.dispose();
    }
  }, 30_000);

  it('has no update routes at all when they are switched off', async () => {
    const server = await bootIsolated({ updateEnabled: false });
    try {
      const cookie = await claim(server);

      // A route that does not exist cannot be reached by a stolen cookie —
      // the same reasoning the terminal is registered under.
      expect((await server.call('/api/update', { cookie })).status).toBe(404);
      expect((await server.call('/api/update/run', { method: 'POST', cookie })).status).toBe(404);

      const status = await json<StatusResponse>(server.call('/api/status', { cookie }));
      expect(status.updateEnabled).toBe(false);
    } finally {
      await server.dispose();
    }
  }, 30_000);
});

describe('browsing folders on the ComfyUI machine', () => {
  /**
   * A proxy, and the interesting case is the ComfyUI that cannot answer.
   *
   * A stock ComfyUI answers 404 to everything under `/comfyllama/`, and that
   * has to arrive as a sentence somebody can act on rather than an empty folder
   * list — an empty list looks like "no pictures" and sends people through
   * their output directory after a fault that is not there.
   *
   * Its own far end, built without the custom nodes: the shared mock has them,
   * because the browser cannot be exercised at all against one that does not.
   */
  it('says what to install when the far end has no browser', async () => {
    const stock = createMockComfy({ logLevel: 'silent', withoutComfyllama: true });
    const address = await stock.listen(0);
    const server = await bootIsolated({ comfyUrl: address });
    try {
      const claimed = await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });
      const cookie = claimed.headers.get('set-cookie')?.split(';')[0] ?? '';

      const barred = await server.call('/api/browse/roots', { cookie });
      expect(barred.status).toBe(404);
      expect((await json<{ error: string }>(barred)).error).toContain('comfyllama');
    } finally {
      await server.dispose();
      await stock.close();
    }
  }, 30_000);

  /** And with comfyllama there, the roots it allows come straight through. */
  it('hands back the folders the far end allows', async () => {
    const response = await api('/api/browse/roots');
    expect(response.status).toBe(200);
    const { roots } = await json<{ roots: { key: string }[] }>(response);
    expect(roots.map((root) => root.key)).toEqual(['output', 'input', 'temp']);
  });

  /**
   * The kind reaches the far end.
   *
   * It was being dropped by the proxy: the picker asked for clips, this handed
   * the request on without the word, and comfyllama fell back to pictures — so
   * a video slot was offered files it cannot load. Proved by asking for videos
   * and getting the clip rather than the renders beside it.
   */
  it('asks for the kind of file the slot can actually use', async () => {
    const response = await api('/api/browse/list?root=output&kind=video');
    expect(response.status).toBe(200);
    const listing = await json<{ files: { name: string }[] }>(response);
    expect(listing.files.map((file) => file.name)).toEqual(['a-clip.webm']);
  });

  it('will not list a folder without being told which one', async () => {
    const response = await api('/api/browse/list');
    expect(response.status).toBe(400);
  });

  it('will not fetch a thumbnail without both halves of the reference', async () => {
    // Root and path together are the reference; either alone names nothing.
    expect((await api('/api/browse/thumb?root=output')).status).toBe(400);
    expect((await api('/api/browse/thumb?path=a.png')).status).toBe(400);
  });

  it('needs a session, like everything else under /api', async () => {
    const server = await bootIsolated();
    try {
      await server.call('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({ password: 'correct horse' }),
      });
      expect((await server.call('/api/browse/roots')).status).toBe(401);
    } finally {
      await server.dispose();
    }
  }, 30_000);
});
