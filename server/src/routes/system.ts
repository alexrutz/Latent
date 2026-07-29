import type { FastifyInstance } from 'fastify';

import type { AppSettings, StatusResponse } from '@latent/shared';

import type { AppContext } from './context.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Unauthenticated on purpose: the login and setup screens need to know which
   * of the two to render before anyone can possibly be authenticated.
   */
  app.get('/api/status', async (request) => {
    const authenticated = ctx.auth.isAuthenticated(request);
    const setupRequired = ctx.auth.setupRequired;

    const base: StatusResponse = {
      comfyUrl: '',
      comfyOnline: false,
      comfyVersion: null,
      authRequired: true,
      authenticated,
      setupRequired,
      terminalEnabled: ctx.config.terminalEnabled,
      archiveLocked: !ctx.vault.isUnlocked,
      activeConnectionId: null,
      activeConnectionName: null,
      devices: [],
    };

    // Nothing about the ComfyUI box leaks before login.
    if (!authenticated) return base;

    const connection = ctx.orchestrator.activeConnection;
    const withConnection: StatusResponse = {
      ...base,
      comfyUrl: connection.url,
      comfyOnline: ctx.orchestrator.getState().comfyOnline,
      activeConnectionId: connection.id,
      activeConnectionName: connection.name,
    };

    try {
      const stats = await ctx.orchestrator.client.systemStats();
      // HTTP works, so ComfyUI is up. If the event socket is still backing off
      // (it usually is, right after a ComfyUI restart), retry it now — the live
      // state, and with it the Generate button, depends on that socket.
      ctx.orchestrator.ensureConnected();
      return {
        ...withConnection,
        comfyOnline: true,
        comfyVersion: stats.system?.comfyui_version ?? null,
        devices: (stats.devices ?? []).map((device) => ({
          name: device.name ?? 'unknown',
          vramTotal: device.vram_total ?? 0,
          vramFree: device.vram_free ?? 0,
        })),
      };
    } catch {
      return { ...withConnection, comfyOnline: false };
    }
  });

  /**
   * Claim an unconfigured server by choosing its password.
   *
   * One-shot: once a password exists this always fails, so the window closes
   * permanently the moment anyone uses it.
   */
  app.post<{ Body: { password?: string } }>('/api/auth/setup', async (request, reply) => {
    const password = request.body?.password;
    const result = ctx.auth.setup(password);
    if (!result.ok) return reply.code(409).send({ error: result.error });

    // Create the archive key under the password that was just chosen.
    if (typeof password === 'string') ctx.vault.unlock(password);

    app.log.info('Password set — this server is now claimed.');
    ctx.auth.setSession(reply);
    return { ok: true };
  });

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (request, reply) => {
    if (ctx.auth.setupRequired) {
      return reply.code(409).send({ error: 'This server has not been set up yet.' });
    }

    const clientKey = request.ip;
    if (!ctx.auth.registerLoginAttempt(clientKey)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait a minute and try again.' });
    }

    if (!ctx.auth.checkPassword(request.body?.password)) {
      // Slow down guessing without holding a connection open long.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return reply.code(401).send({ error: 'Incorrect password' });
    }

    ctx.auth.clearLoginAttempts(clientKey);
    // Signing in is what unseals the archive: the key is derived from the
    // password and only ever held in memory, so a restarted server stays
    // locked until somebody actually logs in.
    if (typeof request.body?.password === 'string') ctx.vault.unlock(request.body.password);
    ctx.auth.setSession(reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    ctx.auth.clearSession(reply);
    return { ok: true };
  });

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/api/auth/password',
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body ?? {};
      const result = ctx.auth.changePassword(currentPassword, newPassword);
      if (!result.ok) return reply.code(400).send({ error: result.error });

      // Re-wrap the archive key rather than re-encrypting every file. If this
      // ever failed the images would become unreadable, so it is not optional.
      if (typeof currentPassword === 'string' && typeof newPassword === 'string') {
        if (!ctx.vault.rewrap(currentPassword, newPassword)) {
          return reply.code(500).send({
            error: 'The password changed but the image archive could not be re-keyed.',
          });
        }
      }

      // The session token is derived from the password hash, so the caller's
      // own cookie has just been invalidated too. Re-issue it.
      ctx.auth.setSession(reply);
      return { ok: true };
    },
  );

  app.get('/api/settings', async () => ctx.store.getSettings());

  app.patch<{ Body: Partial<AppSettings> }>('/api/settings', async (request) =>
    ctx.store.updateSettings(request.body ?? {}),
  );

  /**
   * LoRA files installed on the active ComfyUI, for the tag editor's picker.
   * `/models/{folder}` is not on every build, so fall back to the option list
   * that `/object_info` publishes for LoraLoader.
   */
  app.get('/api/models/loras', async () => {
    try {
      return await ctx.orchestrator.client.models('loras');
    } catch {
      try {
        const objectInfo = await ctx.orchestrator.objectInfo();
        const spec = objectInfo.LoraLoader?.input?.required?.lora_name;
        const options = spec?.[0];
        return Array.isArray(options) ? options.filter((o) => typeof o === 'string') : [];
      } catch {
        return [];
      }
    }
  });

  app.get('/api/archive/stats', async () => ctx.store.archiveStats());
}
