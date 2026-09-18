/**
 * Latent as a host process, with the other services under it.
 *
 * The hierarchy is a convenience rather than a claim: ComfyUI is a powerful
 * program in its own right and so is llama-server, and neither knows Latent
 * exists. But one of the three runs for weeks and the other two fall over —
 * out of memory on a model that was one gigabyte too big, a driver that went
 * away, a custom node that threw during startup — and the one that stays up is
 * the sensible place to put the button that starts the others again.
 *
 * What that needs is small and worth naming exactly:
 *
 * - **A root per service.** Where the binaries are. Everything else is derived
 *   from it, because a portable ComfyUI is a folder with a Python inside it and
 *   a llama.cpp build is a folder with `llama-server` inside it.
 * - **Arguments as a form, not a string.** Both services are configured
 *   entirely on the command line, and both have a hundred flags. Typing one
 *   out is how you find out at 2am that `--lowvram` has one dash. So the
 *   arguments are declared — name, type, default, what it does — and the
 *   command is *built* from what you set.
 * - **A command you can read.** Whatever the form says, the thing that gets run
 *   is shown in full before it runs. A manager that hides the command it
 *   produces is a manager you cannot debug.
 * - **Room for the next one.** There will be more of these. So a service is a
 *   definition in a list rather than a branch in the code, and adding one is
 *   adding a definition.
 *
 * Nothing here runs anything. This module is the catalogue and the rules for
 * turning a configuration into a command; the spawning lives on the server,
 * where the process is.
 */

/** Which service a definition describes. A string, so a new one is a new value. */
export type ServiceKind = string;

/** What sort of value an argument takes, which decides how it is edited. */
export type ServiceArgType = 'flag' | 'string' | 'path' | 'int' | 'float' | 'choice';

/** One command-line argument a service understands. */
export interface ServiceArg {
  /** The flag as it is typed: `--lowvram`, `--port`, `-ngl`. */
  flag: string;
  /** What it is called in the form. */
  label: string;
  type: ServiceArgType;
  /**
   * What the service does when the flag is absent.
   *
   * Shown beside the control rather than filled into it, which is the whole
   * point: a form pre-filled with defaults produces a command line stating
   * thirty things the program would have done anyway, and then you cannot see
   * the two that matter. Nothing is passed unless it is set.
   */
  fallback?: string;
  choices?: string[];
  min?: number;
  max?: number;
  /** One sentence. Long enough to decide with, short enough to read in a list. */
  help: string;
  /** Which section of the form it appears under. */
  group: string;
  /**
   * What switching this argument on fills it in as.
   *
   * An argument with a preset is drawn as a switch and a value rather than as
   * an empty box: the answer is nearly always the same one, and typing
   * `draft-mtp` correctly at two in the morning is not a thing anybody should
   * have to do twice. The value stays editable — the preset decides where it
   * starts, not where it stays.
   *
   * Deliberately not the same thing as `fallback`. That is what the *program*
   * does when the flag is absent; this is what *you* usually want when it is
   * present, and for several of these the two are different on purpose —
   * llama.cpp fits to memory by default and this switches that off.
   */
  preset?: ServiceArgValue;
  /**
   * Offer the files under the service's root instead of an empty text box.
   *
   * `gguf` lists every `.gguf` the root holds. Model filenames are long,
   * versioned and quantisation-suffixed, and typing one from memory on a phone
   * is the single most tedious thing about setting a model server up — on a
   * desktop you tab-complete, which is exactly why the files end up in one
   * folder beside the executable in the first place.
   */
  suggest?: 'gguf';
  /**
   * Offered on the first page rather than behind "everything else".
   *
   * The handful somebody sets on day one — where it listens, how much VRAM to
   * leave, which model to load. The rest exist and are reachable, but a form
   * that opens on a hundred fields is a form nobody fills in.
   */
  common?: boolean;
}

/** A way of starting a service, given its root directory. */
export interface ServiceLauncher {
  id: string;
  label: string;
  /**
   * The executable, relative to the root.
   *
   * Probed in order: the first launcher whose file is actually there is the one
   * used, unless a launcher was chosen by hand. That is what lets one
   * definition cover a portable Windows build, a virtualenv and a system
   * install without asking which you have.
   */
  file: string;
  /** Arguments that come before the configured ones, also relative to the root. */
  args: string[];
  /** What this launcher is, in the one line the picker has room for. */
  hint: string;
}

