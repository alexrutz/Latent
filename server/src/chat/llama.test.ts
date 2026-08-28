import { describe, expect, it } from 'vitest';

import { DEFAULT_WANDER_DRAW } from '@latent/shared';
import type {
  ChatMessage,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolSettings,
  TasteEntry,
  TasteProfile,
} from '@latent/shared';

import { activeTaste, drawTaste } from '../taste.js';
import {
  detailPolicy,
  enabledTools,
  inlineReasoning,
  looksLikeAQuestionWithOptions,
  parseCall,
  reviewInstruction,
  toApiMessages,
  tastePolicy,
  toolPolicy,
  wanderInstruction,
  withForcedInstruction,
} from './llama.js';

/**
 * The parts of the chat client that are decisions rather than plumbing.
 *
 * The streaming and the tag-straddling are covered end to end against the mock
 * server, where they can actually go wrong. What is worth testing here is what
 * the settings *mean*: which tools the model is handed, what it is told about
 * when to use them, and what happens to a call that arrives malformed.
 */

const ALL: ChatToolSettings = {
  build_prompt: 'settled',
  prompt_blocks: 'settled',
  ask_user: 'settled',
};

describe('which tools the model gets', () => {
  it('offers everything that is not switched off', () => {
    expect(enabledTools(ALL).map((tool) => tool.function.name)).toEqual([
      'prompt_blocks',
      'build_prompt',
      'ask_user',
    ]);
  });

  /**
   * The one setting that is a guarantee.
   *
   * Every other level is an instruction, and an instruction is something a
   * small model can talk itself out of. `off` has to mean the tool is not in
   * the request at all, or the setting is a suggestion too.
   */
  it('leaves a tool that is off out of the request entirely', () => {
    const tools = enabledTools({ ...ALL, build_prompt: 'off' });
    expect(tools.map((tool) => tool.function.name)).not.toContain('build_prompt');
  });

  it('offers nothing when everything is off', () => {
    expect(enabledTools({ build_prompt: 'off', prompt_blocks: 'off', ask_user: 'off' })).toEqual(
      [],
    );
  });
});

describe('what the model is told about pace', () => {
  it('spells out what "explicitly asked" means, in both languages', () => {
    const policy = toolPolicy({ ...ALL, build_prompt: 'on-request' });
    expect(policy).toContain('build_prompt');
    expect(policy).toContain('give me a prompt');
    // The user writes in German as often as not, and a small model will not
    // generalise from English examples on its own.
    expect(policy).toContain('erstelle mir einen prompt');
  });

  it('says nothing about a tool it cannot use', () => {
    expect(toolPolicy({ ...ALL, prompt_blocks: 'off' })).not.toContain('prompt_blocks');
  });

  it('tells it to answer in words when it has no tools at all', () => {
    const policy = toolPolicy({ build_prompt: 'off', prompt_blocks: 'off', ask_user: 'off' });
    expect(policy).toContain('Answer in words');
  });

  it('distinguishes the levels', () => {
    const asked = toolPolicy({ ...ALL, build_prompt: 'on-request' });
    const freely = toolPolicy({ ...ALL, build_prompt: 'eager' });
    expect(asked).not.toEqual(freely);
    expect(freely).toContain('without waiting to be asked');
  });

  /**
   * Asking has its own scale, shifted towards firing.
   *
   * A question is one tap and improves everything after it; a finished prompt
   * interrupts the conversation it came out of. Treating them as equally
   * expensive is what left the model listing options in prose, which then have
   * to be typed back in by hand.
   */
  it('tells it never to list options in prose, at every level', () => {
    for (const level of ['on-request', 'invited', 'settled', 'ready', 'eager', 'always'] as const) {
      expect(toolPolicy({ ...ALL, ask_user: level })).toContain('in prose');
    }
  });

  /** The top of the scale says plainly that prose is not a way to ask at all. */
  it('tells it a written question does not count, at the enforced level', () => {
    expect(toolPolicy({ ...ALL, ask_user: 'always' })).toContain('cannot be tapped');
  });
});

/**
 * The detector behind the one enforced level.
 *
 * At `always` a match costs a second request to the model, so a false positive
 * costs a wait — and a false negative leaves options in prose that have to be
 * typed back in. Both directions matter, which is why this is tested rather
 * than eyeballed.
 */
