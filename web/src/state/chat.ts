import { create } from 'zustand';

import type {
  ChatAttachment,
  ChatConversationDetail,
  ChatEvent,
  ChatMessage,
  ChatRun,
  ChatToolCall,
  ProposedBlock,
} from '@latent/shared';
import { IDLE_RUN } from '@latent/shared';

import { api } from '../api/client';

/**
 * The conversation, as this device sees it.
 *
 * There used to be a great deal more here, and it was the wrong more. This
 * store drove the whole module: it read the reply stream, decided whether a
 * proposal should be accepted without asking, queued the render, recorded the
 * decision, waited for the picture, asked for the follow-up turn and started
 * the next round. All of that worked while you were looking at it, and stopped
 * the moment you were not — a backgrounded tab is frozen, its open streams are
 * cut under it, its timers slow to one tick a minute, and the step between two
 * `await`s simply never runs.
 *
 * So none of it is here now. The loop is the server's; see
 * `server/src/chat/engine.ts`. What is left is a view: it holds the transcript,
 * what the server says the conversation is doing, and the things that are
 * genuinely about *this screen* — the half-written message, which dialog is
 * open. It sends intents and it draws what comes back.
 *
 * Still outside the screen component, for the original reason: switching tabs
 * unmounts `ChatScreen`, and holding the transcript and a half-decided dialog
 * in component state meant a tap on Gallery destroyed both.
 */

const LAST_CHAT_KEY = 'latent.lastChatId';
const DRAFT_KEY = 'latent.chatDraft';

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
  /**
   * What the conversation is doing, according to the server.
   *
   * Not worked out here from what has been seen. Two tabs open on one
   * conversation used to be able to disagree about whether a run was going, and
   * a tab that had been asleep believed whatever it had been told last — which
   * was, reliably, that nothing was happening.
   */
  run: ChatRun;
  streaming: Streaming | null;
  /** The proposal waiting on you, looked up from `run.awaiting`. */
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
   * The tool dialog has been folded away without being decided.
   *
   * It covers the screen and blurs everything behind it, which is right while
   * you are deciding and wrong the moment you want to check something first.
   * The call itself is untouched — this is only whether it is on screen, which
   * is why it is the one piece of dialog state that stays on this side.
   */
  callMinimized: boolean;

  open: () => Promise<void>;
  openChat: (id: string) => Promise<void>;
  startNew: () => Promise<void>;
  refresh: () => Promise<void>;

  send: () => Promise<void>;
  askForPrompt: (options?: { fresh?: boolean; instant?: boolean }) => Promise<void>;
  startWander: () => Promise<void>;
  stopWander: () => Promise<void>;
  stop: () => Promise<void>;
  resolveTool: (body: {
    decision: 'accepted' | 'rejected';
    blocks?: ProposedBlock[];
    note?: string;
    prompt?: string;
    /** The workflow the dialog's picker chose, for this prompt only. */
    workflowId?: string;
  }) => Promise<void>;

  /** A render is on screen, which is what releases the turn that judges it. */
  notePictureShown: (generationId: string) => void;

  minimizeCall: () => void;
  restoreCall: () => void;
  setDraft: (draft: string) => void;
  setAttachments: (update: (current: ChatAttachment[]) => ChatAttachment[]) => void;
  setError: (error: string | null) => void;
}

