import { create } from 'zustand';

const STORAGE_KEY = 'latent.blur';

interface BlurStore {
  blurred: boolean;
  toggle: () => void;
  set: (blurred: boolean) => void;
}

/**
 * Privacy blur: every picture in the app, heavily out of focus.
 *
 * For looking at the queue on a train, or handing the phone to somebody to show
 * them one thing. Kept on the device and applied by an attribute on the root
 * element, so it survives a reload and covers pictures no component of ours
 * renders directly.
 */
export const useBlur = create<BlurStore>((set) => ({
  blurred: read(),
  toggle: () => set((state) => write(!state.blurred)),
  set: (blurred) => set(() => write(blurred)),
}));

function write(blurred: boolean): { blurred: boolean } {
  try {
    localStorage.setItem(STORAGE_KEY, blurred ? '1' : '0');
  } catch {
    /* Private browsing: the setting just will not survive a reload. */
  }
  apply(blurred);
  return { blurred };
}

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Reflect the setting onto the document, where the CSS rule can see it. */
export function apply(blurred: boolean): void {
  document.documentElement.dataset.blur = blurred ? 'on' : 'off';
}
