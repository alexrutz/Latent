import Foundation

/// What Latent sends back, as much of it as this app reads.
///
/// A deliberate subset. The server's `GenerationRecord` carries a dozen fields
/// this app has no screen for, and decoding them would mean a struct that has
/// to be kept in step with a codebase it cannot see — so every type here lists
/// what it actually uses and lets `JSONDecoder` drop the rest. Adding a field
/// on the server therefore cannot break this app, which is the whole point of
/// the version in `/api/app` being about *removals*.

// MARK: - Discovery

/// `GET /api/app` — the one thing reachable without a credential.
struct AppInfo: Decodable {
    struct API: Decodable {
        let version: Int
    }

    struct Auth: Decodable {
        let schemes: [String]
        let setupRequired: Bool
    }

    let app: String
    let api: API
    let auth: Auth

    /// Whether this build can talk to that server at all.
    ///
    /// The contract version is bumped only when something a client depends on
    /// is *removed* or changes meaning, so a server ahead of this app is fine
    /// and a server behind it is not.
    var isCompatible: Bool { app == "latent" && api.version >= LatentClient.apiVersion }
}

// MARK: - Status

struct StatusResponse: Decodable {
    let authenticated: Bool
    let setupRequired: Bool
    let comfyOnline: Bool
    let activeConnectionName: String?
}

// MARK: - Workflows

struct WorkflowSummary: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let visible: Bool
    let producesVideo: Bool
}

/// One control on a workflow's form.
///
/// Only the three things this app needs to fill in a prompt: what the field is
/// for, what to call it, and where to put the value.
struct ParamField: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
    let role: String
    let control: String
    let hidden: Bool?
}

struct ParamSchema: Decodable {
    let fields: [ParamField]
}

struct WorkflowDetail: Decodable {
    let id: String
    let name: String
    let schema: ParamSchema
    /// What was submitted last time, so a render here starts where the web app
    /// left off rather than from a form this client never showed.
    let lastValues: [String: JSONValue]
}

// MARK: - Gallery

struct ComfyImage: Decodable, Hashable {
    /// The stored row, and the only unambiguous way to ask for these bytes.
    /// Absent on rows written before it existed; the name is the fallback.
    let id: Int?
    let filename: String
    let subfolder: String
    let type: String
    let rating: Int
    let kept: Bool
    let width: Int?
    let height: Int?
    let kind: String

    var isStill: Bool { kind == "image" }

    var aspectRatio: Double {
        guard let width, let height, width > 0, height > 0 else { return 1 }
        return Double(width) / Double(height)
    }
}

struct GenerationRecord: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let status: String
    let workflowName: String
    let createdAt: Double
    let images: [ComfyImage]

    var created: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

struct GalleryPage: Decodable {
    let items: [GenerationRecord]
    let nextCursor: String?
}

/// One picture, with the run it belongs to — what the viewer pages through.
struct GalleryEntry: Identifiable, Hashable {
    let record: GenerationRecord
    let image: ComfyImage

    /// Stable across a reload, and unique: two runs can hold the same filename.
    var id: String { "\(record.id)/\(image.subfolder)/\(image.filename)" }
}

// MARK: - Generating

struct GenerateResponse: Decodable {
    let generationIds: [String]
    let promptIds: [String]
    /// Set when a batch stopped early; the items before it are still queued.
    let error: String?
}

// MARK: - Queue and live state

struct QueueEntry: Decodable, Identifiable, Hashable {
    let promptId: String
    let title: String
    let workflowName: String
    let running: Bool

    var id: String { promptId }
}

struct QueueState: Decodable {
    let running: [QueueEntry]
    let pending: [QueueEntry]

    var all: [QueueEntry] { running + pending }
    var isEmpty: Bool { running.isEmpty && pending.isEmpty }
}

struct LiveJob: Decodable, Hashable {
    let promptId: String
    let title: String
    let nodeTitle: String?
    let progress: Int
    let progressMax: Int
    let graphProgress: Double
}

struct LiveState: Decodable {
    let connected: Bool
    let comfyOnline: Bool
    let queueRemaining: Int
    let job: LiveJob?
    let lastError: String?
}

/// A frame off `/api/ws`.
///
/// Decoded by hand rather than as an enum with a synthesised initialiser: the
/// server sends a tagged union, and the payload's type depends on the tag,
/// which is exactly the shape `Codable` will not derive for you.
enum ServerEvent {
    case state(LiveState)
    case queue(QueueState)
    case generation(GenerationRecord)

    init?(json data: Data) {
        struct Tag: Decodable { let type: String }
        guard let tag = try? JSONDecoder().decode(Tag.self, from: data) else { return nil }

        func payload<T: Decodable>(_ type: T.Type) -> T? {
            struct Envelope<U: Decodable>: Decodable { let data: U }
            return try? JSONDecoder().decode(Envelope<T>.self, from: data).data
        }

        switch tag.type {
        // `snapshot` is the state a client is sent the moment it connects, and
        // `state` is every change after it. Same payload, same handling: what
        // matters is what is true now.
        case "snapshot", "state":
            guard let value = payload(LiveState.self) else { return nil }
            self = .state(value)
        case "queue":
            guard let value = payload(QueueState.self) else { return nil }
            self = .queue(value)
        case "generation":
            guard let value = payload(GenerationRecord.self) else { return nil }
            self = .generation(value)
        default:
            return nil
        }
    }
}

// MARK: - Values a form holds

/// A workflow value, whatever kind it is.
///
/// The server's form holds one dictionary keyed by field id, and this app has
/// to write one entry and send every other one back untouched — dropping one
/// would quietly reset a setting the web app made.
///
/// These four are the whole of it: Latent's `WidgetValue` is
/// `string | number | boolean | null`, because a ComfyUI widget cannot hold
/// anything else. The fallback below is for a server that grows a fifth kind,
/// and is the honest answer if one ever does.
enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            // An object or an array: nothing this app edits, and nothing it can
            // meaningfully carry. Null is honest about that, and the server
            // fills the field's own default back in.
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}
