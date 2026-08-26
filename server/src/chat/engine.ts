import { randomUUID } from 'node:crypto';

import type {
  ChatEvent,
  ChatMessage,
  ChatPartialReply,
  ChatRun,
  ChatToolCall,
  ChatToolResult,
  ProposedBlock,
} from '@latent/shared';
import { DEFAULT_WANDER_DRAW, IDLE_RUN } from '@latent/shared';

import type { AppContext } from '../routes/context.js';
import { drawTaste } from '../taste.js';
import { resolveProposedBlocks } from './blocks.js';
import { START_OVER_INSTRUCTION, wanderInstruction } from './llama.js';
import { queueChatPrompt } from './queue.js';
import { runTurn, type TurnKind } from './turn.js';

/**
 * The conversation loop, on the server.
 *
 * Everything this module does used to be done by the browser: post a message,
 * read the reply, work out whether to accept the proposal, queue the render,
 * record the decision, wait for the picture, ask for the follow-up turn, go
 * round again. Written that way it worked perfectly while you were looking at
 * it and fell over the moment you were not — a backgrounded tab is frozen, its
 * open streams are cut, its timers slow to a crawl, and the step between two
 * `await`s never runs. A picture-after-picture mode that stops when you look at
 * something else is not a picture-after-picture mode.
 *
 * The rule here is that a conversation makes progress on its own. A client
 * sends an intent — say this, start wandering, accept that — and then has no
 * further part in it. It may watch, and what it watches is a stream of what is
 * happening rather than a transcript of a request it made; it may go away and
 * come back to find three more pictures made. Nothing waits for a browser
 * except the one thing that genuinely has to, which is showing you a picture
 * before the model is told about it, and that has a timeout.
 *
 * One runner per conversation, one step at a time. The state is persisted at
 * every transition, so a restart resumes instead of forgetting, and so two tabs
 * cannot disagree about what is going on.
 */

/** How long a wandering run waits for a render before giving up on it. */
const RENDER_CEILING_MS = 30 * 60 * 1000;

/**
 * How long the follow-up turn waits for the browser to draw the picture.
 *
 * The rule it serves is that you see a render before the model says anything
 * about it — otherwise the conversation is discussing something you have not
 * been shown. It is a courtesy with a deadline: nothing may hold a run open
 * because a page failed to load an image, and a run with nobody watching skips
 * the wait entirely rather than sitting out the full twenty seconds.
 */
const SHOWN_CEILING_MS = 20_000;

/** How many rounds in a row a wandering run may make nothing before giving up. */
const BARREN_ROUNDS = 3;
/** And how long to leave it before trying again, so a failing run is not a spin. */
const BARREN_PAUSE_MS = 2_000;

/** What a client asks for. Everything else is worked out from the state. */
export type ChatIntent =
  | { type: 'say'; content: string; attachments?: ChatMessage['attachments'] }
  /** The ✦ button: ask for a prompt. `instant` queues it without a dialog. */
  | { type: 'prompt'; fresh?: boolean; instant?: boolean }
  | { type: 'wander'; on: boolean }
  /**
   * The ∞ button: carry on by itself.
   *
   * An intent rather than a settings patch, because it has to do something to
   * the run in front of it as well as to the setting — a conversation already
   * parked on a proposal is exactly the case where "turn autonomy on" has to
   * mean "and take this one".
   */
  | { type: 'autonomous'; on: boolean }
  | {
      type: 'decide';
      messageId: string;
      decision: ChatToolResult['decision'];
      blocks?: ProposedBlock[];
      note?: string;
      prompt?: string;
      workflowId?: string;
    }
  | { type: 'stop' };

interface Subscriber {
  send: (event: ChatEvent) => void;
}

/**
 * What an intent came to.
 *
 * `conflict` is its own answer rather than an error string because the caller
 * has to tell it apart: deciding a proposal that has already been decided is
 * not a mistake to report, it is a double tap or a second phone, and the right
 * response is to say so and let the client re-read rather than to show a
 * failure for something that already happened.
 */
export interface IntentResult {
  error?: string;
  conflict?: boolean;
}

/**
 * One conversation, and whatever it is currently doing.
 *
 * Held in memory only for the parts that cannot be persisted usefully: who is
 * watching, the half-finished sentence, and the abort handle for a turn in
 * flight. Everything that decides what happens next is in the database.
 */
class Runner {
  private readonly subscribers = new Set<Subscriber>();
  private partial: ChatPartialReply | null = null;
  private turn: AbortController | null = null;
  private advancing = false;
  /** Set while a step is waiting for something; called to give up on it. */
  private release: (() => void) | null = null;
  private shown = new Set<string>();
  /**
   * The process is going away.
   *
   * Distinct from stopping a run: a stopped run is written down as stopped and
   * picked up as stopped, while this leaves the state exactly as it is so the
   * next process can resume it. All it does is stop *this* one touching a
   * database that is about to close under it.
   */
  private closed = false;

