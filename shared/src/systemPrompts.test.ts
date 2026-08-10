import { describe, expect, it } from 'vitest';

import type { SystemPrompt } from './apiTypes.js';
import type { ParamField, ParamSchema } from './paramTypes.js';
import { applySystemPrompts, matchSystemPrompt, systemPromptFields } from './systemPrompts.js';

const prompt = (name: string, text: string): SystemPrompt => ({
  id: `p-${name}`,
  name,
  text,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
});

const field = (overrides: Partial<ParamField>): ParamField => ({
  id: '5.text',
  nodeId: '5',
  inputName: 'text',
  classType: 'CLIPTextEncode',
  nodeTitle: 'Positive',
  label: 'Prompt',
  role: 'other',
  control: 'textarea',
  defaultValue: '',
  group: 'main',
  hidden: false,
  order: 0,
  unknownNodeType: false,
  ...overrides,
});

const schemaOf = (fields: ParamField[]): ParamSchema => ({
  version: 1,
  fields,
  outputNodeIds: [],
  capabilities: { img2img: false, seeded: false },
  missingNodeTypes: [],
});

describe('matchSystemPrompt', () => {
  it('matches a field by its label, ignoring case and space', () => {
    const found = matchSystemPrompt(field({ label: 'Caption rules' }), [
      prompt('  caption RULES ', 'Describe what is in the picture.'),
    ]);
    expect(found?.text).toBe('Describe what is in the picture.');
  });

  it('falls back to the node title, then to the raw input name', () => {
    const byTitle = matchSystemPrompt(
      field({ label: 'text', nodeTitle: 'Style guide' }),
      [prompt('Style guide', 'House style.')],
    );
    expect(byTitle?.name).toBe('Style guide');

    const byInput = matchSystemPrompt(
      field({ label: 'Instructions', nodeTitle: 'Ollama', inputName: 'system' }),
      [prompt('system', 'Be brief.')],
    );
    expect(byInput?.name).toBe('system');
  });

  it('prefers the label when several names would match', () => {
    const found = matchSystemPrompt(
      field({ label: 'Caption', nodeTitle: 'System' }),
      [prompt('System', 'from the title'), prompt('Caption', 'from the label')],
    );
    expect(found?.text).toBe('from the label');
  });

  it('leaves anything that is not a text input alone', () => {
    const numeric = matchSystemPrompt(
      field({ label: 'Steps', control: 'int', defaultValue: 20 }),
      [prompt('Steps', 'not a place for prose')],
    );
    expect(numeric).toBeNull();
  });
});

describe('applySystemPrompts', () => {
  it('puts the prompt into every field named after it', () => {
    const schema = schemaOf([
      field({ id: '5.text', label: 'Caption' }),
      field({ id: '9.text', nodeId: '9', label: 'Caption' }),
      field({ id: '7.text', nodeId: '7', label: 'Prompt' }),
    ]);

    const values = applySystemPrompts(schema, { '7.text': 'a lighthouse' }, [
      prompt('Caption', 'Describe it plainly.'),
    ]);

    expect(values['5.text']).toBe('Describe it plainly.');
    expect(values['9.text']).toBe('Describe it plainly.');
    // Nothing else is touched.
    expect(values['7.text']).toBe('a lighthouse');
  });

  it('leaves the workflow’s own text alone when the prompt is empty', () => {
    const schema = schemaOf([field({ label: 'Caption' })]);
    const values = applySystemPrompts(schema, { '5.text': 'whatever was exported' }, [
      prompt('Caption', '   '),
    ]);
    expect(values['5.text']).toBe('whatever was exported');
  });

  it('returns the values untouched when nothing matches', () => {
    const schema = schemaOf([field({ label: 'Prompt' })]);
    const values = { '5.text': 'a lighthouse' };
    expect(applySystemPrompts(schema, values, [prompt('Caption', 'x')])).toBe(values);
    expect(applySystemPrompts(schema, values, [])).toBe(values);
  });
});

describe('systemPromptFields', () => {
  it('reports which fields the form should show as filled from the library', () => {
    const schema = schemaOf([
      field({ id: '5.text', label: 'Caption' }),
      field({ id: '7.text', nodeId: '7', label: 'Prompt' }),
    ]);

    const map = systemPromptFields(schema, [prompt('Caption', 'Describe it plainly.')]);
    expect(Object.keys(map)).toEqual(['5.text']);
    expect(map['5.text']?.name).toBe('Caption');
  });
});