export interface ServiceDefinition {
  kind: ServiceKind;
  label: string;
  /** One line, for the card in the list. */
  blurb: string;
  /** What to point the root at, said in terms of what is inside it. */
  rootHint: string;
  /** The address it serves on, built from the arguments, so the UI can link to it. */
  defaultPort: number;
  launchers: ServiceLauncher[];
  args: ServiceArg[];
}

/* ------------------------------------------------------------------ */
/* ComfyUI                                                             */
/* ------------------------------------------------------------------ */

/**
 * ComfyUI's arguments, as its own `cli_args.py` declares them.
 *
 * A deliberate selection rather than all hundred and twenty. The ones left out
 * are the ones that exist for one card, one bug or one CI run — `--fp64-unet`,
 * `--quick-test-for-ci`, the feature-flag registry — and putting them in a form
 * on a phone would bury the six anybody actually sets. Everything omitted is
 * still reachable through the free-text field at the end, which is there
 * precisely so this list does not have to be exhaustive to be complete.
 */
const COMFY_ARGS: ServiceArg[] = [
  {
    flag: '--listen',
    label: 'Listen on',
    type: 'string',
    fallback: '127.0.0.1',
    help: 'Which address to accept connections on. Set it to 0.0.0.0 to reach ComfyUI from another machine — which is what Latent needs unless it is on the same box.',
    group: 'Network',
    common: true,
  },
  {
    flag: '--port',
    label: 'Port',
    type: 'int',
    fallback: '8188',
    min: 1,
    max: 65535,
    help: 'The port to serve on.',
    group: 'Network',
    common: true,
  },
  {
    flag: '--enable-cors-header',
    label: 'CORS origin',
    type: 'string',
    fallback: 'off',
    help: 'Allow browser requests from this origin. Leave it alone unless something in a browser talks to ComfyUI directly.',
    group: 'Network',
  },
  {
    flag: '--tls-keyfile',
    label: 'TLS key file',
    type: 'path',
    help: 'Serve over HTTPS with this private key. Needs the certificate below as well.',
    group: 'Network',
  },
  {
    flag: '--tls-certfile',
    label: 'TLS certificate',
    type: 'path',
    help: 'The certificate matching the key above.',
    group: 'Network',
  },
  {
    flag: '--max-upload-size',
    label: 'Max upload (MB)',
    type: 'float',
    fallback: '100',
    help: 'How large a file may be sent to ComfyUI. Worth raising if a workflow takes video in.',
    group: 'Network',
  },

  {
    flag: '--base-directory',
    label: 'Base directory',
    type: 'path',
    help: 'Where models, custom nodes, inputs and outputs live, if not inside the install itself.',
    group: 'Folders',
    common: true,
  },
  {
    flag: '--output-directory',
    label: 'Output folder',
    type: 'path',
    help: 'Where finished pictures are written. Overrides the base directory.',
    group: 'Folders',
  },
  {
    flag: '--input-directory',
    label: 'Input folder',
    type: 'path',
    help: 'Where pictures sent to ComfyUI land. Overrides the base directory.',
    group: 'Folders',
  },
  {
    flag: '--temp-directory',
    label: 'Temp folder',
    type: 'path',
    help: 'Scratch space. Worth moving off a small system drive.',
    group: 'Folders',
  },
  {
    flag: '--models-directory',
    label: 'Models folder',
    type: 'path',
    help: 'The models tree, when it is on another disk from the install.',
    group: 'Folders',
  },
  {
    flag: '--user-directory',
    label: 'User folder',
    type: 'path',
    help: 'Where saved workflows and settings are kept.',
    group: 'Folders',
  },
  {
    flag: '--extra-model-paths-config',
    label: 'Extra model paths',
    type: 'path',
    help: 'An extra_model_paths.yaml pointing at model folders elsewhere.',
    group: 'Folders',
  },

  {
    flag: '--lowvram',
    label: 'Low VRAM',
    type: 'flag',
    help: 'Split the model up to fit a smaller card. Slower, and the first thing to try when a graph will not load.',
    group: 'Memory',
    common: true,
  },
  {
    flag: '--novram',
    label: 'No VRAM',
    type: 'flag',
    help: 'When low VRAM is still not enough.',
    group: 'Memory',
  },
  {
    flag: '--highvram',
    label: 'High VRAM',
    type: 'flag',
    help: 'Keep models on the card between runs. Faster on a card with room to spare.',
    group: 'Memory',
    common: true,
  },
  {
    flag: '--gpu-only',
    label: 'GPU only',
    type: 'flag',
    help: 'Keep everything — text encoders, VAE, the lot — on the card.',
    group: 'Memory',
  },
  {
    flag: '--cpu',
    label: 'CPU only',
    type: 'flag',
    help: 'Run everything on the processor. Very slow, and occasionally the only way to get a result at all.',
    group: 'Memory',
  },
  {
    flag: '--reserve-vram',
    label: 'Reserve VRAM (GB)',
    type: 'float',
    help: 'Leave this much of the card free for everything else on the machine.',
    group: 'Memory',
    common: true,
  },
  {
    flag: '--vram-headroom',
    label: 'VRAM headroom (GB)',
    type: 'float',
    fallback: '0',
    help: 'How much room dynamic VRAM keeps spare as it loads and unloads.',
    group: 'Memory',
  },
  {
    flag: '--disable-smart-memory',
    label: 'Disable smart memory',
    type: 'flag',
    help: 'Push models back to system RAM aggressively rather than keeping them resident.',
    group: 'Memory',
  },
  {
    flag: '--cache-none',
    label: 'No node cache',
    type: 'flag',
    help: 'Keep no intermediate results. Much less memory, and every run redoes everything.',
    group: 'Memory',
  },
  {
    flag: '--cache-lru',
    label: 'Cache N results',
    type: 'int',
    fallback: '0',
    help: 'Keep this many node results around instead of the default caching.',
    group: 'Memory',
  },

  {
    flag: '--cuda-device',
    label: 'CUDA device',
    type: 'string',
    help: 'Which card to use, by index. `1` for the second card in the machine.',
    group: 'Device',
    common: true,
  },
  {
    flag: '--force-fp16',
    label: 'Force fp16',
    type: 'flag',
    help: 'Run in half precision even where ComfyUI would not choose to.',
    group: 'Device',
  },
  {
    flag: '--force-fp32',
    label: 'Force fp32',
    type: 'flag',
    help: 'Full precision throughout. Slower, and the fix for a card that produces black images.',
    group: 'Device',
  },
  {
    flag: '--fp16-vae',
    label: 'fp16 VAE',
    type: 'flag',
    help: 'Decode in half precision. Faster; on some VAEs it produces black images.',
    group: 'Device',
  },
  {
    flag: '--fp32-vae',
    label: 'fp32 VAE',
    type: 'flag',
    help: 'Decode in full precision. The fix when fp16 goes black.',
    group: 'Device',
  },
  {
    flag: '--cpu-vae',
    label: 'VAE on the CPU',
    type: 'flag',
    help: 'Decode on the processor, which frees the card at the one moment it is most full.',
    group: 'Device',
  },
  {
    flag: '--use-sage-attention',
    label: 'Sage attention',
    type: 'flag',
    help: 'Use SageAttention, where it is installed.',
    group: 'Device',
  },
  {
    flag: '--use-flash-attention',
    label: 'Flash attention',
    type: 'flag',
    help: 'Use FlashAttention, where it is installed.',
    group: 'Device',
  },
  {
    flag: '--use-pytorch-cross-attention',
    label: 'PyTorch attention',
    type: 'flag',
    help: "PyTorch's own attention rather than the split or sub-quadratic ones.",
    group: 'Device',
  },
  {
    flag: '--disable-cuda-malloc',
    label: 'No async CUDA malloc',
    type: 'flag',
    help: 'Turn off cudaMallocAsync. Worth trying against an allocator crash.',
    group: 'Device',
  },
  {
    flag: '--deterministic',
    label: 'Deterministic',
    type: 'flag',
    help: 'Slower algorithms that give the same result every time from the same seed.',
    group: 'Device',
  },

  {
    flag: '--preview-method',
    label: 'Preview method',
    type: 'choice',
    choices: ['none', 'auto', 'latent2rgb', 'taesd'],
    fallback: 'none',
    help: "How the live preview is drawn while sampling. `auto` is what makes Latent's progress bar show the picture forming.",
    group: 'Behaviour',
    common: true,
  },
  {
    flag: '--preview-size',
    label: 'Preview size',
    type: 'int',
    fallback: '512',
    help: 'How large those previews are.',
    group: 'Behaviour',
  },
  {
    flag: '--disable-auto-launch',
    label: "Don't open a browser",
    type: 'flag',
    help: 'Stop ComfyUI opening its own interface on startup. Usually right when Latent is the interface.',
    group: 'Behaviour',
    common: true,
  },
  {
    flag: '--disable-all-custom-nodes',
    label: 'No custom nodes',
    type: 'flag',
    help: 'Load none of them. The way to find out whether a custom node is what is crashing.',
    group: 'Behaviour',
  },
  {
    flag: '--enable-manager',
    label: 'Enable ComfyUI-Manager',
    type: 'flag',
    help: "Turn on the Manager's own features.",
    group: 'Behaviour',
  },
  {
    flag: '--disable-metadata',
    label: 'No metadata in files',
    type: 'flag',
    help: 'Stop writing the prompt into saved pictures. Latent keeps its own record either way.',
    group: 'Behaviour',
  },
  {
    flag: '--multi-user',
    label: 'Multi-user',
    type: 'flag',
    help: 'Keep separate stored state per user.',
    group: 'Behaviour',
  },
  {
    flag: '--verbose',
    label: 'Log level',
    type: 'choice',
    choices: ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'],
    fallback: 'INFO',
    help: 'How much it writes to its log. `DEBUG` is what to turn on before reporting a crash.',
    group: 'Behaviour',
  },
  {
    flag: '--windows-standalone-build',
    label: 'Windows standalone',
    type: 'flag',
    help: "What the portable build's own .bat file passes. Leave it on if you are running ComfyUI Portable.",
    group: 'Behaviour',
  },
];

