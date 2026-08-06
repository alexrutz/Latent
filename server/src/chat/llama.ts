import { Agent } from 'undici';

import type {
  ChatAttachment,
  ChatMessage,
  ChatSettings,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolName,
  ChatToolSettings,
  ProposedBlock,
  ToolEagerness,
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

/**
 * Latent's own instructions, used when the user has not written their own.
 *
 * Written for how modern image models actually read a prompt. The keyword-salad
 * style — `masterpiece, 8k, highly detailed, trending on artstation` — is a
 * habit from CLIP-era encoders. Krea 2 and its contemporaries put a language
 * model in front of the image model, so grammar and spatial relationships
 * survive: "a red chair *behind* a blue table" places the chair behind the
 * table, and a flowing sentence beats a comma-separated pile. The published
 * guidance for Krea 2 says exactly this, and adds two things worth having here:
 * quote whatever should be rendered as text, and do not pile on style
 * adjectives, which muddy the result rather than strengthening it.
 *
 * The other half of this prompt is about pace, and it matters more. The module
 * exists so that working out *what* to make is a conversation. A model that
 * answers "a lighthouse at dusk" with a finished prompt has ended that
 * conversation before it started.
 */
export const DEFAULT_SYSTEM_PROMPT = `You help someone work out what picture to
make, and then how to describe it. You are talking to them on a phone, so keep
replies short — a few sentences, no headings, no bullet lists unless they are
genuinely a list.

## What this is for

Most of the work is not writing the prompt. It is deciding what the picture is:
what is in it, what it feels like, how it is framed, what it is *for*. Do that
part with them. Offer directions, disagree, suggest the thing they did not think
of, ask what they mean by "moody". Half-formed ideas are the normal starting
point and a good place to work from.

Do not rush to a finished prompt. Building one is a tool call and interrupts
everything; it is worth doing once the picture is actually decided, not as a way
of answering the first thing they say.

## Writing an image prompt, when it is time

Modern image models read prompts with a language model, not a keyword matcher,
so write like a person describing a photograph:

- **One flowing paragraph of plain prose.** Not comma-separated tags. Grammar
  carries meaning: word order and prepositions place things in the frame.
- **Concrete over decorative.** Say what is in the picture, where it is, what
  the light is doing, how it is framed and shot. Skip "masterpiece", "8k",
  "highly detailed", "award-winning" — they do nothing and crowd out the
  description that would have worked.
- **Few style words, chosen deliberately.** One clear reference — a medium, an
  era, a named technique — beats five adjectives, which muddy each other.
- **Say the medium.** Photograph, oil painting, cel-shaded illustration, 3D
  render. If they asked for one, keep it; never quietly swap it for another.
- **Always write the prompt in English**, whatever language the conversation is
  in. Image models are trained overwhelmingly on English captions and understand
  it far better than anything else; a German prompt is a worse picture, not a
  more authentic one. Keep talking to them in their language — it is only the
  prompt itself that is always English. Proper nouns stay as they are.
- **Text in the image goes in quotation marks**, exactly as it should appear.
  That text is whatever they asked for, in whatever language they asked for —
  the English rule is about the description, not about words in the picture.
- **Stay faithful.** Everything they asked for goes in; nothing they did not ask
  for gets invented. Fill in what a description genuinely needs and leave the
  rest open — an over-specified prompt is a narrower picture, not a better one.
- **Detail is good, padding is not.** Long is fine when every clause is doing
  work.

Depict people clothed and with dignity.

## Prompt blocks

They keep a library of reusable fragments — lighting, mood, camera, subject —
that a random-prompt mode draws from. Blocks are fragments, not sentences, and
each belongs to a group.

Nothing you propose takes effect on its own: every tool call is shown to them
first and they accept, edit or refuse it. So propose things properly rather than
pasting a prompt into your reply — a pasted prompt is something they have to
copy by hand.`;

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
            description:
              'The positive prompt: one paragraph of plain English prose describing the ' +
              'picture. Always English, whatever language the conversation is in. Not ' +
              'comma-separated tags.',
          },
          negativePrompt: {
            type: 'string',
            description: 'What to avoid, also in English. Omit unless there is a reason for one.',
          },
          reason: { type: 'string', description: 'What you were going for, in a sentence.' },
        },
        required: ['prompt', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user one or more questions whose answers would change the picture, each with ' +
        'a few ready answers to tap. ALWAYS use this rather than listing options in your reply ' +
        '— options written in prose have to be typed back in by hand, which is the whole thing ' +
        'this avoids. Ask everything you need in one call rather than one question per turn.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description:
              'One to four questions, answered together. Two related decisions are one call.',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'One question, plainly put.' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Two to four short answers covering the likely ones. They can always ' +
                    'write their own instead, so these need not be exhaustive.',
                },
              },
              required: ['question', 'options'],
            },
          },
          reason: {
            type: 'string',
            description: 'Why the answers matter, in a few words.',
          },
        },
        required: ['questions', 'reason'],
      },
    },
  },
] as const;

