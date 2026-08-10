import { describe, expect, it } from 'vitest';

import type { ApiWorkflow } from './comfyTypes.js';
import { applyModelServer, isLlamaServerField, type ModelServerTarget } from './modelServer.js';
import type { ParamField } from './paramTypes.js';

const graph = (): ApiWorkflow => ({
  '1': {
    class_type: 'LlamaServerConnect',
    inputs: {
      base_url: 'http://192.168.1.9:8080',
      timeout: 300,
      check_connection: true,
      model: 'auto',
      auth: 'auto',
      api_key: '',
      username: '',
      password: '',
    },
  },
  '2': {
    class_type: 'LlamaServerChat',
    inputs: { server: ['1', 0], system: 'Be brief.', prompt: 'a lighthouse' },
  },
});

const target = (over: Partial<ModelServerTarget> = {}): ModelServerTarget => ({
  url: 'https://12.34.56.78:8080',
  authMode: 'bearer',
  username: null,
  secret: 'sk-rented',
  ...over,
});

describe('applyModelServer', () => {
  it('puts the address and a bearer token into the connect node', () => {
    const next = applyModelServer(graph(), target());

    expect(next['1']?.inputs.base_url).toBe('https://12.34.56.78:8080');
    expect(next['1']?.inputs.auth).toBe('bearer');
    expect(next['1']?.inputs.api_key).toBe('sk-rented');
    expect(next['1']?.inputs.username).toBe('');
    // Everything else on the node is left exactly as it was.
    expect(next['1']?.inputs.timeout).toBe(300);
    expect(next['1']?.inputs.model).toBe('auto');
    expect(next['2']?.inputs.prompt).toBe('a lighthouse');
  });

  it('sends basic auth as user and password', () => {
    const next = applyModelServer(graph(), target({ authMode: 'basic', username: 'vastai' }));

    expect(next['1']?.inputs.auth).toBe('basic');
    expect(next['1']?.inputs.username).toBe('vastai');
    expect(next['1']?.inputs.password).toBe('sk-rented');
    expect(next['1']?.inputs.api_key).toBe('');
  });

  /** vast.ai's proxy wants that name, and a connection that omits it means it. */
  it('falls back to vastai when basic auth has no username', () => {
    const next = applyModelServer(graph(), target({ authMode: 'basic', username: '  ' }));
    expect(next['1']?.inputs.username).toBe('vastai');
  });

  /**
   * `none` is stated rather than left at the node's `auto`, which guesses from
   * whether the other fields are filled.
   */
  it('says none rather than leaving the node to guess', () => {
    const next = applyModelServer(graph(), target({ authMode: 'none', secret: null }));
    expect(next['1']?.inputs.auth).toBe('none');
    expect(next['1']?.inputs.api_key).toBe('');
    expect(next['1']?.inputs.password).toBe('');
  });

  it('leaves an address computed by another node alone', () => {
    const wired = graph();
    wired['1']!.inputs.base_url = ['9', 0];

    const next = applyModelServer(wired, target());
    expect(next['1']?.inputs.base_url).toEqual(['9', 0]);
    // The rest of the node is still filled in.
    expect(next['1']?.inputs.api_key).toBe('sk-rented');
  });

  it('returns the graph untouched when there is no model server, or nothing to change', () => {
    const original = graph();
    expect(applyModelServer(original, null)).toBe(original);
    expect(applyModelServer(original, target({ url: '   ' }))).toBe(original);

    // A graph with no llama-server node in it is not copied either.
    const plain: ApiWorkflow = { '3': { class_type: 'KSampler', inputs: { steps: 20 } } };
    expect(applyModelServer(plain, target())).toBe(plain);
  });

  it('does not touch the graph it was given', () => {
    const original = graph();
    applyModelServer(original, target());
    expect(original['1']?.inputs.base_url).toBe('http://192.168.1.9:8080');
  });
});

describe('isLlamaServerField', () => {
  const field = (over: Partial<ParamField>): ParamField => ({
    id: '1.base_url',
    nodeId: '1',
    inputName: 'base_url',
    classType: 'LlamaServerConnect',
    nodeTitle: 'Connect to llama-server',
    label: 'Base url',
    role: 'other',
    control: 'text',
    defaultValue: '',
    group: 'advanced',
    hidden: false,
    order: 0,
    unknownNodeType: false,
    ...over,
  });

  it('recognises the widgets that describe how to reach the server', () => {
    expect(isLlamaServerField(field({}))).toBe(true);
    expect(isLlamaServerField(field({ inputName: 'api_key' }))).toBe(true);
    // Not everything on the node: the timeout is the workflow's own business.
    expect(isLlamaServerField(field({ inputName: 'timeout' }))).toBe(false);
    expect(isLlamaServerField(field({ classType: 'CLIPTextEncode' }))).toBe(false);
  });
});
