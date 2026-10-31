import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { makeThumbnail, type Thumbnail } from './png.js';

/**
 * `makeThumbnail`, on a thread of its own.
 *
 * A thumbnail is several hundred milliseconds of straight-line JavaScript for
 * a large render, and on the main thread the whole server waits for it: the
 * first star on a picture, which archives it, froze every other request for
 * that long, including the gallery pages being fetched at the same moment.
 *
 * One worker, started on first use and kept, so the cost of starting it is
 * paid once. It runs the compiled worker where there is one (`node dist`) and
 * the TypeScript through tsx where there is not (`tsx watch`, the tests). If
 * neither can start, or the worker dies, the work is done here as it always
 * was — slower for everyone else, but never a missing thumbnail.
 */
let worker: Worker | null = null;
let unavailable = false;
let nextId = 0;
const waiting = new Map<number, { resolve: (value: Thumbnail | null) => void; reject: (error: Error) => void }>();

function start(): Worker | null {
  if (worker || unavailable) return worker;
  const compiled = new URL('./thumbnailWorker.js', import.meta.url);
  const source = new URL('./thumbnailWorker.ts', import.meta.url);
  try {
    if (existsSync(fileURLToPath(compiled))) {
      worker = new Worker(compiled);
    } else if (existsSync(fileURLToPath(source))) {
      /*
       * TypeScript, so tsx has to be registered inside the worker first.
       * Passing `--import tsx` in `execArgv` is not enough — a worker does not
       * apply it, and the worker then died on its first import, every call
       * falling back to the main thread without anyone noticing.
       */
      worker = new Worker(
        `import('tsx/esm/api').then(({ register }) => { register(); return import(${JSON.stringify(source.href)}); });`,
        { eval: true },
      );
    } else {
      unavailable = true;
      return null;
    }
  } catch {
    unavailable = true;
    return null;
  }

  worker.on('message', (message: { id: number; thumbnail?: Thumbnail | null; error?: string }) => {
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (waiting.size === 0) worker?.unref();
    if (message.error !== undefined) {
      entry.reject(new Error(message.error));
      return;
    }
    const thumbnail = message.thumbnail;
    // Structured clone hands a Buffer back as a plain Uint8Array.
    entry.resolve(thumbnail ? { ...thumbnail, data: Buffer.from(thumbnail.data) } : null);
  });
  const fail = (error: Error) => {
    worker = null;
    unavailable = true;
    for (const entry of waiting.values()) entry.reject(error);
    waiting.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (code !== 0) fail(new Error(`The thumbnail worker stopped (${code})`));
    else worker = null;
  });
  /*
   * Not a reason for the process to stay up while it has nothing to do — and
   * held while it does (see below), so an answer still on its way is waited
   * for. After the listeners, not before: attaching a `message` listener
   * references the worker again, and the process then could not exit at all.
   */
  worker.unref();
  return worker;
}

export async function makeThumbnailOffThread(buffer: Buffer, maxSize: number): Promise<Thumbnail | null> {
  const thread = start();
  if (!thread) return makeThumbnail(buffer, maxSize);

  const id = (nextId += 1);
  try {
    return await new Promise<Thumbnail | null>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      thread.ref();
      // A copy, not a transfer: the caller still needs its bytes, and a Buffer
      // is often a slice of a pool that is not ours to hand away.
      thread.postMessage({ id, data: new Uint8Array(buffer), maxSize });
    });
  } catch {
    // The worker failed on this one or died: do it here instead.
    return makeThumbnail(buffer, maxSize);
  }
}

/** Whether thumbnails are being made off the main thread. For tests. */
export function thumbnailWorkerRunning(): boolean {
  return start() !== null;
}
