import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { contentTypeOf } from '@latent/shared';
import type {
  ComfyImageRef,
  CreateFavoriteRequest,
  Favorite,
  FavoriteReference,
  FavoriteSort,
} from '@latent/shared';

import { ArchiveUnreadableError, VaultLockedError } from '../vault.js';
import type { AppContext } from './context.js';

/**
 * ComfyUI's own directories, which the folder browser also serves as roots.
 *
 * A favourite whose picture is still in one of them can be referenced where it
 * lies — `output/monday/render_0007.png` — with nothing copied anywhere. The
 * fourth type Latent uses, `import`, is not one of these: an imported file
 * exists only in the local archive, and the node has never heard of it.
 */
const IN_PLACE_TYPES = new Set(['output', 'input', 'temp']);

const SORTS = new Set<FavoriteSort>(['rating', 'newest', 'oldest']);

/**
 * Favourites: kept images plus the settings that produced them.
 *
 * The purpose is "make more like this". So a favourite stores a *snapshot* of
 * the parameters rather than a reference to the gallery entry — deleting the
 * original, or the workflow, must not quietly empty the thing you saved.
 */
/**
 * Keep one picture, with the settings that made it.
 *
 * A function rather than only a route body because the parameter study needs
 * exactly this and nothing about it is specific to the gallery — a second copy
 * would be a second place to remember that favouriting has to archive, and it
 * would drift the first time either changed.
 *
 * `created` is false when there already was one, which makes tapping the star
 * twice harmless rather than a duplicate — and lets the route answer 200
 * rather than 201, so a client can tell the two apart.
 */
export async function keepAsFavorite(
  app: FastifyInstance,
  ctx: AppContext,
  input: { generationId: string; image: ComfyImageRef; note?: string | null },
): Promise<{ favorite: Favorite; created: boolean } | null> {
  const generation = ctx.store.getGeneration(input.generationId);
  if (!generation) return null;

  const row = ctx.store.findImage(input.image, input.generationId);
  if (!row) return null;

  const existing = ctx.store.findFavoriteByImage(row.id);
  if (existing) return { favorite: existing, created: false };

  /*
   * A favourite is only useful if the picture is still there later, so
   * favouriting archives the image exactly as rating does. Otherwise the
   * favourites tab would fill with dead references the moment the rented
   * instance went away.
   */
  if (!row.archived_path) {
    try {
      await ctx.archive.capture(ctx.orchestrator.client, row.id, input.image);
    } catch (error) {
      app.log.warn({ err: error }, 'Could not archive an image while favouriting it');
    }
  }

  const id = randomUUID();
  ctx.store.insertFavorite({
    id,
    imageId: row.id,
    generationId: input.generationId,
    workflowId: generation.workflowId,
    title: generation.title,
    note: input.note?.trim() || null,
    values: generation.values,
    image:
      ctx.store.getGeneration(input.generationId)?.images.find(
        (candidate) =>
          candidate.filename === input.image.filename &&
          candidate.subfolder === (input.image.subfolder ?? '') &&
          candidate.type === (input.image.type ?? 'output'),
      ) ?? null,
  });

  const favorite = ctx.store.getFavorite(id);
  return favorite ? { favorite, created: true } : null;
}

