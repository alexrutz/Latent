import type { FastifyInstance } from 'fastify';

import type { ImportRequest } from '@latent/shared';

import { VaultLockedError } from '../vault.js';
import type { AppContext } from './context.js';

export function registerImportRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** List what is in the configured folder, marking what has already come in. */
  app.get('/api/import/scan', async () => ctx.importer.scan());

  /**
   * One level of the tree, which is how an output directory is actually
   * organised — by day, by project, by model. The flat scan above stays for
   * anything that wants everything at once.
   */
  app.get<{ Querystring: { path?: string } }>('/api/import/browse', async (request) =>
    ctx.importer.browse(request.query?.path ?? ''),
  );

  app.post<{ Body: ImportRequest }>('/api/import', async (request, reply) => {
    const { paths, folder, recursive, rating } = request.body ?? {};
    if (rating !== undefined && (typeof rating !== 'number' || rating < 0 || rating > 5)) {
      return reply.code(400).send({ error: 'Rating must be between 0 and 5' });
    }

    // Importing writes into the encrypted archive, which needs the key.
    if (!ctx.vault.isUnlocked) {
      return reply.code(423).send({ error: new VaultLockedError().message, locked: true });
    }

    // A folder is expanded server-side: sending ten thousand paths up from a
    // phone to have them sent straight back down is not a plan.
    const selected =
      typeof folder === 'string'
        ? await ctx.importer.listFolder(folder, recursive === true)
        : (paths ?? []);

    if (selected.length === 0) {
      return reply.code(400).send({ error: 'Nothing selected to import' });
    }

    return ctx.importer.importFiles(selected, rating ?? 0);
  });
}
