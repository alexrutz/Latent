import SwiftUI

@main
@MainActor
struct LatentApp: App {
    @State private var session = Session()

    var body: some Scene {
        WindowGroup {
            RootView(session: session)
                // Dark, always. Every screen here is either a picture on black
                // or a form leading to one, and a light gallery is a wall of
                // white gutters between the things you came to look at.
                .preferredColorScheme(.dark)
        }
    }
}

/// Signed in or not, and nothing else.
struct RootView: View {
    let session: Session
    @Environment(\.scenePhase) private var phase

    var body: some View {
        Group {
            switch session.state {
            case .signedOut:
                SignInView(session: session)
            case .connecting:
                ProgressView()
            case .signedIn(let client):
                TabView {
                    GalleryView(client: client, live: session.live)
                        .tabItem { Label("Gallery", systemImage: "photo.on.rectangle") }
                    GenerateView(client: client, live: session.live)
                        .tabItem { Label("Generate", systemImage: "wand.and.stars") }
                    QueueView(client: client, live: session.live, onSignOut: session.signOut)
                        .tabItem { Label("Queue", systemImage: "list.bullet") }
                }
            }
        }
        .task { await session.restore() }
        .onChange(of: phase) { _, phase in
            /*
             * The socket goes when the app does, and comes back with it.
             *
             * iOS closes it on the way to the background anyway; reconnecting
             * on the way back is what makes the progress bar right the moment
             * the app is opened rather than a few seconds later.
             */
            guard let client = session.client else { return }
            if phase == .active {
                session.live.connect(client)
            } else {
                session.live.disconnect()
            }
        }
    }
}
