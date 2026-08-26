import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type {
  ChatAttachment,
  ChatConversationDetail,
  ChatEvent,
  ChatToolResult,
  ProposedBlock,
} from '@latent/shared';

import { ChatEngine, type IntentResult } from '../chat/engine.js';
import { DEFAULT_SYSTEM_PROMPT, LlamaClient } from '../chat/llama.js';
import { llamaClient } from '../chat/turn.js';
import { toConfig } from './connections.js';
import type { AppContext } from './context.js';

/**
 * The chat module's routes — a door onto the engine, and nothing else.
 *
 * There used to be far more here, and it was the wrong more. A conversation's
 * multi-step behaviours were spread across four routes the browser called in
 * order — post a message, record a decision, ask it to continue, ask for
 * another wandering round — which meant the *sequence* lived in a tab. Every
 * gap between two of those calls was somewhere a frozen page could leave the
 * conversation stuck, and it regularly did.
 *
 * So these routes say what somebody wants and stop there. What follows is
 * `chat/engine.ts`'s business, and it happens whether or not anyone is still
 * watching. The one long-lived route is the event stream, which is how a client
 * finds out what happened while it was away.
 */

/** Ceiling on one attachment, before base64 expansion. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

/**
 * How often to write a comment down an idle event stream.
 *
 * A conversation can sit quiet for an hour, and a proxy that sees nothing on a
 * connection for sixty seconds closes it. `EventSource` reconnects on its own,
 * so the cost of not doing this is a reconnect a minute rather than a broken
 * app — but a reconnect means a fresh `sync`, and doing that for ever in the
 * background is exactly the sort of waste nobody notices until the battery is
 * flat.
 */
