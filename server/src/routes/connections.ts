import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { ConnectionInput, ConnectionKind, ConnectionTestResult } from '@latent/shared';
import { defaultSampling } from '@latent/shared';

import { LlamaClient } from '../chat/llama.js';
import { ComfyClient, ComfyError, isSelfSignedError } from '../comfy/client.js';
import type { ConnectionConfig } from '../comfy/connection.js';
import type { AppContext } from './context.js';

const VALID_AUTH_MODES = new Set(['none', 'bearer', 'basic']);
const VALID_KINDS = new Set(['comfy', 'llama']);

function validate(body: ConnectionInput | undefined, requireAll: boolean): string | null {
  if (!body) return 'Missing request body';
  if (body.kind !== undefined && !VALID_KINDS.has(body.kind)) {
    return 'Unknown kind of connection';
  }

  if (requireAll || body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') return 'A name is required';
  }
  if (requireAll || body.url !== undefined) {
    if (typeof body.url !== 'string' || body.url.trim() === '') return 'A URL is required';
    try {
      const parsed = new URL(body.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'The URL must start with http:// or https://';
      }
    } catch {
      return 'That is not a valid URL';
    }
  }
  if (body.authMode !== undefined && !VALID_AUTH_MODES.has(body.authMode)) {
    return 'Unknown authentication mode';
  }
  return null;
}

/**
 * Try an endpoint and report what is actually wrong.
 *
 * "Connection failed" is useless when the three likely causes — wrong address,
 * wrong token, self-signed certificate — each need a different fix, and only one
 * of them is a mistake in the URL.
 */
export async function testConnection(
  config: ConnectionConfig,
  kind: ConnectionKind = 'comfy',
): Promise<ConnectionTestResult> {
  if (kind === 'llama') return testLlama(config);

  const client = new ComfyClient(config);
  try {
    const stats = await client.systemStats();
    const version = stats.system?.comfyui_version ?? null;
    return {
      outcome: 'ok',
      message: version ? `Connected to ComfyUI ${version}` : 'Connected',
      comfyVersion: version,
    };
  } catch (error) {
    if (error instanceof ComfyError && (error.status === 401 || error.status === 403)) {
      return {
        outcome: 'unauthorized',
        message:
          'The server answered but rejected the credentials. On vast.ai this is the value you set ' +
          'for WEB_PASSWORD when renting the instance (or OPEN_BUTTON_TOKEN if you did not set one).',
      };
    }
    if (isSelfSignedError(error) || /self-signed/i.test(String((error as Error)?.message))) {
      return {
        outcome: 'self_signed',
        message:
          'The server uses a self-signed certificate. Turn on "Allow self-signed certificate" — ' +
          'vast.ai instances started with ENABLE_HTTPS=true always do.',
      };
    }
    return {
      outcome: 'unreachable',
      message:
        error instanceof Error
          ? `Could not reach that address: ${error.message}`
          : 'Could not reach that address',
    };
  } finally {
    await client.close();
  }
}

/**
 * The same three questions, asked of a model server.
 *
 * `/v1/models` is the cheapest route that proves both that something is there
 * and that it speaks the OpenAI API — and it answers with the list of models,
 * which is exactly what the settings screen wants next anyway.
 */
async function testLlama(config: ConnectionConfig): Promise<ConnectionTestResult> {
  const client = new LlamaClient(config, {
    model: '',
    maxTokens: 0,
    thinking: false,
    systemPromptId: null,
    tools: { prompt_blocks: 'off', build_prompt: 'off', ask_user: 'off' },
    generation: { workflowId: '', values: {} },
    imageSize: 3,
    promptButton: 'dialog',
    showDiff: { inDialog: false, underPicture: false },
    // Nothing is generated here — this asks `/v1/models` and hangs up.
    sampling: defaultSampling(),
  });

  try {
    const models = await client.models();
    return {
      outcome: 'ok',
      message:
        models.length > 0
          ? `Connected. ${models.length === 1 ? models[0] : `${models.length} models available`}`
          : 'Connected, but the server lists no models.',
      models,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/\b401\b|\b403\b/.test(message)) {
      return {
        outcome: 'unauthorized',
        message: 'The server answered but rejected the credentials.',
      };
    }
    if (isSelfSignedError(error) || /self-signed/i.test(message)) {
      return {
        outcome: 'self_signed',
        message:
          'The server uses a self-signed certificate. Turn on "Allow self-signed certificate".',
      };
    }
    return {
      outcome: 'unreachable',
      message: message
        ? `Could not reach that address: ${message}`
        : 'Could not reach that address',
    };
  } finally {
    await client.close();
  }
}