  constructor(
    private readonly ctx: AppContext,
    readonly chatId: string,
    private readonly onIdle: (chatId: string) => void,
  ) {}

  get run(): ChatRun {
    return this.ctx.store.getChatRun(this.chatId);
  }

  /** Put it down where it stands, for a server that is shutting down. */
  close(): void {
    this.closed = true;
    this.turn?.abort();
    this.release?.();
    this.subscribers.clear();
  }

  get watched(): boolean {
    return this.subscribers.size > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Watching                                                          */
  /* ---------------------------------------------------------------- */

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    // Whatever is true right now, before any delta — so a client that has just
    // connected, just reconnected and one asleep for an hour take one path.
    subscriber.send({ type: 'sync', run: this.run, partial: this.partial });
    /*
     * The switch can also be flipped somewhere this conversation never hears
     * about — Settings has the same toggle, and it patches the setting without
     * any intent reaching here. A run parked on a proposal would then sit
     * there, because being parked is precisely the state with no next
     * transition to notice the change. Coming back to the conversation is the
     * next chance to act on it, so it is taken.
     */
    void this.reconcile();
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Take up a proposal that autonomy would already have taken.
   *
   * Deliberately narrow: it only ever *starts* something the settings say
   * should have started, and only from a standstill. It never stops anything,
   * so arriving with the switch off leaves a run exactly as it was.
   */
  private async reconcile(): Promise<void> {
    if (this.closed || !this.autoEnabled()) return;
    const run = this.run;
    if (run.mode === 'wander' || run.phase !== 'awaiting' || !run.awaiting) return;
    if (run.round >= this.ctx.store.getSettings().chat.autonomous.maxRounds) return;
    await this.takeUpWaiting(run.awaiting);
  }

  private emit(event: ChatEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.send(event);
      } catch {
        // A dead connection is not this conversation's problem; the stream's
        // own close handler will take it out of the set.
      }
    }
  }

  /** Write the state and tell everyone, which must never happen separately. */
  private setRun(patch: Partial<ChatRun>): ChatRun {
    // Nothing is written after close: whatever the state was is what the next
    // process should resume from, not a half-transition made on the way out.
    if (this.closed) return this.run;
    const merged = { ...this.run, ...patch };
    /*
     * `auto` versus `manual` is not this run's to remember.
     *
     * It used to be decided once, when the run started, and then carried for
     * the rest of it — while the strip on the screen read the setting. Flip the
     * switch at any moment other than just before speaking and the two said
     * different things: the strip announced a run carrying on by itself, and
     * the loop stopped at the next proposal and waited to be tapped. That is
     * the whole of "sometimes it iterates and sometimes it does not".
     *
     * So it is derived here instead, on every transition, and `wander` is left
     * alone because that one really is a kind of run rather than a preference.
     */
    const run: ChatRun =
      merged.mode === 'wander' ? merged : { ...merged, mode: this.autoMode() };
    this.ctx.store.setChatRun(this.chatId, run);
    this.emit({ type: 'run', run });
    return run;
  }

  /** Whether runs carry on by themselves, as the setting says right now. */
  private autoEnabled(): boolean {
    return this.ctx.store.getSettings().chat.autonomous.enabled;
  }

  private autoMode(): ChatRun['mode'] {
    return this.autoEnabled() ? 'auto' : 'manual';
  }

  /** A render has been drawn on somebody's screen. */
  noteShown(generationId: string): void {
    this.shown.add(generationId);
    this.release?.();
  }

  /* ---------------------------------------------------------------- */
  /* Intents                                                           */
  /* ---------------------------------------------------------------- */

  async accept(intent: ChatIntent): Promise<IntentResult> {
    switch (intent.type) {
      case 'say':
        return this.say(intent);
      case 'prompt':
        return this.askForPrompt(intent);
      case 'wander':
        return this.setWandering(intent.on);
      case 'autonomous':
        return this.setAutonomous(intent.on);
      case 'decide':
        return this.decide(intent);
      case 'stop':
        return this.stop();
    }
  }

  private async say(intent: Extract<ChatIntent, { type: 'say' }>): Promise<IntentResult> {
    const chat = this.ctx.store.getChat(this.chatId);
    if (!chat) return { error: 'No such conversation' };

    /*
     * Saying something else is an answer to a proposal nobody decided.
     *
     * The honest reading of "carry on talking instead" is that you do not want
     * it — and leaving it pending would mean the next thing you say arrives in
     * a conversation the model thinks is still waiting on a decision, which is
     * a state chat templates handle badly and people handle worse.
     */
    const run = this.run;
    if (run.awaiting) {
      this.settleCall(run.awaiting, {
        decision: 'rejected',
        note: 'The user did not take that up and said something else instead.',
      });
    }

    this.abortTurn();
    this.ctx.store.insertChatMessage(chat.id, {
      id: randomUUID(),
      role: 'user',
      content: intent.content,
      ...(intent.attachments?.length ? { attachments: intent.attachments } : {}),
      createdAt: Date.now(),
    });
    this.emit({ type: 'message', messageId: '' });

    // The first thing said names the conversation, so a list of them is
    // scannable without opening each one.
    if (chat.title === '') this.ctx.store.renameChat(chat.id, intent.content || 'Picture');

    /*
     * Saying something takes over: a wandering run stands aside, an autonomous
     * one starts its count again. A run is what happens between two things you
     * say, so a stopped loop is released by talking to it and a long session
     * does not slowly exhaust its budget on renders from an hour ago.
     */
    // `mode` is derived in `setRun`, so it always matches the setting.
    this.setRun({ ...IDLE_RUN, phase: 'thinking', want: 'reply' });
    void this.advance();
    return {};
  }

  private async askForPrompt(
    intent: Extract<ChatIntent, { type: 'prompt' }>,
  ): Promise<IntentResult> {
    const run = this.run;

    /*
     * "A different one" starts by throwing this one away.
     *
     * Rejected properly rather than dropped: the model is told, and "they threw
     * that away" is exactly the context that stops the next attempt from being
     * the same prompt with two words moved.
     */
    if (intent.fresh && run.awaiting) {
      this.settleCall(run.awaiting, {
        decision: 'rejected',
        note: 'The user threw that prompt away and asked for a different composition.',
      });
    }

    this.abortTurn();
    // The button is a fresh instruction, so it releases a halted run too.
    this.setRun({
      phase: 'thinking',
      round: 0,
      want: intent.fresh ? 'freshPrompt' : 'prompt',
      /*
       * Asked for by name, or by the setting.
       *
       * "Generate now" is the second icon above the button and says so
       * outright; the plain press follows Settings → Chat → what the prompt
       * button does, which is the same question answered once instead of every
       * time. Both end up here, because from the loop's point of view they are
       * one instruction: do not stop to show me this one.
       */
      autoAccept:
        intent.instant === true ||
        this.ctx.store.getSettings().chat.promptButton === 'generate',
      note: null,
      error: null,
      awaiting: null,
    });
    void this.advance();
    return {};
  }

  /**
   * Turning "carry on by itself" on or off, from the chat itself.
   *
   * The setting is written here rather than patched separately, so there is one
   * write and no window where the screen and the loop disagree about it.
   *
   * Then it engages, whatever step the loop is on. A live reading of the
   * setting is enough everywhere else — every transition passes through
   * `setRun` — but a run parked on a proposal has no next transition to be
   * caught by: it is waiting for a tap that autonomy is supposed to make
   * unnecessary. So the thing on the table is taken up here.
   */
  private async setAutonomous(on: boolean): Promise<IntentResult> {
    const settings = this.ctx.store.getSettings();
    if (settings.chat.autonomous.enabled !== on) {
      this.ctx.store.updateSettings({
        chat: {
          ...settings.chat,
          autonomous: { ...settings.chat.autonomous, enabled: on },
          /*
           * The review is what ends a run, so turning this on with it off would
           * be a switch that quietly does nothing.
           */
          ...(on && !settings.chat.review.enabled
            ? { review: { ...settings.chat.review, enabled: true } }
            : {}),
        },
      });
    }

    const run = this.run;
    if (!on || run.mode === 'wander') {
      // Normalises the mode; nothing else to do. A wandering run is not the
      // thing this switch is about, and turning it off simply stops the next
      // proposal being taken automatically.
      this.setRun({});
      return {};
    }

    /*
     * A spent budget must not make the switch a no-op.
     *
     * Reaching `maxRounds` is what left this run waiting in the first place, so
     * engaging with the count still at the cap would look exactly like the
     * fault being fixed: the strip says it is carrying on, and it does not.
     * Turning it on is fresh permission, so it gets a fresh count.
     */
    const stalled = run.phase === 'awaiting' || run.phase === 'idle';
    this.setRun({ ...(stalled ? { round: 0, note: null } : {}) });

    if (run.phase === 'awaiting' && run.awaiting) {
      return this.takeUpWaiting(run.awaiting);
    }
    return {};
  }

  /**
   * Accept the proposal a run is sitting on, as autonomy would have done.
   *
   * Only a prompt: a question needs an answer that nothing here has, and a
   * block proposal changes a library rather than making a picture. Both are
   * left where they are — see `stoppedBecause`, which is what tells you why.
   */
  private async takeUpWaiting(messageId: string): Promise<IntentResult> {
    const chat = this.ctx.store.getChat(this.chatId);
    const message = chat?.messages.find((candidate) => candidate.id === messageId);
    const call = message?.toolCall;
    if (!call || message?.toolResult) return {};
    if (call.tool !== 'build_prompt' && call.tool !== 'revise_prompt') return {};

    return this.decide({ type: 'decide', messageId, decision: 'accepted' });
  }

  private async setWandering(on: boolean): Promise<IntentResult> {
    if (!on) return this.stop();

    const run = this.run;
    if (run.mode === 'wander') return {};
    this.abortTurn();
    this.setRun({ ...IDLE_RUN, mode: 'wander', phase: 'thinking' });
    void this.advance();
    return {};
  }

  private async decide(
    intent: Extract<ChatIntent, { type: 'decide' }>,
  ): Promise<IntentResult> {
    const chat = this.ctx.store.getChat(this.chatId);
    const message = chat?.messages.find((candidate) => candidate.id === intent.messageId);
    if (!message?.toolCall) return { error: 'No such tool call' };
    if (message.toolResult) {
      return { error: 'That has already been decided.', conflict: true };
    }

    /*
     * Queueing and recording are one act.
     *
     * They were two, in the browser, and a page that died between them left a
     * proposal with no answer in a conversation that could not continue. Here
     * the render is started first and the decision written with its id, so
     * either both happened or neither did.
     */
    let generationId: string | null = null;
    if (
      intent.decision === 'accepted' &&
      (message.toolCall.tool === 'build_prompt' || message.toolCall.tool === 'revise_prompt')
    ) {
      const prompt = intent.prompt?.trim() || message.toolCall.prompt;
      const queued = await queueChatPrompt(this.ctx, prompt, {
        ...(intent.workflowId ? { workflowId: intent.workflowId } : {}),
        ...(message.toolCall.negativePrompt
          ? { negativePrompt: message.toolCall.negativePrompt }
          : {}),
      });
      if (queued.error && !queued.generationId) {
        this.setRun({ phase: 'awaiting', error: queued.error, awaiting: intent.messageId });
        return { error: queued.error };
      }
      generationId = queued.generationId;

      this.settleCall(intent.messageId, {
        decision: 'accepted',
        note:
          intent.note?.trim() ||
          `The user accepted the ${
            message.toolCall.tool === 'revise_prompt' ? 'revised ' : ''
          }prompt and queued it: "${prompt.slice(0, 200)}"`,
        ...(generationId ? { generationId } : {}),
        prompt,
      });
    } else {
      this.settleCall(intent.messageId, {
        decision: intent.decision,
        ...(intent.blocks ? { blocks: intent.blocks } : {}),
        ...(intent.note ? { note: intent.note } : {}),
      });
    }

    /*
     * A question asked while looking at a picture is still about that picture.
     *
     * Answering it lands the conversation on an ordinary tool response, which
     * would end the review — and the answer is exactly the thing that makes the
     * rewrite worth proposing. So the turn after one of those is a review turn
     * too, with the same picture and the same offer.
     */
    const stillReviewing =
      message.toolCall.tool === 'ask_user' && message.toolCall.fromReview === true;

    this.setRun(
      generationId
        ? { phase: 'generating', generationId, awaiting: null, error: null }
        : {
            phase: 'thinking',
            awaiting: null,
            error: null,
            want: stillReviewing ? 'afterRender' : 'reply',
          },
    );
    void this.advance();
    return {};
  }

  private async stop(): Promise<IntentResult> {
    this.abortTurn();
    /*
     * Stopping is immediate, including the round in flight.
     *
     * A picture already rendering is not thrown away — it lands in the
     * transcript like any other — but nothing new is asked for, and a step
     * waiting on something is let go rather than left to arrive after you have
     * gone.
     */
    this.release?.();
    this.setRun({ ...IDLE_RUN, mode: 'manual', note: null });
    return {};
  }

  private abortTurn(): void {
    this.turn?.abort();
    this.turn = null;
    this.partial = null;
  }

  /* ---------------------------------------------------------------- */
  /* The loop                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Do whatever the state says is next, until there is nothing left to do.
   *
   * A plain loop over the persisted state rather than a chain of callbacks:
   * every iteration re-reads what the conversation is doing, so a stop, a new
   * message or a restart all take effect at the next step without anything
   * having to unwind. Guarded so one conversation only ever runs one step at a
   * time, however many intents arrive at once.
   */
  async advance(): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    let barren = 0;

    try {
      for (;;) {
        if (this.closed) break;
        const run = this.run;
        if (run.phase === 'idle' || run.phase === 'awaiting') break;

        if (run.phase === 'generating' && run.generationId) {
          await this.awaitRender(run.generationId);
          if (this.run.phase !== 'generating') continue;
          await this.awaitShown(run.generationId);
          if (this.run.phase !== 'generating') continue;

          /*
           * A wandering round says nothing about the picture it just made.
           *
           * The follow-up turn is where the model comments on a render, and in
           * this mode there is nothing to comment to: the next thing wanted is
           * the next picture. That is also what keeps a long run from filling
           * the transcript with small talk.
           */
          if (run.mode === 'wander') {
            this.setRun({ phase: 'thinking', round: run.round + 1, generationId: null });
            continue;
          }
          this.setRun({ phase: 'thinking', generationId: null, want: 'afterRender' });
          continue;
        }

        const produced = await this.think();
        if (this.closed) break;
        if (!produced && this.run.mode === 'wander' && this.run.phase !== 'idle') {
          /*
           * A round that made nothing is worth retrying, but not for ever.
           *
           * The usual cause is a reply with no proposal in it. A run that
           * cannot make a picture at all is not worth retrying, and without a
           * ceiling it would ask again as fast as the server can say no.
           */
          barren += 1;
          if (barren >= BARREN_ROUNDS) {
            this.setRun({
              ...IDLE_RUN,
              note: 'Wandering stopped: the last few rounds made no picture.',
            });
            break;
          }
          await this.pause(BARREN_PAUSE_MS);
          continue;
        }
        barren = 0;
      }
    } finally {
      this.advancing = false;
      if (!this.closed && this.run.phase === 'idle') this.onIdle(this.chatId);
    }
  }

  /**
   * One turn, and what to do with what it proposed.
   *
   * Returns whether the round produced a render, which is the only thing the
   * loop above needs to know about it.
   */
  private async think(): Promise<boolean> {
    const run = this.run;
    const controller = new AbortController();
    this.turn = controller;
    this.partial = { content: '', thinking: '' };

    const kind = this.turnKind(run);
    const settings = this.ctx.store.getSettings().chat;

    const result = await runTurn(this.ctx, this.chatId, {
      kind,
      signal: controller.signal,
      ...(run.mode === 'wander' && settings.wander.sampling === 'own'
        ? { sampling: settings.wander.ownSampling }
        : {}),
      emit: (event) => {
        if (event.type === 'content' && this.partial) {
          this.partial.content += event.text;
          this.emit({ type: 'content', text: event.text });
        } else if (event.type === 'thinking' && this.partial) {
          this.partial.thinking += event.text;
          this.emit({ type: 'thinking', text: event.text });
        }
        // A tool call is not a delta anybody draws: it becomes either a dialog
        // or a queued render, and both of those are run-state changes.
      },
    });

    this.turn = null;
    this.partial = null;
    /*
     * The process went away while the model was answering.
     *
     * What it said is already stored — `runTurn` writes before returning — and
     * everything after this point is bookkeeping against a database that is
     * closing. The state stays as it is, which is what lets the next process
     * resume from it.
     */
    if (this.closed) return false;
    if (result.messageId) this.emit({ type: 'message', messageId: result.messageId });

    if (result.stopped) {
      this.setRun({ ...IDLE_RUN, mode: 'manual' });
      return false;
    }
    if (result.error) {
      this.setRun({ ...IDLE_RUN, mode: run.mode === 'wander' ? 'manual' : run.mode, error: result.error });
      return false;
    }

    if (!result.call || !result.messageId) {
      /*
       * A reply with no proposal in it is where an autonomous run ends.
       *
       * That is the exit condition the user set: the model was shown the
       * render, marked it against the prompt, and did not reach for a rewrite —
       * which means it cleared the threshold. Nothing to do but say so.
       */
      this.setRun({
        ...IDLE_RUN,
        mode: run.mode === 'wander' ? 'wander' : 'manual',
        round: run.round,
        // With the count, because "it finished" and "it finished after two"
        // are different things to come back to: one of them says the model
        // got there, the other that it nearly ran out of rope.
        ...(run.mode === 'auto'
          ? {
              note: `Cleared the mark after ${run.round} of ${
                this.ctx.store.getSettings().chat.autonomous.maxRounds
              } rounds.`,
            }
          : {}),
      });
      return false;
    }

    return this.handleCall(result.messageId, result.call, run);
  }

  /** What this turn is for, from the state rather than from the transcript. */
  private turnKind(run: ChatRun): TurnKind {
    if (run.mode === 'wander') {
      const settings = this.ctx.store.getSettings().chat.wander;
      const rules = { ...DEFAULT_WANDER_DRAW, ...(settings.draw ?? {}) };
      const profile = this.ctx.taste.profileOrNull();
      const chat = this.ctx.store.getChat(this.chatId);
      const drawn = profile
        ? drawTaste(profile, settings.attributes, {
            rules,
            exclude: recentWanderNotes(chat?.messages ?? [], rules.avoidRepeats),
          })
        : [];
      return {
        kind: 'wander',
        instruction: wanderInstruction(drawn.map((note) => note.text)),
        notes: drawn.map((note) => note.text),
        noteIds: drawn.map((note) => note.id),
      };
    }

    if (run.want === 'prompt') return { kind: 'forced', tool: 'build_prompt' };
    if (run.want === 'freshPrompt') {
      return { kind: 'forced', tool: 'build_prompt', instruction: START_OVER_INSTRUCTION };
    }
    if (run.want === 'afterRender') return { kind: 'afterRender' };
    return { kind: 'reply' };
  }

  /**
   * A proposal arrived. Either the app settles it, or a person has to.
   *
   * One place, rather than the two it used to be — the dialog decided some of
   * these and the store decided the rest, from flags that had to be kept in
   * step across a network boundary.
   */
  private async handleCall(
    messageId: string,
    call: ChatToolCall,
    run: ChatRun,
  ): Promise<boolean> {
    if (this.closed) return false;
    const settings = this.ctx.store.getSettings().chat;
    const prompt = call.tool === 'build_prompt' || call.tool === 'revise_prompt';

    const automatic =
      prompt &&
      // A wandering round is accepted without asking, always. There is nobody
      // to ask: the whole mode is "show me things", and a dialog between every
      // picture would make it a mode about tapping.
      (run.mode === 'wander' ||
        // Asked for by name: "generate now" is an instruction, not a preference.
        run.autoAccept ||
        /*
         * Standing permission, until a render clears the threshold.
         *
         * Read from the setting rather than from the run, so a switch flipped
         * while this very turn was being written still counts. The run's own
         * `mode` is derived from the same setting and would usually agree — but
         * "usually" is what made this unpredictable, and the decision is the
         * one place it has to be exact.
         */
        // (a wandering run has already matched above)
        (this.autoEnabled() && run.round < settings.autonomous.maxRounds));

    if (!automatic) {
      /*
       * An autonomous run that reaches something it cannot decide stops there
       * and says why, rather than leaving a dialog to be discovered.
       */
      this.setRun({
        phase: 'awaiting',
        awaiting: messageId,
        autoAccept: false,
        ...(run.mode === 'auto' ? { note: stoppedBecause(call, run, settings) } : {}),
      });
      return false;
    }

    const queued = await queueChatPrompt(this.ctx, call.prompt, {
      ...(run.mode === 'wander' && settings.wander.workflowId
        ? { workflowId: settings.wander.workflowId }
        : {}),
      ...(call.negativePrompt ? { negativePrompt: call.negativePrompt } : {}),
    });

    if (!queued.generationId) {
      /*
       * A failure here stops the loop rather than spinning it. Whatever went
       * wrong — no workflow, ComfyUI unreachable — will go wrong again next
       * round, and an endless run of failures is worse than a stopped one with
       * a message.
       */
      this.setRun({
        ...IDLE_RUN,
        phase: 'awaiting',
        mode: 'manual',
        awaiting: messageId,
        error: queued.error ?? 'Could not queue that.',
      });
      return false;
    }

    this.settleCall(messageId, {
      decision: 'accepted',
      note: `The user accepted the ${
        call.tool === 'revise_prompt' ? 'revised ' : ''
      }prompt and queued it: "${call.prompt.slice(0, 200)}"`,
      generationId: queued.generationId,
      prompt: call.prompt,
    });

    this.setRun({
      phase: 'generating',
      generationId: queued.generationId,
      awaiting: null,
      autoAccept: false,
      round: run.mode === 'auto' ? run.round + 1 : run.round,
    });
    return true;
  }

  /**
   * Record a decision, and tell the model.
   *
   * Both halves, always. Without the `tool` message the next turn has an
   * assistant message asking for a tool and no answer to it, which most
   * templates refuse outright.
   */
  private settleCall(
    messageId: string,
    input: {
      decision: ChatToolResult['decision'];
      blocks?: ProposedBlock[];
      note?: string;
      generationId?: string;
      prompt?: string;
    },
  ): void {
    if (this.closed) return;
    const chat = this.ctx.store.getChat(this.chatId);
    const message = chat?.messages.find((candidate) => candidate.id === messageId);
    if (!message?.toolCall || message.toolResult) return;

    let summary: string;
    if (input.decision === 'rejected') {
      summary = input.note?.trim() || 'The user declined.';
    } else if (message.toolCall.tool === 'prompt_blocks') {
      summary = applyBlocks(this.ctx, input.blocks ?? message.toolCall.blocks);
    } else if (message.toolCall.tool === 'ask_user') {
      // The answer *is* the result.
      summary = input.note?.trim() || 'The user did not answer.';
    } else {
      summary = input.note?.trim() || 'The user accepted the prompt and is generating it.';
    }

    this.ctx.store.setChatToolResult(message.id, { decision: input.decision, summary });
    this.ctx.store.insertChatMessage(this.chatId, {
      id: randomUUID(),
      role: 'tool',
      content: summary,
      toolCall: message.toolCall,
      // The run this decision started, so its pictures land in the transcript
      // at the point they were asked for rather than only in the gallery.
      ...(input.generationId ? { generationId: input.generationId } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      createdAt: Date.now(),
    });
    this.emit({ type: 'message', messageId: message.id });
  }

  /* ---------------------------------------------------------------- */
  /* Waiting                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Until the render is over, whatever became of it.
   *
   * Driven by the orchestrator's own callback rather than by polling, so this
   * costs nothing while it waits and cannot be throttled by anything. The
   * ceiling is there because a job lost between here and ComfyUI must not
   * silence a conversation for good.
   */
  private awaitRender(generationId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const record = this.ctx.store.getGeneration(generationId);
    if (record && record.status !== 'queued' && record.status !== 'running') return Promise.resolve();

    return this.waitFor((done) => {
      const unsubscribe = this.ctx.orchestrator.onSettled((settled) => {
        if (settled === generationId) done();
      });
      const ceiling = setTimeout(done, RENDER_CEILING_MS);
      ceiling.unref?.();
      return () => {
        unsubscribe();
        clearTimeout(ceiling);
      };
    });
  }

  /**
   * Until somebody has actually seen it — or until that stops being sensible.
   *
   * The point of the whole sequence: the render is yours to look at first, and
   * only then does the model get it. A judgement of a picture that arrives
   * before the picture is a judgement of nothing.
   *
   * Skipped outright when nobody is watching, which is the case the old version
   * got wrong: it waited the full twenty seconds for a paint that could not
   * happen, every round, every time you looked at something else.
   */
  private awaitShown(generationId: string): Promise<void> {
    if (this.shown.has(generationId) || !this.watched) return Promise.resolve();

    return this.waitFor((done) => {
      const ceiling = setTimeout(done, SHOWN_CEILING_MS);
      ceiling.unref?.();
      const poll = setInterval(() => {
        if (this.shown.has(generationId) || !this.watched) done();
      }, 250);
      poll.unref?.();
      return () => {
        clearTimeout(ceiling);
        clearInterval(poll);
      };
    });
  }

  private pause(ms: number): Promise<void> {
    return this.waitFor((done) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  }

  /**
   * Wait for something, and let `stop` cut it short.
   *
   * Every wait in this class goes through here so that exactly one of them can
   * be outstanding and stopping always reaches it. A wait nobody can interrupt
   * is how a "stop" button ends up meaning "stop after the next thirty
   * minutes".
   */
  private waitFor(begin: (done: () => void) => () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.release = null;
        resolve();
      };
      const cleanup = begin(done);
      this.release = done;
    });
  }
}

