# comfyllama

llama.cpp nodes for ComfyUI — run GGUF language and vision models directly in
your graph. Write or rewrite prompts with a local LLM, caption images with a
multimodal model, and force structured JSON output, all without an external API.

Models can run **in the ComfyUI process** (via `llama-cpp-python`) or on a
**running `llama-server`** reached over HTTP. Both sets of nodes share the same
sampler, grammar and chat-history types, so you can swap between them without
rebuilding the graph.

## Nodes

### In-process (needs `llama-cpp-python`)

| Node | What it does |
| --- | --- |
| **Load LLM (llama.cpp)** | Loads a GGUF text model. GPU offload, context size, threads, chat template. |
| **Load Vision LLM (llama.cpp)** | Loads a GGUF model plus its `mmproj` projector (LLaVA, MiniCPM-V, moondream, …). |
| **Chat (llama.cpp)** | System prompt, user prompt, a thinking switch and an optional image. Returns `text`, `thinking` and the updated history. |
| **Text Completion (llama.cpp)** | Raw completion, no chat template and no system prompt. |
| **Vision Chat (llama.cpp)** | The same as Chat, with the image required rather than optional. |
| **Sampler Settings (llama.cpp)** | top_k, min_p, typical_p, repetition/presence/frequency penalties, Mirostat, stop sequences — each switched on individually. |
| **Grammar / JSON Output (llama.cpp)** | Constrains output to JSON, a JSON schema, or a custom GBNF grammar. |
| **Chat Message (llama.cpp)** | Builds a conversation for multi-turn chats or few-shot prompting. |
| **Messages to Text (llama.cpp)** | Renders a conversation as plain text. |
| **Prompt Template (llama.cpp)** | Fills `{a} {b} {c} {d}` placeholders from connected strings. |
| **Token Count (llama.cpp)** | Counts tokens with the model's own tokenizer. |
| **Preview Text (llama.cpp)** | Shows the generated text on the node and passes it through. |
| **Unload LLM (llama.cpp)** | Frees the model so the VRAM goes back to your diffusion models. |

### Remote (needs only a running `llama-server`)

| Node | What it does |
| --- | --- |
| **Connect to llama-server** | URL, timeout, default model and authentication (bearer token or user/password). Probes the endpoint so a wrong URL fails immediately, while tolerating router front ends. |
| **Chat (llama-server)** | System prompt, user prompt, a thinking switch and an optional image, via `/v1/chat/completions`. Returns `text`, `thinking` and the updated history. |
| **Chat with Prompt Presets (llama-server)** | Several system prompts in one node, each with its own model, plus a switch between running one and passing the prompt straight through. Takes an image too. |
| **Vision Chat (llama-server)** | The same as Chat, with the image required rather than optional. |
| **Text Completion (llama-server)** | Raw completion via the native `/completion` endpoint, with prompt-cache reuse. |
| **Token Count (llama-server)** | Counts tokens via `/tokenize`. |
| **Server Info (llama-server)** | Model name, context size and available models as JSON. |

### General purpose

These have nothing to do with llama.cpp and work on their own.

