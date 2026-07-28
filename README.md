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
- **Live progress.** A persistent bar shows the running node, sampler progress
  and the live preview image, and follows you between tabs.
- **Gallery.** Every result, with the exact settings that produced it. Pinch to
  zoom, swipe between a batch, save to your camera roll, re-run, or send a
  result straight to img2img or an upscale pass.
- **Queue.** See what is waiting, remove single jobs, clear the lot.
- **Installable.** Add it to your home screen and it runs full-screen like an app.
- **Optional password**, so you can expose it beyond your LAN without exposing
  ComfyUI itself.

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

Then open `http://<your-computer's-LAN-ip>:6173` on your phone and add it to your
home screen.

### Configuration

All optional, set as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | Where ComfyUI is listening |
| `PORT` | `6173` | Port Latent serves on |
| `HOST` | `0.0.0.0` | Bind address (`0.0.0.0` so your phone can reach it) |
| `LATENT_PASSWORD` | *unset* | If set, the app requires this password |
| `LATENT_DATA_DIR` | `./data` | Where the SQLite database lives |
| `LOG_LEVEL` | `info` | `trace`…`silent` |

**Set `LATENT_PASSWORD` if the machine is reachable from anywhere but your own
network.** Without it, anyone who can reach the port can use your GPU.

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
| `shared/` | Types plus the form-building engine (`paramSchema.ts`) — pure, no I/O |
| `server/` | Fastify proxy, ComfyUI client, live event hub, SQLite store |
| `server/src/mock/` | The mock ComfyUI used for development and tests |
| `web/` | React + Vite PWA |
| `e2e/` | Playwright tests |

## Limitations

- **No queue reordering.** ComfyUI's API can delete and clear queue entries but
  cannot reorder them, so neither can Latent.
- **No graph editing.** Latent runs workflows; it does not author them. Build
  them in ComfyUI and import.
- **Thumbnails** use ComfyUI's `preview=` parameter where available and fall
  back to full-size images where it isn't.

## Licence

MIT