export function registerFavoriteRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { sort?: string } }>('/api/favorites', async (request) => {
    const requested = request.query.sort as FavoriteSort | undefined;
    return ctx.store.listFavorites(requested && SORTS.has(requested) ? requested : 'rating');
  });

  app.post<{ Body: CreateFavoriteRequest }>('/api/favorites', async (request, reply) => {
    const { generationId, image, note } = request.body ?? {};
    if (!generationId || !image?.filename) {
      return reply.code(400).send({ error: 'Which image?' });
    }

    if (!ctx.store.getGeneration(generationId)) {
      return reply.code(404).send({ error: 'Generation not found' });
    }

    const kept = await keepAsFavorite(app, ctx, { generationId, image, note });
    if (!kept) return reply.code(404).send({ error: 'That image is not in the gallery' });
    return reply.code(kept.created ? 201 : 200).send(kept.favorite);
  });

  app.patch<{ Params: { id: string }; Body: { rating?: number; note?: string | null } }>(
    '/api/favorites/:id',
    async (request, reply) => {
      if (!ctx.store.getFavorite(request.params.id)) {
        return reply.code(404).send({ error: 'Favourite not found' });
      }

      const { rating, note } = request.body ?? {};
      if (rating !== undefined && (typeof rating !== 'number' || rating < 0 || rating > 5)) {
        return reply.code(400).send({ error: 'Rating must be between 0 and 5' });
      }

      ctx.store.updateFavorite(request.params.id, { rating, note });
      return ctx.store.getFavorite(request.params.id);
    },
  );

  /**
   * Fetch the picture for a favourite that never got one.
   *
   * The copy made at favouriting time can fail — ComfyUI busy, the connection
   * dropped — and it was only logged, which left a favourite that looked fine
   * until the instance holding the picture went away. This is the second
   * chance, and it only works while the source is still reachable, so the
   * failure has to say that rather than "something went wrong".
   */
  app.post<{ Params: { id: string } }>('/api/favorites/:id/archive', async (request, reply) => {
    const favorite = ctx.store.getFavorite(request.params.id);
    if (!favorite) return reply.code(404).send({ error: 'No such favourite' });
    if (favorite.archived) return reply.send(favorite);
    if (!favorite.image) {
      return reply.code(409).send({ error: 'That favourite has no image to fetch.' });
    }

    const row = ctx.store.findImage(favorite.image, favorite.generationId ?? undefined);
    if (!row) {
      return reply.code(409).send({
        error: 'That picture is no longer in the gallery, so there is nothing left to copy.',
      });
    }

    try {
      await ctx.archive.capture(ctx.orchestrator.client, row.id, favorite.image);
    } catch (error) {
      app.log.warn({ err: error }, 'Could not archive a favourite on request');
      return reply.code(502).send({
        error:
          'ComfyUI could not give us that picture. It only works while the instance that ' +
          'made it is still reachable and still has the file.',
      });
    }

    return reply.send(ctx.store.getFavorite(request.params.id));
  });

  /**
   * A favourite, as something the folder-browsing node can actually load.
   *
   * The picker in a `LoadImageFromFolder` slot lists the gallery's favourites
   * beside `output` and `input`, because "the pictures I keep coming back to"
   * is the same list whether you are admiring one or feeding one back in. But a
   * favourite is a row in Latent's database, and the node takes a path on the
   * ComfyUI machine — so something has to turn one into the other, and that is
   * this.
   *
   * Two answers, and which one you get depends on where the picture still is:
   *
   * - **Where it lies.** The commonest case by far: the favourite is a render
   *   from this instance and is still sitting in its output folder. Then the
   *   reference is just that, nothing is copied, and the node reads the file
   *   that was already there. Checked rather than assumed — the whole point of
   *   favouriting is to outlive the folder.
   * - **Copied into `input`.** Anything else: a picture imported from a folder,
   *   one whose original was swept up, one from a vast.ai box that no longer
   *   exists. Latent has the bytes in its archive, so it sends them over and
   *   hands back where they landed.
   *
   * Named by content hash on that second path, so picking the same favourite
   * twice reuses one file instead of filling the input directory with copies of
   * one picture.
   */
  app.post<{ Params: { id: string } }>('/api/favorites/:id/reference', async (request, reply) => {
    const favorite = ctx.store.getFavorite(request.params.id);
    if (!favorite) return reply.code(404).send({ error: 'No such favourite' });
    if (!favorite.image) {
      return reply.code(409).send({ error: 'That favourite has no picture to load.' });
    }

    const image = favorite.image;
    const type = image.type || 'output';
    const within = image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename;

    if (IN_PLACE_TYPES.has(type)) {
      try {
        /*
         * Asked for, not assumed.
         *
         * `view` throws on a 404, which is precisely the answer that matters
         * here: the row still says `output/monday/render.png` long after the
         * output folder was emptied, and handing that to the node would be a
         * reference that fails at render time rather than at pick time.
         */
        const upstream = await ctx.orchestrator.client.view({
          filename: image.filename,
          subfolder: image.subfolder,
          type,
        });
        // The body is never read; releasing it keeps the socket from being held
        // open until the timeout for a file we only wanted to know exists.
        await upstream.body?.cancel();
        if (upstream.ok) {
          return { reference: `${type}/${within}`, copied: false } satisfies FavoriteReference;
        }
      } catch {
        // Gone, or the instance is unreachable. Either way there is a copy to
        // fall back on, and falling back is better than refusing.
      }
    }

    const row = ctx.store.findImage(image, favorite.generationId ?? undefined);
    let bytes: Buffer | null = null;
    try {
      if (row?.archived_path) bytes = await ctx.archive.read(row.archived_path);
    } catch (error) {
      if (error instanceof VaultLockedError) {
        return reply.code(423).send({ error: error.message, locked: true });
      }
      if (error instanceof ArchiveUnreadableError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }

    if (!bytes) {
      return reply.code(409).send({
        error:
          'That picture is not stored here and is no longer on the ComfyUI machine, so there ' +
          'is nothing to load. Open it in Favourites and fetch a copy first.',
      });
    }

    try {
      const uploaded = await ctx.orchestrator.client.uploadImage(bytes, stableName(bytes, image.filename), {
        contentType: contentTypeOf(image.filename),
        type: 'input',
      });
      const name = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
      return { reference: `input/${name}`, copied: true } satisfies FavoriteReference;
    } catch (error) {
      app.log.warn({ err: error }, 'Could not send a favourite to ComfyUI as an input');
      return reply.code(502).send({
        error: error instanceof Error ? error.message : 'Could not send that picture to ComfyUI',
      });
    }
  });

  /**
   * Removing a favourite leaves the archived image alone. The gallery rating is
   * a separate decision, and silently deleting a picture because someone
   * un-starred it here would be the wrong kind of surprise.
   */
  app.delete<{ Params: { id: string } }>('/api/favorites/:id', async (request, reply) => {
    if (!ctx.store.getFavorite(request.params.id)) {
      return reply.code(404).send({ error: 'Favourite not found' });
    }
    ctx.store.deleteFavorite(request.params.id);
    return reply.code(204).send();
  });
}

/**
 * A name derived from the bytes, so the same picture is uploaded once.
 *
 * ComfyUI's input directory is a flat namespace shared by everything anybody
 * has ever sent it, and a favourite that is picked for every render of an
 * afternoon would otherwise leave thirty identical files behind under thirty
 * different names. The hash also means the *contents* decide: a picture that
 * genuinely differs gets its own file even if it is called the same thing.
 *
 * Twelve characters of SHA-256 is far more than enough to keep one input
 * directory's worth of pictures apart, and short enough to still read as a
 * filename rather than as a key somebody pasted in.
 */
function stableName(data: Buffer, original: string): string {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
  const dot = original.lastIndexOf('.');
  const extension = dot > 0 ? original.slice(dot) : '.png';
  return `latent-favorite-${hash}${extension}`;
}