describe('spotting a question the model asked in prose', () => {
  it('catches a question followed by a short list', () => {
    expect(
      looksLikeAQuestionWithOptions(
        'What sort of light did you have in mind?\n- Golden hour\n- Overcast\n- Harsh midday',
      ),
    ).toBe(true);
  });

  it('catches a numbered list too', () => {
    expect(
      looksLikeAQuestionWithOptions('Which framing?\n1. Wide\n2. Close\n3) Overhead'),
    ).toBe(true);
  });

  it('catches an inline either/or, in both languages', () => {
    expect(looksLikeAQuestionWithOptions('Portrait or landscape?')).toBe(true);
    expect(looksLikeAQuestionWithOptions('Hochformat oder Querformat?')).toBe(true);
  });

  it('leaves prose that merely contains a question alone', () => {
    expect(
      looksLikeAQuestionWithOptions(
        'That could work. What do you think the picture is actually about?',
      ),
    ).toBe(false);
  });

  /** An explanation in bullets is not an offer of answers. */
  it('leaves a long bulleted explanation alone', () => {
    const text =
      'Why does this matter?\n' +
      Array.from({ length: 7 }, (_, index) => `- point number ${index}`).join('\n');
    expect(looksLikeAQuestionWithOptions(text)).toBe(false);
  });

  it('leaves a paragraph-length bullet alone', () => {
    expect(
      looksLikeAQuestionWithOptions(
        'Which way?\n- ' + 'a very long consideration that runs on and on '.repeat(4),
      ),
    ).toBe(false);
  });

  /** A sentence that happens to contain "or" is not a choice of two. */
  it('does not read a long sentence with "or" as an offer', () => {
    expect(
      looksLikeAQuestionWithOptions(
        'Should it be a photograph or something like it, shot on a long lens in the late ' +
          'afternoon with the sun behind the subject and a lot of haze?',
      ),
    ).toBe(false);
  });

  it('needs a question mark at all', () => {
    expect(looksLikeAQuestionWithOptions('Here are some ideas.\n- One\n- Two')).toBe(false);
  });
});

describe('reading a tool call off the wire', () => {
  it('takes a question with its ready answers', () => {
    const call = parseCall({
      id: 'call_1',
      name: 'ask_user',
      args: JSON.stringify({
        questions: [
          { question: 'Portrait or landscape?', options: ['Portrait', 'Landscape', ''] },
          { question: 'Photograph or illustration?', options: ['Photo', 'Illustration'] },
        ],
        reason: 'They change the composition.',
      }),
    });

    expect(call).toEqual({
      callId: 'call_1',
      tool: 'ask_user',
      questions: [
        // The empty option is dropped: a blank button is not an answer.
        { question: 'Portrait or landscape?', options: ['Portrait', 'Landscape'] },
        { question: 'Photograph or illustration?', options: ['Photo', 'Illustration'] },
      ],
      reason: 'They change the composition.',
    });
  });

  /**
   * The single-question shape, which smaller models produce anyway.
   *
   * They have seen a thousand examples of `{question, options}` and will write
   * it whatever the schema says. Refusing it would mean the tool silently doing
   * nothing on exactly the models this is for.
   */
  it('accepts one question written the old way', () => {
    const call = parseCall({
      id: 'c',
      name: 'ask_user',
      args: JSON.stringify({ question: 'Portrait or landscape?', options: ['Portrait'] }),
    });
    expect(call).toMatchObject({
      tool: 'ask_user',
      questions: [{ question: 'Portrait or landscape?', options: ['Portrait'] }],
    });
  });

  /** A question with no answers is still a question; the box is always there. */
  it('keeps a question that came with no options', () => {
    const call = parseCall({
      id: 'c',
      name: 'ask_user',
      args: JSON.stringify({ questions: [{ question: 'What is it for?' }], reason: '' }),
    });
    expect(call).toMatchObject({
      tool: 'ask_user',
      questions: [{ question: 'What is it for?', options: [] }],
    });
  });

  it('drops a question with nothing in it', () => {
    expect(
      parseCall({ id: 'c', name: 'ask_user', args: JSON.stringify({ questions: [{ question: '  ' }] }) }),
    ).toBeNull();
  });

  it('drops arguments it cannot parse rather than failing the reply', () => {
    expect(parseCall({ id: 'c', name: 'build_prompt', args: '{"prompt": "unterminated' })).toBeNull();
  });

  it('drops a tool it does not have', () => {
    expect(parseCall({ id: 'c', name: 'delete_everything', args: '{}' })).toBeNull();
  });
});

