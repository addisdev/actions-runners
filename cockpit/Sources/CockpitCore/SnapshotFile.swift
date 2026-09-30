import Foundation

/// `~/Library/Application Support/FleetCockpit/glance.json`: the app's latest
/// view, for the `cockpit` CLI, Homelab Map, Load Warden and scripts. Written
/// atomically, mode 0600 (it names repos and run titles), and it carries its
/// own age so a reader can tell a fresh view from a dead app's last words.
public struct SnapshotFile: Codable, Sendable, Equatable {
    public var writtenAt: Double
    public var route: String?
    public var connection: String
    /// What the cockpit shows, which may be an out-of-band verdict the daemon
    /// could not produce (host down, blind).
    public var verdict: Verdict
    public var glance: Glance?

    public init(writtenAt: Double, route: String?, connection: String, verdict: Verdict, glance: Glance?) {
        self.writtenAt = writtenAt; self.route = route; self.connection = connection
        self.verdict = verdict; self.glance = glance
    }

    public static var defaultURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FleetCockpit", isDirectory: true)
            .appendingPathComponent("glance.json")
    }

    /// The copy the widgets read: the app group container shared with the
    /// sandboxed widget extension. nil when the build carries no app group.
    public static var groupURL: URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FleetAppGroup") as? String,
              !group.isEmpty, !group.hasPrefix("$("), !group.hasPrefix("io."),
              let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return dir.appendingPathComponent("glance.json")
    }

    public func write(to url: URL = SnapshotFile.defaultURL) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        let data = try enc.encode(self)
        let tmp = dir.appendingPathComponent(".glance.\(ProcessInfo.processInfo.processIdentifier).tmp")
        FileManager.default.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600])
        // rename(2) is atomic and keeps the temp file's 0600; replaceItemAt
        // copies the destination's old attributes over it.
        guard rename(tmp.path, url.path) == 0 else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public static func read(from url: URL = SnapshotFile.defaultURL) throws -> SnapshotFile {
        try JSONDecoder().decode(SnapshotFile.self, from: Data(contentsOf: url))
    }

    public func ageMs(now: Double = Format.nowMs()) -> Double { now - writtenAt }
}
