import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  formatDuration,
  formatTrackLength,
  mediaKindOf,
  playsInAudioElement,
  playsInVideoElement,
  referenceOrigin,
  regionFraction,
  viewBox,
  viewerScaleOf,
  visibleRegion,
  worthRendering,
} from '@latent/shared';
import type { GenerationImage, GenerationRecord, ViewTransform } from '@latent/shared';

import { useQueryClient } from '@tanstack/react-query';

import { imageUrl, thumbnailUrl, viewUrl } from '../api/client';
import { reportPoster } from '../lib/poster';
import { useBlur } from '../state/blur';
import { useGridSettings } from '../state/grid';
import { CompareWipe } from './CompareWipe';
import { cn } from './ui';

/** One image in the viewer's flat list, with the run it came from. */
export interface ViewerEntry {
  record: GenerationRecord;
  image: GenerationImage;
}

interface ImageViewerProps {
  /**
   * Everything swipeable, flattened.
   *
   * Flat rather than one record at a time: a batch of four is not a meaningful
   * boundary when you are flicking through a gallery, and stopping dead at the
   * end of one run made swiping feel broken.
   */
  entries: ViewerEntry[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  footer?: React.ReactNode;
  /** A caption drawn over the bottom of the picture, e.g. chosen parameters. */
  overlay?: React.ReactNode;
}

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
/** How long to wait for a second tap before treating one as a single tap. */
const DOUBLE_TAP_MS = 280;
/** Movement a finger is allowed while still counting as a tap rather than a drag. */
const TAP_SLOP = 10;

/**
 * Full-screen image viewer with pinch-zoom, pan, and swipe between results.
 *
 * Gestures are handled explicitly rather than delegated to the browser: a
 * fixed-position overlay does not get native pinch-zoom, and the alternative
 * (letting the page zoom) breaks the surrounding UI.
 */
/** How long the transform has to hold still before the detail is fetched. */
const DETAIL_SETTLE_MS = 220;

/**
 * The two sources the viewer draws from.
 *
 * `fitted` is the whole picture at the size this screen can show — that alone
 * is the difference between opening a recent output in a moment and waiting
 * several seconds for twenty megabytes that the browser then holds as sixty-four
 * of bitmap. `detail` is the rectangle you have zoomed into, rendered the same
 * way, and it is fetched only once the gesture has settled: a pinch produces a
 * transform every frame, and a request per frame would be worse than the
 * problem it solves.
 *
 * Both fall back to the original when the setting asks for it.
 */
function useViewSources(
  image: GenerationImage | undefined,
  transform: ViewTransform,
): {
  fitted: string | undefined;
  detail: string | null;
  onFittedLoad: (element: HTMLImageElement) => void;
  /**
   * How anything else laid over this picture should be fetched.
   *
   * The before/after comparison draws a second picture in exactly the same box,
   * and it has to be asked for the same way or the two are different sizes of
   * the same thing stacked on each other. Handed out rather than recomputed
   * there, so one place decides.
   */
  box: { width: number; height: number };
  native: boolean;
} {
  const [grid] = useGridSettings();
  /**
   * How much of the screen's resolution to render at, as a multiple of it.
   *
   * `0` is the file itself, which is the one step that is not a box at all —
   * there is nothing to ask the server to fit, and nothing to crop, because
   * every pixel is already there.
   */
  const scale = viewerScaleOf(grid);
  /*
   * A video is always fetched as itself.
   *
   * The renderer on the other end decodes still images; there is nothing there
   * that can open an mp4, resize it and hand back a frame. Asking anyway would
   * cost a round trip to be told so — and the clip is streamed in ranges, which
   * is the cheaper answer to "do not send me all of it" in any case.
   */
  const isVideo = image ? mediaKindOf(image.filename) === 'video' : false;
  const native = scale === 0 || isVideo;
  const [detail, setDetail] = useState<string | null>(null);
  /**
   * The size of the copy that actually arrived.
   *
   * Measured rather than looked up. The stored `width`/`height` are a hint
   * recorded by whoever saw the picture first, and since thumbnails started
   * being derived on the server that "whoever" was often looking at a 384-pixel
   * copy — so trusting the field would put every crop in the wrong coordinate
   * space. This is the picture on screen, so it is right by construction, and
   * it doubles as the answer to "did the server have to shrink it": a copy that
   * came back below the box in both directions is one it declined to enlarge,
   * which means the file has nothing more to show.
   */
  const [rendered, setRendered] = useState<{ width: number; height: number } | null>(null);

  const box = useMemo(
    () =>
      viewBox(
        { width: window.innerWidth, height: window.innerHeight },
        window.devicePixelRatio,
        scale,
      ),
    // Re-measured per picture rather than per frame: a rotation closes and
    // reopens nothing, but it does change which picture is being looked at
    // rarely enough that the extra work is not worth a resize listener.
    [image?.filename, image?.id, scale],
  );

  /*
   * The base layer needs no knowledge of how big the file is: the server
   * discovers that when it decodes, and never enlarges.
   */
  const fitted = !image ? undefined : native ? imageUrl(image) : viewUrl(image, box);

  const onFittedLoad = useCallback((element: HTMLImageElement) => {
    if (element.naturalWidth > 0) {
      setRendered({ width: element.naturalWidth, height: element.naturalHeight });
    }
  }, []);

  // A different picture invalidates the measurement before its own load fires.
  useEffect(() => setRendered(null), [image?.filename, image?.id]);

  /*
   * The rectangle, once the gesture stops moving.
   *
   * Cleared on every change so the stale crop is never shown over a picture it
   * no longer matches — the stretched `fitted` copy takes over in the meantime,
   * which is the ordinary progressive-detail behaviour.
   */
  useEffect(() => {
    setDetail(null);
    if (!image || !rendered || native) return;

    const region = visibleRegion(rendered, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, transform);
    if (!worthRendering(region, rendered, box)) return;

    const timer = window.setTimeout(() => {
      setDetail(viewUrl(image, box, regionFraction(region, rendered)));
    }, DETAIL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [
    image,
    rendered,
    native,
    box,
    transform.scale,
    transform.offsetX,
    transform.offsetY,
  ]);

  return { fitted, detail, onFittedLoad, box, native };
}

export function ImageViewer({
  entries,
  index,
  onIndexChange,
  onClose,
  footer,
  overlay,
}: ImageViewerProps) {
  const entry = entries[index];
  const record = entry?.record;
  const image = entry?.image;
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const { fitted, detail, onFittedLoad, box, native } = useViewSources(image, {
    scale,
    offsetX: offset.x,
    offsetY: offset.y,
  });
  const [grid] = useGridSettings();

  /*
   * The picture this one was edited from, when the workflow said which that
   * was. Fetched the same way and into the same box as the picture over it, so
   * the two line up pixel for pixel and a seam dragged between them is a
   * comparison rather than two differently-scaled copies.
   *
   * Fetched as soon as the result is opened rather than when a handle is first
   * touched: the handles have to know whether there is anything behind them
   * before they are dragged, and a torn-down ComfyUI takes its input directory
   * with it. One extra copy, only for a labelled edit, and only at screen size.
   */
  const origin = referenceOrigin(record?.origins ?? []);
  const originSrc = useMemo(() => {
    if (!origin) return null;
    const ref = { filename: origin.filename, subfolder: origin.subfolder, type: 'input' };
    return native ? imageUrl(ref) : viewUrl(ref, box);
  }, [origin?.filename, origin?.subfolder, native, box]);
  /*
   * The blur is reachable from here as well as from the grid. Full screen is
   * exactly where somebody sitting down next to you sees the most, and going
   * back out to the gallery header to cover it is a second too late.
   */
  const blurred = useBlur((state) => state.blurred);
  const toggleBlur = useBlur((state) => state.toggle);

  /**
   * Whether the viewer's own controls are on screen.
   *
   * Every one of them floats over the picture, and on some pictures that is
   * exactly where the thing you are looking at is: a face behind the close
   * button, a horizon under the action row. There is no arrangement that avoids
   * it on every image, so the answer is to be able to take them all away.
   *
   * While they are gone a tap brings them back rather than closing the viewer.
   * That is the one thing that keeps this from being a trap — the control that
   * undoes the state has gone with everything else, so the gesture has to
   * stand in for it, which is what every photo viewer does anyway.
   */
  const [controlsVisible, setControlsVisible] = useState(true);

  /**
   * The cross-fade between the picture and the one it was edited from.
   *
   * `0` is the result alone, `1` the original alone, and in between the two are
   * laid over each other. Held here rather than inside the comparison because
   * its control lives in the header with the blur: it changes how the whole
   * screen looks, which is what that row is for.
   */
  const [blend, setBlend] = useState(0);
  /** The origin's file has gone — see `originSrc`. Drops the comparison whole. */
  const [originMissing, setOriginMissing] = useState(false);

  /*
   * A poster arriving is news to every grid on the other side of this overlay:
   * until they hear it, the video they are listing keeps showing the plate that
   * says it has no still.
   */
  const queryClient = useQueryClient();
  const capturePoster = useCallback(
    (element: HTMLVideoElement | HTMLImageElement | HTMLAudioElement) => {
      if (!image) return;
      reportPoster(image, element, () => {
        void queryClient.invalidateQueries({ queryKey: ['gallery'] });
        void queryClient.invalidateQueries({ queryKey: ['favorites'] });
      });
    },
    [image, queryClient],
  );

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gestureStart = useRef({ distance: 0, scale: 1, x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const lastTap = useRef(0);
  const tapTimer = useRef<number | undefined>(undefined);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  /**
   * Where the finger went down, for *every* gesture.
   *
   * `swipeStart` is only set when unzoomed, because that is when a flick pages
   * through the gallery. That left a zoomed pan with nothing recording that it
   * had moved at all, so it fell through to the tap branch — and a single tap
   * while zoomed means "zoom back out". Panning a zoomed picture therefore
   * scheduled its own reset, a fifth of a second later, every time.
   */
  const pressStart = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  /*
   * A new *picture* starts unzoomed — not a new index.
   *
   * The list grows underneath the viewer: finishing a render inserts an entry
   * at the top, which shifts the index of the image you are looking at without
   * changing the image at all. Resetting on the index therefore threw away a
   * zoom you had just set up, seconds after you set it up, for no visible
   * reason. Keyed on the entry's own identity, that cannot happen.
   */
  const entryKey = entry ? `${entry.record.id}/${entry.image.subfolder}/${entry.image.filename}` : '';
  useEffect(reset, [entryKey, reset]);

  /*
   * A new picture is a new comparison, so the fade goes back to the result and
   * the question of whether there is an original to fade to is asked again.
   *
   * Not the controls, though: hiding them is a decision about how you want to
   * look at things, and having it undone by every swipe would make it useless
   * for the one case it exists for — going through a run of pictures where the
   * buttons are in the way of all of them.
   */
  useEffect(() => {
    setBlend(0);
    setOriginMissing(false);
  }, [entryKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight' && index < entries.length - 1) onIndexChange(index + 1);
      if (event.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, entries.length, onClose, onIndexChange]);

  // Any pending single-tap must not fire after the viewer has gone.
  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  if (!image || !record) return null;

  const distanceBetween = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const onPointerDown = (event: React.PointerEvent) => {
    /*
     * Capture keeps events coming if the finger leaves the element mid-swipe.
     * It is an optimisation, not a requirement, and it throws for a pointer the
     * browser does not consider active — so a failure here must not be allowed
     * to abort the handler and swallow the whole gesture.
     */
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // Carry on without it.
    }

    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gestureStart.current = {
        distance: distanceBetween(a!, b!),
        scale,
        x: (a!.x + b!.x) / 2,
        y: (a!.y + b!.y) / 2,
        offsetX: offset.x,
        offsetY: offset.y,
      };
    } else if (pointers.current.size === 1) {
      setDragging(true);
      pressStart.current = { x: event.clientX, y: event.clientY };
      gestureStart.current = {
        ...gestureStart.current,
        x: event.clientX,
        y: event.clientY,
        offsetX: offset.x,
        offsetY: offset.y,
      };
      swipeStart.current = scale === 1 ? { x: event.clientX, y: event.clientY } : null;
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const start = gestureStart.current;
      if (start.distance === 0) return;
      const next = Math.min(
        MAX_SCALE,
        Math.max(1, (start.scale * distanceBetween(a!, b!)) / start.distance),
      );
      setScale(next);
      return;
    }

    if (pointers.current.size === 1 && scale > 1) {
      const start = gestureStart.current;
      setOffset({
        x: start.offsetX + (event.clientX - start.x),
        y: start.offsetY + (event.clientY - start.y),
      });
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const start = swipeStart.current;
    pointers.current.delete(event.pointerId);

    if (pointers.current.size === 0) {
      setDragging(false);

      // Unzoomed horizontal flick moves through the gallery.
      if (start && scale === 1) {
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0 && index < entries.length - 1) onIndexChange(index + 1);
          if (dx > 0 && index > 0) onIndexChange(index - 1);
          swipeStart.current = null;
          lastTap.current = 0;
          window.clearTimeout(tapTimer.current);
          return;
        }
        // A drag that went nowhere in particular is not a tap either.
        if (Math.abs(dx) > 12 || Math.abs(dy) > 12) {
          swipeStart.current = null;
          return;
        }
      }

      /*
       * A gesture that travelled is not a tap, zoomed or not. Pinching also
       * lands here when the second finger lifts first, and that must not be
       * read as a tap either.
       */
      const pressed = pressStart.current;
      pressStart.current = null;
      if (
        pressed &&
        (Math.abs(event.clientX - pressed.x) > TAP_SLOP ||
          Math.abs(event.clientY - pressed.y) > TAP_SLOP)
      ) {
        swipeStart.current = null;
        return;
      }

      const now = Date.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        // Double tap toggles zoom, the standard photo-viewer gesture. It wins
        // over the single tap, whose action is still waiting on the timer.
        window.clearTimeout(tapTimer.current);
        if (scale > 1) reset();
        else setScale(DOUBLE_TAP_SCALE);
        lastTap.current = 0;
      } else {
        lastTap.current = now;
        /*
         * A single tap closes the viewer — or, when zoomed in, zooms back out
         * first, because closing on a stray tap while inspecting detail would be
         * infuriating.
         *
         * And when the controls are hidden it brings them back instead, which
         * is the only way back: the button that would undo that state went with
         * them. Standing in for a missing control is what this gesture does in
         * every photo viewer, so it is also the one people try first.
         *
         * Deferred by the double-tap window: without the wait, the first tap of
         * a double tap would close the viewer before the second arrived.
         */
        window.clearTimeout(tapTimer.current);
        tapTimer.current = window.setTimeout(() => {
          if (!controlsVisible) setControlsVisible(true);
          else if (scale > 1) reset();
          else onClose();
        }, DOUBLE_TAP_MS);
      }
    }
    swipeStart.current = null;
  };

  const plays = playsInVideoElement(image.filename);
  const sounds = playsInAudioElement(image.filename);

  /**
   * Whether there is a before-and-after on this screen at all.
   *
   * One question asked once, because three things hang off it — the two wipe
   * tabs, the fade slider, and whether the header shows a counter instead. They
   * disagreeing about it is how you get a slider that steers nothing.
   *
   * Stills only: there is nothing to fade through a clip, and the video element
   * has already taken the gestures.
   */
  const comparing = Boolean(origin && originSrc && !originMissing && !plays && !sounds);

  return (
    /*
      One layer, not three stacked boxes.

      The header and the footer used to take their height out of the middle,
      so the picture was shown in whatever was left — a letterboxed strip with
      black above and below it. The picture is the whole point of this screen,
      so it gets the whole screen, and the controls float on top of it.
    */
    <div className="fixed inset-0 z-60 bg-black">
      <div
        className="absolute inset-0 touch-none overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {sounds ? (
          /*
            A sound, with nothing to look at.

            No frame, no poster, no zoom: what a track has is a title, a length
            and a scrubber, so that is what the screen is. Centred as a card
            rather than stretched over the viewport, because a full-bleed audio
            element is an invisible box that swallows every gesture — and the
            gestures still have work to do here, since a swipe is the next
            output and a tap closes the viewer.
          */
          <div className="flex size-full items-center justify-center p-6">
            <div
              data-testid="viewer-audio"
              className="w-full max-w-sm space-y-3 rounded-2xl border border-line bg-surface-2 p-4 text-center"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerMove={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
            >
              <p aria-hidden className="text-3xl">
                ♪
              </p>
              <p className="text-sm break-words">{record.title}</p>
              <audio
                src={imageUrl(image)}
                controls
                preload="metadata"
                // The length is the one fact about a track worth storing, and
                // the browser is the only thing here that can read it.
                onLoadedMetadata={(event) => capturePoster(event.currentTarget)}
                className="w-full"
              />
            </div>
          </div>
        ) : plays ? (
          /*
            A clip gets the browser's own controls, and keeps its hands off the
            gestures.

            Pinch-to-zoom on a video is meaningless — there is no detail to
            fetch, only a scaled-up frame — and a scrubber you cannot drag
            because the layer above it reads every drag as a swipe is worse than
            no scrubber. So the element stops its own pointer events, and it is
            sized to the clip rather than to the screen: a full-bleed element
            with `object-contain` looks identical and is not the same thing —
            its *box* covers the viewport, so the black margins beside a
            portrait clip would belong to the video and swallow every gesture.
            Fitted, those margins stay with the layer underneath, which is what
            keeps a swipe moving to the next output and a tap closing the
            viewer.
          */
          <div className="flex size-full items-center justify-center">
            <video
              data-testid="viewer-video"
              src={imageUrl(image)}
              controls
              loop
              playsInline
              preload="metadata"
              poster={image.hasThumbnail ? thumbnailUrl(image) : undefined}
              // The first decoded frame is the poster this video does not have
              // yet — see `lib/poster`. `loadeddata` is the moment there is one.
              onLoadedData={(event) => capturePoster(event.currentTarget)}
              // How long it runs arrives first, and separately — see `lib/poster`.
              onLoadedMetadata={(event) => capturePoster(event.currentTarget)}
              onPlaying={(event) => capturePoster(event.currentTarget)}
              onPointerDown={(event) => event.stopPropagation()}
              onPointerMove={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              className="max-h-full max-w-full"
            />
          </div>
        ) : (
          <img
            data-testid="viewer-image"
            src={fitted}
            alt={record.title}
            draggable={false}
            onLoad={(event) => {
              onFittedLoad(event.currentTarget);
              // An animated GIF is a video that a browser draws as a picture,
              // and the still it needs is the frame already on screen.
              if (mediaKindOf(image.filename) === 'video') {
                capturePoster(event.currentTarget);
              }
            }}
            className={cn(
              'size-full origin-center object-contain select-none',
              !dragging && 'transition-transform duration-150',
            )}
            style={{
              transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
            }}
          />
        )}

        {/*
          The zoomed-in rectangle, rendered at the screen's own resolution and
          laid straight over the viewport.

          It is only ever requested for a rectangle wholly inside the picture,
          which is exactly when it covers the viewport edge to edge — so it
          needs no transform of its own. Until it arrives the stretched copy
          underneath is what you see, which is blurry rather than blank.
        */}
        {detail && !plays && !sounds && (
          <img
            data-testid="viewer-detail"
            src={detail}
            alt=""
            draggable={false}
            className="pointer-events-none absolute inset-0 size-full object-cover select-none"
          />
        )}

        {/*
          Before and after, in one frame.

          Over the detail layer as well as the base one, because the crop
          fetched for a zoom is still the *edited* picture — it would otherwise
          be painted back over the half that is supposed to be showing the
          original. Only for stills: there is no before-and-after to drag
          through a clip, and the video element has already taken the gestures.
        */}
        {comparing && (
          <CompareWipe
            origin={origin!}
            src={originSrc!}
            transform={{ scale, offsetX: offset.x, offsetY: offset.y }}
            verticalEdge={grid.compareVerticalEdge}
            horizontalEdge={grid.compareHorizontalEdge}
            blend={blend}
            controlsVisible={controlsVisible}
            onMissing={() => setOriginMissing(true)}
          />
        )}
      </div>

      {/*
        `pointer-events-none` on the strip, `auto` on what is actually in it:
        the picture underneath still takes a tap to close, everywhere the close
        button is not.
      */}
      {controlsVisible && (
        <div className="safe-t pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-1 bg-gradient-to-b from-black/60 to-transparent px-2 py-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="pointer-events-auto grid size-11 shrink-0 place-items-center rounded-full text-2xl text-white/80 active:bg-white/10"
          >
            ✕
          </button>

          {/*
            The fade, where the counter would be.

            The two compete for the same middle, and they are never both the
            thing you want: while you are comparing one picture against the one
            it was made from, which of forty you are on is not the question. It
            comes back the moment the fade is not on offer.
          */}
          {comparing ? (
            <BlendSlider value={blend} onChange={setBlend} title={origin!.nodeTitle} />
          ) : (
            <span className="flex-1 text-center text-sm text-white/60 tabular-nums">
              {entries.length > 1 ? `${index + 1} / ${entries.length}` : ''}
            </span>
          )}

          <button
            type="button"
            onClick={() => setControlsVisible(false)}
            aria-label="Hide the controls"
            className="pointer-events-auto grid size-11 shrink-0 place-items-center rounded-full text-xl text-white/80 active:bg-white/10"
          >
            {/* An open frame: what is left when everything in front of the
                picture has gone. */}
            ⛶
          </button>

          <button
            type="button"
            onClick={toggleBlur}
            aria-label="Blur every image"
            aria-pressed={blurred}
            className={cn(
              'pointer-events-auto grid size-11 shrink-0 place-items-center rounded-full text-xl active:bg-white/10',
              blurred ? 'text-accent' : 'text-white/80',
            )}
          >
            {/* The same glyph the gallery's blur wears: a circle half filled in
                reads as "obscured" at a glance, where a dotted one reads as a
                speck of dust on the screen. */}
            ◍
          </button>
        </div>
      )}

      <div className={cn('absolute inset-x-0 bottom-0 z-10', !controlsVisible && 'hidden')}>
        {/*
          Over the picture, not below it: this is a glance, and the footer is
          already carrying the actions. Hidden while zoomed, where it would just
          be in the way of what you are inspecting.

          No wash behind it either. A gradient from black up to transparent
          reads as a soft fade from above and as a hard edge from below — it has
          to stop somewhere, and where it stopped was a line across the bottom
          of every picture, the last remnant of the bar this used to be. The
          text carries its own legibility instead, which costs nothing and
          covers nothing.
        */}
        {overlay && scale === 1 && (
          <div className="pointer-events-none overflow-hidden px-3 pt-6 pb-2 [text-shadow:0_1px_3px_rgb(0_0_0/0.9)]">
            {/*
              Capped and scrollable rather than as tall as it likes. What a
              node prints can be a paragraph — a model's reasoning, an expanded
              wildcard — and at full height that paragraph covers the picture
              it is describing. `pointer-events-auto` is what lets it be
              scrolled at all; `touch-pan-y` keeps that gesture from being read
              as a swipe to the next image.
            */}
            <div className="pointer-events-auto max-h-[35svh] touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain">
              {overlay}
            </div>
          </div>
        )}

        {/*
          No bar. Just the buttons, over the picture.

          This started as a translucent strip with a blur behind it, then a
          strip without the blur, and the honest end of that line is nothing at
          all: every version was a band across the bottom of the picture that
          existed to make the buttons legible, when the buttons already carry
          their own backgrounds and do that themselves.
        */}
        {/*
          Held to the middle on a big screen.

          The actions belong to the picture, and stretched across a tablet they
          stop reading as a row of controls and start reading as a strip of
          furniture along the bottom of the window — with the rating at one far
          corner and Delete at the other.
        */}
        {footer && (
          <div className="safe-b px-3 pt-2 pb-2 tablet:mx-auto tablet:w-full tablet:max-w-3xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The fade between the picture and the one it was edited from.
 *
 * A range input rather than something hand-built. Dragging a value between two
 * ends is what one is, and taking the platform's means arrow keys, a decent
 * touch target and a screen reader that already knows what to say — none of
 * which a div with pointer handlers gets for free.
 *
 * The two ends are named rather than numbered. "40%" is not a fact anybody
 * wants about a comparison; which picture you are looking at is.
 */
function BlendSlider({
  value,
  onChange,
  title,
}: {
  value: number;
  onChange: (value: number) => void;
  title: string;
}) {
  return (
    <label className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 px-1">
      <span className="sr-only">Fade between the result and {title}</span>
      <input
        type="range"
        data-testid="compare-blend"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        // The layer underneath reads a drag as a swipe to the next picture and
        // a tap as "close"; a finger on this is asking for neither.
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        aria-label={`Fade between the result and ${title}`}
        aria-valuetext={
          value === 0 ? 'the result' : value === 1 ? title : `${Math.round(value * 100)}% ${title}`
        }
        className="h-11 w-full min-w-0 touch-none accent-[var(--color-accent)]"
      />
    </label>
  );
}

/**
 * A grid thumbnail.
 *
 * Only ever requests the preview variant — never the full image. The server
 * resolves that to a stored thumbnail, ComfyUI's own resizer, or (on an old
 * build with neither) the original; from the client's side there is no
 * fallback that could accidentally pull megabytes over mobile data.
 */
export function Thumb({
  image,
  alt,
  label,
  className,
  style,
  onClick,
  onLongPress,
  onMeasured,
  fit = 'cover',
}: {
  image: GenerationImage;
  alt: string;
  /**
   * A name for the thumbnail that is not the picture's own.
   *
   * Left off nearly everywhere, because a grid of pictures is named by its
   * pictures. Set where position is what identifies one — a numbered list of
   * attempts, where "the third" is how you would refer to it out loud and the
   * titles are all variations on the same sentence.
   */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  onLongPress?: () => void;
  /** Reports the real pixel size the first time we learn it. */
  onMeasured?: (width: number, height: number) => void;
  fit?: 'cover' | 'contain';
}) {
  const longPress = useLongPress(onLongPress);

  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      {...(label ? { 'aria-label': label } : {})}
      {...longPress}
      className={cn(
        'relative overflow-hidden rounded-xl bg-surface-2 active:opacity-80',
        className,
      )}
    >
      <Still image={image} alt={alt} fit={fit} onMeasured={onMeasured} />
    </button>
  );
}

/**
 * The still for an output, whatever kind of output it is.
 *
 * For a picture that is the picture. For a video it is the poster — a frame
 * some browser handed back while playing it — and until one exists, a plate
 * saying so. Emphatically *not* the clip itself: a grid that autoloads videos
 * is a grid that pulls tens of megabytes on a mobile connection, which is the
 * exact thing thumbnails exist to prevent.
 */
export function Still({
  image,
  alt,
  className,
  fit = 'cover',
  onMeasured,
  onShown,
}: {
  image: GenerationImage;
  alt: string;
  className?: string;
  /**
   * Which of the three shapes a caller is asking for.
   *
   * `cover` fills a box the caller sized and crops what does not fit — a grid
   * tile. `contain` takes a width and makes its own height from the picture's
   * proportions — a sheet, a chat bubble. `inside` is the third: a box whose
   * height is also fixed, with the picture letterboxed in it. That one exists
   * for the tablet's Generate pane, where the stage is whatever height the
   * window leaves over and a portrait render would otherwise be taller than the
   * space it was given and cropped at the bottom.
   */
  fit?: 'cover' | 'contain' | 'inside';
  onMeasured?: (width: number, height: number) => void;
  /**
   * Called once there is something to look at.
   *
   * "Loaded" rather than "rendered", which is as close as the platform gets —
   * and close enough for the one caller that needs it: the chat, which hands
   * the picture to the model only after you have seen it. The plate a video
   * shows before it has a poster counts too; it is what is on screen.
   */
  onShown?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const kind = mediaKindOf(image.filename);
  const isVideo = kind === 'video';
  const isAudio = kind === 'audio';
  const duration = isAudio ? formatTrackLength(image.durationMs) : formatDuration(image.durationMs);

  /*
   * Two shapes, because there are two kinds of caller.
   *
   * A grid tile is a box of a size the grid decided, and the picture fills it.
   * A sheet or a chat bubble is the other way round: the width is given and the
   * picture's own proportions set the height. Forcing the tile's `size-full` on
   * those collapsed them to nothing, since their height is what was being asked
   * for in the first place.
   */
  const fills = fit !== 'contain';

  /*
   * A tile with no picture behind it.
   *
   * Three cases: a sound, which will never have one; a video whose poster
   * nobody has captured yet; and a picture whose file has gone. A sound is not
   * a failure to show something — it is a thing of a different kind — so it
   * gets a plate of its own rather than the "missing" one.
   */
  if (failed || isAudio || (isVideo && !image.hasThumbnail)) {
    return (
      <span
        ref={() => onShown?.()}
        data-testid={isAudio ? 'audio-placeholder' : isVideo ? 'video-placeholder' : undefined}
        className={cn(
          'grid place-items-center gap-1 bg-surface-2 text-muted',
          fills ? 'size-full' : 'aspect-video w-full',
          className,
        )}
      >
        {isAudio && !failed ? (
          <span className="flex flex-col items-center gap-0.5">
            <span aria-hidden className="text-lg leading-none">
              ♪
            </span>
            <span className="text-[10px]">{duration ?? 'sound'}</span>
          </span>
        ) : isVideo ? (
          <span className="flex flex-col items-center gap-0.5">
            <span aria-hidden className="text-lg leading-none">
              ▶
            </span>
            <span className="text-[10px]">{duration ?? 'video'}</span>
          </span>
        ) : (
          <span className="text-xs">missing</span>
        )}
      </span>
    );
  }

  return (
    <span className={cn('relative block', fills ? 'size-full' : 'w-full', className)}>
      <img
        src={thumbnailUrl(image)}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={(event) => {
          const element = event.currentTarget;
          // The thumbnail's own dimensions carry the original's aspect ratio,
          // which is all the grid needs to shape the tile.
          if (!image.width && element.naturalWidth > 0) {
            onMeasured?.(element.naturalWidth, element.naturalHeight);
          }
          onShown?.();
        }}
        onError={() => setFailed(true)}
        className={cn(
          fit === 'cover' && 'size-full object-cover',
          fit === 'inside' && 'size-full object-contain',
          fit === 'contain' && 'block h-auto w-full object-contain',
        )}
      />
      {/* A poster is a picture of a video, and looks exactly like a picture.
          The badge is the whole difference, so it is not optional. */}
      {isVideo && (
        <span className="pointer-events-none absolute top-1 left-1 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">
          <span aria-hidden>▶</span>
          {duration && <span className="tabular-nums">{duration}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * Long-press without swallowing taps or triggering on a scroll.
 *
 * Used for the per-tile size override — a phone has no right-click, and a
 * dedicated button on every thumbnail would clutter the grid.
 */
function useLongPress(onLongPress?: () => void) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  if (!onLongPress) return {};

  const cancel = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  return {
    onPointerDown: (event: React.PointerEvent) => {
      start.current = { x: event.clientX, y: event.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        onLongPress();
      }, 500);
    },
    onPointerMove: (event: React.PointerEvent) => {
      // Scrolling past a tile must not count as holding it.
      const origin = start.current;
      if (!origin) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  };
}
