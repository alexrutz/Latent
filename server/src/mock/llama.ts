import Fastify, { type FastifyInstance } from 'fastify';

/**
 * A stand-in for `llama-server`.
 *
 * Enough of the OpenAI chat API to exercise the chat module end to end without
 * a GPU or a model file: it streams, it emits reasoning both of the two ways
 * real builds do, and it can be told to call a tool. What it says is scripted,
 * because the point of the tests is the plumbing around the model, not the
 * model.
 */

export interface ScriptedReply {
  /** Sent as `reasoning_content` deltas. */
  reasoning?: string;
  /** Sent as content deltas, split into a few frames. */
  content?: string;
  /** Wrapped in `<think>` tags inside the content, as some builds do. */
  inlineThinking?: string;
  /** Wrapped in Gemma 4's thought channel, which leaks into content routinely. */
  channelThinking?: string;
  toolCall?: { name: string; arguments: unknown };
}

export function createMockLlama(
  options: {
    logLevel?: string;
    /**
     * Answer a request carrying a picture with an error, as a text-only build does.
     *
     * `llama-server` started without a vision projector does not ignore an
     * image part — it refuses the request. That is the case worth having in a
     * test, because showing the model the finished picture is on by default:
     * whatever happens here happens to somebody who never asked for it.
     */
    refuseImages?: boolean;
  } = {},
) {
  const app: FastifyInstance = Fastify({
    logger: { level: options.logLevel ?? 'silent' },
  });

  /** What the next completion will answer. Shifted off, so a script can queue several. */
  const replies: ScriptedReply[] = [];
  /** Every request body seen, so a test can assert what was actually sent. */
  const seen: Record<string, unknown>[] = [];

  app.get('/v1/models', async () => ({ data: [{ id: 'mock-model' }] }));

  app.post('/v1/chat/completions', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    seen.push(body);

    if (options.refuseImages && JSON.stringify(body.messages ?? []).includes('image_url')) {
      return reply.code(400).send({ error: { message: 'this model does not support images' } });
    }

    const script = replies.shift() ?? { content: 'All right.' };

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const frame = (delta: unknown) => {
      reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    };

    if (script.reasoning) {
      for (const chunk of split(script.reasoning)) frame({ reasoning_content: chunk });
    }
    if (script.inlineThinking) {
      // Deliberately straddling the tag across frames, which is the case that
      // breaks a naive parser.
      frame({ content: '<thi' });
      frame({ content: `nk>${script.inlineThinking}</th` });
      frame({ content: 'ink>' });
    }
    if (script.channelThinking) {
      // Gemma 4's channel token, straddled the same way — and with the newline
      // the template puts after the opener.
      frame({ content: '<|chan' });
      frame({ content: `nel>thought\n${script.channelThinking}<chan` });
      frame({ content: 'nel|>' });
    }
    if (script.content) {
      for (const chunk of split(script.content)) frame({ content: chunk });
    }
    if (script.toolCall) {
      // Split across deltas the way a real server sends them: the name first,
      // then the arguments a few characters at a time.
      frame({
        tool_calls: [
          { index: 0, id: 'call_mock_1', function: { name: script.toolCall.name, arguments: '' } },
        ],
      });
      for (const chunk of split(JSON.stringify(script.toolCall.arguments), 12)) {
        frame({ tool_calls: [{ index: 0, function: { arguments: chunk } }] });
      }
    }

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  });

  return {
    app,
    /** Queue what the next completion will answer. */
    script(...next: ScriptedReply[]) {
      replies.push(...next);
    },
    /** Request bodies received so far. */
    get requests() {
      return seen;
    },
    /** Forget what was queued and what was seen, between tests. */
    reset() {
      replies.length = 0;
      seen.length = 0;
    },
    async listen(port = 0): Promise<string> {
      await app.listen({ port, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      return `http://127.0.0.1:${address.port}`;
    },
    close: () => app.close(),
  };
}

/** A few frames rather than one, so the streaming path is genuinely exercised. */
function split(text: string, size = 8): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks.length > 0 ? chunks : [text];
}
