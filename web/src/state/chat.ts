import { create } from 'zustand';

import type {
  ChatAttachment,
  ChatConversationDetail,
  ChatMessage,
  ChatStreamEvent,
  ChatToolCall,
  GenerationRecord,
} from '@latent/shared';

import { ApiError, api } from '../api/client';
import { useLiveStore } from './live';

/**
 * The conversation, held outside the screen that shows it.
 *
 * The chat used to live entirely in `ChatScreen`'s state, which meant switching
 * tabs unmounted it — and unmounting it aborted the reply, dropped the tool
 * dialog you were half way through deciding on, and threw away what you had
 * typed. Worse, coming back re-ran the "open the conversation" effect, which
 * raced whatever had been happening and could leave the transcript missing the
 * last thing said. That is the whole of "the chat window is unstable": nothing
 * about it was wrong except *where it was kept*.
 *
 * Here, a reply carries on arriving while you are looking at the gallery, and
 * coming back is a render rather than a reload.
 */

/** What has arrived of a reply so far. */
export interface Streaming {
  content: string;
  thinking: string;
}

export interface PendingCall {
  messageId: string;
  call: ChatToolCall;
}

interface ChatStore {
  chat: ChatConversationDetail | null;
  streaming: Streaming | null;
  pendingCall: PendingCall | null;
  /**
   * Kept here — and on the device — so a half-written sentence outlives both a
   * tab switch and a reload. It is not part of the conversation until it is
   * sent, so it never goes to the server.
   */
  draft: string;
  attachments: ChatAttachment[];
  error: string | null;
  /** True while the first conversation is being opened. */
  loading: boolean;

  /**
   * True while the tool call in flight is one the prompt button asked for.
   *
   * Only those are queued without being read. A prompt the model offered on its
   * own is still shown first, whatever the button's setting says.
   */
  askedForPrompt: boolean;

  /**
   * The run the model is waiting on before it says anything else.
   *
   * Accepting a prompt used to be followed straight away by the model's next
   * turn, which meant it commented on — and often proposed a change to — a
   * picture that did not exist yet. Nothing it said then could be about the
   * result, because the result was still being sampled.
   */
  waitingFor: string | null;

  /**
   * The tool dialog has been folded away without being decided.
   *
   * It covers the screen and blurs everything behind it, which is right while
   * you are deciding and wrong the moment you want to check something first.
   * The call itself is untouched — this is only whether it is on screen.
   */
  callMinimized: boolean;

  minimizeCall: () => void;
  restoreCall: () => void;

  open: () => Promise<void>;
  openChat: (id: string) => Promise<void>;
  startNew: () => Promise<void>;
  send: () => Promise<void>;
  /** Force the build_prompt tool, because the button was pressed. */
  askForPrompt: () => Promise<void>;
  stop: () => Promise<void>;
  /** Record a decision about a tool call, then let the model respond to it. */
  resolveTool: (body: Omit<Parameters<typeof api.resolveTool>[1], 'messageId'>) => Promise<void>;
  /** Re-read the conversation from the server, which is the authority. */
  refresh: () => Promise<void>;

  setDraft: (draft: string) => void;
  setAttachments: (update: (current: ChatAttachment[]) => ChatAttachment[]) => void;
  setError: (error: string | null) => void;
}

const LAST_CHAT_KEY = 'latent.lastChatId';
const DRAFT_KEY = 'latent.chatDraft';

/**
 * The in-flight request, outside the store.
 *
 * Deliberately not state: nothing renders differently for it, and putting it in
 * the store would mean a re-render every time it is swapped.
 */
let inFlight: AbortController | null = null;
/** Guards `open` against being run twice by two mounts of the same screen. */
let opening: Promise<void> | null = null;

/** How often to ask the server, when no live event has told us. */
const SETTLE_POLL_MS = 2_000;
/**
 * Long enough for any render, short enough that a lost job cannot silence the
 * conversation for good. Reaching it carries on rather than giving up.
 */
const SETTLE_CEILING_MS = 30 * 60 * 1000;

