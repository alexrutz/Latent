# Latent

A mobile-optimised frontend for an existing ComfyUI instance.

ComfyUI's own interface is a desktop node graph — you cannot comfortably pan it,
tap its widgets, or watch a render while your phone is in your pocket. But
*using* a workflow you already built is simple: type a prompt, nudge a few
numbers, tap generate, look at the picture.

Latent is that. You import a workflow once, and it becomes a clean, thumb-sized
form. Nothing about your ComfyUI setup changes.

<p align="center">
  <img src="docs/screenshots/generate.png" width="240" alt="The generate screen">
  <img src="docs/screenshots/progress.png" width="240" alt="Live progress">
  <img src="docs/screenshots/gallery.png" width="240" alt="The gallery">
</p>

## What it does

- **Any workflow you already have.** Import a ComfyUI *Export (API)* file and
  Latent reads the graph, works out which inputs are editable, and builds a form
  — prompt, seed, steps, CFG, sampler, dimensions, model pickers. Model and
  sampler lists come from your server, so they are always the files you actually
  have installed.
- **Remote instances, including vast.ai.** Save any number of connections and
  switch between them. Bearer or basic tokens, and self-signed certificates, are
  all handled — see [Connecting to vast.ai](#connecting-to-vastai).
- **Live progress, with numbers.** A persistent bar shows the live preview, the
  sampler's step rate and **how much longer it has to go**, follows you between
  tabs, and **stays on screen when the run finishes** so you actually see the
  picture you waited for. A tap opens the full timing breakdown without covering
  the app.
- **A queue you can actually manage.** Every waiting job lists the settings it
  was submitted with — including its seed — so you can tell eight variations of
  one prompt apart and cancel the one you regret. One switch expands them all
  for a side-by-side comparison.
- **Gallery.** Every result, with the exact settings that produced it. Pinch to
  zoom, swipe between a batch, save to your camera roll, re-run, or send a
  result straight to img2img or an upscale pass.
- **Ratings that outlive the GPU.** Rating an image copies it onto the machine
  running Latent — **encrypted**, so it survives the rented instance being
  destroyed without leaving your pictures readable on disk.
- **Favourites.** Keep an image together with the settings that made it, rate
  those separately, and generate more like it in one tap.
- **A grid that fits the pictures.** Adjustable column count; each tile takes its
  shape from the image's aspect ratio so nothing is cropped square, with a
  per-image override. Only thumbnails are ever downloaded.
- **Import an existing output folder.** Point Latent at a ComfyUI output
  directory and pull in whatever is worth keeping, through the same rating
  system.
- **LoRA editor.** `<lora:name:0.8>` tags become compact rows with a strength
  slider and a picker, instead of something you type by hand on a phone keyboard.
- **Parameter presets.** Save a whole set of settings per workflow and re-apply
  it in one tap.
- **Saveable form layouts.** Arrange a workflow's form once — what shows, what
  it's called, what goes under Advanced — save it under a name, and switch
  between arrangements later.
- **Prompt blocks.** Save the phrases you reuse and assemble a prompt by tapping
  chips instead of typing paragraphs on a phone keyboard. Tapping a chip again
  takes that phrase back out.
- **Edit a photo before it uploads.** Crop to an aspect ratio, rotate, mirror
  and downscale on the device, so an img2img input is the right shape before the
  bytes are sent anywhere.
- **Queue.** See what is waiting, remove single jobs, clear the lot.
- **Installable.** Add it to your home screen and it runs full-screen like an app.
- **Password protected.** The first person to open a new install chooses the
  password.
- **Optional terminal** for maintaining the host, off unless you enable it.

## Requirements

- Node.js 20.11 or newer
- A running ComfyUI instance the Latent server can reach

## Quick start

```bash
git clone https://github.com/alexrutz/Latent.git
cd Latent
npm install
npm run build

COMFY_URL=http://127.0.0.1:8188 npm start
```

Then open `http://<your-computer's-LAN-ip>:6173` on your phone, **choose a
password when it asks**, and add it to your home screen.

### Configuration

All optional, set as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | Seeds the first connection on a fresh install |
| `PORT` | `6173` | Port Latent serves on |
| `HOST` | `0.0.0.0` | Bind address (`0.0.0.0` so your phone can reach it) |
| `LATENT_PASSWORD` | *unset* | Fixes the password, skipping the first-run prompt |
| `LATENT_DATA_DIR` | `./data` | SQLite database and the image archive |
| `LATENT_TERMINAL` | *unset* | Set to `1` to enable the built-in shell |
| `LOG_LEVEL` | `info` | `trace`…`silent` |

After the first run, connections are managed in the app — `COMFY_URL` only
matters for the very first boot.

### The password

Latent always requires one. On a fresh install the first person to open it
chooses the password, and that window closes permanently once they do.

**That means whoever reaches the address first gets the server.** Do it
immediately, or set `LATENT_PASSWORD` and skip the window entirely — which is
the right choice for anything unattended or reachable from outside your network.

## Connecting to vast.ai

vast.ai puts ComfyUI behind a proxy that requires a token, and — if the instance
was started with `ENABLE_HTTPS=true` — a self-signed certificate.

**When renting the instance, set `WEB_PASSWORD` to something you choose.** That
value replaces the auto-generated `OPEN_BUTTON_TOKEN`, which you otherwise
cannot read without SSHing into the box.

Then in Latent, **Settings → Connections → Add**:

| Field | Value |
| --- | --- |
| Address | The host and port the instance portal shows for ComfyUI |
| Authentication | **Token** (sent as `Authorization: Bearer …`) |
| Token | Your `WEB_PASSWORD` |
| Allow self-signed certificate | On, if the address is `https://` |

Hit **Test** first — it distinguishes "wrong address" from "wrong token" from
"self-signed certificate", rather than just failing. Then **Save**, and
**Use this** to switch to it.

Basic auth works too (`vastai` / your token) if you prefer it.

> Allowing a self-signed certificate means Latent stops verifying *who* it is
> talking to on that connection. It is per-connection and off by default. It is
> also the only way to reach a vast.ai instance using its own certificate.

### Docker

```bash
docker compose up -d
```

`docker-compose.yml` assumes ComfyUI runs on the host; adjust `COMFY_URL` if not.

## Importing a workflow

In ComfyUI, open the workflow you want and choose **Workflow → Export (API)**
(older builds: enable *Dev mode* in settings, then **Save (API Format)**). In
Latent, go to **Settings → Import** and pick that file.

The regular "Export" format will not work — it describes the visual graph, not
the executable one. Latent detects it and tells you so rather than failing
obscurely.

### If the form isn't quite right

Latent identifies fields by node class and input name. That covers the usual
workflows, but no heuristic handles every custom node — anything it doesn't
recognise goes to **Advanced** rather than being dropped. Use
**Settings → Edit form** to show, hide, rename or promote any field. Those
edits are stored separately from the derived form, so **Refresh models** (which
re-reads node definitions after you install something new) never overwrites them.

Rearranging a form on a phone is fiddly enough that you should only do it once.
**Save current** at the top of that sheet stores the arrangement under a name,
and tapping a saved layout puts it back — so one workflow can have a stripped
"just the prompt" layout and a full one, and you switch rather than re-edit.
Deleting a layout only forgets the arrangement; it never changes the form you
are looking at.

## Keeping images when the instance goes away

A gallery entry normally just points at a file in ComfyUI's output directory. If
that ComfyUI is a rented GPU, the directory stops existing the moment you end the
rental — and every image you liked goes with it.

**Rating an image copies it onto the machine running Latent.** From then on the
gallery serves it from there, so it keeps working with the instance destroyed.
The gallery's **Rated** and **★ 4+** filters show what you have kept, and
Settings reports how much disk the archive is using and can drop copies of
anything unrated.

This is why it matters where Latent runs: put it on a machine that stays up (a
PC, a NAS, a small always-on box), and point it at whatever GPU you are renting
today.

### The archive is encrypted

Those copies then sit on a disk indefinitely, so they are encrypted:

- A random 256-bit master key encrypts every file with AES-256-GCM.
- That master key is itself wrapped with a key derived from your password
  (scrypt). The password is never stored.
- The master key only ever exists **in memory**, and only after somebody signs
  in. Restart the server and the archive is sealed again until the next login.

So a stolen disk, a backup, or someone sitting at the machine gets nothing but
ciphertext. Changing your password re-wraps the master key, which takes
milliseconds — no image is ever re-encrypted.

**Metadata stays readable.** Prompts, seeds and settings remain in the database
in the clear, which is what lets the server sort and filter by rating without
decrypting everything first — and what means the settings behind an image are
still there years later.

> **If you forget the password, the images are gone.** There is no recovery key
> and no back door; that is what makes the encryption worth anything. The
> database, and the settings in it, survive — the pictures do not.

## Importing an existing output folder

**Settings → Import from a folder.** Give it a path, and Latent walks it
recursively, lists every image, and marks the ones already in your library.
Select what you want and import — the files are copied into the same encrypted
archive as generated work and can be rated, favourited and browsed identically.

The path is read from the machine running Latent. If ComfyUI is on a remote
vast.ai instance, its outputs are not on this filesystem: point this at a local
ComfyUI, a network mount, or a synced folder. A Windows install talking to a
ComfyUI inside WSL2 is the same situation in miniature — use the `\\wsl$\…` path
(or a drive mapped to it) so the files really are reachable from where Latent
runs.

Imported files exist **only** in Latent's archive; ComfyUI has never heard of
them. Everything that reads an image — the grid, the viewer, "send to img2img" —
therefore serves them from the archive directly, and says so plainly if the
archive is locked or was encrypted under a different password, rather than
showing a broken tile.

## Timings and the queue

The step rate and the time remaining are measured **on the server**, where the
progress events actually arrive. That matters for two reasons: every device shows
the same numbers, and a phone that locks its screen mid-render and comes back
gets the real elapsed time instead of restarting a stopwatch from zero.

The per-step average deliberately ignores the first step of each sampler pass —
on a cold instance that one step includes loading the model and warming up CUDA,
which is easily twenty seconds and would poison the estimate for the whole run.
The average also resets when a new node starts sampling, because a two-sampler
workflow runs at two different speeds and one figure would be wrong for both.

The remaining time is for the **current sampler pass**, not the whole graph:
that is the part whose length is knowable. When several jobs are waiting and a
previous run has finished, the stats panel also estimates when the queue as a
whole will drain, assuming the rest take as long as the last one did.

In the queue, each job carries a snapshot of the values it was submitted with,
recorded at submit time rather than looked up later — so the listing keeps
describing what actually ran even after the workflow's form is re-arranged or the
workflow itself is deleted.

**Cancelled runs leave no trace in the gallery.** Clearing a queue of eight used
to leave eight "cancelled" tombstones at the top of your pictures. A cancel that
landed mid-batch still keeps whatever images it managed to produce — those are
real results.

## The terminal

Set `LATENT_TERMINAL=1` and Settings gains a shell on the machine running
Latent, with a soft key row for Esc, Tab, Ctrl and the arrows that a phone
keyboard does not have.

It is exactly what it sounds like: **anyone who knows the password gets a shell
on that machine.** It is off unless you turn it on, and it is not registered as a
route at all when disabled.

## How it works

```
phone ──HTTPS/WSS──▶ Latent server ──HTTP/WS──▶ ComfyUI
                          │
                          └─ SQLite: workflows, forms, generation history
```

The browser never talks to ComfyUI directly. The server holds **one** WebSocket
to ComfyUI and submits every prompt under that connection's client id, then fans
events out to whichever devices are connected.

That indirection is the point. Phones drop sockets constantly — screen lock, app
switch, moving between wifi and cellular. Because the server owns the connection,
a job keeps running and keeps being recorded regardless, and a reconnecting phone
receives a full snapshot and is instantly correct. It also means several devices
stay in sync, and that ComfyUI needs no CORS configuration and need not be
exposed to the network at all.

## Development

```bash
npm run dev:mock   # mock ComfyUI + server + Vite, all wired together
```

`dev:mock` runs a **mock ComfyUI** (`server/src/mock/`) that implements the real
route contract and event sequence and returns generated placeholder images. The
whole app — import, generate, live progress with previews, gallery, queue,
uploads — works against it with no GPU. Use `npm run dev` instead to develop
against a real ComfyUI.

```bash
npm test           # unit + server integration tests (Vitest)
npm run test:e2e   # mobile browser tests (Playwright, iPhone viewport)
npm run typecheck
npm run build
```

`npm run test:e2e` needs `npm run build` first. If your environment ships a
pre-installed browser that doesn't match Playwright's expected build, point at
it: `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:e2e`.

### Layout

| Path | What lives there |
| --- | --- |
| `shared/` | Types, the form-building engine (`paramSchema.ts`), LoRA tag parsing and the queue's parameter summaries — pure, no I/O |
| `server/` | Fastify proxy, ComfyUI client, live event hub, SQLite store, archive, terminal |
| `server/src/vault.ts` | Archive encryption: master key, wrapping, unlock on sign-in |
| `server/src/images/` | A dependency-free PNG decoder/resizer for thumbnails and image sizes |
| `server/src/mock/` | The mock ComfyUI used for development and tests |
| `web/` | React + Vite PWA |
| `e2e/` | Playwright tests |

Schema changes go in `server/src/db.ts` as a new entry in `MIGRATIONS` — never by
editing one that has shipped.

## Limitations

- **No queue reordering.** ComfyUI's API can delete and clear queue entries but
  cannot reorder them, so neither can Latent.
- **No graph editing.** Latent runs workflows; it does not author them. Build
  them in ComfyUI and import.
- **Thumbnails** use ComfyUI's `preview=` parameter where available and fall
  back to full-size images where it isn't.
- **Connection tokens are stored in plain text** in the local SQLite database.
  Encrypting them with a key sitting next to that database would be theatre;
  treat the data directory as sensitive.
- **The terminal needs `node-pty`**, an optional native module. If it could not
  be built for your platform, the terminal reports that instead of opening;
  nothing else is affected.
- **Thumbnails are generated for PNG only.** ComfyUI writes PNG by default, so
  this covers nearly everything; a JPEG or WebP without a ComfyUI-side preview
  is served at full size. This avoids a large native image library for what is
  otherwise a small job.
- **Lose the password, lose the archived images.** Deliberately — see above.

## Licence

MIT
