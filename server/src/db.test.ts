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
    expect(subject.getSettings().browseFavorites).toEqual([]);

    subject.updateSettings({
      browseFavorites: [
        { ref: 'output/monday', kind: 'folder', addedAt: 2 },
        { ref: 'input/face.png', kind: 'file', addedAt: 1 },
      ],
    });

    const stored = subject.getSettings().browseFavorites;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.map((entry) => entry.ref)).toEqual(['output/monday', 'input/face.png']);
    expect(stored[1]?.kind).toBe('file');
  });

  it('replaces rather than merges, so the last one can be removed', () => {
    const subject = store();
    subject.updateSettings({
      browseFavorites: [
        { ref: 'output/a.png', kind: 'file', addedAt: 1 },
        { ref: 'output/b.png', kind: 'file', addedAt: 2 },
      ],
    });

    subject.updateSettings({
      browseFavorites: [{ ref: 'output/b.png', kind: 'file', addedAt: 2 }],
    });
    expect(subject.getSettings().browseFavorites.map((entry) => entry.ref)).toEqual([
      'output/b.png',
    ]);

    subject.updateSettings({ browseFavorites: [] });
    expect(subject.getSettings().browseFavorites).toEqual([]);
  });

  it('survives a restore from the mirror when the database has none', () => {
    const subject = store();
    const favorites = [{ ref: 'output/keep', kind: 'folder' as const, addedAt: 7 }];

    subject.importUiState({ settings: { browseFavorites: favorites } } as never, () => 'id');
    expect(subject.getSettings().browseFavorites).toEqual(favorites);

    // Additive, as everywhere else: what is already stored wins.
    subject.importUiState(
      {
        settings: { browseFavorites: [{ ref: 'output/other', kind: 'folder', addedAt: 8 }] },
      } as never,
      () => 'id',
    );
    expect(subject.getSettings().browseFavorites).toEqual(favorites);
  });
});
