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
  LlamaServerChat: {
    display_name: 'Chat (llama-server)',
    output: ['STRING', 'STRING', 'LLAMA_MESSAGES'],
    input: {
      required: {
        server: ['LLAMA_SERVER'],
        system: ['STRING', { default: 'You are a helpful assistant.', multiline: true }],
        prompt: ['STRING', { default: '', multiline: true, dynamicPrompts: true }],
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
        name_1: ['STRING', { default: 'Preset 1' }],
        system_1: ['STRING', { default: '', multiline: true }],
        name_2: ['STRING', { default: 'Preset 2' }],
        system_2: ['STRING', { default: '', multiline: true }],
        name_3: ['STRING', { default: 'Preset 3' }],
        system_3: ['STRING', { default: '', multiline: true }],
        name_4: ['STRING', { default: 'Preset 4' }],
        system_4: ['STRING', { default: '', multiline: true }],
        name_5: ['STRING', { default: 'Preset 5' }],
        system_5: ['STRING', { default: '', multiline: true }],
        name_6: ['STRING', { default: 'Preset 6' }],
        system_6: ['STRING', { default: '', multiline: true }],
      },
      optional: {
        extra_separator: ['STRING', { default: '\\n\\n' }],
      },
    },
  },
  /**
   * An empty latent sized by ratio rather than by width and height.
   *
   * `divisible_by` is the numeric combo in the suite: its choices arrive as
   * numbers, and the node compares against numbers.
   */
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
          ['SD1.5 / SDXL (4 channels)', 'SD3 / Flux (16 channels)'],
          { default: 'SD1.5 / SDXL (4 channels)' },
        ],
      },
    },
  },
};
