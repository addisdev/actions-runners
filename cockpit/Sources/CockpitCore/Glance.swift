import Foundation

// The /api/glance contract, schema 1 (docs/api.md#get-apiglance).
//
// Decoding is deliberately forgiving in one direction only: fields the daemon
// omits (it strips nulls) default to nil, and enum values this build does not
// know decode to `.unknown` instead of failing the whole payload. A newer
// daemon must never blank an older cockpit.

public struct Glance: Codable, Sendable, Equatable {
    public var schema: Int
    public var ts: Double?
    public var generatedAt: Double?
    public var ageMs: Double?
    public var stale: Bool?
    public var fastMs: Double?
    public var verdict: Verdict
    public var counts: Counts
    public var hosts: [Host]
    public var runners: [Runner]
    public var queue: [QueueItem]
    public var incidents: [Incident]
    public var admission: Admission?
    public var collector: Collector?
    public var api: RateLimit?

    public static let supportedSchema = 1
}

public enum Tone: String, Codable, Sendable, Comparable, CaseIterable {
    case critical, warning, info, ok, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Tone(rawValue: raw) ?? .unknown
    }

    /// Severity order: critical is "largest".
    var rank: Int {
        switch self {
        case .critical: 4
        case .warning: 3
        case .unknown: 2
        case .info: 1
        case .ok: 0
        }
    }

    public static func < (a: Tone, b: Tone) -> Bool { a.rank < b.rank }
}

public struct NextMove: Codable, Sendable, Equatable {
    public var label: String
    public var kind: String
    public var action: String?
    public var then: String?
    public var url: String?
    public var command: String?
    public var secondary: String?

    public init(label: String, kind: String, action: String? = nil, then: String? = nil,
                url: String? = nil, command: String? = nil, secondary: String? = nil) {
        self.label = label; self.kind = kind; self.action = action; self.then = then
        self.url = url; self.command = command; self.secondary = secondary
    }
}

public struct Finding: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var tone: Tone
    public var title: String
    public var sentence: String?
    public var evidence: [String]?
    public var next: NextMove?

    public init(id: String, tone: Tone, title: String, sentence: String?, evidence: [String]?, next: NextMove?) {
        self.id = id; self.tone = tone; self.title = title
        self.sentence = sentence; self.evidence = evidence; self.next = next
    }
}

public struct Verdict: Codable, Sendable, Equatable {
    public var id: String
    public var tone: Tone
    public var title: String
    public var sentence: String?
    public var evidence: [String]
    public var next: NextMove?
    public var rung: Int?
    public var open: [Finding]

    public init(id: String, tone: Tone, title: String, sentence: String?, evidence: [String],
                next: NextMove?, rung: Int?, open: [Finding]) {
        self.id = id; self.tone = tone; self.title = title; self.sentence = sentence
        self.evidence = evidence; self.next = next; self.rung = rung; self.open = open
    }

    enum CodingKeys: String, CodingKey { case id, tone, title, sentence, evidence, next, rung, open }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tone = try c.decodeIfPresent(Tone.self, forKey: .tone) ?? .unknown
        title = try c.decode(String.self, forKey: .title)
        sentence = try c.decodeIfPresent(String.self, forKey: .sentence)
        evidence = try c.decodeIfPresent([String].self, forKey: .evidence) ?? []
        next = try c.decodeIfPresent(NextMove.self, forKey: .next)
        rung = try c.decodeIfPresent(Int.self, forKey: .rung)
        open = try c.decodeIfPresent([Finding].self, forKey: .open) ?? []
    }
}

public struct Counts: Codable, Sendable, Equatable {
    public var running: Int
    public var queued: Int
    public var held: Int
    public var runners: Int

    public init(running: Int = 0, queued: Int = 0, held: Int = 0, runners: Int = 0) {
        self.running = running; self.queued = queued; self.held = held; self.runners = runners
    }
}

public struct Vitals: Codable, Sendable, Equatable {
    public var cores: Int?
    public var load1: Double?
    public var memPressure: String?
    public var memFreePct: Double?
    public var swapinsPerSec: Double?
    public var swapUsedMb: Double?
    public var diskFreeGb: Double?
    public var diskTotalGb: Double?
    public var diskFloorGb: Double?
    public var diskFloorEtaMs: Double?
    public var uptimeSec: Double?

    public var loadPerCore: Double? {
        guard let load1, let cores, cores > 0 else { return nil }
        return load1 / Double(cores)
    }
}

public struct Host: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var local: Bool?
    public var stale: Bool?
    public var staleForMs: Double?
    public var ghOnly: Bool?
    public var drained: Bool?
    public var vitals: Vitals?
}

public enum RunnerState: String, Codable, Sendable, CaseIterable {
    case hostDown = "host-down"
    case unknown
    case dead
    case misconfigured
    case draining
    case offline
    case settling
    case heldDisk = "held-disk"
    case heldSlot = "held-slot"
    case overdue
    case busy
    case lost
    case idle

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RunnerState(rawValue: raw) ?? .unknown
    }
}

public struct Job: Codable, Sendable, Equatable {
    public var runId: Int?
    public var repo: String?
    public var workflow: String?
    public var job: String?
    public var startedAt: Double?
    public var elapsedMs: Double?
    public var expectedMs: Double?
    public var overdue: Bool?
    public var url: String?
    public var prNumber: Int?
    public var branch: String?
}

public struct Runner: Codable, Sendable, Equatable, Identifiable {
    public var id: String { name }
    public var name: String
    public var repo: String?
    public var project: String?
    public var host: String
    public var state: RunnerState
    public var detail: String?
    public var since: Double?
    public var lostAt: Double?
    public var job: Job?
}

public struct QueueItem: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var repo: String
    public var project: String?
    public var workflow: String?
    public var queuedMs: Double?
    public var cause: String?
    public var confidence: String?
    public var recommended: String?
    public var evidence: [String]?
    public var url: String?
    public var branch: String?
    public var prNumber: Int?
    public var title: String?
    public var etaStartMs: [Double]?
    public var etaDoneMs: [Double]?
}

public struct Incident: Codable, Sendable, Equatable, Identifiable {
    public var id: String { key }
    public var key: String
    public var rule: String?
    public var severity: String?
    public var title: String
    public var body: String?
    public var openedAt: Double?
    public var dismissed: Bool?

    public var tone: Tone {
        switch severity {
        case "critical": .critical
        case "warning": .warning
        case "info": .info
        default: .unknown
        }
    }
}

public struct Admission: Codable, Sendable, Equatable {
    public var mode: String?
    public var limit: Int?
    public var waiting: Int?
}

public struct Collector: Codable, Sendable, Equatable {
    public var lastError: String?
    public var failedRepos: Int?
}

public struct RateLimit: Codable, Sendable, Equatable {
    public var remaining: Int?
    public var limit: Int?
}

public enum GlanceError: Error, CustomStringConvertible, Equatable {
    case unsupportedSchema(Int)

    public var description: String {
        switch self {
        case .unsupportedSchema(let s):
            "The daemon speaks glance schema \(s); this cockpit understands \(Glance.supportedSchema). Update the app."
        }
    }
}

public extension Glance {
    static func decode(_ data: Data) throws -> Glance {
        let g = try JSONDecoder().decode(Glance.self, from: data)
        guard g.schema == Glance.supportedSchema else { throw GlanceError.unsupportedSchema(g.schema) }
        return g
    }
}
