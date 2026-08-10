import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { SystemPromptInput } from '@latent/shared';

import type { AppContext } from './context.js';

/**
 * The collected instructions, kept apart from the things that use them.
 *
 * A workflow that captions a picture or rewrites a prompt carries a paragraph of
 * instructions inside a node, where it is invisible from here and can only be
 * changed by opening ComfyUI and exporting the graph again. Collecting them
 * gives that text a name, one place to edit it, and a way to reach every
 * workflow with a matching field at once — plus the chat's own instructions,
 * which are the same kind of thing and were previously a box of their own.
 */
export function registerSystemPromptRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/system-prompts', async () => ctx.store.listSystemPrompts());

  app.post<{ Body: SystemPromptInput }>('/api/system-prompts', async (request, reply) => {
    const { name, text, position } = request.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Give the prompt a name' });
    }
    /*
     * Names are the matching key, so two of them are not a nuisance but an
     * ambiguity: which of the two would fill a field called that?
     */
    if (ctx.store.findSystemPromptByName(name)) {
      return reply.code(409).send({ error: `There is already a prompt called “${name.trim()}”.` });
    }

    const prompt = ctx.store.insertSystemPrompt(randomUUID(), {
      name,
      text: typeof text === 'string' ? text : '',
      position,
    });
    return reply.code(201).send(prompt);
  });

  app.patch<{ Params: { id: string }; Body: Partial<SystemPromptInput> }>(
    '/api/system-prompts/:id',
    async (request, reply) => {
      const existing = ctx.store.getSystemPrompt(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'No such prompt' });

      const patch = request.body ?? {};
      if (patch.name !== undefined) {
        if (typeof patch.name !== 'string' || patch.name.trim() === '') {
          return reply.code(400).send({ error: 'Give the prompt a name' });
        }
        const clash = ctx.store.findSystemPromptByName(patch.name);
        if (clash && clash.id !== existing.id) {
          return reply
            .code(409)
            .send({ error: `There is already a prompt called “${patch.name.trim()}”.` });
        }
      }

      ctx.store.updateSystemPrompt(existing.id, patch);
      return ctx.store.getSystemPrompt(existing.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/system-prompts/:id', async (request, reply) => {
    ctx.store.deleteSystemPrompt(request.params.id);
    /*
     * The chat is left pointing at nothing rather than being silently moved to
     * another prompt: falling back to Latent's own wording is a state the user
     * can see and undo, and picking a neighbour is not.
     */
    if (ctx.store.getSettings().chat.systemPromptId === request.params.id) {
      ctx.store.updateSettings({
        chat: { ...ctx.store.getSettings().chat, systemPromptId: null },
      });
    }
    return reply.code(204).send();
  });
}
