import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type {
  GalleryPage,
  GenerationRecord,
  QueueState,
  ServerEvent,
  StatusResponse,
  WorkflowDetail,
} from '@latent/shared';
import { sd15Txt2Img, uiFormatWorkflow } from '@latent/shared/fixtures';

import { buildApp } from './app.js';
import { createMockComfy } from './mock/comfy.js';

/**
 * End-to-end coverage of the server against the mock ComfyUI: import a
 * workflow, generate, watch the live events, and find the result in the
 * gallery. This is the closest thing to a real run that works without a GPU.
 */

let mock: ReturnType<typeof createMockComfy>;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let baseUrl: string;
let dataDir: string;

const api = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
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

  const built = await buildApp({
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
    expect(status.authRequired).toBe(false);
    expect(status.devices[0]?.vramTotal).toBeGreaterThan(0);
  });
});

describe('workflow import', () => {
  it('rejects a UI-format export with an actionable message', async () => {
    const response = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Wrong format', graph: uiFormatWorkflow }),
    });
    expect(response.status).toBe(400);
    expect((await json<{ error: string }>(response)).error).toMatch(/Export \(API\)/);
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

    socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/api/ws`);
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
    const view = await fetch(`${baseUrl}/api/view?${params}`);
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
    const response = await fetch(`${baseUrl}/api/view?filename=../../etc/passwd`);
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

    let late: ReturnType<typeof createMockComfy> | null = null;
    try {
      // Nothing is listening yet.
      const offline = (await (await fetch(`${url}/api/status`)).json()) as StatusResponse;
      expect(offline.comfyOnline).toBe(false);

      // Let the socket fail a few times so it is genuinely in backoff.
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      late = createMockComfy({ logLevel: 'silent' });
      await late.listen(port);

      // Polling status is what a phone does on wake; it must pull the socket
      // back up rather than leaving the UI stale.
      const online = await waitFor(async () => {
        const status = (await (await fetch(`${url}/api/status`)).json()) as StatusResponse;
        return status.comfyOnline ? status : null;
      }, 10_000);
      expect(online.comfyOnline).toBe(true);

      // And the live state — what the UI actually renders — must agree.
      const socket = new WebSocket(`${url.replace('http', 'ws')}/api/ws`);
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

describe('authentication', () => {
  it('locks down the API when a password is configured', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'latent-auth-'));
    const built = await buildApp({
      comfyUrl: 'http://127.0.0.1:1', // unreachable on purpose; auth must not depend on it
      dbPath: join(authDir, 'auth.db'),
      dataDir: authDir,
      webDir: join(authDir, 'no-web'),
      password: 'hunter2',
      logLevel: 'silent',
    });

    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const address = built.app.server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      expect((await fetch(`${url}/api/workflows`)).status).toBe(401);

      // /api/status stays reachable so the login screen can render, but it
      // must not disclose anything about the ComfyUI box.
      const status = (await (await fetch(`${url}/api/status`)).json()) as StatusResponse;
      expect(status.authRequired).toBe(true);
      expect(status.authenticated).toBe(false);
      expect(status.comfyUrl).toBe('');

      const badLogin = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      expect(badLogin.status).toBe(401);

      const login = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'hunter2' }),
      });
      expect(login.status).toBe(200);

      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      expect(cookie).toContain('latent_session');

      const authed = await fetch(`${url}/api/workflows`, { headers: { cookie } });
      expect(authed.status).toBe(200);

      // The live socket must refuse an unauthenticated upgrade too. The auth
      // hook rejects it during the HTTP handshake, so it never becomes a
      // WebSocket at all — the client sees a 401, not a close frame.
      const socket = new WebSocket(`${url.replace('http', 'ws')}/api/ws`);
      const failure = await new Promise<Error>((resolve, reject) => {
        socket.once('error', resolve);
        socket.once('open', () => reject(new Error('socket opened without authentication')));
        setTimeout(() => reject(new Error('socket neither opened nor failed')), 5_000);
      });
      expect(failure.message).toContain('401');

      // With the session cookie the same upgrade succeeds.
      const authedSocket = new WebSocket(`${url.replace('http', 'ws')}/api/ws`, {
        headers: { cookie },
      });
      await new Promise<void>((resolve, reject) => {
        authedSocket.once('open', () => resolve());
        authedSocket.once('error', reject);
      });
      authedSocket.close();
    } finally {
      await built.app.close();
      rmSync(authDir, { recursive: true, force: true });
    }
  }, 30_000);
});
