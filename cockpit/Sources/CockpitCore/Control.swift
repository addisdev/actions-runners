import Foundation
import Security

// Control: everything the cockpit can ask the daemon to DO.
//
// The buttons are rendered from the daemon's own catalogue (GET /api/actions),
// with its danger level and its confirmation text, so a new upstream action
// appears here without a release and the cockpit never invents its own idea
// of what is safe. High-danger fleet surgery (register, duplicate, remove) is
// deliberately not offered: it is rare, and the web Control tab does it with
// previews.

public struct ActionDef: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var danger: String?
    public var confirm: String?

    public var isHighDanger: Bool { danger == "high" }

    public init(id: String, label: String, danger: String?, confirm: String?) {
        self.id = id; self.label = label; self.danger = danger; self.confirm = confirm
    }
}

public struct ActionCatalog: Codable, Sendable, Equatable {
    public var readOnly: Bool?
    public var actions: [ActionDef]

    /// What the cockpit offers. `fleet.cleanupApply` is the one high-danger
    /// action allowed, and only as the second step after a preview.
    public static let offered: Set<String> = [
        "fleet.health", "fleet.healthRepair", "fleet.status", "fleet.cleanupPreview", "fleet.cleanupApply",
        "runner.restart", "runner.drain", "runner.resume", "host.drain", "host.resume", "run.rerun", "run.cancel",
    ]

    /// Used before the catalogue has loaded, for the verdict's own next move.
    public static func fallback(_ id: String) -> ActionDef? {
        switch id {
        case "fleet.healthRepair": ActionDef(id: id, label: "Health check and repair", danger: "medium", confirm: nil)
        case "fleet.cleanupPreview": ActionDef(id: id, label: "Preview cleanup", danger: "none", confirm: nil)
        default: nil
        }
    }

    public func action(_ id: String) -> ActionDef? {
        guard ActionCatalog.offered.contains(id) else { return nil }
        return actions.first { $0.id == id }
    }
}

public struct ActionResult: Codable, Sendable, Equatable {
    public var ok: Bool
    public var command: String?
    public var code: Int?
    public var output: String?
    public var error: String?
    public var durationMs: Double?

    public init(ok: Bool, command: String? = nil, code: Int? = nil, output: String? = nil,
                error: String? = nil, durationMs: Double? = nil) {
        self.ok = ok; self.command = command; self.code = code; self.output = output
        self.error = error; self.durationMs = durationMs
    }

    /// The last few lines, which is where a shell script says what happened.
    public var summary: String {
        if let error { return error }
        let lines = (output ?? "").split(separator: "\n", omittingEmptySubsequences: true)
        return lines.suffix(4).joined(separator: "\n")
    }
}

public struct RunnerDetail: Codable, Sendable, Equatable {
    public struct Event: Codable, Sendable, Equatable { public var ts: Double; public var kind: String; public var detail: String? }
    public struct JobRow: Codable, Sendable, Equatable, Identifiable {
        public var id: Int
        public var repo: String?
        public var name: String?
        public var status: String?
        public var conclusion: String?
        public var started_at: String?
        public var completed_at: String?
        public var duration_ms: Double?
        public var html_url: String?
    }
    public struct Utilization: Codable, Sendable, Equatable {
        public var days: Int?
        public var jobCount: Int?
        public var failureCount: Int?
        public var totalMs: Double?
        public var lastJobAt: String?
        public var workKb: Double?
    }
    public struct DiagSummary: Codable, Sendable, Equatable {
        public var errors: Int?
        public var warnings: Int?
        public var lastError: String?
    }
    public var remote: Bool?
    public var events: [Event]?
    public var jobs: [JobRow]?
    public var utilization: Utilization?
    public var diagSummary: DiagSummary?
}

public extension FleetClient {
    func actions() async throws -> ActionCatalog {
        try JSONDecoder().decode(ActionCatalog.self, from: try await get("api/actions"))
    }

