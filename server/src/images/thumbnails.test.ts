import { describe, expect, it } from 'vitest';

import { encodePng, readImageSize } from './png.js';
import { ThumbnailCache } from './thumbnails.js';

/**
 * The promise a preview makes.
 *
 * Nothing here is about looks. A gallery tile is 180 pixels across, and the
 * difference between sending it a 384-pixel picture and a 4000-pixel one is
 * 64 MB of decoded bitmap per tile in the browser — which is what took the tab
 * down when a page of upscaled images scrolled past.
 */

function png(width: number, height: number, seed = 0): Buffer {
  const pixels = new Uint8Array(width * height * 3);
  for (let at = 0; at < pixels.length; at += 3) {
    pixels[at] = (at + seed) % 256;
    pixels[at + 1] = (at * 3 + seed) % 256;
    pixels[at + 2] = 128;
  }
  return encodePng(width, height, pixels);
}

describe('deriving a thumbnail', () => {
  it('shrinks a big picture to the thumbnail size', async () => {
    const cache = new ThumbnailCache(384);
    const thumbnail = await cache.get('big', async () => png(1024, 768));

    expect(thumbnail?.contentType).toBe('image/png');
    const size = readImageSize(thumbnail!.data);
    expect(size).toEqual({ width: 384, height: 288 });
  });

  it('keeps the picture’s shape', async () => {
    const cache = new ThumbnailCache(384);
    const thumbnail = await cache.get('tall', async () => png(512, 1024));
    expect(readImageSize(thumbnail!.data)).toEqual({ width: 192, height: 384 });
  });

  it('passes a small one through untouched', async () => {
    const cache = new ThumbnailCache(384);
    const original = png(200, 200);
    const thumbnail = await cache.get('small', async () => original);
    expect(thumbnail?.data).toBe(original);
  });

  it('says so when it cannot read the format', async () => {
    const cache = new ThumbnailCache(384);
    expect(await cache.get('jpeg', async () => Buffer.from('not an image at all'))).toBeNull();
  });

  it('treats nothing at all as nothing to serve', async () => {
    const cache = new ThumbnailCache(384);
    expect(await cache.get('empty', async () => null)).toBeNull();
    expect(await cache.get('blank', async () => Buffer.alloc(0))).toBeNull();
  });
});

describe('keeping the work done', () => {
  it('derives once and answers from memory after that', async () => {
    const cache = new ThumbnailCache(384);
    let fetched = 0;
    const load = async () => {
      fetched += 1;
      return png(1024, 1024);
    };

    const first = await cache.get('once', load);
    const second = await cache.get('once', load);

    expect(fetched).toBe(1);
    expect(second).toBe(first);
  });

  it('fetches once for a whole grid asking at the same time', async () => {
    const cache = new ThumbnailCache(384);
    let fetched = 0;
    const load = async () => {
      fetched += 1;
      return png(1024, 1024);
    };

    // What a gallery page actually does: twenty tiles, one image.
    const all = await Promise.all(Array.from({ length: 20 }, () => cache.get('grid', load)));

    expect(fetched).toBe(1);
    expect(new Set(all).size).toBe(1);
  });

  it('remembers that a format cannot be read, rather than refetching', async () => {
    const cache = new ThumbnailCache(384);
    let fetched = 0;
    const load = async () => {
      fetched += 1;
      return Buffer.from('still not an image');
    };

    expect(await cache.get('bad', load)).toBeNull();
    expect(await cache.get('bad', load)).toBeNull();
    expect(fetched).toBe(1);
  });

  it('drops the oldest when the budget is spent', async () => {
    // A budget of one byte: room for whatever was just asked for, and nothing
    // else. Never zero entries, because the one in hand is never evicted.
    const cache = new ThumbnailCache(384, 1);

    await cache.get('a', async () => png(1024, 1024, 1));
    expect(cache.size).toBeGreaterThan(0);

    await cache.get('b', async () => png(1024, 1024, 2));

    // `a` is gone, so asking for it again has to derive it a second time.
    let refetched = 0;
    await cache.get('a', async () => {
      refetched += 1;
      return png(1024, 1024, 1);
    });
    expect(refetched).toBe(1);
  });

  it('forgets everything when told to', async () => {
    const cache = new ThumbnailCache(384);
    await cache.get('a', async () => png(1024, 1024));
    expect(cache.size).toBeGreaterThan(0);

    cache.clear();
    expect(cache.size).toBe(0);

    let refetched = 0;
    await cache.get('a', async () => {
      refetched += 1;
      return png(1024, 1024);
    });
    expect(refetched).toBe(1);
  });
});
