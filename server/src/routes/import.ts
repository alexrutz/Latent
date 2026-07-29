import type { FastifyInstance } from 'fastify';

import type { ImportRequest } from '@latent/shared';

import { VaultLockedError } from '../vault.js';
import type { AppContext } from './context.js';

export function registerImportRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** List what is in the configured folder, marking what has already come in. */
  app.get('/api/import/scan', async () => ctx.importer.scan());

  app.post<{ Body: ImportRequest }>('/api/import', async (request, reply) => {
    const { paths, rating } = request.body ?? {};
    if (!Array.isArray(paths) || paths.length === 0) {
      return reply.code(400).send({ error: 'Nothing selected to import' });
    }
    if (rating !== undefined && (typeof rating !== 'number' || rating < 0 || rating > 5)) {
      return reply.code(400).send({ error: 'Rating must be between 0 and 5' });
    }

    // Importing writes into the encrypted archive, which needs the key.
    if (!ctx.vault.isUnlocked) {
      return reply.code(423).send({ error: new VaultLockedError().message, locked: true });
    }

    return ctx.importer.importFiles(paths, rating ?? 0);
  });
}
