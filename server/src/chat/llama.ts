import type {
  ChatAttachment,
  ChatMessage,
  ChatSettings,
  ChatStreamEvent,
  ChatToolCall,
  ProposedBlock,
} from '@latent/shared';

/**
 * Talking to a local llama.cpp server.
 *
 * `llama-server` speaks the OpenAI chat API, which is what everything here
 * uses: `/v1/chat/completions` with `stream: true`, tools declared the standard
 * way, and images as `image_url` parts for a multimodal model. Nothing about
 * this is llama.cpp-specific beyond the default address, so anything else
 * offering the same routes works too.
 *
 * Two things need handling that the plain API does not spell out:
 *
 * 1. **Reasoning.** Some builds send it as `reasoning_content` deltas; others
 *    leave `<think>…</think>` inline in the content. Both are read here, so the
 *    answer and the thinking stay apart whichever the model does.
 * 2. **Tool calls arrive in fragments.** The name comes in one delta and the
 *    arguments in a dozen more, so they are accumulated by index and only
 *    parsed once the stream says it is finished.
 */

const TIMEOUT_MS = 300_000;

/** Latent's own instructions, used when the user has not written their own. */
export const DEFAULT_SYSTEM_PROMPT = `You help someone make images with ComfyUI.

You have two tools:

- \`prompt_blocks\` proposes changes to their library of reusable prompt
  fragments. Use it when they ask for block ideas, or when a conversation has
  produced phrases worth keeping. Group blocks by category — lighting, mood,
  camera, subject — and keep each one a fragment, not a sentence.
- \`build_prompt\` writes a finished image prompt. Use it when they ask for a
  prompt, or to make a picture of what you have been discussing. Write it as
  comma-separated fragments the way image models expect, not as prose.

Propose a tool call rather than pasting blocks or prompts into your reply: the
tools are what let them accept your suggestion with one tap. Everything you
propose is reviewed before it takes effect, so suggest freely — but only call a
tool when it is actually what they asked for.

Keep replies short. They are reading on a phone.`;

/** The tools, in the shape the OpenAI API expects. */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'prompt_blocks',
      description:
        'Propose additions, edits or removals to the user’s library of reusable prompt ' +
        'fragments. Each proposed block is reviewed individually before anything is saved.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'One sentence on why these are worth having.',
          },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['add', 'update', 'remove'] },
                id: {
                  type: 'string',
                  description: 'Required for update and remove; the existing block’s id.',
                },
                name: { type: 'string', description: 'Short label, e.g. "Golden hour".' },
                category: {
                  type: 'string',
                  description: 'Group it belongs to, e.g. "Lighting".',
                },
                text: {
                  type: 'string',
                  description: 'The prompt fragment itself, not a sentence about it.',
                },
              },
              required: ['action', 'name', 'category', 'text'],
            },
          },
        },
        required: ['reason', 'blocks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_prompt',
      description:
        'Write a finished image prompt from the conversation. The user can send it straight ' +
        'to ComfyUI with their current settings, or reject it and keep talking.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The positive prompt, as comma-separated fragments.',
          },
          negativePrompt: {
            type: 'string',
            description: 'What to avoid. Omit unless there is a reason for one.',
          },
          reason: { type: 'string', description: 'What you were going for, in a sentence.' },
        },
        required: ['prompt', 'reason'],
      },
    },
  },
] as const;

export class LlamaError extends Error {
  override name = 'LlamaError';
}

interface OpenAiMessage {
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[];
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Turn a stored conversation into what the API takes.
 *
 * Reasoning is deliberately left out of the history. Every model that produces
 * it asks for it not to be fed back — it is working, not record — and including
 * it wastes the context window on a phone-sized conversation.
 */
export function toApiMessages(messages: ChatMessage[], systemPrompt: string): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCall?.callId ?? 'unknown',
        content: message.content,
      });
      continue;
    }

    if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.content,
        ...(message.toolCall
          ? {
              tool_calls: [
                {
                  id: message.toolCall.callId,
                  type: 'function' as const,
                  function: {
                    name: message.toolCall.tool,
                    arguments: JSON.stringify(message.toolCall),
                  },
                },
              ],
            }
          : {}),
      });
      continue;
    }

    out.push({ role: 'user', content: userContent(message.content, message.attachments) });
  }

  return out;
}

