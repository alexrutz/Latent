import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { rollRandomPrompt } from '@latent/shared';
import type { PromptBlockInput, RandomPromptConfig } from '@latent/shared';

import type { AppContext } from './context.js';

/** How many example draws a preview request returns. */
const PREVIEW_COUNT = 3;

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

  /* ---------------------------------------------------------------- */
  /* Random prompt mode                                                */
  /* ---------------------------------------------------------------- */

  app.get('/api/prompt-mode', async () => ctx.store.getRandomPromptConfig());

  app.patch<{ Body: Partial<RandomPromptConfig> }>('/api/prompt-mode', async (request) =>
    ctx.store.setRandomPromptConfig(request.body ?? {}),
  );

  /**
   * Example draws, so you can see what the mode will actually produce before
   * committing a batch of eight renders to it.
   *
   * Drawn here rather than in the browser so the preview uses exactly the same
   * code path as a real submit — a preview that agrees with itself but not with
   * the server would be worse than none.
   */
  app.post<{ Body: { base?: string; config?: Partial<RandomPromptConfig> } }>(
    '/api/prompt-mode/preview',
    async (request) => {
      const body = request.body ?? {};
      // Unsaved edits are honoured, so the preview tracks the controls live.
      const config = { ...ctx.store.getRandomPromptConfig(), ...(body.config ?? {}) };
      const blocks = ctx.store.listPromptBlocks();
      const base = typeof body.base === 'string' ? body.base : '';

      return {
        pool: blocks.filter(
          (block) => config.blockIds.length === 0 || config.blockIds.includes(block.id),
        ).length,
        rolls: Array.from({ length: PREVIEW_COUNT }, () =>
          rollRandomPrompt(blocks, config, base),
        ),
      };
    },
  );
}
