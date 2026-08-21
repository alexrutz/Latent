import { create } from 'zustand';

import type {
  AutonomousRun,
  ChatAttachment,
  ChatConversationDetail,
  ChatMessage,
  ChatStreamEvent,
  ChatToolCall,
  GenerationRecord,
} from '@latent/shared';

import { ApiError, api } from '../api/client';
import { queuePrompt, resolveTarget } from '../lib/queuePrompt';
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

/** The settings the store itself acts on, mirrored from the server's copy. */
export interface ChatMode {
  autonomous: AutonomousRun;
  /** Whether the ✦ button queues the prompt or shows it first. */
  promptButton: 'generate' | 'dialog';
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
   * A prompt has been asked for and nothing has come back yet.
   *
   * The gap is a second or two against a local model, and without it the ✦
   * button is a button that visibly does nothing when pressed — which reads as
   * a tap that missed, so people press it again.
   */
  asking: boolean;

  /**
   * The renders the transcript has actually put on screen.
   *
   * Not "the run finished": finished means the record exists, and there is a
   * refetch and an image download between that and anything being visible. The
   * model is handed the picture only once you have seen it, which is the whole
   * order the review is supposed to happen in.
   */
  notePictureShown: (generationId: string) => void;

  /**
   * How the app decides things on the model's behalf.
   *
   * Mirrored from the settings rather than read from them here: the store is
   * where "is this proposal accepted automatically" is decided, and that
   * question has two sources — the prompt button, and the autonomous run — that
   * were previously answered in two different places. See `setMode`.
   */
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;

  /**
   * Renders this autonomous run has started, since the last thing you said.
   *
   * The loop's own brake. A model convinced its prompt is nearly right will
   * rewrite it indefinitely, and nobody is watching by definition.
   */
  autoRounds: number;

  /**
   * The autonomous run has been stopped, until you say something next.
   *
   * Set by the Stop button and by any decision you make yourself: taking one
   * over is the clearest possible statement that you would like the wheel back.
   */
  autoHalted: boolean;

  /** Why it stopped carrying on, in a few words, for the strip above the composer. */
  autoNote: string | null;

  /** Stop the current autonomous run without switching the mode off. */
  haltAutonomous: () => void;

  /**
   * Wandering: picture after picture out of what you like, until you stop it.
   *
   * Held here rather than in the screen for the same reason everything else
   * about the conversation is: the loop has to survive a tab switch, and
   * looking at the gallery while it runs is exactly what people do with it.
   */
  wandering: boolean;
  /** How many pictures this run has made, for the strip above the composer. */
  wanderRounds: number;

  /**
   * Accept the next proposal whatever the settings say.
   *
   * Set by "rewrite, then generate": that button says what to do with the
   * answer before the answer exists, and the prompt-button setting is about
   * what the *other* button does.
   */
  forceAccept: boolean;
  startWander: () => Promise<void>;
  stopWander: () => void;

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
  /**
   * Force the build_prompt tool, because the button was pressed.
   *
   * `fresh` throws the last prompt away first — the proposal on screen if there
   * is one, and the conversation's last one either way: the model is told not
   * to revise it but to compose the same idea differently, which is the way out
   * of a conversation that has converged on one picture. `instant` accepts what
   * comes back without showing it, whatever the prompt button's setting says.
   */
  askForPrompt: (options?: { fresh?: boolean; instant?: boolean }) => Promise<void>;
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
 * Renders the transcript has drawn, and who is waiting for one.
 *
 * Module-level rather than state: nothing renders differently for it, and it
 * has to outlive the screen — the picture arrives while you are in the gallery
 * just as often as while you are looking at the chat.
 */
const shown = new Set<string>();
const waiting = new Map<string, (() => void)[]>();

/** How long to wait for a picture to appear before carrying on without it. */
const SHOWN_CEILING_MS = 20_000;

/** How many rounds in a row a wandering run may make nothing before giving up. */
const BARREN_WANDER_ROUNDS = 3;
/** And how long to leave it before trying again, so a failing run is not a spin. */
const BARREN_WANDER_PAUSE_MS = 2_000;

/**
 * Wait until the picture is on screen, or until waiting stops being sensible.
 *
 * The point of the whole sequence: the render is yours to look at first, and
 * only then does the model get it. Bounded, because a picture that fails to
 * load must not leave the conversation silent for ever — after the ceiling the
 * turn happens anyway, which is what it did before any of this existed.
 */
async function waitForPicture(generationId: string): Promise<void> {
  if (shown.has(generationId)) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(ceiling);
      resolve();
    };

