import { useEffect, useRef, useState } from 'react';

import { CHAT_IMAGE_SIZES } from '@latent/shared';
import type { ChatMessage, ChatToolCall } from '@latent/shared';

import { api, thumbnailUrl } from '../api/client';
import { useGeneration, useSettings } from '../api/queries';
import { ImageViewer } from '../components/ImageViewer';
import { Markdown } from '../components/Markdown';
import { PromptDiff, promptChanged } from '../components/PromptDiff';
import { ToolDialog } from '../components/ToolDialog';
import { Button, cn, ErrorNote, Sheet, Spinner } from '../components/ui';
import { useChatStore } from '../state/chat';
import { useLiveStore } from '../state/live';

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
  prompt_blocks: 'Proposed blocks',
  ask_user: 'Asked something',
};

export function ChatScreen() {
  const settings = useSettings();

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
  const askedForPrompt = useChatStore((state) => state.askedForPrompt);
  const callMinimized = useChatStore((state) => state.callMinimized);
  const waitingFor = useChatStore((state) => state.waitingFor);
  const store = useChatStore.getState;

  /** A prompt from further up, reopened to run again or to rewind to. */
  const [revisiting, setRevisiting] = useState<{
    messageId: string;
    call: ChatToolCall;
  } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
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
    <div className="safe-t flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-2 pb-1">
        <h1 className="min-w-0 truncate text-base font-semibold">{chat.title || 'Chat'}</h1>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            aria-label="Saved chats"
            className="grid size-9 place-items-center rounded-full bg-surface text-muted active:bg-surface-2"
          >
            ≡
          </button>
          <button
            type="button"
            onClick={() => void startNew()}
            aria-label="New chat"
            className="grid size-9 place-items-center rounded-full bg-surface text-muted active:bg-surface-2"
          >
            ＋
          </button>
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
            {TOOL_LABELS[pendingCall.call.tool]} — waiting on you
          </span>
          <span className="shrink-0 font-medium underline">Open</span>
        </button>
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
          {!streaming && (
            <Button
              variant="secondary"
              className="size-10 shrink-0 rounded-xl p-0 text-base"
              onClick={() => void store().askForPrompt()}
              aria-label="Build a prompt"
              title="Build a prompt from this conversation"
            >
              ✦
            </Button>
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
            disabled={streaming !== null || (draft.trim() === '' && attachments.length === 0)}
            aria-label="Send"
          >
            {streaming ? <Spinner className="size-4" /> : '↑'}
          </Button>
        </div>
      </div>

      {pendingCall && !callMinimized && (
        <ToolDialog
          call={pendingCall.call}
          onMinimize={() => store().minimizeCall()}
          settings={settings.data ?? null}
          previousPrompt={previousPrompt}
          autoAccept={
            pendingCall.call.tool === 'build_prompt' &&
            askedForPrompt &&
            settings.data?.chat.promptButton === 'generate'
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
            onRerun: async (generationId, prompt) => {
              const { messageId } = revisiting;
              setRevisiting(null);
              try {
                await api.rerunPrompt(chat.id, {
                  messageId,
                  ...(generationId ? { generationId } : {}),
                  prompt,
                });
                await store().refresh();
              } catch (cause) {
                store().setError(
                  cause instanceof Error ? cause.message : 'Could not record that',
                );
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

function MessageRow({
  message,
  pictureWidth,
  previousPrompt,
  showDiff,
  onRevisit,
}: {
  message: ChatMessage;
  pictureWidth: number;
  /** The prompt generated before this one, for marking what changed. */
  previousPrompt: string;
  showDiff: boolean;
  onRevisit: (call: ChatToolCall) => void;
}) {
  if (message.role === 'tool' || message.role === 'note') {
    return (
      <div className="space-y-1.5">
        <p className="text-center text-[11px] text-muted">{message.content}</p>
        {message.generationId && (
          <GeneratedRun
            id={message.generationId}
            width={pictureWidth}
            prompt={message.prompt ?? ''}
            previousPrompt={previousPrompt}
            showDiff={showDiff}
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

  return (
    <div className="space-y-1">
      {message.thinking && <ThinkingBlock text={message.thinking} />}
      {message.content !== '' && <Markdown text={message.content} />}
      {message.toolCall &&
        /*
          A prompt stays reachable for the rest of the conversation.
          Wanting the same picture with one thing changed is the commonest
          thing there is, and the alternative was a trip to the gallery to
          find the result and press reuse — which loses the conversation the
          prompt came out of. Only prompts: a decided question or a saved
          block has nothing left to do.
        */
        (message.toolCall.tool === 'build_prompt' && message.toolResult ? (
          <button
            type="button"
            onClick={() => onRevisit(message.toolCall!)}
            className="flex w-full items-center gap-1.5 rounded-lg bg-surface-2/60 px-2 py-1.5 text-left text-[11px] text-muted active:bg-surface-2"
          >
            <span aria-hidden className="text-accent">
              ✦
            </span>
            <span className="min-w-0 flex-1 truncate">{message.toolCall.prompt}</span>
            <span className="shrink-0 text-accent">Again</span>
          </button>
        ) : (
          <p className="text-[11px] text-muted">
            {TOOL_LABELS[message.toolCall.tool]}
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
}: {
  id: string;
  width: number;
  prompt: string;
  previousPrompt: string;
  showDiff: boolean;
}) {
  const generation = useGeneration(id);
  const job = useLiveStore((state) => state.live.job);
  const [viewing, setViewing] = useState<number | null>(null);

  const record = generation.data;
  const images = record?.images ?? [];
  /** Centred, and as wide a share of the message as the setting says. */
  const style = { width: `${Math.round(width * 100)}%` };

  if (!record || (images.length === 0 && record.status !== 'failed')) {
    /*
     * The same numbers the live bar shows, in the place you are looking.
     *
     * A run started from the chat is one you are watching from the chat, and
     * "Queued" with no end in sight for two minutes is indistinguishable from
     * broken. `graphProgress` rather than sampler steps: it covers the whole
     * graph, so a workflow that loads a model for forty seconds before the
     * first step still moves.
     */
    const mine = job?.generationId === id ? job : null;
    const fraction = mine
      ? Math.max(mine.graphProgress, mine.progressMax > 0 ? mine.progress / mine.progressMax : 0)
      : 0;

    return (
      <div style={style} className="mx-auto space-y-1.5 rounded-xl border border-line bg-surface-2/50 p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-muted">
          <span className="flex min-w-0 items-center gap-2 truncate">
            <Spinner className="size-3.5 shrink-0" />
            {mine?.nodeTitle ?? (record?.status === 'running' ? 'Generating…' : 'Queued')}
            {/*
              The node's own steps, next to its name.
              A percentage across the whole graph barely moves during the part
              that actually takes the time; "KSampler 12/20" is the number you
              are waiting on.
            */}
            {mine && mine.progressMax > 0 && (
              <span className="shrink-0 tabular-nums text-body">
                {mine.progress}/{mine.progressMax}
              </span>
            )}
          </span>
          {fraction > 0 && (
            <span className="shrink-0 tabular-nums">{Math.round(fraction * 100)}%</span>
          )}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div
            className={cn(
              'h-full rounded-full bg-accent transition-[width] duration-300',
              // Nothing to report yet: a bar at zero looks stuck, so it pulses
              // across instead of claiming a progress it does not have.
              fraction === 0 && 'w-1/3 animate-pulse',
            )}
            style={fraction > 0 ? { width: `${Math.round(fraction * 100)}%` } : undefined}
          />
        </div>
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
          <button
            key={image.id ?? `${image.filename}-${index}`}
            type="button"
            onClick={() => setViewing(index)}
            style={style}
            aria-label={`Open picture ${index + 1}`}
            className="overflow-hidden rounded-xl bg-surface-2 active:opacity-80"
          >
            <img
              src={thumbnailUrl(image)}
              alt=""
              // `h-auto` so each picture keeps its own shape: a portrait and a
              // landscape from one batch should not be cropped into agreeing
              // with each other.
              className="block h-auto w-full"
            />
          </button>
        ))}
      </div>

      {/* What it was made from, folded away. */}
      {prompt !== '' && (
        <div style={style} className="mx-auto">
          <PromptPanel prompt={prompt} previousPrompt={showDiff ? previousPrompt : ''} />
        </div>
      )}

      {viewing !== null && (
        <ImageViewer
          entries={images.map((image) => ({ record, image }))}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
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
