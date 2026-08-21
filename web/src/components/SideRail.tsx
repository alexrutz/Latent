import { NavLink, useLocation } from 'react-router-dom';

import { useLiveStore } from '../state/live';
import { scrollToTop } from '../state/scroll';
import { ChatMark, MORE, TABS, type Tab } from './BottomTabs';
import { cn } from './ui';

/**
 * Navigation down the side, which is what a tablet's extra width is first for.
 *
 * The bottom bar exists because the bottom of a phone is the only part of it a
 * thumb reaches. Neither half of that is true here: a tablet is held in two
 * hands or stood on a table, nothing about its bottom edge is privileged, and
 * the axis that is actually scarce is the vertical one — a landscape 9.7-inch
 * screen is 768 points tall, and giving 60 of them to navigation is giving away
 * the room the pictures wanted.
 *
 * Sideways it costs width instead, which there is plenty of, and it buys two
 * things the bar could not afford. Every destination is listed — the four
 * behind "More" were only ever hidden because six is as many as a phone's width
 * can label — so setting up a workflow or checking the monitor stops being a
 * menu. And the labels are legible: eight points at the bottom of a phone is
 * a shape you learn the position of rather than a word you read.
 */
export function SideRail() {
  const queueRemaining = useLiveStore((state) => state.live.queueRemaining);
  const pathname = useLocation().pathname;

  return (
    /*
     * `touch-none` for the same reason the bar has it: this is not a scrollable
     * surface, and a drag starting here was being handed to the document, which
     * slid the whole app sideways. The list inside may scroll — ten rows and a
     * heading is more than a short window has — and says so for itself.
     */
    <nav
      data-testid="side-rail"
      className="safe-l safe-t z-30 flex w-[5.25rem] shrink-0 touch-none flex-col border-r border-line bg-surface/60"
    >
      {/*
        The name, once, at the top of the rail.

        Not decoration: the rail is a column of small marks, and a column of
        small marks with nothing above it reads as a toolbar that has come
        loose. On a phone there is no room to say it and no need — you launched
        the thing — but here the space is free.
      */}
      <div className="flex h-12 shrink-0 items-center justify-center">
        <span className="text-[13px] font-semibold tracking-[0.18em] text-muted uppercase">
          Latent
        </span>
      </div>

      <ul className="min-h-0 flex-1 touch-pan-y space-y-0.5 overflow-y-auto px-1.5 pb-2">
        {TABS.map((tab) => (
          <RailItem
            key={tab.to}
            tab={tab}
            pathname={pathname}
            badge={tab.to === '/queue' ? queueRemaining : 0}
          />
        ))}

        {/*
          A rule, not a menu.

          These four are still the ones you set up and then leave alone, and
          that difference is worth keeping — it is what tells you where to look
          for something you have only touched once. A line says it at no cost;
          a menu said it by making them harder to reach.
        */}
        <li aria-hidden className="mx-2 my-1.5 border-t border-line" />

        {MORE.map((tab) => (
          <RailItem key={tab.to} tab={tab} pathname={pathname} badge={0} quiet />
        ))}
      </ul>
    </nav>
  );
}

/**
 * One destination.
 *
 * `quiet` is the set-and-forget half of the list: the same row at the same size
 * — they are targets, not footnotes — with a lighter resting colour, so the six
 * you use daily are the ones the eye lands on first.
 */
function RailItem({
  tab,
  pathname,
  badge,
  quiet = false,
}: {
  tab: Tab;
  pathname: string;
  badge: number;
  quiet?: boolean;
}) {
  const active = tab.to === '/' ? pathname === '/' : pathname.startsWith(tab.to);
  const chat = tab.to === '/chat';

  return (
    <li>
      <NavLink
        to={tab.to}
        end={tab.to === '/'}
        // Tapping the destination you are already on goes back to the top, as
        // it does on the bar. A long gallery is a one-way trip without it.
        onClick={(event) => {
          if (!active) return;
          event.preventDefault();
          scrollToTop();
        }}
        className={cn(
          'relative flex flex-col items-center gap-1 rounded-xl px-1 py-2 transition-colors',
          active
            ? 'bg-accent/15 text-accent'
            : quiet
              ? 'text-muted/70 active:bg-surface-2'
              : 'text-muted active:bg-surface-2',
        )}
      >
        {chat ? (
          <span
            aria-hidden
            className={cn(
              'grid size-8 place-items-center rounded-[0.7rem] transition-colors',
              active
                ? 'bg-gradient-to-br from-accent to-accent/70 text-white shadow-sm shadow-accent/30'
                : 'bg-surface-2 text-accent ring-1 ring-accent/30 ring-inset',
            )}
          >
            <ChatMark />
          </span>
        ) : (
          <span aria-hidden className="grid size-8 place-items-center text-lg leading-none">
            {tab.icon}
          </span>
        )}

        {/* Read rather than recognised, which is the point of the rail. */}
        <span className="max-w-full truncate text-[10px] leading-none font-medium">
          {tab.label}
        </span>

        {badge > 0 && (
          <span className="absolute top-1 right-2 grid size-4 place-items-center rounded-full bg-accent text-[9px] font-semibold text-white">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </NavLink>
    </li>
  );
}
