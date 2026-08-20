import { useState } from 'react';

import type { TasteCategory, TasteEntry } from '@latent/shared';

import {
  useCreateTasteCategory,
  useCreateTasteEntry,
  useDeleteTasteCategory,
  useDeleteTasteEntry,
  useReorderTasteCategories,
  useTaste,
  useUpdateTasteCategory,
  useUpdateTasteEntry,
} from '../api/queries';
import { Toggle } from './ParamControl';
import { Button, Card, ErrorNote, Sheet, Spinner, cn } from './ui';

/**
 * What you like, written down.
 *
 * The point is having somewhere to start. Deciding what to make is the hard
 * part of making pictures, and "give me an idea" is a question no model can
 * answer well without knowing anything about who is asking. These notes are the
 * answer to that: concepts, aesthetics, places, films — whatever you keep
 * coming back to.
 *
 * Two levels only, and the second one optional. Categories are there because a
 * long flat list stops being readable, not because filing is required: a note
 * that belongs under no heading is still a note, and it lands under "Anything
 * else". Each note and each category has its own switch, so changing your mind
 * for an evening is a tap rather than a deletion.
 *
 * A note can also be pinned, which is a different thing from being switched on:
 * the switch says whether it is in play at all, and the pin says it applies even
 * when a picture has already been named. Settled preferences — a format, a thing
 * you never want in a picture — are the notes that matter most in exactly the
 * case the influence scale would otherwise silence them.
 *
 * Everything here is encrypted with the app password and only ever read by the
 * model — see `server/src/taste.ts`.
 */
