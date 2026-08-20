import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { contentTypeOf, mediaKindOf, textOutputLabel } from '@latent/shared';
import type { Favorite, GenerationRecord, GridSettings } from '@latent/shared';

import { api, imageUrl } from '../api/client';
import {
  queryKeys,
  useAddFavorite,
  useDeleteFavorite,
  useDeleteImage,
  useFavorites,
  useKeepImage,
  useRateImage,
  useSettings,
  useUpdateFavorite,
  useWorkflows,
} from '../api/queries';
import { ImageViewer, type ViewerEntry } from './ImageViewer';
import { overlayValues, ParamOverlayLine, ParamOverlayPicker } from './ParamOverlay';
import { RatingStars } from './RatingStars';
import { Button, cn, ErrorNote, Sheet, Spinner } from './ui';
import { usePendingStore } from '../state/pending';

/* ------------------------------------------------------------------ */
/* Viewer with the actions that make a result reusable                 */
/* ------------------------------------------------------------------ */

/**
 * The full-screen viewer, wherever a picture is opened from.
 *
 * Shared rather than owned by the gallery: opening a favourite used to give a
 * viewer with nothing in it, so the picture you cared about most was the one
 * you could do least with — no rating, no keep, no save, no details. A picture
 * is a picture whichever list you came in by, and the actions belong to it
 * rather than to the screen.
 */