/* ------------------------------------------------------------------ */
/* llama-server                                                        */
/* ------------------------------------------------------------------ */

/**
 * llama.cpp's server arguments, as `tools/server` documents them.
 *
 * Same selection rule as ComfyUI's: the ones that decide whether it starts and
 * how it behaves, not the full parser. Sampling is included — temperature and
 * the rest — because a server started with the wrong ones is a chat that reads
 * wrong in a way nobody traces back to a command line, and because llama.cpp
 * treats them as the server's defaults rather than as per-request settings.
 */
const LLAMA_ARGS: ServiceArg[] = [
  {
    flag: '--model',
    label: 'Model file',
    type: 'path',
    suggest: 'gguf',
    help: 'The .gguf to load. An absolute path, or one relative to the root below.',
    group: 'Model',
    common: true,
  },
  {
    flag: '--hf-repo',
    label: 'Hugging Face repo',
    type: 'string',
    help: 'Fetch and run a model from the Hub instead, as `owner/name:quant`.',
    group: 'Model',
  },
  {
    flag: '--alias',
    label: 'Model name',
    type: 'string',
    help: 'What the model calls itself over the API. Handy when something picks a model by name.',
    group: 'Model',
  },
  {
    flag: '--mmproj',
    label: 'Multimodal projector',
    type: 'path',
    suggest: 'gguf',
    help: 'The mmproj file a multimodal model needs to see pictures, watch clips or hear sound at all.',
    group: 'Model',
    common: true,
  },
  /*
   * The MTP head, which is a draft model wearing another name.
   *
   * llama.cpp has no `--mtp-head`: multi-token prediction is one of the
   * speculative decoding *types*, and the weights it speculates with are loaded
   * through the ordinary draft-model flag. Worth saying in the label rather
   * than leaving somebody to work out that "draft model" is where their MTP
   * head goes — and worth pairing with the speculation setting below, which is
   * the switch that makes it do anything.
   */
  {
    flag: '--spec-draft-model',
    label: 'MTP head / draft model',
    type: 'path',
    suggest: 'gguf',
    help: 'The weights speculative decoding drafts with. For an MTP head this is where it goes — llama.cpp loads it through the draft-model flag and the speculation type below decides what it does with it.',
    group: 'Model',
    common: true,
  },
  {
    flag: '--lora',
    label: 'LoRA',
    type: 'path',
    help: 'A LoRA adapter to apply on top of the model.',
    group: 'Model',
  },
  {
    flag: '--chat-template',
    label: 'Chat template',
    type: 'string',
    help: "Override the template baked into the file. Only needed when a model's own is wrong.",
    group: 'Model',
  },

  {
    flag: '--host',
    label: 'Listen on',
    type: 'string',
    fallback: '127.0.0.1',
    help: 'Which address to accept connections on. 0.0.0.0 to reach it from another machine.',
    group: 'Network',
    common: true,
  },
  {
    flag: '--port',
    label: 'Port',
    type: 'int',
    fallback: '8080',
    min: 1,
    max: 65535,
    help: 'The port to serve on.',
    group: 'Network',
    common: true,
  },
  {
    flag: '--api-key',
    label: 'API key',
    type: 'string',
    help: 'Require this key on every request. Worth setting the moment it listens on anything but localhost.',
    group: 'Network',
  },
  {
    flag: '--no-webui',
    label: 'No web interface',
    type: 'flag',
    help: "Serve the API only. Reasonable when Latent's chat is the only thing talking to it.",
    group: 'Network',
  },
  {
    flag: '--metrics',
    label: 'Prometheus metrics',
    type: 'flag',
    help: 'Expose a /metrics endpoint.',
    group: 'Network',
  },

  {
    flag: '--gpu-layers',
    label: 'Layers on the GPU',
    type: 'int',
    help: 'How many layers to offload. The single most consequential number here: too many and it will not load, too few and it crawls. `99` means all of them.',
    group: 'Performance',
    common: true,
  },
  {
    flag: '--ctx-size',
    label: 'Context size',
    type: 'int',
    fallback: "the model's own",
    help: 'How many tokens it can hold at once. Costs memory in proportion.',
    group: 'Performance',
    common: true,
  },
  {
    flag: '--threads',
    label: 'Threads',
    type: 'int',
    help: 'CPU threads for generation. Usually the number of real cores.',
    group: 'Performance',
  },
  {
    flag: '--batch-size',
    label: 'Batch size',
    type: 'int',
    fallback: '2048',
    help: 'How many tokens are submitted for processing at once.',
    group: 'Performance',
  },
  {
    flag: '--ubatch-size',
    label: 'Physical batch size',
    type: 'int',
    fallback: '512',
    help: 'How many of those are actually computed together.',
    group: 'Performance',
  },
  {
    flag: '--flash-attn',
    label: 'Flash attention',
    type: 'choice',
    choices: ['on', 'off', 'auto'],
    fallback: 'auto',
    help: 'Faster attention where the build supports it.',
    group: 'Performance',
  },
  {
    flag: '--parallel',
    label: 'Slots',
    type: 'int',
    fallback: '1',
    help: 'How many requests it will serve at once. Each one takes its own share of the context.',
    group: 'Performance',
  },
  {
    flag: '--no-mmap',
    label: 'No mmap',
    type: 'flag',
    help: 'Read the whole model into memory rather than mapping it. Slower to start, and sometimes necessary on a network drive.',
    group: 'Performance',
  },
  {
    flag: '--mlock',
    label: 'Lock in RAM',
    type: 'flag',
    help: 'Stop the model being paged out.',
    group: 'Performance',
  },
  {
    flag: '--cache-type-k',
    label: 'K cache type',
    type: 'choice',
    choices: ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0'],
    fallback: 'f16',
    help: 'Quantise the key cache to fit a longer context in the same memory.',
    group: 'Performance',
  },
  {
    flag: '--cache-type-v',
    label: 'V cache type',
    type: 'choice',
    choices: ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0'],
    fallback: 'f16',
    help: 'The same for the value cache. Usually set together with the key cache.',
    group: 'Performance',
  },

  {
    flag: '--temp',
    label: 'Temperature',
    type: 'float',
    fallback: '0.8',
    help: "How adventurous the replies are, unless a request says otherwise.",
    group: 'Sampling',
  },
  {
    flag: '--top-k',
    label: 'Top-k',
    type: 'int',
    fallback: '40',
    help: 'Only ever consider this many candidates.',
    group: 'Sampling',
  },
  {
    flag: '--top-p',
    label: 'Top-p',
    type: 'float',
    fallback: '0.95',
    help: 'Consider the likeliest candidates up to this share of the probability.',
    group: 'Sampling',
  },
  {
    flag: '--min-p',
    label: 'Min-p',
    type: 'float',
    fallback: '0.05',
    help: 'Drop anything this much less likely than the best candidate.',
    group: 'Sampling',
  },
  {
    flag: '--repeat-penalty',
    label: 'Repeat penalty',
    type: 'float',
    fallback: '1.0',
    help: 'Push down on words it has just used.',
    group: 'Sampling',
  },
  {
    flag: '--predict',
    label: 'Max tokens',
    type: 'int',
    fallback: 'unlimited',
    help: 'A ceiling on how much it writes in one reply.',
    group: 'Sampling',
  },
  {
    flag: '--jinja',
    label: 'Jinja templates',
    type: 'flag',
    help: "Use the model's own chat template. Needed by most models that call tools.",
    group: 'Sampling',
    common: true,
  },

  {
    flag: '--spec-type',
    label: 'Speculative decoding',
    type: 'choice',
    choices: [
      'none',
      'draft-simple',
      'draft-eagle3',
      'draft-mtp',
      'draft-dflash',
      'draft-dspark',
      'ngram-simple',
      'ngram-map-k',
      'ngram-map-k4v',
      'ngram-mod',
      'ngram-cache',
    ],
    preset: 'draft-mtp',
    fallback: 'none',
    help: 'How it guesses ahead. `draft-mtp` is multi-token prediction, which needs the MTP head above; the ngram ones speculate from the text alone and need no second model.',
    group: 'Speculation',
    common: true,
  },
  {
    flag: '-np',
    label: 'Slots',
    type: 'int',
    preset: 1,
    fallback: '-1 (auto)',
    min: 1,
    help: 'How many requests it serves at once. Each slot takes its own share of the context, so one slot gives a single conversation all of it.',
    group: 'Performance',
    common: true,
  },
  {
    flag: '-fit',
    label: 'Fit to memory',
    type: 'choice',
    choices: ['on', 'off'],
    preset: 'off',
    fallback: 'on',
    help: 'Whether llama.cpp adjusts the arguments you did not set so everything fits in device memory. Off leaves your numbers exactly as you typed them, which is what you want once you have tuned them.',
    group: 'Performance',
    common: true,
  },
  {
    flag: '--sleep-idle-seconds',
    label: 'Sleep when idle after',
    type: 'int',
    preset: 1,
    fallback: '-1 (never)',
    min: -1,
    help: 'Seconds of quiet before it unloads the model and gives the VRAM back. The next request loads it again. -1 never sleeps.',
    group: 'Performance',
    common: true,
  },
  {
    flag: '-lv',
    label: 'Log verbosity',
    type: 'int',
    preset: 4,
    fallback: '0',
    min: 0,
    max: 5,
    help: 'How much it writes: 0 generic, 1 error, 2 warning, 3 info, 4 trace, 5 debug. 4 is what makes the log worth watching.',
    group: 'Behaviour',
    common: true,
  },
];

