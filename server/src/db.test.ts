import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Store } from './db.js';

/**
 * The upgrade path for an install that already had a chat.
 *
 * Its address and its instructions were fields on the chat settings; both moved
 * out — the address into the connection list, the instructions into the system
 * prompt collection. Moving them rather than dropping them is the whole point:
 * the address is somebody's rented box, and the instructions are often months
 * of tuning.
 */
describe('migrating the chat settings', () => {
  const dirs: string[] = [];

  const store = (): Store => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-db-'));
    dirs.push(dir);
    return new Store(join(dir, 'test.db'));
  };

  /** Write the shape an older version stored, straight past the typed API. */
  const writeLegacyChat = (target: Store, chat: Record<string, unknown>) => {
    (
      target as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
      }
    ).db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('chat', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(chat));
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('turns the old address into a model server connection and keeps the instructions', () => {
    const subject = store();
    writeLegacyChat(subject, {
      baseUrl: 'http://192.168.1.50:8080',
      model: 'gemma',
      temperature: 1.4,
      systemPrompt: 'Talk like a photographer.',
      thinking: true,
    });

    let id = 0;
    subject.migrateChatSettings(() => `id-${(id += 1)}`);

    const llama = subject.listConnections().filter((entry) => entry.kind === 'llama');
    expect(llama).toHaveLength(1);
    expect(llama[0]?.url).toBe('http://192.168.1.50:8080');
    expect(llama[0]?.isActive).toBe(true);

    const prompts = subject.listSystemPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['Chat']);
    expect(prompts[0]?.text).toBe('Talk like a photographer.');

    const settings = subject.getSettings();
    expect(settings.chat.systemPromptId).toBe(prompts[0]?.id);
    // Sampling belongs to the model server's launch flags now; a stale number
    // here would keep overriding them.
    expect(settings.chat).not.toHaveProperty('temperature');
    expect(settings.chat).not.toHaveProperty('baseUrl');
    // Everything that did not move is untouched.
    expect(settings.chat.model).toBe('gemma');
    expect(settings.chat.thinking).toBe(true);
  });

  it('runs again without making a second copy of anything', () => {
    const subject = store();
    writeLegacyChat(subject, { baseUrl: 'http://127.0.0.1:8080', systemPrompt: 'Be brief.' });

    let id = 0;
    subject.migrateChatSettings(() => `id-${(id += 1)}`);
    const after = subject.getSettings().chat.systemPromptId;
    subject.migrateChatSettings(() => `id-${(id += 1)}`);

    expect(subject.listConnections().filter((entry) => entry.kind === 'llama')).toHaveLength(1);
    expect(subject.listSystemPrompts()).toHaveLength(1);
    expect(subject.getSettings().chat.systemPromptId).toBe(after);
  });

  it('leaves a database that never had a chat alone', () => {
    const subject = store();
    subject.migrateChatSettings(() => 'unused');

    expect(subject.listConnections()).toHaveLength(0);
    expect(subject.listSystemPrompts()).toHaveLength(0);
    expect(subject.getSettings().chat.systemPromptId).toBeNull();
  });
});

/**
 * One list, two kinds. The flag is "in use for its kind" now, so choosing a
 * model server must not stand ComfyUI down.
 */
describe('connections of two kinds', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps one of each kind active', () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-db-'));
    dirs.push(dir);
    const subject = new Store(join(dir, 'test.db'));

    subject.insertConnection('comfy-1', { name: 'Local', url: 'http://127.0.0.1:8188' });
    subject.insertConnection('llama-1', {
      kind: 'llama',
      name: 'Model server',
      url: 'http://127.0.0.1:8080',
    });
    subject.activateConnection('comfy-1');
    subject.activateConnection('llama-1');

    expect(subject.getActiveConnection('comfy')?.id).toBe('comfy-1');
    expect(subject.getActiveConnection('llama')?.id).toBe('llama-1');

    // A second ComfyUI takes over from the first, and leaves the other kind be.
    subject.insertConnection('comfy-2', { name: 'Rented', url: 'https://example.invalid:8188' });
    subject.activateConnection('comfy-2');

    expect(subject.getActiveConnection('comfy')?.id).toBe('comfy-2');
    expect(subject.getActiveConnection('llama')?.id).toBe('llama-1');
    expect(subject.countConnections('comfy')).toBe(2);
  });
});

