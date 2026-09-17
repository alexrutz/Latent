import Foundation

/// Everything this app knows how to ask a Latent server.
///
/// One place, because a native client's failure mode is a request that quietly
/// forgets the token and gets a 401 that looks like "signed out" — so the header
/// goes on in exactly one function and nothing else builds a request.
///
/// A `struct` rather than a singleton: the address and the token are what it is,
/// and signing in produces a new one rather than mutating a shared thing that
/// half the screens are already holding.
struct LatentClient {
    /// The contract version this app was written against. See `AppInfo`.
    static let apiVersion = 1

    let baseURL: URL
    let token: String?

    /// One session for the whole app, not one per client.
    ///
    /// A `URLSession` owns a connection pool, and building a new one every time
    /// this struct is copied would throw away the pool along with it — a fresh
    /// TCP handshake per request, to a machine on the same network.
    private static let shared: URLSession = {
        let config = URLSessionConfiguration.default
        // A home server, sometimes on a laptop that has gone to sleep. Fail in
        // a few seconds rather than leaving a spinner up for a minute.
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private var session: URLSession { Self.shared }

    init(baseURL: URL, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
    }

    /// The same client, signed in.
    func authenticated(with token: String) -> LatentClient {
        LatentClient(baseURL: baseURL, token: token)
    }

    // MARK: - Errors

    enum Failure: LocalizedError {
        case unreachable(String)
        case notLatent
        case tooOld(server: Int, needs: Int)
        case unauthorised
        /**
         * The change stuck; the copy into the local archive did not.
         *
         * `423` off a rating or a keep is a particular thing and not a plain
         * failure: the server writes the value first and only then finds the
         * archive locked, so the star *is* set. Treating it like any other
         * error would take the star back off — which is the one outcome the
         * server's own comment says it went out of its way to avoid.
         */
        case savedButNotArchived(String)
        case server(status: Int, message: String)

        var errorDescription: String? {
            switch self {
            case .unreachable(let detail):
                return "Could not reach that address. \(detail)"
            case .notLatent:
                return "Something answered, but it is not a Latent server."
            case .tooOld(let server, let needs):
                return "That server speaks API version \(server); this app needs \(needs) or later. Update Latent."
            case .unauthorised:
                return "The password was not accepted, or this device has been signed out."
            case .savedButNotArchived(let message):
                return message.isEmpty ? "Saved, but no local copy was made." : message
            case .server(let status, let message):
                return message.isEmpty ? "The server answered \(status)." : message
            }
        }
    }

    // MARK: - Requests

    /// The address of one route on this server.
    ///
    /// Built by hand rather than with `appendingPathComponent`, which doubles
    /// the separator when the component already starts with one — every path
    /// here does — and which would drop a base URL's own path if Latent is
    /// behind a reverse proxy at, say, `https://home.example/latent`.
    func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return baseURL
        }
        var base = components.path
        while base.hasSuffix("/") { base.removeLast() }
        components.path = base + (path.hasPrefix("/") ? path : "/" + path)
        if !query.isEmpty { components.queryItems = query }
        return components.url ?? baseURL
    }

    /// The one place a request is built, and the only place the token goes on.
    private func request(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// Send it, and turn everything that can go wrong into a `Failure`.
    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Failure.unreachable(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else { return data }
        if http.statusCode == 401 { throw Failure.unauthorised }
        guard (200..<300).contains(http.statusCode) else {
            // The server puts a readable sentence in `error` on every failure
            // path it controls; anything else is a bare status code.
            struct Problem: Decodable { let error: String? }
            let message = (try? JSONDecoder().decode(Problem.self, from: data))?.error ?? ""
            if http.statusCode == 423 { throw Failure.savedButNotArchived(message) }
            throw Failure.server(status: http.statusCode, message: message)
        }
        return data
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type) async throws -> T {
        let data = try await send(request(path, query: query))
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - Signing in

    /// Ask what this address is before offering to sign in to it.
    ///
    /// Worth a round trip of its own: typing an address wrong is the commonest
    /// thing that goes wrong here, and "that is not a Latent server" is a far
    /// better answer than a password box that rejects every password.
    func discover() async throws -> AppInfo {
        let info = try await get("/api/app", as: AppInfo.self)
        guard info.app == "latent" else { throw Failure.notLatent }
        guard info.isCompatible else {
            throw Failure.tooOld(server: info.api.version, needs: Self.apiVersion)
        }
        return info
    }

    /// Sign in and keep the token. See the server's `issueToken`.
    func signIn(password: String) async throws -> String {
        struct Body: Encodable {
            let password: String
            let issueToken = true
        }
        struct Reply: Decodable { let token: String? }

        let data = try await send(
            request("/api/auth/login", method: "POST", body: try JSONEncoder().encode(Body(password: password)))
        )
        guard let token = try JSONDecoder().decode(Reply.self, from: data).token, !token.isEmpty else {
            // The server only withholds it when `issueToken` did not arrive,
            // which would be this app's own bug rather than a wrong password.
            throw Failure.server(status: 200, message: "The server signed in but issued no token.")
        }
        return token
    }

    func status() async throws -> StatusResponse {
        try await get("/api/status", as: StatusResponse.self)
    }

    // MARK: - Gallery

    func gallery(cursor: String? = nil, limit: Int = 30) async throws -> GalleryPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await get("/api/gallery", query: query, as: GalleryPage.self)
    }

    /// Where the bytes for one picture live.
    ///
    /// `preview` asks the server for a small copy. A grid must always use it:
    /// a screen of full-size renders is tens of megabytes over a home Wi-Fi and
    /// hundreds of megabytes of decoded bitmap in memory, which is exactly what
    /// thumbnails exist to prevent.
    func imageURL(_ image: ComfyImage, preview: Bool = false) -> URL {
        var query = [
            URLQueryItem(name: "filename", value: image.filename),
            URLQueryItem(name: "subfolder", value: image.subfolder),
            URLQueryItem(name: "type", value: image.type),
        ]
        // By row id where there is one: a name is not a key, and asking by name
        // alone is how a thumbnail ends up showing a different picture.
        if let id = image.id { query.append(URLQueryItem(name: "id", value: String(id))) }
        if preview { query.append(URLQueryItem(name: "preview", value: "webp;70")) }
        return url("/api/view", query: query)
    }

    func rate(_ image: ComfyImage, in generationId: String, stars: Int) async throws {
        struct Body: Encodable {
            let image: Ref
            let rating: Int
            struct Ref: Encodable {
                let id: Int?
                let filename: String
                let subfolder: String
                let type: String
            }
        }
        let body = Body(
            image: .init(id: image.id, filename: image.filename, subfolder: image.subfolder, type: image.type),
            rating: stars
        )
        _ = try await send(
            request("/api/gallery/\(generationId)/rating", method: "PUT", body: try JSONEncoder().encode(body))
        )
    }

    /// Keep a picture without passing judgement on it — see the server's route.
    func keep(_ image: ComfyImage, in generationId: String, kept: Bool) async throws {
        struct Body: Encodable {
            let image: Ref
            let kept: Bool
            struct Ref: Encodable {
                let id: Int?
                let filename: String
                let subfolder: String
                let type: String
            }
        }
        let body = Body(
            image: .init(id: image.id, filename: image.filename, subfolder: image.subfolder, type: image.type),
            kept: kept
        )
        _ = try await send(
            request("/api/gallery/\(generationId)/keep", method: "PUT", body: try JSONEncoder().encode(body))
        )
    }

    // MARK: - Generating

    func workflows() async throws -> [WorkflowSummary] {
        try await get("/api/workflows", as: [WorkflowSummary].self)
    }

    func workflow(_ id: String) async throws -> WorkflowDetail {
        try await get("/api/workflows/\(id)", as: WorkflowDetail.self)
    }

    /// Queue a render of `workflow` with `prompt` in its prompt field.
    ///
    /// The values sent are the workflow's own last ones with the prompt written
    /// over the top. Sending only the prompt would reset every other setting to
    /// the graph's defaults — the steps, the model, the size — which is not what
    /// "make one of these with this prompt" means to anybody.
    func generate(workflow: WorkflowDetail, prompt: String, batchCount: Int = 1) async throws -> GenerateResponse {
        struct Body: Encodable {
            let workflowId: String
            let values: [String: JSONValue]
            let randomizeSeeds = true
            let batchCount: Int
        }

        var values = workflow.lastValues
        if let field = workflow.promptField {
            values[field.id] = .string(prompt)
        }

        let data = try await send(
            request(
                "/api/generate",
                method: "POST",
                body: try JSONEncoder().encode(
                    Body(workflowId: workflow.id, values: values, batchCount: batchCount)
                )
            )
        )
        return try JSONDecoder().decode(GenerateResponse.self, from: data)
    }

    // MARK: - Queue

    func queue() async throws -> QueueState {
        try await get("/api/queue", as: QueueState.self)
    }

    func cancel(promptId: String) async throws {
        _ = try await send(request("/api/queue/\(promptId)", method: "DELETE"))
    }

    /// Clear everything still waiting. Leaves the running job alone.
    func cancelAll() async throws {
        _ = try await send(request("/api/queue", method: "DELETE"))
    }

    /// Stop the job actually running, which `DELETE /api/queue/:id` does not.
    func interrupt() async throws {
        _ = try await send(request("/api/queue/interrupt", method: "POST"))
    }

    // MARK: - Live

    /// A handshake request for `/api/ws`, with the token already on it.
    ///
    /// The server checks the same header on the upgrade that it checks on every
    /// other route, so live progress needs nothing a plain request does not.
    var liveSocketRequest: URLRequest {
        var components = URLComponents(url: url("/api/ws"), resolvingAgainstBaseURL: false)
        components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        var request = URLRequest(url: components?.url ?? url("/api/ws"))
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }
}

extension WorkflowDetail {
    /// The field a typed prompt belongs in, if this workflow has one.
    ///
    /// By role rather than by name: the server has already worked out which of
    /// a graph's text boxes is the description of the picture, walking back from
    /// the sampler's positive conditioning. Guessing from `label` here would be
    /// a worse copy of that, and would find the negative prompt half the time.
    var promptField: ParamField? {
        schema.fields.first { $0.role == "prompt" && $0.hidden != true }
    }
}
