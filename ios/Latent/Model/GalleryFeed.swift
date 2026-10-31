import Foundation
import Observation

/// The gallery's list, and every way it changes.
///
/// Out of the view because the list has three writers that used to trip over
/// each other — the first load, the next page as you scroll, and a run
/// finishing — and the view replaced the whole list with page one on the last
/// of those. A run finishing while you were ten pages down took you back to the
/// top and threw the other nine away; two of them close together could also
/// land in the wrong order and leave the older answer on screen.
///
/// Foundation only, so it can be checked without a Mac.
@Observable
@MainActor
final class GalleryFeed {
    typealias Fetch = (_ cursor: String?) async throws -> GalleryPage

    private(set) var entries: [GalleryEntry] = []
    private(set) var cursor: String?
    /// A load from nothing: the first one, or pull to refresh.
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var problem: String?

    /// Bumped by every start-over, so an answer to a question asked before
    /// it is recognised as stale and dropped rather than written over the new list.
    private var epoch = 0
    /// One refresh of the top at a time, and at most one more after it.
    private var refreshing = false
    private var refreshAgain = false

    /// Start over from page one.
    func reload(_ fetch: Fetch) async {
        epoch += 1
        let asked = epoch
        loading = true
        defer { if asked == epoch { loading = false } }
        do {
            let page = try await fetch(nil)
            guard asked == epoch else { return }
            entries = Self.flatten(page.items)
            cursor = page.nextCursor
            problem = nil
        } catch is CancellationError {
            return
        } catch {
            guard asked == epoch else { return }
            problem = error.localizedDescription
        }
    }

    /// Bring the newest page in without losing what is below it.
    ///
    /// What a finished run, or coming back to the tab, needs: the top of the
    /// list is out of date and the rest of it is not.
    ///
    /// A burst — a batch of four finishing one after another — becomes one
    /// request in flight and one more after it, never four racing each other.
    func refreshTop(_ fetch: Fetch) async {
        if entries.isEmpty && !loading {
            await reload(fetch)
            return
        }
        if refreshing {
            refreshAgain = true
            return
        }
        refreshing = true
        defer { refreshing = false }

        repeat {
            refreshAgain = false
            let asked = epoch
            guard let page = try? await fetch(nil), asked == epoch else { return }
            // Merged on arrival rather than on asking, so a page loaded
            // further down in the meantime is kept.
            let merged = Self.merge(top: page, into: entries, cursor: cursor)
            entries = merged.entries
            cursor = merged.cursor
        } while refreshAgain
    }

    /// The page after the last one shown.
    func loadMore(_ fetch: Fetch) async {
        guard let cursor, !loading, !loadingMore else { return }
        let asked = epoch
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await fetch(cursor)
            guard asked == epoch, cursor == self.cursor else { return }
            let known = Set(entries.map(\.id))
            entries.append(contentsOf: Self.flatten(page.items).filter { !known.contains($0.id) })
            self.cursor = page.nextCursor
        } catch is CancellationError {
            return
        } catch {
            // A page that will not load is not worth an error over the whole
            // screen; the pictures already on it are still good.
            guard asked == epoch else { return }
            self.cursor = nil
        }
    }

    /// One picture's current state.
    func entry(_ id: String) -> GalleryEntry? {
        entries.first { $0.id == id }
    }

    /// Change one picture in place.
    ///
    /// Rather than reloading: the change is already known, and a refetch would
    /// move the scroll position under whoever just tapped a star.
    ///
    /// The change is a function of the picture as it is *now*, not a copy of it
    /// taken earlier — which is what lets a failed rating be taken back without
    /// also taking back the keep tapped after it.
    func revise(_ id: String, _ change: (ComfyImage) -> ComfyImage?) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        let entry = entries[index]
        guard let image = change(entry.image) else { return }
        entries[index] = GalleryEntry(record: entry.record, image: image)
    }

    // MARK: - Pure parts

    /// Runs to pictures.
    nonisolated static func flatten(_ records: [GenerationRecord]) -> [GalleryEntry] {
        records.flatMap { record in
            record.images.map { GalleryEntry(record: record, image: $0) }
        }
    }

    /**
     * A fresh first page, laid over a list that may run much further.
     *
     * The page is the truth about everything as new as its oldest run: those
     * runs replace what was there (a run that had no pictures yet now has
     * them; a deleted one is gone), and what is older than all of it is kept,
     * in order, below. Runs on the page are newest first, as the server sends
     * them.
     *
     * The cursor goes with what is kept. When older entries survive below the
     * page, the old cursor still points past the last of them; when nothing
     * survives, the list is just this page and so is the cursor.
     */
    nonisolated static func merge(
        top page: GalleryPage,
        into existing: [GalleryEntry],
        cursor: String?
    ) -> (entries: [GalleryEntry], cursor: String?) {
        let top = flatten(page.items)
        guard let oldest = page.items.last else {
            // Page one is empty: there is nothing at all any more.
            return ([], page.nextCursor)
        }
        let onPage = Set(page.items.map(\.id))
        let older = existing.filter { entry in
            !onPage.contains(entry.record.id) && entry.record.createdAt <= oldest.createdAt
        }
        if older.isEmpty { return (top, page.nextCursor) }
        return (top + older, cursor)
    }
}
