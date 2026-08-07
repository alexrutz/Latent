import { describe, expect, it } from 'vitest';

import type { ChatStreamEvent, ChatToolSettings } from '@latent/shared';

import {
  authHeader,
  enabledTools,
  inlineReasoning,
  looksLikeAQuestionWithOptions,
  parseCall,
  toolPolicy,
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

describe('authenticating against the model server', () => {
  /**
   * The local case, which is most of them: nothing is sent, because
   * `llama-server` on your own machine has nothing to check it against.
   */
  it('sends nothing when there is no token', () => {
    expect(authHeader({ authMode: 'none', username: '', apiKey: '' })).toEqual({});
    expect(authHeader({ authMode: 'bearer', username: '', apiKey: '   ' })).toEqual({});
  });

  it('sends a bearer token', () => {
    expect(authHeader({ authMode: 'bearer', username: '', apiKey: 'sk-abc' })).toEqual({
      authorization: 'Bearer sk-abc',
    });
  });

  /** vast.ai's proxy takes `vastai:<token>`, which is what basic auth is for. */
  it('sends basic auth as user:token', () => {
    const header = authHeader({ authMode: 'basic', username: 'vastai', apiKey: 'hunter2' });
    const encoded = header.authorization?.replace('Basic ', '') ?? '';
    expect(Buffer.from(encoded, 'base64').toString()).toBe('vastai:hunter2');
  });

  /**
   * A blank username is a real arrangement, not a mistake — some proxies want
   * `:token` — so it has to encode rather than fall back to bearer.
   */
  it('encodes basic auth with an empty username', () => {
    const header = authHeader({ authMode: 'basic', username: '', apiKey: 'tok' });
    expect(Buffer.from(header.authorization?.slice(6) ?? '', 'base64').toString()).toBe(':tok');
  });

  /**
   * Settings written before there were modes carry a token and no mode, and
   * that has always meant bearer. Reading one must not silently stop
   * authenticating.
   */
  it('treats a token with no mode as bearer, the way it used to be', () => {
    expect(authHeader({ username: '', apiKey: 'legacy' })).toEqual({
      authorization: 'Bearer legacy',
    });
  });

  /** Switching the mode to none is how you turn it off without losing the token. */
  it('sends nothing when the mode is none, even with a token saved', () => {
    expect(authHeader({ authMode: 'none', username: 'vastai', apiKey: 'still here' })).toEqual({});
  });
});
