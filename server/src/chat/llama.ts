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
  PromptDetail,
  ReviewAsk,
  ReviewThreshold,
  TasteInfluence,
  TasteProfile,
  ToolEagerness,
} from '@latent/shared';
import { samplingOverrides } from '@latent/shared';

import { authHeaders, type ConnectionConfig } from '../comfy/connection.js';
import { activeTaste } from '../taste.js';

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

## Looking at a picture that came out

When you are shown a render made from one of your prompts, judge it. Describe
what is actually in the frame — including the parts that are not what the prompt
asked for — rather than what the prompt led you to expect. A compliment about a
picture that missed is worse than useless, because the next prompt gets built on
it. If you propose a rewrite, change what did not work and keep the wording that
did.

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
 * The tool that only exists on the turn after a picture.
 *
 * Kept out of `TOOLS` deliberately. Everything in that list is offered on every
 * turn and governed by a pace setting; this one is offered on exactly one turn
 * — the one where the model has just been shown what the last prompt produced —
 * and offering it any earlier would invite a rewrite of a prompt whose result
 * nobody has seen.
 */
export const REVIEW_TOOL = {
  type: 'function',
  function: {
    name: 'revise_prompt',
    description:
      'Propose a rewritten prompt, after looking at the picture the last one produced. ' +
      'Only for what the picture actually got wrong: name the difference, then fix it in ' +
      'the prompt. The user can generate it straight away or refuse it.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The rewritten positive prompt, whole rather than a fragment: one paragraph ' +
            'of plain English prose. Keep everything that worked and change what did not.',
        },
        negativePrompt: {
          type: 'string',
          description: 'What to avoid, also in English. Omit unless there is a reason for one.',
        },
        reason: {
          type: 'string',
          description:
            'What the picture got wrong and what the change is meant to fix, in a sentence.',
        },
        score: {
          type: 'number',
          description: 'How well the picture matched the prompt it came from, from 0 to 10.',
        },
      },
      required: ['prompt', 'reason', 'score'],
    },
  },
} as const;

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

/**
 * How far a prompt goes in settling the picture.
 *
 * Instructions rather than a word count. "Two sentences" is a rule a model
 * follows by truncating the wrong half; what is actually being chosen is how
 * much of the scene is decided in the prompt and how much is left to the
 * sampler — which is a different picture at each end, not a longer one.
 */
const PROMPT_DETAIL: Record<PromptDetail, string> = {
  sparse:
    'Keep prompts short — a sentence or two naming the subject, the medium and one or two ' +
    'things about how it looks. Leave everything else open; the model fills it in differently ' +
    'every seed, which is the point.',
  plain:
    'Keep prompts brief: the subject, the medium, the light and the framing, and little else. ' +
    'Say what the picture is, not everything that is in it.',
  balanced:
    'Write a prompt that settles the picture without exhausting it: subject, setting, light, ' +
    'framing, medium, and the two or three details that make it that picture rather than a ' +
    'generic one. Leave the rest open.',
  detailed:
    'Work the scene out properly: subject and what it is doing, the setting and its details, ' +
    'the light and its direction, the framing and lens, the medium and its texture, colour and ' +
    'mood. Every clause should be doing work — length is fine, padding is not.',
  elaborate:
    'Describe the picture exhaustively, as a paragraph that leaves nothing important to chance: ' +
    'the subject in detail, everything else in the frame and where it sits, the quality and ' +
    'direction of the light, the colour palette, the lens and the distance, the medium and its ' +
    'surface, the atmosphere. Say what is in the background as well as the foreground. Still no ' +
    'keyword piles and no "masterpiece" — this is more description, not more adjectives.',
};

/**
 * The section that says how much a prompt spells out.
 *
 * Appended like the tool policy, and for the same reason: it belongs to the app
 * rather than to the wording of the instructions, so replacing those does not
 * silently lose it.
 */
export function detailPolicy(detail: PromptDetail): string {
  return `\n\n## How much detail a prompt goes into\n\n${PROMPT_DETAIL[detail] ?? PROMPT_DETAIL.balanced}`;
}

/**
 * How far the user's own notes are allowed to reach.
 *
 * Every level is a statement about *empty space*, not about authority. The user
 * asked for this to shape things when they have not said what they want and to
 * keep its hands off when they have, so each wording says which of the two
 * situations it applies in rather than how strongly to push.
 */
