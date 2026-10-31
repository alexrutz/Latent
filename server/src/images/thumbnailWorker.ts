import { parentPort } from 'node:worker_threads';

import { makeThumbnail } from './png.js';

/**
 * The other end of `makeThumbnailOffThread`: decode and shrink, one at a time.
 *
 * Its own thread because the work is hundreds of milliseconds of plain
 * JavaScript per picture — undoing the PNG filters and resizing, not zlib —
 * and on the main thread nothing else can run meanwhile: not the gallery's
 * requests, not the ComfyUI socket.
 */
parentPort?.on('message', (message: { id: number; data: Uint8Array; maxSize: number }) => {
  try {
    const buffer = Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength);
    const thumbnail = makeThumbnail(buffer, message.maxSize);
    parentPort?.postMessage({ id: message.id, thumbnail });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
