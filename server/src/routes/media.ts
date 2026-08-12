import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { ComfyImageRef, UploadImageResponse } from '@latent/shared';

import { ComfyError } from '../comfy/client.js';
import { readImageSize } from '../images/png.js';
import type { Region } from '../images/png.js';
import type { DerivedThumbnail } from '../images/thumbnails.js';
import { ArchiveUnreadableError, VaultLockedError } from '../vault.js';
import type { AppContext } from './context.js';

/** Guard against a filename walking out of ComfyUI's media directories. */
function isSafePathPart(value: string): boolean {
  return !value.includes('..') && !value.startsWith('/') && !value.includes('\\');
}

/**
 * Image "types" the proxy will serve.
 *
 * The first three are ComfyUI's own directories. `import` is ours: a file
 * scanned in from a folder, which exists only in the local archive. It has to be
 * listed here or every imported image 400s — which is exactly what happened
 * before, showing the whole gallery as "missing".
 */
const ALLOWED_TYPES = new Set(['output', 'input', 'temp', 'import']);
/** Types ComfyUI knows about, and which may therefore be fetched upstream. */
const UPSTREAM_TYPES = new Set(['output', 'input', 'temp']);
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Streams an image out of ComfyUI.
   *
   * The browser never reaches ComfyUI directly, so this is the only way images
   * get to the phone. `preview` asks for a small copy — which is made here,
   * because ComfyUI's own `preview=` only re-encodes and leaves the pixels
   * alone. See `ThumbnailCache`.
   */
  app.get<{
    Querystring: {
      filename?: string;
      subfolder?: string;
      type?: string;
      preview?: string;
      /** `WIDTHxHEIGHT`: the box a rendered view has to fit inside. */
      fit?: string;
      /** `X,Y,W,H` as fractions of the picture. Only meaningful with `fit`. */
      crop?: string;
      id?: string;
    };
  }>('/api/view', async (request, reply) => {
    const { filename, subfolder = '', type = 'output', preview, fit, crop, id } = request.query;

    if (!filename || !isSafePathPart(filename) || !isSafePathPart(subfolder)) {
      return reply.code(400).send({ error: 'Invalid image path' });
    }
    if (!ALLOWED_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid image type' });
    }

    const params = { filename, subfolder, type };
    /*
     * The row the client meant, when it knows. The name alone does not identify
     * a stored image — see `Store.findImage` — and resolving by name is how a
     * thumbnail ends up showing bytes from a different picture.
     */
    const rowId = Number(id);

    /*
     * Archive first. This single check is what makes a rated image keep working
     * after the ComfyUI that produced it has been destroyed — without it the
     * gallery would be a wall of broken thumbnails the moment a vast.ai
     * instance is torn down.
     */
    const known = ctx.store.findImage(
      Number.isFinite(rowId) && rowId > 0 ? { ...params, id: rowId } : params,
    );

    /**
     * Note the picture's real size, while we are holding the actual file.
     *
     * The browser used to do this, by measuring what `preview=` gave it. That
     * stopped being the original the moment thumbnails started being derived
     * here — a 4000×4000 output would be recorded as 384×384 — so the
     * measurement moved to the only place that still sees the whole thing. The
     * client's report survives as the fallback for formats this cannot decode,
     * which are exactly the ones it is still sent at full size.
     */
    const measure = (bytes: Buffer | null): Buffer | null => {
      if (!bytes || !known || (known.width && known.height)) return bytes;
      const size = readImageSize(bytes);
      if (size) ctx.store.setImageDimensions(known.id, size.width, size.height);
      return bytes;
    };

    /** Whatever this picture's bytes are, from wherever they live. */
    const loadOriginal = async (): Promise<Buffer | null> => {
      if (known?.archived_path) return measure(await ctx.archive.read(known.archived_path));
      if (!UPSTREAM_TYPES.has(type)) return null;
      const upstream = await ctx.orchestrator.client.view(params);
      if (!upstream.body) return null;
      return measure(Buffer.from(await upstream.arrayBuffer()));
    };

    /*
     * A view sized for the screen looking at it.
     *
     * The viewer used to open the original, which for a 4000×4000 output is
     * twenty megabytes to fetch and sixty-four to hold decoded — on a phone
     * that is also watching the next render. A screen has two million pixels;
     * everything past that is paid for and thrown away. `crop` is the same
     * request while zoomed in: a smaller rectangle at the same box, which is
     * how detail arrives without the whole frame ever being sent.
     */
    if (fit) {
      const box = parseBox(fit);
      const region = parseRegion(crop);
      if (!box) return reply.code(400).send({ error: 'Invalid fit box' });

      const key = viewKey(rowId, params);
      try {
        const view = await ctx.views.render(key, loadOriginal, box, region);
        if (view) {
          return reply
            .header('content-type', view.contentType)
            // The rectangle is part of the URL, so a view never goes stale —
            // and panning back to one already seen costs nothing.
            .header('cache-control', 'private, max-age=86400')
            .header('x-latent-source', 'view')
            .send(view.data);
        }
      } catch (error) {
        if (error instanceof VaultLockedError) {
          return reply.code(423).send({ error: error.message, locked: true });
        }
        if (error instanceof ArchiveUnreadableError) {
          return reply.code(409).send({ error: error.message });
        }
        return sendImageError(reply, error);
      }
      // Undecodable here, so fall through and send whatever the original is.
    }

    if (known?.archived_path) {
      /*
       * A stored `.webp` thumbnail is not one.
       *
       * Archiving used to file whatever ComfyUI answered `preview=webp;70`
       * with, believing it had been resized. It had not, so every archive
       * written before this holds full-size pictures under a name that says
       * otherwise. They are ignored rather than migrated: the original is
       * beside them and can be shrunk properly, which repairs an existing
       * archive by using it.
       */
      const stored = known.thumb_path?.endsWith('.png') ? known.thumb_path : null;
      // A `preview` request must never fall back to the full-size file: the
      // gallery grid asks for previews specifically to avoid pulling megabytes
      // over mobile data.
      const wantsThumbnail = Boolean(preview) && Boolean(stored);
      const path = wantsThumbnail ? (stored as string) : known.archived_path;

      try {
        if (preview && !wantsThumbnail) {
          const derived = await ctx.thumbnails.get(`archive:${known.archived_path}`, async () =>
            measure(await ctx.archive.read(known.archived_path as string)),
          );
          if (derived) {
            return reply
              .header('content-type', derived.contentType)
              .header('cache-control', 'private, max-age=86400')
              .header('x-latent-source', 'derived-thumb')
              .send(derived.data);
          }
        }

        const bytes = await ctx.archive.read(path);
        if (bytes) {
          return reply
            .header('content-type', wantsThumbnail ? thumbnailContentType(path) : contentTypeFor(filename))
            .header('cache-control', 'private, max-age=86400')
            .header('x-latent-source', wantsThumbnail ? 'archive-thumb' : 'archive')
            .send(bytes);
        }
      } catch (error) {
        if (error instanceof VaultLockedError) {
          return reply.code(423).send({ error: error.message, locked: true });
        }
        if (error instanceof ArchiveUnreadableError) {
          // Not a server fault, and retrying will never help. Say so plainly
          // rather than returning a 500 for a permanent condition.
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    }

    /*
     * An imported file only ever lives in our archive. Asking ComfyUI for it
     * would be meaningless — it has never heard of it — so fail honestly
     * instead of proxying a request that cannot succeed.
     */
    if (type === 'import' || !UPSTREAM_TYPES.has(type)) {
      if (known && !known.archived_path) {
        return reply.code(404).send({
          error: 'That imported image has no local copy. Import it again.',
        });
      }
      if (!ctx.vault.isUnlocked) {
        return reply.code(423).send({ error: new VaultLockedError().message, locked: true });
      }
      return reply.code(404).send({ error: 'That image is not in the local archive' });
    }

    /*
     * A preview has to be small, and only this end can promise that.
     *
     * ComfyUI's `preview=` re-encodes the file and moves not one pixel — a
     * 4000×4000 output comes back 4000×4000, which is a couple of megabytes on
     * the wire and 64 MB of bitmap once the browser has decoded it. A grid of
     * those is what was killing the tab. So the original is fetched once and
     * shrunk here, and the result is kept for every tile after the first.
     */
    if (preview) {
      const key =
        Number.isFinite(rowId) && rowId > 0
          ? `id:${rowId}`
          : `${type}/${subfolder}/${filename}`;

      let thumbnail: DerivedThumbnail | null;
      try {
        thumbnail = await ctx.thumbnails.get(key, async () => {
          const original = await ctx.orchestrator.client.view(params);
          if (!original.body) return null;
          return measure(Buffer.from(await original.arrayBuffer()));
        });
      } catch (error) {
        return sendImageError(reply, error);
      }

      if (thumbnail) {
        return reply
          .header('content-type', thumbnail.contentType)
          .header('cache-control', 'private, max-age=86400')
          .header('x-latent-source', 'derived-thumb')
          .send(thumbnail.data);
      }
      // Nothing we can decode — a JPEG, a 16-bit or interlaced PNG. Fall
      // through and let ComfyUI's own re-encode do what little it can.
    }

    let response: Response;
    try {
      response = await ctx.orchestrator.client.view({ ...params, preview });
    } catch (error) {
      // Not every ComfyUI build implements `preview=`. Retry at full size
      // rather than showing the user a broken thumbnail.
      if (preview && error instanceof ComfyError && error.status && error.status < 500) {
        try {
          response = await ctx.orchestrator.client.view(params);
        } catch (retryError) {
          return sendImageError(reply, retryError);
        }
      } else {
        return sendImageError(reply, error);
      }
    }

    if (!response.body) return reply.code(502).send({ error: 'ComfyUI returned an empty image' });

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = response.headers.get('content-length');

    reply.header('content-type', contentType);
    if (contentLength) reply.header('content-length', contentLength);
    // Output filenames are effectively immutable, so let the phone keep them.
    reply.header('cache-control', type === 'output' ? 'private, max-age=86400' : 'no-store');

    return reply.send(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>));
  });

  /** Upload a photo from the phone into ComfyUI's input directory. */
  app.post('/api/upload', async (request, reply) => {
    const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!file) return reply.code(400).send({ error: 'No file was uploaded' });

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'That image is too large (limit 64 MB)' });
    }

    if (!file.mimetype.startsWith('image/')) {
      return reply.code(400).send({ error: 'Only image files can be uploaded' });
    }

    try {
      const result = await ctx.orchestrator.client.uploadImage(buffer, uniqueName(file.filename), {
        contentType: file.mimetype,
        type: 'input',
      });
      return result satisfies UploadImageResponse;
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : 'Upload to ComfyUI failed',
      });
    }
  });

  /**
   * Copy an existing result back into ComfyUI's input directory.
   *
   * This is what makes "Send to img2img" and "Upscale this" work from the
   * gallery: a LoadImage node can only read from the input directory, so the
   * output file has to be round-tripped through the server first.
   */
  app.post<{ Body: ComfyImageRef & { id?: number } }>('/api/images/to-input', async (request, reply) => {
    const { filename, subfolder = '', type = 'output', id } = request.body ?? {};

    if (!filename || !isSafePathPart(filename) || !isSafePathPart(subfolder)) {
      return reply.code(400).send({ error: 'Invalid image path' });
    }
    if (!ALLOWED_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid image type' });
    }

    try {
      let buffer: Buffer;
      let contentType = 'image/png';

      /*
       * Prefer the local archive. For an imported file it is the only source —
       * ComfyUI has never seen it — and for a rated one it saves a round trip
       * and still works when the instance that produced it is long gone.
       */
      const known = ctx.store.findImage({ filename, subfolder, type, ...(id ? { id } : {}) });
      const local = known?.archived_path ? await ctx.archive.read(known.archived_path) : null;

      if (local) {
        buffer = local;
        contentType = contentTypeFor(filename);
      } else if (UPSTREAM_TYPES.has(type)) {
        const response = await ctx.orchestrator.client.view({ filename, subfolder, type });
        buffer = Buffer.from(await response.arrayBuffer());
        contentType = response.headers.get('content-type') ?? 'image/png';
      } else {
        return reply.code(404).send({
          error: 'That image has no local copy, and ComfyUI does not have it either.',
        });
      }

      const result = await ctx.orchestrator.client.uploadImage(buffer, uniqueName(filename), {
        contentType,
        type: 'input',
      });
      return result satisfies UploadImageResponse;
    } catch (error) {
      if (error instanceof VaultLockedError) {
        return reply.code(423).send({ error: error.message, locked: true });
      }
      return reply.code(502).send({
        error: error instanceof Error ? error.message : 'Could not copy the image into ComfyUI',
      });
    }
  });
}

