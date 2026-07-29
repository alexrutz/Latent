import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { PromptBlockInput } from '@latent/shared';

import type { AppContext } from './context.js';

/**
 * Saved fragments of prompt text.
 *
 * Long prompts are the single most tedious thing to produce on a phone
 * keyboard. Storing the phrases you reuse — a lighting setup, a camera, a style
 * — turns writing one into tapping a few chips instead of typing a paragraph.
 */
export function registerPromptBlockRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/prompt-blocks', async () => ctx.store.listPromptBlocks());

  app.post<{ Body: PromptBlockInput }>('/api/prompt-blocks', async (request, reply) => {
    const { name, text, category, position } = request.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
      return reply.code(400).send({ error: 'Give the block a name' });
    }
    if (typeof text !== 'string' || text.trim() === '') {
      return reply.code(400).send({ error: 'A block needs some text' });
    }

    const block = ctx.store.insertPromptBlock(randomUUID(), {
      name,
      text: text.trim(),
      category,
      position,
    });
    return reply.code(201).send(block);
  });

  app.patch<{ Params: { id: string }; Body: Partial<PromptBlockInput> }>(
    '/api/prompt-blocks/:id',
    async (request, reply) => {
      if (!ctx.store.getPromptBlock(request.params.id)) {
        return reply.code(404).send({ error: 'Block not found' });
      }
      ctx.store.updatePromptBlock(request.params.id, request.body ?? {});
      return ctx.store.getPromptBlock(request.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/prompt-blocks/:id', async (request, reply) => {
    if (!ctx.store.getPromptBlock(request.params.id)) {
      return reply.code(404).send({ error: 'Block not found' });
    }
    ctx.store.deletePromptBlock(request.params.id);
    return reply.code(204).send();
  });
}
