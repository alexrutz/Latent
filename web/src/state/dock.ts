import { create } from 'zustand';

/**
 * Whether the side panel is open, and what it is showing.
 *
 * Persisted, because it is a decision about the room you have rather than about
 * the thing you are doing: a 27-inch monitor wants it open permanently, a
 * 1280-point laptop window wants it out of the way while a wide screen is being
 * read, and neither answer changes between sessions. Asking again on every
 * reload would make it a setting you re-apply rather than one you set.
 *
 * Kept out of the server's settings deliberately. This is a property of the
 * machine you are sitting at — the same account on a phone has no panel at all
 * and no opinion about it — and a value synced between them would mean the
 * laptop deciding what the desktop looks like.
 */
interface DockStore {
  open: boolean;
  toggle: () => void;
  set: (open: boolean) => void;
}

const STORAGE_KEY = 'latent.dock';

export const useDock = create<DockStore>((set) => ({
  open: load(),
  toggle: () => set((state) => save(!state.open)),
  set: (open) => set(() => save(open)),
}));

function save(open: boolean): { open: boolean } {
  try {
    localStorage.setItem(STORAGE_KEY, open ? 'open' : 'shut');
  } catch {
    /* Private browsing or a full quota: the in-memory copy still works. */
  }
  return { open };
}

/** Open unless it was shut on purpose — the panel is the point of desk mode. */
function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'shut';
  } catch {
    return true;
  }
}