describe('pulling reasoning out of the content stream', () => {
  /** Everything one splitter makes of a sequence of deltas. */
  const run = (deltas: string[], thinking = true) => {
    const splitter = inlineReasoning(thinking);
    const events: ChatStreamEvent[] = [];
    for (const delta of deltas) events.push(...splitter.push(delta));
    events.push(...splitter.end());
    return {
      content: events
        .filter((event) => event.type === 'content')
        .map((event) => (event as { text: string }).text)
        .join(''),
      thinking: events
        .filter((event) => event.type === 'thinking')
        .map((event) => (event as { text: string }).text)
        .join(''),
    };
  };

  it('reads DeepSeek-style tags split across deltas', () => {
    expect(run(['<thi', 'nk>quiet and blue</th', 'ink>A harbour.'])).toEqual({
      thinking: 'quiet and blue',
      content: 'A harbour.',
    });
  });

  /**
   * Gemma 4's template is supposed to keep the thought channel out of the
   * visible output and in llama.cpp routinely does not.
   */
  it("reads Gemma's thought channel, newline and all", () => {
    expect(run(['<|chan', 'nel>thought\nweighing it up<chan', 'nel|>A harbour.'])).toEqual({
      thinking: 'weighing it up',
      content: 'A harbour.',
    });
  });

  /** A block has to be closed by its own family, not by whatever comes first. */
  it('does not close one family with another', () => {
    expect(run(['<|channel>thought\nI could write </think> here<channel|>Done.'])).toEqual({
      thinking: 'I could write </think> here',
      content: 'Done.',
    });
  });

  it('leaves text that only looks like a tag alone', () => {
    expect(run(['Use <thinking> as a word.'])).toEqual({
      thinking: '',
      content: 'Use <thinking> as a word.',
    });
  });

  /** An unclosed block is what a stream cut off mid-thought looks like. */
  it('flushes an unterminated block at the end', () => {
    expect(run(['<think>half a thou'])).toEqual({ thinking: 'half a thou', content: '' });
  });

  it('drops the reasoning entirely when it is switched off', () => {
    expect(run(['<think>never mind</think>The answer.'], false)).toEqual({
      thinking: '',
      content: 'The answer.',
    });
  });

  it('handles two blocks in one reply', () => {
    expect(run(['<think>one</think>Middle.<thought>two</thought>End.'])).toEqual({
      thinking: 'onetwo',
      content: 'Middle.End.',
    });
  });
});


/**
 * What the model is shown of its own past turns.
 *
 * A conversation is replayed on every request, so anything wrong here is wrong
 * for the rest of the conversation rather than for one turn.
 */
describe('replaying the transcript', () => {
  const call: ChatToolCall = {
    callId: 'call_1',
    tool: 'build_prompt',
    prompt: 'a lighthouse at dusk',
    reason: 'The conversation settled on weather.',
  };

  const message = (over: Partial<ChatMessage>): ChatMessage => ({
    id: 'm',
    role: 'user',
    content: '',
    createdAt: 0,
    ...over,
  });

  it('sends a tool call’s arguments and not Latent’s own fields', () => {
    const [, assistant] = toApiMessages(
      [message({ role: 'assistant', content: '', toolCall: call })],
      'instructions',
    );

    const args = JSON.parse(assistant!.tool_calls![0]!.function.arguments) as Record<
      string,
      unknown
    >;
    expect(args).toEqual({
      prompt: 'a lighthouse at dusk',
      reason: 'The conversation settled on weather.',
    });
    // The name and the envelope belong to the call, not to its arguments.
    expect(assistant!.tool_calls![0]!.function.name).toBe('build_prompt');
    expect(assistant!.tool_calls![0]!.id).toBe('call_1');
  });

  it('leaves notes out — they are transcript, not conversation', () => {
    const out = toApiMessages(
      [message({ role: 'note', content: 'Generated again' }), message({ content: 'hello' })],
      'instructions',
    );
    expect(out.map((entry) => entry.role)).toEqual(['system', 'user']);
  });
});

/**
 * The ✦ button, which asks for a prompt without saying anything.
 *
 * Forcing the tool is not enough: with nothing added, the request ends on the
 * assistant's own last message, and a model asked to speak straight after
 * itself repeats what it just said.
 */
