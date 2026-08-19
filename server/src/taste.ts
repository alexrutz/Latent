import type { TasteCategory, TasteEntry, TasteProfile } from '@latent/shared';

import type { Store, TasteCategoryRow, TasteEntryRow } from './db.js';
import { Vault, VaultLockedError } from './vault.js';

/**
 * What the user likes, kept under the same lock as the pictures.
 *
 * The point of the feature is to have somewhere to start from when you do not
 * know what to make: concepts, aesthetics, places, films — whatever you keep
 * coming back to. That list is a fairly complete description of a person, and
 * unlike a prompt it is never on screen, so nobody would notice it sitting
 * readable in a database file or a backup. It is encrypted with the app
 * password for exactly that reason.
 *
 * The model still reads it, because a note nobody can use is a note not worth
 * writing. "Encrypted" here means at rest: while somebody is signed in, the
 * server can read the notes and put the active ones in front of the model, and
 * the moment it locks, they are bytes again.
 *
 * Ordering, switching a note on or off, and which category a note is under stay
 * in the clear — see the v12 migration. That is what lets the screen still show
 * the shape of the list, and what keeps a locked server from losing track of it.
 */
export class Taste {
  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
  ) {}

  private seal(text: string): string {
    if (!this.vault.isUnlocked) throw new VaultLockedError();
    return this.vault.encrypt(Buffer.from(text, 'utf8')).toString('base64');
  }

  /**
   * Read one back.
   *
   * A row that cannot be decrypted is not an error worth failing the whole
   * screen over — a database restored beside a different vault would otherwise
   * be unopenable rather than merely unreadable — so it comes back empty and
   * the rest of the list still works.
   */
  private open(payload: string): string {
    const bytes = Buffer.from(payload, 'base64');
    if (!Vault.isEncrypted(bytes)) return '';
    try {
      return this.vault.decrypt(bytes).toString('utf8');
    } catch {
      return '';
    }
  }

  /** True when the notes can be read right now. */
  get isUnlocked(): boolean {
    return this.vault.isUnlocked;
  }

  /** Everything, in order, decrypted. Throws `VaultLockedError` when locked. */
  profile(): TasteProfile {
    if (!this.vault.isUnlocked) throw new VaultLockedError();
    return {
      categories: this.store.listTasteCategoryRows().map((row) => this.toCategory(row)),
      entries: this.store.listTasteEntryRows().map((row) => this.toEntry(row)),
    };
  }

  /**
   * The profile, or nothing when it cannot be read.
   *
   * For the places that would rather go without than fail: a chat turn should
   * still work on a server whose vault happens to be locked, just without the
   * part of the prompt that says what the user likes.
   */
  profileOrNull(): TasteProfile | null {
    try {
      return this.profile();
    } catch {
      return null;
    }
  }

  addCategory(id: string, name: string): TasteCategory {
    return this.toCategory(this.store.insertTasteCategory(id, this.seal(name.trim())));
  }

  updateCategory(id: string, input: { name?: string; active?: boolean }): TasteCategory | null {
    if (!this.store.getTasteCategoryRow(id)) return null;
    this.store.updateTasteCategory(id, {
      ...(input.name !== undefined ? { name: this.seal(input.name.trim()) } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    });
    const row = this.store.getTasteCategoryRow(id);
    return row ? this.toCategory(row) : null;
  }

  deleteCategory(id: string): void {
    this.store.deleteTasteCategory(id);
  }

  addEntry(id: string, input: { categoryId: string | null; text: string }): TasteEntry {
    // A note filed under a heading that is gone belongs to no heading, rather
    // than to a dangling id the screen would have to explain.
    const categoryId =
      input.categoryId && this.store.getTasteCategoryRow(input.categoryId)
        ? input.categoryId
        : null;
    return this.toEntry(
      this.store.insertTasteEntry(id, { categoryId, text: this.seal(input.text.trim()) }),
    );
  }

  updateEntry(
    id: string,
    input: { categoryId?: string | null; text?: string; active?: boolean },
  ): TasteEntry | null {
    if (!this.store.getTasteEntryRow(id)) return null;
    this.store.updateTasteEntry(id, {
      ...(input.categoryId !== undefined
        ? {
            categoryId:
              input.categoryId && this.store.getTasteCategoryRow(input.categoryId)
                ? input.categoryId
                : null,
          }
        : {}),
      ...(input.text !== undefined ? { text: this.seal(input.text.trim()) } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    });
    const row = this.store.getTasteEntryRow(id);
    return row ? this.toEntry(row) : null;
  }

  deleteEntry(id: string): void {
    this.store.deleteTasteEntry(id);
  }

  private toCategory(row: TasteCategoryRow): TasteCategory {
    return {
      id: row.id,
      name: this.open(row.name),
      active: row.active === 1,
      position: row.position,
      createdAt: row.created_at,
    };
  }

  private toEntry(row: TasteEntryRow): TasteEntry {
    return {
      id: row.id,
      categoryId: row.category_id,
      text: this.open(row.text),
      active: row.active === 1,
      position: row.position,
      createdAt: row.created_at,
    };
  }
}

/**
 * The notes that are actually feeding in, grouped under their headings.
 *
 * A note under a switched-off category is off whatever its own switch says: the
 * category switch is the coarse control, and having to also switch off six
 * notes to silence a heading would make it useless. Empty categories are
 * dropped, and notes belonging to no category come back under `null`.
 */
export function activeTaste(
  profile: TasteProfile,
): { heading: string | null; notes: string[] }[] {
  const categories = new Map(profile.categories.map((category) => [category.id, category]));
  const groups: { heading: string | null; notes: string[] }[] = [];
  const byCategory = new Map<string | null, string[]>();

  for (const entry of profile.entries) {
    if (!entry.active) continue;
    const category = entry.categoryId ? categories.get(entry.categoryId) : undefined;
    if (entry.categoryId && (!category || !category.active)) continue;
    const text = entry.text.trim();
    if (!text) continue;

    const key = category ? category.id : null;
    const notes = byCategory.get(key);
    if (notes) notes.push(text);
    else byCategory.set(key, [text]);
  }

  for (const category of profile.categories) {
    const notes = byCategory.get(category.id);
    if (notes?.length) groups.push({ heading: category.name.trim() || 'Notes', notes });
  }
  const loose = byCategory.get(null);
  if (loose?.length) groups.push({ heading: null, notes: loose });

  return groups;
}