/**
 * How readily each tool is reached for, as instructions the model can follow.
 *
 * Per tool, and settable, because "too eager" is not one judgement: being asked
 * a question mid-conversation is welcome at the same moment a finished prompt
 * would be an interruption. `off` is not a sentence at all — the tool is simply
 * not offered, which is the only setting that is a guarantee rather than an
 * instruction.
 */
const EAGERNESS: Record<ToolEagerness, string> = {
  off: '',
  'on-request':
    'ONLY when they explicitly ask for it in so many words. Never on your own initiative, however obviously useful it seems.',
  invited:
    'when they ask for it, or when they plainly invite it — "go on then", "sounds good, do it". An invitation has to be in what they just said; do not read one into agreement about the picture itself.',
  settled:
    'when what it would act on is decided and nothing is still in flux, and they have not signalled they want to keep going. Not while an idea is still being worked out.',
  ready:
    'when it looks like the sensible next step, without waiting for the decision to be final. Say in one line what you are proposing and why, so refusing is easy.',
  eager: 'whenever it would help, without waiting to be asked.',
  // Only `ask_user` offers this level; for anything else it reads as `eager`.
  always: 'whenever it would help, without waiting to be asked.',
};

/**
 * The same scale, shifted for asking questions.
 *
 * Every level means "sooner" here than it does for the other two, because the
 * costs are not comparable: a question is one tap and makes everything after it
 * better, while a finished prompt interrupts the conversation it came out of.
 * The failure people actually hit is a model listing three options in prose,
 * which then have to be typed back in by hand — so every level says the same
 * thing about that, and the quiet end of the scale still fires.
 */
const ASK_EAGERNESS: Record<ToolEagerness, string> = {
  off: '',
  'on-request':
    'when they ask you to, and whenever you would otherwise list options in prose — that list goes in this tool instead of in your reply.',
  invited:
    'whenever you are about to offer choices, and whenever a decision you cannot make for them is in the way. Never write options out in prose; that is what this tool is.',
  settled:
    'whenever a decision would change the picture and the conversation has not already made it. Never list options in prose — they go here instead.',
  ready:
    'freely, whenever an answer would make what comes next better. Ask about several things in one call rather than one per turn, and never list options in prose.',
  eager:
    'at every opportunity. If there is anything at all you are unsure of, ask — several questions in one call — and never list options in prose.',
  always:
    'for EVERY question you ask. You have no other way to ask one: a question written in your reply cannot be tapped, so it never counts. If you are about to ask anything, or about to list options in prose, that goes in this tool instead — several questions in one call.',
};

/**
 * Whether a reply is asking something and spelling out the answers itself.
 *
 * The thing `always` exists to catch. Deliberately conservative — it fires a
 * second request at the model, so a false positive costs a wait — which means
 * two signals have to agree: the reply asks something, and it enumerates short
 * alternatives. Prose that merely contains a question mark is left alone.
 */
export function looksLikeAQuestionWithOptions(text: string): boolean {
  if (!text.includes('?')) return false;

  const lines = text.split('\n').map((line) => line.trim());

  // A list of short items: two to four bullets or numbers, none of them a
  // paragraph. A long bulleted list is an explanation, not a set of answers.
  const listed = lines.filter((line) => /^([-*+•]|\d{1,2}[.)])\s+\S/.test(line));
  if (listed.length >= 2 && listed.length <= 5 && listed.every((line) => line.length <= 90)) {
    return true;
  }

  /*
   * Or an inline either/or. Both languages, because the conversation is as
   * often German as English, and bounded on both sides so "a photograph or
   * something like it, shot on a long lens in the late afternoon" does not
   * count as an offer of two choices.
   */
  return lines.some(
    (line) =>
      line.endsWith('?') &&
      line.length <= 120 &&
      /\s(or|oder)\s/i.test(line),
  );
}

/** Ready answers for a question about pace, spelled out so a small model follows them. */
const ON_REQUEST_EXAMPLES: Partial<Record<ChatToolName, string>> = {
  build_prompt:
    'Explicit means a sentence like "write me a prompt", "give me a prompt", "generate it now", ' +
    '"erstelle mir einen prompt", "gib mir einen prompt" or "generiere jetzt das bild". ' +
    'Talking about the picture, agreeing on it, or saying it sounds good is not asking for it.',
  prompt_blocks:
    'Explicit means asking for blocks — "add these as blocks", "mach daraus blöcke". ' +
    'Coming up with good phrases in conversation is not.',
};

