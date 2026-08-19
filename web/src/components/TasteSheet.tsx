import { useState } from 'react';

import type { TasteCategory, TasteEntry } from '@latent/shared';

import {
  useCreateTasteCategory,
  useCreateTasteEntry,
  useDeleteTasteCategory,
  useDeleteTasteEntry,
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
        <p className="text-[11px] text-muted">
          Notes the model reads when you have not said what you want — a starting point instead of a
          blank page. Encrypted with your password, and never shown back to you in the chat. How far
          it reaches is set under <strong className="text-body">Settings → Chat</strong>.
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
              Writing a note comes first, above everything.

              The thing people actually do here is remember something and want
              it written down before the thought goes. Making that wait until
              after a category has been picked is how a list like this ends up
              empty.
            */}
            <Card className="space-y-2">
              <label className="block text-sm" htmlFor="taste-note">
                Something you like
              </label>
              <textarea
                id="taste-note"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={2}
                placeholder="Rain on a window at night, lit from inside"
                className="w-full resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <Button
                variant="secondary"
                className="w-full"
                disabled={draft.trim() === '' || addEntry.isPending}
                onClick={() => void submitNote()}
              >
                Remember it
              </Button>
            </Card>

            {profile.categories.map((category) => (
              <CategoryCard
                key={category.id}
                category={category}
                entries={profile.entries.filter((entry) => entry.categoryId === category.id)}
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

            <Card className="space-y-2">
              <label className="block text-sm" htmlFor="taste-category">
                New category
              </label>
              <p className="text-[11px] text-muted">
                A heading to group notes under — “Colour”, “Places”, “Films”. Switching one off
                silences everything under it.
              </p>
              <div className="flex gap-2">
                <input
                  id="taste-category"
                  value={newCategory}
                  onChange={(event) => setNewCategory(event.target.value)}
                  placeholder="Colour"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <Button
                  variant="secondary"
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
            </Card>

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

function CategoryCard({
  category,
  entries,
}: {
  category: TasteCategory;
  entries: TasteEntry[];
}) {
  const update = useUpdateTasteCategory();
  const remove = useDeleteTasteCategory();
  const addEntry = useCreateTasteEntry();
  const [draft, setDraft] = useState('');

  return (
    <Card className={cn('space-y-2', !category.active && 'opacity-60')}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{category.name}</p>
        <Toggle
          checked={category.active}
          label={`${category.name} feeds in`}
          onChange={(active) => update.mutate({ id: category.id, patch: { active } })}
        />
        <button
          type="button"
          aria-label={`Delete ${category.name}`}
          onClick={() => remove.mutate(category.id)}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-muted active:bg-surface-2"
        >
          ✕
        </button>
      </div>

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

  return (
    <li className="flex items-start gap-2 rounded-lg py-1">
      <Toggle
        checked={entry.active}
        label={`${entry.text} feeds in`}
        onChange={(active) => update.mutate({ id: entry.id, patch: { active } })}
      />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm break-words', !entry.active && 'text-muted line-through')}>
          {entry.text}
        </p>
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
