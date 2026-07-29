import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { ComfyImageRef, UploadImageResponse } from '@latent/shared';

import { ComfyError } from '../comfy/client.js';
import type { AppContext } from './context.js';

/** Guard against a filename walking out of ComfyUI's media directories. */
function isSafePathPart(value: string): boolean {
  return !value.includes('..') && !value.startsWith('/') && !value.includes('\\');
}

const ALLOWED_TYPES = new Set(['output', 'input', 'temp']);
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export function registerMediaRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Streams an image out of ComfyUI.
   *
   * The browser never reaches ComfyUI directly, so this is the only way images
   * get to the phone. `preview` asks ComfyUI for a resized copy — a big win for
   * gallery scrolling over mobile data — and is silently dropped if the server
   * is too old to support it.
   */
  app.get<{
    Querystring: { filename?: string; subfolder?: string; type?: string; preview?: string };
  }>('/api/view', async (request, reply) => {
    const { filename, subfolder = '', type = 'output', preview } = request.query;

    if (!filename || !isSafePathPart(filename) || !isSafePathPart(subfolder)) {
      return reply.code(400).send({ error: 'Invalid image path' });
    }
    if (!ALLOWED_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid image type' });
    }

    const params = { filename, subfolder, type };

    /*
     * Archive first. This single check is what makes a rated image keep working
     * after the ComfyUI that produced it has been destroyed — without it the
     * gallery would be a wall of broken thumbnails the moment a vast.ai
     * instance is torn down.
     */
    const known = ctx.store.findImage(params);
    if (known?.archived_path) {
      const bytes = await ctx.archive.read(known.archived_path);
      if (bytes) {
        return reply
          .header('content-type', contentTypeFor(filename))
          .header('cache-control', 'private, max-age=86400')
          .header('x-latent-source', 'archive')
          .send(bytes);
      }
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
  app.post<{ Body: ComfyImageRef }>('/api/images/to-input', async (request, reply) => {
    const { filename, subfolder = '', type = 'output' } = request.body ?? {};

    if (!filename || !isSafePathPart(filename) || !isSafePathPart(subfolder)) {
      return reply.code(400).send({ error: 'Invalid image path' });
    }
    if (!ALLOWED_TYPES.has(type)) {
      return reply.code(400).send({ error: 'Invalid image type' });
    }

    try {
      const response = await ctx.orchestrator.client.view({ filename, subfolder, type });
      const buffer = Buffer.from(await response.arrayBuffer());
      const result = await ctx.orchestrator.client.uploadImage(buffer, uniqueName(filename), {
        contentType: response.headers.get('content-type') ?? 'image/png',
        type: 'input',
      });
      return result satisfies UploadImageResponse;
    } catch (error) {
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