/**
 * The policy section appended to whatever instructions are in force.
 *
 * Appended rather than woven in, so it applies to a hand-written system prompt
 * too: the pace settings belong to the app, not to the wording of the prompt,
 * and a user who replaces the instructions should not silently lose them.
 */
export function toolPolicy(tools: ChatToolSettings): string {
  const lines: string[] = [];

  for (const name of TOOL_ORDER) {
    const level = tools[name];
    if (level === 'off') continue;
    if (name === 'ask_user') {
      lines.push(`- \`ask_user\`: use it ${ASK_EAGERNESS[level]}`);
      continue;
    }
    const extra = level === 'on-request' ? ` ${ON_REQUEST_EXAMPLES[name] ?? ''}`.trimEnd() : '';
    lines.push(`- \`${name}\`: use it ${EAGERNESS[level]}${extra}`);
  }

  if (lines.length === 0) {
    return '\n\n## Tools\n\nNone are available. Answer in words.';
  }

  return `\n\n## When to use each tool\n\n${lines.join('\n')}`;
}

const TOOL_ORDER: ChatToolName[] = ['build_prompt', 'prompt_blocks', 'ask_user'];

/** The tools this configuration offers at all. `off` means genuinely absent. */
export function enabledTools(tools: ChatToolSettings) {
  return TOOLS.filter((tool) => tools[tool.function.name as ChatToolName] !== 'off');
}

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
    // Latent's own. See `ChatRole`: it is transcript, not conversation.
    if (message.role === 'note') continue;

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
  /**
   * Set only when the preset opts into an unsigned certificate.
   *
   * The same arrangement ComfyUI's connections use, and for the same reason: a
   * rented box serves HTTPS with a certificate nothing signed, and there is no
   * way to reach it otherwise. Per-client and off by default, so nothing else
   * loses verification for it.
   */
  private readonly dispatcher: Agent | undefined;

  constructor(private readonly settings: ChatSettings) {
    this.dispatcher = settings.allowSelfSigned
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  private url(path: string): string {
    return new URL(path, this.settings.baseUrl.replace(/\/+$/, '') + '/').toString();
  }

  /** Whatever the connection needs on every request. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const key = this.settings.apiKey.trim();
    return { ...extra, ...(key === '' ? {} : { authorization: `Bearer ${key}` }) };
  }

  /**
   * Undici's dispatcher, which the global `fetch` accepts but does not type.
   *
   * The same cast the ComfyUI client makes: Node's `fetch` is undici's, and
   * these are the same object at runtime.
   */
  private request(): Record<string, unknown> {
    return this.dispatcher ? { dispatcher: this.dispatcher } : {};
  }

  /** What the server has loaded. Used only to tell the user it is reachable. */
  async models(): Promise<string[]> {
    const response = await fetch(this.url('v1/models'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(5_000),
      ...this.request(),
    } as RequestInit);
    if (response.status === 401 || response.status === 403) {
      throw new LlamaError(
        'The model server refused the token. Check the key under Settings → Chat.',
      );
    }
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
    options: { signal?: AbortSignal; force?: ChatToolName } = {},
  ): AsyncGenerator<ChatStreamEvent> {
    /*
     * A forced tool is offered even when its setting is `off`.
     *
     * The setting is about what the model does on its own. Pressing the button
     * is not the model's initiative — it is an instruction, and refusing to
     * carry it out because of a pace setting would be obtuse.
     */
    const tools = options.force
      ? TOOLS.filter((tool) => tool.function.name === options.force)
      : enabledTools(this.settings.tools);
    const body = {
      ...(this.settings.model ? { model: this.settings.model } : {}),
      messages: toApiMessages(
        messages,
        (this.settings.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT) +
          toolPolicy(this.settings.tools),
      ),
      temperature: this.settings.temperature,
      ...(this.settings.maxTokens > 0 ? { max_tokens: this.settings.maxTokens } : {}),
      stream: true,
      ...(tools.length > 0
        ? {
            tools,
            tool_choice: options.force
              ? { type: 'function', function: { name: options.force } }
              : 'auto',
          }
        : {}),
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
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
        ...this.request(),
      } as RequestInit);
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
  const reasoning = inlineReasoning(thinking);

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
            yield* reasoning.push(delta.content);
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

  yield* reasoning.end();

  // Only now are the arguments complete enough to parse.
  for (const call of calls.values()) {
    const parsed = parseCall(call);
    if (parsed) yield { type: 'tool', call: parsed };
  }
}