describe('asking for a prompt with the button', () => {
  const conversation = (content: string, role: ChatMessage['role'] = 'user'): ChatMessage[] => [
    { id: 'm', role, content, createdAt: 0 },
  ];

  it('adds a turn saying what was asked for', () => {
    const out = withForcedInstruction(
      toApiMessages(conversation('Something calm.', 'assistant'), 'instructions'),
      'build_prompt',
    );

    const last = out[out.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toContain('build_prompt');
  });

  it('folds it into the last turn when that is already the user’s', () => {
    const history = toApiMessages(conversation('A lighthouse.'), 'instructions');
    const out = withForcedInstruction(history, 'build_prompt');

    // Two user turns in a row is what several chat templates refuse.
    expect(out).toHaveLength(history.length);
    expect(out[out.length - 1]!.content).toContain('A lighthouse.');
    expect(out[out.length - 1]!.content).toContain('build_prompt');
  });

  it('keeps a picture attached to that turn', () => {
    const withImage: ChatMessage[] = [
      {
        id: 'm',
        role: 'user',
        content: 'Like this.',
        attachments: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AA' }],
        createdAt: 0,
      },
    ];
    const out = withForcedInstruction(
      toApiMessages(withImage, 'instructions'),
      'build_prompt',
    );

    const parts = out[out.length - 1]!.content as { type: string; text?: string }[];
    expect(parts.some((part) => part.type === 'image_url')).toBe(true);
    expect(parts.filter((part) => part.type === 'text')).toHaveLength(2);
  });
});

/**
 * What the model is asked when it is shown the picture.
 *
 * The threshold is the whole of the perfectionism setting, and it has to reach
 * the model as something followable: a standard in words *and* a number to
 * beat. Either one alone leaves "too far apart" to be decided fresh every time.
 */
describe('checking a picture against its prompt', () => {
  const PROMPT = 'a working harbour at dawn, boats at the quay';

  it('hands over the prompt in full, rather than pointing at it', () => {
    const text = reviewInstruction(PROMPT, 'balanced');
    expect(text).toContain(PROMPT);
    expect(text).toContain('out of 10');
    expect(text).toContain('revise_prompt');
  });

  it('raises the bar as the setting gets pickier', () => {
    const scoreOf = (text: string) => Number(/below (\d+) out of 10/.exec(text)?.[1] ?? 0);

    const wrong = scoreOf(reviewInstruction(PROMPT, 'wrong'));
    const balanced = scoreOf(reviewInstruction(PROMPT, 'balanced'));
    const exacting = scoreOf(reviewInstruction(PROMPT, 'exacting'));

    expect(wrong).toBeLessThan(balanced);
    expect(balanced).toBeLessThan(exacting);
    expect(exacting).toBe(10);
  });

  /**
   * The quiet end is a different instruction, not a lower number.
   *
   * "Look at it and tell me" without "and rewrite it" is a real way to work,
   * and asking for a score of zero would read as an invitation to rewrite
   * everything rather than nothing.
   */
  it('says plainly not to propose anything at the lowest setting', () => {
    const text = reviewInstruction(PROMPT, 'never');
    expect(text).not.toContain('revise_prompt');
    expect(text).toMatch(/Do NOT propose/);
  });
});

/**
 * Where a render sits in what the model is shown.
 *
 * At the point it was made, as a turn of its own — not appended to the end.
 * "The first one was better" only means anything if the two are in the order
 * they happened, and a picture at the end of the request is a picture with no
 * prompt attached to it.
 */
describe('pictures in the replayed conversation', () => {
  const withRender: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'build me a prompt', createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCall: {
        callId: 'call_1',
        tool: 'build_prompt',
        prompt: 'a harbour at dawn',
        reason: 'Calm.',
      },
      createdAt: 2,
    },
    {
      id: 't1',
      role: 'tool',
      content: 'The user accepted the prompt.',
      toolCall: {
        callId: 'call_1',
        tool: 'build_prompt',
        prompt: 'a harbour at dawn',
        reason: 'Calm.',
      },
      generationId: 'gen-1',
      prompt: 'a harbour at dawn',
      createdAt: 3,
    },
    { id: 'u2', role: 'user', content: 'make the sky darker', createdAt: 4 },
  ];

  it('puts the picture in after the message that made it', () => {
    const out = toApiMessages(withRender, 'system', new Map([['t1', 'data:image/png;base64,AAA']]));

    const at = out.findIndex((message) => JSON.stringify(message.content).includes('image_url'));
    expect(at).toBeGreaterThan(0);
    // Straight after the tool response, and before what was said next.
    expect(out[at - 1]?.role).toBe('tool');
    expect(out[at]?.role).toBe('user');
    expect(out[at + 1]?.content).toBe('make the sky darker');

    // With the prompt beside it, so the picture is not a picture of nothing.
    expect(JSON.stringify(out[at]?.content)).toContain('a harbour at dawn');
  });

  it('sends no picture when there is none to send', () => {
    const out = toApiMessages(withRender, 'system');
    expect(JSON.stringify(out)).not.toContain('image_url');
  });

  /**
   * A re-run is Latent's own bookkeeping and never a turn in the conversation
   * — but the picture it produced is a picture, and a model that is never
   * shown it will be asked to change something it does not know exists.
   */
  it('shows what a re-run produced, without inventing a turn for it', () => {
    const messages: ChatMessage[] = [
      ...withRender,
      {
        id: 'n1',
        role: 'note',
        content: 'Generated again',
        generationId: 'gen-2',
        prompt: 'a harbour at dawn, colder',
        createdAt: 5,
      },
    ];

    const out = toApiMessages(messages, 'system', new Map([['n1', 'data:image/png;base64,BBB']]));
    const shown = out.filter((message) => JSON.stringify(message.content).includes('image_url'));
    expect(shown).toHaveLength(1);
    expect(JSON.stringify(shown[0]?.content)).toContain('colder');
    // And the note itself is still not said out loud.
    expect(JSON.stringify(out)).not.toContain('Generated again');
  });
});

describe('how much a prompt spells out', () => {
  /**
   * Instructions, not a word count.
   *
   * "Two sentences" is a rule a model follows by truncating the wrong half.
   * What is being chosen is how much of the scene the prompt settles — a
   * different picture at each end rather than a longer one.
   */
  it('says something different at each end of the scale', () => {
    const sparse = detailPolicy('sparse');
    const elaborate = detailPolicy('elaborate');

    expect(sparse).toContain('short');
    expect(sparse).toContain('Leave everything else open');
    expect(elaborate).toContain('exhaustively');
    expect(elaborate).not.toBe(sparse);
    // And neither of them reintroduces the keyword pile the instructions spend
    // half their length arguing against.
    expect(elaborate).toContain('no keyword piles');
  });

  it('falls back to the middle for a value nobody set', () => {
    expect(detailPolicy(undefined as never)).toBe(detailPolicy('balanced'));
  });
});

