import type { FastifyInstance } from 'fastify';

import { MODEL_FOLDERS, resolveWords } from '@latent/shared';
import type { ModelFile, ModelFolder, ModelNote, ModelSummary } from '@latent/shared';

import { CivitaiError, isExampleUrl, lookupByHash } from '../civitai.js';
import type { AppContext } from './context.js';

/**
 * The library of models installed on the ComfyUI machine.
 *
 * Three routes and one idea: a LoRA is useless without the words it wants, and
 * those words are on a web page rather than anywhere near the prompt box. So
 * this joins what the file says about itself (read by comfyllama, on the disk
 * the file is on) to what Latent has been told about it (the notes table), and
 * offers to ask Civitai for the rest.
 *
 * The comfyllama half is allowed to fail. A ComfyUI without the extension still
 * has models, and the library still lists them — from `/object_info`, with no
 * metadata behind them — because a screen that shows nothing at all is worse
 * than one that shows names and says why there is nothing else.
 */
const COMFYLLAMA_MISSING =
  'This ComfyUI does not have comfyllama, so the files cannot be read for ' +
  'trigger words. Install or update comfyllama in its custom_nodes.';

function isFolder(value: string): value is ModelFolder {
  return (MODEL_FOLDERS as string[]).includes(value);
}

/** A file with nothing known about it, for a ComfyUI with no comfyllama. */
function bare(name: string): ModelFile {
  return {
    name,
    size: null,
    modified: null,
    trainedTags: [],
    baseModel: null,
    title: null,
    description: null,
    networkDim: null,
    networkAlpha: null,
    clipSkip: null,
    trainImages: null,
    hasMetadata: false,
  };
}

