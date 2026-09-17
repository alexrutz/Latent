import type { FastifyInstance } from 'fastify';

import { ComfyError } from '../comfy/client.js';
import type { AppContext } from './context.js';

/**
 * The folder browser behind comfyllama's `LoadImageFromFolder`.
 *
 * Three routes, and all three are a pass-through to the ComfyUI machine. Latent
 * already reads ComfyUI's *input* folder off disk for the picture picker, and
 * doing the same for the output folder would have been less code than this — but
 * which folders may be browsed is decided over there, by the environment ComfyUI
 * was started with, and the node refuses to load anything outside them. A second
 * implementation here would be a second answer to that question, and the way it
 * would go wrong is by offering somebody a picture that then fails to load.
 *
 * So the allow-list stays in one place and Latent asks. The cost is that this
 * only works when the ComfyUI in question has comfyllama installed, which the
 * 404 below says plainly rather than leaving an empty list to be puzzled over.
 */
export function registerBrowseRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** comfyllama is not installed over there, or is too old to have the browser. */
  const missing = (error: unknown): boolean =>
    error instanceof ComfyError && (error.status === 404 || error.status === 405);

  const unavailable =
    'This ComfyUI does not have the comfyllama folder browser. Install or update ' +
    'comfyllama in its custom_nodes, then restart it.';

  app.get('/api/browse/roots', async (_request, reply) => {
    try {
      return await ctx.orchestrator.client.browseRoots();
    } catch (error) {
      if (missing(error)) return reply.code(404).send({ error: unavailable });
      throw error;
    }
  });

  app.get<{
    Querystring: {
      root?: string;
      path?: string;
      q?: string;
      sort?: string;
      order?: string;
      recursive?: string;
      limit?: string;
      kind?: string;
    };
  }>('/api/browse/list', async (request, reply) => {
    const { root, path, q, sort, order, recursive, limit, kind } = request.query;
    if (!root) return reply.code(400).send({ error: 'Which folder?' });

    try {
      return await ctx.orchestrator.client.browseList({
        root,
        path: path ?? '',
        q: q ?? '',
        sort: sort ?? 'date',
        order: order ?? 'desc',
        recursive: recursive === 'true' ? '1' : '',
        /*
         * What the slot can load, which the far end filters by.
         *
         * It was being dropped here — the picker asked for clips and this
         * handed the request on without the word, so comfyllama fell back to
         * its default and a video slot was offered pictures it cannot load.
         * The kind of thing that only shows up on the machine with the videos.
         */
        kind: kind ?? 'image',
        ...(limit ? { limit } : {}),
      });
    } catch (error) {
      if (missing(error)) return reply.code(404).send({ error: unavailable });
      throw error;
    }
  });

  /**
   * One thumbnail, piped straight through.
   *
   * Not re-encoded here: the far end already made a small WebP, and decoding it
   * only to encode it again would cost a phone nothing but latency.
   */
  app.get<{ Querystring: { root?: string; path?: string } }>(
    '/api/browse/thumb',
    async (request, reply) => {
      const { root, path } = request.query;
      if (!root || !path) return reply.code(400).send({ error: 'Which picture?' });

      let response: Response;
      try {
        response = await ctx.orchestrator.client.browseThumbnail(root, path);
      } catch (error) {
        if (error instanceof ComfyError && error.status === 404) {
          return reply.code(404).send({ error: 'That picture is no longer there' });
        }
        if (missing(error)) return reply.code(404).send({ error: unavailable });
        throw error;
      }

      const body = Buffer.from(await response.arrayBuffer());
      return (
        reply
          .header('content-type', response.headers.get('content-type') ?? 'image/webp')
          // Keyed by path and modification time on the far side, so a phone
          // holding one for an hour can only ever be holding the right one.
          .header('cache-control', 'private, max-age=3600')
          .send(body)
      );
    },
  );
}
