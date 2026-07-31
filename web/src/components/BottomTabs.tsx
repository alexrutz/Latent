import { NavLink, useLocation } from 'react-router-dom';

import { useLiveStore } from '../state/live';
import { scrollToTop } from '../state/scroll';
import { cn } from './ui';

interface Tab {
  to: string;
  label: string;
  icon: string;
}

/*
 * Eight destinations is a lot for a phone, but each of these is somewhere you
 * go directly rather than through something else, and burying half of them
 * under a "more" menu would only add a tap to every visit.
 *
 * The icons are all typographic glyphs on purpose: an emoji renders in the
 * platform's own colours and style, which next to five monochrome marks looks
 * like a sticker somebody left on the app.
 */
const TABS: Tab[] = [
  { to: '/', label: 'Generate', icon: '✦' },
  { to: '/gallery', label: 'Gallery', icon: '▦' },
  { to: '/favorites', label: 'Favourites', icon: '★' },
  { to: '/blocks', label: 'Blocks', icon: '¶' },
  { to: '/variation', label: 'Random', icon: '⁂' },
  { to: '/queue', label: 'Queue', icon: '≡' },
  { to: '/monitor', label: 'Monitor', icon: '∿' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

/**
 * Bottom navigation, because the bottom of the screen is the only part of a
 * phone you can reach one-handed.
 */
export function BottomTabs() {
  const queueRemaining = useLiveStore((state) => state.live.queueRemaining);
  const pathname = useLocation().pathname;

  return (
    <nav className="safe-b shrink-0 border-t border-line bg-surface/95 backdrop-blur">
      <ul className="flex">
        {TABS.map((tab) => {
          const active = tab.to === '/' ? pathname === '/' : pathname.startsWith(tab.to);
          return (
            <li key={tab.to} className="min-w-0 flex-1">
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
                <span className="text-base leading-none" aria-hidden>
                  {tab.icon}
                </span>
                <span className="max-w-full truncate px-px text-[8px] leading-none font-medium">
                  {tab.label}
                </span>

                {tab.to === '/queue' && queueRemaining > 0 && (
                  <span className="absolute top-1.5 right-[calc(50%-0.95rem)] grid size-3.5 place-items-center rounded-full bg-accent text-[9px] font-semibold text-white">
                    {queueRemaining > 9 ? '9+' : queueRemaining}
                  </span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
