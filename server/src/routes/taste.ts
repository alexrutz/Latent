import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AppContext } from './context.js';
import { VaultLockedError } from '../vault.js';

/**
 * Notes about what the user likes.
 *
 * Everything here needs the vault open, because everything here is encrypted —
 * see `server/src/taste.ts` for why. A locked server answers 423 rather than
 * an empty list, so the screen can say "sign in" instead of quietly showing
 * nothing and inviting somebody to write their notes a second time.
 */
export function registerTasteRoutes(app: FastifyInstance, ctx: AppContext): void {
  const locked = (reply: FastifyReply) =>
    reply.code(423).send({ error: new VaultLockedError().message, locked: true });

  app.get('/api/taste', async (_request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    return ctx.taste.profile();
  });

  app.post<{ Body: { name?: string } }>('/api/taste/categories', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: 'Give the category a name' });
    return reply.code(201).send(ctx.taste.addCategory(randomUUID(), name));
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean } }>(
    '/api/taste/categories/:id',
    async (request, reply) => {
      if (!ctx.taste.isUnlocked) return locked(reply);
      const body = request.body ?? {};
      if (body.name !== undefined && body.name.trim() === '') {
        return reply.code(400).send({ error: 'Give the category a name' });
      }
      const category = ctx.taste.updateCategory(request.params.id, body);
      if (!category) return reply.code(404).send({ error: 'That category is gone' });
      return category;
    },
  );

  /** Deleting a heading keeps the notes under it; they simply stop being filed. */
  app.delete<{ Params: { id: string } }>('/api/taste/categories/:id', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    if (!ctx.store.getTasteCategoryRow(request.params.id)) {
      return reply.code(404).send({ error: 'That category is gone' });
    }
    ctx.taste.deleteCategory(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Body: { text?: string; categoryId?: string | null } }>(
    '/api/taste/entries',
    async (request, reply) => {
      if (!ctx.taste.isUnlocked) return locked(reply);
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: 'Write something to remember' });
      return reply
        .code(201)
        .send(
          ctx.taste.addEntry(randomUUID(), {
            categoryId: request.body?.categoryId ?? null,
            text,
          }),
        );
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { text?: string; active?: boolean; categoryId?: string | null };
  }>('/api/taste/entries/:id', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    const body = request.body ?? {};
    if (body.text !== undefined && body.text.trim() === '') {
      return reply.code(400).send({ error: 'Write something to remember' });
    }
    const entry = ctx.taste.updateEntry(request.params.id, body);
    if (!entry) return reply.code(404).send({ error: 'That note is gone' });
    return entry;
  });

  app.delete<{ Params: { id: string } }>('/api/taste/entries/:id', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    if (!ctx.store.getTasteEntryRow(request.params.id)) {
      return reply.code(404).send({ error: 'That note is gone' });
    }
    ctx.taste.deleteEntry(request.params.id);
    return reply.code(204).send();
  });
}