describe('asking rather than guessing about a picture', () => {
  const PROMPT = 'a working harbour at dawn';

  it('adds the standard for asking, and asks for one tool at most', () => {
    const text = reviewInstruction(PROMPT, 'balanced', 'unsure');
    expect(text).toContain('ask_user');
    expect(text).toContain('revise_prompt');
    // Two dialogs about one picture is two decisions where one was asked for.
    expect(text).toContain('at most one tool');
  });

  it('says nothing about asking when it is switched off', () => {
    const text = reviewInstruction(PROMPT, 'balanced', 'never');
    expect(text).not.toContain('ask_user');
    expect(text).toContain('revise_prompt');
  });

  it('gets more insistent as the setting rises', () => {
    expect(reviewInstruction(PROMPT, 'balanced', 'unclear')).toContain('cannot tell');
    expect(reviewInstruction(PROMPT, 'balanced', 'always')).toContain('Always call');
  });

  /**
   * A run nobody is watching cannot be asked anything.
   *
   * The tool is withheld from the request as well, but a model told it may ask
   * writes the question into its answer instead — and an unattended loop then
   * stops on a question nobody reads for an hour.
   */
  it('tells an autonomous run to decide for itself, whatever the ask setting says', () => {
    const text = reviewInstruction(PROMPT, 'balanced', 'always', true);

    expect(text).toContain('not answering questions');
    expect(text).toContain('Do not ask which way to go');
    expect(text).not.toContain('Always call');
    // The judgement itself is unchanged: same threshold, same rewrite tool.
    expect(text).toContain('revise_prompt');
    expect(text).toContain('below 7 out of 10');
  });

  /** And it is told what ending the loop looks like. */
  it('says what clearing the mark means, so a run can end', () => {
    expect(reviewInstruction(PROMPT, 'exacting', 'never', true)).toContain(
      'Once it clears 10 out of 10, say so and call nothing.',
    );
  });
});

/* ------------------------------------------------------------------ */
/* What the user likes                                                 */
/* ------------------------------------------------------------------ */

/** One note, with the parts a test does not care about filled in. */
function note(fields: Partial<TasteEntry> & { text: string }): TasteEntry {
  return {
    id: fields.text,
    categoryId: null,
    active: true,
    always: false,
    position: 0,
    createdAt: 1,
    ...fields,
  };
}

function profile(): TasteProfile {
  return {
    categories: [
      { id: 'colour', name: 'Colour', active: true, position: 0, createdAt: 1 },
      { id: 'places', name: 'Places', active: false, position: 1, createdAt: 2 },
    ],
    entries: [
      note({ id: 'a', categoryId: 'colour', text: 'washed-out teal' }),
      note({ id: 'b', categoryId: 'colour', text: 'neon', active: false }),
      note({ id: 'c', categoryId: 'places', text: 'harbours' }),
      note({ id: 'd', categoryId: null, text: 'rain at night' }),
      note({ id: 'e', categoryId: 'gone', text: 'orphaned' }),
    ],
  };
}

describe('which notes are feeding in', () => {
  it('keeps the switched-on ones and groups them under their heading', () => {
    expect(activeTaste(profile())).toEqual({
      groups: [
        { heading: 'Colour', notes: ['washed-out teal'] },
        { heading: null, notes: ['rain at night'] },
      ],
      standing: [],
    });
  });

  /**
   * The category switch is the coarse control.
   *
   * Having to also switch off six notes to silence a heading would make it
   * useless, so a note under a switched-off category is off whatever it says.
   */
  it('silences a whole category from its own switch', () => {
    const { groups } = activeTaste(profile());
    expect(groups.some((group) => group.notes.includes('harbours'))).toBe(false);
  });

  it('drops a note filed under a category that no longer exists', () => {
    const { groups } = activeTaste(profile());
    expect(groups.some((group) => group.notes.includes('orphaned'))).toBe(false);
  });

  /**
   * A standing note is listed once, apart from the rest.
   *
   * Saying it twice in one prompt — under its heading and again as a rule — is
   * how a model decides it is the most important thing in the list.
   */
  it('lists a standing note on its own, not under its heading as well', () => {
    const base = profile();
    base.entries.push(note({ id: 'f', categoryId: 'colour', text: 'never any text', always: true }));

    const { groups, standing } = activeTaste(base);
    expect(standing).toEqual(['never any text']);
    expect(groups.some((group) => group.notes.includes('never any text'))).toBe(false);
  });

  /**
   * `always` decides how far a note reaches, not whether it is in play.
   *
   * Switching one off, or switching off the heading over it, is still the way
   * to silence it — otherwise a note marked "always" could never be put away.
   */
  it('still obeys the switches', () => {
    const base = profile();
    base.entries.push(
      note({ id: 'f', text: 'switched off', always: true, active: false }),
      note({ id: 'g', categoryId: 'places', text: 'under a silent heading', always: true }),
    );
    expect(activeTaste(base).standing).toEqual([]);
  });
});