/**
 * Every service Latent knows how to start.
 *
 * A list, and adding to it is the whole job of supporting a new one. Nothing
 * else in the supervisor — not the process manager, not the routes, not the
 * screen — mentions ComfyUI or llama.cpp by name.
 */
export const SERVICE_DEFINITIONS: ServiceDefinition[] = [
  {
    kind: 'comfyui',
    label: 'ComfyUI',
    blurb: 'The thing that makes the pictures.',
    rootHint:
      'The folder holding ComfyUI. For the Windows portable build that is `ComfyUI_windows_portable`, the one with `python_embeded` and `ComfyUI` inside it — not the `ComfyUI` folder itself.',
    defaultPort: 8188,
    launchers: [
      {
        id: 'portable',
        label: 'Windows portable',
        file: 'python_embeded/python.exe',
        args: ['-s', 'ComfyUI/main.py'],
        hint: 'What run_nvidia_gpu.bat runs: the embedded Python, isolated with -s.',
      },
      {
        id: 'venv-windows',
        label: 'Virtualenv (Windows)',
        file: 'venv/Scripts/python.exe',
        args: ['main.py'],
        hint: 'A checkout with a venv beside it.',
      },
      {
        id: 'venv-posix',
        label: 'Virtualenv',
        file: 'venv/bin/python',
        args: ['main.py'],
        hint: 'A checkout with a venv beside it.',
      },
      {
        id: 'dotvenv-posix',
        label: '.venv',
        file: '.venv/bin/python',
        args: ['main.py'],
        hint: 'The same, under the dotted name.',
      },
      {
        id: 'system',
        label: 'System Python',
        file: 'python3',
        args: ['main.py'],
        hint: "Whatever `python3` resolves to, run inside the root. The fallback when nothing else is found.",
      },
    ],
    args: COMFY_ARGS,
  },
  {
    kind: 'llama-server',
    label: 'llama-server',
    blurb: "llama.cpp's HTTP server, which the chat talks to.",
    rootHint:
      'The folder holding the llama.cpp binaries — where `llama-server` is, or the build directory above `bin`.',
    defaultPort: 8080,
    launchers: [
      {
        id: 'flat-windows',
        label: 'Binary release (Windows)',
        file: 'llama-server.exe',
        args: [],
        hint: 'An unzipped release, where the executables sit at the top.',
      },
      {
        id: 'flat-posix',
        label: 'Binary release',
        file: 'llama-server',
        args: [],
        hint: 'An unzipped release, where the executables sit at the top.',
      },
      {
        id: 'build-windows',
        label: 'Built from source (Windows)',
        file: 'build/bin/Release/llama-server.exe',
        args: [],
        hint: 'A CMake build, Release configuration.',
      },
      {
        id: 'build-posix',
        label: 'Built from source',
        file: 'build/bin/llama-server',
        args: [],
        hint: 'A CMake build.',
      },
    ],
    args: LLAMA_ARGS,
  },
];