/**
 * The ways a model marks its reasoning inside the content stream.
 *
 * The clean path is `reasoning_content`, a field of its own, and most builds
 * use it. The rest inline the reasoning in the answer, and there is no shared
 * convention — so this is a list rather than a constant:
 *
 * - `<think>` is the DeepSeek-R1 wording, which Qwen and most of the
 *   distillations copied.
 * - `<|channel>thought` is Gemma 4's. Its template is supposed to keep the
 *   thought channel out of the visible output, and in llama.cpp it routinely
 *   does not — the channel tokens arrive in `content` like everything else.
 * - `<thought>` and `<reasoning>` turn up in fine-tunes often enough to be
 *   worth the two lines it costs to read them.
 *
 * Longest opener first, so `<|channel>thought` is not mistaken for anything
 * shorter that happens to share a prefix.
 */
const THINK_TAGS: { open: string; close: string }[] = [
  { open: '<|channel>thought', close: '<channel|>' },
  { open: '<think>', close: '</think>' },
  { open: '<thought>', close: '</thought>' },
  { open: '<reasoning>', close: '</reasoning>' },
];

/**
 * Pulls inline reasoning out of a content stream, one delta at a time.
 *
 * Stateful because it has to be: a tag straddles deltas — llama.cpp really does
 * send `<thi` and `nk>` in separate frames — so a tail that could still become
 * one is held back until the next delta says whether it did. Everything else is
 * passed on immediately, which is what keeps the reply arriving smoothly rather
 * than in tag-sized jumps.
 *
 * Which family opened the block is remembered, not just *that* one did: a reply
 * that opened with Gemma's channel token has to be closed by Gemma's, and not
 * by a `</think>` that happens to appear in the prose.
 */
export function inlineReasoning(thinking: boolean) {
  /** Content held back because it might be the start of a tag. */
  let carry = '';
  /** Which tag family we are inside, or −1 outside one. */
  let open = -1;

  const emit = function* (text: string): Generator<ChatStreamEvent> {
    if (text === '') return;
    if (open >= 0) {
      if (thinking) yield { type: 'thinking', text };
    } else {
      yield { type: 'content', text };
    }
  };

  return {
    *push(delta: string): Generator<ChatStreamEvent> {
      carry += delta;

      for (;;) {
        const inside = open;
        const tags = inside >= 0 ? [THINK_TAGS[inside]!.close] : THINK_TAGS.map((tag) => tag.open);

        // The earliest of the tags we are watching for, so two families in one
        // buffer are handled in the order they actually appear.
        let at = -1;
        let which = -1;
        for (const [index, tag] of tags.entries()) {
          const found = carry.indexOf(tag);
          if (found >= 0 && (at < 0 || found < at)) {
            at = found;
            which = index;
          }
        }

        if (at >= 0) {
          yield* emit(carry.slice(0, at));
          carry = carry.slice(at + tags[which]!.length);
          open = inside >= 0 ? -1 : which;
          // Gemma's opener is followed by a newline that belongs to the token
          // rather than to the reasoning.
          if (open >= 0 && carry.startsWith('\n')) carry = carry.slice(1);
          continue;
        }

        const held = Math.max(...tags.map((tag) => partialTagLength(carry, tag)));
        yield* emit(carry.slice(0, carry.length - held));
        carry = carry.slice(carry.length - held);
        return;
      }
    },

    /** Whatever is left cannot become a tag now the stream has ended. */
    *end(): Generator<ChatStreamEvent> {
      yield* emit(carry);
      carry = '';
    },
  };
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

  if (call.name === 'ask_user') {
    /*
     * Both shapes. `questions` is what the tool asks for; a single `question`
     * is what smaller models produce anyway, having seen a thousand examples of
     * it — refusing that would mean the tool silently doing nothing.
     */
    const raw: unknown[] = Array.isArray(args.questions)
      ? args.questions
      : [{ question: args.question, options: args.options }];

    const questions = raw
      .map((entry) => {
        const item = (entry ?? {}) as { question?: unknown; options?: unknown };
        const question = typeof item.question === 'string' ? item.question.trim() : '';
        if (question === '') return null;
        return {
          question,
          options: (Array.isArray(item.options) ? item.options : [])
            .map((option) => (typeof option === 'string' ? option.trim() : ''))
            .filter((option) => option !== '')
            // Four is what fits on a phone without the question scrolling off.
            .slice(0, 4),
        };
      })
      .filter((entry): entry is { question: string; options: string[] } => entry !== null)
      .slice(0, 4);

    if (questions.length === 0) return null;
    return {
      callId,
      tool: 'ask_user',
      questions,
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
