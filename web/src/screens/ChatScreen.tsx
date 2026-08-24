import { useEffect, useMemo, useRef, useState } from 'react';

import { CHAT_IMAGE_SIZES } from '@latent/shared';
import type { ChatMessage, ChatToolCall } from '@latent/shared';

import { api } from '../api/client';
import { useGeneration, useGenerations, useSettings, useUpdateSettings } from '../api/queries';
import { Still, Thumb, type ViewerEntry } from '../components/ImageViewer';
import { RunProgress } from '../components/LiveBar';
import { ViewerWithActions } from '../components/ViewerWithActions';
import { Markdown } from '../components/Markdown';
import { PromptDiff, promptChanged } from '../components/PromptDiff';
import { BlurButton } from '../components/BlurButton';
import { TasteSheet } from '../components/TasteSheet';
import { ToolDialog } from '../components/ToolDialog';
import {
  Button,
  cn,
  CONTROL_FACE,
  CONTROL_FACE_SET,
  ErrorNote,
  Sheet,
  Spinner,
} from '../components/ui';
import { useChatStore } from '../state/chat';
import { useGridSettings } from '../state/grid';
import { useWide } from '../state/layout';

/**
 * Talking to a local model about what to make.
 *
 * The chat is not a side feature: describing a picture is a conversation, and
 * thinking up prompt fragments by hand is the slowest part of using this app.
 * What makes it more than a text box is the tools — the model proposes blocks
 * or a finished prompt, and the proposal arrives as something you accept,
 * correct or throw away rather than as text you have to copy somewhere.
 *
 * Nothing a tool proposes takes effect on its own. Every one of them is a
 * dialog first.
 *
 * The conversation itself is in `state/chat`. See the note in `ChatScreen`.
 */

/** Longest side an attachment is scaled to before it is sent. */
const MAX_IMAGE_SIDE = 1024;

/**
 * The prompt generated before this message, if there was one.
 *
 * Each picture is marked against the one before *it*, not against the newest —
 * scrolling back through a conversation should show the change that was made at
 * the time, which is the only version of that comparison worth anything.
 */
/**
 * The proposal a tool message came out of, when it was a wandering one.
 *
 * A wandering round is two messages: the assistant's `build_prompt` call, and
 * the tool message carrying the run it started. The picture hangs off the
 * second and the prompt off the first, so tapping the picture has to reach back
 * one message to find what made it. Only for wandering rounds — everywhere else
 * a picture opens the viewer, which is what a picture should do.
 */
function wanderCallBefore(
  messages: ChatMessage[],
  id: string,
): { messageId: string; call: ChatToolCall } | null {
  const at = messages.findIndex((message) => message.id === id);
  if (at < 0) return null;
  for (let index = at - 1; index >= 0; index -= 1) {
    const earlier = messages[index]!;
    const call = earlier.toolCall;
    if (!call) continue;
    return call.tool === 'build_prompt' && call.fromWander
      ? { messageId: earlier.id, call }
      : null;
  }
  return null;
}

/** What identifies one picture across the conversation's whole list. */
function pictureKey(recordId: string, image: { subfolder: string; filename: string }): string {
  return `${recordId}/${image.subfolder}/${image.filename}`;
}

function promptBefore(messages: ChatMessage[], id: string): string {
  const at = messages.findIndex((message) => message.id === id);
  if (at < 0) return '';
  for (let index = at - 1; index >= 0; index -= 1) {
    const earlier = messages[index]!.prompt;
    if (earlier) return earlier;
  }
  return '';
}

/** What a resolved tool call is called once it is only a line in the history. */
const TOOL_LABELS: Record<ChatToolCall['tool'], string> = {
  build_prompt: 'Proposed a prompt',
  revise_prompt: 'Proposed a rewrite',
  prompt_blocks: 'Proposed blocks',
  ask_user: 'Asked something',
};

/**
 * The same, but honest about what a block proposal actually did.
 *
 * "Proposed blocks" for a call whose every row deletes one reads as the
 * opposite of what happened, and the line in the transcript is often the only
 * trace left once the dialog has been answered.
 */
function toolLabel(call: ChatToolCall): string {
  if (call.tool !== 'prompt_blocks') return TOOL_LABELS[call.tool];
  const actions = new Set(call.blocks.map((block) => block.action));
  if (actions.size !== 1) return 'Proposed block changes';
  if (actions.has('remove')) return 'Proposed removing blocks';
  if (actions.has('update')) return 'Proposed changing blocks';
  return 'Proposed blocks';
}

