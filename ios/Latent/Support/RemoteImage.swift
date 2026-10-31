import SwiftUI
import UIKit

/// A picture from Latent, fetched through `LatentClient`.
///
/// `AsyncImage` would be the obvious thing and cannot be used: it takes a URL
/// and builds its own request, with no way to add a header — and every image
/// route here needs `Authorization`. This used to build that request itself,
/// outside the client, and so outside its timeout, its connection pool and its
/// signing out on a 401. Now the client fetches the bytes like anything else.
///
/// Only ever decodes a still. A clip shows its poster, if the server has one,
/// and a sound shows what it is: reading a whole video into memory to hand it
/// to `UIImage`, which then fails, is what this used to do with both — and
/// what put a warning triangle on every one of them.
struct RemoteImage: View {
    let client: LatentClient
    let image: ComfyImage
    /// The server's small copy. A clip is always asked for its poster, whatever
    /// this says; a sound is never asked at all.
    var preview = false
    var contentMode: ContentMode = .fill

    @State private var loaded: UIImage?
    @State private var failed = false

    private var url: URL? {
        // A sound has no still, and the server says so every time it is asked.
        if image.kind == "audio" { return nil }
        return client.imageURL(image, preview: preview || !image.isStill)
    }

    var body: some View {
        ZStack {
            if let loaded {
                Image(uiImage: loaded)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else if !image.isStill && (failed || url == nil) {
                // Not a failure: a clip nothing has made a poster for yet, or
                // a sound. Says what it is rather than that something broke.
                Color.black.opacity(0.25)
                    .overlay(
                        Image(systemName: image.kind == "audio" ? "waveform" : "film")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                    )
            } else if failed {
                // A picture whose file has gone. Says so quietly rather than
                // spinning forever on something that is never going to arrive.
                Color.black.opacity(0.25)
                    .overlay(Image(systemName: "exclamationmark.triangle").foregroundStyle(.secondary))
            } else {
                Color.black.opacity(0.25)
                    .overlay(ProgressView().controlSize(.small))
            }
        }
        // Keyed on the URL: a cell scrolled off and reused must not keep the
        // last picture on screen while the next one loads.
        .task(id: url) { await load() }
    }

    private func load() async {
        loaded = nil
        failed = false
        guard let url else { return }

        do {
            let data = try await client.bytes(url)
            guard !Task.isCancelled else { return }
            if let decoded = UIImage(data: data) { loaded = decoded } else { failed = true }
        } catch is CancellationError {
            // A cell that scrolled away, not a failure. The client turns both
            // spellings of it into this one.
            return
        } catch {
            failed = true
        }
    }
}
