import { NavLink } from 'react-router-dom';

import { useLiveStore } from '../state/live';
import { cn } from './ui';

interface Tab {
  to: string;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { to: '/', label: 'Generate', icon: '✦' },
  { to: '/gallery', label: 'Gallery', icon: '▦' },
  { to: '/favorites', label: 'Favourites', icon: '★' },
  { to: '/queue', label: 'Queue', icon: '≡' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

/**
 * Bottom navigation, because the bottom of the screen is the only part of a
 * phone you can reach one-handed. Each target is 56px tall plus the home
 * indicator inset.
 */
export function BottomTabs() {
  const queueRemaining = useLiveStore((state) => state.live.queueRemaining);

  return (
    <nav className="safe-b shrink-0 border-t border-line bg-surface/95 backdrop-blur">
      <ul className="flex">
        {TABS.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                cn(
                  'relative flex h-14 flex-col items-center justify-center gap-0.5',
                  isActive ? 'text-accent' : 'text-muted',
                )
              }
            >
              <span className="text-lg leading-none" aria-hidden>
                {tab.icon}
              </span>
              <span className="max-w-full truncate px-0.5 text-[9px] font-medium">{tab.label}</span>

              {tab.to === '/queue' && queueRemaining > 0 && (
                <span className="absolute top-1.5 right-[calc(50%-1.1rem)] grid size-4 place-items-center rounded-full bg-accent text-[10px] font-semibold text-white">
                  {queueRemaining > 9 ? '9+' : queueRemaining}
                </span>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