export function registerModelRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Every model in a folder, joined to what is known about it.
   *
   * The join is by name, which is the identifier that survives the trip to a
   * phone and back into a `<lora:…>` tag. A note for a model that is no longer
   * installed is kept in the table but not listed: uninstalling something for
   * an afternoon should not throw away the words you wrote for it.
   */
  app.get<{ Querystring: { folder?: string } }>('/api/models', async (request, reply) => {
    const folder = request.query.folder ?? 'loras';
    if (!isFolder(folder)) return reply.code(400).send({ error: 'Unknown model folder' });

    let files: ModelFile[] = [];
    let warning: string | null = null;

    try {
      const listed = await ctx.orchestrator.client.listModelFiles(folder);
      files = (listed.models as ModelFile[]) ?? [];
      if (listed.error) warning = listed.error;
    } catch {
      /*
       * Fall back to the names ComfyUI itself publishes. They are enough to
       * write notes and trigger words against, which is most of the value —
       * only the reading-the-header half is lost.
       */
      warning = COMFYLLAMA_MISSING;
      try {
        const names = await ctx.orchestrator.client.models(folder);
        files = names.map(bare);
      } catch {
        files = [];
      }
    }

    const notes = new Map(
      ctx.store.listModelNotes(folder).map((note) => [note.name, note] as const),
    );

    const models: ModelSummary[] = files.map((file) => {
      const note = notes.get(file.name) ?? null;
      const { words, from } = resolveWords(file, note);
      return { ...file, folder, note, words, wordsFrom: from };
    });

    return { folder, models, warning };
  });

  /**
   * One of the creator's example pictures, fetched by Latent, not by the phone.
   *
   * Proxied for the same reason every other picture here is: the phone talks to
   * Latent and to nothing else. It may be on a LAN with no route to the
   * internet while the server has one, and a page reaching a third-party CDN
   * directly tells that CDN which models somebody has installed.
   *
   * The allowlist is the whole security of it — see `isExampleUrl`. Without it
   * this is a machine that fetches whatever anybody names, from inside the
   * network Latent runs in.
   */
  app.get<{ Querystring: { url?: string } }>('/api/models/example', async (request, reply) => {
    const url = request.query.url ?? '';
    if (!isExampleUrl(url)) return reply.code(400).send({ error: 'Not an example image' });

    let upstream: Response;
    try {
      upstream = await fetch(url, { headers: { accept: 'image/*' } });
    } catch {
      return reply.code(502).send({ error: 'Could not fetch that picture' });
    }

    const type = upstream.headers.get('content-type') ?? '';
    if (!upstream.ok || !type.startsWith('image/')) {
      return reply.code(502).send({ error: 'Could not fetch that picture' });
    }

    /*
     * Civitai's URLs carry the transformation in the path, so a given URL is
     * one immutable picture and can be held for as long as anybody likes.
     */
    return reply
      .header('content-type', type)
      .header('cache-control', 'private, max-age=604800, immutable')
      .send(Buffer.from(await upstream.arrayBuffer()));
  });

  /** Your own words, notes and strength for one model. */
  app.put<{
    Params: { folder: string; name: string };
    Body: Partial<Pick<ModelNote, 'triggerWords' | 'notes' | 'strength'>>;
  }>('/api/models/:folder/:name/note', async (request, reply) => {
    const { folder, name } = request.params;
    if (!isFolder(folder)) return reply.code(400).send({ error: 'Unknown model folder' });

    const body = request.body ?? {};
    const patch: Partial<Omit<ModelNote, 'folder' | 'name' | 'updatedAt'>> = {};

    if (body.triggerWords !== undefined) {
      if (!Array.isArray(body.triggerWords)) {
        return reply.code(400).send({ error: 'Trigger words must be a list' });
      }
      patch.triggerWords = body.triggerWords
        .filter((word): word is string => typeof word === 'string')
        .map((word) => word.trim())
        .filter((word) => word !== '');
    }
    if (body.notes !== undefined) patch.notes = String(body.notes);
    if (body.strength !== undefined) {
      const strength = body.strength === null ? null : Number(body.strength);
      if (strength !== null && !Number.isFinite(strength)) {
        return reply.code(400).send({ error: 'Strength must be a number' });
      }
      patch.strength = strength;
    }

    return ctx.store.saveModelNote(folder, decodeURIComponent(name), patch);
  });

  /**
   * Forget everything Latent knows about one model.
   *
   * Distinct from clearing the fields, which is why it is its own verb: the
   * words and notes you typed are only half a note, and a lookup that matched
   * the wrong thing, or a description from a version you have since replaced,
   * cannot be emptied by blanking a text box. This puts the model back to
   * "nothing gathered", which is where it started.
   */
  app.delete<{ Params: { folder: string; name: string } }>(
    '/api/models/:folder/:name/note',
    async (request, reply) => {
      const { folder } = request.params;
      if (!isFolder(folder)) return reply.code(400).send({ error: 'Unknown model folder' });
      ctx.store.deleteModelNote(folder, decodeURIComponent(request.params.name));
      return reply.code(204).send();
    },
  );

  /**
   * Ask Civitai what this file is.
   *
   * Two round trips on purpose, and both are slow enough to be worth naming:
   * hashing the file happens on the ComfyUI machine and is tens of seconds for
   * a checkpoint, then the lookup itself goes out to the internet. Which is why
   * this is a button somebody presses rather than something the listing does on
   * its own for forty models at once.
   */
  app.post<{ Params: { folder: string; name: string } }>(
    '/api/models/:folder/:name/lookup',
    async (request, reply) => {
      const { folder } = request.params;
      if (!isFolder(folder)) return reply.code(400).send({ error: 'Unknown model folder' });
      const name = decodeURIComponent(request.params.name);

      // Reuse the hash if this file has been looked up before: it is keyed by
      // content on the far side, so re-reading 7 GB to get the same answer is
      // the one cost worth avoiding here.
      let sha256 = ctx.store.getModelNote(folder, name)?.sha256 ?? null;
      if (!sha256) {
        try {
          sha256 = (await ctx.orchestrator.client.modelHash(folder, name)).sha256;
        } catch {
          return reply.code(502).send({ error: COMFYLLAMA_MISSING });
        }
      }
      if (!sha256) return reply.code(404).send({ error: 'No such model' });

      try {
        const civitai = await lookupByHash(sha256);
        return ctx.store.saveModelNote(folder, name, { civitai, sha256 });
      } catch (cause) {
        // The hash is worth keeping even when the lookup failed — it is the
        // expensive half, and it does not change.
        ctx.store.saveModelNote(folder, name, { sha256 });
        if (cause instanceof CivitaiError) {
          return reply.code(cause.notFound ? 404 : 502).send({ error: cause.message });
        }
        throw cause;
      }
    },
  );
}
