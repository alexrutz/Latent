import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type {
  ChatAttachment,
  ChatMessage,
  ChatStreamEvent,
  ChatToolName,
  ChatToolResult,
  ProposedBlock,
} from '@latent/shared';

import {
  DEFAULT_SYSTEM_PROMPT,
  LlamaClient,
  LlamaError,
  looksLikeAQuestionWithOptions,
} from '../chat/llama.js';
import type { AppContext } from './context.js';

/**
 * The chat module's routes.
 *
 * One thing here is unlike the rest of the server: the reply is streamed. A
 * local model on a modest box produces a few tokens a second, and a chat that
 * shows nothing for forty seconds and then everything at once is a chat nobody
 * waits for. The stream is server-sent events, which survive a proxy and a
 * flaky phone connection in a way a second WebSocket would not.
 */

/** Ceiling on one attachment, before base64 expansion. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  const client = () => new LlamaClient(ctx.store.getSettings().chat);

  /** Whether the model server is there, and what it has loaded. */
  app.get('/api/chat/status', async () => {
    const settings = ctx.store.getSettings().chat;
    try {
      const models = await client().models();
      return { ok: true, baseUrl: settings.baseUrl, models };
    } catch (error) {
      return {
        ok: false,
        baseUrl: settings.baseUrl,
        models: [],
        message:
          error instanceof Error
            ? error.message
            : `No answer from the model server at ${settings.baseUrl}.`,
      };
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

  app.get<{ Params: { id: string } }>('/api/chat/conversations/:id', async (request, reply) => {
    const chat = ctx.store.getChat(request.params.id);
    return chat ?? reply.code(404).send({ error: 'No such conversation' });
  });

  app.delete<{ Params: { id: string } }>('/api/chat/conversations/:id', async (request, reply) => {
    ctx.store.deleteChat(request.params.id);
    return reply.code(204).send();
  });

  /**
   * Say something, and stream the reply.
   *
   * The user's message is stored before the model is asked, so a reply that
   * fails halfway leaves the conversation intact rather than losing what was
   * typed.
   */
  app.post<{
    Params: { id: string };
    Body: { content?: string; attachments?: ChatAttachment[] };
  }>('/api/chat/conversations/:id/messages', async (request, reply) => {
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

    ctx.store.insertChatMessage(chat.id, {
      id: randomUUID(),
      role: 'user',
      content,
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: Date.now(),
    });

    // The first thing said names the conversation, so a list of them is
    // scannable without opening each one.
    if (chat.title === '') {
      ctx.store.renameChat(chat.id, content || 'Picture');
    }

    return streamReply(app, ctx, reply, chat.id);
  });

  /**
   * What the user decided about a tool call.
   *
   * Doing the work here rather than in the browser: the decision has to be
   * recorded, the blocks have to be written, and the model has to be told — and
   * a client that did two of those and then lost its connection would leave the
   * conversation unable to continue.
   */
  app.post<{
    Params: { id: string };
    Body: {
      messageId?: string;
      decision?: ChatToolResult['decision'];
      /** For `prompt_blocks`: the blocks the user kept, as edited. */
      blocks?: ProposedBlock[];
      /** For `build_prompt` and `ask_user`: what the client did, or the answer. */
      note?: string;
      /** For `build_prompt`: the run the accepted prompt started. */
      generationId?: string;
      /** The prompt as it was actually queued, after any editing in the dialog. */
      prompt?: string;
    };
  }>('/api/chat/conversations/:id/tool', async (request, reply) => {
    const chat = ctx.store.getChat(request.params.id);
    if (!chat) return reply.code(404).send({ error: 'No such conversation' });

    const {
      messageId,
      decision = 'rejected',
      blocks,
      note,
      generationId,
      prompt,
    } = request.body ?? {};
    const message = chat.messages.find((candidate) => candidate.id === messageId);
    if (!message?.toolCall) return reply.code(404).send({ error: 'No such tool call' });
    if (message.toolResult) {
      return reply.code(409).send({ error: 'That has already been decided.' });
    }

    let summary: string;
    if (decision === 'rejected') {
      summary = note?.trim() || 'The user declined.';
    } else if (message.toolCall.tool === 'prompt_blocks') {
      summary = applyBlocks(ctx, blocks ?? message.toolCall.blocks);
    } else if (message.toolCall.tool === 'ask_user') {
      // The answer *is* the result. Quoted so the model reads it as theirs.
      summary = note?.trim() || 'The user did not answer.';
    } else {
      summary = note?.trim() || 'The user accepted the prompt and is generating it.';
    }

    const result: ChatToolResult = { decision, summary };
    ctx.store.setChatToolResult(message.id, result);

    /*
     * The model is told what happened, as a `tool` message. Without it the next
     * turn has an assistant message asking for a tool and no answer to it,
     * which most templates refuse outright.
     */
    ctx.store.insertChatMessage(chat.id, {
      id: randomUUID(),
      role: 'tool',
      content: summary,
      toolCall: message.toolCall,
      // The run this decision started, so its pictures land in the transcript
      // at the point they were asked for rather than only in the gallery.
      ...(typeof generationId === 'string' && generationId !== '' ? { generationId } : {}),
      ...(typeof prompt === 'string' && prompt !== '' ? { prompt } : {}),
      createdAt: Date.now(),
    });

    return reply.send({ ok: true, summary });
  });

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
    Body: { messageId?: string; generationId?: string; prompt?: string };
  }>('/api/chat/conversations/:id/rerun', async (request, reply) => {
    const chat = ctx.store.getChat(request.params.id);
    if (!chat) return reply.code(404).send({ error: 'No such conversation' });

    const { messageId, generationId, prompt } = request.body ?? {};
    const message = chat.messages.find((candidate) => candidate.id === messageId);
    if (message?.toolCall?.tool !== 'build_prompt') {
      return reply.code(404).send({ error: 'No such prompt' });
    }

    const id = randomUUID();
    ctx.store.insertChatMessage(chat.id, {
      id,
      role: 'note',
      content: 'Generated again',
      ...(typeof generationId === 'string' && generationId !== ''
        ? { generationId }
        : {}),
      ...(typeof prompt === 'string' && prompt !== '' ? { prompt } : {}),
      createdAt: Date.now(),
    });
    return reply.send({ ok: true, messageId: id });
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

      const at = chat.messages.findIndex(
        (candidate) => candidate.id === request.body?.messageId,
      );
      if (at < 0) return reply.code(404).send({ error: 'No such message' });

      const removed = ctx.store.truncateChat(chat.id, chat.messages[at]!.id);
      return reply.send({ ok: true, removed });
    },
  );

  /**
   * Ask for a prompt, because a button was pressed.
   *
   * The tool is forced rather than suggested: pressing the button is not the
   * model's initiative to weigh up, it is an instruction. Its own route so the
   * pace settings stay about what the model does *on its own* — which is what
   * they are for.
   */
  app.post<{ Params: { id: string } }>(
    '/api/chat/conversations/:id/build',
    async (request, reply) => {
      const chat = ctx.store.getChat(request.params.id);
      if (!chat) return reply.code(404).send({ error: 'No such conversation' });
      return streamReply(app, ctx, reply, chat.id, 'build_prompt');
    },
  );

  /**
   * Carry on after a tool call, without the user saying anything.
   *
   * Separate from answering, because after a decision the model usually has
   * something short to say about it — and sometimes nothing, in which case this
   * is never called.
   */
  app.post<{ Params: { id: string } }>(
    '/api/chat/conversations/:id/continue',
    async (request, reply) => {
      const chat = ctx.store.getChat(request.params.id);
      if (!chat) return reply.code(404).send({ error: 'No such conversation' });
      return streamReply(app, ctx, reply, chat.id);
    },
  );
}

/**
 * Ask the model and forward what it says, frame by frame.
 *
 * The assistant's message is written once the stream ends, with everything it
 * produced: content, reasoning and any tool call. Writing it incrementally
 * would mean a database write per token for a record nobody reads until it is
 * finished.
 */
async function streamReply(
  app: FastifyInstance,
  ctx: AppContext,
  reply: FastifyReply,
  chatId: string,
  force?: ChatToolName,
): Promise<void> {
  const chat = ctx.store.getChat(chatId);
  if (!chat) {
    await reply.code(404).send({ error: 'No such conversation' });
    return;
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nginx and friends buffer event streams into uselessness otherwise.
    'x-accel-buffering': 'no',
  });

  const send = (event: ChatStreamEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const controller = new AbortController();
  reply.raw.on('close', () => controller.abort());

  const message: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
  };
  let thinking = '';

  try {
    for await (const event of new LlamaClient(ctx.store.getSettings().chat).stream(
      chat.messages,
      { signal: controller.signal, ...(force ? { force } : {}) },
    )) {
      if (event.type === 'content') message.content += event.text;
      if (event.type === 'thinking') thinking += event.text;
      if (event.type === 'tool') message.toolCall = event.call;
      send(event);
    }

    if (thinking !== '') message.thinking = thinking;
    // An empty reply with no tool call is nothing worth keeping in the history.
    if (message.content.trim() !== '' || message.toolCall) {
      ctx.store.insertChatMessage(chatId, message);
    }

    /*
     * The one place a pace setting is enforced rather than requested.
     *
     * At `always`, a question asked in prose is not a question the user can
     * answer with a tap — so if the reply asked one and no tool was called, the
     * model is asked again with the tool forced. Every other level is a
     * sentence in the system prompt, which a small model talks itself out of
     * constantly; this one does not depend on it agreeing.
     *
     * Conservative on purpose: it costs a second wait, so it only fires when
     * the reply both asks something and enumerates the answers.
     */
    const settings = ctx.store.getSettings().chat;
    if (
      !force &&
      !message.toolCall &&
      settings.tools.ask_user === 'always' &&
      looksLikeAQuestionWithOptions(message.content)
    ) {
      const asked = await runTurn(ctx, chatId, send, controller.signal, 'ask_user');
      if (asked) {
        send({ type: 'done', messageId: asked });
        return;
      }
    }

    send({ type: 'done', messageId: message.id });
  } catch (error) {
    /*
     * The user pressed stop, or walked away.
     *
     * What the model had already said is kept. Stopping a model that has got
     * stuck repeating itself usually means the first paragraph was the good
     * one, and throwing the whole turn away to punish the last one is not what
     * anybody wants — nor is leaving the conversation with a user message and
     * no answer, which most chat templates then refuse to continue from.
     */
    if (controller.signal.aborted) {
      if (thinking !== '') message.thinking = thinking;
      if (message.content.trim() !== '' || message.toolCall) {
        ctx.store.insertChatMessage(chatId, message);
      }
      return;
    }

    const text =
      error instanceof LlamaError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'The model server could not be reached.';
    app.log.warn({ err: error }, 'Chat stream failed');
    send({ type: 'error', message: text });
  } finally {
    reply.raw.end();
  }
}