/** Plain text when there are no pictures, so a text-only model is unbothered. */
function userContent(text: string, attachments?: ChatAttachment[]): OpenAiMessage['content'] {
  if (!attachments || attachments.length === 0) return text;
  return [
    ...attachments.map((attachment) => ({
      type: 'image_url',
      image_url: { url: attachment.dataUrl },
    })),
    { type: 'text', text },
  ];
}

export class LlamaClient {
  constructor(private readonly settings: ChatSettings) {}

  private url(path: string): string {
    return new URL(path, this.settings.baseUrl.replace(/\/+$/, '') + '/').toString();
  }

  /** What the server has loaded. Used only to tell the user it is reachable. */
  async models(): Promise<string[]> {
    const response = await fetch(this.url('v1/models'), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new LlamaError(`The model server answered ${response.status}.`);
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string');
  }

  /**
   * Stream one reply.
   *
   * An async generator rather than a callback so the route can simply forward
   * what it yields: the shape of a stream is a sequence, and writing it as one
   * keeps the cancellation and error paths where they belong.
   */
  async *stream(
    messages: ChatMessage[],
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatStreamEvent> {
    const body = {
      ...(this.settings.model ? { model: this.settings.model } : {}),
      messages: toApiMessages(
        messages,
        this.settings.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
      ),
      temperature: this.settings.temperature,
      ...(this.settings.maxTokens > 0 ? { max_tokens: this.settings.maxTokens } : {}),
      stream: true,
      tools: TOOLS,
      tool_choice: 'auto',
      /*
       * `none` keeps the reasoning in its own field instead of inline in the
       * answer. Builds that do not know the option ignore it, and the inline
       * `<think>` path below covers those.
       */
      ...(this.settings.thinking
        ? { reasoning_format: 'none' }
        : { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: false } }),
    };

    let response: Response;
    try {
      response = await fetch(this.url('v1/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new LlamaError(
        `No answer from the model server at ${this.settings.baseUrl}. ` +
          (error instanceof Error ? error.message : ''),
      );
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new LlamaError(
        `The model server answered ${response.status}. ${detail.slice(0, 400)}`.trim(),
      );
    }

    yield* readStream(response.body, this.settings.thinking);
  }
}

/** Accumulates one tool call across the deltas it arrives in. */
interface PartialCall {
  id: string;
  name: string;
  args: string;
}

async function* readStream(
  body: ReadableStream<Uint8Array>,
  thinking: boolean,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const calls = new Map<number, PartialCall>();
  /** True while inside an inline `<think>` block. */
  let inThink = false;
  /** Content held back because it might be the start of a tag. */
  let carry = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a partial one waits.
      let split: number;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;

          let parsed: StreamChunk;
          try {
            parsed = JSON.parse(payload) as StreamChunk;
          } catch {
            continue; // A frame we cannot read is not worth ending the stream over.
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
            if (thinking) yield { type: 'thinking', text: delta.reasoning_content };
          }

          if (typeof delta.content === 'string' && delta.content !== '') {
            /*
             * Split inline reasoning out of the answer.
             *
             * A tag straddles deltas — llama.cpp really does send `<thi` and
             * `nk>` in separate frames — so anything at the tail that could
             * still turn into one is held back rather than emitted. Only what
             * cannot possibly be part of a tag is passed on, which keeps the
             * reply arriving smoothly without ever leaking a half-written tag
             * into it.
             */
            carry += delta.content;
            for (const event of drain(() => carry, (rest) => (carry = rest), thinking, () => inThink, (next) => (inThink = next))) {
              yield event;
            }
          }

          for (const part of delta.tool_calls ?? []) {
            const index = part.index ?? 0;
            const existing = calls.get(index) ?? { id: '', name: '', args: '' };
            calls.set(index, {
              id: part.id ?? existing.id,
              name: part.function?.name ?? existing.name,
              args: existing.args + (part.function?.arguments ?? ''),
            });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Whatever is left cannot become a tag now the stream has ended.
  if (carry !== '') yield { type: inThink ? 'thinking' : 'content', text: carry };

  // Only now are the arguments complete enough to parse.
  for (const call of calls.values()) {
    const parsed = parseCall(call);
    if (parsed) yield { type: 'tool', call: parsed };
  }
}

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/**
 * Emit everything in the buffer that is unambiguous, and keep the rest.
 *
 * "The rest" is a partial tag at the very end: `…light <thi` could become
 * `<think>`, so those four characters wait for the next frame. Anything else is
 * safe to pass on immediately, which is what keeps the reply readable as it
 * arrives.
 */
function* drain(
  read: () => string,
  write: (rest: string) => void,
  thinking: boolean,
  inThink: () => boolean,
  setThink: (next: boolean) => void,
): Generator<ChatStreamEvent> {
  let buffer = read();

  for (;;) {
    const tag = inThink() ? CLOSE_TAG : OPEN_TAG;
    const at = buffer.indexOf(tag);

    if (at >= 0) {
      const before = buffer.slice(0, at);
      if (before !== '') {
        if (inThink()) {
          if (thinking) yield { type: 'thinking', text: before };
        } else {
          yield { type: 'content', text: before };
        }
      }
      buffer = buffer.slice(at + tag.length);
      setThink(!inThink());
      continue;
    }

    /*
     * No whole tag. Emit everything except a tail that could still become one,
     * and wait for more.
     */
    const held = partialTagLength(buffer, tag);
    const safe = buffer.slice(0, buffer.length - held);
    if (safe !== '') {
      if (inThink()) {
        if (thinking) yield { type: 'thinking', text: safe };
      } else {
        yield { type: 'content', text: safe };
      }
    }
    write(buffer.slice(buffer.length - held));
    return;
  }
}

/** How many trailing characters of `text` are a prefix of `tag`. */
function partialTagLength(text: string, tag: string): number {
  const most = Math.min(tag.length - 1, text.length);
  for (let length = most; length > 0; length -= 1) {
    if (tag.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
}

/**
 * Turn accumulated arguments into a tool call, or nothing.
 *
 * A model can emit malformed JSON or invent a tool; neither should reach the
 * user as a dialog it cannot make sense of, so anything unrecognised is simply
 * dropped and the reply stands on its own.
 */
export function parseCall(call: PartialCall): ChatToolCall | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.args || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }

  const callId = call.id || `call_${Math.random().toString(36).slice(2, 10)}`;

  if (call.name === 'build_prompt') {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (prompt === '') return null;
    return {
      callId,
      tool: 'build_prompt',
      prompt,
      ...(typeof args.negativePrompt === 'string' && args.negativePrompt.trim() !== ''
        ? { negativePrompt: args.negativePrompt.trim() }
        : {}),
      reason: typeof args.reason === 'string' ? args.reason : '',
    };
  }

  if (call.name === 'prompt_blocks') {
    const raw = Array.isArray(args.blocks) ? args.blocks : [];
    const blocks = raw
      .map((entry) => {
        const block = entry as Record<string, unknown>;
        const action: ProposedBlock['action'] =
          block.action === 'update' || block.action === 'remove' ? block.action : 'add';
        const name = typeof block.name === 'string' ? block.name.trim() : '';
        const text = typeof block.text === 'string' ? block.text.trim() : '';
        if (name === '' || (action !== 'remove' && text === '')) return null;
        return {
          action,
          name,
          text,
          category: typeof block.category === 'string' ? block.category.trim() : '',
          ...(typeof block.id === 'string' && block.id !== '' ? { id: block.id } : {}),
        };
      })
      .filter((block): block is NonNullable<typeof block> => block !== null);

    if (blocks.length === 0) return null;
    return {
      callId,
      tool: 'prompt_blocks',
      reason: typeof args.reason === 'string' ? args.reason : '',
      blocks,
    };
  }

  return null;
}