export function ViewerWithActions({
  entries,
  index,
  grid,
  onGridChange,
  onIndexChange,
  onClose,
  onShowInGallery,
}: {
  entries: ViewerEntry[];
  index: number;
  /** Which parameters to draw over the picture, shared with the grid's own. */
  grid: GridSettings;
  onGridChange: (patch: Partial<GridSettings>) => void;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /**
   * Take this picture to where the rest of its run is, when there is somewhere
   * else to take it. Set from Favourites, where the swipe goes through the
   * favourites rather than through the batch this one came out of.
   */
  onShowInGallery?: (entry: ViewerEntry) => void;
}) {
  const navigate = useNavigate();
  const setPending = usePendingStore((state) => state.setPending);
  const workflows = useWorkflows();
  const settings = useSettings();
  const [showDetails, setShowDetails] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rateImage = useRateImage();
  const keepImage = useKeepImage();
  const deleteImage = useDeleteImage();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const addFavorite = useAddFavorite();
  const removeFavorite = useDeleteFavorite();
  const favorites = useFavorites();

  // Swiping to the next picture must not leave a primed delete button behind.
  useEffect(() => setConfirmDelete(false), [index]);

  // Every hook above runs unconditionally; only then is it safe to bail. The
  // caller only renders this once it has found the entry, so a miss means the
  // picture was deleted underneath us — closing is the right answer.
  const entry = entries[index];
  if (!entry) return null;

  const { record, image } = entry;
  const workflowExists = workflows.data?.some((item) => item.id === record.workflowId) ?? false;
  /*
   * A clip cannot be sent anywhere that expects a picture.
   *
   * `LoadImage` reads one frame from a file, so img2img and upscaling are not
   * "not implemented yet" for a video — they are the wrong question. Shown
   * disabled rather than hidden, so the row of actions does not rearrange
   * itself as you swipe from a picture to a video.
   */
  /*
   * Anything that is not a still picture cannot be sent where a picture goes.
   *
   * `LoadImage` reads one frame from a file, so img2img and upscaling are not
   * "not implemented yet" for a clip or a track — they are the wrong question.
   */
  const notAStill = mediaKindOf(image.filename) !== 'image';
  const viewerOverlay = overlayValues(record, grid.viewerParams);

  /*
   * Whether *this* image is already a favourite.
   *
   * Read from the stored list rather than tracked locally, so the button tells
   * the truth when the viewer is reopened — and so a second tap removes it
   * instead of silently saving a duplicate, which is what used to happen.
   */
  const existingFavorite = image
    ? (favorites.data?.find(
        (entry) =>
          entry.generationId === record.id &&
          entry.image?.filename === image.filename &&
          entry.image?.subfolder === image.subfolder,
      ) ?? null)
    : null;

  const favorite = async () => {
    if (!image) return;
    setError(null);
    try {
      if (existingFavorite) {
        await removeFavorite.mutateAsync(existingFavorite.id);
      } else {
        await addFavorite.mutateAsync({ generationId: record.id, image });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that favourite');
    }
  };

  const rate = async (rating: number) => {
    if (!image) return;
    setError(null);
    try {
      await rateImage.mutateAsync({ generationId: record.id, image, rating });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that rating');
    }
  };

  const rerun = (freshSeed: boolean) => {
    if (!record.workflowId) return;
    setPending({ workflowId: record.workflowId, values: record.values, freshSeed });
    onClose();
    navigate('/');
  };

  /** Copy this result into ComfyUI's inputs, then open the target workflow. */
  const sendTo = async (target: 'img2img' | 'upscale') => {
    if (!image) return;
    const workflowId =
      target === 'upscale' ? settings.data?.upscaleWorkflowId : settings.data?.img2imgWorkflowId;

    if (!workflowId) {
      setError(
        `No ${target} workflow chosen yet. Pick one in Settings so this button knows where to send the image.`,
      );
      return;
    }

    setBusy(target);
    setError(null);
    try {
      const uploaded = await api.toInput(image);
      setPending({
        workflowId,
        imageFilename: uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name,
        freshSeed: true,
      });
      onClose();
      navigate('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the image');
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    if (!image) return;
    const url = imageUrl(image);
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const file = new File([blob], image.filename, {
        type: blob.type || contentTypeOf(image.filename),
      });

      // Web Share with files is the only route to "save to camera roll" on iOS.
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: record.title });
        return;
      }
    } catch {
      // Fall through to a plain download.
    }

    const link = document.createElement('a');
    link.href = url;
    link.download = image.filename;
    link.click();
  };

  return (
    <ImageViewer
      entries={entries}
      index={index}
      onIndexChange={onIndexChange}
      onClose={onClose}
      /*
        Text a node produced is chosen here like any other value now, rather
        than always being on: a node that writes the prompt is describing the
        picture the way the seed is, but a caption several lines long is not
        something to have permanently across the bottom of every image.
      */
      overlay={
        /*
          Nothing chosen, nothing rendered — not an empty strip. The viewer
          reserves room for whatever this is, so handing it a component that
          draws nothing left a band of blank space over the picture.
        */
        viewerOverlay.length > 0 ? (
          <ParamOverlayLine items={viewerOverlay} withLabels={grid.overlayLabels} />
        ) : undefined
      }
      footer={
        <div className="space-y-2">
          <ErrorNote>{error}</ErrorNote>

          {/* Scrolls sideways rather than wrapping — a two-line button row eats
              the bottom of the image on a small screen. */}
          {/*
            Rating is what copies the bytes onto this device, so it is the first
            thing offered — it is the difference between keeping an image and
            losing it when the instance is destroyed.
          */}
          {image && (
            <div className="flex items-center justify-between gap-3">
              <RatingStars value={image.rating} onChange={rate} size="sm" />
              <span className="text-[11px] text-muted">
                {image.archived
                  ? 'Stored on this device'
                  : image.rating > 0 || image.kept
                    ? 'Not copied locally'
                    : 'Rate or keep it to store a copy'}
              </span>
            </div>
          )}

          {/*
            Five columns of icon-led cells, two rows.

            Three columns of full-width buttons was flush at both edges and far
            too tall: ten actions became four rows of text that ate the bottom
            of the picture, which is the thing you opened. An icon with a small
            label underneath says the same in a fifth of the width, so
            everything stays reachable without a sheet and the image keeps the
            room.
          */}
          <div className="grid grid-cols-5 gap-1">
            <ViewerAction
              glyph={existingFavorite ? '★' : '☆'}
              // The label carries the state as well as the colour: "on or off"
              // has to survive being read rather than looked at.
              label={existingFavorite ? 'Favourited' : 'Favourite'}
              active={Boolean(existingFavorite)}
              busy={addFavorite.isPending || removeFavorite.isPending}
              onClick={favorite}
              title={
                existingFavorite
                  ? 'In Favourites — tap to remove'
                  : 'Keep this image and its settings in Favourites'
              }
            />
            <ViewerAction glyph="⤓" label="Save" onClick={share} />
            {/*
              Keeping is the promise a rating makes, without the judgement.
              With automatic cleanup switched on this is the difference between
              a picture surviving and not, and being made to award it stars
              first is a tax on saying "not sure yet, but don't bin it".
            */}
            <ViewerAction
              glyph="⌾"
              label={image?.kept ? 'Kept' : 'Keep'}
              active={Boolean(image?.kept)}
              busy={keepImage.isPending}
              onClick={() => {
                if (!image) return;
                keepImage.mutate(
                  { generationId: record.id, image, kept: !image.kept },
                  {
                    onError: (cause) =>
                      setError(cause instanceof Error ? cause.message : 'Could not keep that'),
                  },
                );
              }}
              title={
                image?.kept
                  ? 'Kept — the cleanup will leave it alone'
                  : 'Keep this picture without rating it'
              }
            />
            <ViewerAction
              glyph="⟳"
              label="Reseed"
              disabled={!workflowExists}
              onClick={() => rerun(true)}
              title={workflowExists ? 'Run again with a new seed' : 'That workflow has been deleted'}
            />
            <ViewerAction
              glyph="⇥"
              label="Reuse"
              disabled={!workflowExists}
              onClick={() => rerun(false)}
              title="Load these settings into the form"
            />
            <ViewerAction
              glyph="◨"
              label="img2img"
              busy={busy === 'img2img'}
              disabled={notAStill}
              title={notAStill ? 'img2img takes a still picture' : undefined}
              onClick={() => void sendTo('img2img')}
            />
            <ViewerAction
              glyph="⤢"
              label="Upscale"
              busy={busy === 'upscale'}
              disabled={notAStill}
              title={notAStill ? 'Upscaling takes a still picture' : undefined}
              onClick={() => void sendTo('upscale')}
            />
            <ViewerAction glyph="≡" label="Details" onClick={() => setShowDetails(true)} />
            {/* Which values are drawn over the picture. Its own choice, separate
                from the grid's — there is room for more here. */}
            <ParamOverlayPicker
              label="Values on the picture"
              caption="Values"
              records={entries.map((candidate) => candidate.record)}
              selected={grid.viewerParams}
              withLabels={grid.overlayLabels}
              onChange={(viewerParams) => onGridChange({ viewerParams })}
              onWithLabelsChange={(overlayLabels) => onGridChange({ overlayLabels })}
              // Shaped like the cells it shares a row with: glyph, then a word.
              className="h-auto w-full flex-col justify-center gap-0.5 rounded-lg px-1 py-1 shadow-md shadow-black/40"
            />
            {/* Two taps, because it cannot be undone. */}
            <ViewerAction
              glyph="⌫"
              label={confirmDelete ? 'Sure?' : 'Delete'}
              danger={confirmDelete}
              busy={deleteImage.isPending}
              onClick={() => {
                if (!confirmDelete) return setConfirmDelete(true);
                if (!image) return;
                deleteImage.mutate(
                  { generationId: record.id, image },
                  {
                    onSuccess: () => onClose(),
                    onError: (cause) =>
                      setError(cause instanceof Error ? cause.message : 'Could not delete that'),
                  },
                );
              }}
            />
          </div>

          <Sheet open={showDetails} onClose={() => setShowDetails(false)} title="Settings used" full>
            {/*
              A favourite's own things, where the rest of this picture's things
              already are.

              Favourites used to open a page of their own before the viewer:
              tapping one gave a sheet with the note, the rating and a preview,
              and the viewer was a tap further in. That page is gone — a
              favourite opens the same viewer as everything else, and swipes
              through the other favourites the way the gallery swipes through
              the gallery. What was genuinely only on that page is here.
            */}
            {existingFavorite && (
              <FavoriteNote
                favorite={existingFavorite}
                onShowInGallery={onShowInGallery ? () => onShowInGallery(entry) : undefined}
              />
            )}
            <DetailsList record={record} />
          </Sheet>
        </div>
      }
    />
  );
}