/**
 * The engine: every conversation that is doing something, and the way in.
 *
 * A registry rather than a singleton loop, because conversations are
 * independent: two of them wandering at once is two runs, and a step in one has
 * no business blocking the other.
 */
export class ChatEngine {
  private readonly runners = new Map<string, Runner>();

  constructor(private readonly ctx: AppContext) {}

  /**
   * Pick up whatever was in flight when the server stopped.
   *
   * A restart is indistinguishable from a crash from the database's side, so
   * the honest thing is to look at every conversation that was mid-something. A
   * run that was waiting on a render resumes waiting; a loop that was thinking
   * is asked again, because the transcript is intact and asking again is what
   * anyone would do. Only the manual case is left alone: a half-finished reply
   * to something you said is not worth re-asking without you.
   */
  resume(): void {
    for (const chatId of this.ctx.store.listUnsettledChats()) {
      const run = this.ctx.store.getChatRun(chatId);
      if (run.phase === 'thinking' && run.mode === 'manual') {
        this.ctx.store.setChatRun(chatId, {
          ...run,
          phase: 'idle',
          note: 'That reply was interrupted by a restart. Say something to go on.',
        });
        continue;
      }
      if (run.phase === 'awaiting') continue;
      void this.runner(chatId).advance();
    }
  }

