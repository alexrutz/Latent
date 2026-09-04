import { describe, expect, it, vi } from 'vitest';

import { CivitaiError, lookupByHash, toInfo } from './civitai.js';

const HASH = 'a'.repeat(64);

function answering(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
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

describe('reducing the response', () => {
  it('keeps nothing it was not asked for', () => {
    const info = toInfo({ id: 1, modelId: 2, name: 'v', baseModel: 'SD 1.5' });
    expect(Object.keys(info).sort()).toEqual([
      'baseModel',
      'description',
      'fetchedAt',
      'modelId',
      'name',
      'trainedWords',
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