/**
 * What a favourite carries that a picture does not.
 *
 * The note is the whole of it: why you kept this one, in your words, months
 * after the prompt has stopped reminding you. Saved when the field loses focus
 * rather than on a button, because a note nobody remembers to save is a note
 * that gets lost — and the sheet closing takes the focus with it.
 */
function FavoriteNote({
  favorite,
  onShowInGallery,
}: {
  favorite: Favorite;
  onShowInGallery?: () => void;
}) {
  const update = useUpdateFavorite();
  const [note, setNote] = useState(favorite.note ?? '');
  const [storing, setStoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  return (
    <div className="mb-4 space-y-2">
      {/*
        The favourite's own rating, which is not the picture's.

        Two judgements that look alike and are not: the stars on the picture say
        "this came out well", these say "I want to make more of these". A
        technically perfect render of an idea that went nowhere earns five of
        one and none of the other, and the Favourites list sorts by this one.
      */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2">
        <span className="min-w-0 text-sm">
          Want more like this
          <span className="block text-[11px] text-muted">Sorts your favourites</span>
        </span>
        <RatingStars
          value={favorite.rating}
          size="sm"
          label="Want more like this"
          onChange={(rating) => update.mutate({ id: favorite.id, patch: { rating } })}
        />
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs tracking-wide text-muted uppercase">Your note</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => {
            if (note !== (favorite.note ?? '')) {
              update.mutate({ id: favorite.id, patch: { note: note.trim() || null } });
            }
          }}
          rows={2}
          placeholder="What you liked about it…"
          className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
      </label>

      {onShowInGallery && (
        <Button variant="secondary" className="w-full" onClick={onShowInGallery}>
          Show in the gallery
        </Button>
      )}

      {/* The copy that never happened, and the second chance at it. */}
      {!favorite.archived && (
        <>
          <p className="text-xs text-warn">
            This one is not stored on this device — it is still being read from ComfyUI, so it
            goes when that instance does.
          </p>
          <Button
            variant="secondary"
            className="w-full"
            busy={storing}
            onClick={async () => {
              setError(null);
              setStoring(true);
              try {
                await api.archiveFavorite(favorite.id);
                await queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not fetch it');
              } finally {
                setStoring(false);
              }
            }}
          >
            Store a copy here now
          </Button>
        </>
      )}

      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}

function DetailsList({ record }: { record: GenerationRecord }) {
  const entries = Object.entries(record.values).filter(
    ([, value]) => value !== null && value !== '',
  );

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs tracking-wide text-muted uppercase">Prompt</p>
        <p className="mt-1 text-sm break-words">{record.title}</p>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Detail label="Workflow" value={record.workflowName} />
        <Detail label="Status" value={record.status} />
        <Detail label="Created" value={new Date(record.createdAt).toLocaleString()} />
        {record.completedAt && (
          <Detail
            label="Took"
            value={`${Math.round((record.completedAt - record.createdAt) / 100) / 10}s`}
          />
        )}
      </div>

      {record.error && <ErrorNote>{record.error}</ErrorNote>}

      {/*
        Whatever the graph printed, one line each until you open it.

        A workflow can print several things — a rewritten prompt, a caption, the
        reasoning that produced either — and a node titled `rewrite prompt
        [thinking]` says which is which. Shown the same way as the parameters,
        because that is what they are: something the run decided, which you
        occasionally want to read in full and usually only want to know exists.
      */}
      {record.texts.length > 0 && (
        <div>
          <p className="mb-2 text-xs tracking-wide text-muted uppercase">What the graph printed</p>
          <dl className="space-y-1.5 text-xs">
            {record.texts.map((output, index) => (
              <DetailRow
                key={`${output.nodeId}-${index}`}
                name={textOutputLabel(output.nodeTitle)}
                value={output.text}
              />
            ))}
          </dl>
        </div>
      )}

      <div>
        <p className="mb-2 text-xs tracking-wide text-muted uppercase">All parameters</p>
        <dl className="space-y-1.5 text-xs">
          {entries.map(([id, value]) => (
            <DetailRow key={id} name={id} value={String(value)} />
          ))}
        </dl>
      </div>
    </div>
  );
}

