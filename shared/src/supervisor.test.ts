import { describe, expect, it } from 'vitest';

import {
  argumentsOf,
  blankConfig,
  buildCommand,
  commandLine,
  definitionFor,
  portOf,
  SERVICE_DEFINITIONS,
  splitArgs,
  type ServiceConfig,
} from './supervisor.js';

const comfy = definitionFor('comfyui')!;
const llama = definitionFor('llama-server')!;

const config = (over: Partial<ServiceConfig> = {}): ServiceConfig => ({
  ...blankConfig(comfy, 'id', 0),
  root: '/opt/ComfyUI_windows_portable',
  ...over,
});

describe('the catalogue', () => {
  it('describes both services, each with a launcher and some arguments', () => {
    expect(SERVICE_DEFINITIONS.map((entry) => entry.kind)).toContain('comfyui');
    expect(SERVICE_DEFINITIONS.map((entry) => entry.kind)).toContain('llama-server');
    for (const definition of SERVICE_DEFINITIONS) {
      expect(definition.launchers.length).toBeGreaterThan(0);
      expect(definition.args.length).toBeGreaterThan(0);
    }
  });

  it('names every flag once per service', () => {
    for (const definition of SERVICE_DEFINITIONS) {
      const flags = definition.args.map((arg) => arg.flag);
      expect(new Set(flags).size).toBe(flags.length);
    }
  });

  it('gives every choice argument something to choose from', () => {
    for (const definition of SERVICE_DEFINITIONS) {
      for (const arg of definition.args) {
        if (arg.type === 'choice') expect(arg.choices?.length ?? 0).toBeGreaterThan(1);
      }
    }
  });

  it('has something worth showing first in each service', () => {
    for (const definition of SERVICE_DEFINITIONS) {
      expect(definition.args.some((arg) => arg.common)).toBe(true);
    }
  });
});

describe('splitArgs', () => {
  it('splits on whitespace', () => {
    expect(splitArgs('--fast --lowvram')).toEqual(['--fast', '--lowvram']);
  });

  it('keeps a quoted path with a space in it whole', () => {
    expect(splitArgs('--output-directory "D:/My Pictures/out"')).toEqual([
      '--output-directory',
      'D:/My Pictures/out',
    ]);
  });

  it('honours a backslash escape outside single quotes', () => {
    expect(splitArgs('a\\ b c')).toEqual(['a b', 'c']);
    expect(splitArgs("'a\\ b'")).toEqual(['a\\ b']);
  });

  it('is nothing for nothing', () => {
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('   ')).toEqual([]);
  });

  it('keeps an empty quoted argument, which is not the same as no argument', () => {
    expect(splitArgs('--api-key ""')).toEqual(['--api-key', '']);
  });

  it('does not treat a shell metacharacter as one', () => {
    // It is handed to spawn as an argument list, so this is three arguments to
    // a program that will reject them — not a second command.
    expect(splitArgs('--port 8188; rm -rf /')).toEqual(['--port', '8188;', 'rm', '-rf', '/']);
  });
});

describe('argumentsOf', () => {
  it('passes nothing at all for a blank configuration', () => {
    expect(argumentsOf(comfy, config())).toEqual([]);
  });

  it('passes a set flag and leaves an unset one out', () => {
    const args = argumentsOf(comfy, config({ values: { '--lowvram': true, '--cpu': false } }));
    expect(args).toEqual(['--lowvram']);
  });

  it('passes a value as two arguments rather than with an equals sign', () => {
    const args = argumentsOf(comfy, config({ values: { '--port': 8189 } }));
    expect(args).toEqual(['--port', '8189']);
  });

  it('treats an emptied text field as unset', () => {
    // Otherwise `--listen` arrives with nothing after it, and ComfyUI reads the
    // next flag as its value.
    expect(argumentsOf(comfy, config({ values: { '--listen': '' } }))).toEqual([]);
  });

  it('keeps the order the form declares, so the command reads the way it was set', () => {
    const args = argumentsOf(
      comfy,
      config({ values: { '--port': 8189, '--listen': '0.0.0.0' } }),
    );
    expect(args).toEqual(['--listen', '0.0.0.0', '--port', '8189']);
  });

  it('appends whatever was typed by hand, after the declared ones', () => {
    const args = argumentsOf(
      comfy,
      config({ values: { '--lowvram': true }, extraArgs: '--fast --cache-none' }),
    );
    expect(args).toEqual(['--lowvram', '--fast', '--cache-none']);
  });

  it('ignores a flag value that is somehow not a boolean', () => {
    expect(argumentsOf(comfy, config({ values: { '--cpu': 'true' } }))).toEqual(['--cpu']);
  });
});

