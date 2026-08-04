import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ChatConversationDetail,
  ChatMessage,
  ChatStreamEvent,
  ChatToolCall,
} from '@latent/shared';

import { api, imageUrl } from '../api/client';
import { useGeneration, useSettings } from '../api/queries';
import { ImageViewer } from '../components/ImageViewer';
import { ToolDialog } from '../components/ToolDialog';
import { Button, cn, ErrorNote, Sheet, Spinner } from '../components/ui';

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
 */

const LAST_CHAT_KEY = 'latent.lastChatId';
/** Longest side an attachment is scaled to before it is sent. */
const MAX_IMAGE_SIDE = 1024;

interface Streaming {
  content: string;
  thinking: string;
}

/** What a resolved tool call is called once it is only a line in the history. */
const TOOL_LABELS: Record<ChatToolCall['tool'], string> = {
  build_prompt: 'Proposed a prompt',
  prompt_blocks: 'Proposed blocks',
  ask_user: 'Asked something',
};

export function ChatScreen() {
  const settings = useSettings();

  const [chat, setChat] = useState<ChatConversationDetail | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [pendingCall, setPendingCall] = useState<{ messageId: string; call: ChatToolCall } | null>(
    null,
  );
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<{ dataUrl: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [transcriptHeight, setTranscriptHeight] = useState(0);

  /*
   * A generated picture is sized against the chat window, not against the
   * screen: the setting is "a third of what I am reading", and on a phone with
   * the keyboard up that is a very different number from a third of the
   * display. Measured rather than assumed for the same reason.
   */
  useEffect(() => {
    const element = transcriptRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setTranscriptHeight(element.clientHeight));
    observer.observe(element);
    setTranscriptHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const pictureHeight = Math.max(
    80,
    Math.round(transcriptHeight * (settings.data?.chat.imageHeight ?? 1 / 3)),
  );

  /** Open the conversation we were last in, or start one. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const remembered = localStorage.getItem(LAST_CHAT_KEY);
      try {
        if (remembered) {
          const existing = await api.chat(remembered).catch(() => null);
          if (existing && !cancelled) {
            setChat(existing);
            return;
          }
        }
        const created = await api.createChat();
        if (cancelled) return;
        localStorage.setItem(LAST_CHAT_KEY, created.id);
        setChat({ ...created, messages: [] });
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not open the chat');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Follow the reply as it arrives, the way a chat should.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [chat?.messages.length, streaming?.content, streaming?.thinking]);

  /** Read one server-sent stream to the end, updating as it goes. */
  const consume = useCallback(
    async (response: Response, chatId: string) => {
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `The chat request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let call: { messageId: string; call: ChatToolCall } | null = null;
      let pendingToolCall: ChatToolCall | null = null;

      setStreaming({ content: '', thinking: '' });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let split: number;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (!frame.startsWith('data:')) continue;

            let event: ChatStreamEvent;
            try {
              event = JSON.parse(frame.slice(5).trim()) as ChatStreamEvent;
            } catch {
              continue;
            }

            if (event.type === 'content') {
              setStreaming((current) => ({
                thinking: current?.thinking ?? '',
                content: (current?.content ?? '') + event.text,
              }));
            } else if (event.type === 'thinking') {
              setStreaming((current) => ({
                content: current?.content ?? '',
                thinking: (current?.thinking ?? '') + event.text,
              }));
            } else if (event.type === 'tool') {
              pendingToolCall = event.call;
            } else if (event.type === 'error') {
              setError(event.message);
            } else if (event.type === 'done' && pendingToolCall) {
              call = { messageId: event.messageId, call: pendingToolCall };
            }
          }
        }
      } finally {
        reader.releaseLock();
        setStreaming(null);
      }

      // Re-read rather than patching locally: the server decided what was worth
      // keeping, and a divergence here would show a message that is not stored.
      const refreshed = await api.chat(chatId);
      setChat(refreshed);
      if (call) setPendingCall(call);
    },
    [],
  );

  const send = async () => {
    const content = draft.trim();
    if (!chat || (content === '' && attachments.length === 0) || streaming) return;

    setError(null);
    setDraft('');
    const sending = attachments;
    setAttachments([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`/api/chat/conversations/${chat.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content, attachments: sending }),
        signal: controller.signal,
      });
      await consume(response, chat.id);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'The model did not answer');
      setStreaming(null);
    }
  };

  /** After a decision, let the model say something about it. */
  const continueAfterTool = async (chatId: string) => {
    try {
      const response = await fetch(`/api/chat/conversations/${chatId}/continue`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      await consume(response, chatId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The model did not answer');
    }
  };

  const attach = async (files: FileList) => {
    setError(null);
    for (const file of [...files].slice(0, 4)) {
      try {
        setAttachments((current) => [...current, { dataUrl: '', name: file.name }]);
        const dataUrl = await downscale(file);
        setAttachments((current) =>
          current.map((entry) => (entry.name === file.name && entry.dataUrl === '' ? { ...entry, dataUrl } : entry)),
        );
      } catch {
        setAttachments((current) => current.filter((entry) => entry.name !== file.name));
        setError(`${file.name} could not be read as an image.`);
      }
    }
  };

  const startNew = async () => {
    const created = await api.createChat();
    localStorage.setItem(LAST_CHAT_KEY, created.id);
    setChat({ ...created, messages: [] });
    setPendingCall(null);
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
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2',
          pendingCall && 'pointer-events-none blur-sm',
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
            <MessageRow key={message.id} message={message} pictureHeight={pictureHeight} />
          ))}

          {streaming && (
            <div className="space-y-1">
              {streaming.thinking !== '' && (
                <ThinkingBlock text={streaming.thinking} live={streaming.content === ''} />
              )}
              <div className="text-sm leading-relaxed whitespace-pre-wrap">
                {streaming.content}
                <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      <ErrorNote>{error}</ErrorNote>

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
                    setAttachments((current) => current.filter((_, at) => at !== index))
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
            onChange={(event) => setDraft(event.target.value)}
            rows={1}
            placeholder="Say something…"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-line bg-surface px-3 py-2 text-sm leading-relaxed focus:border-accent focus:outline-none"
          />

          <Button
            variant="primary"
            className="size-10 shrink-0 rounded-xl p-0"
            onClick={() => void send()}
            disabled={streaming !== null || (draft.trim() === '' && attachments.length === 0)}
            aria-label="Send"
          >
            {streaming ? <Spinner className="size-4" /> : '↑'}
          </Button>
        </div>
      </div>

      {pendingCall && (
        <ToolDialog
          call={pendingCall.call}
          settings={settings.data ?? null}
          onResolve={async (body) => {
            setPendingCall(null);
            try {
              await api.resolveTool(chat.id, { messageId: pendingCall.messageId, ...body });
              await continueAfterTool(chat.id);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'Could not record that');
            }
          }}
        />
      )}

      <Sheet open={showHistory} onClose={() => setShowHistory(false)} title="Saved chats">
        <SavedChats
          currentId={chat.id}
          onOpen={async (id) => {
            const opened = await api.chat(id);
            localStorage.setItem(LAST_CHAT_KEY, id);
            setChat(opened);
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
  pictureHeight,
}: {
  message: ChatMessage;
  pictureHeight: number;
}) {
  if (message.role === 'tool') {
    return (
      <div className="space-y-1.5">
        <p className="text-center text-[11px] text-muted">{message.content}</p>
        {message.generationId && (
          <GeneratedRun id={message.generationId} height={pictureHeight} />
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
      {message.content !== '' && (
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{message.content}</p>
      )}
      {message.toolCall && (
        <p className="text-[11px] text-muted">
          {TOOL_LABELS[message.toolCall.tool]}
          {message.toolResult
            ? ` · ${message.toolResult.decision === 'accepted' ? 'accepted' : 'declined'}`
            : ' · waiting'}
        </p>
      )}
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
function GeneratedRun({ id, height }: { id: string; height: number }) {
  const generation = useGeneration(id);
  const [viewing, setViewing] = useState<number | null>(null);

  const record = generation.data;
  const images = record?.images ?? [];

  if (!record || (images.length === 0 && record.status !== 'failed')) {
    return (
      <div
        style={{ height }}
        className="grid place-items-center rounded-xl border border-line bg-surface-2/50"
      >
        <span className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="size-3.5" />
          {record?.status === 'running' ? 'Generating…' : 'Queued'}
        </span>
      </div>
    );
  }

  if (record.status === 'failed') {
    return <ErrorNote>{record.error || 'That run failed.'}</ErrorNote>;
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {images.map((image, index) => (
          <button
            key={image.id ?? `${image.filename}-${index}`}
            type="button"
            onClick={() => setViewing(index)}
            style={{ height }}
            aria-label={`Open picture ${index + 1}`}
            className="overflow-hidden rounded-xl bg-surface-2 active:opacity-80"
          >
            <img
              src={imageUrl(image, 'webp;80')}
              alt=""
              // `h-full w-auto` so the row keeps each picture's own shape: a
              // portrait and a landscape from one batch should not be cropped
              // into agreeing with each other.
              className="h-full w-auto object-contain"
            />
          </button>
        ))}
      </div>

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
 * The model's reasoning, folded away.
 *
 * Worth having — it is often where the interesting part of a suggestion is —
 * and worth keeping out of the way, because it is usually several times longer
 * than the answer.
 */
function ThinkingBlock({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);

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
      </button>
      {open && (
        <p className="px-2 pb-1.5 text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
          {text}
        </p>
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