/**
 * One action in the viewer's footer: a glyph with a small label under it.
 *
 * Ten actions belong on that screen and none of them is worth a row of its own
 * — the picture is what the screen is for. A 44px cell is still a comfortable
 * target, and the label means the glyph never has to be guessed at.
 */
function ViewerAction({
  glyph,
  label,
  onClick,
  active = false,
  danger = false,
  disabled = false,
  busy = false,
  title,
}: {
  glyph: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-pressed={active}
      aria-label={label}
      title={title}
      className={cn(
        // The shadow does what the bar behind these used to: separates them
        // from whatever part of the picture they happen to be sitting on.
        'flex flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 shadow-md shadow-black/40 disabled:opacity-40',
        danger
          ? 'bg-danger/20 text-danger'
          : active
            ? 'bg-accent/20 text-accent'
            : 'bg-surface text-body active:bg-surface-2',
      )}
    >
      <span aria-hidden className="text-base leading-none">
        {busy ? <Spinner className="size-4" /> : glyph}
      </span>
      <span className="w-full truncate text-center text-[9px] leading-none text-muted">
        {label}
      </span>
    </button>
  );
}

/**
 * One parameter, cut to a line until you tap it.
 *
 * A prompt is the value people most often want to read here and the one least
 * likely to fit, so truncating it permanently hides exactly what the list is
 * for. Tapping opens the whole thing; tapping again puts it back, so a long
 * value does not push everything below it off the screen for good.
 */
function DetailRow({ name, value }: { name: string; value: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-line/50 pb-1.5">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <dt className="shrink-0 text-muted">{name}</dt>
        <dd
          className={cn(
            'min-w-0 text-right',
            open ? 'break-words [overflow-wrap:anywhere]' : 'truncate',
          )}
        >
          {value}
        </dd>
      </button>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="truncate">{value}</p>
    </div>
  );
}