/**
 * A setting that is a list, not a value and not a group.
 *
 * The browse favourites are the first of these, and they land in code written
 * for the other two shapes: a single string, or a group of fields merged over
 * its defaults. An array is `typeof 'object'`, so without a path of its own it
 * would take the group path and come back keyed by index — `{0: …, 1: …}` —
 * and removing the last entry would merge to no change at all.
 */
describe('settings held as a list', () => {
  const dirs: string[] = [];

  const store = (): Store => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-db-'));
    dirs.push(dir);
    return new Store(join(dir, 'test.db'));
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('comes back as a list, in order', () => {
    const subject = store();
    expect(subject.getSettings().fieldArrangement).toEqual([]);

    subject.updateSettings({
      fieldArrangement: [
        { name: 'steps', group: 'main' },
        { name: 'cfg', hidden: true },
      ],
    });

    const stored = subject.getSettings().fieldArrangement;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.map((entry) => entry.name)).toEqual(['steps', 'cfg']);
    expect(stored[1]?.hidden).toBe(true);
  });

  it('replaces rather than merges, so the last one can be removed', () => {
    const subject = store();
    subject.updateSettings({
      fieldArrangement: [{ name: 'steps' }, { name: 'cfg' }],
    });

    subject.updateSettings({ fieldArrangement: [{ name: 'cfg' }] });
    expect(subject.getSettings().fieldArrangement.map((entry) => entry.name)).toEqual(['cfg']);

    subject.updateSettings({ fieldArrangement: [] });
    expect(subject.getSettings().fieldArrangement).toEqual([]);
  });

  it('survives a restore from the mirror when the database has none', () => {
    const subject = store();
    const arrangement = [{ name: 'steps', group: 'main' as const }];

    subject.importUiState({ settings: { fieldArrangement: arrangement } } as never, () => 'id');
    expect(subject.getSettings().fieldArrangement).toEqual(arrangement);

    // Additive, as everywhere else: what is already stored wins.
    subject.importUiState(
      { settings: { fieldArrangement: [{ name: 'cfg' }] } } as never,
      () => 'id',
    );
    expect(subject.getSettings().fieldArrangement).toEqual(arrangement);
  });
});

/**
 * "Remove unrated copies" deletes the archived file, which is often the only
 * copy left once ComfyUI's output folder has been emptied. It has to spare
 * exactly what the sweep spares, or a favourite loses its picture.
 */
