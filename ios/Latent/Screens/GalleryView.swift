import SwiftUI

/// Everything that has been made, newest first.
///
/// A flat grid of pictures rather than a list of runs. A batch of four is not a
/// boundary anybody is thinking about when they are looking for one image, and
/// grouping by run puts a heading between every four thumbnails.
struct GalleryView: View {
    let client: LatentClient
    let live: LiveSocket

    @State private var entries: [GalleryEntry] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var problem: String?
    @State private var opened: GalleryEntry?

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

    var body: some View {
        NavigationStack {
            Group {
                if entries.isEmpty && loading {
                    ProgressView()
                } else if entries.isEmpty {
                    ContentUnavailableView(
                        "Nothing yet",
                        systemImage: "photo.on.rectangle",
                        description: Text(problem ?? "Renders appear here as soon as they finish.")
                    )
                } else {
                    grid
                }
            }
            .navigationTitle("Gallery")
            .refreshable { await reload() }
        }
        .task { await reload() }
        .onAppear {
            // A run finishing means this list is stale. The socket is the only
            // thing that knows; polling for it would be a request a second for
            // an event that happens twice an hour.
            live.onGenerationFinished = { Task { await reload() } }
        }
        .fullScreenCover(item: $opened) { entry in
            ViewerView(
                client: client,
                entries: entries,
                start: entry,
                onChanged: { updated in replace(updated) }
            )
        }
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(entries) { entry in
                    Button { opened = entry } label: {
                        RemoteImage(
                            // Always the preview in a grid: a screenful of
                            // full-size renders is tens of megabytes over the
                            // network and hundreds decoded.
                            url: client.imageURL(entry.image, preview: true),
                            token: client.token
                        )
                        .aspectRatio(1, contentMode: .fill)
                        .clipped()
                        .overlay(alignment: .bottomLeading) { marks(entry.image) }
                    }
                    .buttonStyle(.plain)
                    .task {
                        // The last tile coming into view is the signal to fetch
                        // the next page — no button, no page numbers.
                        if entry.id == entries.last?.id { await loadMore() }
                    }
                }
            }
            if loading && !entries.isEmpty {
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

    // MARK: - Loading

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            let page = try await client.gallery()
            entries = flatten(page.items)
            cursor = page.nextCursor
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard let cursor, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.gallery(cursor: cursor)
            entries.append(contentsOf: flatten(page.items))
            self.cursor = page.nextCursor
        } catch {
            // A page that will not load is not worth an error over the whole
            // screen; the pictures already on it are still good.
            self.cursor = nil
        }
    }

    /// Runs to pictures, dropping the ones with nothing to show.
    private func flatten(_ records: [GenerationRecord]) -> [GalleryEntry] {
        records.flatMap { record in
            record.images.map { GalleryEntry(record: record, image: $0) }
        }
    }

    /// Put a rating or a keep back into the list under it.
    ///
    /// Rather than reloading the page: the change is already known, and a
    /// refetch would move the scroll position under whoever just tapped a star.
    private func replace(_ entry: GalleryEntry) {
        guard let index = entries.firstIndex(where: { $0.id == entry.id }) else { return }
        entries[index] = entry
    }
}
