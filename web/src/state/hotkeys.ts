import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useDock } from './dock';

/**
 * Driving the app from the keyboard, which is what a machine with one is for.
 *
 * A phone has no keyboard to speak of and a tablet's is a thing you attach, so
 * every route through this app is a tap on something you can see. That is the
 * right floor and the wrong ceiling: at a desk your hands are already on the
 * keys, and reaching for a mouse to move between two screens you move between
 * forty times an hour is the whole of what makes a web app feel slower than a
 * program.
 *
 * Three rules the bindings obey, and the third is the one that matters:
 *
 * 1. **Nothing fires while you are typing.** An `input`, a `textarea` or
 *    anything `contenteditable` owns every key it receives — a prompt with the
 *    word "gallery" in it must not navigate five times on the way in.
 * 2. **Nothing is a bare modifier-less key that a browser already means.** Tab,
 *    space and the arrows stay the browser's.
 * 3. **Every binding has a visible way to do the same thing.** These are a
 *    faster route to buttons, never the only route to a behaviour — an app you
 *    can only fully use if you have read a list of shortcuts is an app that
 *    does not work on the phone it was written for.
 *
 * The navigation half is a *chord*: `g` then a letter, the convention Gmail
 * settled and everything since has borrowed. Two keys rather than one because
 * ten destinations do not have ten spare single letters between them, and
 * because a leading `g` makes the second key unambiguous rather than a gamble
 * on which screen `m` belongs to.
 */

/** Where `g` then a letter goes. The letter is the destination's own initial. */
export const GO_KEYS: { key: string; to: string; label: string }[] = [
  { key: 'g', to: '/', label: 'Generate' },
  { key: 'l', to: '/gallery', label: 'Gallery' },
  { key: 'f', to: '/favorites', label: 'Favourites' },
  { key: 'c', to: '/chat', label: 'Chat' },
  { key: 'q', to: '/queue', label: 'Queue' },
  { key: 'b', to: '/blocks', label: 'Blocks' },
  { key: 'm', to: '/models', label: 'Models' },
  { key: 'r', to: '/variation', label: 'Random' },
  { key: 'n', to: '/monitor', label: 'Monitor' },
  { key: 'y', to: '/study', label: 'Study' },
  { key: 's', to: '/settings', label: 'Settings' },
];

/** The single keys, for the map that lists them. */
export const KEYS: { keys: string; does: string }[] = [
  { keys: '⌘/Ctrl ↵', does: 'Generate, from the form' },
  { keys: '/', does: 'Jump to the prompt' },
  { keys: '[', does: 'Show or hide the bench' },
  { keys: 'g then a letter', does: 'Go to a screen' },
  { keys: '?', does: 'This list' },
  { keys: 'Esc', does: 'Close what is in front' },
];

/**
 * Whether a key press belongs to something being typed in.
 *
 * Exported because the Generate screen asks the same question about its own
 * `⌘↵`, and two answers to "is the user typing" is how one of them ends up
 * wrong.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * The app-wide bindings. Mounted once, in `App`.
 *
 * Returns whether the shortcut map is open, and the way to close it, because
 * the map is the one binding whose effect is a piece of UI rather than a
 * navigation — and the component that draws it is the one that owns it.
 */
export function useHotkeys(enabled: boolean): { map: boolean; closeMap: () => void } {
  const navigate = useNavigate();
  const toggleDock = useDock((state) => state.toggle);
  const [map, setMap] = useState(false);

  /*
   * A `g` waiting for its second key.
   *
   * In a ref rather than a local of the effect, because the effect is torn down
   * and rebuilt whenever the router hands back a new `navigate` — which is
   * exactly what the first half of a chord does. Held in the closure, `g l`
   * worked and `g m` immediately after it did not: the listener that was
   * holding the `g` had been replaced by the navigation the `g` caused.
   *
   * The timeout is long enough not to hurry anybody and short enough that a `g`
   * typed and abandoned does not turn the next keystroke — minutes later, in a
   * different frame of mind — into a navigation nobody asked for.
   */
  const pendingGo = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target)) return;

      // A chord in progress: this key is the destination, whatever it is.
      if (pendingGo.current !== null) {
        window.clearTimeout(pendingGo.current);
        pendingGo.current = null;
        const target = GO_KEYS.find((entry) => entry.key === event.key.toLowerCase());
        if (target) {
          event.preventDefault();
          navigate(target.to);
        }
        return;
      }

      // Modified keys are the browser's and the operating system's — ⌘L, ⌘R,
      // ctrl+F. The one exception the app claims is handled where it applies.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'g') {
        pendingGo.current = window.setTimeout(() => (pendingGo.current = null), 1200);
        return;
      }
      if (event.key === '[') {
        event.preventDefault();
        toggleDock();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        setMap((current) => !current);
        return;
      }
      if (event.key === '/') {
        /*
         * The prompt, wherever it is. Found by its placeholder rather than by
         * a ref threaded from here into the form: the composer on the chat
         * screen and the prompt on the generate screen are different
         * components on different routes, and this has to mean "the thing you
         * would type into on the screen you are looking at".
         */
        const box = document.querySelector<HTMLTextAreaElement>('textarea[data-prompt]');
        if (box) {
          event.preventDefault();
          box.focus();
        }
      }
    };

    window.addEventListener('keydown', onKey);
    // The pending chord is deliberately *not* cleared here: a re-subscription
    // is not the person changing their mind, and cancelling it there is the
    // bug this ref exists to fix. The timeout still ends it on its own.
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, navigate, toggleDock]);

  return { map, closeMap: () => setMap(false) };
}