describe('which archived copies the prune offers up', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const store = (): Store => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-db-'));
    dirs.push(dir);
    return new Store(join(dir, 'test.db'));
  };

  /** One run with `count` archived pictures; returns their ids. */
  const run = (subject: Store, id: string, count = 2): number[] => {
    subject.insertGeneration({
      id,
      promptId: `prompt-${id}`,
      workflowId: null,
      workflowName: 'Test',
      title: id,
      values: {},
      seeds: {},
    });
    subject.addImages(
      `prompt-${id}`,
      '9',
      Array.from({ length: count }, (_, index) => ({
        filename: `${id}-${index}.png`,
        subfolder: '',
        type: 'output',
      })),
    );
    const ids = (subject.getGeneration(id)?.images ?? [])
      .map((image) => image.id)
      .filter((imageId): imageId is number => typeof imageId === 'number')
      .sort((a, b) => a - b);
    for (const imageId of ids) {
      subject.setImageArchive(imageId, { path: `ab/${imageId}.bin`, bytes: 10, encrypted: false });
    }
    return ids;
  };

  const offered = (subject: Store): number[] =>
    subject
      .listUnratedArchived()
      .map((row) => row.id)
      .sort((a, b) => a - b);

  it('offers a run nobody marked', () => {
    const subject = store();
    const ids = run(subject, 'plain');
    expect(offered(subject)).toEqual(ids);
  });

  it('spares a run with a star, a keep, or a favourite anywhere in it', () => {
    const subject = store();
    const [rated] = run(subject, 'rated');
    const [kept] = run(subject, 'kept');
    const [favourite] = run(subject, 'favourite');
    run(subject, 'run-favourite');
    subject.setImageRating(rated!, 3);
    subject.setImageKept(kept!, true);
    subject.insertFavorite({
      id: 'fav-image',
      imageId: favourite!,
      generationId: null,
      workflowId: null,
      title: '',
      note: null,
      values: {},
      image: null,
    });
    subject.insertFavorite({
      id: 'fav-run',
      imageId: null,
      generationId: 'run-favourite',
      workflowId: null,
      title: '',
      note: null,
      values: {},
      image: null,
    });
    expect(offered(subject)).toEqual([]);
  });

  it('never offers an imported picture', () => {
    const subject = store();
    const imageId = subject.insertImportedImage({
      generationId: 'import-1',
      promptId: 'import-1',
      title: 'From a folder',
      filename: 'holiday.png',
      subfolder: '',
      modifiedAt: Date.now(),
    });
    subject.setImageArchive(imageId, { path: 'cd/holiday.bin', bytes: 10, encrypted: false });
    expect(offered(subject)).toEqual([]);
  });
});

/**
 * Shots a paused study left behind, on the way back in.
 *
 * Every queued shot used to go back to pending, including the ones still
 * rendering — so pausing and resuming within a minute rendered them twice.
 */
describe('resuming a study', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const setUp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-db-'));
    dirs.push(dir);
    const subject = new Store(join(dir, 'test.db'));
    subject.insertStudy({ id: 's', name: 'Study', workflowId: null, workflowName: '', seed: 1 });
    subject.replaceShots('s', ['a', 'b', 'c', 'd'].map((id) => ({ id, values: {} })));
    const runAs = (shot: string, status: 'queued' | 'running' | 'completed' | 'cancelled') => {
      subject.insertGeneration({
        id: `g-${shot}`,
        promptId: `p-${shot}`,
        workflowId: null,
        workflowName: '',
        title: shot,
        values: {},
        seeds: {},
        source: 'study',
      });
      if (status !== 'queued') subject.setGenerationStatus(`p-${shot}`, status);
      subject.setShotStatus(shot, 'queued', `g-${shot}`);
    };
    return { subject, runAs };
  };

  it('leaves what is in flight, settles what finished, and requeues what was lost', () => {
    const { subject, runAs } = setUp();
    runAs('a', 'queued');
    runAs('b', 'running');
    runAs('c', 'completed');
    runAs('d', 'cancelled');

    expect(subject.requeueStranded('s')).toBe(1);
    const status = Object.fromEntries(
      subject.listShots('s').map((shot) => [shot.id, shot.status]),
    );
    expect(status).toEqual({ a: 'queued', b: 'queued', c: 'done', d: 'pending' });
  });

  it('counts a queued shot as unfinished, so the study does not end early', () => {
    const { subject, runAs } = setUp();
    for (const id of ['a', 'b', 'c']) subject.setShotStatus(id, 'done');
    runAs('d', 'running');
    expect(subject.hasUnfinishedShots('s')).toBe(true);
    subject.setShotStatus('d', 'done');
    expect(subject.hasUnfinishedShots('s')).toBe(false);
  });
});

/**
 * Each run's best star is stored, and kept by triggers, so the rating sort can
 * walk an index instead of working it out for the whole library every page.
 */
