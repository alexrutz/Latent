import { describe, expect, it } from 'vitest';

import type { ChatStreamEvent, ChatToolSettings } from '@latent/shared';

import { enabledTools, inlineReasoning, parseCall, toolPolicy } from './llama.js';

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
    const asked = toolPolicy({ ...ALL, ask_user: 'on-request' });
    const freely = toolPolicy({ ...ALL, ask_user: 'eager' });
    expect(asked).not.toEqual(freely);
    expect(freely).toContain('without waiting to be asked');
  });
});

describe('reading a tool call off the wire', () => {
  it('takes a question with its ready answers', () => {
    const call = parseCall({
      id: 'call_1',
      name: 'ask_user',
      args: JSON.stringify({
        question: 'Portrait or landscape?',
        options: ['Portrait', 'Landscape', ''],
        reason: 'It changes the composition.',
      }),
    });

    expect(call).toEqual({
      callId: 'call_1',
      tool: 'ask_user',
      question: 'Portrait or landscape?',
      // The empty one is dropped: a blank button is not an answer.
      options: ['Portrait', 'Landscape'],
      reason: 'It changes the composition.',
    });
  });

  /** A question with no answers is still a question; the box is always there. */
  it('keeps a question that came with no options', () => {
    const call = parseCall({
      id: 'c',
      name: 'ask_user',
      args: JSON.stringify({ question: 'What is it for?', reason: '' }),
    });
    expect(call).toMatchObject({ tool: 'ask_user', options: [] });
  });

  it('drops a question with nothing in it', () => {
    expect(
      parseCall({ id: 'c', name: 'ask_user', args: JSON.stringify({ question: '  ' }) }),
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