export function registerConnectionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/connections', async () => ctx.store.listConnections());

  app.post<{ Body: ConnectionInput }>('/api/connections', async (request, reply) => {
    const error = validate(request.body, true);
    if (error) return reply.code(400).send({ error });

    const id = randomUUID();
    const kind = request.body.kind ?? 'comfy';
    ctx.store.insertConnection(id, request.body);

    // The first of its kind becomes the one in use; otherwise the user would
    // have to add it and then separately remember to select it. Per kind,
    // because adding a model server must not leave ComfyUI unselected.
    if (ctx.store.countConnections(kind) === 1) {
      ctx.store.activateConnection(id);
      const created = ctx.store.getConnectionWithSecret(id);
      if (created && kind === 'comfy') await ctx.orchestrator.switchConnection(toConfig(created));
    }

    return reply.code(201).send(ctx.store.getConnection(id));
  });

  app.patch<{ Params: { id: string }; Body: ConnectionInput }>(
    '/api/connections/:id',
    async (request, reply) => {
      const existing = ctx.store.getConnection(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Connection not found' });

      const error = validate(request.body, false);
      if (error) return reply.code(400).send({ error });

      ctx.store.updateConnection(request.params.id, request.body);

      // Editing the connection currently in use must take effect immediately,
      // or the user fixes a wrong token and nothing changes. Only ComfyUI has a
      // socket to re-open; the chat builds its client per request.
      const updated = ctx.store.getConnectionWithSecret(request.params.id);
      if (updated?.isActive && updated.kind === 'comfy') {
        await ctx.orchestrator.switchConnection(toConfig(updated));
      }

      return ctx.store.getConnection(request.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (request, reply) => {
    const existing = ctx.store.getConnection(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Connection not found' });
    /*
     * Only ComfyUI's cannot be pulled out from under the app: the orchestrator
     * holds a socket to it and every screen assumes there is one. A model
     * server is asked for per request, so deleting the one in use simply leaves
     * the chat with nothing to talk to — which is a state it already handles,
     * and the honest thing to allow for a box you have stopped renting.
     */
    if (existing.isActive && existing.kind === 'comfy') {
      return reply
        .code(409)
        .send({ error: 'That connection is in use. Switch to another one first.' });
    }
    ctx.store.deleteConnection(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/connections/:id/activate', async (request, reply) => {
    const target = ctx.store.getConnectionWithSecret(request.params.id);
    if (!target) return reply.code(404).send({ error: 'Connection not found' });

    ctx.store.activateConnection(target.id);
    if (target.kind === 'comfy') await ctx.orchestrator.switchConnection(toConfig(target));
    return ctx.store.listConnections();
  });

  /** Test a stored connection, or an unsaved one posted in the body. */
  app.post<{ Params: { id: string }; Body: ConnectionInput | undefined }>(
    '/api/connections/:id/test',
    async (request, reply) => {
      const stored = ctx.store.getConnectionWithSecret(request.params.id);
      if (!stored) return reply.code(404).send({ error: 'Connection not found' });

      const overrides: Partial<ConnectionInput> = request.body ?? {};
      const config: ConnectionConfig = {
        ...toConfig(stored),
        ...(overrides.url ? { url: overrides.url.replace(/\/+$/, '') } : {}),
        ...(overrides.authMode ? { authMode: overrides.authMode } : {}),
        ...(overrides.username !== undefined ? { username: overrides.username } : {}),
        // An empty secret in a test means "use the stored one", not "send none".
        ...(overrides.secret ? { secret: overrides.secret } : {}),
        ...(overrides.allowSelfSigned !== undefined
          ? { allowSelfSigned: overrides.allowSelfSigned }
          : {}),
      };

      return testConnection(config, overrides.kind ?? stored.kind);
    },
  );

  /** Test an endpoint that has not been saved yet, straight from the add form. */
  app.post<{ Body: ConnectionInput }>('/api/connections/test', async (request, reply) => {
    const error = validate(request.body, true);
    if (error) return reply.code(400).send({ error });

    return testConnection(
      {
        id: 'unsaved',
        name: request.body.name,
        url: request.body.url.replace(/\/+$/, ''),
        authMode: request.body.authMode ?? 'none',
        username: request.body.username ?? null,
        secret: request.body.secret ?? null,
        allowSelfSigned: request.body.allowSelfSigned ?? false,
      },
      request.body.kind ?? 'comfy',
    );
  });
}

/** Store row -> the shape the client and socket consume. */
export function toConfig(row: {
  id: string;
  name: string;
  url: string;
  authMode: ConnectionConfig['authMode'];
  username: string | null;
  secret: string | null;
  allowSelfSigned: boolean;
}): ConnectionConfig {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    authMode: row.authMode,
    username: row.username,
    secret: row.secret,
    allowSelfSigned: row.allowSelfSigned,
  };
}
