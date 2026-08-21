import { randomBytes } from 'node:crypto';

import type {
  TasteCategory,
  TasteEntry,
  TasteProfile,
  WanderCategoryRule,
  WanderDraw,
} from '@latent/shared';

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

  /**
   * The words behind a list of note ids, in the order asked for.
   *
   * What a wandering picture records is ids, because a chat message is stored
   * in the clear and the notes are encrypted on purpose — see the note on
   * `BuildPromptCall.wanderNoteIds`. This is the other half of that: the words
   * are put back on the way out, and only while the vault is open.
   *
   * A note that has since been deleted is simply missing rather than a gap
   * marked "gone": what the list is for is reading, and a picture whose notes
   * are half deleted is still worth telling what it was made of.
   */
  textFor(ids: readonly string[]): string[] {
    if (!this.vault.isUnlocked) return [];
    const out: string[] = [];
    for (const id of ids) {
      const row = this.store.getTasteEntryRow(id);
      if (!row) continue;
      const text = this.open(row.text).trim();
      if (text !== '') out.push(text);
    }
    return out;
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

  /** The order they are listed in, which is the order they are read in. */
  reorderCategories(ids: string[]): void {
    this.store.reorderTasteCategories(ids);
  }

  addEntry(
    id: string,
    input: { categoryId: string | null; text: string; always?: boolean },
  ): TasteEntry {
    // A note filed under a heading that is gone belongs to no heading, rather
    // than to a dangling id the screen would have to explain.
    const categoryId =
      input.categoryId && this.store.getTasteCategoryRow(input.categoryId)
        ? input.categoryId
        : null;
    return this.toEntry(
      this.store.insertTasteEntry(id, {
        categoryId,
        text: this.seal(input.text.trim()),
        always: input.always,
      }),
    );
  }

  updateEntry(
    id: string,
    input: { categoryId?: string | null; text?: string; active?: boolean; always?: boolean },
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
      ...(input.always !== undefined ? { always: input.always } : {}),
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
      always: row.always_on === 1,
      position: row.position,
      createdAt: row.created_at,
    };
  }
}

/**
 * A short-lived pass for reading the notes, bought with the app password.
 *
 * Signing in is not enough for this one screen. Everything else in the app is
 * pictures and settings, which a phone left on a table shows to whoever picks
 * it up and which is a risk people accept; this is a written description of
 * what somebody likes, and the whole reason it is encrypted at rest is that
 * nobody would think to look at it. Asking again at the door is the same
 * argument applied to the screen rather than to the disk.
 *
 * A ticket rather than a flag on the session: sessions here are stateless — an
 * HMAC of the password hash, with no server-side table to hang anything on —
 * and a client-side "did they type it" would be a lock a `curl` walks past.
 * Held in memory only, so a restart or a sign-out ends every one of them.
 */
export class TasteGate {
  private readonly tickets = new Map<string, number>();

  constructor(
    /** How long a pass lasts. Long enough to write a list, short enough to forget. */
    private readonly lifetimeMs = 15 * 60 * 1000,
  ) {}

  /** Mint one. The caller has just proved it knows the password. */
  issue(now = Date.now()): string {
    this.sweep(now);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, now + this.lifetimeMs);
    return ticket;
  }

  /**
   * Whether this pass is still good — and if so, extend it.
   *
   * Sliding rather than fixed: the expiry is there so a pass does not outlive
   * the sitting it was bought for, and being asked for the password again in
   * the middle of writing a list is the kind of security that gets switched
   * off.
   */
  check(ticket: unknown, now = Date.now()): boolean {
    if (typeof ticket !== 'string' || ticket === '') return false;
    const expires = this.tickets.get(ticket);
    if (expires === undefined) return false;
    if (expires <= now) {
      this.tickets.delete(ticket);
      return false;
    }
    this.tickets.set(ticket, now + this.lifetimeMs);
    return true;
  }

  /** Hand one back, when the screen it was for is closed. */
  revoke(ticket: unknown): void {
    if (typeof ticket === 'string') this.tickets.delete(ticket);
  }

  /** Every pass at once: signing out, or locking the vault, ends all of them. */
  revokeAll(): void {
    this.tickets.clear();
  }

  private sweep(now: number): void {
    for (const [ticket, expires] of this.tickets) {
      if (expires <= now) this.tickets.delete(ticket);
    }
  }
}

