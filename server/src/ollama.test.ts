import { describe, expect, it } from 'vitest';

import { ollamaUrlFor, resolveOllamaUrl } from './ollama.js';

describe('finding the Ollama a workflow talks to', () => {
  it('reads the address off the node itself', () => {
    const graph = {
      '7': {
        class_type: 'OllamaGenerate',
        inputs: { url: 'http://10.0.0.5:11434', model: 'llama3', prompt: 'describe this' },
      },
    };
    expect(ollamaUrlFor(graph, '7')).toBe('http://10.0.0.5:11434');
  });

  it('falls back to the usual address when the node names none', () => {
    expect(ollamaUrlFor({ '7': { class_type: 'OllamaGenerate', inputs: {} } }, '7')).toBe(
      'http://127.0.0.1:11434',
    );
    // A value that is not an address at all is not one.
    expect(
      ollamaUrlFor({ '7': { class_type: 'OllamaGenerate', inputs: { url: 'not a url' } } }, '7'),
    ).toBe('http://127.0.0.1:11434');
  });

  /**
   * The case that makes this worth having: ComfyUI on a rented box, Latent at
   * home. A workflow saying `127.0.0.1` means "next to ComfyUI", and taking it
   * literally asks Latent's own machine and gets a confident empty answer.
   */
  it('points a loopback address at the machine ComfyUI runs on', () => {
    expect(resolveOllamaUrl('http://127.0.0.1:11434', 'http://192.168.1.40:8188')).toBe(
      'http://192.168.1.40:11434/',
    );
    expect(resolveOllamaUrl('http://localhost:11434', 'https://box.vast.ai:8188')).toBe(
      'https://box.vast.ai:11434/',
    );
  });

  it('leaves an address that already names a host alone', () => {
    expect(resolveOllamaUrl('http://10.0.0.5:11434', 'http://192.168.1.40:8188')).toBe(
      'http://10.0.0.5:11434/',
    );
  });

  it('leaves loopback alone when ComfyUI is local too', () => {
    // Both on this machine: 127.0.0.1 is already the right answer.
    expect(resolveOllamaUrl('http://127.0.0.1:11434', 'http://127.0.0.1:8188')).toBe(
      'http://127.0.0.1:11434/',
    );
  });
});
