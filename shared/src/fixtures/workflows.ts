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

/**
 * A workflow that names its nodes by the convention.
 *
 * `Prompt` is the description of the picture and `Lora Input` is the field that
 * holds `<lora:…>` tags — stated outright rather than left to be inferred from
 * class names and wiring, which is what the convention is for.
 */
export const sd15WithLoraInput = {
  ...sd15Txt2Img,
  '6': {
    ...sd15Txt2Img['6'],
    _meta: { title: 'Prompt' },
  },
  '11': {
    class_type: 'CLIPTextEncode',
    inputs: {
      text: '<lora:pixel_art_xl.safetensors:0.8>',
      clip: ['4', 1],
    },
    _meta: { title: 'Lora Input' },
  },
};

/**
 * A workflow that asks a `llama-server` for something on the way through.
 *
 * The [comfyllama](https://github.com/alexrutz/comfyllama) nodes hold the
 * server's address as a widget, which is what Latent fills in from the
 * connection it is already using for the chat.
 */
export const withLlamaServer: ApiWorkflow = {
  ...sd15Txt2Img,
  '20': {
    class_type: 'LlamaServerConnect',
    inputs: {
      base_url: 'http://127.0.0.1:8080',
      timeout: 300,
      check_connection: true,
      model: 'auto',
      auth: 'auto',
      api_key: '',
      username: '',
      password: '',
    },
    _meta: { title: 'Connect to llama-server' },
  },
  '21': {
    class_type: 'LlamaServerChat',
    inputs: {
      server: ['20', 0],
      system: 'Rewrite the prompt.',
      prompt: 'a lighthouse',
    },
    _meta: { title: 'Rewrite' },
  },
};

/**
 * The two nodes comfyllama grew most recently, in one graph.
 *
 * The preset-chat node with its slots renamed and only three of six in use, and
 * the aspect-ratio latent whose `divisible_by` is a combo of numbers. Both are
 * cases where the form cannot be read off `/object_info` alone.
 */
export const withPresetChat: ApiWorkflow = {
  ...sd15Txt2Img,
  // Replaces the plain empty latent, so the picture's size comes from the ratio.
  '5': {
    class_type: 'EmptyLatentByAspectRatio',
    inputs: {
      aspect_ratio: '3:2',
      megapixels: 1,
      divisible_by: 64,
      batch_size: 1,
      latent_format: 'SD1.5 / SDXL (4 channels)',
    },
    _meta: { title: 'Empty Latent (Aspect Ratio)' },
  },
  '20': {
    class_type: 'LlamaServerConnect',
    inputs: {
      base_url: 'http://127.0.0.1:8080',
      timeout: 300,
      check_connection: true,
      model: 'auto',
      auth: 'auto',
      api_key: '',
      username: '',
      password: '',
    },
    _meta: { title: 'Connect to llama-server' },
  },
  '22': {
    class_type: 'LlamaServerPresetChat',
    inputs: {
      server: ['20', 0],
      prompt: 'a lighthouse',
      active: 'Rewrite',
      slot_count: 3,
      max_tokens: 512,
      seed: 0,
      name_1: 'Rewrite',
      model_1: '',
      system_1: 'Rewrite the idea as one vivid prompt.',
      name_2: 'Caption',
      model_2: '',
      system_2: 'Describe the picture in one sentence.',
      name_3: 'Preset 3',
      model_3: '',
      system_3: '',
      name_4: 'Preset 4',
      model_4: '',
      system_4: '',
      name_5: 'Preset 5',
      model_5: '',
      system_5: '',
      name_6: 'Preset 6',
      model_6: '',
      system_6: '',
      extra_separator: '\\n\\n',
      // Exported with nothing wired to `image`, which is how a text-only chat
      // node comes out of ComfyUI now that every one of them can take pictures.
      image_max_size: 1024,
      image_quality: 90,
      use_image: true,
      // Exported with the model on and a preset chosen, which is the ordinary
      // state; `active` says which one and the switch says whether to run it.
      use_model: true,
    },
    _meta: { title: 'Chat with Prompt Presets' },
  },
  /*
   * Advanced sampling, wired into the preset chat above.
   *
   * Exported with the intensity slider off, which is how the node comes out of
   * ComfyUI untouched: the three values are set one at a time, and the slider
   * and its six range bounds are inert. `idleSamplingControl` is what decides
   * which of the two halves the form shows.
   */
  '23': {
    class_type: 'LlamaCppSampling',
    inputs: {
      use_top_k: false,
      top_k: 40,
      use_min_p: false,
      min_p: 0.05,
      use_typical_p: false,
      typical_p: 1,
      use_repeat_penalty: false,
      repeat_penalty: 1.1,
      use_presence_penalty: false,
      presence_penalty: 0,
      use_frequency_penalty: false,
      frequency_penalty: 0,
      use_mirostat: false,
      mirostat_mode: 2,
      mirostat_tau: 5,
      mirostat_eta: 0.1,
      use_stop_sequences: false,
      stop_sequences: '',
      use_temperature: false,
      temperature: 0.7,
      use_top_p: false,
      top_p: 0.95,
      use_intensity: false,
      intensity: 0.5,
      temperature_min: 0.1,
      temperature_max: 1.4,
      top_p_min: 0.5,
      top_p_max: 1,
      top_k_min: 10,
      top_k_max: 100,
    },
    _meta: { title: 'Sampler Settings' },
  },
};

