import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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
/** The header a pass travels in. Not a cookie: it must not outlive the tab. */
const TICKET_HEADER = 'x-latent-taste';

/**
 * Drop a deleted heading's wandering rule along with the heading.
 *
 * The draw would never have consulted it — a rule keyed by an id that no longer
 * exists matches nothing — but "never consulted" is not the same as harmless.
 * The settings screen counts these rules to say what wandering is currently
 * doing, and a tally of headings that have not existed for weeks is a summary
 * that lies about the app to the only person who could tell.
 */
function forgetWanderRule(ctx: AppContext, categoryId: string): void {
  const settings = ctx.store.getSettings();
  const rules = settings.chat.wander?.draw?.categories;
  if (!rules || !(categoryId in rules)) return;

  const { [categoryId]: _gone, ...rest } = rules;
  ctx.store.updateSettings({
    chat: {
      ...settings.chat,
      wander: { ...settings.chat.wander, draw: { ...settings.chat.wander.draw, categories: rest } },
    },
  });
}

export function registerTasteRoutes(app: FastifyInstance, ctx: AppContext): void {
  const locked = (reply: FastifyReply) =>
    reply.code(423).send({ error: new VaultLockedError().message, locked: true });

  /**
   * Every route below needs the password, not just the session.
   *
   * Answered as 403 with a marker the screen can act on, so it knows to ask
   * rather than to show an error: being signed in is the wrong question here
   * and a "something went wrong" would send people looking for a bug.
   */
  const barred = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (ctx.tasteGate.check(request.headers[TICKET_HEADER])) return false;
    void reply.code(403).send({ error: 'Enter your password to open this', needsPassword: true });
    return true;
  };

  /**
   * Buy a pass with the app password.
   *
   * Rate-limited with the same counter the login uses, per address: this is a
   * second door onto the same password, and leaving it uncounted would make it
   * the cheaper one to hammer.
   */
  app.post<{ Body: { password?: string } }>('/api/taste/unlock', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    if (!ctx.auth.registerLoginAttempt(request.ip)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait a minute and try again.' });
    }
    if (!ctx.auth.checkPassword(request.body?.password)) {
      return reply.code(401).send({ error: 'That is not the password.' });
    }
    ctx.auth.clearLoginAttempts(request.ip);
    return { ticket: ctx.tasteGate.issue(), profile: ctx.taste.profile() };
  });

  /** Hand the pass back, which is what closing the screen does. */
  app.post('/api/taste/lock', async (request, reply) => {
    ctx.tasteGate.revoke(request.headers[TICKET_HEADER]);
    return reply.code(204).send();
  });

  app.get('/api/taste', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    if (barred(request, reply)) return reply;
    return ctx.taste.profile();
  });

  app.post<{ Body: { name?: string } }>('/api/taste/categories', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    if (barred(request, reply)) return reply;
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: 'Give the category a name' });
    return reply.code(201).send(ctx.taste.addCategory(randomUUID(), name));
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; active?: boolean } }>(
    '/api/taste/categories/:id',
    async (request, reply) => {
      if (!ctx.taste.isUnlocked) return locked(reply);
      if (barred(request, reply)) return reply;
      const body = request.body ?? {};
      if (body.name !== undefined && body.name.trim() === '') {
        return reply.code(400).send({ error: 'Give the category a name' });
      }
      const category = ctx.taste.updateCategory(request.params.id, body);
      if (!category) return reply.code(404).send({ error: 'That category is gone' });
      return category;
    },
  );

  /** The result of a drag: one new sequence for the categories it names. */
  app.post<{ Body: { ids?: string[] } }>('/api/taste/categories/reorder', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    if (barred(request, reply)) return reply;
    const ids = request.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return reply.code(400).send({ error: 'Send the new order as a list of ids' });
    }
    ctx.taste.reorderCategories(ids);
    return ctx.taste.profile();
  });

  /** Deleting a heading keeps the notes under it; they simply stop being filed. */
  app.delete<{ Params: { id: string } }>('/api/taste/categories/:id', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    if (barred(request, reply)) return reply;
    if (!ctx.store.getTasteCategoryRow(request.params.id)) {
      return reply.code(404).send({ error: 'That category is gone' });
    }
    ctx.taste.deleteCategory(request.params.id);
    forgetWanderRule(ctx, request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Body: { text?: string; categoryId?: string | null; always?: boolean } }>(
    '/api/taste/entries',
    async (request, reply) => {
      if (!ctx.taste.isUnlocked) return locked(reply);
      if (barred(request, reply)) return reply;
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: 'Write something to remember' });
      return reply.code(201).send(
        ctx.taste.addEntry(randomUUID(), {
          categoryId: request.body?.categoryId ?? null,
          text,
          always: request.body?.always,
        }),
      );
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { text?: string; active?: boolean; always?: boolean; categoryId?: string | null };
  }>('/api/taste/entries/:id', async (request, reply) => {
    if (!ctx.taste.isUnlocked) return locked(reply);
    if (barred(request, reply)) return reply;
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
    if (barred(request, reply)) return reply;
    if (!ctx.store.getTasteEntryRow(request.params.id)) {
      return reply.code(404).send({ error: 'That note is gone' });
    }
    ctx.taste.deleteEntry(request.params.id);
    return reply.code(204).send();
  });
}