function sendImageError(reply: FastifyReply, error: unknown) {
  if (error instanceof ComfyError && error.status === 404) {
    return reply.code(404).send({ error: 'That image is no longer in ComfyUI' });
  }
  return reply.code(502).send({
    error: error instanceof Error ? error.message : 'Could not fetch the image from ComfyUI',
  });
}

/** Thumbnails come from ComfyUI as WebP, or from our own encoder as PNG. */
/** Longest side a view is ever asked for, whatever the client claims. */
const MAX_VIEW_EDGE = 4096;

/** `WIDTHxHEIGHT`, clamped — the box comes from a browser and is not trusted. */
export function parseBox(raw: string): { width: number; height: number } | null {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(raw.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) return null;
  return { width: Math.min(width, MAX_VIEW_EDGE), height: Math.min(height, MAX_VIEW_EDGE) };
}

/**
 * `X,Y,W,H` as fractions of the picture, or nothing for the whole of it.
 *
 * Anything malformed is *nothing* rather than an error: a crop is an
 * optimisation, and answering with the whole picture is always right.
 */
export function parseRegion(raw: string | undefined): Region | null {
  if (!raw) return null;
  const parts = raw.split(',').map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = parts as [number, number, number, number];
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.max(0, Math.min(x, 1)),
    y: Math.max(0, Math.min(y, 1)),
    width: Math.min(width, 1),
    height: Math.min(height, 1),
  };
}

/** What identifies the picture a view is of — the row when there is one. */
function viewKey(rowId: number, params: { type: string; subfolder: string; filename: string }): string {
  return Number.isFinite(rowId) && rowId > 0
    ? `id:${rowId}`
    : `${params.type}/${params.subfolder}/${params.filename}`;
}

function thumbnailContentType(path: string): string {
  return path.endsWith('.webp') ? 'image/webp' : 'image/png';
}

function contentTypeFor(filename: string): string {
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'png':
    default:
      return 'image/png';
  }
}

/**
 * Prefix with a timestamp so uploading `IMG_0001.jpg` twice doesn't silently
 * replace the first one (phones reuse camera filenames constantly).
 */
function uniqueName(original: string): string {
  const safe = (original || 'upload.png').replace(/[^\w.-]+/g, '_').slice(-80);
  return `latent_${Date.now().toString(36)}_${safe}`;
}