  runner(chatId: string): Runner {
    const existing = this.runners.get(chatId);
    if (existing) return existing;
    const made = new Runner(this.ctx, chatId, (id) => {
      // Kept while it is doing something and while anybody is watching;
      // dropped otherwise, so a long-lived server does not accumulate one
      // object per conversation ever opened.
      const runner = this.runners.get(id);
      if (runner && !runner.watched) this.runners.delete(id);
    });
    this.runners.set(chatId, made);
    return made;
  }

  /** Forget one, because it has been deleted. */
  forget(chatId: string): void {
    this.runners.get(chatId)?.close();
    this.runners.delete(chatId);
  }

  /**
   * Put every run down, for a server that is shutting down.
   *
   * Without this an advance loop outlives the process that owns it and reaches
   * for a database that has already closed — which is not merely untidy: it is
   * the last thing a run does before it is resumed, and a write landing in that
   * window is a write into a file nobody is going to read.
   */
  close(): void {
    for (const runner of this.runners.values()) runner.close();
    this.runners.clear();
  }

  /**
   * Run a prompt from further up the conversation again.
   *
   * Not an intent, because it is not a step in the run: the model already had
   * its answer to that proposal, and a second tool response for one call is
   * what chat templates refuse. It borrows the queueing and nothing else.
   */
  queueAgain(prompt: string, workflowId?: string): ReturnType<typeof queueChatPrompt> {
    return queueChatPrompt(this.ctx, prompt, { ...(workflowId ? { workflowId } : {}) });
  }
}

