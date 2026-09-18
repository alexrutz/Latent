import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import {
  blankConfig,
  definitionFor,
  SERVICE_DEFINITIONS,
  type ServiceConfig,
  type ServiceView,
} from '@latent/shared';

import { isUp } from '../supervisor.js';
import type { AppContext } from './context.js';

/**
 * The supervisor's API: what can be run, what is configured, and what it is doing.
 *
 * Every route here can start a process on the machine Latent is installed on,
 * which is worth being plain about rather than burying. It is the same class of
 * power the update routes already have — they run `git` and `npm` — and it sits
 * behind the same session check as everything else. What it is *not* is
 * arbitrary: the executable is never sent by the client. It is derived from the
 * service's kind, which must be one of the definitions Latent ships with, and
 * from the root directory somebody typed in. A client can choose which of
 * ComfyUI's launchers to use and what flags to pass it; it cannot ask for a
 * different program.
 *
 * Modularity is the point of the `/definitions` route. The screen is built from
 * whatever it returns — the groups, the controls, the help text — so a service
 * added to the catalogue appears in the UI with no client change at all.
 */
export function registerSupervisorRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** What Latent knows how to run. The screen builds its forms from this. */
  app.get('/api/supervisor/definitions', async () => ({ definitions: SERVICE_DEFINITIONS }));

  const view = (config: ServiceConfig): ServiceView => ({
    config,
    status: ctx.supervisor.statusOf(config),
  });

  app.get('/api/supervisor/services', async () => ({
    services: ctx.store.listServices().map(view),
  }));

  app.post<{ Body: { kind?: string; name?: string; root?: string } }>(
    '/api/supervisor/services',
    async (request, reply) => {
      const kind = request.body?.kind;
      const definition = kind ? definitionFor(kind) : undefined;
      if (!definition) {
        return reply.code(400).send({ error: 'Latent does not know how to run that.' });
      }

      const config = blankConfig(definition, randomUUID(), Date.now());
      if (request.body?.name?.trim()) config.name = request.body.name.trim();
      if (request.body?.root?.trim()) config.root = request.body.root.trim();

      ctx.store.insertService(config);
      return reply.code(201).send(view(config));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<ServiceConfig> }>(
    '/api/supervisor/services/:id',
    async (request, reply) => {
      const current = ctx.store.getService(request.params.id);
      if (!current) return reply.code(404).send({ error: 'No such service' });

      const patch = { ...(request.body ?? {}) };
      /*
       * The record's identity is not editable, whatever the body says.
       *
       * The store refuses these too — it is one of the few things it is
       * opinionated about — but a route that quietly accepts a field it cannot
       * honour is a route that lies about what it did.
       */
      delete patch.id;
      delete patch.kind;
      delete patch.createdAt;

      const next = ctx.store.updateService(request.params.id, patch);
      if (!next) return reply.code(404).send({ error: 'No such service' });
      return view(next);
    },
  );

  /**
   * Removing a service stops it first.
   *
   * The alternative is an orphan: a ComfyUI holding a GPU, started by Latent,
   * with nothing left in the database that knows it exists. There is no
   * "remove but leave it running" because there is no way back from it.
   */
  app.delete<{ Params: { id: string } }>('/api/supervisor/services/:id', async (request, reply) => {
    if (!ctx.store.getService(request.params.id)) {
      return reply.code(404).send({ error: 'No such service' });
    }
    ctx.supervisor.stop(request.params.id);
    ctx.supervisor.forget(request.params.id);
    ctx.store.deleteService(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/supervisor/services/:id/start', async (request, reply) => {
    const config = ctx.store.getService(request.params.id);
    if (!config) return reply.code(404).send({ error: 'No such service' });

    const failure = ctx.supervisor.start(config);
    /*
     * 409 rather than 500. Every way this fails is a thing about the
     * configuration that the person reading the screen has to change — a root
     * that points at the wrong folder, a binary that is not there — and that is
     * a conflict with the current state, not a server that broke.
     */
    if (failure) return reply.code(409).send({ error: failure, ...view(config) });
    return view(config);
  });

  app.post<{ Params: { id: string } }>('/api/supervisor/services/:id/stop', async (request, reply) => {
    const config = ctx.store.getService(request.params.id);
    if (!config) return reply.code(404).send({ error: 'No such service' });
    ctx.supervisor.stop(config.id);
    return view(config);
  });

  app.post<{ Params: { id: string } }>(
    '/api/supervisor/services/:id/restart',
    async (request, reply) => {
      const config = ctx.store.getService(request.params.id);
      if (!config) return reply.code(404).send({ error: 'No such service' });
      ctx.supervisor.restart(config);
      return view(config);
    },
  );

  /**
   * The output, from a line the client names.
   *
   * `since` rather than a page, because the question a log viewer asks is
   * always "what is new" — and answering it by sequence means a poll every
   * second sends almost nothing while a service is quiet, and everything that
   * happened while it was not.
   */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/supervisor/services/:id/log',
    async (request, reply) => {
      const config = ctx.store.getService(request.params.id);
      if (!config) return reply.code(404).send({ error: 'No such service' });

      const since = Number(request.query.since);
      const tail = ctx.supervisor.logSince(config.id, Number.isFinite(since) ? since : 0);
      return { ...tail, running: isUp(ctx.supervisor.statusOf(config).state) };
    },
  );
}
