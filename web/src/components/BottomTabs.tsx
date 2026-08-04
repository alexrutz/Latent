import { Fragment, useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { useLiveStore } from '../state/live';
import { scrollToTop } from '../state/scroll';
import { cn } from './ui';

interface Tab {
  to: string;
  label: string;
  icon: string;
}

/*
 * Seven destinations, with Chat in the middle.
 *
 * Eight flat tabs was one for every screen, and by the time there were eight
 * the labels were four pixels tall and the two you used most were indis-
 * tinguishable from the two you used twice a month. These six are places you go
 * directly; Blocks, Random and Monitor are places you go to *set something up*
 * and then leave alone, so they sit behind one more tab rather than costing a
 * seventh and eighth of the width forever.
 *
 * Chat is deliberately the middle one and deliberately looks different. It is
 * the screen this app is increasingly built around, and the middle of the bar
 * is the easiest thing on a phone to hit without looking.
 *
 * The icons are all typographic glyphs on purpose: an emoji renders in the
 * platform's own colours and style, which next to five monochrome marks looks
 * like a sticker somebody left on the app.
 */
const TABS: Tab[] = [
  { to: '/', label: 'Generate', icon: '✦' },
  { to: '/gallery', label: 'Gallery', icon: '▦' },
  { to: '/favorites', label: 'Favourites', icon: '★' },
  { to: '/chat', label: 'Chat', icon: '✧' },
  { to: '/queue', label: 'Queue', icon: '≡' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

/** Set up once and then left alone, which is why they are behind a tap. */
const MORE: Tab[] = [
  { to: '/blocks', label: 'Blocks', icon: '¶' },
  { to: '/variation', label: 'Random', icon: '⁂' },
  { to: '/monitor', label: 'Monitor', icon: '∿' },
];

/** Where the "more" tab sits, so Chat keeps the middle. */
const MORE_AFTER = '/queue';

/**
 * The chat module's mark: a speech bubble with a spark in it.
 *
 * Drawn rather than typed. No single character says "talk to a model that makes
 * pictures", and the ones that come close — ✧, ✦, 💬 — are either already used
 * by another tab or render as the platform's own coloured emoji, which next to
 * five monochrome glyphs looks like a sticker somebody left on the app.
 *
 * `currentColor` throughout, so the one mark serves both the filled active tile
 * and the outlined resting one.
 */
function ChatMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[1.15rem]" fill="none" aria-hidden>
      <path
        d="M4 10.2c0-2.9 2.4-5.2 5.4-5.2h5.2c3 0 5.4 2.3 5.4 5.2s-2.4 5.3-5.4 5.3H11l-3.6 3v-3.3C5.5 14.4 4 12.5 4 10.2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {/* The spark: four-pointed, the same family as Generate's ✦, so the two
          read as one app rather than two. */}
      <path
        d="M12 7.4c.35 1.7.75 2.1 2.45 2.45-1.7.35-2.1.75-2.45 2.45-.35-1.7-.75-2.1-2.45-2.45 1.7-.35 2.1-.75 2.45-2.45Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Bottom navigation, because the bottom of the screen is the only part of a
 * phone you can reach one-handed.
 */
export function BottomTabs() {
  const queueRemaining = useLiveStore((state) => state.live.queueRemaining);
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  const [moreOpen, setMoreOpen] = useState(false);

  // Any navigation closes it, including one made from inside the menu.
  useEffect(() => setMoreOpen(false), [pathname]);

  const inMore = MORE.some((tab) => pathname.startsWith(tab.to));

  return (
    <nav className="safe-b relative shrink-0 border-t border-line bg-surface/95 backdrop-blur">
      {moreOpen && (
        <>
          {/* Tapping anywhere else puts it away, the way a menu should. */}
          <div
            role="presentation"
            onClick={() => setMoreOpen(false)}
            className="fixed inset-0 z-10"
          />
          <ul
            data-testid="more-menu"
            className="animate-rise absolute right-2 bottom-full z-20 mb-2 w-44 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
          >
            {MORE.map((tab) => (
              <li key={tab.to}>
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    navigate(tab.to);
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm active:bg-surface-2',
                    pathname.startsWith(tab.to) ? 'text-accent' : 'text-body',
                  )}
                >
                  <span aria-hidden className="w-4 text-center text-base leading-none">
                    {tab.icon}
                  </span>
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <ul className="flex">
        {TABS.map((tab) => {
          const active = tab.to === '/' ? pathname === '/' : pathname.startsWith(tab.to);
          const chat = tab.to === '/chat';

          return (
            <Fragment key={tab.to}>
              <li className="min-w-0 flex-1">
                <NavLink
                  to={tab.to}
                  end={tab.to === '/'}
                  /*
                   * Tapping the tab you are already on goes back to the top, the
                   * way every other phone app behaves. Without it, a long gallery
                   * scroll is a one-way trip.
                   */
                  onClick={(event) => {
                    if (!active) return;
                    event.preventDefault();
                    scrollToTop();
                  }}
                  className={({ isActive }) =>
                    cn(
                      'relative flex h-14 flex-col items-center justify-center gap-0.5',
                      isActive ? 'text-accent' : 'text-muted',
                    )
                  }
                >
                  {/*
                    Chat gets a tile, not a glyph.

                    The other five are typographic marks sitting on the bar;
                    this one is a filled squircle with a drawn mark inside it,
                    which is a different *kind* of thing rather than a bigger
                    version of the same one — and that is what makes the middle
                    of the bar findable without reading any of the labels. Same
                    footprint as the ring it replaces, so the bar's height is
                    unchanged.
                  */}
                  {chat ? (
                    <span
                      aria-hidden
                      className={cn(
                        'grid size-8 -translate-y-1 place-items-center rounded-[0.7rem] transition-colors',
                        active
                          ? 'bg-gradient-to-br from-accent to-accent/70 text-white shadow-sm shadow-accent/30'
                          : 'bg-surface-2 text-accent ring-1 ring-accent/30 ring-inset',
                      )}
                    >
                      <ChatMark />
                    </span>
                  ) : (
                    <span aria-hidden className="text-base leading-none">
                      {tab.icon}
                    </span>
                  )}
                  <span
                    className={cn(
                      'max-w-full truncate px-px text-[8px] leading-none font-medium',
                      chat && '-mt-1.5',
                    )}
                  >
                    {tab.label}
                  </span>

                  {tab.to === '/queue' && queueRemaining > 0 && (
                    <span className="absolute top-1.5 right-[calc(50%-0.95rem)] grid size-3.5 place-items-center rounded-full bg-accent text-[9px] font-semibold text-white">
                      {queueRemaining > 9 ? '9+' : queueRemaining}
                    </span>
                  )}
                </NavLink>
              </li>

              {tab.to === MORE_AFTER && (
                <li className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setMoreOpen((open) => !open)}
                    aria-expanded={moreOpen}
                    aria-label="More modules"
                    className={cn(
                      'relative flex h-14 w-full flex-col items-center justify-center gap-0.5',
                      inMore || moreOpen ? 'text-accent' : 'text-muted',
                    )}
                  >
                    <span className="text-base leading-none" aria-hidden>
                      ⋯
                    </span>
                    <span className="max-w-full truncate px-px text-[8px] leading-none font-medium">
                      More
                    </span>
                  </button>
                </li>
              )}
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}
