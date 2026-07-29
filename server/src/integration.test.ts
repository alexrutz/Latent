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

import Database from 'better-sqlite3';

import { buildApp } from './app.js';
import { Store } from './db.js';
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
