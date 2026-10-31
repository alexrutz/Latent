import { describe, expect, it } from 'vitest';

import { renderPlaceholder } from '../mock/png.js';
import { makeThumbnailOffThread, thumbnailWorkerRunning } from './offThread.js';
import { makeThumbnail } from './png.js';

/**
 * Thumbnails are made on a worker thread.
 *
 * A large render is hundreds of milliseconds of plain JavaScript to shrink,
 * and on the main thread the whole server stood still for it — the first star
 * on a picture archived it, and every other request waited.
 */
describe('making a thumbnail off the main thread', () => {
  it('runs on the worker and gives the same picture', async () => {
    expect(thumbnailWorkerRunning()).toBe(true);
    const original = renderPlaceholder(1600, 1200, 'worker');
    const here = makeThumbnail(original, 512)!;
    const there = (await makeThumbnailOffThread(original, 512))!;
    expect([there.width, there.height]).toEqual([here.width, here.height]);
    expect(Buffer.compare(there.data, here.data)).toBe(0);
    // And it was the worker that did it, not the fallback after it died.
    expect(thumbnailWorkerRunning()).toBe(true);
  });

  it('leaves the event loop free while it works', async () => {
    const original = renderPlaceholder(4096, 4096, 'busy');
    // Warm the worker, so its start-up is not what is being measured.
    await makeThumbnailOffThread(renderPlaceholder(800, 800, 'warm'), 256);

    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    const started = Date.now();
    await makeThumbnailOffThread(original, 512);
    const took = Date.now() - started;
    clearInterval(timer);

    // On the main thread this would be zero ticks for the whole of `took`.
    expect(took).toBeGreaterThan(30);
    expect(ticks).toBeGreaterThan(Math.floor(took / 5 / 4));
  });

  it('is nothing for something it cannot read, as before', async () => {
    expect(await makeThumbnailOffThread(Buffer.from('not a picture'), 256)).toBeNull();
  });
});
