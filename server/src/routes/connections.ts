import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { ConnectionInput, ConnectionTestResult } from '@latent/shared';

import { ComfyClient, ComfyError, isSelfSignedError } from '../comfy/client.js';
import type { ConnectionConfig } from '../comfy/connection.js';
import type { AppContext } from './context.js';

const VALID_AUTH_MODES = new Set(['none', 'bearer', 'basic']);

function validate(body: ConnectionInput | undefined, requireAll: boolean): string | null {
  if (!body) return 'Missing request body';

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
export async function testConnection(config: ConnectionConfig): Promise<ConnectionTestResult> {
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

export function registerConnectionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/connections', async () => ctx.store.listConnections());

  app.post<{ Body: ConnectionInput }>('/api/connections', async (request, reply) => {
    const error = validate(request.body, true);
    if (error) return reply.code(400).send({ error });

    const id = randomUUID();
    ctx.store.insertConnection(id, request.body);

    // A first connection becomes the active one; otherwise the user would have
    // to add it and then separately remember to select it.
    if (ctx.store.countConnections() === 1) {
      ctx.store.activateConnection(id);
      const created = ctx.store.getConnectionWithSecret(id);
      if (created) await ctx.orchestrator.switchConnection(toConfig(created));
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
      // or the user fixes a wrong token and nothing changes.
      const updated = ctx.store.getConnectionWithSecret(request.params.id);
      if (updated?.isActive) await ctx.orchestrator.switchConnection(toConfig(updated));

      return ctx.store.getConnection(request.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (request, reply) => {
    const existing = ctx.store.getConnection(request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Connection not found' });
    if (existing.isActive) {
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
    await ctx.orchestrator.switchConnection(toConfig(target));
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

      return testConnection(config);
    },
  );

  /** Test an endpoint that has not been saved yet, straight from the add form. */
  app.post<{ Body: ConnectionInput }>('/api/connections/test', async (request, reply) => {
    const error = validate(request.body, true);
    if (error) return reply.code(400).send({ error });

    return testConnection({
      id: 'unsaved',
      name: request.body.name,
      url: request.body.url.replace(/\/+$/, ''),
      authMode: request.body.authMode ?? 'none',
      username: request.body.username ?? null,
      secret: request.body.secret ?? null,
      allowSelfSigned: request.body.allowSelfSigned ?? false,
    });
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
