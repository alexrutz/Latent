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

- **Any workflow you already have.** Point Latent at your ComfyUI folder and it
  reads every workflow saved in it — the editor's own files, not just an
  *Export (API)*. For each one it works out which inputs are editable and builds
  a form: prompt, seed, steps, CFG, sampler, dimensions, model pickers. Model and
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
- **Gallery.** Every result, with the exact settings that produced it. Swipe
  through the whole gallery, pinch to zoom, tap to close, save to your camera
  roll, re-run, or send a result straight to img2img or an upscale pass.
- **Values on the pictures.** Pick which settings to draw over the thumbnails —
  `St20 Cf8`, small enough to fit — so a sweep can be compared at a glance
  without opening anything. The full-size viewer has its own separate choice.
- **Ratings that outlive the GPU.** Rating an image copies it onto the machine
  running Latent — **encrypted**, so it survives the rented instance being
  destroyed without leaving your pictures readable on disk.
- **Keep, delete, and a cleanup that runs itself.** Keeping stores a picture
  without passing judgement on it; anything nobody rated, kept or favourited is
  deleted after a period you choose, so the gallery stays worth scrolling.
- **Favourites.** Keep an image together with the settings that made it, rate
  those separately, and generate more like it in one tap.
- **A grid that fits the pictures.** Adjustable column count; each tile takes its
  shape from the image's aspect ratio so nothing is cropped square, with a
  per-image override. Only thumbnails are ever downloaded.
- **Import an existing output folder.** Point Latent at a ComfyUI output
  directory and walk it a folder at a time — a day, a project, a model — with
  image counts on each. Import a picture, a selection, or a whole folder tree in
  one tap, and **imported pictures keep the settings ComfyUI wrote into them**,
  so "reuse these settings" works on work made long before Latent existed.
- **LoRA editor.** `<lora:name:0.8>` tags become compact rows with a strength
  slider and a picker, instead of something you type by hand on a phone keyboard.
- **Parameter presets.** Save a whole set of settings per workflow and re-apply
  it in one tap.
- **Saveable form layouts.** Arrange a workflow's form once — what shows, what
  it's called, what goes under Advanced — save it under a name, and switch
  between arrangements later.
- **Prompt blocks.** Save the phrases you reuse and assemble a prompt by tapping
  chips instead of typing paragraphs on a phone keyboard. Tapping a chip again
  takes that phrase back out. They have a **Blocks** tab of their own for making,
  grouping and ordering them — laid out two to a row, because a library worth
  having is longer than one screen.
- **A form you build.** Drag fields into the order you want, give each one half a
  row or a whole one, rename or hide anything — per workflow, saved under a name.
- **A monitor.** VRAM, GPU, CPU and sampler speed over time, with the queue's own
  events marked on the same axis, so "why did that take so long" has an answer.
- **Text outputs.** Whatever the graph printed rather than drew — an expanded
  wildcard, a generated caption — kept with the run and shown with the picture.
- **Privacy blur.** Every image in the app, heavily out of focus, in one tap.
- **Random prompt mode.** Let the app draw the prompt from your blocks instead —
  from the whole library or a pool you narrow by hand. Every queued run gets its
  own draw, so a batch of eight is eight different pictures. It has its own
  **Random** tab, because it is a screenful you arrange once and come back to.
- **Parameter sweeps.** Give any numeric setting a range and an interval; each
  run draws one of the resulting values. Saved together with the prompt setup as
  one named thing, because that is how it is used.
- **Point lines.** Any numeric field can be a row of pre-set values instead of a
  sheet with a slider and a keyboard — set the range and interval once, then
  changing Steps from 20 to 40 is a single tap.
- **Edit a photo before it uploads.** Crop to an aspect ratio, rotate by quarter
  turns or a free angle, mirror and downscale on the device, so an img2img input
  is the right shape before the bytes are sent anywhere.
- **An input folder.** ComfyUI's own `input` directory — reference shots,
  sketches and masks — picked straight from the image input and copied
  server-side, so the file never travels to your phone and back.
- **Queue.** See what is waiting, remove single jobs, clear the lot.
- **Installable.** Add it to your home screen and it runs full-screen like an app.
- **Password protected.** The first person to open a new install chooses the
  password.
- **Settings that outlive the project folder.** Everything you arrange is
  mirrored to two files one directory above the checkout, and the database and
  image archive live there too — so a clean reinstall keeps your gallery, your
  layouts, your presets and your prompt library.
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
| `LATENT_DATA_DIR` | `../latent-data` | SQLite database and the image archive |
| `LATENT_STATE_DIR` | `..` | Where the portable settings files are written |
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

