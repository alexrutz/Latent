import type { FastifyInstance } from 'fastify';

import type { AppSettings, StatusResponse } from '@latent/shared';

import type { AppContext } from './context.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Unauthenticated on purpose: the login screen needs to know if auth is on. */
  app.get('/api/status', async (request) => {
    const authenticated = ctx.auth.isAuthenticated(request);
    const base: StatusResponse = {
      comfyUrl: ctx.config.comfyUrl,
      comfyOnline: ctx.orchestrator.getState().comfyOnline,
      comfyVersion: null,
      authRequired: ctx.auth.required,
      authenticated,
      devices: [],
    };

    // Don't leak anything about the ComfyUI box to an unauthenticated caller.
    if (!authenticated) return { ...base, comfyUrl: '', comfyOnline: false };

    try {
      const stats = await ctx.orchestrator.client.systemStats();
      // HTTP works, so ComfyUI is up. If the event socket is still backing off
      // (it usually is, right after a ComfyUI restart), retry it now — the live
      // state, and with it the Generate button, depends on that socket.
      ctx.orchestrator.ensureConnected();
      return {
        ...base,
        comfyOnline: true,
        comfyVersion: stats.system?.comfyui_version ?? null,
        devices: (stats.devices ?? []).map((device) => ({
          name: device.name ?? 'unknown',
          vramTotal: device.vram_total ?? 0,
          vramFree: device.vram_free ?? 0,
        })),
      };
    } catch {
      return { ...base, comfyOnline: false };
    }
  });

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (request, reply) => {
    if (!ctx.auth.required) return { ok: true };

    if (!ctx.auth.checkPassword(request.body?.password)) {
      // Slow down credential guessing without holding a connection open long.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return reply.code(401).send({ error: 'Incorrect password' });
    }

    ctx.auth.setSession(reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    ctx.auth.clearSession(reply);
    return { ok: true };
  });

  app.get('/api/settings', async () => ctx.store.getSettings());

  app.patch<{ Body: Partial<AppSettings> }>('/api/settings', async (request) =>
    ctx.store.updateSettings(request.body ?? {}),
  );
}
