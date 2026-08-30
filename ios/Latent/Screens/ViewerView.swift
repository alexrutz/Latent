import SwiftUI

/// One picture, full screen, with the next one a swipe away.
///
/// A `TabView` in page mode rather than a gesture written by hand: paging
/// between full-screen pictures is what it is for, and it brings the rubber
/// banding at the ends and the momentum with it.
struct ViewerView: View {
    let client: LatentClient
    let entries: [GalleryEntry]
    let start: GalleryEntry
    /// A rating or a keep, back to whoever is listing these.
    let onChanged: (GalleryEntry) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var current: String = ""
    /// Every control on this screen floats over the picture, and on some
    /// pictures that is exactly where the thing you are looking at is.
    @State private var controlsVisible = true
    @State private var problem: String?

    private var entry: GalleryEntry? {
        entries.first { $0.id == current }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $current) {
                ForEach(entries) { entry in
                    RemoteImage(
                        url: client.imageURL(entry.image),
                        token: client.token,
                        contentMode: .fit
                    )
                    .tag(entry.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()

            if controlsVisible {
                controls
            }
        }
        .statusBarHidden(!controlsVisible)
        .onAppear { current = start.id }
        // A tap anywhere puts the controls away, and brings them back. The one
        // gesture that has to keep working while they are gone, since the button
        // that would undo it went with them.
        .onTapGesture { withAnimation(.easeInOut(duration: 0.15)) { controlsVisible.toggle() } }
    }

    private var controls: some View {
        VStack {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.title3)
                }
                Spacer()
                if let entry {
                    Text(entry.record.title)
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(.white.opacity(0.7))
                }
                Spacer()
                // A placeholder the width of the close button, so the title
                // sits in the middle of the screen rather than of what is left.
                Image(systemName: "xmark").font(.title3).opacity(0)
            }
            .padding(.horizontal)

            Spacer()

            if let entry {
                VStack(spacing: 14) {
                    if let problem {
                        Text(problem).font(.caption).foregroundStyle(.red)
                    }
                    stars(for: entry)
                    keep(entry)
                }
                .padding(.bottom, 24)
            }
        }
        .foregroundStyle(.white)
        .shadow(radius: 6)
        .transition(.opacity)
    }

    /// Five stars, and tapping the one already set clears it.
    ///
    /// Without that there is no way back to unrated, which is a state you want
    /// after a second look.
    private func stars(for entry: GalleryEntry) -> some View {
        HStack(spacing: 6) {
            ForEach(1...5, id: \.self) { star in
                Button {
                    rate(entry, stars: entry.image.rating == star ? 0 : star)
                } label: {
                    Image(systemName: star <= entry.image.rating ? "star.fill" : "star")
                        .font(.title2)
                        .foregroundStyle(star <= entry.image.rating ? .yellow : .white.opacity(0.6))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func keep(_ entry: GalleryEntry) -> some View {
        Button {
            setKept(entry, kept: !entry.image.kept)
        } label: {
            Label(
                entry.image.kept ? "Kept" : "Keep",
                systemImage: entry.image.kept ? "tray.and.arrow.down.fill" : "tray.and.arrow.down"
            )
            .font(.subheadline)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.white.opacity(0.15), in: .capsule)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Changes

    /*
     * Shown at once, then sent.
     *
     * A star that waits for a round trip before it fills in feels broken on a
     * home network with a sleeping server, and the request nearly always
     * succeeds. When it does not, the value goes back and says why — which is
     * the honest version of an optimistic update.
     */
    private func rate(_ entry: GalleryEntry, stars: Int) {
        let previous = entry.image.rating
        apply(entry) { $0.rating = stars }
        Task {
            do {
                try await client.rate(entry.image, in: entry.record.id, stars: stars)
                problem = nil
            } catch LatentClient.Failure.savedButNotArchived(let message) {
                // The star stuck; only the local copy did not. Taking it back
                // off would be the one outcome the server avoids on purpose.
                problem = message
            } catch {
                apply(entry) { $0.rating = previous }
                problem = error.localizedDescription
            }
        }
    }

    private func setKept(_ entry: GalleryEntry, kept: Bool) {
        apply(entry) { $0.kept = kept }
        Task {
            do {
                try await client.keep(entry.image, in: entry.record.id, kept: kept)
                problem = nil
            } catch LatentClient.Failure.savedButNotArchived(let message) {
                problem = message
            } catch {
                apply(entry) { $0.kept = !kept }
                problem = error.localizedDescription
            }
        }
    }

    /// Rebuild the entry with one field changed and hand it back up.
    private func apply(_ entry: GalleryEntry, _ change: (inout MutableImage) -> Void) {
        var mutable = MutableImage(entry.image)
        change(&mutable)
        onChanged(GalleryEntry(record: entry.record, image: mutable.build()))
    }

    /// `ComfyImage` is decoded from the server and has no business being
    /// mutable; this is the one place a copy is made with a field changed.
    private struct MutableImage {
        var rating: Int
        var kept: Bool
        private let source: ComfyImage

        init(_ image: ComfyImage) {
            source = image
            rating = image.rating
            kept = image.kept
        }

        func build() -> ComfyImage {
            ComfyImage(
                id: source.id,
                filename: source.filename,
                subfolder: source.subfolder,
                type: source.type,
                rating: rating,
                kept: kept,
                width: source.width,
                height: source.height,
                kind: source.kind
            )
        }
    }
}
