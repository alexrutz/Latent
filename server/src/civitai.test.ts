import { describe, expect, it, vi } from 'vitest';

import { CivitaiError, isExampleUrl, lookupByHash, toInfo } from './civitai.js';

const HASH = 'a'.repeat(64);

/**
 * A fetcher answering the version request, and 404 for anything else.
 *
 * The client asks twice now — the version by hash, then the model — so a
 * single-answer stub would hand the model endpoint a version body. Anything
 * not explicitly answered 404s, which is what the model request is allowed to
 * get.
 */
function answering(status: number, body: unknown): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const target = String(url);
    if (!target.includes('/by-hash/')) return new Response('{}', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

/** Answers both requests: the version by hash, then the model behind it. */
function answeringBoth(version: unknown, model: unknown): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const target = String(url);
    const body = target.includes('/by-hash/') ? version : model;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('looking a file up on Civitai', () => {
  it('keeps the trigger words, the base model and a link back', async () => {
    const info = await lookupByHash(
      HASH,
      answering(200, {
        id: 456,
        modelId: 123,
        name: 'v2',
        baseModel: 'SDXL 1.0',
        trainedWords: ['mystyle', '  spacing  ', ''],
        description: '<p>Use at <strong>0.7</strong>.</p>',
        model: { name: 'A Style', type: 'LORA' },
      }),
    );

    expect(info.trainedWords).toEqual(['mystyle', 'spacing']);
    expect(info.baseModel).toBe('SDXL 1.0');
    expect(info.name).toBe('A Style');
    expect(info.versionName).toBe('v2');
    expect(info.description).toBe('Use at 0.7.');
    expect(info.url).toBe('https://civitai.com/models/123?modelVersionId=456');
  });

  it('sends the hash to the by-hash endpoint and nothing else', async () => {
    const fetcher = answering(200, { id: 1, modelId: 2 });
    await lookupByHash(HASH, fetcher);

    const [url] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`https://civitai.com/api/v1/model-versions/by-hash/${HASH}`);
  });

  /*
   * The commonest outcome for anything trained at home, and not a fault: it has
   * its own flag so the caller can say "not on Civitai" rather than "lookup
   * failed", which are different things to be told.
   */
  it('marks a 404 as not-found rather than as a failure', async () => {
    await expect(lookupByHash(HASH, answering(404, { error: 'nope' }))).rejects.toMatchObject({
      name: 'CivitaiError',
      notFound: true,
    });
  });

  it('names rate limiting, because waiting is the fix', async () => {
    await expect(lookupByHash(HASH, answering(429, {}))).rejects.toThrow(/rate-limiting/);
  });

  it('reports a server error as one, and not as not-found', async () => {
    const error = await lookupByHash(HASH, answering(503, {})).catch((cause) => cause);
    expect(error).toBeInstanceOf(CivitaiError);
    expect((error as CivitaiError).notFound).toBe(false);
  });

  it('tells an unreachable network apart from an unknown file', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const error = await lookupByHash(HASH, offline).catch((cause) => cause);
    expect(error).toBeInstanceOf(CivitaiError);
    expect((error as CivitaiError).notFound).toBe(false);
    expect((error as CivitaiError).message).toMatch(/Could not reach/);
  });

  it('refuses something that is not a hash before making a request', async () => {
    const fetcher = answering(200, {});
    await expect(lookupByHash('not-a-hash', fetcher)).rejects.toThrow(/not a SHA256/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('survives a response that is not JSON', async () => {
    await expect(lookupByHash(HASH, answering(200, '<html>maintenance</html>'))).rejects.toThrow(
      /not JSON/,
    );
  });
});

/**
 * The half people actually read.
 *
 * The version carries trigger words and a changelog; the *model* carries the
 * paragraph explaining what the thing is for. Fetching only the first would
 * have made a library with no information in it.
 */
describe('the model behind the version', () => {
  const version = {
    id: 456,
    modelId: 123,
    name: 'v2',
    description: '<p>Fixed the hands.</p>',
    trainedWords: ['mystyle'],
    model: { name: 'stale name', type: 'LORA' },
  };

  it('fetches it, and prefers its name, description and type', async () => {
    const fetcher = answeringBoth(version, {
      name: 'A Style',
      description: '<p>Use at 0.7 with SDXL. Fights with detail LoRAs.</p>',
      type: 'LORA',
      tags: ['style', ' concept ', '', 42],
      creator: { username: 'somebody' },
    });

    const info = await lookupByHash(HASH, fetcher);

    expect(info.name).toBe('A Style');
    expect(info.modelDescription).toBe('Use at 0.7 with SDXL. Fights with detail LoRAs.');
    // The changelog is kept too, and kept apart — they answer different things.
    expect(info.description).toBe('Fixed the hands.');
    expect(info.creator).toBe('somebody');
    expect(info.tags).toEqual(['style', 'concept']);

    const urls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) =>
      String(url),
    );
    expect(urls).toEqual([
      `https://civitai.com/api/v1/model-versions/by-hash/${HASH}`,
      'https://civitai.com/api/v1/models/123',
    ]);
  });

  /*
   * The trigger words are the point and they arrive in the first response. A
   * model endpoint that is down, rate-limited or missing must not throw away a
   * lookup that already succeeded.
   */
  it('still succeeds when the model request fails', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/by-hash/')) {
        return new Response(JSON.stringify(version), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;

    const info = await lookupByHash(HASH, fetcher);
    expect(info.trainedWords).toEqual(['mystyle']);
    expect(info.modelDescription).toBeNull();
    // Falls back to the name the version carried.
    expect(info.name).toBe('stale name');
  });

  it('does not ask when there is no model id to ask about', async () => {
    const fetcher = answering(200, { id: 1, trainedWords: ['x'] });
    await lookupByHash(HASH, fetcher);
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe('the creator’s example pictures', () => {
  it('keeps the picture and the prompt behind it', async () => {
    const info = await lookupByHash(
      HASH,
      answering(200, {
        id: 1,
        images: [
          {
            url: 'https://image.civitai.com/abc/width=450/one.jpeg',
            width: 832,
            height: 1216,
            nsfwLevel: 1,
            meta: { prompt: '  a lighthouse in a storm  ' },
          },
        ],
      }),
    );

    expect(info.examples).toEqual([
      {
        url: 'https://image.civitai.com/abc/width=450/one.jpeg',
        width: 832,
        height: 1216,
        nsfwLevel: 1,
        prompt: 'a lighthouse in a storm',
      },
    ]);
  });

  /*
   * "What can this do" is the picture; "how do I get that" is the prompt. An
   * example with the metadata stripped is still worth showing, with nothing
   * where the prompt would be rather than an empty string pretending to be one.
   */
  it('keeps an example whose prompt the creator stripped', async () => {
    const info = await lookupByHash(
      HASH,
      answering(200, { id: 1, images: [{ url: 'https://image.civitai.com/a.jpeg', meta: null }] }),
    );
    expect(info.examples[0]?.prompt).toBeNull();
  });

  it('skips videos, which an img tag would draw as a broken picture', async () => {
    const info = await lookupByHash(
      HASH,
      answering(200, {
        id: 1,
        images: [
          { url: 'https://image.civitai.com/clip.mp4', type: 'video' },
          { url: 'https://image.civitai.com/still.jpeg', type: 'image' },
        ],
      }),
    );
    expect(info.examples.map((example) => example.url)).toEqual([
      'https://image.civitai.com/still.jpeg',
    ]);
  });

  it('caps how many are kept', async () => {
    const images = Array.from({ length: 40 }, (_, index) => ({
      url: `https://image.civitai.com/${index}.jpeg`,
    }));
    const info = await lookupByHash(HASH, answering(200, { id: 1, images }));
    expect(info.examples).toHaveLength(8);
  });

  it('is empty rather than broken when there are none', async () => {
    expect((await lookupByHash(HASH, answering(200, { id: 1 }))).examples).toEqual([]);
    expect(toInfo({ images: 'not a list' as never }).examples).toEqual([]);
  });
});

/**
 * The proxy's allowlist.
 *
 * Latent fetches these pictures on the phone's behalf, so the URL it is handed
 * decides what it will connect to. Anything but a Civitai image host is a
 * request to make this server fetch something for somebody.
 */
describe('which example URLs may be fetched', () => {
  it('allows Civitai image hosts over https, and nothing else', () => {
    expect(isExampleUrl('https://image.civitai.com/abc/one.jpeg')).toBe(true);
    expect(isExampleUrl('https://imagecache.civitai.com/abc/one.jpeg')).toBe(true);

    expect(isExampleUrl('http://image.civitai.com/one.jpeg')).toBe(false);
    expect(isExampleUrl('https://civitai.com/one.jpeg')).toBe(false);
    expect(isExampleUrl('https://image.civitai.com.evil.test/one.jpeg')).toBe(false);
    expect(isExampleUrl('https://127.0.0.1/one.jpeg')).toBe(false);
    expect(isExampleUrl('file:///etc/passwd')).toBe(false);
    expect(isExampleUrl('not a url')).toBe(false);
  });
});

describe('reducing the response', () => {
  it('keeps nothing it was not asked for', () => {
    const info = toInfo({ id: 1, modelId: 2, name: 'v', baseModel: 'SD 1.5' });
    expect(Object.keys(info).sort()).toEqual([
      'baseModel',
      'creator',
      'description',
      'examples',
      'fetchedAt',
      'modelDescription',
      'modelId',
      'name',
      'tags',
      'trainedWords',
      'type',
      'url',
      'versionId',
      'versionName',
    ]);
  });

  it('copes with a response missing everything', () => {
    const info = toInfo({});
    expect(info.trainedWords).toEqual([]);
    expect(info.url).toBeNull();
    expect(info.modelId).toBeNull();
  });

  it('links to the model even when the version id is missing', () => {
    expect(toInfo({ modelId: 7 }).url).toBe('https://civitai.com/models/7');
  });

  it('drops trained words that are not strings', () => {
    expect(toInfo({ trainedWords: ['ok', 5, null, { a: 1 }] as never }).trainedWords).toEqual([
      'ok',
    ]);
  });
});