const TASTE_REACH: Record<Exclude<TasteInfluence, 'off'>, string> = {
  sparingly:
    'Use it only when they have given you nothing to go on — "surprise me", "I don\'t know what ' +
    'I want", or a request for an idea with no subject in it. The moment they name something, ' +
    'work on that instead and leave the notes alone.',
  hints:
    'Use it to fill in what they have left open. If they have only a vague idea — a mood, a word, ' +
    '"something quiet" — let the notes colour the details you choose around it. If they have ' +
    'named the picture they want, build that picture; the notes may inform small choices nobody ' +
    'specified, and nothing more.',
  guiding:
    'Let it shape what you suggest wherever it does not contradict them: the settings you reach ' +
    'for first, the light, the treatment, what you offer when they ask for options. Anything ' +
    'they actually asked for still wins outright.',
  strong:
    'Treat it as the house style. Start from it for every idea and every prompt, and only step ' +
    'outside it where they have asked for something else — which they then get, exactly as ' +
    'asked, without argument.',
};

/**
 * The section that tells the model what the user likes.
 *
 * Absent entirely at `off`, when nothing is switched on, and when the vault is
 * locked so the notes cannot be read — in all three cases the model is told
 * nothing rather than told about an empty list, because a heading with nothing
 * under it invites a small model to invent the contents. `off` silences the
 * standing notes too: it is the master switch, and a setting called Off that
 * still sends something would be worth nothing.
 *
 * Two sections rather than one, because they are two different instructions.
 * The ordinary notes fill the space the user left and step aside when they say
 * what they want. The standing ones do not step aside — but they are bounded by
 * relevance instead, which is the part that needs saying out loud: a note about
 * colour has no business in a request for a line drawing, and a model handed
 * "this always applies" without that limit will work every one of them into
 * every prompt.
 *
 * The notes go in as plain lines of the user's own words. No instruction to
 * quote them, and one not to: they are never shown in the chat, so reciting
 * them back would be both strange and a small leak of something written down
 * privately.
 */
