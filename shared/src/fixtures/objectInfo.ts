import type { ObjectInfo } from '../comfyTypes.js';

/*
 * A trimmed but faithful `/object_info` response.
 *
 * Shapes and option lists are copied from a real ComfyUI server so the schema
 * engine and the mock server are exercised against genuine data, not a
 * simplified idea of it.
 */

/**
 * ComfyUI advertises seeds up to 2^64-1. `JSON.parse` cannot represent that
 * exactly and rounds it to 2^64, so this is literally the number a client
 * receives — and it is still far beyond `Number.MAX_SAFE_INTEGER`, which is
 * what the schema engine has to clamp it to.
 */
export const SEED_MAX = 2 ** 64;

export const SAMPLERS = [
  'euler',
  'euler_ancestral',
  'heun',
  'dpm_2',
  'dpm_2_ancestral',
  'lms',
  'dpm_fast',
  'dpm_adaptive',
  'dpmpp_2s_ancestral',
  'dpmpp_sde',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_3m_sde',
  'ddim',
  'uni_pc',
];

export const SCHEDULERS = [
  'normal',
  'karras',
  'exponential',
  'sgm_uniform',
  'simple',
  'ddim_uniform',
  'beta',
];

export const CHECKPOINTS = [
  'sd_xl_base_1.0.safetensors',
  'sd_xl_refiner_1.0.safetensors',
  'v1-5-pruned-emaonly.safetensors',
  'dreamshaperXL_v21.safetensors',
];

export const LORAS = ['detail_tweaker_xl.safetensors', 'pixel_art_xl.safetensors'];

export const UPSCALE_MODELS = ['RealESRGAN_x4plus.pth', '4x-UltraSharp.pth'];

export const INPUT_IMAGES = ['example.png', 'photo.jpg'];

/**
 * Quantised weights, as they actually appear on a machine that runs video
 * models on one consumer card.
 *
 * The published checkpoints for LTX-2.5 and MiniMax-H3 are tens of gigabytes of
 * bf16 safetensors that nobody loads on a 24 GB card; what people run is a GGUF
 * or fp8 repack of them, loaded by a different node than a checkpoint. The
 * fixture says so, because a workflow this app cannot describe is a workflow it
 * cannot offer.
 */
export const GGUF_MODELS = [
  'ltx-2.5-video-Q4_K_M.gguf',
  'ltx-2.5-video-Q6_K.gguf',
  'minimax-h3-Q4_K_M.gguf',
];

export const GGUF_CLIPS = ['t5xxl_encoderonly-Q5_K_M.gguf', 'umt5-xxl-Q4_K_M.gguf'];

export const VAES = ['ltx-2.5-vae.safetensors', 'ae.safetensors'];

/** The ratios comfyllama's aspect-ratio latent offers, in its own order. */
export const ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '9:21',
  '21:9',
  '1:2',
  '2:1',
];