## One folder, and the workflows in it

Latent asks for **one path**: where ComfyUI is installed. A stock install keeps
everything in known places under it, so the rest follows —

```
<ComfyUI>/output                    pictures to import
<ComfyUI>/input                     pictures to feed into workflows
<ComfyUI>/user/default/workflows    every workflow you have ever saved
```

Enter it under **Settings → ComfyUI folder** and tap **Read workflows**. That
imports the lot, converting the editor's own save format on the way in: the
positional widget lists those files use are walked against `/object_info`, so
`20` is understood to be `steps` without anybody re-exporting anything.

They arrive **switched off**. A long-running install holds dozens of workflows,
most of them experiments, and a picker listing all of them is worse than one
listing none — so each has a switch in Settings, and only the ones you turn on
appear when you generate.

An *Export (API)* file still imports one at a time through **Settings → Import**,
and so does an editor file if you would rather pick it by hand.

If a workflow uses a node this ComfyUI does not have, or has nothing in it that
saves an image, the import says exactly that instead of failing later at submit
time.

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

### Building the form

**Settings → Edit form** is a layout tool, not a list of switches:

- **Drag the handle** on any field to reorder it. The order here is the order on
  the Generate screen.
- **Half a row or a whole one.** The form is two columns of chips; a field set to
  full takes the width of both. A sampler name needs the room its longest option
  does, while four short numbers read better side by side — which is why it is a
  per-field choice rather than a rule.
- **Rename, hide, or move to Advanced.** A rename saves as you type: it used to
  save on blur, which on a phone meant closing the sheet threw it away.

### Sliders, or a line of points

Every numeric field has two ways of being edited, chosen per field under
**Settings → Edit form**:

- **Slider** — the chip opens a sheet with a slider and a keyboard. Right for a
  value that could be anything.
- **Points** — a row of pre-set values on the form itself. Set the range and the
  interval (`20 to 50, step 10` gives `20 30 40 50`, listed under the fields so
  there is nothing to work out), and from then on changing the value is one tap.

The second exists because of how these values are actually used: nobody sweeps
Steps continuously, they cycle between the same handful of numbers, and three
taps plus a keyboard to get from 20 to 30 is three taps too many. A value that
arrives from a preset, a reused result or a random draw and lands between two
points highlights the nearest one and says **off the line**, rather than quietly
rounding itself.

Everything that stays a chip is laid out in **two even columns**, so a sampler
block reads as a list you can scan down instead of a wrapped heap of
differently-sized bubbles.

## Where your data lives

**Everything is outside the project directory**, which is the one you delete
when you want a clean reinstall:

```
../latent-data/            the database, and the encrypted image archive
../latent-settings.json    every arrangement: app settings, connections,
                           per-workflow form layouts and presets, the
                           variation setups
../latent-prompt-blocks.json   the prompt library, on its own
```

An install made when the database lived in `./data` moves itself the first time
it starts, so there is nothing to do about it.

The database stays the source of truth at runtime; the two JSON files are
mirrored from it whenever it changes, and read back on boot into whatever the
database does not already have. The point is the clean start: delete the project
folder, clone it again, import the same workflow — and the form you built, the
layouts you named and the phrases you saved are all still there. Workflows are
matched by **name**, because the id is generated at import time and a re-imported
workflow is a different row.

Two files rather than one because they are used differently: the prompt library
is worth copying to another machine or keeping in version control on its own,
while the rest is this installation's configuration.

Restoring is additive and never overwrites: anything already in the database
wins, so a stale file cannot undo work. Set `LATENT_STATE_DIR` to put them
somewhere else.

**Both files are encrypted**, with AES-256-GCM under a key derived from your app
password — they hold connection secrets and your whole prompt library, and they
sit in a directory chosen precisely because it does not get deleted. They are
readable only after somebody signs in, which has one consequence worth stating
plainly: wiping the database and then choosing a *different* password on the way
back up leaves them undecryptable. Latent refuses to overwrite a file it could
not read, and says so in the log, rather than quietly destroying what it holds.
Changing the password rewrites both files under the new key.

## What the graph printed

Not every output is a picture. A **"preview as text"** node — `PreviewAny`,
`ShowText` and the rest — is how a workflow tells you what it decided: the prompt
after a wildcard expanded, a caption a vision model wrote, a size a node
computed. Latent records those with the run and shows them under the picture in
the viewer, and on the Monitor's timeline as they arrive.