/** What a profile actually contributes, once the switches have had their say. */
export interface ActiveTaste {
  /** The ordinary notes, grouped under their headings; `null` is no heading. */
  groups: { heading: string | null; notes: string[] }[];
  /**
   * The ones that apply whatever the influence setting says.
   *
   * Listed apart rather than mixed in because they are told to the model
   * differently: the rest fill the space you left, and these hold even when you
   * have said exactly what you want — where they bear on it at all.
   */
  standing: string[];
}

/**
 * The notes that are actually feeding in, grouped under their headings.
 *
 * A note under a switched-off category is off whatever its own switch says: the
 * category switch is the coarse control, and having to also switch off six
 * notes to silence a heading would make it useless. Empty categories are
 * dropped, and notes belonging to no category come back under `null`.
 *
 * The switches decide *whether* a note is in play; `always` decides how far it
 * reaches. So a standing note under a switched-off heading is still off — you
 * silenced it — and it simply does not appear at all.
 */
export function activeTaste(profile: TasteProfile): ActiveTaste {
  const categories = new Map(profile.categories.map((category) => [category.id, category]));
  const groups: { heading: string | null; notes: string[] }[] = [];
  const byCategory = new Map<string | null, string[]>();
  const standing: string[] = [];

  for (const entry of profile.entries) {
    if (!entry.active) continue;
    const category = entry.categoryId ? categories.get(entry.categoryId) : undefined;
    if (entry.categoryId && (!category || !category.active)) continue;
    const text = entry.text.trim();
    if (!text) continue;

    /*
     * A standing note is listed once, in its own section, and not again under
     * its heading. Saying it twice in one prompt is how a model decides it is
     * the most important thing in the list.
     */
    if (entry.always) {
      standing.push(text);
      continue;
    }

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

  return { groups, standing };
}

/** One note that came out of the draw: the words, and what to call it later. */
export interface DrawnNote {
  id: string;
  text: string;
  /** The heading it came from, or `null` for a note filed under none. */
  categoryId: string | null;
}

/** What a draw is allowed to do, beyond how many notes it wants. */
export interface DrawOptions {
  rules: WanderDraw;
  /**
   * Notes to leave out this time, by id — the last few rounds' worth.
   *
   * Advisory, not a rule. Honouring it to the point of drawing nothing would
   * turn "don't repeat yourself" into "stop", which is not what it means, so a
   * round that cannot fill itself without them takes them back.
   */
  exclude?: readonly string[];
  /** Injectable so a test can pin the draw down. */
  random?: () => number;
}

/** Fisher–Yates on a copy. The profile is not ours to reorder. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    const held = out[index] as T;
    out[index] = out[pick] as T;
    out[pick] = held;
  }
  return out;
}

/**
 * A handful of notes, drawn for one wandering picture, under your rules.
 *
 * At most `count` of them, and often fewer — see `WanderRun.attributes` for why
 * that is deliberate. The order is:
 *
 * 1. Every heading marked `always` gets one note, in a random order of
 *    headings, so a short round still spreads across them rather than always
 *    satisfying the same one first.
 * 2. Every pinned note goes in, if pinning is set to `always`.
 * 3. The rest of the round is filled at random from everything still eligible.
 *
 * Caps are checked at every step, including against the guaranteed notes: a
 * heading capped at one that is also `always` contributes exactly one, and the
 * fill cannot add a second.
 *
 * What is *not* here is any notion of a note being more important than another
 * within a heading. Headings are the unit you curate; notes are the things you
 * wrote down, and ranking them would be a second list to maintain for a mode
 * whose whole point is not deciding anything.
 */
export function drawTaste(
  profile: TasteProfile,
  count: number,
  options: DrawOptions,
): DrawnNote[] {
  const random = options.random ?? Math.random;
  const rules = options.rules;
  const wanted = Math.max(0, Math.floor(count) || 0);
  if (wanted === 0) return [];

  const categories = new Map(profile.categories.map((category) => [category.id, category]));
  const ruleFor = (categoryId: string | null): WanderCategoryRule =>
    (categoryId ? rules.categories[categoryId] : undefined) ?? { role: 'draw', max: 0 };

  /*
   * Everything the switches leave in play, before the wandering rules have had
   * their say. `activeTaste` is the authority on that — a note under a
   * switched-off heading is off whatever its own switch says — and this mode
   * has no business disagreeing with it.
   */
  const eligible: DrawnNote[] = [];
  const guaranteedPins: DrawnNote[] = [];
  for (const entry of profile.entries) {
    if (!entry.active) continue;
    const category = entry.categoryId ? categories.get(entry.categoryId) : undefined;
    if (entry.categoryId && (!category || !category.active)) continue;
    const text = entry.text.trim();
    if (text === '') continue;

    const note: DrawnNote = { id: entry.id, text, categoryId: category?.id ?? null };

    if (entry.always) {
      if (rules.pinned === 'off') continue;
      if (rules.pinned === 'always') {
        guaranteedPins.push(note);
        continue;
      }
      // `draw`: in the pool like anything else, and subject to its heading's
      // cap like anything else.
    }

    if (note.categoryId === null && rules.loose === 'off') continue;
    if (ruleFor(note.categoryId).role === 'off') continue;
    eligible.push(note);
  }

  const cap = (categoryId: string | null): number => {
    const rule = ruleFor(categoryId);
    const own = Math.max(0, Math.floor(rule.max) || 0);
    return own > 0 ? own : Math.max(0, Math.floor(rules.perCategory) || 0);
  };

  const taken: DrawnNote[] = [];
  const takenIds = new Set<string>();
  const perHeading = new Map<string | null, number>();

  const room = (note: DrawnNote): boolean => {
    if (takenIds.has(note.id)) return false;
    const limit = cap(note.categoryId);
    if (limit === 0) return true;
    return (perHeading.get(note.categoryId) ?? 0) < limit;
  };

  const take = (note: DrawnNote): void => {
    taken.push(note);
    takenIds.add(note.id);
    perHeading.set(note.categoryId, (perHeading.get(note.categoryId) ?? 0) + 1);
  };

  /*
   * The pins first, when they are the kind that always apply.
   *
   * Before the `always` headings rather than after: they are the notes you said
   * hold whatever else is going on, and a round that ran out of room before
   * reaching them would be ignoring the stronger of the two instructions.
   */
  for (const note of guaranteedPins) {
    if (taken.length >= wanted) break;
    take(note);
  }

  // One from each heading that insists on one, headings in a random order.
  const insisting = shuffled(
    profile.categories.filter(
      (category) => category.active && ruleFor(category.id).role === 'always',
    ),
    random,
  );
  for (const category of insisting) {
    if (taken.length >= wanted) break;
    const candidates = shuffled(
      eligible.filter((note) => note.categoryId === category.id && room(note)),
      random,
    );
    const fresh = candidates.find((note) => !options.exclude?.includes(note.id)) ?? candidates[0];
    if (fresh) take(fresh);
  }

  /*
   * And the rest at random, recently-used notes held back until they are the
   * only thing left. Two passes rather than one shuffled list with the stale
   * ones sorted to the end: "prefer fresh" is a preference between two pools,
   * and each pool still has to be in a random order of its own.
   */
  for (const pass of [0, 1]) {
    const pool = shuffled(
      eligible.filter((note) => (options.exclude?.includes(note.id) ?? false) === (pass === 1)),
      random,
    );
    for (const note of pool) {
      if (taken.length >= wanted) return taken;
      if (room(note)) take(note);
    }
  }

  return taken;
}