| Node | What it does |
| --- | --- |
| **Empty Latent (Aspect Ratio + Megapixels)** | An empty latent sized by picking a ratio and a megapixel budget instead of typing width and height, or by borrowing either from a connected picture. Handles SD1.5/SDXL, SD3/Flux and Krea 2 latents. |
| **Load Image (Folder Browser)** | An image input with a file browser behind it: subfolders, thumbnails, a search box and sorting, over the folders the server allows. See [Browsing folders](#browsing-folders). |
| **MiniMax H3 Reference Picker** | Fifteen reference slots — nine pictures, three videos, three audio — each picked with the folder browser, each on its own output, for wiring into the stock MiniMax H3 node. See [Picking reference material](#picking-reference-material). |
| **MiniMax H3 Reference to Video (Slots)** | The stock reference-to-video node with a fixed, switchable slot per reference instead of autogrow inputs — so it can be driven over the API — and tag names so the prompt need not hard-code reference numbers. See [MiniMax H3 references](#minimax-h3-references). |

## Browsing folders

Stock `LoadImage` offers a combo of everything in ComfyUI's **input** directory.
That stops being usable at a few thousand files, and it cannot see the **output**
directory at all — so feeding a finished render back in means finding it in a
file manager and copying it across first.

**Load Image (Folder Browser)** replaces the combo with a `Browse…` button
(double-clicking the node opens the same dialog). Inside: the folders the server
allows, their subfolders, a thumbnail grid, a search box, sorting by date, name
or size, and an *Include subfolders* switch for when you know the filename but
not where it ended up. It outputs `image`, `mask` and `name` — the filename
without its extension, ready for a `filename_prefix`.

In **Latent** the same browser appears wherever this node's `image` field is
shown, reading through Latent's own `/api/browse/*` proxy so it can only ever
offer what this node will agree to load.

The dialog's **Clear** button empties the slot. A picture, once chosen, had no
way back out — the widget holds a path and every path is a picture — and this is
where you already are when you want it gone or different.

### Which folders it may read

By default: ComfyUI's own `output`, `input` and `temp` directories. To add more,
set `COMFYLLAMA_IMAGE_ROOTS` before starting ComfyUI — the same
`PATH`-style separator your platform uses (`:` on Linux and macOS, `;` on
Windows):

```bash
COMFYLLAMA_IMAGE_ROOTS=/mnt/photos:/mnt/renders/archive python main.py
```

Folders that do not exist are dropped rather than offered. Two folders with the
same basename both appear, the second suffixed `(2)`, so neither shadows the
other.

**This deliberately is not a widget on the node.** The browser's routes serve
whatever they are allowed to open to anyone who can reach the ComfyUI server. If
the node's own text field decided, then "which folders may be read" would be a
value inside a workflow — editable by anyone who can post a graph, and
travelling inside every shared `.json`. An environment variable is part of how
the server was *started*, which is the same place its bind address and its
`--listen` flag live.

Every path is resolved through one function that checks the named root, fully
resolves the result, and then re-checks containment with `os.path.commonpath`
rather than a string prefix. `..` cannot climb out, an absolute path cannot
replace the root, a symlink pointing outside is refused, and `/renders-private`
is not inside `/renders`. Recursive listings do not follow symlinks, so a link
back up the tree cannot make the walk loop.

## MiniMax H3 references

`MiniMaxH3ReferenceToVideo` takes its references through **autogrow** inputs —
slots that appear as you connect things. That is pleasant in the graph editor
and unreachable from anywhere else: an autogrow group cannot be expressed in an
API-format prompt. Sent nested it is accepted and **silently ignored**; sent
flat it raises `TypeError: execute() got an unexpected keyword argument`. The
upstream issue asking for it to work ([#15667](https://github.com/Comfy-Org/ComfyUI/issues/15667))
was closed as not planned.

Latent submits API-format prompts. So driving the stock node from a phone
produces a video that ignores every reference and says nothing about it — the
reporter of that issue proved it with four bit-identical runs, one of them with
the reference nodes deleted entirely.

This node is the same node with its references arriving through ordinary fixed
inputs: nine picture slots, three video slots each with a soundtrack, three
audio slots, every one with a switch. It does not reimplement any conditioning —
it packs the switched-on slots into the dictionaries upstream's `execute` wants
and calls it, so the sizing, the VAE encoding and the tokenizer presentation
stay upstream where they are maintained.

### Tags, and why the numbers are not yours to type

H3 refers to references by ordinal, inside the prompt: `<Picture 1>`,
`<Video 1>`, `<Audio 2>`. The ordinals come from presentation order, not from
which slot something is plugged into. **Switch one reference off and every later
number shifts.** A prompt reading "the woman in `<Picture 3>` wears the jacket
from `<Picture 4>`" keeps running after you disable `<Picture 1>`; it just
quietly describes two different pictures.

So give the slot a tag and let the node do the arithmetic:

| Slot | Tag | Prompt you write | What is sent |
| --- | --- | --- | --- |
| picture 1 | `woman` | `@woman walks past @jacket` | `<Picture 1> walks past <Picture 2>` |
| picture 4 | `jacket` | | |

Switch picture 1 off and the same prompt sends `<Picture 1>` for the jacket,
because that is what it became. Tags are matched case-insensitively, a `@` typed
into the tag field is ignored, and `<Picture 2>` written by hand is left alone.
A `@tag` no switched-on slot answers to is refused before the queue rather than
reaching the model as the literal text `@tag`.

Two orderings are worth knowing, both reproduced from upstream exactly:

- references are presented as **all pictures, then videos, then standalone
  audio**, whatever order the slots are in;
- a reference video's soundtrack takes an `<Audio j>` number **before** the
  standalone audio slots. One video-with-sound plus one standalone clip makes
  the soundtrack `<Audio 1>` and the standalone `<Audio 2>`. Reach a soundtrack
  in the prompt as `@tag-audio`.

### The switches are lazy

A slot that is switched off is never evaluated — its picture is not loaded, its
video is not decoded or resized. Switching a reference off makes the run
shorter, not just the prompt shorter.

## Picking reference material

The stock **MiniMax H3 Reference to Video** takes up to nine pictures, three
videos with their soundtracks and three standalone audio clips. Feeding it by
hand means a loader node per reference — fifteen nodes trailing wires across the
canvas before you reach any of the interesting settings.

**MiniMax H3 Reference Picker** is one node holding all of them. Each slot has a
`Browse <slot>…` button over the folders this server allows, filtered to what
that slot can use — pictures for picture slots, clips for video slots, sound for
audio slots. Each slot has an output. Wire the ones you filled into the stock
node's reference sockets and leave the rest alone.

It does not condition anything and it does not replace the stock node: it loads
files and hands them over, which is the whole job.

### Which node to wire it into

Both, depending on where the workflow is going to be *run*, and the difference
is not cosmetic:

- **Running it in ComfyUI** — wire the picker into the stock
  **MiniMax H3 Reference to Video**. Its autogrow sockets are pleasant in the
  editor, and in the editor they work.
- **Running it from Latent, or anything else driving the API** — wire the picker
  into **MiniMax H3 Reference to Video (Slots)** instead. The stock node's
  autogrow inputs cannot be expressed in an API-format prompt at all: sent
  nested they are accepted and silently ignored, so you get a video that used
  none of your references and no error saying so. See
  [MiniMax H3 references](#minimax-h3-references) for the whole story.

So the picker and the Slots node are two halves of the same path rather than two
ways of doing one thing — one gets the material in, the other is what lets the
graph be submitted from a phone.

**An empty slot outputs nothing at all.** Literally `None`, which the stock node
skips — so you can clear a slot without unwiring it, and without disturbing the
references you already connected. That is also why there is an output per slot
rather than one list: the order into an autogrow socket is fixed by the wire, so
a slot that empties has to leave a hole the far end knows to drop.

Every video slot also gives you its **own soundtrack** on a separate output,
because the stock node pairs a soundtrack to its video by slot number and a
reference clip that came with sound usually wants it. A silent clip gives
nothing there rather than failing.

Videos are resampled to `video_fps` (24, what H3 expects) and trimmed to
`video_seconds`. Decoding is PyAV for both video and audio — the same library
ComfyUI's own loaders use, rather than a second decoder with its own opinions
about frame rates and sample formats.

## Reporting the GPU's power draw

One route, `GET /comfyllama/power`, and no node at all:

```json
{ "gpus": [{ "watts": 412.5, "limit": 450.0 }], "source": "nvml" }
```

It exists because utilisation does not answer the question people ask of it.
"GPU at 100%" means the scheduler had work resident every sampling interval,
which a kernel waiting on memory satisfies exactly as well as one doing
arithmetic — so a bandwidth-bound run and a compute-bound one read the same, and
the number that separates them is the power. A 450 W card pulling 160 W at "full
utilisation" is waiting for VRAM; the same card pulling 430 W is working.
Latent's monitor draws it against the limit for exactly that reason.

**Read here rather than by whatever is asking**, because this is the process on
the machine with the GPU in it. Latent is routinely somewhere else — a NAS at
home talking to a rented box — and `nvidia-smi` run there would report the wrong
card, or none, with no way to tell which had happened. Same reasoning as the
folder browser: the far machine is the one that knows.

Two ways of asking, in order of preference:

- **NVML**, through `pynvml`, which torch's CUDA builds already depend on. A
  library call against a handle we keep, so it costs microseconds.
- **`nvidia-smi`**, as a subprocess, for an install where the bindings are
  missing but the driver is not. Tens of milliseconds, which is why it is second
  and why the answer is cached for a second either way.

Anything else — Apple silicon, ROCm, a CPU-only box — reports nothing, and stops
being asked after the first attempt. An absent reading is a fact the caller can
state; a zero is a lie it would draw.

## Install

Clone into `ComfyUI/custom_nodes/`:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/alexrutz/comfyllama.git
```

The **llama-server nodes work right away** — they only use the standard library.
The in-process nodes additionally need `llama-cpp-python` **in the same Python
environment ComfyUI runs in**; pick the build that matches your hardware:

```bash
# CPU
pip install llama-cpp-python

# NVIDIA / CUDA 12.4 (prebuilt wheels)
pip install llama-cpp-python \
  --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124

# Apple Silicon / Metal
CMAKE_ARGS="-DGGML_METAL=on" pip install llama-cpp-python
```

On the Windows portable build, prefix the command with the bundled interpreter:

```bat
python_embeded\python.exe -m pip install llama-cpp-python
```

Restart ComfyUI afterwards. If the binding is missing, the nodes still load and
tell you exactly what to install when you run them.

## Sampling

`max_tokens`, `temperature`, `top_p` and `seed` sit on the generation nodes and
are always sent. Everything else lives on the **Sampler Settings** node, where
each setting has its own switch:

- **Switch off** (the default): the parameter is left out of the request
  entirely, so whatever the model, llama-cpp-python or your `llama-server`
  command line sets stays in effect. Disabled rows are greyed out on the node.
- **Switch on**: the value next to it is sent.

So a Sampler Settings node with only `use_repeat_penalty` on changes the
repetition penalty and nothing else — it will not quietly pin `top_k` or
`min_p` to this node's defaults. With every switch off it behaves exactly like
not connecting the node at all. `mirostat_tau` and `mirostat_eta` are
meaningless without the mode, so those three share one switch.

`temperature` and `top_p` are on this node as well, on switches of their own.
They override the generation node's when switched on, which is what lets one
slider reach all three of them.

### One slider for temperature, top_p and top_k

Those three say roughly the same thing in three different units — how much room
the sampler has — and they are almost always moved together and in the same
direction. Doing that by hand is three edits and remembering which way each one
points, which is why in practice they get left where they are.

Turn on **`use_intensity`** and one `intensity` slider sets all three. Each has
a range you define: `temperature_min`/`max`, `top_p_min`/`max`, `top_k_min`/
`max`. Intensity 0 is the low end of every range, 1 the high end, and the map
between them is linear, so 0.5 is the middle of each. The defaults run from a
model that will not surprise you to one that will:

| | 0 | 1 |
| --- | --- | --- |
| `temperature` | 0.1 | 1.4 |
| `top_p` | 0.5 | 1.0 |
| `top_k` | 10 | 100 |

Putting the larger number in `min` is allowed, and runs that parameter against
the slider — the way to say "this one goes the other way" without doing the
arithmetic yourself.

**Both halves are the same control.** Move the slider and the three fields
update to what is about to be sent. Type a value into one of the three and the
slider snaps to where that value sits in its range, and the other two follow it
there — typing a temperature is a statement about intensity. While the slider is
on it decides all three, so their individual switches are turned on for you and
greyed out; the value fields stay editable, because typing in one is the other
way of moving the slider.

The arithmetic lives in `comfyllama/scale.py` and is repeated in the web
extension so the node always shows what it is about to send. The node computes
it again when it runs, which means the slider means the same thing in a front
end that submits an API-format workflow and never loads the extension —
[Latent](https://github.com/alexrutz/Latent) among them.

Like `use_image`, the slider and its six bounds are appended after the existing
widgets rather than slotted in where they read best: ComfyUI stores widget
values positionally, so anything inserted above an existing widget shifts every
value after it in a workflow that has already been saved.

## Prompt presets in one node

**Chat with Prompt Presets** holds up to six system prompts and switches
between them with the `active` dropdown:

- `slot_count` sets how many presets the node offers; the rest are hidden.
- Each preset has a **name** — which is what the `active` dropdown lists — and
  its **system prompt**. Rename them to whatever the presets do
  ("Enhance", "Translate", "Negative prompt").
- **`use_model`** is the switch between running a preset and handing the prompt
  straight to the output. Off, the model is not contacted at all: the server
  input is lazy, so nothing on the LLM side of the graph runs — not the
  connection, not the active preset's extra prompt, not the image. The `active`
  dropdown greys out, since there is nothing to pick.

  This used to be a `passthrough` entry at the top of that dropdown, which meant
  turning the model off was a matter of opening a list of six system prompts and
  choosing the one item in it that is not one. The dropdown holds presets only
  now. It still *understands* a stored `passthrough` — that is how a workflow
  saved before the switch existed keeps meaning what it meant, and it opens with
  the switch off.
- Each preset has its own **`model_N`** field, so different presets can run on
  different models when llama-server is in router mode. Empty falls back to the
  connect node.
- Each preset has its own optional **`extra_N`** input, appended to the incoming
  prompt with `extra_separator` (default a blank line) — for system prompts that
  expect two instructions you would rather keep in separate boxes. Only the
  active preset's extra input is read, and because those inputs are lazy too,
  the nodes feeding an inactive one never execute. The node labels them
  `extra_N (inactive)` so it is clear which one is live.
- Outputs are `text`, `thinking` and `active` (the preset that ran, or
  `passthrough` when the switch is off), so the rest of the graph can tell what
  happened.

Every per-slot field is an **optional** input. Hidden widgets do not survive
ComfyUI's *export (API)*, so a required one would make an exported workflow
fail validation with "Required input is missing (model_5)" before it ever
reached the server. Anything absent from an API payload simply falls back:
a missing name to `Preset N`, a missing model to the connect node and then to
whatever the server reports.

## Empty latent by aspect ratio

Pick a ratio (`1:1` and `2:3` lead the list) and a megapixel budget instead of
typing pixel dimensions. 1.0 MP means 1024x1024, so `2:3` at 1.0 MP gives
840x1256 (832x1280 with `divisible_by` set to 64). Both edges are rounded to
`divisible_by` — 8 is the smallest a latent can express, 64 suits SDXL — which
is why the area lands near, not exactly on, the requested megapixels. The node
also outputs the resulting `width` and `height`.

`latent_format` sets the shape of the latent:

| Format | Latent |
| --- | --- |
| `SD1.5 / SDXL (4 channels)` | 4 channels, 1/8 scale |
| `SD3 / Flux (16 channels)` | 16 channels, 1/8 scale |
| `Krea 2 (16 channels)` | 16 channels, 1/8 scale, edges kept on a 16 px grid |

Krea 2 decodes through the Qwen-Image autoencoder — 16 channels at f8, the same
tensor shape ComfyUI's own Krea 2 workflow builds with `EmptySD3LatentImage` —
and its transformer patchifies that latent in 2x2 blocks, so the Krea 2 entry
raises the rounding to 16 px even when `divisible_by` is 8. A coarser
`divisible_by` still wins. Krea 2 is documented as covering 1K to 2K, i.e.
`megapixels` between 1.0 and 2.0; at 1.0 the presets come out as 1024x1024
(1:1), 832x1248 (2:3) and 1360x768 (16:9).

### Taking the size from a picture

Connect an **`image`** and set **`from_image`**, and the size comes from that
picture instead of from the widgets:

| `from_image` | What the picture decides |
| --- | --- |
| `off` | Nothing. The widgets decide, as they always have. This is the default, and a connected picture is ignored. |
| `aspect ratio` | The shape only. `megapixels` still decides how big — so a 3024x4032 phone photo at 1.0 MP gives 880x1176, the same proportions at the size the model wants. |
| `resolution` | The size itself. The picture's own width and height, and `megapixels` is not consulted at all. |

Both modes round to the same grid as everything else here, so an odd source —
1023 px — lands on `divisible_by`, or on the coarser grid the latent format
needs. The node's `width` and `height` outputs report what it actually made.

The shape is the picture's **own** proportions, not the nearest of the thirteen
labels. A 2778x1284 screenshot is none of them, and snapping it to `2:1` would
be a crop nobody asked for.

`image` is a **lazy** input: with `from_image` off, nothing upstream of it runs
at all — no loader, no decode, no resize. Set a mode with nothing connected and
the node says so rather than guessing.

## Images

Every chat node takes an optional **`image`** input — in-process, remote and the
preset node alike. Connect one and the turn is sent as an OpenAI-style content
list (images first, prompt last) instead of plain text; leave it unconnected and
nothing about the request changes. A whole `IMAGE` batch is sent as several
parts, so you can ask a model to compare frames.

`image_max_size` scales the longest edge before upload (0 disables it) and
`image_quality` picks JPEG quality, or lossless PNG at 100.

### Turning the picture off, and taking it out

A graph is a fixed set of links, so "the same workflow, this time without a
picture" used to mean dragging the link off and dragging it back on later. Two
things replace that:

- **`use_image`** ignores whatever is wired to `image` and sends a text-only
  prompt. Because `image` is a lazy input, the nodes feeding it are not executed
  at all — the picture is not loaded, decoded or resized, so switching it off
  costs nothing rather than costing all of that and then discarding the result.
  It is on by default, and the two encoding controls grey out while it is off.
- **`✕ clear image`** is a button on the node that disconnects the link, for
  when you want it gone rather than paused. It reads `no image connected` while
  there is nothing to clear.

A connected image that is switched off is labelled `image (off)` on the input,
so a live-looking link that goes nowhere says so.

The switch is deliberately the *last* widget on the node, below the two controls
it governs. ComfyUI stores widget values as a positional list, so a widget
inserted above them would shift every value after it in an already-saved
workflow — a size silently becoming a quality. Appended, an older workflow has
no value for it and takes the default, which is the behaviour it already had.

What has to match is the model:

- **In-process**: load it with **Load Vision LLM (llama.cpp)** so a projector is
  attached. Connecting an image to a model loaded by the plain loader fails with
  a message saying so rather than sending something the model cannot read.
- **llama-server**: start it with `--mmproj`, or point the node at a multimodal
  model in router mode. The server reports the error if it cannot see.

The two **Vision Chat** nodes are now just these nodes with the image required,
kept because existing workflows use them — they have the clear button but no
switch, since an image is what they are for. On the preset node the image is
lazy like everything else, so neither `passthrough` nor a switched-off image
runs the branch that produces one.

## Prompts and reasoning models

All four chat nodes (in-process and remote) take a **`system`** prompt above the
`prompt` field; leave it empty to send no system message. The two Text
Completion nodes deliberately have none — they send the prompt verbatim with no
chat template, so there are no roles to put a system message in. Use a Chat node
if you want one. Every widget can also be driven from another node: drag a
connection onto it, or right-click the node → *Convert widget to input* on older
frontends.

Chat nodes have a **`thinking`** switch and a separate **`thinking`** output:

| | |
| --- | --- |
| `auto` | Sends nothing — the model's own default applies. |
| `on` / `off` | Requests thinking explicitly. Remote: sent as `chat_template_kwargs {"enable_thinking": …}`, which is what Qwen3-style templates read. In-process: appended to the prompt as `/think` or `/no_think`, because llama-cpp-python renders the GGUF's template without forwarding arguments. Models whose template ignores the switch keep their default. |

The chain of thought is always separated, whatever the switch is set to:

- `text` — the answer with the reasoning removed.
- `thinking` — the reasoning, from the server's `reasoning_content` field when
  llama-server runs with `--reasoning-format deepseek`, otherwise parsed out of
  `<think>` tags. Blocks the template opened itself and blocks cut off by
  `max_tokens` are both handled.
- `messages` — the history carries the answer only, so the reasoning is not fed
  back into the next turn.

To turn thinking off server-side regardless of the request, start llama-server
with `--reasoning-budget 0`.

## Using a running llama-server

Start the server yourself and point the **Connect to llama-server** node at it:

```bash
llama-server -m model.gguf --host 127.0.0.1 --port 8080 -ngl 99
# multimodal:
llama-server -m llava.gguf --mmproj mmproj.gguf --host 127.0.0.1 --port 8080
```

Worth doing when you want the LLM to stay loaded between runs, need it on
another machine, want several ComfyUI instances (or other tools) to share one
model, or simply want the model out of ComfyUI's process. The nodes speak both
the OpenAI-compatible `/v1/chat/completions` API and llama.cpp's native
`/completion`, so llama.cpp's samplers, GBNF grammars and JSON schemas all work.

Notes:

- The URL may include a trailing `/v1` — it is stripped.
- Requests to `localhost`/`127.0.0.1` deliberately bypass any `HTTP_PROXY` set
  in the environment.
- `timeout` is per request; raise it for long generations on slow hardware.
- Cancelling in ComfyUI aborts the stream immediately.

### Choosing a model (router mode)

`model` on the connect node is the default for everything using that
connection, and **every generation node has its own `model` field that
overrides it** — including one per preset on the prompt-preset node, so a
router can serve a small model for one preset and a large one for another.

Resolution order is: the node's `model` → the connect node's `model` →
whatever the server reports. `auto` (or an empty field) means *ask the server*:
it takes the first model `/v1/models` lists, so a single-model llama-server
needs no configuration and a router still gets a model name to dispatch on.
Only a server that reports no models at all leaves the field out of the
request.

Every one of these nodes has a **`⟳ fetch models`** button. It polls the
endpoint — reusing the URL and credentials from the connect node it is wired
to — and shows what is actually being served; picking an entry writes it into
that node's `model` field, and `auto` is offered as the way back. Asking for a
model the server does not have produces an error that names the alternatives.

The model list is fetched at most once per connection during a run, and never
per request.

A router in front of llama-server usually implements only the
OpenAI-compatible routes, so `/health` may be missing and `/props`,
`/tokenize` and the native `/completion` endpoint may not exist. The connect
node copes: it falls back to `/v1/models` when `/health` is unavailable, and a
server that reports "still loading" is a console warning rather than a failed
graph — routers load models on demand. It still fails on a URL that cannot be
reached, on rejected credentials, and on an endpoint where neither `/health`
nor `/v1/models` answers. **Server Info** works without `/props`; **Token
Count (llama-server)** and **Text Completion (llama-server)** need the native
endpoints, so use the chat nodes if your router does not proxy them.

### Authentication

The connect node speaks two schemes, chosen with the `auth` widget:

| `auth` | Header sent |
| --- | --- |
| `auto` (default) | Basic when `username` is filled in, Bearer when only `api_key` is, nothing when neither. |
| `bearer` | `Authorization: Bearer <api_key>` — for llama-server started with `--api-key`. |
| `basic` | `Authorization: Basic <base64 user:password>` — for an nginx/Caddy/Traefik reverse proxy in front of llama-server. |
| `none` | Never sends credentials, even with the fields filled in. |

Forcing `bearer` or `basic` without its field filled in fails with a clear
error instead of silently sending an unauthenticated request. Credentials may
also be written straight into the URL (`http://user:pass@host:8080`); they are
stripped from the URL and used as basic auth. A 401/403 reply says whether
credentials were rejected or never sent.

**Keeping secrets out of the workflow file:** widget values are saved into
workflow JSON in plain text, and that JSON travels with shared graphs and gets
embedded in generated PNGs. All three credential fields therefore accept an
`env:NAME` indirection that reads the value from the environment ComfyUI runs
in:

```
api_key:  env:LLAMA_API_KEY
username: llama
password: env:LLAMA_PASSWORD
```

## Models

For the in-process nodes, put `.gguf` files into `ComfyUI/models/llm/`. The
folder is created on first start, and `models/LLM`, `models/gguf` and
`models/llama` are picked up too if you already use them. Multimodal projectors can live in `models/llm/` or
`models/mmproj/`. Both folder keys work in `extra_model_paths.yaml`:

```yaml
comfyui:
  base_path: /data/ComfyUI
  llm: models/llm
  mmproj: models/mmproj
```

Every loader also has a `model_path_override` field if you want to point at a
file somewhere else entirely.

Good starting points: any `*-instruct-*Q4_K_M.gguf` model in the 3–8B range for
text, and LLaVA 1.6 or MiniCPM-V 2.6 (model **plus** its `mmproj-*.gguf`) for
image captioning.

## Usage notes

- **VRAM.** Set `n_gpu_layers` to `-1` to offload everything, `0` for CPU only.
  Before a GPU load the pack unloads ComfyUI's diffusion models, so a text step
  in front of your image generation does not fight over VRAM. `keep_loaded`
  controls how many models stay resident; put an **Unload** node after the last
  node that uses the model to release it immediately.
- **Caching.** Re-running a graph reuses the loaded model as long as the loader
  settings do not change. A seed of `-1` re-runs generation every time; a fixed
  seed lets ComfyUI cache the result.
- **Cancelling.** Generation streams token by token, so the ComfyUI cancel
  button stops it right away and the progress bar tracks `max_tokens`.
- **Structured output.** Connect the **Grammar** node to force valid JSON, JSON
  matching a schema, or any GBNF grammar — handy for feeding parsed values into
  the rest of a workflow.
- **Chat templates.** Leave `chat_format` on `auto` unless the GGUF has no
  embedded template; then pick the matching one (`chatml`, `llama-3`, …).

Example graphs are in [`example_workflows/`](example_workflows) — drag a JSON
file onto the ComfyUI canvas.

## Tests

The suite stubs ComfyUI, so it runs anywhere:

```bash
python -m unittest discover -s tests -v
```

## License

MIT — see [LICENSE](LICENSE).
