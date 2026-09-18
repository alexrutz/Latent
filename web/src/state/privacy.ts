import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The app puts itself away when you stop looking at it.
 *
 * Not a blur and not a lock. The blur next door (`state/blur.ts`) is for
 * handing somebody the phone to show them one thing — it softens the pictures
 * and leaves the app usable. This is the other case: you have left. The screen
 * is about to be a thumbnail in an app switcher, or a window somebody else is
 * now standing in front of, and what is on it is a prompt you wrote and the
 * pictures it made.
 *
 * So the whole app goes behind a cover, and coming back is one tap — there is
 * no password here, because this is not protecting the account. It is
 * protecting the glance.
 *
 * Everything above the tab bar is covered and the tab bar itself is not, which
 * is what makes the cover feel like part of the app rather than a crash: the
 * way out is the navigation that was always there, and tapping a tab both
 * lifts the cover and takes you where you were going. See `App.tsx`.
 */
interface PrivacyStore {
  /** Whether the cover is up right now. */
  covered: boolean;
  cover: () => void;
  uncover: () => void;
}

export const usePrivacyStore = create<PrivacyStore>((set) => ({
  covered: false,
  cover: () => set({ covered: true }),
  uncover: () => set({ covered: false }),
}));

/** Whether the cover is up. A subscription, for the components that draw it. */
export function useCovered(): boolean {
  return usePrivacyStore((state) => state.covered);
}

/**
 * Lift the cover, from anywhere.
 *
 * A plain function rather than a hook because most callers are event handlers
 * in components that otherwise have no reason to subscribe — the tab bar
 * re-rendering on every cover and uncover would be a re-render of the
 * navigation for something the navigation does not draw.
 */
export function uncover(): void {
  usePrivacyStore.getState().uncover();
}

/**
 * Raise the cover whenever the app stops being what is in front of you.
 *
 * Three signals, because no one of them catches every way of leaving:
 *
 * - `visibilitychange` to hidden is the phone locking, the app being switched
 *   away from, and the browser tab going to the background. It is the one that
 *   matters most and the one that fires last, which is why it is not alone.
 * - `blur` on the window is the desktop case the first one misses entirely: the
 *   window is still perfectly visible, you have just clicked on something else
 *   in front of it. It also fires *earlier* than the visibility change when an
 *   app is switched away from, which on iOS is the difference between the cover
 *   being in the app switcher's snapshot and not.
 * - `pagehide` is the tab being closed or navigated away from, where the last
 *   frame drawn is the one a restored session starts on.
 *
 * Nothing lowers the cover automatically. Coming back is a deliberate tap, on
 * the cover or on a tab — if returning to the app were enough, the cover would
 * be gone by the time you looked at the screen you had just unlocked, which is
 * exactly the frame it exists for.
 */
export function usePrivacyCover(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      /*
       * Switching the feature off takes down a cover that is already up.
       * Otherwise the setting that turns it off is behind the thing it turns
       * off — you would have to lift the cover to reach the switch, and the
       * switch would then appear to have done nothing.
       */
      usePrivacyStore.getState().uncover();
      return;
    }

    const raise = () => usePrivacyStore.getState().cover();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') raise();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', raise);
    window.addEventListener('pagehide', raise);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', raise);
      window.removeEventListener('pagehide', raise);
    };
  }, [enabled]);
}
