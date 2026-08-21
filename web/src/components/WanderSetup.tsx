import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { DEFAULT_WANDER_DRAW } from '@latent/shared';
import type { TasteProfile, WanderCategoryRule, WanderDraw } from '@latent/shared';

import { api, setTasteTicket } from '../api/client';
import { queryKeys, useTaste } from '../api/queries';
import { Button, cn, ErrorNote, Sheet, Spinner } from './ui';

/**
 * What a wandering round is allowed to draw from.
 *
 * The mode began as a flat shuffle of every note switched on, and that is not
 * good enough for a list anyone has actually curated. Notes are not
 * interchangeable: a heading called "Format" holds things that belong in every
 * picture, one called "Films" holds a dozen near-synonyms of which you want
 * exactly one, and one called "Ideas for later" is not something you want
 * turning up tonight at all. Only the person who wrote them knows which is
 * which, so this is where they say.
 *
 * Two halves, split by what they give away. The general rules — how many from
 * one heading, what to do with pins, how long before a note may come round
 * again — describe the *draw* and are open. Choosing headings means reading
 * their names, which is reading the profile, and that is behind the password
 * like everything else about it.
 */
export function WanderSetup({
  open,
  onClose,
  draw,
  onChange,
  attributes,
}: {
  open: boolean;
  onClose: () => void;
  draw: WanderDraw;
  onChange: (draw: WanderDraw) => void;
  /** How many notes a round asks for, so the sheet can say what it will get. */
  attributes: number;
}) {
  const [unlocked, setUnlocked] = useState(false);
  const taste = useTaste(open && unlocked);
  const queryClient = useQueryClient();

  /*
   * Closing it hands the pass back, both ends: the server forgets the ticket
   * and the decrypted profile leaves the cache. Reopening asks again rather
   * than showing the headings for a frame while it makes up its mind.
   */
  useEffect(() => {
    if (open || !unlocked) return;
    void api.lockTaste().catch(() => undefined);
    setTasteTicket(null);
    setUnlocked(false);
    queryClient.removeQueries({ queryKey: queryKeys.taste });
  }, [open, unlocked, queryClient]);

  const patch = (fields: Partial<WanderDraw>) => onChange({ ...draw, ...fields });
  const profile = taste.data ?? null;

  return (
    <Sheet open={open} onClose={onClose} title="What wandering draws from" full>
      <div className="space-y-4">
        <p className="text-[11px] leading-relaxed text-muted">
          Each round takes a few of your notes at random and makes one picture out of them. This
          is which notes it may take and how they are spread — the part that decides whether a
          round is one idea or four unrelated ones.
        </p>

        {/*
          The headings first, because they are what the sheet is for.

          Everything below is a dial on the draw; this is the part that knows
          what your notes actually are. A heading of near-synonyms and a heading
          of settled decisions want opposite treatment, and nothing but you can
          tell them apart — so it is the first thing asked and the rest is
          detail underneath.
        */}
        <div className="space-y-2">
          <div>
            <p className="text-sm">Headings</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              What each one does in a round. <strong className="text-body">Always</strong> is the
              one that matters most: a heading that decides what kind of picture this is at all
              gets a place in every round, however few notes are drawn.{' '}
              <strong className="text-body">Never</strong> leaves one out of wandering without
              switching it off for the chat, and{' '}
              <strong className="text-body">≤</strong> caps how much any one of them may
              contribute.
            </p>
          </div>

          {!unlocked ? (
            <Unlock onUnlocked={() => setUnlocked(true)} />
          ) : taste.isLoading ? (
            <div className="grid place-items-center py-6">
              <Spinner className="size-5 text-muted" />
            </div>
          ) : (
            <Headings
              profile={profile}
              draw={draw}
              onRule={(id, rule) => patch({ categories: { ...draw.categories, [id]: rule } })}
            />
          )}
        </div>

        <div className="space-y-4 border-t border-line pt-4">
          <Section
            title="At most from one heading"
            hint="The general limit, which any heading can override with its own ≤. One stops a round being four ways of saying the same thing because one heading won the shuffle four times."
          >
            <Choices
              label="At most from one heading"
              value={String(draw.perCategory)}
              options={[
                { value: '0', label: 'No limit' },
                { value: '1', label: '1' },
                { value: '2', label: '2' },
                { value: '3', label: '3' },
              ]}
              onChange={(value) => patch({ perCategory: Number(value) })}
            />
          </Section>

          <Section
            title="Notes under no heading"
            hint="They have no heading to switch off, so they get their own switch — for a profile where the loose notes are the unsorted inbox and the filed ones the considered list."
          >
            <Choices
              label="Notes under no heading"
              value={draw.loose}
              options={[
                { value: 'draw', label: 'In the draw' },
                { value: 'off', label: 'Leave out' },
              ]}
              onChange={(value) => patch({ loose: value as WanderDraw['loose'] })}
            />
          </Section>

          <Section
            title="Pinned notes"
            hint="A pin means “this holds even when I have asked for something specific”, and here nobody has asked for anything — so by default a pin buys nothing. Always in is the other reading: that a pinned note is part of everything you make."
          >
            <Choices
              label="Pinned notes"
              value={draw.pinned}
              options={[
                { value: 'draw', label: 'In the draw' },
                { value: 'always', label: 'Always in' },
                { value: 'off', label: 'Leave out' },
              ]}
              onChange={(value) => patch({ pinned: value as WanderDraw['pinned'] })}
            />
          </Section>

          <Section
            title="Before a note may come round again"
            hint="The fault of a long run is not repeated pictures, it is repeated notes: a short list shows you the same one twice within a minute. Dropped when it would leave nothing to draw."
          >
            <Choices
              label="Before a note may come round again"
              value={String(draw.avoidRepeats)}
              options={[
                { value: '0', label: 'Off' },
                { value: '1', label: '1 round' },
                { value: '2', label: '2' },
                { value: '3', label: '3' },
                { value: '5', label: '5' },
              ]}
              onChange={(value) => patch({ avoidRepeats: Number(value) })}
            />
          </Section>
        </div>

        {/*
          What it all adds up to, at the bottom where a summary belongs — and
          only once the headings can be read, since it is counting them.
        */}
        {unlocked && profile && (
          <div className="space-y-2 border-t border-line pt-4">
            <Reach profile={profile} draw={draw} attributes={attributes} />
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => onChange({ ...DEFAULT_WANDER_DRAW })}
            >
              Back to drawing from everything
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** One labelled rule, with its reasoning under it. */
function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm">{title}</p>
      {children}
      <p className="text-[11px] leading-relaxed text-muted">{hint}</p>
    </div>
  );
}

/** A row of exclusive choices, sized to the words rather than to the screen. */
function Choices({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={`${label}: ${option.label}`}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-lg px-2.5 py-1.5 text-xs',
            value === option.value ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const ROLES: { value: WanderCategoryRule['role']; label: string; hint: string }[] = [
  { value: 'off', label: 'Never', hint: 'Out of wandering, and still on for the chat' },
  { value: 'draw', label: 'Sometimes', hint: 'In the pool; may or may not come up' },
  { value: 'always', label: 'Always', hint: 'A place in every round' },
];

/** The caps a heading can set for itself, on top of the general one. */
const CAPS = [0, 1, 2, 3];

function Headings({
  profile,
  draw,
  onRule,
}: {
  profile: TasteProfile | null;
  draw: WanderDraw;
  onRule: (id: string, rule: WanderCategoryRule) => void;
}) {
  if (!profile || profile.categories.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-surface-2/40 px-3 py-3 text-xs text-muted">
        No headings yet. Everything you have written is one flat list, so a round simply draws
        from all of it — add headings under <strong className="text-body">♥</strong> in the chat
        and they turn up here.
      </p>
    );
  }

  const rule = (id: string): WanderCategoryRule =>
    draw.categories[id] ?? { role: 'draw', max: 0 };

  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {profile.categories.map((category) => {
          const current = rule(category.id);
          const notes = profile.entries.filter(
            (entry) => entry.categoryId === category.id && entry.active,
          ).length;

          return (
            <li
              key={category.id}
              className={cn(
                'rounded-xl border border-line bg-surface px-2.5 py-2',
                // A heading switched off for the notes themselves has no say
                // here; saying so is better than silently ignoring the setting.
                !category.active && 'opacity-50',
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {category.name.trim() || 'Untitled'}
                </span>
                <span className="shrink-0 text-[11px] text-muted tabular-nums">
                  {category.active ? `${notes} on` : 'switched off'}
                </span>
              </div>

              <div className="mt-1.5 flex items-center gap-1">
                <div
                  role="radiogroup"
                  aria-label={`${category.name} in wandering`}
                  className="flex min-w-0 flex-1 gap-1"
                >
                  {ROLES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={current.role === option.value}
                      aria-label={`${category.name}: ${option.label}`}
                      title={option.hint}
                      onClick={() => onRule(category.id, { ...current, role: option.value })}
                      className={cn(
                        'min-w-0 flex-1 truncate rounded-lg px-1.5 py-1 text-[11px]',
                        current.role === option.value
                          ? 'bg-accent text-white'
                          : 'bg-surface-2 text-muted',
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {/*
                  This heading's own cap, as one small control that cycles.

                  A picker per row would be three more taps and a sheet on top
                  of a sheet; the value is on the face of it, so a tap that
                  moves it one step is legible in a way a hidden menu is not.
                  Shown only where it can do something.
                */}
                {current.role !== 'off' && (
                  <button
                    type="button"
                    onClick={() =>
                      onRule(category.id, {
                        ...current,
                        max: CAPS[(CAPS.indexOf(current.max) + 1) % CAPS.length] ?? 0,
                      })
                    }
                    aria-label={
                      current.max === 0
                        ? `At most from ${category.name}: whatever the general limit says`
                        : `At most from ${category.name}: ${current.max}`
                    }
                    title="At most this many from this heading in one round"
                    className={cn(
                      'shrink-0 rounded-lg px-2 py-1 text-[11px] tabular-nums',
                      current.max === 0
                        ? 'bg-surface-2 text-muted'
                        : 'bg-accent/20 text-accent',
                    )}
                  >
                    {current.max === 0 ? '≤ —' : `≤ ${current.max}`}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * What the rules actually add up to, in one line.
 *
 * The caps are hard on purpose — a round would rather come up short than take
 * two from a heading you capped at one — which means a strict set of rules can
 * quietly stop a round ever reaching the number of notes you asked for. That is
 * the right behaviour and the wrong thing to discover from the pictures, so it
 * is said here while the rules are in front of you.
 */
function Reach({
  profile,
  draw,
  attributes,
}: {
  profile: TasteProfile;
  draw: WanderDraw;
  attributes: number;
}) {
  const active = new Map(profile.categories.map((entry) => [entry.id, entry]));
  const cap = (id: string | null) => {
    const rule = (id ? draw.categories[id] : undefined) ?? { role: 'draw' as const, max: 0 };
    if (rule.role === 'off') return 0;
    const own = rule.max || draw.perCategory;
    return own > 0 ? own : Number.POSITIVE_INFINITY;
  };

  const available = new Map<string | null, number>();
  for (const entry of profile.entries) {
    if (!entry.active) continue;
    const category = entry.categoryId ? active.get(entry.categoryId) : undefined;
    if (entry.categoryId && (!category || !category.active)) continue;
    if (entry.always && draw.pinned === 'off') continue;
    const key = category?.id ?? null;
    if (key === null && draw.loose === 'off') continue;
    available.set(key, (available.get(key) ?? 0) + 1);
  }

  let reach = 0;
  for (const [key, count] of available) reach += Math.min(count, cap(key));

  const short = reach < attributes;
  return (
    <p className={cn('px-1 text-[11px] leading-relaxed', short ? 'text-warn' : 'text-muted')}>
      {short
        ? `These rules leave ${reach} ${reach === 1 ? 'note' : 'notes'} a round can reach, so a round of ${attributes} will draw ${reach}. Raise a cap, or bring a heading back in.`
        : `A round can draw its full ${attributes} under these rules.`}
    </p>
  );
}

/**
 * The password, at the door to the headings.
 *
 * The same argument as everywhere else the profile is read: signing in says the
 * app is open, not that you are the one holding it. The rules above this need
 * no password because they say nothing about you — "at most one from a heading"
 * is a fact about the draw.
 */
function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (password === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { ticket, profile } = await api.unlockTaste(password);
      setTasteTicket(ticket);
      queryClient.setQueryData(queryKeys.taste, profile);
      setPassword('');
      onUnlocked();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2/40 px-3 py-3">
      <p className="text-[11px] text-muted">
        Your password, to read the headings. Choosing between them means seeing what they are
        called, and what they are called is part of the profile.
      </p>
      <input
        type="password"
        value={password}
        aria-label="Password"
        placeholder="Password"
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
        }}
        className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm outline-none focus:border-accent"
      />
      <Button
        variant="primary"
        size="sm"
        className="w-full"
        busy={busy}
        disabled={password === ''}
        onClick={() => void submit()}
      >
        Show the headings
      </Button>
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}