describe('buildCommand', () => {
  it('takes the first launcher whose file is there', () => {
    const command = buildCommand(comfy, config(), (file) => file === 'python_embeded/python.exe');
    expect(command?.file).toBe('python_embeded/python.exe');
    expect(command?.args.slice(0, 2)).toEqual(['-s', 'ComfyUI/main.py']);
  });

  it('skips a launcher that is not installed and takes the next', () => {
    const command = buildCommand(comfy, config(), (file) => file === 'venv/bin/python');
    expect(command?.file).toBe('venv/bin/python');
    expect(command?.args[0]).toBe('main.py');
  });

  it('uses a launcher chosen by hand even when its file cannot be seen', () => {
    // `python3` has no file under the root to find, which is the ordinary case
    // for it rather than a broken install.
    const command = buildCommand(comfy, config({ launcher: 'system' }), () => false);
    expect(command?.file).toBe('python3');
  });

  it('is nothing when no launcher is found and none was chosen', () => {
    expect(buildCommand(comfy, config(), () => false)).toBeNull();
  });

  it('puts the launcher arguments before the configured ones', () => {
    const command = buildCommand(
      comfy,
      config({ values: { '--listen': '0.0.0.0' } }),
      (file) => file === 'python_embeded/python.exe',
    );
    expect(command?.args).toEqual(['-s', 'ComfyUI/main.py', '--listen', '0.0.0.0']);
  });

  it('builds a llama-server command from its own launchers', () => {
    const llamaConfig: ServiceConfig = {
      ...blankConfig(llama, 'id', 0),
      root: '/opt/llama',
      values: { '--model': '/models/q4.gguf', '--gpu-layers': 99 },
    };
    const command = buildCommand(llama, llamaConfig, (file) => file === 'llama-server');
    expect(command?.file).toBe('llama-server');
    expect(command?.args).toEqual(['--model', '/models/q4.gguf', '--gpu-layers', '99']);
  });
});

describe('commandLine', () => {
  it('quotes only the parts that need it', () => {
    const command = buildCommand(
      comfy,
      config({ values: { '--output-directory': 'D:/My Pictures' } }),
      (file) => file === 'python_embeded/python.exe',
    );
    expect(commandLine(command)).toBe(
      'python_embeded/python.exe -s ComfyUI/main.py --output-directory "D:/My Pictures"',
    );
  });

  it('is empty when there is no command to show', () => {
    expect(commandLine(null)).toBe('');
  });
});

describe('portOf', () => {
  it('is the service default until one is set', () => {
    expect(portOf(comfy, config())).toBe(8188);
    expect(portOf(llama, { ...blankConfig(llama, 'id', 0), root: '' })).toBe(8080);
  });

  it('is whatever was set, including as text', () => {
    expect(portOf(comfy, config({ values: { '--port': 9000 } }))).toBe(9000);
    expect(portOf(comfy, config({ values: { '--port': '9001' } }))).toBe(9001);
  });

  it('falls back rather than returning nonsense', () => {
    expect(portOf(comfy, config({ values: { '--port': 'abc' } }))).toBe(8188);
  });
});

describe('the arguments a model server actually needs', () => {
  const arg = (flag: string) => llama.args.find((entry) => entry.flag === flag);

  it('offers the five that otherwise get typed by hand every time', () => {
    for (const flag of ['--spec-type', '-lv', '-fit', '--sleep-idle-seconds', '-np']) {
      expect(arg(flag)).toBeDefined();
    }
  });

  it('presets each of them to the value that is nearly always wanted', () => {
    expect(arg('--spec-type')?.preset).toBe('draft-mtp');
    expect(arg('-lv')?.preset).toBe(4);
    expect(arg('-fit')?.preset).toBe('off');
    expect(arg('--sleep-idle-seconds')?.preset).toBe(1);
    expect(arg('-np')?.preset).toBe(1);
  });

  it('keeps the preset apart from what the program does unasked', () => {
    // These two differ on purpose: llama.cpp fits to memory by default, and the
    // preset here switches that off.
    expect(arg('-fit')?.fallback).toBe('on');
    expect(arg('-fit')?.preset).toBe('off');
  });

  it('sends nothing at all until one is switched on', () => {
    const fresh: ServiceConfig = { ...blankConfig(llama, 'id', 0), root: '/opt/llama' };
    expect(argumentsOf(llama, fresh)).toEqual([]);
  });

  it('sends the flag and its value once it is', () => {
    const on: ServiceConfig = {
      ...blankConfig(llama, 'id', 0),
      root: '/opt/llama',
      values: { '--spec-type': 'draft-mtp', '-np': 1, '-fit': 'off' },
    };
    // In the order the catalogue declares them, which is the order they read
    // in on the form — so the command line and the form agree.
    expect(argumentsOf(llama, on)).toEqual([
      '--spec-type', 'draft-mtp',
      '-np', '1',
      '-fit', 'off',
    ]);
  });

  it('lists draft-mtp among the speculation types llama.cpp knows', () => {
    expect(arg('--spec-type')?.choices).toContain('draft-mtp');
    expect(arg('--spec-type')?.choices).toContain('none');
  });

  /**
   * The MTP head is a draft model wearing another name.
   *
   * llama.cpp has no `--mtp-head`: multi-token prediction is a speculation
   * *type*, and the weights it drafts with load through the ordinary draft
   * flag. Worth pinning, because a label that says "draft model" and a user
   * looking for "MTP head" is exactly how this gets asked for twice.
   */
  it('reaches the MTP head through the draft-model flag, and says so', () => {
    const head = arg('--spec-draft-model');
    expect(head).toBeDefined();
    expect(head?.label).toMatch(/MTP head/i);
    expect(head?.suggest).toBe('gguf');
  });

  it('offers the folder for every file it would be tedious to type', () => {
    for (const flag of ['--model', '--mmproj', '--spec-draft-model']) {
      expect(arg(flag)?.suggest).toBe('gguf');
    }
  });
});

describe('blankConfig', () => {
  it('starts with no arguments set, so the command says only what you chose', () => {
    const fresh = blankConfig(comfy, 'new', 1234);
    expect(fresh.values).toEqual({});
    expect(fresh.extraArgs).toBe('');
    expect(argumentsOf(comfy, fresh)).toEqual([]);
  });

  it('restarts a crash by itself but does not start itself with Latent', () => {
    const fresh = blankConfig(comfy, 'new', 1234);
    expect(fresh.autoRestart).toBe(true);
    expect(fresh.autoStart).toBe(false);
  });
});