describe('how far the notes reach', () => {
  it('says nothing at all when it is off', () => {
    expect(tastePolicy(profile(), 'off')).toBe('');
  });

  /**
   * A heading with nothing under it invites a small model to invent the
   * contents, so an empty profile produces no section rather than an empty one.
   */
  it('says nothing when there is nothing switched on, or nothing to read', () => {
    expect(tastePolicy({ categories: [], entries: [] }, 'strong')).toBe('');
    expect(tastePolicy(null, 'strong')).toBe('');
  });

  it('puts the active notes in, under their headings', () => {
    const text = tastePolicy(profile(), 'hints');
    expect(text).toContain('washed-out teal');
    expect(text).toContain('**Colour**');
    expect(text).toContain('rain at night');
    // Switched off, and under a switched-off heading: neither reaches the model.
    expect(text).not.toContain('neon');
    expect(text).not.toContain('harbours');
  });

  /** The rule the user asked for, at every level: what they asked for wins. */
  it('leaves what was actually asked for alone at every step', () => {
    for (const level of ['sparingly', 'hints', 'guiding', 'strong'] as const) {
      expect(tastePolicy(profile(), level)).toContain(
        'Whatever they have actually asked for is what they get',
      );
    }
  });

  it('reaches further as the setting rises', () => {
    expect(tastePolicy(profile(), 'sparingly')).toContain('nothing to go on');
    expect(tastePolicy(profile(), 'hints')).toContain('vague idea');
    expect(tastePolicy(profile(), 'guiding')).toContain('wherever it does not contradict');
    expect(tastePolicy(profile(), 'strong')).toContain('house style');
  });

  /**
   * The point of the override: a settled preference is not a starting point.
   *
   * The rest of the notes step aside the moment a picture is named, which is
   * exactly when "always 21:9" or "never any text in the picture" matters most.
   */
  it('tells it that a standing note holds even against a concrete request', () => {
    const base = profile();
    base.entries.push(note({ id: 'f', text: 'never any text in the picture', always: true }));

    const text = tastePolicy(base, 'sparingly');
    expect(text).toContain('Things that always hold');
    expect(text).toContain('never any text in the picture');
    expect(text).toContain('even when they have told you exactly what they want');
  });

  /**
   * And the limit that makes the override usable.
   *
   * Without it, "this always applies" reads as "put this in every prompt", and
   * a note about colour turns up in a request for a line drawing.
   */
  it('bounds a standing note by whether it is relevant at all', () => {
    const base = profile();
    base.entries.push(note({ id: 'f', text: 'shot on 35mm', always: true }));

    const text = tastePolicy(base, 'hints');
    expect(text).toContain('only where it actually bears on the picture');
    expect(text).toContain('leave it out entirely');
    expect(text).toContain('Do not bend the picture');
  });

  /** Off is the master switch, or it is not a switch. */
  it('sends nothing at all when the whole thing is off, standing notes included', () => {
    const base = profile();
    base.entries.push(note({ id: 'f', text: 'always widescreen', always: true }));
    expect(tastePolicy(base, 'off')).toBe('');
  });

  /** A profile that is nothing but standing notes still has a section. */
  it('writes the section for standing notes alone', () => {
    const text = tastePolicy(
      { categories: [], entries: [note({ id: 'f', text: 'always widescreen', always: true })] },
      'hints',
    );
    expect(text).toContain('always widescreen');
    expect(text).toContain('Things that always hold');
    // No empty lead-in for the ordinary notes, which there are none of.
    expect(text).not.toContain('things they keep coming back to');
  });

  /** Never shown in the chat, so reciting it back would be a small leak. */
  it('tells it not to read the list back', () => {
    expect(tastePolicy(profile(), 'guiding')).toContain('Never read the list back');
  });
});

/* ------------------------------------------------------------------ */
/* Wandering                                                           */
/* ------------------------------------------------------------------ */