    /// Runs one catalogue action. Requires a paired device token.
    func perform(_ action: String, args: [String: Any] = [:]) async throws -> ActionResult {
        do {
            // Actions are shell scripts on the host (health.sh walks every
            // runner); the daemon replies when they finish.
            let data = try await post("api/action", json: ["action": action, "args": args], timeout: 300)
            return try JSONDecoder().decode(ActionResult.self, from: data)
        } catch let e as URLError {
            return ActionResult(ok: false, error: "No reply from the dashboard: \(e.localizedDescription)")
        } catch ClientError.http(let code, let body) {
            if let r = try? JSONDecoder().decode(ActionResult.self, from: Data(body.utf8)) { return r }
            let msg = (try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])?["error"] as? String
            return ActionResult(ok: false, error: msg ?? "HTTP \(code)")
        }
    }

    /// Stops a condition notifying, everywhere (web, phone push, cockpit). Over
    /// the tunnel the request arrives as loopback, which needs no token.
    func dismiss(_ key: String, restore: Bool = false) async throws {
        _ = try await post(restore ? "api/alerts/restore" : "api/alerts/dismiss", json: ["key": key])
    }

    func runner(_ name: String) async throws -> RunnerDetail {
        try JSONDecoder().decode(RunnerDetail.self, from: try await get("api/runner", query: ["name": name]))
    }

    /// Exchanges a six-digit pairing code for this device's own revocable token.
    func pair(code: String, name: String) async throws -> String {
        let data = try await post("api/pair", json: ["code": code, "name": name])
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = obj["token"] as? String else { throw ClientError.http(200, "no token in reply") }
        return token
    }
}

/// Starting a pairing needs the master token, which never leaves the host, so
/// the code is minted there: `fleetctl.sh pair` over the same SSH alias.
public enum Pairing {
    public static func mintCode(alias: String, fleetRoot: String = "~/actions-runners") async -> String? {
        let cmd = "cd \(fleetRoot)/dashboard && ./fleetctl.sh pair"
        guard let out = await Shell.run("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-T", alias, cmd],
                                        timeout: 20) else { return nil }
        return parseCode(out)
    }

    /// "Pairing code: 123 456" → "123456".
    public static func parseCode(_ output: String) -> String? {
        guard let line = output.split(separator: "\n").first(where: { $0.contains("Pairing code:") }) else { return nil }
        let digits = line.filter(\.isNumber)
        return digits.count == 6 ? String(digits) : nil
    }
}

/// The device token lives in the login Keychain, readable after first unlock.
public enum TokenStore {
    static let service = "io.github.addisdev.fleetcockpit"

    public static func save(_ token: String, account: String) -> Bool {
        delete(account: account)
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            kSecValueData as String: Data(token.utf8),
        ]
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    public static func load(account: String) -> String? {
        let context = LAContextStub.noUI
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        // Never block on a Keychain prompt: a menu bar app waiting on a dialog
        // behind other windows looks hung, and a CLI in a script is hung.
        q.merge(context) { $1 }
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    @discardableResult
    public static func delete(account: String) -> Bool {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        return SecItemDelete(q as CFDictionary) == errSecSuccess
    }
}

/// Keychain queries that fail instead of prompting.
enum LAContextStub {
    static var noUI: [String: Any] {
        [kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail]
    }
}

/// The CLI's token. SwiftPM builds are ad-hoc signed, so their code signature
/// changes with every build and a Keychain item would prompt each time; the
/// command line keeps its own token in a 0600 file instead, the way gh does.
public enum CLITokenFile {
    static func url(_ account: String) -> URL {
        SnapshotFile.defaultURL.deletingLastPathComponent()
            .appendingPathComponent("cli-token-\(account.replacingOccurrences(of: "/", with: "_"))")
    }

    public static func save(_ token: String, account: String) throws {
        let u = url(account)
        try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        FileManager.default.createFile(atPath: u.path, contents: Data(token.utf8), attributes: [.posixPermissions: 0o600])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: u.path)
    }

    public static func load(account: String) -> String? {
        (try? String(contentsOf: url(account), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func delete(account: String) { try? FileManager.default.removeItem(at: url(account)) }
}
