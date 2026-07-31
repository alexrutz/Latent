import type { ApiWorkflow } from '../comfyTypes.js';

/** Stock SD1.5 text-to-image — the "default" ComfyUI graph, API format. */
export const sd15Txt2Img: ApiWorkflow = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 156680208700286,
      steps: 20,
      cfg: 8,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 512, height: 512, batch_size: 1 },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'beautiful scenery nature glass bottle landscape', clip: ['4', 1] },
    _meta: { title: 'CLIP Text Encode (Prompt)' },
  },
  '7': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'text, watermark', clip: ['4', 1] },
    _meta: { title: 'CLIP Text Encode (Prompt)' },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] },
  },
};

/** SDXL base + refiner: two samplers, so several fields share a label. */
export const sdxlBaseRefiner: ApiWorkflow = {
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
    _meta: { title: 'Base checkpoint' },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'a photograph of an astronaut riding a horse', clip: ['4', 1] },
  },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality', clip: ['4', 1] } },
  '10': {
    class_type: 'KSamplerAdvanced',
    inputs: {
      add_noise: 'enable',
      noise_seed: 721897303308196,
      steps: 25,
      cfg: 8,
      sampler_name: 'euler',
      scheduler: 'normal',
      start_at_step: 0,
      end_at_step: 20,
      return_with_leftover_noise: 'enable',
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
    _meta: { title: 'Base sampler' },
  },
  '12': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sd_xl_refiner_1.0.safetensors' },
    _meta: { title: 'Refiner checkpoint' },
  },
  '15': { class_type: 'CLIPTextEncode', inputs: { text: 'a photograph of an astronaut riding a horse', clip: ['12', 1] } },
  '16': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality', clip: ['12', 1] } },
  '11': {
    class_type: 'KSamplerAdvanced',
    inputs: {
      add_noise: 'disable',
      noise_seed: 0,
      steps: 25,
      cfg: 8,
      sampler_name: 'euler',
      scheduler: 'normal',
      start_at_step: 20,
      end_at_step: 10000,
      return_with_leftover_noise: 'disable',
      model: ['12', 0],
      positive: ['15', 0],
      negative: ['16', 0],
      latent_image: ['10', 0],
    },
    _meta: { title: 'Refiner sampler' },
  },
  '17': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['12', 2] } },
  '19': { class_type: 'SaveImage', inputs: { filename_prefix: 'SDXL', images: ['17', 0] } },
};

/** Image-to-image: has a LoadImage, so `capabilities.img2img` must be true. */
export const img2img: ApiWorkflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  '2': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
  },
  '3': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0], vae: ['2', 2] } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'oil painting, thick brush strokes', clip: ['2', 1] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'photo, realistic', clip: ['2', 1] } },
  '6': {
    class_type: 'KSampler',
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 7.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 0.65,
      model: ['2', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['3', 0],
    },
  },
  '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['2', 2] } },
  '8': { class_type: 'SaveImage', inputs: { filename_prefix: 'img2img', images: ['7', 0] } },
};

/** Model-based upscale of an existing image — no sampler, no prompt. */
export const upscale: ApiWorkflow = {
  '1': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  '2': { class_type: 'UpscaleModelLoader', inputs: { model_name: 'RealESRGAN_x4plus.pth' } },
  '3': {
    class_type: 'ImageUpscaleWithModel',
    inputs: { upscale_model: ['2', 0], image: ['1', 0] },
  },
  '4': { class_type: 'SaveImage', inputs: { filename_prefix: 'upscaled', images: ['3', 0] } },
};

/** Prompts routed through ConditioningCombine, so detection must walk backwards. */
export const combinedConditioning: ApiWorkflow = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a castle', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'at sunset', clip: ['1', 1] } },
  '4': { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['2', 0], conditioning_2: ['3', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'ugly', clip: ['1', 1] } },
  '6': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '7': {
    class_type: 'KSampler',
    inputs: {
      seed: 1,
      steps: 20,
      cfg: 8,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['1', 0],
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'combined', images: ['8', 0] } },
};

/** Custom nodes that are not in `/object_info` — must degrade, not explode. */
export const unknownCustomNodes: ApiWorkflow = {
  '1': {
    class_type: 'SuperSecretSamplerXL',
    inputs: {
      magic_strength: 0.75,
      iterations: 12,
      mode: 'turbo',
      enabled: true,
      seed: 99,
      model: ['2', 0],
    },
    _meta: { title: 'Secret Sampler' },
  },
  '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'dreamshaperXL_v21.safetensors' } },
  '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'custom', images: ['1', 0] } },
};

/**
 * A graph that reports as well as renders.
 *
 * "Preview as text" nodes are how a workflow tells you what it decided — the
 * prompt after a wildcard expanded, a caption a vision model wrote. They produce
 * an output with no images in it, which is exactly the case a client that only
 * looks for pictures gets wrong.
 */
export const withTextPreview: ApiWorkflow = {
  ...sd15Txt2Img,
  '10': {
    class_type: 'PreviewAny',
    inputs: { source: ['3', 0] },
    _meta: { title: 'What ran' },
  },
};

/** The wrong export format — used to test the error message. */
export const uiFormatWorkflow = {
  last_node_id: 9,
  last_link_id: 9,
  nodes: [{ id: 3, type: 'KSampler', pos: [863, 186] }],
  links: [[1, 4, 0, 3, 0, 'MODEL']],
  version: 0.4,
};

export const workflowFixtures = {
  sd15Txt2Img,
  sdxlBaseRefiner,
  img2img,
  upscale,
  combinedConditioning,
  unknownCustomNodes,
  withTextPreview,
};