/**
 * Text-to-video on a quantised model, the way it is actually run.
 *
 * Modelled on the published LTX-2.5 graphs, with the weights swapped for the
 * GGUF repacks people load on one card — a `UnetLoaderGGUF` where a checkpoint
 * loader would be, a video latent with a frame count, a frame rate on the
 * conditioning, and a saver that writes a `.webm` rather than a picture.
 */
export const ltxVideoGguf: ApiWorkflow = {
  '1': {
    class_type: 'UnetLoaderGGUF',
    inputs: { unet_name: 'ltx-2.5-video-Q4_K_M.gguf' },
  },
  '2': {
    class_type: 'CLIPLoaderGGUF',
    inputs: { clip_name: 't5xxl_encoderonly-Q5_K_M.gguf', type: 'ltxv' },
  },
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'ltx-2.5-vae.safetensors' } },
  '4': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'a paper boat drifting down a rain gutter', clip: ['2', 0] },
    _meta: { title: 'CLIP Text Encode (Prompt)' },
  },
  '5': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'still, jitter, watermark', clip: ['2', 0] },
    _meta: { title: 'CLIP Text Encode (Negative)' },
  },
  '6': {
    class_type: 'EmptyLTXVLatentVideo',
    inputs: { width: 768, height: 512, length: 97, batch_size: 1 },
  },
  '7': {
    class_type: 'LTXVConditioning',
    inputs: { positive: ['4', 0], negative: ['5', 0], frame_rate: 25 },
  },
  '8': {
    class_type: 'KSampler',
    inputs: {
      seed: 4242,
      steps: 20,
      cfg: 3,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['1', 0],
      positive: ['7', 0],
      negative: ['7', 1],
      latent_image: ['6', 0],
    },
  },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
  '10': {
    class_type: 'SaveWEBM',
    inputs: { images: ['9', 0], filename_prefix: 'LTXV', codec: 'vp9', fps: 25, crf: 32 },
  },
};

/** The same thing ending in VideoHelperSuite's combiner, which reports `gifs`. */
export const videoCombine: ApiWorkflow = {
  ...ltxVideoGguf,
  '10': {
    class_type: 'VHS_VideoCombine',
    inputs: {
      images: ['9', 0],
      frame_rate: 8,
      loop_count: 0,
      filename_prefix: 'LTXV',
      format: 'image/gif',
      pingpong: false,
      save_output: true,
    },
  },
};

/**
 * A music workflow, of the shape the audio models actually ship with.
 *
 * MiniMax-Music3 and its neighbours are a checkpoint, a text encoder for the
 * style prompt, an empty audio latent whose one interesting number is a length
 * in *seconds*, a sampler, a decoder and a save node that writes flac. Nothing
 * about the middle differs from a picture graph — which is the point: the parts
 * that differ are the length in seconds and the file at the end.
 */
export const minimaxMusic: ApiWorkflow = {
  '1': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'minimax-music3-Q6_K.gguf' },
  },
  '2': {
    class_type: 'CLIPTextEncode',
    inputs: {
      text: 'slow shoegaze instrumental, tape hiss, distant guitars',
      clip: ['1', 1],
    },
    _meta: { title: 'CLIP Text Encode (Prompt)' },
  },
  '3': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'spoken word, applause', clip: ['1', 1] },
    _meta: { title: 'CLIP Text Encode (Negative)' },
  },
  '4': {
    class_type: 'EmptyLatentAudio',
    inputs: { seconds: 30, batch_size: 1 },
  },
  '5': {
    class_type: 'KSampler',
    inputs: {
      seed: 909,
      steps: 24,
      cfg: 4.5,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['1', 0],
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['4', 0],
    },
  },
  '6': { class_type: 'VAEDecodeAudio', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  '7': {
    class_type: 'SaveAudio',
    inputs: { audio: ['6', 0], filename_prefix: 'audio/Latent' },
  },
};

/** A speech workflow: the same shape, with words to say rather than a style. */
export const qwenSpeech: ApiWorkflow = {
  ...minimaxMusic,
  '2': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'Good evening. The harbour is closed until Thursday.', clip: ['1', 1] },
    _meta: { title: 'CLIP Text Encode (Prompt)' },
  },
  '7': {
    class_type: 'SaveAudioMP3',
    inputs: { audio: ['6', 0], filename_prefix: 'speech/Latent', quality: 'V0' },
  },
};

/**
 * An edit workflow that says which of its two pictures is the origin.
 *
 * Both are `LoadImage` nodes feeding the same sampler, and from the graph alone
 * there is no telling them apart — which is exactly why the titles carry a tag.
 * `[Reference]` is the picture being edited, the one a result is worth
 * comparing against; `[Context]` is the other kind, here a pose to follow.
 */
