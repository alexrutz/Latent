import AVKit
import SwiftUI

/// A clip or a sound, full screen: the poster first, the file when asked for.
///
/// Fetched to a file before playing, because `AVPlayer` cannot be handed the
/// token — see `LatentClient.download`. That costs the whole file up front
/// rather than streaming it, so it waits for Play: paging past a clip in the
/// viewer must not download it, which is exactly what the old picture view
/// did, only to fail to decode it as a picture.
@MainActor
struct MediaPlayer: View {
    let client: LatentClient
    let image: ComfyImage

    @State private var wantsPlay = false
    @State private var player: AVPlayer?
    @State private var file: URL?
    @State private var problem: String?

    var body: some View {
        ZStack {
            if let player {
                VideoPlayer(player: player) {
                    // A sound has nothing to show over the controls but what it is.
                    if image.kind == "audio" {
                        Image(systemName: "waveform")
                            .font(.system(size: 64))
                            .foregroundStyle(.white.opacity(0.6))
                    }
                }
            } else {
                RemoteImage(client: client, image: image, preview: true, contentMode: .fit)
                VStack(spacing: 10) {
                    Button { wantsPlay = true } label: {
                        if wantsPlay {
                            ProgressView().controlSize(.large).tint(.white)
                        } else {
                            Image(systemName: "play.circle.fill")
                                .font(.system(size: 64))
                                .symbolRenderingMode(.hierarchical)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(wantsPlay)
                    if let problem {
                        Text(problem).font(.caption).foregroundStyle(.red)
                    }
                }
                .foregroundStyle(.white)
            }
        }
        // Structured, so paging away part way through calls the download off
        // rather than leaving it to finish for a page nobody is looking at.
        .task(id: wantsPlay) {
            guard wantsPlay, player == nil else { return }
            await fetch()
        }
        .onDisappear(perform: stop)
    }

    private func fetch() async {
        problem = nil
        do {
            let downloaded = try await client.download(image)
            guard !Task.isCancelled else {
                try? FileManager.default.removeItem(at: downloaded)
                return
            }
            file = downloaded
            let player = AVPlayer(url: downloaded)
            self.player = player
            player.play()
        } catch is CancellationError {
            return
        } catch {
            problem = error.localizedDescription
            wantsPlay = false
        }
    }

    /// Off screen: stop the sound, and give the file back.
    private func stop() {
        player?.pause()
        player = nil
        wantsPlay = false
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
    }
}