export function TasteSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Not fetched until it is opened: it is a sheet behind a button, and the
  // request needs the vault open, which is a worse thing to fail in the
  // background than on a screen that can say so.
  const taste = useTaste(open);
  const addCategory = useCreateTasteCategory();
  const addEntry = useCreateTasteEntry();
  const reorder = useReorderTasteCategories();

  const [newCategory, setNewCategory] = useState('');
  const [draft, setDraft] = useState('');

  const profile = taste.data;
  const loose = profile?.entries.filter((entry) => !entry.categoryId) ?? [];

  const submitNote = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await addEntry.mutateAsync({ text, categoryId: null });
  };

  return (
    <Sheet open={open} onClose={onClose} title="What you like" full>
      <div className="space-y-3">
        {/*
          One line, not three paragraphs.

          Everything this sheet explains was explained on it: two paragraphs of
          preamble and a two-row writing box meant the headings — the thing the
          page is a list of — started below the fold. The explanation lives in
          the README and in Settings; here it is one line, and the rest is the
          list.
        */}
        <p className="text-[11px] text-muted">
          Notes the model reads when you have not said what you want. Encrypted with your
          password, never shown back to you. How far they reach is set under{' '}
          <strong className="text-body">Settings → Chat</strong>.
        </p>

        {taste.isLoading && (
          <div className="grid place-items-center py-8">
            <Spinner className="size-5 text-muted" />
          </div>
        )}

        {taste.isError && (
          <ErrorNote>
            These notes are locked. Sign in again to read them — they are encrypted with your
            password.
          </ErrorNote>
        )}

        {profile && (
          <>
            {/*
              Writing one comes first, above everything, and on one line.

              The thing people actually do here is remember something and want
              it written down before the thought goes. Making that wait until
              after a category has been picked is how a list like this ends up
              empty — and a note is a phrase, not an essay, so it does not need
              a paragraph box to hold it.
            */}
            <div className="flex gap-2">
              <input
                id="taste-note"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitNote();
                }}
                aria-label="Something you like"
                placeholder="Rain on a window at night"
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <Button
                variant="secondary"
                aria-label="Remember it"
                disabled={draft.trim() === '' || addEntry.isPending}
                onClick={() => void submitNote()}
              >
                Add
              </Button>
            </div>

            {profile.categories.map((category, index) => (
              <CategoryCard
                key={category.id}
                category={category}
                entries={profile.entries.filter((entry) => entry.categoryId === category.id)}
                first={index === 0}
                last={index === profile.categories.length - 1}
                onMove={(direction) => {
                  /*
                    The whole order, not a swap.

                    Positions are the server's to assign, and sending "these
                    two changed places" would leave the rest of the list
                    holding numbers that only made sense before the move.
                  */
                  const ids = profile.categories.map((entry) => entry.id);
                  const to = index + direction;
                  if (to < 0 || to >= ids.length) return;
                  const held = ids[index] as string;
                  ids[index] = ids[to] as string;
                  ids[to] = held;
                  reorder.mutate(ids);
                }}
              />
            ))}

            {loose.length > 0 && (
              <Card className="space-y-2">
                <p className="text-sm font-medium">Anything else</p>
                <p className="text-[11px] text-muted">Notes that belong under no heading.</p>
                <ul className="space-y-1">
                  {loose.map((entry) => (
                    <EntryRow key={entry.id} entry={entry} categories={profile.categories} />
                  ))}
                </ul>
              </Card>
            )}

            <div className="flex gap-2 border-t border-line pt-3">
              <input
                id="taste-category"
                value={newCategory}
                onChange={(event) => setNewCategory(event.target.value)}
                aria-label="New category"
                placeholder="New heading — Colour, Places, Films"
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <Button
                variant="ghost"
                aria-label="Add category"
                disabled={newCategory.trim() === '' || addCategory.isPending}
                onClick={async () => {
                  const name = newCategory.trim();
                  if (!name) return;
                  setNewCategory('');
                  await addCategory.mutateAsync(name);
                }}
              >
                Add
              </Button>
            </div>

            {profile.categories.length === 0 && profile.entries.length === 0 && (
              <p className="py-2 text-center text-sm text-muted">
                Nothing written down yet. Anything at all helps — it is only ever used to fill in
                what you have left open.
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * One heading, folded away until you want it.
 *
 * Collapsed by default, and that is the point: a page of open cards is three
 * headings on a phone screen, so a list long enough to be worth having is a
 * list you cannot see the shape of. Closed, each one is a row — its name, how
 * many notes are under it, and its switch — so a dozen fit at once and moving
 * one is a decision you can make while looking at the others.
 */
function CategoryCard({
  category,
  entries,
  first,
  last,
  onMove,
}: {
  category: TasteCategory;
  entries: TasteEntry[];
  first: boolean;
  last: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  const update = useUpdateTasteCategory();
  const remove = useDeleteTasteCategory();
  const addEntry = useCreateTasteEntry();
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const active = entries.filter((entry) => entry.active).length;

  return (
    <Card className={cn('space-y-2 p-2', !category.active && 'opacity-60')}>
      <div className="flex items-center gap-1">
        {renaming === null ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1.5 text-left active:bg-surface-2"
          >
            <span aria-hidden className={cn('text-[10px] text-muted', open && 'rotate-90')}>
              ▶
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{category.name}</span>
            <span className="shrink-0 text-[10px] text-muted">
              {active}/{entries.length}
            </span>
          </button>
        ) : (
          /*
            Renaming in place, because a heading is one word and a dialog for
            one word is a dialog nobody opens twice.
          */
          <input
            value={renaming}
            autoFocus
            aria-label={`Rename ${category.name}`}
            onChange={(event) => setRenaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setRenaming(null);
            }}
            onBlur={() => {
              const name = (renaming ?? '').trim();
              if (name && name !== category.name) {
                update.mutate({ id: category.id, patch: { name } });
              }
              setRenaming(null);
            }}
            className="min-w-0 flex-1 rounded-lg border border-accent bg-surface-2 px-2 py-1.5 text-sm outline-none"
          />
        )}

        <Toggle
          checked={category.active}
          label={`${category.name} feeds in`}
          onChange={(active) => update.mutate({ id: category.id, patch: { active } })}
        />
      </div>

      {open && (
        <div className="space-y-2 border-t border-line pt-2">
          {!category.active && (
            <p className="text-[11px] text-muted">
              Switched off — nothing under this heading feeds in, whatever its own switch says.
            </p>
          )}

          <ul className="space-y-1">
            {entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} categories={[]} />
            ))}
          </ul>

          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={`Add to ${category.name}`}
              placeholder="Add something"
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            {/*
              Named for its category, not just "Add".

              Every card on the sheet has one of these, and a row of buttons that
              all read "Add" is a row nothing using a screen reader can tell apart.
            */}
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Save to ${category.name}`}
              disabled={draft.trim() === '' || addEntry.isPending}
              onClick={async () => {
                const text = draft.trim();
                if (!text) return;
                setDraft('');
                await addEntry.mutateAsync({ text, categoryId: category.id });
              }}
            >
              Add
            </Button>
          </div>

          {/*
            Ordering, renaming and deleting, in the fold rather than on the row.

            The row is for reading the list; these are the three things you do
            to a heading occasionally, and putting them all on the closed row
            would make a list of six headings a wall of thirty buttons.
          */}
          <div className="flex items-center gap-1 pt-1">
            <button
              type="button"
              disabled={first}
              aria-label={`Move ${category.name} up`}
              onClick={() => onMove(-1)}
              className="grid size-8 place-items-center rounded-lg bg-surface-2 text-muted disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              disabled={last}
              aria-label={`Move ${category.name} down`}
              onClick={() => onMove(1)}
              className="grid size-8 place-items-center rounded-lg bg-surface-2 text-muted disabled:opacity-30"
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Rename ${category.name}`}
              onClick={() => setRenaming(category.name)}
              className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-muted"
            >
              Rename
            </button>
            <span className="flex-1" />
            {/* Two taps: a heading holds notes, and losing the heading loses
                which of them belonged together. */}
            <button
              type="button"
              aria-label={confirmDelete ? `Really delete ${category.name}` : `Delete ${category.name}`}
              onClick={() => (confirmDelete ? remove.mutate(category.id) : setConfirmDelete(true))}
              className={cn(
                'rounded-lg px-2.5 py-1.5 text-xs',
                confirmDelete ? 'bg-danger/20 text-danger' : 'bg-surface-2 text-muted',
              )}
            >
              {confirmDelete ? 'Sure?' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * One note: its own switch, its text, and a way to get rid of it.
 *
 * `categories` is non-empty only for the loose ones, where filing a note under
 * a heading afterwards is the move that turns a growing pile into a list.
 */
function EntryRow({ entry, categories }: { entry: TasteEntry; categories: TasteCategory[] }) {
  const update = useUpdateTasteEntry();
  const remove = useDeleteTasteEntry();
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <li className="flex items-start gap-2 rounded-lg py-1">
      <Toggle
        checked={entry.active}
        label={`${entry.text} feeds in`}
        onChange={(active) => update.mutate({ id: entry.id, patch: { active } })}
      />
      <div className="min-w-0 flex-1">
        {/*
          Tap the words to change them.

          A note is a sentence you wrote in a hurry, and "nearly right" is its
          normal state — retyping it as a new note and deleting the old one is
          the workaround this removes. Saved when the field loses focus, like
          every other text on this sheet.
        */}
        {editing === null ? (
          <button
            type="button"
            onClick={() => setEditing(entry.text)}
            aria-label={`Edit ${entry.text}`}
            className={cn(
              'block w-full text-left text-sm break-words',
              !entry.active && 'text-muted line-through',
            )}
          >
            {entry.text}
          </button>
        ) : (
          <textarea
            value={editing}
            autoFocus
            rows={2}
            aria-label={`Edit ${entry.text}`}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(null);
            }}
            onBlur={() => {
              const text = (editing ?? '').trim();
              if (text && text !== entry.text) update.mutate({ id: entry.id, patch: { text } });
              setEditing(null);
            }}
            className="w-full resize-none rounded-lg border border-accent bg-surface-2 px-2 py-1 text-sm outline-none"
          />
        )}
        {/*
          The one control that changes what a note *is*.

          Everything else here fills the space you left, so naming a picture
          pushes it aside. A pinned note does not get pushed aside — which is
          the whole point, because a settled preference matters most exactly
          when you have said what you want. It still only applies where it
          bears on the picture; the model is told so in as many words.
        */}
        <button
          type="button"
          aria-pressed={entry.always}
          aria-label={`${entry.text} always applies`}
          onClick={() => update.mutate({ id: entry.id, patch: { always: !entry.always } })}
          className={cn(
            'mt-1 rounded-md px-2 py-0.5 text-[10px]',
            entry.always ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-muted',
          )}
        >
          {entry.always ? '📌 Always' : 'Only when it fits'}
        </button>
        {categories.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() =>
                  update.mutate({ id: entry.id, patch: { categoryId: category.id } })
                }
                className="rounded-md bg-surface-2 px-2 py-0.5 text-[10px] text-muted"
              >
                → {category.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={`Delete ${entry.text}`}
        onClick={() => remove.mutate(entry.id)}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-muted active:bg-surface-2"
      >
        ✕
      </button>
    </li>
  );
}
