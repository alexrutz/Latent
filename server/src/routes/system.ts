import type { FastifyInstance } from 'fastify';

import { LATENT_API_VERSION } from '@latent/shared';
import type { AppInfo, AppSettings, StatusResponse } from '@latent/shared';

import { fetchOllamaModels, ollamaUrlFor } from '../ollama.js';
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

    // Create the archive key under the password that was just chosen, and
    // with it the key the settings files are written under.
    if (typeof password === 'string') {
      ctx.vault.unlock(password);
      ctx.stateFiles.unlock(password);
    }

    app.log.info('Password set — this server is now claimed.');
    ctx.auth.setSession(reply);
    return { ok: true };
  });

  app.post<{ Body: { password?: string; issueToken?: boolean } }>('/api/auth/login', async (request, reply) => {
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
    if (typeof request.body?.password === 'string') {
      ctx.vault.unlock(request.body.password);
      // The settings files are encrypted under the same password, and this is
      // the first moment they can be read.
      ctx.stateFiles.unlock(request.body.password);
    }
    ctx.auth.setSession(reply);

    /*
     * The token, only when it is asked for.
     *
     * The cookie is `httpOnly` so that script on the page cannot read it, and
     * handing the same secret back in the response body to everybody would
     * throw that away — the browser would be one XSS from a credential it was
     * specifically arranged not to be able to see. A native client has no page
     * and no script and does have to hold it, so it says so.
     */
    return request.body?.issueToken === true
      ? { ok: true as const, token: ctx.auth.issueToken() ?? '' }
      : { ok: true as const };
  });

  /**
   * What this server is, for a client that was not served by it.
   *
   * The web app is shipped by the same process it talks to, so it can assume
   * the two agree. A native app is installed once and then meets whatever
   * version happens to be running months later — it needs to ask, before it
   * can sensibly do anything, and it needs somewhere to ask that will not
   * itself change shape.
   *
   * Unauthenticated, and says nothing a stranger could use: the name of the
   * software, the contract it speaks, and how to sign in. Everything about the
   * machine is behind `/api/status`, which requires the password.
   */
  app.get('/api/app', async () => {
    return {
      app: 'latent',
      api: { version: LATENT_API_VERSION },
      auth: {
        // Both work everywhere. A browser is served the cookie automatically;
        // anything else asks for the token and sends it as a bearer.
        schemes: ['cookie', 'bearer'],
        login: '/api/auth/login',
        setupRequired: ctx.auth.setupRequired,
        /*
         * There is no refresh and no expiry to track.
         *
         * The token is derived from the stored password hash, so it stays good
         * until the password changes and then stops working everywhere at
         * once. A client that gets a 401 signs in again; there is nothing else
         * to implement.
         */
        tokenLifetime: 'until the password changes',
      },
    } satisfies AppInfo;
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    ctx.auth.clearSession(reply);
    /*
     * And every pass for the notes with it.
     *
     * Signing out is the moment somebody else might pick the phone up, which
     * is the whole case that screen is locked for — a pass that outlived it
     * would be the lock left on the latch.
     */
    ctx.tasteGate.revokeAll();
    return { ok: true };
  });

  /**
   * Unseal the archive without signing out first.
   *
   * The session cookie outlives a restart — it is an HMAC over the stored
   * password hash, so it keeps verifying — but the archive key does not: it is
   * derived from the password and only ever held in memory. A restarted server
   * therefore leaves you signed in with the archive shut, and importing or
   * keeping an image answers 423 for a reason you cannot act on. Signing out
   * and back in was the only way through, and nothing said so.
   *
   * Behind the session guard, so this is a re-entry of a password you already
   * have rather than a second way in.
   */
  app.post<{ Body: { password?: string } }>('/api/auth/unlock', async (request, reply) => {
    if (ctx.vault.isUnlocked) return { ok: true };

    const clientKey = request.ip;
    if (!ctx.auth.registerLoginAttempt(clientKey)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait a minute and try again.' });
    }

    const password = request.body?.password;
    /*
     * Checked against the stored hash before the vault sees it. `Vault.unlock`
     * treats an uninitialised vault as "create one under this password", which
     * for a typo here would key the archive to a guess.
     */
    if (typeof password !== 'string' || !ctx.auth.checkPassword(password)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return reply.code(401).send({ error: 'Incorrect password' });
    }
    ctx.auth.clearLoginAttempts(clientKey);

    if (!ctx.vault.unlock(password)) {
      return reply.code(409).send({
        error:
          'That is the right password, but it does not open this archive — the files were ' +
          'written under a different one.',
      });
    }
    // Encrypted under the same password, and this is the first moment they can
    // be read again.
    ctx.stateFiles.unlock(password);
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
        // Two small files, so they are simply rewritten under the new key.
        ctx.stateFiles.rekey(newPassword);
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

  /**
   * The models an Ollama node can choose from.
   *
   * Not in `/object_info`: those nodes publish an empty combo and fill it in
   * from the browser, so the list has to be fetched from Ollama itself. Keyed
   * by workflow and node because the address is a widget on that node.
   */
  app.get<{ Querystring: { workflowId?: string; nodeId?: string } }>(
    '/api/models/ollama',
    async (request, reply) => {
      const { workflowId, nodeId } = request.query;
      if (!workflowId || !nodeId) {
        return reply.code(400).send({ error: 'Which node?' });
      }

      const workflow = ctx.store.getWorkflow(workflowId);
      if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

      return fetchOllamaModels(
        ollamaUrlFor(workflow.graph, nodeId),
        ctx.orchestrator.client.baseUrl,
      );
    },
  );

  app.get('/api/archive/stats', async () => ctx.store.archiveStats());

  /**
   * The resource and event history.
   *
   * `since` makes repeat calls cheap: the screen keeps what it already has and
   * asks only for what happened after it, which is what makes polling every
   * couple of seconds from a phone reasonable.
   */
  app.get<{ Querystring: { since?: string } }>('/api/monitor', async (request) => {
    const since = Number(request.query.since);
    return ctx.orchestrator.monitor.snapshot(Number.isFinite(since) ? since : undefined);
  });
}