export function tastePolicy(profile: TasteProfile | null, level: TasteInfluence): string {
  if (!profile || level === 'off') return '';

  const { groups, standing } = activeTaste(profile);
  if (groups.length === 0 && standing.length === 0) return '';

  const sections: string[] = [];

  if (groups.length > 0) {
    const body = groups
      .map((group) => {
        const notes = group.notes.map((note) => `- ${note}`).join('\n');
        return group.heading ? `**${group.heading}**\n${notes}` : notes;
      })
      .join('\n\n');

    sections.push(
      'Notes they have written about their own taste — concepts, aesthetics, things they keep ' +
        `coming back to.\n\n${body}\n\n${TASTE_REACH[level]}`,
    );
  }

  if (standing.length > 0) {
    sections.push(
      '### Things that always hold\n\n' +
        'These are settled preferences rather than starting points, so they apply even when they ' +
        'have told you exactly what they want:\n\n' +
        standing.map((note) => `- ${note}`).join('\n') +
        '\n\n' +
        /*
         * The limit that makes the override usable.
         *
         * Without it, "this always applies" is read as "put this in every
         * prompt", and a standing note about colour turns up in a request for
         * a line drawing. Relevance is the whole of the constraint: apply it
         * where it bears on the picture, and say nothing where it does not.
         */
        'Apply each one only where it actually bears on the picture in hand. If a note has no ' +
        'part in what is being made — a note about colour in a line drawing, a note about ' +
        'framing in a question about wording — leave it out entirely. Do not bend the picture to ' +
        'give a note something to do, and do not list them.',
    );
  }

  return (
    '\n\n## What this person likes\n\n' +
    sections.join('\n\n') +
    '\n\n' +
    /*
     * The one rule that does not move with the setting.
     *
     * Spelled out at every level rather than only at the gentle ones: the
     * failure this feature could cause is a picture nobody asked for, and a
     * model reading "house style" without this line is exactly the model that
     * would produce one. It holds for the standing notes as well — those
     * override the *scale*, not the person.
     */
    'Whatever they have actually asked for is what they get. These notes fill in what they left ' +
    'open; they never overrule what was said.\n\n' +
    'Never read the list back to them, quote it, or say that you are using it. They wrote it; ' +
    'they know what is in it. It shows in what you suggest, not in what you say.'
  );
}

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
export function toApiMessages(
  messages: ChatMessage[],
  systemPrompt: string,
  /**
   * Renders to put back into the conversation, by the message that made them.
   *
   * Empty for a text-only server, and for the setting that keeps none in view.
   * See `loadConversationPictures`: a model that saw a picture once, three
   * turns ago, is working from its own description of it by the time anybody
   * asks for a change.
   */
  pictures: Map<string, string> = new Map(),
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: systemPrompt }];

  /**
   * The picture that message produced, as a turn of its own.
   *
   * A user turn, because that is the only role every chat template renders an
   * image in — and because it is true: here is what came out, look at it. It
   * goes immediately after the message that started the run, so the order of
   * the conversation is the order things actually happened in.
   */
  const showPicture = (message: ChatMessage): void => {
    const dataUrl = pictures.get(message.id);
    if (!dataUrl) return;
    out.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        {
          type: 'text',
          text: message.prompt
            ? `This is what that prompt produced: "${message.prompt}"`
            : 'This is the picture that produced.',
        },
      ],
    });
  };

  for (const message of messages) {
    /*
     * Latent's own. See `ChatRole`: it is transcript, not conversation — but
     * the picture it points at is not, and a re-run the model is never told
     * about is a picture it will be asked to change without knowing it exists.
     */
    if (message.role === 'note') {
      showPicture(message);
      continue;
    }

    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCall?.callId ?? 'unknown',
        content: message.content,
      });
      showPicture(message);
      continue;
    }

    if (message.role === 'assistant') {
      const call = message.toolCall;
      out.push({
        role: 'assistant',
        content: message.content,
        ...(call
          ? {
              tool_calls: [
                {
                  id: call.callId,
                  type: 'function' as const,
                  function: { name: call.tool, arguments: JSON.stringify(toolArguments(call)) },
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

/**
 * A tool call as the model wrote it: the arguments, and nothing else.
 *
 * `tool` is the function's name and `callId` is the envelope llama.cpp put it
 * in — Latent's own fields, neither declared in the tool's parameters. Sending
 * them back as if the model had produced them shows it, every turn from then
 * on, an example of a call it would never make.
 */
function toolArguments(call: ChatToolCall): Record<string, unknown> {
  const args: Record<string, unknown> = { ...call };
  delete args.callId;
  delete args.tool;
  // Which turn the question was asked on is Latent's note to itself, and a
  // field the tool never declared teaches the model to send it back.
  delete args.fromReview;
  return args;
}

/**
 * What the button asked for, said as a turn the model can answer.
 *
 * Forcing the tool is not enough on its own. Pressing ✦ adds nothing to the
 * conversation, so the request that goes out ends on the assistant's own last
 * message — and asked to speak again straight after itself, a model repeats
 * what it just said. That is the whole of the "it just sends the last message
 * again" fault: there was no turn saying what had been asked for.
 */
const FORCED_INSTRUCTIONS: Record<ChatToolName, string> = {
  build_prompt:
    'Write the image prompt now, with the `build_prompt` tool, from everything said so ' +
    'far. Do not answer in words and do not ask anything first.',
  prompt_blocks:
    'Propose the prompt blocks now, with the `prompt_blocks` tool. Do not answer in words.',
  ask_user: 'Ask what you still need to know now, with the `ask_user` tool.',
};

/**
 * What each level of perfectionism means, said as a standard to hold to.
 *
 * A number *and* a sentence. The number alone is not something a model applies
 * consistently — "is this a 6 or a 7" is exactly the judgement it is bad at —
 * and the sentence alone leaves "too far apart" to be decided fresh every time.
 * Together they are reproducible enough that moving the setting one step
 * visibly changes what comes back.
 */
const REVIEW_THRESHOLDS: Record<ReviewThreshold, { score: number; standard: string }> = {
  never: {
    score: 0,
    standard:
      'Do NOT propose a new prompt, whatever you find. Say how well it turned out and leave ' +
      'it there; they will ask if they want a change.',
  },
  wrong: {
    score: 3,
    standard:
      'Only propose a rewrite if the picture is plainly not what was asked for — the wrong ' +
      'subject, the wrong medium, something central missing. Anything that is recognisably ' +
      'the picture described stands.',
  },
  loose: {
    score: 5,
    standard:
      'Propose a rewrite when something the prompt actually called for is missing or wrong. ' +
      'Differences of degree — a little darker, a slightly different angle — are not worth one.',
  },
  balanced: {
    score: 7,
    standard:
      'Propose a rewrite when a noticeable part of the prompt did not come through. Small ' +
      'imperfections that do not change what the picture is are not worth one.',
  },
  strict: {
    score: 8,
    standard:
      'Propose a rewrite whenever any part of the prompt is not there or not as described, ' +
      'including details of light, framing and material.',
  },
  exacting: {
    score: 10,
    standard:
      'Propose a rewrite unless the picture is exactly what the prompt describes, in every ' +
      'detail it names. Near enough is not enough here.',
  },
};

/**
 * When it stops and asks rather than deciding for you.
 *
 * The failure this exists for is a confident rewrite of the wrong thing. A
 * picture can miss for several reasons at once, and which of them to chase is
 * often a matter of taste — so the useful move is to say what is off and offer
 * two or three ways to go at it, which is one tap to answer.
 */
const REVIEW_ASKS: Record<ReviewAsk, string> = {
  never: '',
  unclear:
    'If you genuinely cannot tell what went wrong — the picture is off but not in a way you ' +
    'can name — call `ask_user` instead, with what you suspect as the options.',
  unsure:
    'If you are not sure which of several fixes they would want, call `ask_user` instead of ' +
    'guessing: name what is off, and offer two to four concrete ways to improve how closely ' +
    'the picture follows the prompt. Rewrite it yourself only when the fix is obvious.',
  often:
    'Whenever there is more than one sensible way to improve the match, call `ask_user` rather ' +
    'than choosing for them: two to four concrete options, each a different way of closing the ' +
    'gap. Rewrite it yourself only when there is exactly one thing to change.',
  always:
    'Always call `ask_user` before rewriting anything: say what came through and what did not, ' +
    'and offer two to four concrete ways to improve the match for them to choose from. Do not ' +
    'call `revise_prompt` until they have answered.',
};

/**
 * The turn that shows the model what its prompt produced.
 *
 * Phrased as the user handing over a picture, because that is the only turn a
 * chat template is guaranteed to render with an image in it — and because it is
 * true: this is the result, and the question is whether it is what was asked
 * for. The prompt is repeated in full rather than pointed at, since it may be
 * twenty messages back and half of it was written by a tool call.
 */
export function reviewInstruction(
  prompt: string,
  threshold: ReviewThreshold,
  askWhen: ReviewAsk = 'never',
  /** True while the run is accepting its own proposals; see `AutonomousRun`. */
  autonomous = false,
): string {
  const { score, standard } = REVIEW_THRESHOLDS[threshold];

  const lines = [
    'Look at the picture that prompt produced. Compare it with the prompt and say how well ' +
      'it was carried out.',
    '',
    'The prompt was:',
    '',
    prompt.trim(),
    '',
    'Say in two or three sentences what came through and what did not. Be concrete: name ' +
      'what you can see, not what you would expect to see. Score the match out of 10.',
  ];

  if (threshold !== 'never') {
    lines.push(
      '',
      `If it scores below ${score} out of 10, call \`revise_prompt\` with a rewritten prompt ` +
        'that keeps everything which worked and fixes what did not. ' +
        standard,
    );
    /*
     * Nobody is at the other end of a question right now.
     *
     * The ask tool is withheld from the request as well — see `reviewTools` —
     * but a model that has been told it may ask will write the question into
     * its answer instead, and an unattended loop then stops on a question
     * nobody reads. Better to say plainly that the choice is its to make.
     */
    if (autonomous) {
      lines.push(
        '',
        'The user has left this running and is not answering questions. Do not ask which way ' +
          'to go: either rewrite the prompt yourself, or say it is good enough and stop. ' +
          `Once it clears ${score} out of 10, say so and call nothing.`,
      );
    } else if (REVIEW_ASKS[askWhen] !== '') {
      lines.push('', REVIEW_ASKS[askWhen]);
    }
    // One or the other, never both: two dialogs about one picture is two
    // decisions where the user asked for one.
    lines.push('', 'Call at most one tool. Say your judgement in words either way.');
  } else {
    lines.push('', standard);
  }

  return lines.join('\n');
}

/**
 * Add that turn, folding it into the last one when that is already the user's.
 *
 * Two user messages in a row is something several chat templates refuse
 * outright — Mistral's raises rather than rendering — and the instruction is
 * the same instruction either way.
 */
export function withForcedInstruction(
  messages: OpenAiMessage[],
  force: ChatToolName,
): OpenAiMessage[] {
  const text = FORCED_INSTRUCTIONS[force];
  const last = messages[messages.length - 1];
  if (last?.role !== 'user') return [...messages, { role: 'user', content: text }];

  const merged: OpenAiMessage =
    typeof last.content === 'string'
      ? { ...last, content: `${last.content}\n\n${text}` }
      : { ...last, content: [...last.content, { type: 'text', text }] };
  return [...messages.slice(0, -1), merged];
}

/** The tools a review turn offers: a rewrite, a question, or neither. */
function reviewTools(review: ReviewTurn): unknown[] {
  const tools: unknown[] = [];
  if (review.threshold !== 'never') tools.push(REVIEW_TOOL);
  // A question is a dialog waiting for a tap, and the point of an autonomous
  // run is that there is nobody to tap it. Offering the tool anyway is how a
  // loop ends parked on a question nobody sees for an hour.
  if (review.askWhen !== 'never' && !review.autonomous) {
    const ask = TOOLS.find((tool) => tool.function.name === 'ask_user');
    if (ask) tools.push(ask);
  }
  return tools;
}

/** What the model is shown, and how picky it is asked to be, after a render. */
export interface ReviewTurn {
  /** The finished picture, small enough to be worth prefilling. */
  dataUrl: string;
  /** The prompt it was made from, repeated so it need not be hunted for. */
  prompt: string;
  threshold: ReviewThreshold;
  /** How readily it asks rather than rewriting the prompt itself. */
  askWhen: ReviewAsk;
  /**
   * True while the run accepts its own proposals and carries on by itself.
   *
   * Changes two things about this turn: no question tool, and the instruction
   * says why. Everything else — the threshold, the standard, the rewrite — is
   * exactly what it is when somebody is watching, because the judgement being
   * asked for is the same one.
   */
  autonomous: boolean;
  /** True when the history already carries it, so it is not sent twice. */
  inHistory: boolean;
}

/**
 * The picture, handed over as a turn.
 *
 * A user turn rather than an assistant one: an image inside an assistant
 * message is not something every chat template renders, and this genuinely is
 * the user's side of the exchange — here is what your prompt made, what do you
 * make of it.
 */
function reviewTurn(review: ReviewTurn): OpenAiMessage {
  const instruction = reviewInstruction(
    review.prompt,
    review.threshold,
    review.askWhen,
    review.autonomous,
  );

  /*
   * The picture only when it is not already there.
   *
   * With renders kept in view it is the message immediately above this one, and
   * sending it twice is a second thousand tokens of prefill for a model that is
   * looking at the same thing. With none kept — the setting that says "only
   * while you judge it" — this turn is the one place it appears.
   */
  if (!review.inHistory) {
    return {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: review.dataUrl } },
        { type: 'text', text: instruction },
      ],
    };
  }

  return { role: 'user', content: instruction };
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

/**
 * One model server, reached the same way ComfyUI is.
 *
 * The address, the token and the certificate come from a `ConnectionConfig`,
 * exactly as they do for ComfyUI, because the problem is the same one: the
 * useful model servers are on rented boxes behind a proxy that wants an
 * `Authorization` header and serves a certificate nobody signed. Everything
 * about *what to say* stays in `ChatSettings`; everything about *how to reach
 * it* is the connection.
 */
export class LlamaClient {
  /**
   * Set only when the connection opts into an unsigned certificate.
   *
   * The same arrangement ComfyUI's connections use, and for the same reason: a
   * rented box serves HTTPS with a certificate nothing signed, and there is no
   * way to reach it otherwise. Per-client and off by default, so nothing else
   * loses verification for it.
   */
  private readonly dispatcher: Agent | undefined;

  constructor(
    private readonly connection: ConnectionConfig,
    private readonly settings: ChatSettings,
    /** The instructions in force, already resolved. Empty uses Latent's own. */
    private readonly systemPrompt: string = '',
    /**
     * What the user likes, if it could be read.
     *
     * Passed in rather than fetched: reading it needs the vault, which belongs
     * to the server rather than to a client that talks to a model. `null` for
     * a locked server, and the section is then simply absent.
     */
    private readonly taste: TasteProfile | null = null,
  ) {
    this.dispatcher = connection.allowSelfSigned
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  private url(path: string): string {
    return new URL(path, this.connection.url.replace(/\/+$/, '') + '/').toString();
  }

  /** Auth header and TLS agent, added to every request this client makes. */
  private init(extra: RequestInit = {}): RequestInit {
    // `Omit` then widen: @types/node declares `dispatcher` with its own bundled
    // undici types, which do not line up with the installed package's `Agent`.
    // They are the same object at runtime.
    const init: Omit<RequestInit, 'dispatcher'> & { dispatcher?: unknown } = {
      ...extra,
      headers: { ...authHeaders(this.connection), ...(extra.headers ?? {}) },
    };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    return init as RequestInit;
  }

  /** Release the TLS agent's sockets. */
  async close(): Promise<void> {
    await this.dispatcher?.close().catch(() => undefined);
  }

  /** What the server has loaded. Used only to tell the user it is reachable. */
  async models(): Promise<string[]> {
    const response = await fetch(
      this.url('v1/models'),
      this.init({ signal: AbortSignal.timeout(5_000) }),
    );
    if (response.status === 401 || response.status === 403) {
      throw new LlamaError(
        'The model server refused the token. Check it under Settings → Connections.',
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
    options: {
      signal?: AbortSignal;
      force?: ChatToolName;
      withoutTools?: boolean;
      /**
       * Show it the picture that came out, and have it marked against the
       * prompt. Only ever set for the turn straight after a render.
       */
      review?: ReviewTurn;
      /** Renders to keep in the conversation; see `toApiMessages`. */
      pictures?: Map<string, string>;
    } = {},
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
      : options.review
        ? /*
           * Two at most, and both about the picture in front of it.
           *
           * A rewrite when it knows what to change, and a question when it does
           * not — which is the difference between a useful proposal and a
           * confident one that fixes the wrong thing. Everything else is
           * withheld on this turn exactly as it was before the review existed:
           * what is wanted here is a judgement, not a fresh proposal on top of
           * a picture nobody has looked at yet.
           */
          reviewTools(options.review)
        : options.withoutTools
          ? []
          : enabledTools(this.settings.tools);

    const history = toApiMessages(
      messages,
      (this.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT) +
        toolPolicy(this.settings.tools) +
        detailPolicy(this.settings.promptDetail) +
        tastePolicy(this.taste, this.settings.taste),
      options.pictures,
    );
    // A forced call needs a turn of its own to answer; see the comment there.
    const conversation = options.force
      ? withForcedInstruction(history, options.force)
      : options.review
        ? [...history, reviewTurn(options.review)]
        : history;

    const body = {
      ...(this.settings.model ? { model: this.settings.model } : {}),
      messages: conversation,
      /*
       * Sampling: only what was explicitly switched on.
       *
       * llama.cpp is started with the sampling its model wants — the flags are
       * in the launch command, and a Gemma and a Qwen do not want the same
       * ones. Sending a full set from here would override all of that with
       * whatever was last left in a settings box, which is a worse answer than
       * the server's own and one nobody could see being applied. So each
       * parameter is off until asked for, and an untouched install sends none
       * of them — the request is byte-for-byte what it was before any of this
       * existed.
       */
      ...samplingOverrides(this.settings.sampling),
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
      response = await fetch(
        this.url('v1/chat/completions'),
        this.init({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
        }),
      );
    } catch (error) {
      throw new LlamaError(
        `No answer from the model server at ${this.connection.url}. ` +
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

  /*
   * A rewrite is a `build_prompt` with a mark out of ten attached, so it is
   * read the same way and kept apart by its name alone.
   */
  if (call.name === 'revise_prompt') {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (prompt === '') return null;
    const score = Number(args.score);
    return {
      callId,
      tool: 'revise_prompt',
      prompt,
      ...(typeof args.negativePrompt === 'string' && args.negativePrompt.trim() !== ''
        ? { negativePrompt: args.negativePrompt.trim() }
        : {}),
      reason: typeof args.reason === 'string' ? args.reason : '',
      ...(Number.isFinite(score) ? { score: Math.max(0, Math.min(10, score)) } : {}),
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