export function definitionFor(kind: ServiceKind): ServiceDefinition | undefined {
  return SERVICE_DEFINITIONS.find((definition) => definition.kind === kind);
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/** What one argument is set to. `true` is a flag being present. */
export type ServiceArgValue = string | number | boolean;

export interface ServiceConfig {
  id: string;
  kind: ServiceKind;
  /** What you call it. Two ComfyUIs on two cards want telling apart. */
  name: string;
  /** Where its binaries are. Nothing can start without one. */
  root: string;
  /**
   * Which launcher to use, or `null` to take the first one that exists.
   *
   * Automatic is right nearly always and wrong exactly once: a checkout with
   * both a venv and a system Python that differ in what is installed.
   */
  launcher: string | null;
  /** The arguments that are set, by flag. Anything absent is not passed. */
  values: Record<string, ServiceArgValue>;
  /**
   * Anything the catalogue above does not cover, typed out.
   *
   * Deliberately present. The declared arguments are the ones worth a control;
   * this is what stops that selection from being a ceiling, and it is where a
   * flag added to ComfyUI last week goes until somebody adds it properly.
   */
  extraArgs: string;
  /** Environment variables to start it with, on top of Latent's own. */
  env: Record<string, string>;
  /**
   * Start it again by itself when it dies.
   *
   * The reason this module exists. A crash mid-queue is otherwise a walk to
   * another machine, and everything after it in the queue is lost either way —
   * but with this, the walk is not also necessary.
   */
  autoRestart: boolean;
  /** Start it when Latent starts. */
  autoStart: boolean;
  createdAt: number;
}

/** What a service is doing. */
export type ServiceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed';

export interface ServiceStatus {
  id: string;
  state: ServiceState;
  pid: number | null;
  startedAt: number | null;
  /** When it last stopped, however it stopped. */
  stoppedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  /** How many times it has been restarted automatically since it was started. */
  restarts: number;
  /** Why it will not start, or why it stopped badly. */
  error: string | null;
  /** The command as it would actually be run, for reading before you run it. */
  command: string;
  /** When the next automatic restart is due, while one is pending. */
  restartAt: number | null;
}

export interface ServiceView {
  config: ServiceConfig;
  status: ServiceStatus;
}

/** A file found under a service's root, offered instead of a text box. */
export interface ServiceFile {
  /** Relative to the root, with forward slashes whatever the platform. */
  path: string;
  bytes: number;
}

/** One line of output, as the log tail hands it over. */
export interface ServiceLogLine {
  /** Monotonic within one service, so a client can ask for what it has not seen. */
  seq: number;
  at: number;
  stream: 'stdout' | 'stderr' | 'latent';
  text: string;
}

/* ------------------------------------------------------------------ */
/* Building the command                                                */
/* ------------------------------------------------------------------ */

/**
 * Split a free-text argument string the way a shell would, near enough.
 *
 * Quotes group, and a backslash escapes the next character. Deliberately not a
 * shell: nothing here expands a variable, runs a subcommand or globs, because
 * the string is handed to `spawn` as an argument list and never to `/bin/sh`.
 * A path with a space in it has to work, and `; rm -rf /` has to be three
 * arguments to a program that will not understand them rather than a second
 * command.
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;

  for (let at = 0; at < input.length; at += 1) {
    const char = input[at]!;

    if (char === '\\' && at + 1 < input.length && quote !== "'") {
      current += input[at + 1];
      has = true;
      at += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      has = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      has = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (has) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += char;
    has = true;
  }

  if (has) out.push(current);
  return out;
}

/**
 * The arguments a configuration produces, in the order the form declares them.
 *
 * Only what is set. A flag is present or absent; everything else is the flag
 * followed by its value, as two arguments rather than `--flag=value` — both
 * work for these two programs, and two arguments is the form that cannot be
 * broken by a value containing an equals sign.
 *
 * An empty string counts as unset. Otherwise clearing a text field would pass
 * `--listen` with nothing after it, which ComfyUI reads as the *next* flag
 * being its value.
 */
export function argumentsOf(definition: ServiceDefinition, config: ServiceConfig): string[] {
  const out: string[] = [];

  for (const arg of definition.args) {
    const value = config.values[arg.flag];
    if (value === undefined || value === null || value === '') continue;

    if (arg.type === 'flag') {
      if (value === true || value === 'true') out.push(arg.flag);
      continue;
    }

    if (typeof value === 'boolean') continue;
    out.push(arg.flag, String(value));
  }

  out.push(...splitArgs(config.extraArgs ?? ''));
  return out;
}

/** What a service would be started as: the program, its arguments, and where. */
export interface ServiceCommand {
  /** The executable. Relative to the root unless it has no path separator. */
  file: string;
  args: string[];
  launcher: ServiceLauncher;
}

/**
 * Turn a configuration into something that can be spawned.
 *
 * `available` is asked which of the launcher files actually exist — a question
 * only the machine with the folder on it can answer, which is why it comes in
 * rather than being worked out here. Everything else is a pure function of the
 * definition and the configuration, so the command shown in the UI and the
 * command that gets run are built by the same code from the same inputs.
 */
export function buildCommand(
  definition: ServiceDefinition,
  config: ServiceConfig,
  available: (file: string) => boolean,
): ServiceCommand | null {
  const chosen = config.launcher
    ? definition.launchers.find((launcher) => launcher.id === config.launcher)
    : undefined;

  /*
   * A launcher chosen by hand is used even when its file cannot be seen.
   *
   * `python3` has no file under the root to find, and a folder on a network
   * mount may not answer a `stat` while it is waking up. Somebody who picked a
   * launcher meant it; the automatic path is where existence decides.
   */
  const launcher =
    chosen ?? definition.launchers.find((candidate) => available(candidate.file)) ?? null;
  if (!launcher) return null;

  return {
    file: launcher.file,
    args: [...launcher.args, ...argumentsOf(definition, config)],
    launcher,
  };
}

/**
 * The command as one readable line.
 *
 * For showing, never for running — nothing takes this string apart again. Which
 * is exactly why it can afford to quote for readability rather than for a
 * particular shell: the point is that somebody can see that `--listen` got
 * `0.0.0.0` and that the model path with the space in it arrived in one piece.
 */
export function commandLine(command: ServiceCommand | null): string {
  if (!command) return '';
  return [command.file, ...command.args]
    .map((part) => (/[\s"']/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(' ');
}

/** The port a service will actually serve on, given what is set. */
export function portOf(definition: ServiceDefinition, config: ServiceConfig): number {
  const value = config.values['--port'];
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(port) && port > 0 ? port : definition.defaultPort;
}

/**
 * A fresh configuration for a service of this kind.
 *
 * Empty of arguments on purpose. See `ServiceArg.fallback`: a form pre-filled
 * with every default produces a command line that states thirty things the
 * program would have done anyway, and then the two that matter are invisible
 * in the middle of it.
 */
export function blankConfig(
  definition: ServiceDefinition,
  id: string,
  now: number,
): ServiceConfig {
  return {
    id,
    kind: definition.kind,
    name: definition.label,
    root: '',
    launcher: null,
    values: {},
    extraArgs: '',
    env: {},
    /*
     * Restarting is on and starting with Latent is off, which sounds
     * inconsistent and is not. Bringing something back that was running is
     * restoring the state you had; starting something you never started is a
     * decision, and a supervisor that launches processes on a machine because
     * it was installed there would be a nasty surprise.
     */
    autoRestart: true,
    autoStart: false,
    createdAt: now,
  };
}