export function ChatScreen() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();

  /*
   * The conversation itself lives in `state/chat`, not here.
   *
   * This screen is unmounted every time another tab is touched, and holding the
   * transcript, the reply in flight and a half-decided tool dialog in component
   * state meant a tap on Gallery destroyed all three — and that coming back
   * re-opened the conversation from scratch, racing whatever was left. What
   * stays here is what is genuinely about the screen: where it is scrolled, and
   * which sheets are open.
   */
  const chat = useChatStore((state) => state.chat);
  const streaming = useChatStore((state) => state.streaming);
  const pendingCall = useChatStore((state) => state.pendingCall);
  const draft = useChatStore((state) => state.draft);
  const attachments = useChatStore((state) => state.attachments);
  const error = useChatStore((state) => state.error);
  const callMinimized = useChatStore((state) => state.callMinimized);
  /*
   * What the conversation is doing, as one thing the server decided.
   *
   * These used to be seven separate flags kept in step by hand on this side —
   * whether a run was going, how many rounds it had done, whether it had
   * quietly stopped, what it was waiting on. Keeping them right meant the
   * screen had to reason about the loop, and a screen that had been asleep
   * reasoned from stale premises. Now it reads.
   */
  const run = useChatStore((state) => state.run);
  const store = useChatStore.getState;

  const autonomous = settings.data?.chat.autonomous;
  const wandering = run.mode === 'wander';
  /** A prompt has been asked for by name and nothing has come back yet. */
  const asking = run.phase === 'thinking' && (run.want === 'prompt' || run.want === 'freshPrompt');
  /** The render the follow-up turn is waiting on, so it can be said out loud. */
  const waitingFor = run.phase === 'generating' ? run.generationId : null;

  /*
   * Every picture in the conversation, in the order it was made.
   *
   * The viewer opens over this rather than over the one run you tapped: these
   * are the last things generated, one after another, which is exactly the list
   * a swipe should move through — and it is what the gallery does with the
   * gallery. A wandering run makes that the whole point, since it *is* a column
   * of one picture after another.
   */
  const runIds = useMemo(
    () =>
      (chat?.messages ?? [])
        .map((message) => message.generationId)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    [chat?.messages],
  );
  const runs = useGenerations(runIds);
  const viewerEntries = useMemo<ViewerEntry[]>(
    () =>
      runs.flatMap(({ data: record }) =>
        record ? record.images.map((image) => ({ record, image })) : [],
      ),
    [runs],
  );
  const [viewing, setViewing] = useState<string | null>(null);
  const [grid, updateGrid] = useGridSettings();
  const wide = useWide();
  const viewerIndex = viewing
    ? viewerEntries.findIndex((entry) => pictureKey(entry.record.id, entry.image) === viewing)
    : -1;

  /** A prompt from further up, reopened to run again or to rewind to. */
  const [revisiting, setRevisiting] = useState<{
    messageId: string;
    call: ChatToolCall;
  } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showTaste, setShowTaste] = useState(false);
  /** Whether the prompt button's two options are showing. */
  const [choosing, setChoosing] = useState(false);
  /** Set while the transcript is at the end, which is when it follows a reply. */
  const [atBottom, setAtBottom] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  /*
   * Sized as a share of the transcript's width, on a fixed scale.
   *
   * It used to be a share of the *height*, which was wrong twice over: the
   * chat window's height changes when the keyboard opens, so one setting meant
   * two sizes; and the measurement ran before the transcript existed, so it
   * fell through to the 80-pixel floor and every picture came out as a stamp.
   * Width is stable, and a percentage of it needs no measuring at all.
   */
  const pictureWidth =
    CHAT_IMAGE_SIZES[
      Math.min(Math.max(settings.data?.chat.imageSize ?? 3, 1), CHAT_IMAGE_SIZES.length) - 1
    ] ?? 0.7;

  // Idempotent: opens what was last in use, or starts one, and does nothing at
  // all on the many mounts after the first. Nothing is aborted on the way out —
  // that is the point.
  useEffect(() => {
    void store().open();
  }, [store]);

  /*
   * Catch up after being away.
   *
   * A backgrounded tab is not a running one: a phone suspends the connection
   * when the screen locks, and a stream killed mid-reply leaves this client
   * holding a transcript the server has since moved past. Re-reading on the way
   * back in is cheap, and it is what makes "it stopped showing messages"
   * impossible.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !useChatStore.getState().streaming) {
        void store().refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [store]);

  /*
   * Follow the reply as it arrives — until you scroll away from the bottom.
   *
   * Following unconditionally is what made the transcript feel like it was
   * fighting you: every token dragged the view back down, so reading anything
   * further up, or reading the thinking as it streams, was impossible. A chat
   * should follow when you are at the bottom and hold still when you are not,
   * which is what every messaging app does and what the `atBottom` flag is.
   */
  useEffect(() => {
    if (!atBottom) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [atBottom, chat?.messages.length, streaming?.content, streaming?.thinking]);

  /**
   * The last prompt this conversation actually generated with.
   *
   * What the next one is marked against. Taken from the transcript rather than
   * from the gallery so it is right even after a run has been swept, and so
   * the marking works the moment the dialog opens.
   */
  const previousPrompt =
    [...(chat?.messages ?? [])].reverse().find((message) => message.prompt)?.prompt ?? '';

  /** Whether the transcript is scrolled to (or near) the end. */
  const onTranscriptScroll = () => {
    const element = transcriptRef.current;
    if (!element) return;
    // A few pixels of slack: sub-pixel layout means an element scrolled all the
    // way down is rarely exactly at its maximum.
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(distance < 40);
  };

  const attach = async (files: FileList) => {
    store().setError(null);
    for (const file of [...files].slice(0, 4)) {
      try {
        store().setAttachments((current) => [...current, { dataUrl: '', name: file.name }]);
        const dataUrl = await downscale(file);
        store().setAttachments((current) =>
          current.map((entry) =>
            entry.name === file.name && entry.dataUrl === '' ? { ...entry, dataUrl } : entry,
          ),
        );
      } catch {
        store().setAttachments((current) => current.filter((entry) => entry.name !== file.name));
        store().setError(`${file.name} could not be read as an image.`);
      }
    }
  };

  /**
   * Switch the mode, and switch on the thing it depends on.
   *
   * The loop's exit condition *is* the review: the model is shown the render,
   * marks it against the prompt, and proposes a rewrite while it falls short.
   * With the review off there is nothing to end a run, so turning this on with
   * it off would be a switch that quietly does nothing — the honest reading of
   * "carry on until it is good enough" is that you want the check on too.
   */
  const toggleAutonomous = async () => {
    const chatSettings = settings.data?.chat;
    if (!chatSettings) return;
    const enabled = !chatSettings.autonomous.enabled;

    await updateSettings.mutateAsync({
      chat: {
        ...chatSettings,
        autonomous: { ...chatSettings.autonomous, enabled },
        ...(enabled && !chatSettings.review.enabled
          ? { review: { ...chatSettings.review, enabled: true } }
          : {}),
      },
    });
  };

  const startNew = async () => {
    await store().startNew();
    setShowHistory(false);
  };

  if (!chat) {
    return (
      <div className="grid h-full place-items-center">
        {error ? <ErrorNote>{error}</ErrorNote> : <Spinner className="size-6 text-muted" />}
      </div>
    );
  }

  return (
    /*
      The whole screen, and the transcript takes all of it that is not the
      composer. A chat is the one place where more text on screen is simply
      better, so nothing else competes for the height.
    */
    <div className="flex h-full min-h-0">
      {/*
        The conversation itself, in a column that stops widening once the lines
        are long enough to read.

        A tablet's full width is about a hundred and forty characters a line,
        which is roughly twice what anyone reads comfortably — the eye loses the
        start of the next line on the way back. Capping it is not leaving the
        space unused; on a wide screen the space goes to the pictures beside it,
        and on a narrower one an even margin is what a page looks like.
      */}
      <div className="safe-t flex min-h-0 min-w-0 flex-1 flex-col tablet:mx-auto tablet:w-full tablet:max-w-[46rem]">
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-2 pb-1">
        <h1 className="min-w-0 truncate text-base font-semibold">{chat.title || 'Chat'}</h1>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            aria-label="Saved chats"
            className={cn('grid size-9 place-items-center rounded-full text-base', CONTROL_FACE)}
          >
            ≡
          </button>
          {/*
            Off wandering: picture after picture, out of your own notes.

            Beside the other two mode buttons because it is the third answer to
            "what now" — the chat list is what you were doing, the ♥ is what you
            like, and this is being shown things made out of it without deciding
            anything.
          */}
          <button
            type="button"
            aria-pressed={wandering}
            // Not "…what you like": the ♥ beside it is called that, and two
            // controls whose names contain one another are two controls nothing
            // reading the screen aloud can tell apart.
            aria-label="Wander through your notes"
            onClick={() => (wandering ? store().stopWander() : void store().startWander())}
            className={cn(
              'grid size-9 place-items-center rounded-full text-base',
              wandering ? CONTROL_FACE_SET : CONTROL_FACE,
            )}
          >
            ❋
          </button>
          {/*
            Left to get on with it.

            A mode rather than a button that does something: while it is on, the
            model's own prompts and rewrites are accepted for you and the next
            render starts, until one clears the perfectionism threshold. Up here
            with the other two because it is a thing about this conversation,
            and because switching it on for one picture and off again should not
            be a trip to Settings.
          */}
          <button
            type="button"
            aria-pressed={autonomous?.enabled === true}
            aria-label="Carry on by itself"
            onClick={() => void toggleAutonomous()}
            className={cn(
              'grid size-9 place-items-center rounded-full text-base',
              autonomous?.enabled ? CONTROL_FACE_SET : CONTROL_FACE,
            )}
          >
            ∞
          </button>
          {/*
            Next to the chat list, because it belongs to the same question.

            The list is "what have I been working on"; this is "what do I like"
            — both are things you reach for when the composer is empty and you
            do not know what to type. A heart rather than a cog: it is not a
            setting, it is a description of you.
          */}
          <button
            type="button"
            onClick={() => setShowTaste(true)}
            aria-label="What you like"
            className={cn('grid size-9 place-items-center rounded-full text-base', CONTROL_FACE)}
          >
            ♥
          </button>
          <button
            type="button"
            onClick={() => void startNew()}
            aria-label="New chat"
            className={cn('grid size-9 place-items-center rounded-full text-base', CONTROL_FACE)}
          >
            ＋
          </button>
          {/* Last, as everywhere: see `BlurButton`. The chat shows pictures
              like any other screen, and this is the corner your thumb knows. */}
          <BlurButton />
        </div>
      </div>

      {/*
        Blurred while a tool dialog is up. The dialog is a decision about
        something in this transcript, so the transcript stays visible — just
        plainly not the thing being interacted with.
      */}
      <div
        ref={transcriptRef}
        data-testid="chat-transcript"
        onScroll={onTranscriptScroll}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2',
          pendingCall && !callMinimized && 'pointer-events-none blur-sm',
        )}
      >
        {chat.messages.length === 0 && !streaming && (
          <div className="py-10 text-center text-sm text-muted">
            <p>Ask for prompt ideas, or describe what you want and ask for a prompt.</p>
            <p className="mt-2 text-xs">
              Anything it proposes — blocks, a finished prompt — arrives as something to accept or
              throw away.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {chat.messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              pictureWidth={pictureWidth}
              previousPrompt={promptBefore(chat.messages, message.id)}
              showDiff={settings.data?.chat.showDiff.underPicture ?? true}
              onRevisit={(call) => setRevisiting({ messageId: message.id, call })}
              wanderCall={wanderCallBefore(chat.messages, message.id)}
              onOpenPrompt={(found) => setRevisiting(found)}
              onOpenPicture={setViewing}
            />
          ))}

          {/*
            Said plainly, because otherwise this looks like the chat has
            stopped answering. It has not — it is waiting for the picture it
            was asked about, and anything it said before that landed would be
            about something nobody has seen.
          */}
          {waitingFor && !streaming && (
            <div className="flex items-center gap-2 py-1 text-xs text-muted">
              <Spinner className="size-3" />
              <span>Rendering — the reply comes once the picture is done.</span>
            </div>
          )}

          {streaming && (
            <div className="space-y-1">
              {streaming.thinking !== '' && (
                <ThinkingBlock text={streaming.thinking} live={streaming.content === ''} />
              )}
              {/* Rendered as it arrives, so the reply does not reflow into
                  something different the moment it finishes. */}
              <div className="relative">
                <Markdown text={streaming.content} />
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/*
        What was put aside, and the way back to it.

        Pinned to the composer rather than left in the transcript: the point of
        folding the dialog away is to go and look at something, and a marker
        that scrolls out of sight with everything else is not a way back.
      */}
      {pendingCall && callMinimized && (
        <button
          type="button"
          onClick={() => store().restoreCall()}
          className="mx-3 mb-1 flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-left text-xs text-accent active:bg-accent/20"
        >
          <span aria-hidden>◳</span>
          <span className="min-w-0 flex-1 truncate">
            {toolLabel(pendingCall.call)} — waiting on you
          </span>
          <span className="shrink-0 font-medium underline">Open</span>
        </button>
      )}

      {/*
        What a wandering run is up to, and the way out of it.

        The count is the whole of the status: nothing else about this mode is
        worth a line of text, and a run with no visible end needs a visible
        stop.
      */}
      {wandering && (
        <div
          data-testid="wander-strip"
          className="mx-3 mb-1 flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent"
        >
          <Spinner className="size-3" />
          <span className="min-w-0 flex-1">
            {run.note ??
              (run.round === 0
                ? 'Wandering through what you like…'
                : `Wandering — ${run.round} so far`)}
          </span>
          <button
            type="button"
            onClick={() => store().stopWander()}
            className="shrink-0 font-medium underline"
          >
            Stop
          </button>
        </div>
      )}

      {/*
        What the autonomous run is doing, and the way out of it.

        Only while the mode is on. A run is invisible otherwise — pictures
        appear and prompts get accepted with nobody having tapped anything —
        and "how many more of these are coming" is the one question watching it
        raises. Stop halts this run; the mode itself stays on for the next thing
        you say, which is what the ∞ button and Settings are for.
      */}
      {autonomous?.enabled && (
        <div
          data-testid="autonomous-strip"
          className="mx-3 mb-1 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-muted"
        >
          <span aria-hidden>∞</span>
          <span className="min-w-0 flex-1">
            {run.note ??
              (run.round === 0
                ? 'Carrying on by itself, until a picture clears the mark.'
                : `Round ${run.round} of ${autonomous.maxRounds} — carrying on until it clears the mark.`)}
          </span>
          {/* Only while there is something to stop. A run that has already
              said why it finished does not need a button that repeats it. */}
          {run.phase !== 'idle' && (
            <button
              type="button"
              onClick={() => void store().stop()}
              className="shrink-0 font-medium text-accent underline"
            >
              Stop
            </button>
          )}
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 border-t border-line bg-ink px-3 pt-2 pb-2">
        {attachments.length > 0 && (
          <div className="mb-2 flex gap-2 overflow-x-auto">
            {attachments.map((attachment, index) => (
              <div key={`${attachment.name}-${index}`} className="relative shrink-0">
                {attachment.dataUrl ? (
                  <img
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="size-14 rounded-lg object-cover"
                  />
                ) : (
                  <div className="grid size-14 place-items-center rounded-lg bg-surface-2">
                    <Spinner className="size-4 text-muted" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() =>
                    store().setAttachments((current) => current.filter((_, at) => at !== index))
                  }
                  aria-label={`Remove ${attachment.name}`}
                  className="absolute -top-1 -right-1 grid size-5 place-items-center rounded-full bg-ink text-xs text-muted"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach an image"
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-lg text-muted active:bg-surface-3"
          >
            ＋
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) void attach(event.target.files);
              event.target.value = '';
            }}
          />

          <textarea
            value={draft}
            onChange={(event) => store().setDraft(event.target.value)}
            rows={1}
            placeholder="Say something…"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-line bg-surface px-3 py-2 text-sm leading-relaxed focus:border-accent focus:outline-none"
          />

          {/* Ask for a prompt without saying so. What it does with the answer
              — queue it, or show it first — is the setting beside it. */}
          {(!streaming || asking) && (
            <div className="relative shrink-0">
              {/*
                Two ways to press it, in the space of one button.

                The second exists for a conversation that has converged: every
                prompt is the last one with two words moved, because the last
                one is right there in the history being treated as the thing to
                improve. Icons only, and only while the choice is open — a
                permanent second button would be a permanent question, and the
                answer is the first one nearly every time.
              */}
              {/*
                Anywhere else closes it.

                A popover with no way out but the button that opened it is a
                trap on a touch screen, where "click outside" is the gesture
                everybody tries first.
              */}
              {choosing && (
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setChoosing(false)}
                  role="presentation"
                />
              )}
              {choosing && (
                <div className="absolute right-0 bottom-12 z-20 flex gap-1 rounded-xl border border-line bg-surface-2 p-1 shadow-lg shadow-black/40">
                  <button
                    type="button"
                    aria-label="Generate now"
                    title="Build a prompt from this conversation and generate it"
                    onClick={() => {
                      setChoosing(false);
                      void store().askForPrompt();
                    }}
                    className="grid size-9 place-items-center rounded-lg text-base active:bg-surface-3"
                  >
                    ✦
                  </button>
                  <button
                    type="button"
                    aria-label="Fresh prompt, then generate"
                    title="Throw the current prompt away, compose a different one and generate it"
                    onClick={() => {
                      setChoosing(false);
                      void store().askForPrompt({ fresh: true, instant: true });
                    }}
                    className="grid size-9 place-items-center rounded-lg text-base text-accent active:bg-surface-3"
                  >
                    ⟳
                  </button>
                </div>
              )}
              {/*
                Feedback the moment it is pressed, and until it has an answer.

                Three things were wrong with the version that only set `busy`.
                The button was hidden the instant the reply began streaming, so
                the state it was meant to show lasted a few hundred milliseconds
                and then the button vanished — which reads as a tap that missed,
                and people press it again. `busy` also put a spinner *beside*
                the glyph in a forty-pixel square, where there is room for one
                of the two. And nothing at all happened on the press itself,
                which on a phone is the only feedback that arrives instantly:
                the press is a transform, so it does not wait for a network
                round trip to be visible.
              */}
              <Button
                variant="secondary"
                className={cn(
                  'size-10 shrink-0 rounded-xl p-0 text-base transition-transform active:scale-90',
                  (asking || choosing) && 'scale-95 text-accent',
                )}
                disabled={asking}
                onClick={() => setChoosing(!choosing)}
                aria-label="Build a prompt"
                aria-expanded={choosing}
                aria-busy={asking}
                title="Build a prompt from this conversation"
              >
                {asking ? <Spinner className="size-4" /> : '✦'}
              </Button>
            </div>
          )}

          {/* Stop sits beside Send rather than replacing it: replacing it makes
              the one button mean two things, and the moment you want to stop is
              the moment you are already reaching for that corner. */}
          {streaming && (
            <Button
              variant="secondary"
              className="size-10 shrink-0 rounded-xl p-0 text-base"
              onClick={() => void store().stop()}
              aria-label="Stop"
            >
              ■
            </Button>
          )}

          <Button
            variant="primary"
            className="size-10 shrink-0 rounded-xl p-0"
            onClick={() => void store().send()}
            /*
              Not while the model is mid-sentence.

              Sending then would interleave two turns, and the second would be
              answering a conversation the first has not finished writing.
              Waiting on a render is different — that is a good moment to
              change your mind, and taking over is what the composer is for.
            */
            disabled={
              run.phase === 'thinking' || (draft.trim() === '' && attachments.length === 0)
            }
            aria-label="Send"
          >
            {streaming ? <Spinner className="size-4" /> : '↑'}
          </Button>
        </div>
      </div>
      </div>

      {/*
        Every picture this conversation has made, down the side.

        The transcript is the reasoning and this is the result, and on a phone
        you can only ever have one of them: the pictures are strung out through
        several screens of text, so comparing the last four means scrolling past
        what was said about them. Here they are a contact sheet that stays put
        while the conversation moves.

        It earns its width most in a wandering run, which is nothing but a
        column of pictures with a few words between them — the transcript is the
        wrong shape for that, and this is the right one.
      */}
      {wide && (
        <ConversationPictures
          entries={viewerEntries}
          onOpen={(entry) => setViewing(pictureKey(entry.record.id, entry.image))}
        />
      )}

      {pendingCall && !callMinimized && (
        <ToolDialog
          call={pendingCall.call}
          onMinimize={() => store().minimizeCall()}
          settings={settings.data ?? null}
          previousPrompt={previousPrompt}
          /*
            A wandering run has a workflow of its own — often the fast one,
            since it is going to run all evening.
          */
          workflowId={
            pendingCall.call.tool === 'build_prompt' && pendingCall.call.fromWander
              ? settings.data?.chat.wander.workflowId || undefined
              : undefined
          }
          onResolve={(body) => store().resolveTool(body)}
        />
      )}

      {revisiting && (
        <ToolDialog
          call={revisiting.call}
          settings={settings.data ?? null}
          previousPrompt={previousPrompt}
          onResolve={() => setRevisiting(null)}
          revisit={{
            onClose: () => setRevisiting(null),
            onRerun: async (prompt, workflowId) => {
              const { messageId } = revisiting;
              setRevisiting(null);
              try {
                // The server queues it and writes the note, in one act — the
                // dialog no longer starts renders of its own.
                await api.rerunPrompt(chat.id, {
                  messageId,
                  prompt,
                  ...(workflowId ? { workflowId } : {}),
                });
                await store().refresh();
              } catch (cause) {
                store().setError(cause instanceof Error ? cause.message : 'Could not record that');
              }
            },
            onRewind: async () => {
              const { messageId } = revisiting;
              setRevisiting(null);
              try {
                await api.rewindChat(chat.id, messageId);
                await store().refresh();
              } catch (cause) {
                store().setError(cause instanceof Error ? cause.message : 'Could not rewind');
              }
            },
          }}
        />
      )}

      {/*
        The gallery's viewer, over the whole conversation.

        A picture is a picture whichever list you came in by, and here the list
        is the conversation: these are the last things generated, one after
        another, so a swipe moves to the one before it rather than being trapped
        in the batch you happened to tap. That matters most while wandering,
        where the conversation *is* a column of pictures.
      */}
      {viewerIndex >= 0 && (
        <ViewerWithActions
          entries={viewerEntries}
          index={viewerIndex}
          grid={grid}
          onGridChange={updateGrid}
          onIndexChange={(next) => {
            const entry = viewerEntries[next];
            if (entry) setViewing(pictureKey(entry.record.id, entry.image));
          }}
          onClose={() => setViewing(null)}
        />
      )}

      <TasteSheet open={showTaste} onClose={() => setShowTaste(false)} />

      <Sheet open={showHistory} onClose={() => setShowHistory(false)} title="Saved chats">
        <SavedChats
          currentId={chat.id}
          onOpen={async (id) => {
            await store().openChat(id);
            setShowHistory(false);
          }}
          onNew={() => void startNew()}
        />
      </Sheet>
    </div>
  );
}

/**
 * The conversation's output as a contact sheet, beside the conversation.
 *
 * Two columns rather than one: a strip of single thumbnails down a 17-rem
 * column wastes half of it on margins, and two side by side is the smallest
 * number that lets you actually compare one attempt with the next — which is
 * what the panel is for.
 *
 * It follows the newest picture the way the transcript follows the newest
 * message, and for the same reason: both are logs, and the end is where the
 * thing you are waiting for appears.
 */
function ConversationPictures({
  entries,
  onOpen,
}: {
  entries: ViewerEntry[];
  onOpen: (entry: ViewerEntry) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = entries.length;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  return (
    <aside
      data-testid="chat-pictures"
      aria-label="Pictures from this conversation"
      className="safe-t flex w-[17rem] shrink-0 flex-col border-l border-line bg-surface/30"
    >
      <div className="flex shrink-0 items-baseline gap-2 px-3 pt-3 pb-2">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Made here</h2>
        {count > 0 && <span className="text-xs text-muted tabular-nums">{count}</span>}
      </div>

      {count === 0 ? (
        <p className="px-3 text-xs leading-relaxed text-muted">
          Nothing yet. Every picture this conversation makes collects here, in
          the order it was made.
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
          <div className="grid grid-cols-2 gap-2">
            {entries.map((entry, index) => (
              <Thumb
                key={pictureKey(entry.record.id, entry.image)}
                image={entry.image}
                alt={entry.record.title}
                /*
                  Numbered, because that is what identifies one here: the
                  titles in a wandering run are all variations on the same
                  sentence, and position is how you would point at it. Not
                  "Open picture N" — the transcript already calls its own
                  pictures that, and two controls with the same name are two
                  nothing reading the screen aloud can tell apart.
                */
                label={`Picture ${index + 1} in this conversation`}
                onClick={() => onOpen(entry)}
                className="aspect-square w-full"
              />
            ))}
          </div>
          <div ref={endRef} />
        </div>
      )}
    </aside>
  );
}

function MessageRow({
  message,
  pictureWidth,
  previousPrompt,
  showDiff,
  onRevisit,
  wanderCall,
  onOpenPrompt,
  onOpenPicture,
}: {
  message: ChatMessage;
  pictureWidth: number;
  /** The prompt generated before this one, for marking what changed. */
  previousPrompt: string;
  showDiff: boolean;
  onRevisit: (call: ChatToolCall) => void;
  /** Set when this run came out of a wandering round; see `wanderCallBefore`. */
  wanderCall: { messageId: string; call: ChatToolCall } | null;
  onOpenPrompt: (found: { messageId: string; call: ChatToolCall }) => void;
  /** Opens the viewer over every picture in the conversation, at this one. */
  onOpenPicture: (key: string) => void;
}) {
  if (message.role === 'tool' || message.role === 'note') {
    return (
      <div className="space-y-1.5">
        {/*
          A wandering run is a column of pictures and nothing else.

          "The user accepted the prompt and queued it" is true, useful to the
          model, and noise on the screen — nobody accepted anything, and a line
          of it between every picture turns a stream into a transcript of
          itself. The words still go to the model; they just stop being shown.
        */}
        {!wanderCall && <p className="text-center text-[11px] text-muted">{message.content}</p>}
        {message.generationId && (
          <GeneratedRun
            id={message.generationId}
            width={pictureWidth}
            prompt={message.prompt ?? ''}
            previousPrompt={previousPrompt}
            showDiff={showDiff}
            onOpen={onOpenPicture}
            /*
              In a wandering run the prompt was never read, so "what was that
              one?" is the question the picture raises — and the answer is a
              corner button, because tapping the picture itself opens the
              viewer, here as everywhere else in the app.
            */
            onOpenPrompt={wanderCall ? () => onOpenPrompt(wanderCall) : undefined}
          />
        )}
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-1.5">
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {message.attachments.map((attachment, index) => (
                <img
                  key={`${attachment.name}-${index}`}
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="size-20 rounded-lg object-cover"
                />
              ))}
            </div>
          )}
          {message.content !== '' && (
            <p className="rounded-2xl rounded-br-md bg-accent/15 px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap">
              {message.content}
            </p>
          )}
        </div>
      </div>
    );
  }

  const call = message.toolCall;
  /*
    A prompt stays reachable for the rest of the conversation.

    Wanting the same picture with one thing changed is the commonest thing
    there is, and the alternative was a trip to the gallery to find the result
    and press reuse — which loses the conversation the prompt came out of. Only
    prompts: a decided question or a saved block has nothing left to do. A
    rewrite is a prompt like any other — often the better one, since it was
    written knowing what the last attempt produced.
  */
  const reusable =
    call?.tool === 'build_prompt' || call?.tool === 'revise_prompt' ? message.toolResult : null;
  /*
    Except in a wandering round, where the picture is directly below this and
    opens the same dialog — the row would be a second door to a room you are
    already standing in.
  */
  const quiet = call?.tool === 'build_prompt' && call.fromWander === true;

  return (
    <div className="space-y-1">
      {message.thinking && <ThinkingBlock text={message.thinking} />}
      {message.content !== '' && <Markdown text={message.content} />}
      {call &&
        !quiet &&
        (reusable ? (
          <button
            type="button"
            onClick={() => onRevisit(call)}
            className="flex w-full items-center gap-1.5 rounded-lg bg-surface-2/60 px-2 py-1.5 text-left text-[11px] text-muted active:bg-surface-2"
          >
            <span aria-hidden className="text-accent">
              ✦
            </span>
            <span className="min-w-0 flex-1 truncate">
              {call.tool === 'build_prompt' || call.tool === 'revise_prompt' ? call.prompt : ''}
            </span>
            <span className="shrink-0 text-accent">Again</span>
          </button>
        ) : (
          <p className="text-[11px] text-muted">
            {toolLabel(call)}
            {message.toolResult
              ? ` · ${message.toolResult.decision === 'accepted' ? 'accepted' : 'declined'}`
              : ' · waiting'}
          </p>
        ))}
    </div>
  );
}

/**
 * The pictures a prompt accepted here produced, in the conversation.
 *
 * They belong at the point they were asked for. Sending you to the Generate
 * screen to look at them — which is what used to happen — threw away the thread
 * of the conversation at exactly the moment it had paid off, and coming back
 * meant scrolling to find where you were.
 *
 * Sized against the chat window rather than to a fixed number of pixels, and
 * tapping one opens the full viewer: pinch to zoom, drag to move, tap again to
 * put it away.
 */
function GeneratedRun({
  id,
  width,
  prompt,
  previousPrompt,
  showDiff,
  onOpen,
  onOpenPrompt,
}: {
  id: string;
  width: number;
  prompt: string;
  previousPrompt: string;
  showDiff: boolean;
  /** Open the conversation's viewer at this picture. */
  onOpen: (key: string) => void;
  /** For a wandering round: the corner button that shows what made it. */
  onOpenPrompt?: () => void;
}) {
  const generation = useGeneration(id);
  const store = useChatStore.getState;

  const record = generation.data;
  const images = record?.images ?? [];
  /** Centred, and as wide a share of the message as the setting says. */
  const style = { width: `${Math.round(width * 100)}%` };

  if (!record || (images.length === 0 && record.status !== 'failed')) {
    /*
     * The bar the rest of the app shows for the same wait.
     *
     * A run asked for in a conversation is watched in that conversation, and
     * what is wanted there is what the live bar gives everywhere else: the
     * frame it is up to, how much longer, which node, the step count. See
     * `RunProgress`.
     */
    return (
      <div style={style} className="mx-auto">
        <RunProgress
          generationId={id}
          queued={record?.status === 'running' ? 'Generating…' : 'Queued'}
        />
      </div>
    );
  }

  if (record.status === 'failed') {
    return <ErrorNote>{record.error || 'That run failed.'}</ErrorNote>;
  }

  return (
    <>
      {/* Centred in the row, one under the other. A batch is a column rather
          than a wrapped row because at these widths a row of two is two
          pictures too small to judge. */}
      <div className="flex flex-col items-center gap-1.5">
        {images.map((image, index) => (
          <div key={image.id ?? `${image.filename}-${index}`} className="relative" style={style}>
            {/*
              What made it, in the corner.

              Only on a wandering round, where the prompt is not written above
              the picture — everywhere else the row with the prompt is right
              there, and a badge on every picture in every conversation would be
              a permanent apology for an ambiguity that is not there.
            */}
            {onOpenPrompt && (
              <button
                type="button"
                onClick={onOpenPrompt}
                aria-label={`What made picture ${index + 1}`}
                className="absolute top-1.5 right-1.5 z-10 grid size-8 place-items-center rounded-lg bg-black/60 text-sm text-white backdrop-blur active:bg-black/80"
              >
                ✦
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpen(pictureKey(id, image))}
              aria-label={`Open picture ${index + 1}`}
              className="block w-full overflow-hidden rounded-xl bg-surface-2 active:opacity-80"
            >
            {/* `contain` so each picture keeps its own shape: a portrait and a
                landscape from one batch should not be cropped into agreeing
                with each other. */}
            <Still
              image={image}
              alt=""
              fit="contain"
              className="block w-full"
              /*
                The moment it is on screen, and not before.
                What happens next is the model being handed this picture, and
                the whole order of the review depends on that happening after
                you can see it — not merely after the run finished, which is a
                refetch and a download earlier.
              */
              onShown={index === 0 ? () => store().notePictureShown(id) : undefined}
            />
            </button>
          </div>
        ))}
      </div>

      {/* What it was made from, folded away. */}
      {prompt !== '' && (
        <div style={style} className="mx-auto">
          <PromptPanel prompt={prompt} previousPrompt={showDiff ? previousPrompt : ''} />
        </div>
      )}

    </>
  );
}

/**
 * The prompt a picture was made from, under it and folded away.
 *
 * Folded because the picture is the answer and the prompt is the working; open
 * because the moment you want to change one word, retyping the paragraph from
 * the dialog is the alternative. What changed since the conversation's previous
 * prompt is marked, which is the difference between "that looks different" and
 * knowing why.
 */
function PromptPanel({ prompt, previousPrompt }: { prompt: string; previousPrompt: string }) {
  const [open, setOpen] = useState(false);
  const changed = promptChanged(previousPrompt, prompt);

  return (
    <div className="rounded-lg border border-line/60 bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label="The prompt used"
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-muted"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate">{open ? 'Prompt' : prompt}</span>
        {changed && !open && (
          <span aria-hidden className="shrink-0 text-success">
            ±
          </span>
        )}
      </button>
      {open && (
        <div className="px-2 pb-1.5">
          {changed ? (
            <PromptDiff previous={previousPrompt} next={prompt} className="text-[11px]" />
          ) : (
            <p className="text-[11px] leading-relaxed break-words whitespace-pre-wrap">{prompt}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The model's reasoning, folded away.
 *
 * Worth having — it is often where the interesting part of a suggestion is —
 * and worth keeping out of the way, because it is usually several times longer
 * than the answer.
 */
function ThinkingBlock({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  /** Cleared the moment you scroll up, so reading is possible while it writes. */
  const [follow, setFollow] = useState(true);

  /*
   * Its own scroll, capped, and it follows only while you let it.
   *
   * Reasoning arrives faster than anyone reads, so following it unconditionally
   * meant the text you were half-way through was gone before you finished the
   * line — and there was no way to hold it still. Scrolling up stops the
   * follow; scrolling back to the end resumes it, which is the behaviour of
   * every log viewer worth using.
   */
  useEffect(() => {
    if (!open || !follow) return;
    const element = body.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [open, follow, text]);

  return (
    <div className="rounded-lg border border-line/60 bg-surface/60">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-muted"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {live ? 'Thinking…' : 'Thinking'}
        {open && live && !follow && (
          <span className="ml-auto text-[10px] text-accent">paused — scroll down to follow</span>
        )}
      </button>
      {open && (
        <div
          ref={body}
          data-testid="thinking-body"
          onScroll={(event) => {
            const element = event.currentTarget;
            const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
            setFollow(distance < 24);
          }}
          // Capped and scrollable: a model's reasoning runs to paragraphs, and
          // at full height it pushes the answer off the screen entirely.
          className="max-h-48 overflow-y-auto overscroll-contain px-2 pb-1.5"
        >
          <p className="text-[11px] leading-relaxed text-muted whitespace-pre-wrap">{text}</p>
        </div>
      )}
    </div>
  );
}

function SavedChats({
  currentId,
  onOpen,
  onNew,
}: {
  currentId: string;
  onOpen: (id: string) => Promise<void>;
  onNew: () => void;
}) {
  const [chats, setChats] = useState<{ id: string; title: string; updatedAt: number }[]>([]);

  useEffect(() => {
    void api.chats().then(setChats);
  }, []);

  return (
    <div className="space-y-2">
      <Button variant="secondary" className="w-full" onClick={onNew}>
        Start a new chat
      </Button>

      <ul className="space-y-1">
        {chats.map((entry) => (
          <li key={entry.id} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void onOpen(entry.id)}
              className={cn(
                'min-w-0 flex-1 rounded-lg px-3 py-2 text-left text-sm active:bg-surface-2',
                entry.id === currentId && 'bg-accent/15 text-accent',
              )}
            >
              <span className="block truncate">{entry.title || 'Untitled'}</span>
              <span className="block text-[10px] text-muted">
                {new Date(entry.updatedAt).toLocaleString()}
              </span>
            </button>
            <button
              type="button"
              onClick={async () => {
                await api.deleteChat(entry.id);
                setChats((current) => current.filter((chat) => chat.id !== entry.id));
              }}
              aria-label={`Delete ${entry.title || 'chat'}`}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted active:bg-surface-2"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      {chats.length === 0 && <p className="py-4 text-center text-sm text-muted">Nothing saved.</p>}
    </div>
  );
}

/**
 * Shrink a photo before it goes anywhere.
 *
 * A phone camera produces twelve megapixels; a vision model sees a few hundred
 * pixels on a side. Sending the original would spend a minute of a mobile
 * connection to no effect, and the conversation stores what is sent.
 */
async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return canvas.toDataURL('image/jpeg', 0.85);
}
