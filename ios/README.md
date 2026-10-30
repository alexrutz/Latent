# Latent for iOS

A small native front end for a Latent server, talking to the same HTTP API the
web app does — see [*Signing in from something
else*](../README.md#signing-in-from-something-else) in the main README for the
contract it relies on.

**It has never been built as an app.** It was written on a machine with no
Xcode and no iOS SDK. The model layer — `Model/`, everything but the Keychain
code — has been type-checked with Swift 6.1 on Linux, which is how a type
declared inside a generic function in `APITypes.swift` was found and fixed. The
screens use SwiftUI, which exists only on Apple's platforms, so they have not
been checked at all. Expect to fix something on the first build.

## Opening it

```
open ios/Latent.xcodeproj
```

Then, before it will run on a device:

1. Select the **Latent** target → *Signing & Capabilities*.
2. Set **Team** to your own, and change the bundle identifier from
   `com.example.latent` to something under a domain you control.

That is the whole of the setup. There are no dependencies, no package manager
and no generated files: everything is the standard library, `SwiftUI` and
`URLSession`.

The project uses a **synchronized folder group**, so `Latent/` is picked up
whole and adding a file is adding a file — there is no list in the project to
keep in step. That needs Xcode 16 or later.

## Known issues in the screens

Found by review, and left for the first build because the screens cannot be
compiled anywhere but on a Mac — changing SwiftUI blind would trade a known
bug for an unknown compile error.

- **Gallery** reloads page one on every `generation` event and every time it
  appears, so a scrolled-down list jumps back to the top and loses the pages it
  had; overlapping reloads can also finish out of order.
- **Generate** keeps showing the previous workflow while the next one loads,
  with Generate still enabled, so a quick tap queues the old one; and a
  cancelled load reports itself as "could not reach that address".
- **Pictures** — `RemoteImage` reads every file into memory and decodes it as
  an image, so videos and sounds show a warning triangle (and a whole video is
  downloaded to fail); it also builds its own request outside `LatentClient`.
- **Viewer** rolls a failed rating or keep back from the snapshot taken at the
  tap, which also undoes any change made since.

## What it does

| Screen | |
| --- | --- |
| **Sign in** | Address and password, once. It asks `/api/app` what it has reached before offering a password, so a mistyped address says so rather than looking like a wrong password. |
| **Gallery** | Every picture, newest first, paged as you scroll. Tap for full screen; swipe between them; rate out of five or keep one. A tap hides the controls, since they float over the picture. |
| **Generate** | Pick a workflow, type a prompt, send it. Live progress from the WebSocket. |
| **Queue** | What is running and what is waiting, cancelling either, and signing out. |

## What it deliberately does not do

**It is not the web app.** The web app builds a control for every input a graph
declares — thirty of them on a busy workflow — from `paramSchema.ts`. Porting
that would be a second implementation of it in another language, kept in step by
hand, and the first time the two disagreed the phone would submit a graph the
server had never described.

So Generate sends **a prompt into a workflow you already set up**: the values it
submits are that workflow's own last ones with the prompt written over the top.
Everything else — steps, model, size, LoRAs — stays as the web app left it. That
is also the honest description of what a phone is for here: the idea you had
away from the desk, sent to a setup you already trust.

Not here either: the chat, parameter studies, prompt blocks, the wandering
mode, favourites, settings, the terminal, and **your notes** — which want the
password a second time on top of any credential and would need their own screen
to do that properly.

## How it talks to the server

**One token, kept in the Keychain.** Signing in posts to `/api/auth/login` with
`issueToken: true` and stores what comes back. Every request after that carries
`Authorization: Bearer <token>`, including the WebSocket handshake. There is no
refresh: the token is derived from the server's password hash, so it lasts until
the password changes and then stops working everywhere at once. A `401` means
sign in again, and that is the whole lifecycle.

The address goes in `UserDefaults` — it is not a secret and being able to read
it when something is wrong is worth more. The token goes in the Keychain, as
`AfterFirstUnlockThisDeviceOnly`: readable to a background refresh on a locked
phone, and never carried to another device by an iCloud backup, because it is a
credential for one machine on one network.

**Unreachable is not signed out.** The commonest reason a launch fails is that
the machine is asleep or the phone is on mobile data. Throwing the token away
for that would mean typing the password again every time, for a server that was
never in doubt — so only an actual `401` clears it.

**Plain HTTP, on the local network only.** A home server has no certificate and
nothing to get one from, so `Info.plist` sets `NSAllowsLocalNetworking`, which
covers private ranges and `.local` and leaves the rest of the internet under the
normal rules. A server reached over HTTPS through a tunnel is unaffected and
still verified. iOS also asks before letting any app talk to the local network;
`NSLocalNetworkUsageDescription` is the sentence shown in that prompt.

**Thumbnails in the grid, always.** `/api/view` takes `preview=webp;70`, and a
screen of full-size renders would be tens of megabytes over Wi-Fi and hundreds
decoded in memory. The full picture is fetched only when one is opened.

## Layout

```
Latent/
  LatentApp.swift        The app, and signed-in-or-not
  Model/
    APITypes.swift       What the server sends, as much as is read
    Credentials.swift    The address in defaults, the token in the Keychain
    LatentClient.swift   Every request, and the only place the token goes on
    LiveSocket.swift     /api/ws, with its own reconnect
    Session.swift        Signing in, restoring, signing out
  Screens/               One file per screen
  Support/
    RemoteImage.swift    AsyncImage, but with a header on the request
```

`AsyncImage` is unused for one reason: it takes a URL and builds its own
request, with nowhere to put `Authorization`, and every image route here needs
it.
