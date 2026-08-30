import Foundation
import Observation

/// The running job, as the server reports it.
///
/// Polling would work and would be wrong: a render sends a progress event per
/// sampler step, and the difference between a bar that moves and a number that
/// jumps every two seconds is the whole reason to watch at all.
///
/// Reconnects on its own. A phone drops the socket every time it locks, and a
/// live view that needs the screen reopening to come back is not live.
@Observable
@MainActor
final class LiveSocket {
    private(set) var state: LiveState?
    private(set) var queue: QueueState?

    private var task: URLSessionWebSocketTask?
    private var listener: Task<Void, Never>?
    /// Grows while the far end stays unreachable, so a server that is off does
    /// not turn into a reconnect every second for as long as the app is open.
    private var backoff: Duration = .seconds(1)

    private let session = URLSession(configuration: .default)

    func connect(_ client: LatentClient) {
        disconnect()
        let request = client.liveSocketRequest

        listener = Task { [weak self] in
            while !Task.isCancelled {
                let closed = await self?.pump(request) ?? true
                guard !Task.isCancelled, closed else { return }

                let wait = self?.backoff ?? .seconds(1)
                try? await Task.sleep(for: wait)
                // Doubling to a ceiling: long enough that a server left off all
                // evening costs nothing, short enough that one that comes back
                // is picked up within half a minute.
                self?.backoff = min(wait * 2, .seconds(30))
            }
        }
    }

    func disconnect() {
        listener?.cancel()
        listener = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    /// One connection, from open to close. Returns `true` if it should be retried.
    private func pump(_ request: URLRequest) async -> Bool {
        let socket = session.webSocketTask(with: request)
        task = socket
        socket.resume()

        while !Task.isCancelled {
            do {
                let message = try await socket.receive()
                // A frame arriving is the proof the server is there, so the
                // wait for the *next* reconnect starts short again.
                backoff = .seconds(1)
                apply(message)
            } catch {
                // Every close looks the same from here — the server restarting,
                // the phone locking, the network changing — and the answer to
                // all of them is to open it again.
                socket.cancel(with: .abnormalClosure, reason: nil)
                if task === socket { task = nil }
                state = nil
                return true
            }
        }
        return false
    }

    private func apply(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .data(let value): data = value
        case .string(let text): data = Data(text.utf8)
        @unknown default: data = nil
        }

        guard let data, let event = ServerEvent(json: data) else { return }
        switch event {
        case .state(let value): state = value
        case .queue(let value): queue = value
        // A finished run: the gallery is stale, and whoever is showing it wants
        // to know. Nothing here holds the gallery, so it is left to the screen.
        case .generation: onGenerationFinished?()
        }
    }

    /// Called when a run produces something. Set by whoever is listing them.
    var onGenerationFinished: (() -> Void)?
}
