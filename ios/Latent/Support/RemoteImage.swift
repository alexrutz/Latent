import SwiftUI
import UIKit

/// A picture from Latent, fetched with the token on the request.
///
/// `AsyncImage` would be the obvious thing and cannot be used: it takes a URL
/// and builds its own request, with no way to add a header — and every image
/// route here needs `Authorization`. So this is the same idea with a request
/// instead of a URL.
struct RemoteImage: View {
    let url: URL?
    let token: String?
    var contentMode: ContentMode = .fill

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
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
        image = nil
        failed = false
        guard let url else { return }

        var request = URLRequest(url: url)
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                failed = true
                return
            }
            guard !Task.isCancelled else { return }
            guard let decoded = UIImage(data: data) else {
                failed = true
                return
            }
            image = decoded
        } catch {
            /*
             * A cancelled load is a cell that scrolled away, not a failure.
             *
             * Both spellings, because they arrive from different places:
             * `.task` cancelling the child throws `CancellationError`, and
             * `URLSession` noticing first throws `URLError.cancelled`. Treating
             * either as a failure would leave a warning triangle on every tile
             * somebody scrolled quickly past.
             */
            if error is CancellationError { return }
            if (error as? URLError)?.code == .cancelled { return }
            failed = true
        }
    }
}
