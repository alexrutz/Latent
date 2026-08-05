import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type {
  ChatAttachment,
  ChatMessage,
  ChatStreamEvent,
  ChatToolResult,
  ProposedBlock,
} from '@latent/shared';

import { DEFAULT_SYSTEM_PROMPT, LlamaClient, LlamaError } from '../chat/llama.js';
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
    };
  }>('/api/chat/conversations/:id/tool', async (request, reply) => {
    const chat = ctx.store.getChat(request.params.id);
    if (!chat) return reply.code(404).send({ error: 'No such conversation' });

    const { messageId, decision = 'rejected', blocks, note, generationId } = request.body ?? {};
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
      createdAt: Date.now(),
    });

    return reply.send({ ok: true, summary });
  });

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
      { signal: controller.signal },
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
