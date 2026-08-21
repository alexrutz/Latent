import { randomUUID } from 'node:crypto';

import type {
  ChatMessage,
  ChatSampling,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolName,
} from '@latent/shared';

import type { AppContext } from '../routes/context.js';
import { toConfig } from '../routes/connections.js';
import { loadConversationPictures, loadReviewImage } from './reviewImage.js';
import { LlamaClient, LlamaError, looksLikeAQuestionWithOptions } from './llama.js';

/**
 * One turn: what it is for, what it carries, and what it leaves behind.
 *
 * Split out of the route because a turn is not a request. The engine takes
 * several of them to finish one thing a person asked for — a prompt is
 * proposed, a picture is made, the model is shown it and says how close it got
 * — and while that was written as a route the browser called in sequence, every
 * gap between two of those calls was a place the whole conversation could stop
 * dead because a tab had been backgrounded.
 *
 * So nothing here knows about HTTP. A turn is asked for, it emits frames to
 * whoever is listening, and it stores its message. Who wanted it and what
 * happens next is the engine's business.
 */

/** What this turn is for. Decided by the engine, not guessed from the history. */
export type TurnKind =
  /** An ordinary reply to something the user said. */
  | { kind: 'reply' }
  /** A tool asked for by name — the ✦ button, or a pace setting being enforced. */
  | { kind: 'forced'; tool: ChatToolName; instruction?: string }
  /** A wandering round, built from notes drawn before the turn was asked for. */
  | { kind: 'wander'; instruction: string; notes: string[]; noteIds: string[] }
  /** The turn after a render: what came out, against what was asked for. */
  | { kind: 'afterRender' };

export interface TurnResult {
  /** The message that was stored, or nothing when the turn produced nothing. */
  messageId: string | null;
  /** The call it proposed, if any — the engine decides what to do about it. */
  call: ChatToolCall | null;
  /** Set when the turn failed. The text is fit to show. */
  error: string | null;
  /** True when the turn was cut short deliberately rather than by a fault. */
  stopped: boolean;
}

export interface TurnOptions {
  kind: TurnKind;
  /** Sampling for this turn alone, when the mode calls for its own. */
  sampling?: ChatSampling;
  signal: AbortSignal;
  /** Frames as they arrive. The engine forwards them to whoever is watching. */
  emit: (event: ChatStreamEvent) => void;
}

/**
 * Ask the model, and store what it says.
 *
 * The message is written once the stream ends, with everything it produced:
 * content, reasoning and any tool call. Writing it incrementally would be a
 * database write per token for a record nobody reads until it is finished — and
 * the engine holds the partial in memory anyway, for a client that arrives
 * mid-sentence.
 */