/**
 * Wait for one run to stop being in progress.
 *
 * Two sources, because neither alone is enough. The live socket is the fast
 * one, and it is also the one that is not there after a reconnect or while a
 * phone's screen is locked; polling the record is slow but always true. Whether
 * the picture came out is not this function's business — a failed render is
 * still something for the model to respond to.
 */
async function waitForGeneration(id: string, stillWanted: () => boolean): Promise<void> {
  const done = (record: GenerationRecord | null): boolean =>
    record?.id === id &&
    (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled');

  if (done(useLiveStore.getState().lastGeneration)) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearInterval(poll);
      clearTimeout(ceiling);
      resolve();
    };

    const unsubscribe = useLiveStore.subscribe((state) => {
      if (done(state.lastGeneration)) finish();
    });

    const poll = setInterval(() => {
      if (!stillWanted()) {
        finish();
        return;
      }
      void api
        .generation(id)
        .then((record) => {
          if (done(record)) finish();
        })
        // A 404 means the run is not there to wait for — swept, or never
        // recorded. Either way nothing is coming.
        .catch(() => finish());
    }, SETTLE_POLL_MS);

    const ceiling = setTimeout(finish, SETTLE_CEILING_MS);
  });
}

export const useChatStore = create<ChatStore>((set, get) => {
  /**
   * Read one server-sent stream to the end, updating as it goes.
   *
   * Every write checks that the conversation it belongs to is still the one on
   * screen: starting a new chat while a reply is arriving is a normal thing to
   * do, and the late frames of the abandoned reply must not be painted into it.
   */
  const consume = async (response: Response, chatId: string): Promise<void> => {
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `The chat request failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const mine = () => get().chat?.id === chatId;

    let buffer = '';
    let call: PendingCall | null = null;
    let pendingToolCall: ChatToolCall | null = null;

    set({ streaming: { content: '', thinking: '' } });

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

          if (!mine()) continue;

          if (event.type === 'content') {
            set((state) => ({
              streaming: {
                thinking: state.streaming?.thinking ?? '',
                content: (state.streaming?.content ?? '') + event.text,
              },
            }));
          } else if (event.type === 'thinking') {
            set((state) => ({
              streaming: {
                content: state.streaming?.content ?? '',
                thinking: (state.streaming?.thinking ?? '') + event.text,
              },
            }));
          } else if (event.type === 'tool') {
            pendingToolCall = event.call;
          } else if (event.type === 'error') {
            set({ error: event.message });
          } else if (event.type === 'done' && pendingToolCall) {
            call = { messageId: event.messageId, call: pendingToolCall };
          }
        }
      }
    } finally {
      reader.releaseLock();
      if (mine()) set({ streaming: null });
    }

    // Re-read rather than patching locally: the server decided what was worth
    // keeping, and a divergence here would show a message that is not stored.
    const refreshed = await api.chat(chatId);
    if (!mine()) return;
    /*
     * A new proposal is shown — except the one that arrives while you are
     * looking at a picture.
     *
     * A rewrite comes straight after a render, and covering that render with a
     * dialog the moment it appears is the opposite of what was wanted: the
     * point of the review is that you see the result, read what the model made
     * of it, and then decide. So it waits, folded away above the composer, and
     * opens when you go to it. Folding a call away yourself stays a decision
     * about that call, not a preference for the next one.
     */
    set({
      chat: refreshed,
      ...(call
        ? { pendingCall: call, callMinimized: call.call.tool === 'revise_prompt' }
        : {}),
    });
  };

  /** Run one request that produces a stream, cancelling any earlier one. */
  const stream = async (request: () => Promise<Response>, chatId: string): Promise<void> => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    try {
      await consume(await request(), chatId);
    } catch (cause) {
      if (get().chat?.id === chatId) set({ streaming: null });
      if (!controller.signal.aborted) {
        set({
          error: cause instanceof Error ? cause.message : 'The model did not answer',
        });
        // Either way the server is the authority on what was stored — including
        // a message that may or may not have reached it.
        await get().refresh();
      }
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  };

  return {
    chat: null,
    streaming: null,
    pendingCall: null,
    draft: localStorage.getItem(DRAFT_KEY) ?? '',
    attachments: [],
    error: null,
    loading: false,
    askedForPrompt: false,
    waitingFor: null,
    callMinimized: false,

    minimizeCall: () => set({ callMinimized: true }),
    restoreCall: () => set({ callMinimized: false }),

    setDraft: (draft) => {
      set({ draft });
      if (draft === '') localStorage.removeItem(DRAFT_KEY);
      else localStorage.setItem(DRAFT_KEY, draft);
    },
    setAttachments: (update) => set((state) => ({ attachments: update(state.attachments) })),
    setError: (error) => set({ error }),

    /**
     * Open the conversation we were last in, or start one.
     *
     * Runs at most once: a second call while the first is in flight waits for
     * it, and a call once a conversation is open does nothing at all. Both
     * matter now that the screen mounts and unmounts every time a tab is
     * touched — without the guard, coming back created a fresh conversation, or
     * two of them.
     *
     * A failed read is not the same as a missing one. Only a conversation that
     * is genuinely gone is replaced; any other failure says so and leaves the
     * screen empty, which is recoverable.
     */
    open: async () => {
      if (get().chat) return;
      if (opening) return opening;

      opening = (async () => {
        set({ loading: true, error: null });
        try {
          const remembered = localStorage.getItem(LAST_CHAT_KEY);
          if (remembered) {
            try {
              set({ chat: await api.chat(remembered) });
              return;
            } catch (cause) {
              const missing = cause instanceof ApiError && cause.status === 404;
              if (!missing) {
                set({
                  error: cause instanceof Error ? cause.message : 'Could not open the chat',
                });
                return;
              }
              localStorage.removeItem(LAST_CHAT_KEY);
            }
          }

          const created = await api.createChat();
          localStorage.setItem(LAST_CHAT_KEY, created.id);
          set({ chat: { ...created, messages: [] } });
        } catch (cause) {
          set({ error: cause instanceof Error ? cause.message : 'Could not open the chat' });
        } finally {
          set({ loading: false });
          opening = null;
        }
      })();

      return opening;
    },

    openChat: async (id) => {
      inFlight?.abort();
      const opened = await api.chat(id);
      localStorage.setItem(LAST_CHAT_KEY, id);
      set({
        chat: opened,
        streaming: null,
        pendingCall: null,
        callMinimized: false,
        waitingFor: null,
        error: null,
      });
    },

    startNew: async () => {
      inFlight?.abort();
      const created = await api.createChat();
      localStorage.setItem(LAST_CHAT_KEY, created.id);
      set({
        chat: { ...created, messages: [] },
        streaming: null,
        pendingCall: null,
        callMinimized: false,
        waitingFor: null,
        askedForPrompt: false,
        error: null,
        attachments: [],
      });
      get().setDraft('');
    },

    send: async () => {
      const { chat, draft, attachments, streaming, pendingCall } = get();
      const content = draft.trim();
      if (!chat || (content === '' && attachments.length === 0) || streaming) return;

      /*
       * Saying something else is an answer to a proposal nobody decided.
       *
       * A rewrite waits folded away, and the honest reading of "carry on
       * talking instead" is that you do not want it — leaving it pending would
       * mean the next thing you say arrives in a conversation the model thinks
       * is still waiting on a decision, which is a state chat templates handle
       * badly and people handle worse. So it is refused, plainly, and the model
       * is told why.
       */
      if (pendingCall) {
        set({ pendingCall: null, callMinimized: false, askedForPrompt: false });
        try {
          await api.resolveTool(chat.id, {
            messageId: pendingCall.messageId,
            decision: 'rejected',
            note: 'The user did not take that up and said something else instead.',
          });
          await get().refresh();
        } catch {
          // Already decided, or the conversation has gone. Either way what
          // matters next is the message being sent, not this.
        }
      }
      /*
       * A request already out counts as sending, even before the first frame
       * has arrived and set `streaming`. Against a local model that gap is
       * seconds long, and a second tap in it used to post a second message and
       * abandon the reply to the first.
       */
      if (inFlight) return;

      get().setDraft('');
      set({ error: null, attachments: [] });

      /*
       * Your own message goes up immediately.
       *
       * It used to appear only once the whole reply had finished, because the
       * transcript was re-read from the server rather than patched — which is
       * right for the *model's* messages and wrong for yours. Against a local
       * model that is half a minute of watching your own sentence not be there.
       * The id is provisional; the re-read at the end of the stream replaces it.
       */
      const provisional: ChatMessage = {
        id: `pending-${Date.now()}`,
        role: 'user',
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
        createdAt: Date.now(),
      };
      set((state) => ({
        chat: state.chat ? { ...state.chat, messages: [...state.chat.messages, provisional] } : null,
      }));

      await stream(
        () =>
          fetch(`/api/chat/conversations/${chat.id}/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ content, attachments }),
            signal: inFlight?.signal,
          }),
        chat.id,
      );
    },

    /**
     * Ask for a prompt, because the button was pressed.
     *
     * A forced tool call rather than a message saying "write me a prompt": the
     * second is a request the model weighs against its pace setting, and the
     * button is not a request.
     */
    askForPrompt: async () => {
      const { chat, streaming } = get();
      if (!chat || streaming || inFlight) return;

      set({ error: null, askedForPrompt: true });
      await stream(
        () =>
          fetch(`/api/chat/conversations/${chat.id}/build`, {
            method: 'POST',
            credentials: 'same-origin',
            signal: inFlight?.signal,
          }),
        chat.id,
      );
    },

    /**
     * Cut the reply short.
     *
     * Small models get stuck: the same paragraph three times, a list that never
     * ends, a tool call it keeps rewriting. Aborting the request closes the
     * stream, which the server takes as its cue to stop asking the model and
     * keep what it has — so stopping a rambler leaves the useful first
     * paragraph behind rather than throwing the turn away.
     */
    stop: async () => {
      inFlight?.abort();
      inFlight = null;
      set({ streaming: null });
      await get().refresh();
    },

    resolveTool: async (body) => {
      const { chat, pendingCall } = get();
      if (!chat || !pendingCall) return;

      set({ pendingCall: null, askedForPrompt: false, callMinimized: false });
      try {
        await api.resolveTool(chat.id, { messageId: pendingCall.messageId, ...body });
      } catch (cause) {
        set({ error: cause instanceof Error ? cause.message : 'Could not record that' });
        return;
      }

      /*
       * A decision that started a render is answered when the render is over.
       *
       * The model's turn after an accepted prompt is *about* the picture — and
       * replying while it is still sampling meant talking about something
       * nobody had seen, including itself. The wait lives here rather than on
       * the screen because the screen is unmounted the moment you look at the
       * gallery, which is exactly what you do while a picture renders.
       */
      const startedRun = body.generationId;
      if (typeof startedRun === 'string' && startedRun !== '') {
        set({ waitingFor: startedRun });
        await waitForGeneration(startedRun, () => get().chat?.id === chat.id);
        if (get().chat?.id !== chat.id) return;
        set({ waitingFor: null });
      }

      // After a decision the model usually has something short to say about it.
      await stream(
        () =>
          fetch(`/api/chat/conversations/${chat.id}/continue`, {
            method: 'POST',
            credentials: 'same-origin',
            signal: inFlight?.signal,
          }),
        chat.id,
      );
    },

    refresh: async () => {
      const id = get().chat?.id;
      if (!id) return;
      try {
        const fresh = await api.chat(id);
        if (get().chat?.id === id) set({ chat: fresh });
      } catch {
        // A failed refresh leaves what is on screen, which is the last thing
        // the server told us. Nothing here is worth an error message.
      }
    },
  };
});

/** True when a reply is arriving, for the composer's Stop button. */
export const selectStreaming = (state: ChatStore) => state.streaming;