Any output field that is not one of the known binary payloads counts, whatever
the node called it, because there is no convention here and a list of node types
would be out of date within a month.

## The monitor

A tab with two halves that only make sense together: what the machine was doing,
and what it was doing it for. VRAM, system RAM, sampler speed and queue depth
over time, with the queue's own events — queued, started, each node, finished,
failed, connection lost — marked on the same axis and listed underneath.

**GPU and CPU load are not part of ComfyUI.** Core ComfyUI reports VRAM and RAM
through `/system_stats` and nothing else, so those two charts say "not reported"
rather than drawing a flat line at zero. Install the widely used **Crystools**
extension on the ComfyUI box and Latent picks up its broadcasts over the socket
it already holds — no extra configuration, and no polling of a second endpoint.

Readings are taken every two seconds while something is running and every twenty
when the box is idle, and kept **in memory**: this is the recent past, the window
in which you are still asking why something just happened, and writing a row
every two seconds to answer that is a poor trade against an SD card. Switching
connection clears it, because a different endpoint is a different machine.

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

Files are content-addressed, so the same picture is stored once however many
times it is rated or imported. One consequence is worth stating: after a clean
start the archive survives but its master key does not, so files already there
were encrypted under a key the new install has never seen. Latent checks that it
can actually *read* a file before treating it as already stored, and rewrites it
if not — otherwise re-importing a picture would record a row pointing at bytes
nobody can ever decrypt.

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

## An input folder

`<ComfyUI>/input`, found from the folder you already entered. Its contents
appear behind **From folder** next to any image input — reference shots,
sketches, masks, anything a workflow should read rather than produce.

Tapping a picture copies it into ComfyUI's input directory **server-side**. The
bytes go from the Latent machine straight to ComfyUI; nothing travels to the
phone, which is what makes picking a 12 MP photo cost one small request instead
of a download and a re-upload. The grid itself only ever loads generated
thumbnails.

**Edit** on a picture is the opt-in path: only then is the original pulled down,
so you can crop or straighten it first. The result is uploaded like any other
edited photo.

The folder is strictly read-only — Latent never writes to it — and, like the
import folder, a path is refused the moment it tries to escape the configured
root.

## Importing an existing output folder

**A folder at a time.** `<ComfyUI>/output` is routinely tens of thousands of
files in dozens of dated folders, and a flat list of all of them is something
nobody can find anything in. Settings → *Import from a folder* walks the tree
one level at a time, with the image count on each folder, and imports
a single picture, a selection, or a whole folder and everything under it in one
request — the expansion happens on the server, so a phone never sends ten
thousand paths.

**Imported pictures remember how they were made.** ComfyUI writes the graph it
ran into every PNG it saves. Latent reads it back, matches it against the
workflows you have imported here — by node id *and* class, so a graph that
merely numbers its nodes the same way is not mistaken for yours — and stores the
settings with the picture. "Reuse settings" then works on work made long before
Latent existed. Pictures with no metadata, or from a workflow you do not have,
come in as before.


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

## Always-on prompt blocks

Under the prompt field, **Always append** picks blocks that go on the end of
every prompt. A quality tail or a house style is not part of *this* picture's
description — it is part of every request you make, and re-tapping it each time
is exactly the tedium the block library exists to remove. It is applied on the
server at submit time, so it lands on a drawn prompt as surely as a typed one,
and text that is already there is never doubled.

## Random prompt mode

Once you have a library of prompt blocks, the interesting thing to do with it is
not picking four by hand — it is letting the app pick four, over and over, and
seeing what comes out.

Open the **Random** tab and turn it on. From then on every queued run draws
its own prompt. It is a tab rather than a sheet under the prompt field: pool,
per-group limits, parameter ranges and saved setups add up to a screenful, and
something you arrange once and then leave alone deserves a place you can find
rather than a button you have to remember is there. Settings:

- **Blocks per prompt** — *at least* and *at most*, drawn between each time so
  the length varies too. Both offer **all** as well as a number: *at most all*
  puts no ceiling on it beyond the pool and the group limits, and *at least all*
  makes the draw take everything it is allowed to.
