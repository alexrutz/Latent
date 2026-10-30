import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Archive } from './archive.js';
import { Store } from './db.js';
import { Importer } from './importer.js';

/**
 * An import whose copy fails has to be one you can try again.
 *
 * The gallery row went in first and stayed when the archive refused the file,
 * so the entry pointed at nothing — and since the path now counted as
 * imported, importing it again skipped it.
 */
describe('an import whose copy failed', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves nothing behind, and goes through on the next try', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-import-'));
    dirs.push(dir);
    const folder = join(dir, 'outputs');
    mkdirSync(folder);
    writeFileSync(join(folder, 'clip.mp4'), 'not really a video');

    const store = new Store(join(dir, 'test.db'));
    store.updateSettings({ importRoot: folder });

    let refuse = true;
    const archive = {
      async storeStreamed(imageId: number, _name: string, stream: Readable) {
        // Read to the end, as the real archive does, so the file is closed
        // before the folder is removed.
        for await (const _chunk of stream) void _chunk;
        if (refuse) throw new Error('No space left on device');
        store.setImageArchive(imageId, { path: 'ab/clip.bin', bytes: 1, encrypted: false });
      },
      async storeBytes() {
        throw new Error('not used');
      },
    } as unknown as Archive;
    const importer = new Importer(store, archive);

    const first = await importer.importFiles(['clip.mp4']);
    expect(first.failed).toHaveLength(1);
    expect(store.importedPaths().has('clip.mp4')).toBe(false);

    refuse = false;
    const second = await importer.importFiles(['clip.mp4']);
    expect(second).toMatchObject({ imported: 1, skipped: 0, failed: [] });
    expect(store.importedPaths().has('clip.mp4')).toBe(true);
  });
});