    const list = waiting.get(generationId) ?? [];
    list.push(finish);
    waiting.set(generationId, list);

    const ceiling = setTimeout(finish, SHOWN_CEILING_MS);
  });
}

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

/**
 * Whether a failure is the connection going away rather than something wrong.
 *
 * `fetch` rejects with a bare `TypeError` for every transport-level problem,
 * and the message is whatever the engine feels like: Safari says "Load failed",
 * Chrome "Failed to fetch", Firefox "NetworkError when attempting to fetch
 * resource". None of them mean the server is broken — the commonest cause by
 * far is the page being suspended while you look at something else.
 */
function droppedConnection(cause: unknown): boolean {
  if (cause instanceof DOMException && cause.name === 'AbortError') return true;
  if (cause instanceof TypeError) return true;
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  return /load failed|failed to fetch|network ?error|connection|aborted/i.test(message);
}

/**
 * Why an autonomous run has stopped short of the threshold.
 *
 * Written for the strip above the composer, which is the only place a run that
 * has quietly stopped would otherwise be distinguishable from one still going.
 */
function stoppedBecause(call: ChatToolCall, state: { autoRounds: number; mode: ChatMode }): string {
  if (call.tool === 'ask_user') return 'It asked a question, so it is waiting for you.';
  if (call.tool !== 'build_prompt' && call.tool !== 'revise_prompt') {
    return 'It proposed something that needs you.';
  }
  return `Stopped after ${state.autoRounds} of ${state.mode.autonomous.maxRounds} rounds. The last proposal is waiting.`;
}

