import Foundation
import Observation

/// Signed in or not, and everything that follows from it.
///
/// One object rather than each screen holding its own client: signing out has
/// to reach all of them at once, and a screen still holding a client with a
/// dead token would sit there retrying a request that can only ever fail.
@Observable
@MainActor
final class Session {
    enum State {
        case signedOut
        /// Reaching the address and asking what it is, before anything is shown.
        case connecting
        case signedIn(LatentClient)
    }

    private(set) var state: State = .signedOut
    private(set) var problem: String?

    let live = LiveSocket()

    var client: LatentClient? {
        if case .signedIn(let client) = state { return client }
        return nil
    }

    // MARK: - Coming back

    /// Pick up where the last launch left off, without asking again.
    ///
    /// The token outlives the app, so the usual launch has nothing to ask: the
    /// address is in defaults and the token is in the Keychain. It is still
    /// checked against the server rather than trusted — a password changed on
    /// another device invalidates it, and the honest place to find that out is
    /// here rather than on the first thing the user taps.
    func restore() async {
        guard let url = Credentials.serverURL, let token = Credentials.token else { return }

        state = .connecting
        let client = LatentClient(baseURL: url, token: token)
        do {
            let status = try await client.status()
            guard status.authenticated else {
                Credentials.token = nil
                state = .signedOut
                return
            }
            enter(client)
        } catch LatentClient.Failure.unauthorised {
            Credentials.token = nil
            state = .signedOut
        } catch {
            /*
             * Unreachable is not signed out.
             *
             * The commonest reason a launch fails is that the machine is asleep
             * or the phone is on mobile data, and throwing the token away for
             * that would mean typing the password again every time — for a
             * server that was never in doubt.
             */
            /*
             * So the stored token is kept *and used*: signed in, with the
             * screens saying the server cannot be reached and the live socket
             * retrying until it can. Showing the password screen instead threw
             * the token away in practice — nothing retried with it, and the
             * only way past was typing the password again.
             */
            enter(client)
            problem = error.localizedDescription
        }
    }

    // MARK: - Signing in

    func signIn(address: String, password: String) async {
        problem = nil
        guard let url = Self.normalise(address) else {
            problem = "That does not look like an address. Try something like http://192.168.1.20:8080"
            return
        }

        state = .connecting
        let anonymous = LatentClient(baseURL: url)
        do {
            /*
             * What is it, before offering it a password.
             *
             * The answer is thrown away — it is asked for the checks it makes
             * on the way: that something is there, that it is Latent, and that
             * it is new enough to speak to. A wrong address is the commonest
             * mistake here, and "that is not a Latent server" is a far better
             * answer than a password box that rejects every password.
             */
            _ = try await anonymous.discover()

            let token = try await anonymous.signIn(password: password)
            Credentials.serverURL = url
            Credentials.token = token
            enter(anonymous.authenticated(with: token))
        } catch {
            problem = error.localizedDescription
            state = .signedOut
        }
    }

    func signOut() {
        live.disconnect()
        Credentials.clear()
        problem = nil
        state = .signedOut
    }

    private func enter(_ client: LatentClient) {
        var client = client
        // A 401 from any screen, later, signs out everywhere at once.
        client.onUnauthorised = { [weak self] in
            Task { @MainActor in self?.expired() }
        }
        state = .signedIn(client)
        problem = nil
        live.connect(client)
    }

    /// The token stopped working — the password was changed somewhere else.
    private func expired() {
        guard client != nil else { return }
        signOut()
        problem = "Signed out: the password was changed, so sign in again with the new one."
    }

    // MARK: - Addresses

    /// What somebody types, as a URL.
    ///
    /// Typing `192.168.1.20:8080` into a phone keyboard is what actually
    /// happens, and refusing it because it has no scheme is a worse app for no
    /// reason. `http` rather than `https` because this is a machine on a home
    /// network; anybody who has put it behind a certificate will type the
    /// scheme, and that is respected.
    static func normalise(_ text: String) -> URL? {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") { trimmed = "http://\(trimmed)" }
        // A trailing slash would make every path double up.
        while trimmed.hasSuffix("/") { trimmed.removeLast() }

        guard let url = URL(string: trimmed), url.host != nil else { return nil }
        return url
    }
}
