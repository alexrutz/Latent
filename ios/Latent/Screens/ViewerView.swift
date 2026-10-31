import SwiftUI

/// One picture, full screen, with the next one a swipe away.
///
/// A `TabView` in page mode rather than a gesture written by hand: paging
/// between full-screen pictures is what it is for, and it brings the rubber
/// banding at the ends and the momentum with it.
@MainActor
struct ViewerView: View {
    let client: LatentClient
    /// The gallery's own list, read live rather than copied in: a change made
    /// here shows in the grid underneath, and one that has to be taken back is
    /// taken back from what the list holds now.
    let feed: GalleryFeed
    let start: GalleryEntry

    @Environment(\.dismiss) private var dismiss
    @State private var current: String = ""
    /// Every control on this screen floats over the picture, and on some
    /// pictures that is exactly where the thing you are looking at is.
    @State private var controlsVisible = true
    @State private var problem: String?

    private var entry: GalleryEntry? {
        feed.entry(current)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $current) {
                ForEach(feed.entries) { entry in
                    Group {
                        if entry.image.isStill {
                            RemoteImage(client: client, image: entry.image, contentMode: .fit)
                        } else {
                            MediaPlayer(client: client, image: entry.image)
                        }
                    }
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
     *
     * Going back means this one field, from the list as it is when the answer
     * arrives, and only if it still holds what this tap set. It used to put
     * back the whole picture as it was at the tap — so a keep tapped while a
     * star was in flight was undone by the star failing, and a second star
     * tapped meanwhile was overwritten by the first one's old value.
     */
    private func rate(_ entry: GalleryEntry, stars: Int) {
        let previous = entry.image.rating
        feed.revise(entry.id) { $0.with(rating: stars) }
        Task {
            do {
                try await client.rate(entry.image, in: entry.record.id, stars: stars)
                problem = nil
            } catch LatentClient.Failure.savedButNotArchived(let message) {
                // The star stuck; only the local copy did not. Taking it back
                // off would be the one outcome the server avoids on purpose.
                problem = message
            } catch {
                feed.revise(entry.id) { $0.rating == stars ? $0.with(rating: previous) : nil }
                problem = error.localizedDescription
            }
        }
    }

    private func setKept(_ entry: GalleryEntry, kept: Bool) {
        feed.revise(entry.id) { $0.with(kept: kept) }
        Task {
            do {
                try await client.keep(entry.image, in: entry.record.id, kept: kept)
                problem = nil
            } catch LatentClient.Failure.savedButNotArchived(let message) {
                problem = message
            } catch {
                feed.revise(entry.id) { $0.kept == kept ? $0.with(kept: !kept) : nil }
                problem = error.localizedDescription
            }
        }
    }
}
