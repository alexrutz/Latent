import { useEffect, useState } from 'react';

import { uncover } from '../state/privacy';

/**
 * What the app looks like once you are not looking at it.
 *
 * The brief for the drawing is narrow and worth stating, because it rules out
 * most of what a cover screen usually is. It has to be **opaque** — a frosted
 * pane over the gallery is a gallery you can still read the shape of, and the
 * shape is the part somebody recognises across a room. It has to be **quiet**:
 * this is a thing that appears unbidden several times an hour, and a splash
 * screen with a logo animation would be exhausting by Wednesday. And it has to
 * be **obviously the app** rather than an error, or the first instinct on
 * seeing it is to force-quit.
 *
 * So: the app's own dark ground, the name set the way the side rail sets it,
 * and one line saying what to do. The only movement is a slow drift across two
 * soft fields of colour, which is there to say the screen is alive rather than
 * frozen — and which a reduced-motion setting takes away entirely, at no cost
 * to anything the cover is for.
 *
 * It deliberately does not say what is underneath it. A cover captioned "back
 * to the gallery" has told whoever is holding the phone the one thing the
 * cover was put up to keep to yourself.
 */
export function PrivacyCover() {
  /*
   * The clock, because a cover is the screen you glance at.
   *
   * It is the only information here that is safe to show — it is on the lock
   * screen of the device already — and it is what turns the cover from a blank
   * into something you do not mind resting on. Started at mount and ticking on
   * the minute rather than the second: a seconds hand is a thing that draws
   * the eye, which is the opposite of the point.
   */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    /*
      A button, not a div with a click handler.

      The whole surface is one target — "tapping somewhere on the cover removes
      the cover" is the entire interaction — and making that a button is what
      gives it the keyboard and the screen reader for free. A stray Enter or
      Space while the cover is up should lift it, which is exactly what a
      button does and what a handler on a div does not.

      `touch-none` because this is not a scrollable surface: a drag that starts
      here would otherwise be handed to the document underneath, which scrolls
      the screen you cannot see to a place you did not choose.
    */
    <button
      type="button"
      data-testid="privacy-cover"
      aria-label="Latent is covered. Tap to return."
      onClick={uncover}
      className="animate-fade absolute inset-0 z-40 flex touch-none flex-col items-center justify-center overflow-hidden bg-ink"
    >
      {/*
        Two soft fields, well inside the edges.

        Blurred radial washes rather than a gradient across the whole plane: a
        full-bleed gradient reads as a background somebody chose, and these read
        as depth. They sit behind everything and catch no taps.
      */}
      <span
        aria-hidden
        className="motion-safe:animate-cover-drift pointer-events-none absolute -top-24 -left-20 size-[22rem] rounded-full bg-accent/12 blur-3xl"
      />
      <span
        aria-hidden
        className="motion-safe:animate-cover-drift-slow pointer-events-none absolute -right-24 -bottom-28 size-[26rem] rounded-full bg-accent-hi/8 blur-3xl"
      />

      <div className="relative flex flex-col items-center gap-5 px-8">
        {/*
          The mark: a filled squircle with the app's own spark in it.

          The same four-pointed star the Generate tab uses, at the size a lock
          screen icon would be — so the cover is recognisably this app and not
          the operating system having put something else in front of it.
        */}
        <span className="grid size-16 place-items-center rounded-[1.35rem] bg-surface ring-1 ring-line ring-inset">
          <svg viewBox="0 0 24 24" className="size-7 text-accent" fill="none" aria-hidden>
            <path
              d="M12 3.2c.9 4.7 2 5.9 6.8 6.8-4.8.9-5.9 2-6.8 6.8-.9-4.7-2-5.9-6.8-6.8C10 9.1 11.1 8 12 3.2Z"
              fill="currentColor"
            />
            {/*
              A bar under the spark, the width of a shut door.
              It is the only thing on this screen that says "closed", and a
              drawn line says it without a padlock emoji rendering in the
              platform's own colours next to a monochrome mark.
            */}
            <path
              d="M6.5 20h11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              opacity="0.55"
            />
          </svg>
        </span>

        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[13px] font-semibold tracking-[0.34em] text-muted uppercase">
            Latent
          </span>
          <span className="text-3xl font-light tabular-nums text-body/90">
            {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <span className="text-center text-xs text-muted/80">
          Tap anywhere to carry on, or pick a tab below.
        </span>
      </div>
    </button>
  );
}