export const editWithReference: ApiWorkflow = {
  // Named out of `INPUT_IMAGES`, so this graph asks for a picture that is
  // actually in the input directory `/object_info` describes — which is what
  // lets the comparison have something to fetch.
  '1': {
    class_type: 'LoadImage',
    inputs: { image: 'example.png' },
    _meta: { title: 'Input Image [Reference]' },
  },
  '2': {
    class_type: 'LoadImage',
    inputs: { image: 'poses/standing.png' },
    _meta: { title: 'Input Image [Context]' },
  },
  '3': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
  },
  '4': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0], vae: ['3', 2] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'give him a red coat', clip: ['3', 1] } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['3', 1] } },
  '7': {
    class_type: 'KSampler',
    inputs: {
      seed: 7,
      steps: 24,
      cfg: 6,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 0.6,
      model: ['3', 0],
      positive: ['5', 0],
      negative: ['6', 0],
      latent_image: ['4', 0],
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'edit', images: ['8', 0] } },
};

export const workflowFixtures = {
  sd15Txt2Img,
  sdxlBaseRefiner,
  img2img,
  editWithReference,
  upscale,
  combinedConditioning,
  unknownCustomNodes,
  withTextPreview,
  withLlamaServer,
  withPresetChat,
  ltxVideoGguf,
  videoCombine,
  minimaxMusic,
  qwenSpeech,
};

/**
 * The same default graph as ComfyUI's own editor saves it.
 *
 * Not an "Export (API)" file: this is what actually sits in
 * `user/default/workflows`, with positional widget values, a link table, and a
 * seed that contributes two entries because of its "after generate" control.
 */
export const sd15Txt2ImgUi = {
  last_node_id: 9,
  last_link_id: 9,
  nodes: [
    {
      id: 4,
      type: 'CheckpointLoaderSimple',
      pos: [26, 474],
      mode: 0,
      inputs: [],
      outputs: [
        { name: 'MODEL', type: 'MODEL', links: [1] },
        { name: 'CLIP', type: 'CLIP', links: [3, 5] },
        { name: 'VAE', type: 'VAE', links: [8] },
      ],
      widgets_values: ['v1-5-pruned-emaonly.safetensors'],
    },
    {
      id: 6,
      type: 'CLIPTextEncode',
      title: 'CLIP Text Encode (Prompt)',
      pos: [415, 186],
      mode: 0,
      inputs: [{ name: 'clip', type: 'CLIP', link: 3 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4] }],
      widgets_values: ['beautiful scenery nature glass bottle landscape'],
    },
    {
      id: 7,
      type: 'CLIPTextEncode',
      title: 'CLIP Text Encode (Prompt)',
      pos: [413, 389],
      mode: 0,
      inputs: [{ name: 'clip', type: 'CLIP', link: 5 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6] }],
      widgets_values: ['text, watermark'],
    },
    {
      id: 5,
      type: 'EmptyLatentImage',
      pos: [473, 609],
      mode: 0,
      inputs: [],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [2] }],
      widgets_values: [512, 512, 1],
    },
    {
      id: 3,
      type: 'KSampler',
      pos: [863, 186],
      mode: 0,
      inputs: [
        { name: 'model', type: 'MODEL', link: 1 },
        { name: 'positive', type: 'CONDITIONING', link: 4 },
        { name: 'negative', type: 'CONDITIONING', link: 6 },
        { name: 'latent_image', type: 'LATENT', link: 2 },
      ],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }],
      // seed, its control, steps, cfg, sampler, scheduler, denoise.
      widgets_values: [156680208700286, 'randomize', 20, 8, 'euler', 'normal', 1],
    },
    {
      id: 8,
      type: 'VAEDecode',
      pos: [1209, 188],
      mode: 0,
      inputs: [
        { name: 'samples', type: 'LATENT', link: 7 },
        { name: 'vae', type: 'VAE', link: 8 },
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }],
      widgets_values: [],
    },
    {
      id: 9,
      type: 'SaveImage',
      pos: [1451, 189],
      mode: 0,
      inputs: [{ name: 'images', type: 'IMAGE', link: 9 }],
      outputs: [],
      widgets_values: ['ComfyUI'],
    },
  ],
  links: [
    [1, 4, 0, 3, 0, 'MODEL'],
    [2, 5, 0, 3, 3, 'LATENT'],
    [3, 4, 1, 6, 0, 'CLIP'],
    [4, 6, 0, 3, 1, 'CONDITIONING'],
    [5, 4, 1, 7, 0, 'CLIP'],
    [6, 7, 0, 3, 2, 'CONDITIONING'],
    [7, 3, 0, 8, 0, 'LATENT'],
    [8, 4, 2, 8, 1, 'VAE'],
    [9, 8, 0, 9, 0, 'IMAGE'],
  ],
  version: 0.4,
};
