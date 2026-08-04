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
                    Chat's mark sits in a ring. Colour alone would be one more
                    thing competing with the active state; a shape reads as
                    "this one is different" at any size and in any theme.
                  */}
                  <span
                    aria-hidden
                    className={cn(
                      'text-base leading-none',
                      chat &&
                        cn(
                          'grid size-8 -translate-y-1 place-items-center rounded-full border',
                          active
                            ? 'border-accent bg-accent text-white'
                            : 'border-accent/40 bg-accent/10 text-accent',
                        ),
                    )}
                  >
                    {tab.icon}
                  </span>
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