const KEEPALIVE_MS = 25_000;

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): ChatEngine {
  const engine = new ChatEngine(ctx);

  /** Whether the model server is there, and what it has loaded. */
  app.get('/api/chat/status', async () => {
    const active = ctx.store.getActiveConnection('llama');
    if (!active) {
      return {
        ok: false,
        baseUrl: '',
        models: [],
        message: 'No model server chosen yet. Add one under Connections.',
      };
    }

    const connection = toConfig(active);
    const client = new LlamaClient(connection, ctx.store.getSettings().chat);
    try {
      const models = await client.models();
      return { ok: true, baseUrl: connection.url, models };
    } catch (error) {
      return {
        ok: false,
        baseUrl: connection.url,
        models: [],
        message:
          error instanceof Error
            ? error.message
            : `No answer from the model server at ${connection.url}.`,
      };
    } finally {
      await client.close();
    }
  });

  /**
   * Latent's own instructions, so Settings can show them and reset to them.
   *
   * A read-only route rather than a copy in the client: there is one wording,
   * it lives next to the tools it describes, and a duplicate in the browser
   * would be wrong the first time either changed.
   */
  app.get('/api/chat/prompt', async () => ({ prompt: DEFAULT_SYSTEM_PROMPT }));

  app.get('/api/chat/conversations', async () => ctx.store.listChats());

  app.post('/api/chat/conversations', async (_request, reply) =>
    reply.code(201).send(ctx.store.createChat(randomUUID())),
  );

  /**
   * A conversation, and what it is doing.
   *
   * Both together because they are read together: a screen that had the
   * transcript but not the run state would have to guess whether the last
   * proposal in it is waiting on somebody, which is precisely the guessing this
   * rebuild removed.
   */
  app.get<{ Params: { id: string } }>('/api/chat/conversations/:id', async (request, reply) => {
    const chat = ctx.store.getChat(request.params.id);
    if (!chat) return reply.code(404).send({ error: 'No such conversation' });
    return { ...withWanderNotes(ctx, chat), run: ctx.store.getChatRun(chat.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/chat/conversations/:id', async (request, reply) => {
    ctx.store.deleteChat(request.params.id);
    engine.forget(request.params.id);
    return reply.code(204).send();
  });

  /**
   * What this conversation is doing, for as long as you care to watch.
   *
   * One stream per open conversation rather than one per turn, and it opens
   * with everything that is true rather than with whatever happens next. That
   * is the whole difference: a client coming back from a suspended tab used to
   * have no way of learning that three pictures had been made while it was
   * asleep, because the only stream it had ever had was the reply to a request
   * it made an hour ago.
   */
  app.get<{ Params: { id: string } }>(
    '/api/chat/conversations/:id/events',
    async (request, reply) => {
      const chat = ctx.store.getChat(request.params.id);
      if (!chat) return reply.code(404).send({ error: 'No such conversation' });

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx and friends buffer event streams into uselessness otherwise.
        'x-accel-buffering': 'no',
      });

      const send = (event: ChatEvent) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = engine.runner(chat.id).subscribe({ send });

      const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), KEEPALIVE_MS);
      keepalive.unref?.();

      reply.raw.on('close', () => {
        clearInterval(keepalive);
        unsubscribe();
      });

      // Deliberately never resolved: the handler's life is the stream's life.
      return new Promise<void>(() => undefined);
    },
  );

  /* ---------------------------------------------------------------- */
  /* Intents                                                           */
  /* ---------------------------------------------------------------- */

  /** Say something. The reply, and anything it leads to, is the engine's. */
  app.post<{
    Params: { id: string };
    Body: { content?: string; attachments?: ChatAttachment[] };
  }>('/api/chat/conversations/:id/say', async (request, reply) => {
    const chat = ctx.store.getChat(request.params.id);
    if (!chat) return reply.code(404).send({ error: 'No such conversation' });

    const content = (request.body?.content ?? '').trim();
    const attachments = (request.body?.attachments ?? []).slice(0, MAX_ATTACHMENTS);

    for (const attachment of attachments) {
      if (!attachment.dataUrl?.startsWith('data:image/')) {
        return reply.code(400).send({ error: 'Attachments have to be images.' });
      }
      if (attachment.dataUrl.length > MAX_ATTACHMENT_BYTES * 1.4) {
        return reply.code(413).send({ error: 'That image is too large to send.' });
      }
    }

    if (content === '' && attachments.length === 0) {
      return reply.code(400).send({ error: 'Nothing to send.' });
    }

    return settle(
      reply,
      engine.runner(chat.id).accept({
        type: 'say',
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    );
  });

  /**
   * Ask for a prompt, because a button was pressed.
   *
   * The tool is forced rather than suggested: pressing the button is not the
   * model's initiative to weigh up, it is an instruction. `fresh` asks for a
   * different one rather than the same one again; `instant` queues whatever
   * comes back without stopping to show it.
   */
  app.post<{ Params: { id: string }; Body: { fresh?: boolean; instant?: boolean } }>(
    '/api/chat/conversations/:id/prompt',
    async (request, reply) => {
      const chat = ctx.store.getChat(request.params.id);
      if (!chat) return reply.code(404).send({ error: 'No such conversation' });
      return settle(
        reply,
        engine.runner(chat.id).accept({
          type: 'prompt',
          fresh: request.body?.fresh === true,
          instant: request.body?.instant === true,
        }),
      );
    },
  );

  /** Start or stop wandering: picture after picture out of your own notes. */
  app.post<{ Params: { id: string }; Body: { on?: boolean } }>(
    '/api/chat/conversations/:id/wander',
    async (request, reply) => {
      const chat = ctx.store.getChat(request.params.id);
      if (!chat) return reply.code(404).send({ error: 'No such conversation' });
      return settle(
        reply,
        engine.runner(chat.id).accept({ type: 'wander', on: request.body?.on !== false }),
      );
    },
  );

  /**
   * Carry on by itself, from here.
   *
   * A route rather than a settings patch because it has to reach the run as
   * well as the setting: turning it on while a proposal is waiting has to take
   * that proposal, or the switch does nothing visible and the strip above it
   * starts describing a loop that is not running.
   */
  app.post<{ Params: { id: string }; Body: { on?: boolean } }>(
    '/api/chat/conversations/:id/autonomous',
    async (request, reply) => {
      const chat = ctx.store.getChat(request.params.id);
      if (!chat) return reply.code(404).send({ error: 'No such conversation' });
      return settle(
        reply,
        engine.runner(chat.id).accept({ type: 'autonomous', on: request.body?.on !== false }),
      );
    },
  );

  /**
   * What the user decided about a proposal.
   *
   * Accepting a prompt queues it here, in the same act that records the
   * decision. It used to be the browser's job to do both, in that order, over
   * two requests — and a page that died between them left a proposal with no
   * answer in a conversation that could not continue.
   */
  app.post<{
    Params: { id: string };
    Body: {
      messageId?: string;
      decision?: ChatToolResult['decision'];
      /** For `prompt_blocks`: the blocks the user kept, as edited. */
      blocks?: ProposedBlock[];
      /** For `ask_user`: the answer. For the rest: what was done, in a line. */
      note?: string;
      /** The prompt as edited in the dialog, when it was edited. */
      prompt?: string;
      /** The workflow the dialog's picker chose, for this prompt only. */
      workflowId?: string;
    };
  }>('/api/chat/conversations/:id/decide', async (request, reply) => {
    const chat = ctx.store.getChat(request.params.id);
    if (!chat) return reply.code(404).send({ error: 'No such conversation' });

    const body = request.body ?? {};
    if (!body.messageId) return reply.code(400).send({ error: 'Which proposal?' });

    return settle(
      reply,
      engine.runner(chat.id).accept({
        type: 'decide',
        messageId: body.messageId,
        decision: body.decision ?? 'rejected',
        ...(body.blocks ? { blocks: body.blocks } : {}),
        ...(body.note ? { note: body.note } : {}),
        ...(body.prompt ? { prompt: body.prompt } : {}),
        ...(body.workflowId ? { workflowId: body.workflowId } : {}),
      }),
    );
  });

  /** Stop whatever is happening — the turn in flight, and any loop around it. */
  app.post<{ Params: { id: string } }>(
    '/api/chat/conversations/:id/stop',
    async (request, reply) => {
      const chat = ctx.store.getChat(request.params.id);
      if (!chat) return reply.code(404).send({ error: 'No such conversation' });
      return settle(reply, engine.runner(chat.id).accept({ type: 'stop' }));
    },
  );

  /**
   * A render has been drawn on somebody's screen.
   *
   * The one thing in the module that still waits for a browser, and it is worth
   * it: the point of the sequence is that you see the picture before the model
   * says anything about it, and only the browser knows when that happened.
   * Advisory — the engine carries on after a timeout, and skips the wait
   * entirely when nobody is watching.
   */
  app.post<{ Params: { id: string }; Body: { generationId?: string } }>(
    '/api/chat/conversations/:id/shown',
    async (request, reply) => {
      const generationId = request.body?.generationId;
      if (typeof generationId === 'string' && generationId !== '') {
        engine.runner(request.params.id).noteShown(generationId);
      }
      return reply.code(204).send();
    },
  );

  /**
   * Note that a prompt from further up was generated again.
   *
   * Its own route, and its own `note` role, because this is not a turn in the
   * conversation: the model already had its answer to that tool call, and a
   * second tool response for one call is what chat templates refuse. The note
   * exists so the picture has somewhere to appear.
   */
  app.post<{
    Params: { id: string };
    Body: { messageId?: string; prompt?: string; workflowId?: string };
  }>('/api/chat/conversations/:id/rerun', async (request, reply) => {
    const chat = ctx.store.getChat(request.params.id);
    if (!chat) return reply.code(404).send({ error: 'No such conversation' });

    const { messageId, prompt, workflowId } = request.body ?? {};
    const message = chat.messages.find((candidate) => candidate.id === messageId);
    const tool = message?.toolCall?.tool;
    // A rewrite is a prompt too, and the commonest one to want again.
    if (tool !== 'build_prompt' && tool !== 'revise_prompt') {
      return reply.code(404).send({ error: 'No such prompt' });
    }

    const text = prompt?.trim() || (message?.toolCall as { prompt: string }).prompt;
    const queued = await engine.queueAgain(text, workflowId);
    if (queued.error && !queued.generationId) {
      return reply.code(502).send({ error: queued.error });
    }

    const id = randomUUID();
    ctx.store.insertChatMessage(chat.id, {
      id,
      role: 'note',
      content: 'Generated again',
      ...(queued.generationId ? { generationId: queued.generationId } : {}),
      prompt: text,
      createdAt: Date.now(),
    });
    return reply.send({ ok: true, messageId: id, generationId: queued.generationId });
  });

  /**
   * Wind the conversation back to a message and drop everything after it.
   *
   * The message itself stays: "take me back to this prompt and carry on from
   * there" means that prompt is where you are, not the last thing you lost. It
   * is a real delete rather than a marker — a hidden tail that the model could
   * still see would make the conversation behave in ways the transcript does
   * not explain.
   */
  app.post<{ Params: { id: string }; Body: { messageId?: string } }>(
    '/api/chat/conversations/:id/rewind',
    async (request, reply) => {
      const chat = ctx.store.getChat(request.params.id);
      if (!chat) return reply.code(404).send({ error: 'No such conversation' });

      const at = chat.messages.findIndex((candidate) => candidate.id === request.body?.messageId);
      if (at < 0) return reply.code(404).send({ error: 'No such message' });

      const removed = ctx.store.truncateChat(chat.id, chat.messages[at]!.id);
      // Anything the dropped tail was waiting on is gone with it, so the run
      // has to stop pointing at it.
      await engine.runner(chat.id).accept({ type: 'stop' });
      return reply.send({ ok: true, removed });
    },
  );

  return engine;
}

/** One shape for every intent's answer, so the client has one thing to check. */
async function settle(
  reply: FastifyReply,
  result: Promise<IntentResult>,
): Promise<FastifyReply> {
  const { error, conflict } = await result;
  // A proposal decided twice is a double tap or a second phone, not a fault:
  // 409 says "that already happened" and the client re-reads rather than
  // showing a failure for something that worked.
  if (conflict) return reply.code(409).send({ error });
  if (error) return reply.code(400).send({ error });
  return reply.send({ ok: true });
}

/**
 * A conversation with the wandering notes put back into words.
 *
 * The ids are what is stored; the words live in the vault. Done here rather
 * than in the store because it needs the vault, and because a locked server
 * should still be able to hand over the conversation — just without this part
 * of it, which is exactly what `textFor` does when it cannot read.
 */
function withWanderNotes(ctx: AppContext, chat: ChatConversationDetail): ChatConversationDetail {
  if (!chat.messages.some((message) => message.toolCall?.tool === 'build_prompt')) return chat;

  return {
    ...chat,
    messages: chat.messages.map((message) => {
      const call = message.toolCall;
      if (call?.tool !== 'build_prompt' || !call.wanderNoteIds?.length) return message;
      const notes = ctx.taste.textFor(call.wanderNoteIds);
      if (notes.length === 0) return message;
      return { ...message, toolCall: { ...call, wanderNotes: notes } };
    }),
  };
}

// Re-exported for the tests, which drive a turn without a conversation around
// it. Nothing in the app calls it directly.
export { llamaClient };