describe('the stored best rating', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const setUp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-db-'));
    dirs.push(dir);
    const subject = new Store(join(dir, 'test.db'));
    const run = (id: string, createdAt: number) => {
      subject.insertGeneration({ id, promptId: `p-${id}`, workflowId: null, workflowName: '', title: id, values: {}, seeds: {} });
      (subject as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
        .prepare('UPDATE generations SET created_at = ? WHERE id = ?')
        .run(createdAt, id);
      subject.setGenerationStatus(`p-${id}`, 'completed');
      subject.addImages(`p-${id}`, '9', [0, 1].map((i) => ({ filename: `${id}-${i}.png`, subfolder: '', type: 'output' })));
      return subject.getGeneration(id)!.images.map((image) => image.id!);
    };
    const order = () => subject.listGenerations({ limit: 10, sort: 'rating' }).items.map((item) => item.id);
    return { subject, run, order };
  };

  it('follows ratings up, down and away', () => {
    const { subject, run, order } = setUp();
    const [a1, a2] = run('a', 1);
    const [b1] = run('b', 2);
    run('c', 3);

    subject.setImageRating(a1!, 2);
    subject.setImageRating(a2!, 5);
    subject.setImageRating(b1!, 3);
    expect(order()).toEqual(['a', 'b', 'c']);

    // The best one taken back down: the next best in the run decides.
    subject.setImageRating(a2!, 0);
    expect(order()).toEqual(['b', 'a', 'c']);

    // A rated picture deleted takes its stars with it.
    subject.deleteImage(b1!);
    expect(order()).toEqual(['a', 'c', 'b']);
  });

  it('pages through the rating sort without repeating or skipping', () => {
    const { subject, run } = setUp();
    for (let i = 0; i < 7; i += 1) {
      const [first] = run(`r${i}`, i);
      subject.setImageRating(first!, i % 3);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = subject.listGenerations({ limit: 3, sort: 'rating', cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});

/**
 * Favourites a page at a time. The whole list used to come back on every look,
 * settings and all, and again after every change to any one of them.
 */
describe('favourites, a page at a time', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const setUp = (count: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'latent-db-'));
    dirs.push(dir);
    const subject = new Store(join(dir, 'test.db'));
    const raw = (subject as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    for (let i = 0; i < count; i += 1) {
      subject.insertFavorite({
        id: `f${String(i).padStart(2, '0')}`,
        imageId: null,
        generationId: null,
        workflowId: null,
        title: `favourite ${i}`,
        note: null,
        values: {},
        image: { filename: `pic${i}.png`, subfolder: 'day', type: 'output' } as never,
      });
      // Ties on purpose: several share a time and a rating, so the id has to
      // break them for a page boundary to land anywhere deterministic.
      raw.prepare('UPDATE favorites SET created_at = ?, rating = ? WHERE id = ?').run(
        Math.floor(i / 3),
        i % 4,
        `f${String(i).padStart(2, '0')}`,
      );
    }
    return subject;
  };

  for (const sort of ['newest', 'oldest', 'rating'] as const) {
    it(`walks every favourite once, sorted by ${sort}`, () => {
      const subject = setUp(17);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = subject.listFavoritesPage(sort, 4, cursor);
        seen.push(...page.items.map((favorite) => favorite.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      expect(pages).toBe(5);
      // The same order as the whole list, which is what a page boundary must
      // not disturb.
      expect(seen).toEqual(subject.listFavorites(sort).map((favorite) => favorite.id));
    });
  }

  it('says which pictures are favourites without their settings', () => {
    const subject = setUp(2);
    const index = subject.listFavoriteIndex();
    expect(index).toHaveLength(2);
    expect(index[0]).toEqual({
      id: expect.stringMatching(/^f0/),
      generationId: null,
      image: { id: null, filename: expect.stringMatching(/^pic/), subfolder: 'day', type: 'output' },
    });
    expect(JSON.stringify(index)).not.toContain('values');
  });
});
