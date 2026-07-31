import { useMemo, useState } from 'react';

import type { PromptBlock } from '@latent/shared';

import {
  useCreatePromptBlock,
  useDeletePromptBlock,
  usePromptBlocks,
  useReorderPromptBlocks,
  useUpdatePromptBlock,
} from '../api/queries';
import { SortableList } from '../components/SortableList';
import { Button, cn, ErrorNote, Sheet, Spinner } from '../components/ui';

const UNGROUPED = 'Ungrouped';

/**
 * The prompt library: where blocks are made, named, grouped and put in order.
 *
 * A tab of its own because this is a thing you build up over time, separately
 * from any one render — the sheet it used to live in was reachable only while
 * writing a prompt, which is the worst moment to stop and do some filing. Using
 * blocks stays where it was: chips under the prompt field, and the pool in the
 * Random tab.
 *
 * Order is the point of the drag handles. Blocks come out in list order, so the
 * sequence here is the sequence a built prompt reads in, and the ones you reach
 * for most belong at the top of their group.
 */
export function BlocksScreen() {
  const blocks = usePromptBlocks();
  const reorder = useReorderPromptBlocks();
  const [editing, setEditing] = useState<PromptBlock | 'new' | null>(null);

  const library = blocks.data ?? [];

  const grouped = useMemo(() => {
    const map = new Map<string, PromptBlock[]>();
    for (const block of library) {
      const key = block.category || UNGROUPED;
      map.set(key, [...(map.get(key) ?? []), block]);
    }
    return [...map.entries()].sort(([a], [b]) =>
      // Ungrouped last: it is the leftovers drawer, not a category.
      a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b),
    );
  }, [library]);

  const categories = useMemo(
    () => [...new Set(library.map((block) => block.category).filter(Boolean))].sort(),
    [library],
  );

  /*
   * A drag reorders one group, but positions are global — so the ids of every
   * other group have to travel with it, or the groups would interleave.
   */
  const reorderGroup = (ids: string[]) => {
    const inGroup = new Set(ids);
    const merged: string[] = [];
    let injected = false;
    for (const block of library) {
      if (!inGroup.has(block.id)) {
        merged.push(block.id);
        continue;
      }
      // The group keeps the slice of the list it already occupied.
      if (!injected) {
        merged.push(...ids);
        injected = true;
      }
    }
    reorder.mutate(merged);
  };

  if (blocks.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-6 text-muted" />
      </div>
    );
  }

  return (
    <div className="safe-t px-4 pt-3 pb-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Blocks</h1>
        <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
          New block
        </Button>
      </div>

      {library.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing saved yet. A block is a phrase you keep retyping — a lighting setup, a camera, a
          style. Save a few and a prompt becomes a handful of taps.
        </p>
      ) : (
        <div className="space-y-5">
          {grouped.map(([category, items]) => (
            <section key={category} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="min-w-0 truncate text-xs font-medium tracking-wide text-muted uppercase">
                  {category}
                </h2>
                <span className="shrink-0 text-[11px] text-muted">{items.length}</span>
              </div>

              <SortableList
                items={items}
                idOf={(block) => block.id}
                onReorder={reorderGroup}
                className="space-y-1.5"
              >
                {(block, handle, dragging) => (
                  <div
                    className={cn(
                      'flex items-center gap-2 rounded-xl border bg-surface px-2 py-2',
                      dragging ? 'border-accent shadow-lg' : 'border-line',
                    )}
                  >
                    <span
                      {...handle}
                      role="button"
                      aria-label={`Reorder ${block.name}`}
                      className="grid size-8 shrink-0 cursor-grab place-items-center rounded-lg bg-surface-2 text-muted"
                    >
                      ⠿
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditing(block)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm">{block.name}</p>
                      <p className="truncate text-[11px] text-muted">{block.text}</p>
                    </button>
                  </div>
                )}
              </SortableList>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <BlockSheet
          block={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Create or edit one block, including which group it belongs to. */
function BlockSheet({
  block,
  categories,
  onClose,
}: {
  block: PromptBlock | null;
  categories: string[];
  onClose: () => void;
}) {
  const create = useCreatePromptBlock();
  const update = useUpdatePromptBlock();
  const remove = useDeletePromptBlock();

  const [name, setName] = useState(block?.name ?? '');
  const [category, setCategory] = useState(block?.category ?? '');
  const [text, setText] = useState(block?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const save = async () => {
    setError(null);
    const input = { name: name.trim(), text: text.trim(), category: category.trim() };
    try {
      if (block) await update.mutateAsync({ id: block.id, input });
      else await create.mutateAsync(input);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that block');
    }
  };

  return (
    <Sheet open onClose={onClose} title={block ? 'Edit block' : 'New block'}>
      <div className="space-y-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Golden hour"
            aria-label="Block name"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
        </Field>

        <Field label="Group">
          <input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Lighting"
            aria-label="Block group"
            list="latent-block-categories"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
          {/* Existing groups offered rather than typed again — a typo makes a
              second group that looks identical and behaves separately. */}
          <datalist id="latent-block-categories">
            {categories.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1.5">
              {categories.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setCategory(item)}
                  aria-pressed={category === item}
                  className={cn(
                    'rounded-full border px-2 py-1 text-[11px]',
                    category === item
                      ? 'border-accent bg-accent/20 text-accent'
                      : 'border-line text-muted',
                  )}
                >
                  {item}
                </button>
              ))}
            </div>
          )}
        </Field>

        <Field label="Text">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            placeholder="warm rim light, long shadows, low sun"
            aria-label="Block text"
            className="w-full resize-none rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
        </Field>

        <ErrorNote>{error}</ErrorNote>

        <div className="flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            busy={create.isPending || update.isPending}
            disabled={name.trim() === '' || text.trim() === ''}
            onClick={save}
          >
            Save
          </Button>
          {block && (
            <Button
              variant={confirming ? 'danger' : 'ghost'}
              onClick={() => {
                if (!confirming) return setConfirming(true);
                remove.mutate(block.id, { onSuccess: onClose });
              }}
            >
              {confirming ? 'Really delete' : 'Delete'}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      {children}
    </div>
  );
}