export const objectInfoFixture: ObjectInfo = {
  KSampler: {
    display_name: 'KSampler',
    category: 'sampling',
    output: ['LATENT'],
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0, min: 0, max: SEED_MAX, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000, tooltip: 'Number of denoising steps.' }],
        cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1, round: 0.01 }],
        sampler_name: [SAMPLERS, { default: 'euler' }],
        scheduler: [SCHEDULERS, { default: 'normal' }],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1.0, min: 0.0, max: 1.0, step: 0.01 }],
      },
    },
  },
  KSamplerAdvanced: {
    display_name: 'KSampler (Advanced)',
    output: ['LATENT'],
    input: {
      required: {
        model: ['MODEL'],
        add_noise: [['enable', 'disable'], { default: 'enable' }],
        noise_seed: ['INT', { default: 0, min: 0, max: SEED_MAX }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1 }],
        sampler_name: [SAMPLERS, { default: 'euler' }],
        scheduler: [SCHEDULERS, { default: 'normal' }],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        start_at_step: ['INT', { default: 0, min: 0, max: 10000 }],
        end_at_step: ['INT', { default: 10000, min: 0, max: 10000 }],
        return_with_leftover_noise: [['disable', 'enable'], { default: 'disable' }],
      },
    },
  },
  CheckpointLoaderSimple: {
    display_name: 'Load Checkpoint',
    output: ['MODEL', 'CLIP', 'VAE'],
    input: {
      required: {
        ckpt_name: [CHECKPOINTS, { tooltip: 'The diffusion model checkpoint to load.' }],
      },
    },
  },
  LoraLoader: {
    display_name: 'Load LoRA',
    output: ['MODEL', 'CLIP'],
    input: {
      required: {
        model: ['MODEL'],
        clip: ['CLIP'],
        lora_name: [LORAS],
        strength_model: ['FLOAT', { default: 1.0, min: -100.0, max: 100.0, step: 0.01 }],
        strength_clip: ['FLOAT', { default: 1.0, min: -100.0, max: 100.0, step: 0.01 }],
      },
    },
  },
  CLIPTextEncode: {
    display_name: 'CLIP Text Encode (Prompt)',
    output: ['CONDITIONING'],
    input: {
      required: {
        text: ['STRING', { multiline: true, dynamicPrompts: true }],
        clip: ['CLIP'],
      },
    },
  },
  EmptyLatentImage: {
    display_name: 'Empty Latent Image',
    output: ['LATENT'],
    input: {
      required: {
        width: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
        height: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
        batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
      },
    },
  },
  VAEDecode: {
    display_name: 'VAE Decode',
    output: ['IMAGE'],
    input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
  },
  VAEEncode: {
    display_name: 'VAE Encode',
    output: ['LATENT'],
    input: { required: { pixels: ['IMAGE'], vae: ['VAE'] } },
  },
  SaveImage: {
    display_name: 'Save Image',
    output: [],
    output_node: true,
    input: {
      required: {
        images: ['IMAGE'],
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
      },
    },
  },
  PreviewImage: {
    display_name: 'Preview Image',
    output: [],
    output_node: true,
    input: { required: { images: ['IMAGE'] } },
  },
  /** Reports a value as words rather than pixels — the diagnostic node. */
  PreviewAny: {
    display_name: 'Preview Any',
    output: [],
    output_node: true,
    input: { required: { source: ['*'] } },
  },
  LoadImage: {
    display_name: 'Load Image',
    output: ['IMAGE', 'MASK'],
    input: {
      required: {
        image: [INPUT_IMAGES, { image_upload: true }],
      },
    },
  },
  ImageScale: {
    display_name: 'Upscale Image',
    output: ['IMAGE'],
    input: {
      required: {
        image: ['IMAGE'],
        upscale_method: [['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos']],
        width: ['INT', { default: 512, min: 0, max: 16384, step: 1 }],
        height: ['INT', { default: 512, min: 0, max: 16384, step: 1 }],
        crop: [['disabled', 'center']],
      },
    },
  },
  UpscaleModelLoader: {
    display_name: 'Load Upscale Model',
    output: ['UPSCALE_MODEL'],
    input: { required: { model_name: [UPSCALE_MODELS] } },
  },
  ImageUpscaleWithModel: {
    display_name: 'Upscale Image (using Model)',
    output: ['IMAGE'],
    input: { required: { upscale_model: ['UPSCALE_MODEL'], image: ['IMAGE'] } },
  },
  ConditioningCombine: {
    display_name: 'Conditioning (Combine)',
    output: ['CONDITIONING'],
    input: { required: { conditioning_1: ['CONDITIONING'], conditioning_2: ['CONDITIONING'] } },
  },
  /**
   * The comfyllama node that points the rest at a `llama-server`.
   *
   * Here because Latent fills its address in from the connection in use, which
   * is only testable against a node that declares the widgets it fills.
   */
  LlamaServerConnect: {
    display_name: 'Connect to llama-server',
    output: ['LLAMA_SERVER', 'STRING'],
    input: {
      required: {
        base_url: ['STRING', { default: 'http://127.0.0.1:8080', multiline: false }],
        timeout: ['INT', { default: 300, min: 1, max: 3600 }],
        check_connection: ['BOOLEAN', { default: true }],
      },
      optional: {
        model: ['STRING', { default: 'auto' }],
        auth: [['auto', 'bearer', 'basic', 'none'], { default: 'auto' }],
        api_key: ['STRING', { default: '' }],
        username: ['STRING', { default: '' }],
        password: ['STRING', { default: '' }],
      },
    },
  },
  /**
   * Advanced sampling, and the one node with two ways to reach the same values.
   *
   * Temperature, top_p and top_k are settable one at a time, each on its own
   * switch, or all three at once from the `intensity` slider across the six
   * range bounds below it. Latent shows whichever half is deciding — see
   * `idleSamplingControl` — which is only testable against a node that declares
   * both halves.
   *
   * Copied in the node's own order, which is not the order it reads in: the
   * newer widgets are appended because ComfyUI stores widget values
   * positionally.
   */
  LlamaCppSampling: {
    display_name: 'Sampler Settings (llama.cpp)',
    output: ['LLAMA_SAMPLING'],
    input: {
      required: {
        use_top_k: ['BOOLEAN', { default: false }],
        top_k: ['INT', { default: 40, min: 0, max: 1000 }],
        use_min_p: ['BOOLEAN', { default: false }],
        min_p: ['FLOAT', { default: 0.05, min: 0.0, max: 1.0, step: 0.01 }],
        use_typical_p: ['BOOLEAN', { default: false }],
        typical_p: ['FLOAT', { default: 1.0, min: 0.0, max: 1.0, step: 0.01 }],
        use_repeat_penalty: ['BOOLEAN', { default: false }],
        repeat_penalty: ['FLOAT', { default: 1.1, min: 0.0, max: 2.0, step: 0.01 }],
        use_presence_penalty: ['BOOLEAN', { default: false }],
        presence_penalty: ['FLOAT', { default: 0.0, min: -2.0, max: 2.0, step: 0.01 }],
        use_frequency_penalty: ['BOOLEAN', { default: false }],
        frequency_penalty: ['FLOAT', { default: 0.0, min: -2.0, max: 2.0, step: 0.01 }],
        use_mirostat: ['BOOLEAN', { default: false }],
        mirostat_mode: ['INT', { default: 2, min: 0, max: 2 }],
        mirostat_tau: ['FLOAT', { default: 5.0, min: 0.0, max: 20.0, step: 0.1 }],
        mirostat_eta: ['FLOAT', { default: 0.1, min: 0.0, max: 1.0, step: 0.01 }],
        use_stop_sequences: ['BOOLEAN', { default: false }],
        stop_sequences: ['STRING', { default: '', multiline: true }],
        use_temperature: ['BOOLEAN', { default: false }],
        temperature: ['FLOAT', { default: 0.7, min: 0.0, max: 5.0, step: 0.01 }],
        use_top_p: ['BOOLEAN', { default: false }],
        top_p: ['FLOAT', { default: 0.95, min: 0.0, max: 1.0, step: 0.01 }],
        use_intensity: ['BOOLEAN', { default: false }],
        intensity: ['FLOAT', { default: 0.5, min: 0.0, max: 1.0, step: 0.01 }],
        temperature_min: ['FLOAT', { default: 0.1, min: 0, max: 5.0, step: 0.01 }],
        temperature_max: ['FLOAT', { default: 1.4, min: 0, max: 5.0, step: 0.01 }],
        top_p_min: ['FLOAT', { default: 0.5, min: 0, max: 1.0, step: 0.01 }],
        top_p_max: ['FLOAT', { default: 1.0, min: 0, max: 1.0, step: 0.01 }],
        top_k_min: ['INT', { default: 10, min: 0, max: 1000 }],
        top_k_max: ['INT', { default: 100, min: 0, max: 1000 }],
      },
    },
  },
  LlamaServerChat: {
    display_name: 'Chat (llama-server)',
    output: ['STRING', 'STRING', 'LLAMA_MESSAGES'],
    input: {
      required: {
        server: ['LLAMA_SERVER'],
        system: ['STRING', { default: 'You are a helpful assistant.', multiline: true }],
        prompt: ['STRING', { default: '', multiline: true, dynamicPrompts: true }],
      },
      /*
       * The image and its three controls, in the node's own order.
       *
       * `use_image` comes last because comfyllama appends it there: ComfyUI
       * stores widget values positionally, so a switch inserted above the two
       * encoding controls would have shifted them in every already-saved
       * workflow.
       */
      optional: {
        image: ['IMAGE'],
        image_max_size: ['INT', { default: 1024, min: 0, max: 4096, step: 64 }],
        image_quality: ['INT', { default: 90, min: 30, max: 100 }],
        use_image: ['BOOLEAN', { default: true }],
      },
    },
  },
  /**
   * Six system prompts in one node, switched by `active`.
   *
   * The slots are declared as `Preset 1…6` and renamed in the graph, which is
   * the whole reason `applyPresetChat` exists — a form built from this
   * definition alone offers names nobody uses.
   */
  LlamaServerPresetChat: {
    display_name: 'Chat with Prompt Presets (llama-server)',
    output: ['STRING', 'STRING', 'STRING'],
    input: {
      required: {
        server: ['LLAMA_SERVER'],
        prompt: ['STRING', { default: '', multiline: true, dynamicPrompts: true }],
        active: [
          ['passthrough', 'Preset 1', 'Preset 2', 'Preset 3', 'Preset 4', 'Preset 5', 'Preset 6'],
          { default: 'passthrough' },
        ],
        slot_count: ['INT', { default: 3, min: 1, max: 6 }],
        max_tokens: ['INT', { default: 512, min: 1, max: 32768 }],
        seed: ['INT', { default: 0, min: 0, max: SEED_MAX }],
      },
      /*
       * Optional, exactly as the node has them. The web extension hides the
       * slots above `slot_count`, and a hidden widget does not survive an
       * "export (API)" — so declaring these required made such a workflow fail
       * validation before any request was made.
       */
      optional: {
        name_1: ['STRING', { default: 'Preset 1' }],
        system_1: ['STRING', { default: '', multiline: true }],
        model_1: ['STRING', { default: '' }],
        name_2: ['STRING', { default: 'Preset 2' }],
        system_2: ['STRING', { default: '', multiline: true }],
        model_2: ['STRING', { default: '' }],
        name_3: ['STRING', { default: 'Preset 3' }],
        system_3: ['STRING', { default: '', multiline: true }],
        model_3: ['STRING', { default: '' }],
        name_4: ['STRING', { default: 'Preset 4' }],
        system_4: ['STRING', { default: '', multiline: true }],
        model_4: ['STRING', { default: '' }],
        name_5: ['STRING', { default: 'Preset 5' }],
        system_5: ['STRING', { default: '', multiline: true }],
        model_5: ['STRING', { default: '' }],
        name_6: ['STRING', { default: 'Preset 6' }],
        system_6: ['STRING', { default: '', multiline: true }],
        model_6: ['STRING', { default: '' }],
        extra_separator: ['STRING', { default: '\\n\\n' }],
        /*
         * Every chat node can take an image now, not just the vision ones. The
         * two encoding controls are widgets, so they are exported whether or
         * not anything is wired to `image` — see `idleImageControl`.
         */
        image: ['IMAGE'],
        image_max_size: ['INT', { default: 1024, min: 0, max: 4096, step: 64 }],
        image_quality: ['INT', { default: 90, min: 30, max: 100 }],
        /* The switch that ignores a connected image; in the node's own order. */
        use_image: ['BOOLEAN', { default: true }],
        /*
         * Run the chosen preset, or hand the prompt straight through.
         *
         * The switch that replaced picking `passthrough` out of a dropdown of
         * system prompts. Latent hides the picker while it is off — see
         * `applyPresetChat` — which is only testable against a node that
         * declares it.
         */
        use_model: ['BOOLEAN', { default: true }],
      },
    },
  },
  /**
   * An empty latent sized by ratio rather than by width and height.
   *
   * `divisible_by` is the numeric combo in the suite: its choices arrive as
   * numbers, and the node compares against numbers.
   */
  /* ---------------------------------------------------------------- */
  /* Video: quantised loaders, a video latent, and the savers           */
  /* ---------------------------------------------------------------- */

  /** ComfyUI-GGUF's loader — how a quantised video model is actually loaded. */
  UnetLoaderGGUF: {
    display_name: 'Unet Loader (GGUF)',
    output: ['MODEL'],
    input: { required: { unet_name: [GGUF_MODELS] } },
  },
  CLIPLoaderGGUF: {
    display_name: 'CLIP Loader (GGUF)',
    output: ['CLIP'],
    input: {
      required: {
        clip_name: [GGUF_CLIPS],
        type: [['ltxv', 'stable_diffusion', 'flux', 'hunyuan_video', 'wan']],
      },
    },
  },
  VAELoader: {
    display_name: 'Load VAE',
    output: ['VAE'],
    input: { required: { vae_name: [VAES] } },
  },
  EmptyLTXVLatentVideo: {
    display_name: 'Empty LTXV Latent Video',
    output: ['LATENT'],
    input: {
      required: {
        width: ['INT', { default: 768, min: 64, max: 16384, step: 32 }],
        height: ['INT', { default: 512, min: 64, max: 16384, step: 32 }],
        // Quantised to 8n+1 by the model, which is what the step is for.
        length: ['INT', { default: 97, min: 9, max: 257, step: 8 }],
        batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
      },
    },
  },
  LTXVConditioning: {
    display_name: 'LTXV Conditioning',
    output: ['CONDITIONING', 'CONDITIONING'],
    input: {
      required: {
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        frame_rate: ['FLOAT', { default: 25, min: 0, max: 1000, step: 1 }],
      },
    },
  },
  /** Core ComfyUI's own video saver: files its result under `images`. */
  SaveWEBM: {
    display_name: 'Save WEBM',
    output: [],
    output_node: true,
    input: {
      required: {
        images: ['IMAGE'],
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
        codec: [['vp9', 'av1']],
        fps: ['FLOAT', { default: 24, min: 1, max: 120, step: 1 }],
        crf: ['FLOAT', { default: 32, min: 0, max: 63, step: 1 }],
      },
    },
  },
  /** VideoHelperSuite's, which files its result under `gifs` whatever it made. */
  VHS_VideoCombine: {
    display_name: 'Video Combine 🎥🅥🅗🅢',
    output: [],
    output_node: true,
    input: {
      required: {
        images: ['IMAGE'],
        frame_rate: ['FLOAT', { default: 8, min: 1, max: 120, step: 1 }],
        loop_count: ['INT', { default: 0, min: 0, max: 100 }],
        filename_prefix: ['STRING', { default: 'AnimateDiff' }],
        format: [['image/gif', 'video/h264-mp4', 'video/webm']],
        pingpong: ['BOOLEAN', { default: false }],
        save_output: ['BOOLEAN', { default: true }],
      },
    },
  },

  /* -------------------------------------------------------------- */
  /* Audio                                                            */
  /* -------------------------------------------------------------- */

  EmptyLatentAudio: {
    display_name: 'Empty Latent Audio',
    output: ['LATENT'],
    input: {
      required: {
        // Seconds, not frames: the one number that decides what you get, and
        // most of the time spent making it.
        seconds: ['FLOAT', { default: 47.6, min: 1, max: 1000, step: 0.1 }],
        batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
      },
    },
  },
  VAEDecodeAudio: {
    display_name: 'VAE Decode (Audio)',
    output: ['AUDIO'],
    input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
  },
  /** Core ComfyUI's own audio saver: files its result under `audio`, as flac. */
  SaveAudio: {
    display_name: 'Save Audio (FLAC)',
    output: [],
    output_node: true,
    input: {
      required: { audio: ['AUDIO'], filename_prefix: ['STRING', { default: 'audio/ComfyUI' }] },
    },
  },
  SaveAudioMP3: {
    display_name: 'Save Audio (MP3)',
    output: [],
    output_node: true,
    input: {
      required: {
        audio: ['AUDIO'],
        filename_prefix: ['STRING', { default: 'audio/ComfyUI' }],
        quality: [['V0', '128k', '320k'], { default: 'V0' }],
      },
    },
  },

  EmptyLatentByAspectRatio: {
    display_name: 'Empty Latent (Aspect Ratio)',
    output: ['LATENT', 'INT', 'INT'],
    input: {
      required: {
        aspect_ratio: [ASPECT_RATIOS, { default: '1:1' }],
        megapixels: ['FLOAT', { default: 1.0, min: 0.01, max: 64.0, step: 0.01 }],
        divisible_by: [[8, 16, 32, 64], { default: 8 }],
        batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
      },
      optional: {
        latent_format: [
          ['SD1.5 / SDXL (4 channels)', 'SD3 / Flux (16 channels)', 'Krea 2 (16 channels)'],
          { default: 'SD1.5 / SDXL (4 channels)' },
        ],
        /*
         * The size can come from a connected picture instead of the widgets.
         *
         * Appended after `latent_format` rather than put beside `aspect_ratio`,
         * for the same positional reason as every other switch in this pack —
         * and the order is what the parity test against the real node checks.
         */
        from_image: [['off', 'aspect ratio', 'resolution'], { default: 'off' }],
        image: ['IMAGE'],
      },
    },
  },
};
