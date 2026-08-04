import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { UploadImageResponse } from '@latent/shared';

import type { AppContext } from './context.js';

/**
 * Pictures to feed into a workflow, read from a folder on the Latent machine.
 *
 * The important route is `use`: it copies the chosen file into ComfyUI's input
 * directory **server-side**, so the bytes never travel to the phone and back.
 * That matters — a folder of 12 MP photos is not something to round-trip over
 * mobile data just to say "this one".
 */
export function registerInputImageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/input-images', async () => ctx.inputs.scan());

  /**
   * The file itself. `preview=1` returns a small version for the picker grid;
   * the full bytes are only ever sent when the user asks to edit one.
   */
  app.get<{ Querystring: { path?: string; preview?: string } }>(
    '/api/input-images/file',
    async (request, reply) => {
      const { path, preview } = request.query;
      if (!path) return reply.code(400).send({ error: 'No image chosen' });

      if (preview) {
        const thumbnail = await ctx.inputs.thumbnail(path);
        if (!thumbnail) return reply.code(404).send({ error: 'That image is no longer there' });
        return reply
          .header('content-type', thumbnail.png ? 'image/png' : contentTypeFor(path))
          // Keyed by path, and a folder's files are effectively immutable in the
          // lifetime of a session, so let the phone keep them.
          .header('cache-control', 'private, max-age=3600')
          .send(thumbnail.data);
      }

      const file = await ctx.inputs.read(path);
      if (!file) return reply.code(404).send({ error: 'That image is no longer there' });
      return reply
        .header('content-type', contentTypeFor(path))
        .header('cache-control', 'private, max-age=3600')
        .send(file.data);
    },
  );

  /** Copy a chosen file into ComfyUI's input directory, ready for a LoadImage. */
  app.post<{ Body: { path?: string } }>('/api/input-images/use', async (request, reply) => {
    const path = request.body?.path;
    if (!path) return reply.code(400).send({ error: 'No image chosen' });

    const file = await ctx.inputs.read(path);
    if (!file) {
      return reply.code(404).send({
        error: 'That image is not in the input folder any more.',
      });
    }

    try {
      const result = await ctx.orchestrator.client.uploadImage(file.data, stableName(file.data, file.name), {
        contentType: contentTypeFor(file.name),
        type: 'input',
      });
      return result satisfies UploadImageResponse;
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : 'Could not send that image to ComfyUI',
      });
    }
  });
}

function contentTypeFor(filename: string): string {
  switch (filename.toLowerCase().split('.').pop() ?? '') {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'png':
    default:
      return 'image/png';
  }
}

/**
 * A name derived from the bytes, not from the clock.
 *
 * It used to carry a timestamp, so choosing the same picture twice put two
 * copies in ComfyUI's input directory — and since that directory *is* the
 * folder being browsed, they showed up in the picker as duplicates of what you
 * had just chosen. Naming by content means picking the same image again
 * resolves to the same file, and the upload (which already overwrites) is a
 * no-op rather than another copy.
 */
function stableName(data: Buffer, original: string): string {
  const safe = (original || 'input.png').replace(/[^\w.-]+/g, '_').slice(-80);
  const digest = createHash('sha256').update(data).digest('hex').slice(0, 12);
  return `latent_${digest}_${safe}`;
}