/**
 * The notes the last few wandering rounds used, so this one can avoid them.
 *
 * Read back out of the conversation rather than held in memory: the rounds are
 * already recorded, this server is restarted often, and a run that forgets what
 * it just showed you the moment the process reloads is a run whose "don't
 * repeat yourself" setting does not work on the one machine it matters on.
 */
function recentWanderNotes(messages: ChatMessage[], rounds: number): string[] {
  const wanted = Math.max(0, Math.floor(rounds) || 0);
  if (wanted === 0) return [];

  const seen: string[] = [];
  let found = 0;
  for (let index = messages.length - 1; index >= 0 && found < wanted; index -= 1) {
    const call = messages[index]?.toolCall;
    if (call?.tool !== 'build_prompt' || !call.wanderNoteIds) continue;
    seen.push(...call.wanderNoteIds);
    found += 1;
  }
  return seen;
}

/**
 * Why an autonomous run has stopped short of the threshold.
 *
 * Written for the strip above the composer, which is the only place a run that
 * has quietly stopped is distinguishable from one still going.
 */
function stoppedBecause(
  call: ChatToolCall,
  run: ChatRun,
  settings: { autonomous: { maxRounds: number } },
): string {
  if (call.tool === 'ask_user') return 'It asked a question, so it is waiting for you.';
  if (call.tool !== 'build_prompt' && call.tool !== 'revise_prompt') {
    return 'It proposed something that needs you.';
  }
  return `Stopped after ${run.round} of ${settings.autonomous.maxRounds} rounds. The last proposal is waiting.`;
}