export async function runTurn(
  ctx: AppContext,
  chatId: string,
  options: TurnOptions,
): Promise<TurnResult> {
  const chat = ctx.store.getChat(chatId);
  if (!chat) return { messageId: null, call: null, error: 'No such conversation', stopped: false };

  const settings = ctx.store.getSettings().chat;
  const wander = options.kind.kind === 'wander';

  /*
   * A wandering turn is told a few notes, and nothing else about them.
   *
   * The taste section of the system prompt lists *everything* switched on and
   * tells the model to let it shape what it suggests. Both at once is the mode
   * asking for three things and being handed the whole profile underneath,
   * which is how every round ended up containing everything and they all
   * started to look alike. The drawn notes are in the turn; the list comes out.
   */
  const client = llamaClient(ctx, {
    ...(options.sampling ? { sampling: options.sampling } : {}),
    ...(wander ? { taste: 'off' as const } : {}),
  });
  if (!client) {
    return {
      messageId: null,
      call: null,
      error: 'No model server chosen yet. Add one under Connections in Settings.',
      stopped: false,
    };
  }

  const message: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
  };
  let thinking = '';

  try {
    const carried = await carriage(ctx, chat.messages, options.kind);

    for await (const event of streamWithFallback(client, chat.messages, {
      signal: options.signal,
      ...carried,
    })) {
      if (event.type === 'content') message.content += event.text;
      if (event.type === 'thinking') thinking += event.text;
      if (event.type === 'tool') {
        /*
         * Where a call came from is ours to record, not the model's to claim.
         *
         * A question decides whether the turn after the answer is still about
         * the picture; a wandering prompt decides what tapping its picture
         * opens and what the round was drawn from. Both are stamped here and
         * stripped again before the call is ever replayed to the model.
         */
        const stamped = stamp(event.call, options.kind, Boolean(carried.review));
        message.toolCall = stamped;
        /*
         * The words go out with the frame; only the ids are kept.
         *
         * A chat message is stored in the clear and the notes are encrypted on
         * purpose, so writing the text into the transcript would put the whole
         * profile in the database a round at a time. Reading a conversation
         * back fills the words in again from the vault.
         */
        options.emit({
          type: 'tool',
          call:
            options.kind.kind === 'wander' && stamped.tool === 'build_prompt'
              ? { ...stamped, wanderNotes: options.kind.notes }
              : stamped,
        });
        continue;
      }
      options.emit(event);
    }

    if (thinking !== '') message.thinking = thinking;
    // An empty reply with no tool call is nothing worth keeping in the history.
    const worthKeeping = message.content.trim() !== '' || Boolean(message.toolCall);
    if (worthKeeping) ctx.store.insertChatMessage(chatId, message);

    /*
     * The one place a pace setting is enforced rather than requested.
     *
     * At `always`, a question asked in prose is not a question anybody can
     * answer with a tap — so if the reply asked one and called no tool, the
     * model is asked again with the tool forced. Every other level is a
     * sentence in the system prompt, which a small model talks itself out of
     * constantly; this one does not depend on it agreeing.
     *
     * Conservative on purpose: it costs a second wait, so it only fires when
     * the reply both asks something and enumerates the answers.
     */
    if (
      options.kind.kind === 'reply' &&
      !message.toolCall &&
      settings.tools.ask_user === 'always' &&
      looksLikeAQuestionWithOptions(message.content)
    ) {
      const asked = await runTurn(ctx, chatId, {
        ...options,
        kind: { kind: 'forced', tool: 'ask_user' },
      });
      if (asked.call) return asked;
    }

    return {
      messageId: worthKeeping ? message.id : null,
      call: message.toolCall ?? null,
      error: null,
      stopped: false,
    };
  } catch (error) {
    /*
     * Stopped, or walked away from.
     *
     * What the model had already said is kept. Stopping a model that has got
     * stuck repeating itself usually means the first paragraph was the good
     * one, and throwing the whole turn away to punish the last one is not what
     * anybody wants — nor is leaving the conversation with a user message and
     * no answer, which most chat templates then refuse to continue from.
     */
    if (options.signal.aborted) {
      if (thinking !== '') message.thinking = thinking;
      const worthKeeping = message.content.trim() !== '' || Boolean(message.toolCall);
      if (worthKeeping) ctx.store.insertChatMessage(chatId, message);
      return {
        messageId: worthKeeping ? message.id : null,
        call: message.toolCall ?? null,
        error: null,
        stopped: true,
      };
    }

    return {
      messageId: null,
      call: null,
      error:
        error instanceof LlamaError || error instanceof Error
          ? error.message
          : 'The model server could not be reached.',
      stopped: false,
    };
  } finally {
    await client.close();
  }
}

/** Everything the turn carries beyond the transcript itself. */
type Carriage = Omit<NonNullable<Parameters<LlamaClient['stream']>[1]>, 'signal'>;

/**
 * What this turn is given, worked out from what it is for.
 *
 * All in one place because these decisions interlock: whether the tools are
 * offered depends on whether there is a picture to judge, which depends on
 * whether the last thing that happened was a render, which is also what decides
 * whether the pictures already in view need loading. Spread across the call
 * site they drifted apart, and a turn ended up being offered a rewrite of a
 * picture it had not been shown.
 */
async function carriage(
  ctx: AppContext,
  messages: ChatMessage[],
  kind: TurnKind,
): Promise<Carriage> {
  if (kind.kind === 'forced') {
    return { force: kind.tool, ...(kind.instruction ? { instruction: kind.instruction } : {}) };
  }
  if (kind.kind === 'wander') {
    return { force: 'build_prompt', instruction: kind.instruction };
  }

  const settings = ctx.store.getSettings().chat;

  /*
   * The pictures stay in front of it.
   *
   * "Make the sky darker" is meaningless to a model that saw the render once,
   * two turns ago, and has been working from its own description of it ever
   * since — every change after that compounds the description rather than the
   * picture. So the last few renders go back with every turn, and both sides of
   * the conversation are looking at the same thing.
   */
  const pictures = settings.review.enabled
    ? await loadConversationPictures(ctx, messages, settings.review.keepInView)
    : new Map<string, string>();

  if (kind.kind === 'reply') {
    return { ...(pictures.size > 0 ? { pictures } : {}) };
  }

  /*
   * A question asked while looking at a picture is still about that picture.
   *
   * Answering it lands the conversation on an ordinary tool response, which
   * would end the review — and the answer is exactly the thing that makes the
   * rewrite worth proposing. So the turn after one of those is a review turn
   * too, with the same picture and the same offer.
   */
  const last = messages[messages.length - 1];
  const answeredReviewQuestion =
    last?.role === 'tool' && last.toolCall?.tool === 'ask_user' && last.toolCall.fromReview === true;
  const reviewed = answeredReviewQuestion ? lastRender(messages) : last;

  /*
   * And when it can be shown the picture, it is.
   *
   * That turn was always the model talking about a render it had never seen —
   * confidently, because that is what these models do. Most model servers worth
   * running are multimodal, so hand it the result and the prompt together and
   * the sentence becomes a judgement it is in a position to make. The one tool
   * it gets is a rewrite, and only when the setting says a rewrite may be
   * proposed at all.
   */
  const image =
    settings.review.enabled && reviewed?.generationId && reviewed.prompt
      ? await loadReviewImage(ctx, reviewed.generationId)
      : null;

  if (!image || !reviewed?.prompt) {
    /*
     * Nothing to judge, so nothing to propose.
     *
     * A model handed its tools back the moment a render was accepted would open
     * a second proposal on top of the first — before anyone has seen what the
     * first one made, and therefore before there is anything to say about it.
     * What is wanted here is a sentence.
     */
    return { withoutTools: true, ...(pictures.size > 0 ? { pictures } : {}) };
  }

  return {
    review: {
      dataUrl: image.dataUrl,
      prompt: reviewed.prompt,
      threshold: settings.review.threshold,
      askWhen: settings.review.askWhen,
      /*
       * Nobody is watching, so nothing is asked. Read from the settings rather
       * than passed in: what the model is *told* about its situation belongs
       * with everything else the server puts in front of it.
       */
      autonomous: settings.autonomous.enabled,
      // Already in the history, unless nothing is kept in view.
      inHistory: pictures.has(reviewed.id),
    },
    ...(pictures.size > 0 ? { pictures } : {}),
  };
}

