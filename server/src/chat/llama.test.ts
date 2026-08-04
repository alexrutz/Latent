import { describe, expect, it } from 'vitest';

import type { ChatToolSettings } from '@latent/shared';

import { enabledTools, parseCall, toolPolicy } from './llama.js';

/**
 * The parts of the chat client that are decisions rather than plumbing.
 *
 * The streaming and the tag-straddling are covered end to end against the mock
 * server, where they can actually go wrong. What is worth testing here is what
 * the settings *mean*: which tools the model is handed, what it is told about
 * when to use them, and what happens to a call that arrives malformed.
 */

const ALL: ChatToolSettings = {
  build_prompt: 'considered',
  prompt_blocks: 'considered',
  ask_user: 'considered',
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