/**
 * Write the blocks the user kept.
 *
 * The list is the *edited* one from the client, not what the model proposed:
 * the point of the dialog is that a block can be corrected before it is saved,
 * and taking the model's version afterwards would throw that away.
 */
function applyBlocks(ctx: AppContext, proposed: ProposedBlock[]): string {
  let added = 0;
  let updated = 0;
  let removed = 0;
  const lost: string[] = [];

  /*
   * Matched against the library again, here at the end.
   *
   * It was matched once already when the proposal was made, but that can be
   * several turns and one visit to the library screen ago, so an id from then
   * is not something to delete a row on faith. Re-running it also means the
   * name a person corrected in the dialog is the name that gets looked up —
   * fixing a proposal the model got slightly wrong is the point of being able
   * to edit it, and it would be strange if the one field that identifies the
   * block were the one field editing could not help with.
   */
  const blocks = resolveProposedBlocks(proposed, ctx.store.listPromptBlocks());

  for (const block of blocks) {
    /*
     * Both of the old failures lived here. A removal whose id was never filled
     * in was skipped without a word, and a change whose id was never filled in
     * fell through to the insert below and quietly made a duplicate of the very
     * block it had been asked to correct.
     */
    if (block.action !== 'add') {
      if (block.missing || !block.id) {
        lost.push(block.name);
        continue;
      }

      if (block.action === 'remove') {
        ctx.store.deletePromptBlock(block.id);
        removed += 1;
      } else {
        ctx.store.updatePromptBlock(block.id, {
          name: block.name,
          category: block.category,
          text: block.text,
        });
        updated += 1;
      }
      continue;
    }

    ctx.store.insertPromptBlock(randomUUID(), {
      name: block.name,
      category: block.category,
      text: block.text,
    });
    added += 1;
  }

  const parts = [
    added > 0 ? `${added} added` : '',
    updated > 0 ? `${updated} changed` : '',
    removed > 0 ? `${removed} removed` : '',
  ].filter(Boolean);

  /*
   * Said plainly, including the part that did not work.
   *
   * This sentence is the tool result, which is the only thing the model ever
   * learns about what became of its proposal. "The user kept none of them"
   * after a removal that failed to find its block is a lie that reads as a
   * refusal, and the model's next move is to propose the same removal again.
   */
  const failed =
    lost.length > 0
      ? `Could not find ${lost.map((name) => `“${name}”`).join(', ')} in the library — ` +
        'nothing was changed for those. Check the list of blocks above before naming one again.'
      : '';

  const done = parts.length > 0 ? `The user kept ${parts.join(', ')}.` : '';
  if (done === '' && failed === '') return 'The user kept none of them.';
  return [done, failed].filter(Boolean).join(' ');
}