describe('drawing a few notes for a wandering round', () => {
  /*
   * The flat shuffle the mode started as: everything eligible, nothing capped.
   *
   * Written out rather than taken from the defaults, which it used to be. The
   * default is one from each heading now, and a fixture that quietly followed
   * that would stop testing what these cases are about — the *count* limit,
   * which only means anything when the caps are not the thing doing the
   * limiting.
   */
  const flat = { rules: { ...DEFAULT_WANDER_DRAW, perCategory: 0 }, random: () => 0 };
  const texts = (drawn: { text: string }[]) => drawn.map((note) => note.text);

  /**
   * At most as many as were asked for — pinned ones included in the count.
   *
   * Pinning has three readings here and this is the default one: a pin says
   * "this holds even when they have asked for something specific", and in a
   * wandering round nobody has asked for anything. Letting every pinned note in
   * *on top of* the draw is how a long list turns every round into the same
   * crowded picture — which is now the `always` setting, for people who want
   * exactly that.
   */
  it('draws the number asked for and no more, pins included', () => {
    const base = profile();
    base.entries.push(
      note({ id: 'p', text: 'always 21:9', always: true }),
      note({ id: 'q', text: 'never any text', always: true }),
    );

    expect(drawTaste(base, 1, flat)).toHaveLength(1);
    expect(drawTaste(base, 3, flat)).toHaveLength(3);
  });

  it('never draws more than there are', () => {
    expect(drawTaste(profile(), 99, flat)).toHaveLength(2);
    expect(drawTaste(profile(), 1, flat)).toHaveLength(1);
    expect(drawTaste(profile(), 0, flat)).toEqual([]);
    expect(drawTaste({ categories: [], entries: [] }, 3, flat)).toEqual([]);
  });

  /** Only what is switched on, exactly as everywhere else the notes are read. */
  it('obeys the switches', () => {
    const drawn = texts(drawTaste(profile(), 99, flat));
    expect(drawn).not.toContain('neon');
    expect(drawn).not.toContain('harbours');
  });

  /** The id comes back too, because that is what a round records. */
  it('says which notes they were, not only what they said', () => {
    expect(drawTaste(profile(), 99, flat).map((drawn) => drawn.id).sort()).toEqual(['a', 'd']);
  });

  /**
   * Two rounds are two pictures.
   *
   * The whole mode rests on this: the same three notes every round would be
   * one picture rendered endlessly with a different seed.
   */
  it('draws differently as the random does', () => {
    const many: TasteProfile = {
      categories: [],
      entries: ['a', 'b', 'c', 'd', 'e', 'f'].map((text) => note({ id: text, text })),
    };
    const first = drawTaste(many, 2, { rules: DEFAULT_WANDER_DRAW, random: () => 0 });
    const last = drawTaste(many, 2, { rules: DEFAULT_WANDER_DRAW, random: () => 0.999 });
    expect(texts(first)).not.toEqual(texts(last));
  });

  /* ---------------------------------------------------------------- */
  /* The rules                                                         */
  /* ---------------------------------------------------------------- */

  /** Two headings of near-synonyms, which is the case the caps exist for. */
  const filed = (): TasteProfile => ({
    categories: [
      { id: 'colour', name: 'Colour', active: true, position: 0, createdAt: 1 },
      { id: 'places', name: 'Places', active: true, position: 1, createdAt: 2 },
      { id: 'later', name: 'Ideas for later', active: true, position: 2, createdAt: 3 },
    ],
    entries: [
      note({ id: 'c1', categoryId: 'colour', text: 'teal' }),
      note({ id: 'c2', categoryId: 'colour', text: 'amber' }),
      note({ id: 'c3', categoryId: 'colour', text: 'sodium' }),
      note({ id: 'p1', categoryId: 'places', text: 'harbours' }),
      note({ id: 'p2', categoryId: 'places', text: 'stairwells' }),
      note({ id: 'l1', categoryId: 'later', text: 'a lighthouse someday' }),
      note({ id: 'x1', categoryId: null, text: 'loose thought' }),
    ],
  });

  const rules = (patch: Partial<typeof DEFAULT_WANDER_DRAW>) => ({
    rules: { ...DEFAULT_WANDER_DRAW, ...patch },
    random: () => 0.5,
  });

  /** The single most useful rule: one thing from each heading, not four. */
  it('takes at most one from a heading when capped at one', () => {
    const drawn = drawTaste(filed(), 4, rules({ perCategory: 1 }));
    const headings = drawn.map((entry) => entry.categoryId);
    expect(new Set(headings).size).toBe(headings.length);
  });

  /**
   * And it comes up short rather than breaking the rule.
   *
   * Four wanted, four headings' worth of room — but two of them switched out —
   * means two notes, not two notes plus a second from somewhere to make up the
   * number. Quietly doubling up is exactly the fault this rule was asked for.
   */
  it('would rather draw fewer than break a cap', () => {
    const drawn = drawTaste(
      filed(),
      4,
      rules({
        perCategory: 1,
        loose: 'off',
        categories: { later: { role: 'off', max: 0 }, places: { role: 'off', max: 0 } },
      }),
    );
    expect(texts(drawn)).toHaveLength(1);
    expect(drawn[0]?.categoryId).toBe('colour');
  });

  /** A heading's own cap beats the general one, in both directions. */
  it('lets a heading set its own cap', () => {
    const drawn = drawTaste(
      filed(),
      6,
      rules({ perCategory: 1, categories: { colour: { role: 'draw', max: 2 } } }),
    );
    expect(drawn.filter((entry) => entry.categoryId === 'colour')).toHaveLength(2);
    expect(drawn.filter((entry) => entry.categoryId === 'places')).toHaveLength(1);
  });

  /** "Never draw from this one" — without switching it off for the chat. */
  it('leaves a heading out entirely when it is switched off for wandering', () => {
    const drawn = drawTaste(filed(), 99, rules({ categories: { later: { role: 'off', max: 0 } } }));
    expect(texts(drawn)).not.toContain('a lighthouse someday');
    expect(texts(drawn)).toContain('loose thought');
  });

  /**
   * The one the mode needs most: a heading that decides what kind of picture
   * this is at all, guaranteed a place in every round however small.
   */
  it('always takes one from a heading marked always', () => {
    for (const seed of [0, 0.3, 0.9]) {
      const drawn = drawTaste(filed(), 1, {
        rules: { ...DEFAULT_WANDER_DRAW, categories: { places: { role: 'always', max: 0 } } },
        random: () => seed,
      });
      expect(drawn.map((entry) => entry.categoryId)).toEqual(['places']);
    }
  });

  /** Several of them, each guaranteed, and the rest of the round filled after. */
  it('gives every insisting heading a place before filling the rest', () => {
    const drawn = drawTaste(filed(), 3, {
      rules: {
        ...DEFAULT_WANDER_DRAW,
        categories: {
          places: { role: 'always', max: 0 },
          colour: { role: 'always', max: 0 },
        },
      },
      random: () => 0.5,
    });
    const headings = drawn.map((entry) => entry.categoryId);
    expect(headings).toContain('places');
    expect(headings).toContain('colour');
    expect(drawn).toHaveLength(3);
  });

  it('can leave the notes filed under no heading out', () => {
    const drawn = drawTaste(filed(), 99, rules({ loose: 'off' }));
    expect(texts(drawn)).not.toContain('loose thought');
  });

  /** The other reading of a pin: part of everything, every round. */
  it('puts every pinned note in when pinning is set to always', () => {
    const base = filed();
    base.entries.push(note({ id: 'pin', categoryId: 'colour', text: '21:9', always: true }));

    const drawn = drawTaste(base, 3, rules({ pinned: 'always' }));
    expect(texts(drawn)).toContain('21:9');
    expect(drawn).toHaveLength(3);
  });

  it('keeps pinned notes out altogether when told to', () => {
    const base = filed();
    base.entries.push(note({ id: 'pin', categoryId: 'colour', text: '21:9', always: true }));

    expect(texts(drawTaste(base, 99, rules({ pinned: 'off' })))).not.toContain('21:9');
  });

  /**
   * The failure of an endless run is a note coming round again two pictures
   * later, which reads as the model being stuck.
   */
  it('holds back the notes the last rounds used', () => {
    const stale = ['c1', 'c2', 'c3', 'p1'];
    const drawn = drawTaste(filed(), 2, {
      rules: DEFAULT_WANDER_DRAW,
      exclude: stale,
      random: () => 0.5,
    });

    // Which two of the three fresh ones is the shuffle's business; that neither
    // is one of the four just used is this rule's.
    expect(drawn).toHaveLength(2);
    for (const entry of drawn) expect(stale).not.toContain(entry.id);
  });

  /**
   * But not to the point of stopping.
   *
   * "Do not repeat yourself" cannot mean "draw nothing" — a profile with three
   * notes and three drawn a round would go silent after the first picture.
   */
  it('takes a repeat rather than come back empty', () => {
    const small: TasteProfile = {
      categories: [],
      entries: [note({ id: 'only', text: 'the one note' })],
    };
    const drawn = drawTaste(small, 1, {
      rules: DEFAULT_WANDER_DRAW,
      exclude: ['only'],
      random: () => 0,
    });
    expect(texts(drawn)).toEqual(['the one note']);
  });
});

describe('what a wandering round is told', () => {
  it('hands over the drawn notes and asks for one call', () => {
    const text = wanderInstruction(['low fog over water', 'brutalist stairwells']);
    expect(text).toContain('low fog over water');
    expect(text).toContain('brutalist stairwells');
    expect(text).toContain('build_prompt');
    // Only these: a round that adds the whole profile back in is the same
    // picture every time.
    expect(text).toContain('only these');
  });

  /*
   * The round goes out with no transcript, so there is nothing to tell it to
   * ignore — and a line asking a model to overlook what it can see was never
   * the mechanism anyway. What keeps two rounds apart is the draw.
   */
  it('does not argue with a conversation it cannot see', () => {
    const text = wanderInstruction(['low fog over water']);
    expect(text).not.toContain('conversation');
    expect(text).not.toContain('Repeating yourself');
  });

  /** An empty profile is a licence, not an error. */
  it('still asks for a picture when there is nothing written down', () => {
    const text = wanderInstruction([]);
    expect(text).toContain('build_prompt');
    expect(text).toContain('entirely');
  });
});