/** Where a call came from, recorded by us rather than claimed by the model. */
function stamp(call: ChatToolCall, kind: TurnKind, review: boolean): ChatToolCall {
  if (review && call.tool === 'ask_user') return { ...call, fromReview: true };
  if (kind.kind === 'wander' && call.tool === 'build_prompt') {
    return { ...call, fromWander: true, wanderNoteIds: kind.noteIds };
  }
  return call;
}

/** The last render this conversation produced, whatever has been said since. */
export function lastRender(messages: ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.generationId && message.prompt) return message;
  }
  return undefined;
}

/**
 * The same turn, without the picture, if the picture is what it choked on.
 *
 * A model server with no vision projector answers an image part with an error
 * rather than ignoring it, and the setting that put the picture there is on by
 * default — so the failure would land on somebody who never asked for any of
 * this, on the turn after every render. Retried once, plainly: if nothing has
 * been emitted yet, ask again as the turn always used to be.
 *
 * Only before the first frame. Once the model has started answering, a second
 * attempt would repeat what is already on screen.
 */
async function* streamWithFallback(
  client: LlamaClient,
  messages: ChatMessage[],
  options: Parameters<LlamaClient['stream']>[1],
): AsyncGenerator<ChatStreamEvent> {
  const carriesPictures = Boolean(options?.review) || (options?.pictures?.size ?? 0) > 0;
  if (!carriesPictures) {
    yield* client.stream(messages, options);
    return;
  }

  let started = false;
  try {
    for await (const event of client.stream(messages, options)) {
      started = true;
      yield event;
    }
  } catch (error) {
    if (started || options?.signal?.aborted) throw error;
    // Every picture goes, not just the one being judged: a server that refuses
    // an image refuses all of them, wherever in the conversation they sit.
    const { review: _review, pictures: _pictures, ...rest } = options ?? {};
    yield* client.stream(messages, { ...rest, ...(options?.review ? { withoutTools: true } : {}) });
  }
}

/**
 * The instructions in force, resolved from the collection.
 *
 * By id, and empty when that id no longer exists: deleting the prompt the chat
 * was using falls back to Latent's own wording rather than sending an empty
 * system message, which some templates take as an instruction to say nothing.
 */
function systemPrompt(ctx: AppContext): string {
  const id = ctx.store.getSettings().chat.systemPromptId;
  if (!id) return '';
  return ctx.store.getSystemPrompt(id)?.text ?? '';
}

/**
 * A client for the model server in use, or nothing when none is configured.
 *
 * `overrides` beat what the chat's own settings say, which is how a wandering
 * round gets its own temperature: the request is otherwise identical, and
 * duplicating the client for one field would duplicate the taste, the
 * instructions and the connection with it.
 */
export function llamaClient(
  ctx: AppContext,
  overrides?: Partial<ReturnType<AppContext['store']['getSettings']>['chat']>,
): LlamaClient | null {
  const active = ctx.store.getActiveConnection('llama');
  if (!active) return null;

  /*
   * The notes go in per client, so switching one on takes effect on the next
   * message rather than on the next restart — and a locked vault simply means
   * `null`, which leaves the section out instead of failing the turn.
   */
  return new LlamaClient(
    toConfig(active),
    { ...ctx.store.getSettings().chat, ...overrides },
    systemPrompt(ctx),
    ctx.taste.profileOrNull(),
  );
}