export const useChatStore = create<ChatStore>((set, get) => {
  /**
   * Whether the app accepts this proposal itself.
   *
   * Two reasons it might, and they are different things. The ✦ button is an
   * instruction you just gave — you asked for a prompt and said "queue it" —
   * and applies to exactly the call it asked for. An autonomous run is standing
   * permission to accept the model's own rewrites until a render clears the
   * perfectionism threshold, which is the loop this whole mode is.
   */
  const decideAutoAccept = (call: ChatToolCall): boolean => {
    const { mode, askedForPrompt, autoRounds, autoHalted, wandering, forceAccept } = get();

    // Asked for by name: "rewrite, then generate" is not a preference to weigh.
    if (forceAccept && call.tool === 'build_prompt') return true;

    /*
     * A wandering round is accepted without asking, always.
     *
     * There is nobody to ask: the whole mode is "show me things", and a dialog
     * between every picture would make it a mode about tapping.
     */
    if (wandering && call.tool === 'build_prompt' && call.fromWander) return true;

    if (call.tool === 'build_prompt' && askedForPrompt && mode.promptButton === 'generate') {
      return true;
    }
    if (!mode.autonomous.enabled || autoHalted) return false;
    // A question is the one proposal nobody else can answer.
    if (call.tool !== 'build_prompt' && call.tool !== 'revise_prompt') return false;
    return autoRounds < mode.autonomous.maxRounds;
  };

  /**
   * Record a decision, wait out any render it started, and carry on.
   *
   * Split out of `resolveTool` because a decision does not always come from a
   * dialog: the app makes some of them itself — the ✦ button, an autonomous
   * round, a wandering one — and those used to be made *by* the dialog, in a
   * component. Switching to another tab unmounted the screen, the dialog never
   * mounted, and a wandering run stopped without a word. Everything that
   * decides now goes through here, and nothing about it needs a screen.
   */
  const settle = async (
    chatId: string,
    messageId: string,
    body: Omit<Parameters<typeof api.resolveTool>[1], 'messageId'>,
  ): Promise<void> => {
    try {
      await api.resolveTool(chatId, { messageId, ...body });
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : 'Could not record that' });
      return;
    }

    /*
     * A decision that started a render is answered when the render is over.
     *
     * The model's turn after an accepted prompt is *about* the picture — and
     * replying while it is still sampling meant talking about something nobody
     * had seen, including itself.
     */
    const startedRun = body.generationId;
    if (typeof startedRun === 'string' && startedRun !== '') {
      set({ waitingFor: startedRun });
      /*
       * Re-read now, not after the render: the message carrying the run's id is
       * what puts the progress bar on screen, and the whole wait is the part
       * worth watching.
       */
      await get().refresh();
      if (get().chat?.id !== chatId) return;
      await waitForGeneration(startedRun, () => get().chat?.id === chatId);
      if (get().chat?.id !== chatId) return;

      await get().refresh();
      /*
       * The picture goes on screen before the model is told anything — except
       * where nothing is going to be told.
       *
       * Waiting for a render to be *drawn* is what keeps a judgement of a
       * picture from arriving before the picture. A wandering round makes no
       * judgement, and waiting for a paint that cannot happen while the screen
       * is unmounted would stall the loop for the twenty seconds that wait
       * takes to give up — every round, every time you look at something else.
       */
      if (!get().wandering) await waitForPicture(startedRun);
      if (get().chat?.id !== chatId) return;
      set({ waitingFor: null });
    }

    /*
     * A wandering round says nothing about the picture it just made.
     *
     * The follow-up turn is where the model comments on a render, and in this
     * mode there is nothing to comment to: the next thing wanted is the next
     * picture. So the round simply ends — counted, so the run above knows it
     * produced something — and `startWander` asks for the next one. Asking for
     * it from here is what used to happen, and it could not work: this code
     * runs inside the round's own stream, and a round refuses to start while
     * another is open. The loop hit that guard, returned, and the run stopped
     * after exactly one picture.
     */
    if (get().wandering && body.decision === 'accepted' && body.generationId) {
      set((state) => ({ wanderRounds: state.wanderRounds + 1 }));
      return;
    }

    // After a decision the model usually has something short to say about it.
    await stream(
      () =>
        fetch(`/api/chat/conversations/${chatId}/continue`, {
          method: 'POST',
          credentials: 'same-origin',
          signal: inFlight?.signal,
        }),
      chatId,
    );
  };

  /**
   * Queue a prompt the app decided to accept, with no dialog in the way.
   *
   * The dialog is where *you* accept one; this is the same work for the calls
   * nobody is going to look at. Deliberately not "mount the dialog and press
   * its button": that is what put the loop inside a component.
   */
  const acceptPrompt = async (
    chatId: string,
    messageId: string,
    call: Extract<ChatToolCall, { tool: 'build_prompt' | 'revise_prompt' }>,
  ): Promise<void> => {
    const settings = await api.settings().catch(() => null);
    const forced =
      call.tool === 'build_prompt' && call.fromWander
        ? settings?.chat.wander.workflowId || undefined
        : undefined;

    let generationId: string | null = null;
    try {
      const target = await resolveTarget(settings, forced);
      if (!target) {
        throw new Error('No workflow is switched on, so there is nothing to generate with');
      }
      generationId = await queuePrompt(target, call.prompt, call.negativePrompt);
    } catch (cause) {
      /*
       * A failure here stops the loop rather than spinning it.
       *
       * Whatever went wrong — no workflow, ComfyUI unreachable — will go wrong
       * again next round, and an endless run of failures is worse than a
       * stopped one with a message.
       */
      set({
        error: cause instanceof Error ? cause.message : 'Could not queue that',
        wandering: false,
        autoHalted: true,
      });
      return;
    }

    await settle(chatId, messageId, {
      decision: 'accepted',
      note:
        `The user accepted the ${call.tool === 'revise_prompt' ? 'revised ' : ''}prompt and ` +
        `queued it: "${call.prompt.slice(0, 200)}"`,
      ...(generationId ? { generationId } : {}),
      prompt: call.prompt,
    });
  };

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
    if (!call) {
      set({ chat: refreshed });
      return;
    }

    /*
     * A reply with no proposal in it is where an autonomous run ends.
     *
     * That is the exit condition the user set: the model was shown the render,
     * marked it against the prompt, and did not reach for a rewrite — which
     * means it cleared the threshold. Nothing to do but say so.
     */
    const auto = decideAutoAccept(call.call);

    /*
     * An accepted proposal never becomes a dialog.
     *
     * It used to: the call was put on screen with a flag telling the dialog to
     * press its own button, which flickered for the moment it took and — worse
     * — made the queueing depend on a component being mounted. Tab away and the
     * dialog was never rendered, so nothing was queued, so a wandering run
     * stopped. The work happens here now, and the transcript's progress bar is
     * the feedback.
     */
    if (auto && (call.call.tool === 'build_prompt' || call.call.tool === 'revise_prompt')) {
      const accepted = call.call;
      set((state) => ({
        chat: refreshed,
        autoNote: null,
        askedForPrompt: false,
        autoRounds: state.mode.autonomous.enabled ? state.autoRounds + 1 : state.autoRounds,
      }));
      await acceptPrompt(chatId, call.messageId, accepted);
      return;
    }

    set((state) => ({
      chat: refreshed,
      pendingCall: call,
      // A rewrite waits folded away; see the comment above.
      callMinimized: call.call.tool === 'revise_prompt',
      ...(state.mode.autonomous.enabled && !state.autoHalted
        ? { autoNote: stoppedBecause(call.call, state) }
        : {}),
    }));
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
        /*
         * A dropped connection is not a failure to report.
         *
         * Leaving the tab — or locking the phone — suspends the page, and the
         * browser kills the open stream underneath it. What came back was
         * "Load failed", shown in red next to a chat that was working
         * perfectly, on a server that was still running. The reply itself is
         * not lost: the server keeps what the model had produced, so the
         * honest response is to re-read the conversation and show that, which
         * is what happens for every other outcome here anyway.
         */
        if (!droppedConnection(cause)) {
          set({ error: cause instanceof Error ? cause.message : 'The model did not answer' });
        }
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
    asking: false,
    waitingFor: null,
    callMinimized: false,
    mode: { autonomous: { enabled: false, maxRounds: 0 }, promptButton: 'dialog' },
    autoRounds: 0,
    autoHalted: false,
    autoNote: null,
    wandering: false,
    wanderRounds: 0,
    forceAccept: false,

    notePictureShown: (generationId) => {
      shown.add(generationId);
      for (const waiter of waiting.get(generationId) ?? []) waiter();
      waiting.delete(generationId);
    },

    setMode: (mode) => set({ mode }),

    /*
     * Folding a proposal away by hand is taking the wheel back.
     *
     * It means "not this one, not yet", and an app that then accepted it two
     * seconds later would be ignoring the clearest instruction available.
     */
    minimizeCall: () => set({ callMinimized: true }),
    restoreCall: () => set({ callMinimized: false }),

    haltAutonomous: () =>
      set({ autoHalted: true, autoNote: 'Stopped. Say something to go on.' }),

    /**
     * Start wandering, and keep going until something stops it.
     *
     * One round is one call: ask the server for a prompt built from a few notes
     * drawn at random, queue it, wait for the picture. All of that happens
     * inside the round's stream — `consume` accepts the proposal and `settle`
     * waits out the render — so when the request resolves, the round is over
     * and the next one can be asked for.
     *
     * A plain `while` here, deliberately. It used to be event-driven, with the
     * end of a round asking for the next one, and that meant the loop lived
     * partly in a component and partly inside its own stream: neither could
     * start a round, because a round refuses to start while another is open.
     * Nothing in this loop touches the screen, which is the point — it keeps
     * turning while you are looking at the gallery, or at another app.
     */
    startWander: async () => {
      const { chat, wandering, streaming } = get();
      if (!chat || wandering || streaming || inFlight) return;
      const chatId = chat.id;

      set({ wandering: true, wanderRounds: 0, error: null, autoNote: null });

      /*
       * A round that made nothing is worth retrying, but not for ever.
       *
       * The usual cause is a reply with no proposal in it, or a stream the
       * browser cut off while the page was suspended — both worth another go.
       * A run that cannot make a picture at all is not, and without a ceiling
       * it would ask again as fast as the server can say no.
       */
      let barren = 0;
      while (get().wandering && get().chat?.id === chatId) {
        const before = get().wanderRounds;

        await stream(
          () =>
            fetch(`/api/chat/conversations/${chatId}/wander`, {
              method: 'POST',
              credentials: 'same-origin',
              signal: inFlight?.signal,
            }),
          chatId,
        );

        if (!get().wandering || get().chat?.id !== chatId) return;
        if (get().wanderRounds > before) {
          barren = 0;
          continue;
        }

        barren += 1;
        if (barren >= BARREN_WANDER_ROUNDS) {
          set({
            wandering: false,
            error: get().error ?? 'Wandering stopped: the last few rounds made no picture.',
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, BARREN_WANDER_PAUSE_MS));
      }
    },

    /*
     * Stopping is immediate, including the round in flight.
     *
     * The picture already rendering is not thrown away — it lands in the
     * transcript like any other — but nothing new is asked for, and the request
     * still open is cut off rather than left to arrive after you have gone.
     */
    stopWander: () => {
      if (!get().wandering) return;
      inFlight?.abort();
      inFlight = null;
      set({ wandering: false, streaming: null });
    },

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
        autoRounds: 0,
        autoHalted: false,
        autoNote: null,
        wandering: false,
        wanderRounds: 0,
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
        autoRounds: 0,
        autoHalted: false,
        autoNote: null,
        wandering: false,
        wanderRounds: 0,
        forceAccept: false,
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
      /*
       * Saying something starts the run over.
       *
       * The round count is per run and a run is what happens between two things
       * you say — so a stopped loop is released by talking to it, and a long
       * session does not slowly exhaust its budget on renders from an hour ago.
       */
      // Saying something is taking over, so a wandering run stands aside.
      set({
        error: null,
        attachments: [],
        autoRounds: 0,
        autoHalted: false,
        autoNote: null,
        wandering: false,
      });

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
    askForPrompt: async (options = {}) => {
      const { chat, streaming, pendingCall } = get();
      if (!chat || streaming || inFlight) return;

      /*
       * "A different one" starts by throwing this one away.
       *
       * Rejecting it properly rather than dropping it: the model is told, and
       * "they threw that away" is exactly the context that stops the next
       * attempt from being the same prompt with two words moved.
       */
      if (options.fresh && pendingCall) {
        set({ pendingCall: null, callMinimized: false });
        try {
          await api.resolveTool(chat.id, {
            messageId: pendingCall.messageId,
            decision: 'rejected',
            note: 'The user threw that prompt away and asked for a different composition.',
          });
        } catch {
          // Already decided, or gone. What matters next is the new prompt.
        }
      }

      // The button is a fresh instruction, so it releases a halted run too.
      set({
        error: null,
        askedForPrompt: true,
        asking: true,
        forceAccept: options.instant === true,
        autoRounds: 0,
        autoHalted: false,
        autoNote: null,
        wandering: false,
      });
      try {
        await stream(
          () =>
            fetch(`/api/chat/conversations/${chat.id}/build`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ fresh: options.fresh === true }),
              signal: inFlight?.signal,
            }),
          chat.id,
        );
      } finally {
        // Whatever came of it, the button has stopped being pressed.
        set({ asking: false, forceAccept: false });
      }
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
      // Stopping the reply stops the loop it belongs to. Pressing ■ while a
      // run is accepting its own prompts and having it queue another one would
      // be the button not working.
      set({
        streaming: null,
        autoHalted: true,
        wandering: false,
        ...(get().mode.autonomous.enabled ? { autoNote: 'Stopped. Say something to go on.' } : {}),
      });
      await get().refresh();
    },

    resolveTool: async (body) => {
      const { chat, pendingCall } = get();
      if (!chat || !pendingCall) return;

      /*
       * Every decision that reaches here is one you made.
       *
       * The app's own go straight through `acceptPrompt`, so a dialog being
       * answered means somebody answered it — and a mode whose whole content is
       * "decide for me" has nothing left to do until you hand it back, which
       * saying something does.
       */
      set({
        pendingCall: null,
        askedForPrompt: false,
        callMinimized: false,
        autoHalted: true,
        autoNote: 'You took that one. Say something to go on.',
      });

      await settle(chat.id, pendingCall.messageId, body);
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

/*
 * Coming back to the app re-reads the conversation.
 *
 * A suspended page has its open stream killed, so what is on screen when you
 * return is whatever had arrived when you left — possibly half a sentence, with
 * the rest of the reply sitting finished on the server. Re-reading on the way
 * back is the cheapest possible repair, and it costs one request nobody waits
 * for. Skipped while a request is in flight, which is the case where what is on
 * screen is already the truth.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || inFlight) return;
    void useChatStore.getState().refresh();
  });
}

/** True when a reply is arriving, for the composer's Stop button. */
export const selectStreaming = (state: ChatStore) => state.streaming;