- **Which prompt fields** — shown whenever a workflow has more than one text
  input Latent reads as a prompt, with a switch each. The role heuristics are
  right for a stock workflow and cannot be right for every custom node, and a
  drawn landscape landing in a LoRA loader's trigger words is not a small
  mistake — so what the draw will touch is listed rather than assumed. (A LoRA
  loader's own text is never treated as a prompt in the first place.)
- **Keep what I typed** (on by default) — the draw is *added* to your prompt, so
  "photo of a lighthouse" stays the subject and the blocks supply the treatment.
  Off, the prompt is built purely from blocks.
- **One block per group** (on by default) — the groups you already gave your
  blocks become the constraint that keeps a random prompt coherent. Two lighting
  blocks in one prompt fight each other; this stops that happening. It is only
  the starting point, though: **each group has its own limit** next to its name
  in the pool — `1`, `2`, `3` or `any`. Exactly one block should say *where* the
  picture is, or it is set in two countries at once; three describing the
  *atmosphere* stack up perfectly well. Blocks with no group at all are unlimited
  unless you say otherwise.
- **Pool** — every block by default. Tap any chip to narrow it, and "Use all
  blocks" to go back. An empty pool is stored as "no pool", so blocks you add
  later are included automatically.

**Draw three examples** asks the *server* for sample draws through the same code
path a real submit uses, so a preview can never disagree with what you get. With
"keep what I typed" on it draws on top of whatever is in the prompt field on the
Generate screen, and says so — a preview against an empty prompt would be a
fiction now that the two live on different tabs.

Two things worth knowing:

- **The draw happens on the server, once per queued item.** Rolling in the browser
  would send one prompt eight times, which is the opposite of the point — and it
  means you can queue eight and lock your phone.
- **The drawn prompt is what gets recorded.** The queue, the gallery and the
  generation history all show the prompt that actually ran, so a result you liked
  can be reproduced. What is stored as the workflow's *last used* values stays the
  text you typed, so the form never reopens full of random phrases.

If the pool is empty — no blocks saved, or narrowed to nothing — your typed
prompt is submitted unchanged rather than blank.

### Sweeping parameters too

Under **Parameters** in the same tab, give any numeric setting a **range and an
interval**. `20 to 40, step 10` means each run draws one of `20, 30, 40` — the
candidates are listed under the rule, so there is never a question of what a rule
will actually do.

Discrete on purpose. A continuous range would produce 7.318294 and make two runs
impossible to compare; a small set of values is something you can hold in your
head. Rules are clamped to the node's own limits, integer fields stay integral,
and a rule naming a field the current workflow does not have is skipped rather
than submitted blindly.

The section sits below the prompt controls and starts collapsed, because the
prompt is what decides whether a picture is interesting.

### Saving a whole setup

**Save current** keeps the blocks, the pool, the group limits *and* the parameter
ranges under one name. They are one way of working — "moody landscapes, high step
count" is a different setup from "portraits, fast drafts" — so switching between
them is one tap rather than eight.

Loading a setup deliberately does **not** switch variation on or off. That is a
statement about what to vary, not about whether you want it right now.

## In the gallery

**Tapping the tab you are already on goes back to the top**, the way every other
phone app behaves. Without it a long gallery scroll is a one-way trip.

**The blur.** The ◌ button in the gallery header — and the same switch under
Settings → Display — puts every image in the app heavily out of focus: the grid,
the viewer, the live preview, the queue's thumbnails. It is one attribute on the
root element rather than something each component opts into, because a privacy
feature that only covers what somebody remembered to wire up is not one. Kept on
the device, applied before the first paint, so a reload does not flash the
pictures back.

**Keep, or delete.** A rating is an opinion, and being made to pass one on every
picture you want to survive the cleanup is the wrong price — so **Keep** makes
the same promise a rating does (copied into the local archive, never swept)
while saying nothing about quality. **Delete** takes two taps and removes the
picture and its local copy; when it was the last one in a run, the run goes too.

**The cleanup.** Settings → *Saved images* sets how long an unkept run survives.
Anything rated, kept or favourited stays, and one of those anywhere in a run
keeps the whole run — deleting three of four frames from a batch would throw
away the comparison that made the fourth worth keeping. Imported folders are
never touched: that is somebody's existing library, not scratch space.

**Details open when you tap them.** The parameter list cuts each value to a
line — a prompt is both the value you most want to read here and the one least
likely to fit — and tapping a row shows the whole thing, tapping again puts it
back. The action row underneath is a three-column grid, so both edges are flush
and every button is the same size to hit.

**Values drawn over the picture.** The ⓘ button chooses what appears on the
image itself, two choices to a row, and the selection order is the order on
screen. Anything a node *printed* is a choice like any other, which is how a
model's caption or its reasoning gets shown — and because that can be a
paragraph rather than a number, the strip is capped in height and scrolls
instead of covering the picture it describes.

**A zoom stays put.** The list grows underneath the viewer while a queue drains,
and the viewer used to reset your zoom whenever it did — the *index* of the
picture had changed, not the picture. It is keyed on the picture's own identity
now, so a double-tap and a pan survive whatever arrives next.

**Swiping crosses runs.** The viewer holds every picture in the gallery as one
flat list, so a flick keeps going past the end of a batch instead of stopping
dead at a boundary that means nothing while you are browsing.

**A tap closes it** — the gesture everyone tries first. Zoomed in, the first tap
zooms back out instead, because closing on a stray tap while inspecting detail
would be maddening. Double tap still toggles zoom; the single tap waits out the
double-tap window before acting.

**Values on the pictures.** The ⓘ button in the gallery header chooses what is
drawn over each *thumbnail*; the one in the viewer's action row chooses what is
drawn over the *full-size* picture. Two selections, because a thumbnail fits two
or three numbers and the viewer fits more.

Labels are abbreviated to two letters and lengthened only as far as needed to
stay distinct within the set on screen — so `Seed` and `Sequence` become `Se` and
`Seq`, while `Steps` and `Sampler` are just `St` and `Sa`. Turn **Short labels**
off for bare numbers.

The values come from what each run recorded when it was queued, so they describe
what actually ran even after the workflow has changed.

## Timings and the queue

**The result presents itself.** When the queue drains, the finished picture opens
rather than waiting to be tapped — it is the thing you were waiting for. During a
batch it does not: what happens instead is that the *last* picture stays on screen
until the next one has a preview frame of its own, so a batch of eight is
something you can watch rather than an empty box between renders.

**A lost connection resolves itself.** ComfyUI going away mid-queue used to leave
this app describing a machine that no longer existed: a queue badge that never
cleared, and gallery placeholders for pictures that were never going to arrive.
On reconnect, the queue and the history are compared against what Latent still
believes is running — anything that finished while it was not listening is
recovered with its images, anything that vanished is marked as lost, and the
placeholders go with it. If the box stays unreachable, the same thing happens
after half a minute rather than waiting for it to come back.

On the Generate screen the progress bar and the **Generate** button share one
row: they are two things you look at together, and stacked they cost two rows of
a phone screen that the form needs. Tapping the bar opens the same detail sheet —
preview, progress, full statistics — that the full-width bar opens everywhere
else. The bar only exists while something is running, so an idle screen still
gives the button the whole width.

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

## Editing a photo

Picking any image input — from the camera roll or the input folder's **Edit** —
opens the same editor: crop to a ratio, rotate in quarter turns, mirror, and
**straighten** by any angle up to 45° either way.

A free angle leaves empty wedges at the corners, so the crop box automatically
starts at the largest rectangle that fits *inside* the rotated picture. That is
what makes straightening a one-slider job rather than a slider plus a manual
trim. Anything still outside the crop is filled black rather than left
transparent: a transparent PNG becomes an alpha mask inside ComfyUI, which is not
what anyone means by "straighten".

Output is capped at 2048px on the longest edge, and **Original** skips the canvas
entirely when the picture was already right.

## Nodes that name their own choices

Some custom nodes publish a dropdown with **nothing in it** and fill the list in
from the browser, using a JavaScript extension of their own. The Ollama nodes do
this for their model picker. Latent is not that browser, so the list arrived
empty and the picker reported, quite correctly and quite uselessly, that nothing
matched.

An empty dropdown is now treated as what it is — a value the node names for
itself, not a choice with no options. It can always be typed, and for an Ollama
node Latent also asks Ollama directly, at the address on that node's own `url`
widget. A workflow saying `127.0.0.1` means "the Ollama next to ComfyUI", so
when ComfyUI is somewhere else that host is substituted; if nothing answers, the
field says so and stays typeable.

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
| `shared/` | Types, the form-building engine (`paramSchema.ts`), LoRA tag parsing, the queue's parameter summaries and both random draws (`randomPrompt.ts`, `randomParams.ts`) — pure, no I/O |
| `server/` | Fastify proxy, ComfyUI client, live event hub, SQLite store, archive, terminal |
| `server/src/monitor.ts` | The resource and event history behind the Monitor tab |
| `server/src/statefile.ts` | Mirrors the arrangement to the files above the project |
| `server/src/sweeper.ts` | Deletes runs nobody kept, once they are old enough |
| `shared/src/promptMatch.ts` | Matches an image's embedded graph to a stored workflow |
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
