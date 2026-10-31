import SwiftUI

/// Everything that has been made, newest first.
///
/// A flat grid of pictures rather than a list of runs. A batch of four is not a
/// boundary anybody is thinking about when they are looking for one image, and
/// grouping by run puts a heading between every four thumbnails.
@MainActor
struct GalleryView: View {
    let client: LatentClient
    let live: LiveSocket

    @State private var feed = GalleryFeed()
    @State private var opened: GalleryEntry?

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

    var body: some View {
        NavigationStack {
            Group {
                if feed.entries.isEmpty && feed.loading {
                    ProgressView()
                } else if feed.entries.isEmpty {
                    ContentUnavailableView(
                        "Nothing yet",
                        systemImage: "photo.on.rectangle",
                        description: Text(feed.problem ?? "Renders appear here as soon as they finish.")
                    )
                } else {
                    grid
                }
            }
            .navigationTitle("Gallery")
            // Pulling down is asking to start over, so it does.
            .refreshable { await feed.reload(fetch) }
        }
        // Every time the tab comes back, not only the first: what finished
        // while it was away belongs at the top. Merged in rather than reloaded,
        // so coming back to a list scrolled ten pages down leaves it there.
        .task { await feed.refreshTop(fetch) }
        .onAppear {
            // A run finishing means the top of this list is stale. The socket
            // is the only thing that knows; polling for it would be a request a
            // second for an event that happens twice an hour.
            let feed = feed
            let fetch = fetch
            live.onGenerationFinished = { Task { await feed.refreshTop(fetch) } }
        }
        .fullScreenCover(item: $opened) { entry in
            ViewerView(client: client, feed: feed, start: entry)
        }
    }

    /// Pages from this server, as the feed asks for them.
    private var fetch: GalleryFeed.Fetch {
        { [client] cursor in try await client.gallery(cursor: cursor) }
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(feed.entries) { entry in
                    Button { opened = entry } label: {
                        RemoteImage(
                            // Always the preview in a grid: a screenful of
                            // full-size renders is tens of megabytes over the
                            // network and hundreds decoded.
                            client: client,
                            image: entry.image,
                            preview: true
                        )
                        .aspectRatio(1, contentMode: .fill)
                        .clipped()
                        .overlay(alignment: .bottomLeading) { marks(entry.image) }
                    }
                    .buttonStyle(.plain)
                    .task {
                        // The last tile coming into view is the signal to fetch
                        // the next page — no button, no page numbers.
                        if entry.id == feed.entries.last?.id { await feed.loadMore(fetch) }
                    }
                }
            }
            if feed.loadingMore {
                ProgressView().padding()
            }
        }
    }

    /// What is worth saying over a thumbnail: rated, kept, or moving.
    @ViewBuilder
    private func marks(_ image: ComfyImage) -> some View {
        HStack(spacing: 3) {
            if image.rating > 0 {
                Label("\(image.rating)", systemImage: "star.fill")
            }
            if image.kept {
                Image(systemName: "tray.and.arrow.down.fill")
            }
            if !image.isStill {
                Image(systemName: "play.fill")
            }
        }
        .font(.caption2)
        .labelStyle(.titleAndIcon)
        .padding(3)
        .background(.black.opacity(0.55), in: .rect(cornerRadius: 4))
        .foregroundStyle(.white)
        .padding(3)
    }
}