export const useChatStore = create<ChatStore>((set, get) => {
  /**
   * The one open subscription, and the conversation it belongs to.
   *
   * `EventSource` rather than a `fetch` stream, deliberately. It reconnects by
   * itself — after a dropped connection, after a phone's radio comes back,
   * after the tab is woken from a freeze — and every reconnection opens with a
   * `sync` describing the present rather than replaying a request from an hour
   * ago. That property is the entire reason this rewrite exists.
   */
  let events: EventSource | null = null;
  let watching: string | null = null;

  /**
   * Re-read the transcript, coalescing bursts.
   *
   * A round produces several messages within a few milliseconds — the
   * proposal, the tool result, the note — and one fetch per message would be
   * three fetches for one state anybody wants to see.
   */
  let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
  const refreshSoon = () => {
    if (pendingRefresh) return;
    pendingRefresh = setTimeout(() => {
      pendingRefresh = null;
      void get().refresh();
    }, 60);
  };

  const watch = (chatId: string) => {
    if (watching === chatId && events) return;
    events?.close();
    watching = chatId;
    events = new EventSource(`/api/chat/conversations/${chatId}/events`);

    events.onmessage = (frame) => {
      if (watching !== chatId) return;
      let event: ChatEvent;
      try {
        event = JSON.parse(frame.data as string) as ChatEvent;
      } catch {
        return;
      }
      apply(chatId, event);
    };

    /*
     * Nothing to do on error.
     *
     * `EventSource` retries on its own, and the retry opens with a `sync` — so
     * the honest response to a dropped connection is to wait for it to come
     * back. Showing "connection lost" for the two seconds a phone takes to
     * change network is how the old version earned its reputation.
     */
    events.onerror = () => undefined;
  };

  const apply = (chatId: string, event: ChatEvent) => {
    if (get().chat?.id !== chatId) return;

    switch (event.type) {
      case 'sync':
        set({
          run: event.run,
          streaming: event.partial
            ? { content: event.partial.content, thinking: event.partial.thinking }
            : null,
        });
        // Whatever happened while nobody was listening is in the transcript,
        // not in the events that were missed.
        refreshSoon();
        break;

      case 'run':
        set({ run: event.run, ...(event.run.phase === 'thinking' ? {} : { streaming: null }) });
        // A proposal is only nameable once its message has been read.
        if (event.run.awaiting && event.run.awaiting !== get().pendingCall?.messageId) {
          refreshSoon();
        }
        if (!event.run.awaiting && get().pendingCall) set({ pendingCall: null });
        break;

      case 'content':
        set((state) => ({
          streaming: {
            thinking: state.streaming?.thinking ?? '',
            content: (state.streaming?.content ?? '') + event.text,
          },
        }));
        break;

      case 'thinking':
        set((state) => ({
          streaming: {
            content: state.streaming?.content ?? '',
            thinking: (state.streaming?.thinking ?? '') + event.text,
          },
        }));
        break;

      case 'message':
        refreshSoon();
        break;

      case 'error':
        set({ error: event.message });
        break;
    }
  };

  /** The proposal `run.awaiting` names, found in the transcript we now hold. */
  const findPending = (
    chat: ChatConversationDetail | null,
    run: ChatRun,
  ): PendingCall | null => {
    if (!run.awaiting || !chat) return null;
    const message = chat.messages.find((candidate) => candidate.id === run.awaiting);
    return message?.toolCall ? { messageId: message.id, call: message.toolCall } : null;
  };

  /** Load a conversation and start watching it. One path for every way in. */
  const load = async (chatId: string) => {
    const detail = await api.chat(chatId);
    const pending = findPending(detail, detail.run);
    set((state) => ({
      chat: detail,
      run: detail.run,
      pendingCall: pending,
      // Folding a proposal away is a decision about *that* proposal; a new one
      // arrives open. A rewrite waits folded, because it lands straight after a
      // render and covering that render the moment it appears is the opposite
      // of what the review is for.
      callMinimized:
        pending && pending.messageId === state.pendingCall?.messageId
          ? state.callMinimized
          : pending?.call.tool === 'revise_prompt',
      error: null,
      loading: false,
    }));
    localStorage.setItem(LAST_CHAT_KEY, chatId);
    watch(chatId);
  };

  /** Opening is idempotent: several mounts must not make several conversations. */
  let opening: Promise<void> | null = null;

  return {
    chat: null,
    run: { ...IDLE_RUN },
    streaming: null,
    pendingCall: null,
    draft: localStorage.getItem(DRAFT_KEY) ?? '',
    attachments: [],
    error: null,
    loading: false,
    callMinimized: false,

    open: async () => {
      if (get().chat || opening) return opening ?? undefined;
      set({ loading: true });
      opening = (async () => {
        try {
          const remembered = localStorage.getItem(LAST_CHAT_KEY);
          if (remembered) {
            try {
              await load(remembered);
              return;
            } catch {
              // Deleted, or from another install. Fall through and start one.
            }
          }
          const list = await api.chats().catch(() => []);
          const first = list[0];
          if (first) await load(first.id);
          else await load((await api.createChat()).id);
        } catch (cause) {
          set({
            loading: false,
            error: cause instanceof Error ? cause.message : 'Could not open the chat',
          });
        } finally {
          opening = null;
        }
      })();
      return opening;
    },

    openChat: async (id) => {
      set({ streaming: null, pendingCall: null, error: null });
      await load(id);
    },

    startNew: async () => {
      const made = await api.createChat();
      set({ streaming: null, pendingCall: null, error: null });
      await load(made.id);
    },

    /**
     * Re-read the transcript.
     *
     * The server is the authority on what was stored, so this replaces rather
     * than patches: a divergence here would show a message that is not saved.
     */
    refresh: async () => {
      const chatId = get().chat?.id;
      if (!chatId) return;
      try {
        const detail = await api.chat(chatId);
        if (get().chat?.id !== chatId) return;
        set((state) => {
          const pending = findPending(detail, detail.run);
          return {
            chat: detail,
            run: detail.run,
            pendingCall: pending,
            callMinimized:
              pending && pending.messageId === state.pendingCall?.messageId
                ? state.callMinimized
                : pending?.call.tool === 'revise_prompt',
            ...(detail.run.phase === 'thinking' ? {} : { streaming: null }),
          };
        });
      } catch {
        // A refresh that fails is a refresh; the stream will bring the next
        // reason to try again, and reporting it would put an error on screen
        // for a conversation that is fine.
      }
    },

    send: async () => {
      const { chat, draft, attachments } = get();
      const content = draft.trim();
      if (!chat || (content === '' && attachments.length === 0)) return;

      get().setDraft('');
      set({ error: null, attachments: [], pendingCall: null, callMinimized: false });

      /*
       * Your own message goes up immediately.
       *
       * It used to appear only once the reply had finished, because the
       * transcript is re-read rather than patched — which is right for the
       * model's messages and wrong for yours. Against a local model that is
       * half a minute of watching your own sentence not be there. The id is
       * provisional; the next read replaces it.
       */
      const provisional: ChatMessage = {
        id: `pending-${Date.now()}`,
        role: 'user',
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
        createdAt: Date.now(),
      };
      set((state) => ({
        chat: state.chat
          ? { ...state.chat, messages: [...state.chat.messages, provisional] }
          : null,
      }));

      try {
        await api.say(chat.id, { content, ...(attachments.length > 0 ? { attachments } : {}) });
      } catch (cause) {
        set({ error: cause instanceof Error ? cause.message : 'Could not send that' });
        await get().refresh();
      }
    },

    askForPrompt: async (options = {}) => {
      const chat = get().chat;
      if (!chat) return;
      set({ error: null });
      try {
        await api.askForPrompt(chat.id, options);
      } catch (cause) {
        set({ error: cause instanceof Error ? cause.message : 'Could not ask for that' });
      }
    },

    startWander: async () => {
      const chat = get().chat;
      if (!chat) return;
      set({ error: null });
      try {
        await api.setWandering(chat.id, true);
      } catch (cause) {
        set({ error: cause instanceof Error ? cause.message : 'Could not start wandering' });
      }
    },

    stopWander: async () => {
      const chat = get().chat;
      if (!chat) return;
      await api.setWandering(chat.id, false).catch(() => undefined);
    },

    stop: async () => {
      const chat = get().chat;
      if (!chat) return;
      await api.stopChat(chat.id).catch(() => undefined);
    },

    /**
     * Settle the proposal on the table.
     *
     * One request. Accepting a prompt queues it on the server in the same act
     * that records the decision — it used to be two requests from here with the
     * render in between, and a page that died in the gap left the conversation
     * holding a proposal nothing would ever answer.
     */
    resolveTool: async (body) => {
      const { chat, pendingCall } = get();
      if (!chat || !pendingCall) return;

      set({ pendingCall: null, callMinimized: false });
      try {
        await api.decideTool(chat.id, {
          messageId: pendingCall.messageId,
          decision: body.decision,
          ...(body.blocks ? { blocks: body.blocks } : {}),
          ...(body.note ? { note: body.note } : {}),
          ...(body.prompt ? { prompt: body.prompt } : {}),
          ...(body.workflowId ? { workflowId: body.workflowId } : {}),
        });
      } catch (cause) {
        set({ error: cause instanceof Error ? cause.message : 'Could not record that' });
      }
      await get().refresh();
    },

    notePictureShown: (generationId) => {
      const chat = get().chat;
      if (!chat) return;
      void api.notePictureShown(chat.id, generationId).catch(() => undefined);
    },

    /*
     * Folding a proposal away by hand is taking the wheel back. It means "not
     * this one, not yet", and an app that then accepted it two seconds later
     * would be ignoring the clearest instruction available.
     */
    minimizeCall: () => set({ callMinimized: true }),
    restoreCall: () => set({ callMinimized: false }),

    setDraft: (draft) => {
      set({ draft });
      if (draft === '') localStorage.removeItem(DRAFT_KEY);
      else localStorage.setItem(DRAFT_KEY, draft);
    },
    setAttachments: (update) => set((state) => ({ attachments: update(state.attachments) })),
    setError: (error) => set({ error }),
  };
});