/**
 * One more turn on the same stream, and the id of what it stored.
 *
 * Used only to force a tool the model should have called. Returns null when
 * nothing came of it, so the caller can fall back to the reply it already has
 * rather than leaving the conversation with a turn that says nothing.
 */
async function runTurn(
  ctx: AppContext,
  chatId: string,
  send: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
  force: ChatToolName,
): Promise<string | null> {
  const chat = ctx.store.getChat(chatId);
  if (!chat) return null;

  const message: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
  };

  for await (const event of new LlamaClient(ctx.store.getSettings().chat).stream(chat.messages, {
    signal,
    force,
  })) {
    if (event.type === 'content') message.content += event.text;
    if (event.type === 'tool') message.toolCall = event.call;
    // The reasoning of a forced turn is not worth showing: it is the model
    // restating what it already said, in a box the user has to open.
    if (event.type !== 'thinking') send(event);
  }

  if (!message.toolCall) return null;
  ctx.store.insertChatMessage(chatId, message);
  return message.id;
}

/**
 * Write the blocks the user kept.
 *
 * The list is the *edited* one from the client, not what the model proposed:
 * the point of the dialog is that a block can be corrected before it is saved,
 * and taking the model's version afterwards would throw that away.
 */
function applyBlocks(ctx: AppContext, blocks: ProposedBlock[]): string {
  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const block of blocks) {
    if (block.action === 'remove') {
      if (block.id) {
        ctx.store.deletePromptBlock(block.id);
        removed += 1;
      }
      continue;
    }

    if (block.action === 'update' && block.id) {
      ctx.store.updatePromptBlock(block.id, {
        name: block.name,
        category: block.category,
        text: block.text,
      });
      updated += 1;
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

  return parts.length > 0
    ? `The user kept ${parts.join(', ')}.`
    : 'The user kept none of them.';
}
