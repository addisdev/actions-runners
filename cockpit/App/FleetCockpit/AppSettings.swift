import Foundation
import CockpitCore

/// Everything a person can change, persisted in UserDefaults. Nothing host-
/// specific is compiled in: when the build box replaces the current runner
/// host, this is a new alias here, not a new release.
struct AppSettings: Codable, Equatable {
    enum Mode: String, Codable, CaseIterable, Identifiable {
        case tunnel, direct, fixture
        var id: String { rawValue }
        var label: String {
            switch self {
            case .tunnel: "SSH tunnel"
            case .direct: "Direct URL"
            case .fixture: "Fixture (demo)"
            }
        }
    }

    var mode: Mode = .tunnel
    var aliases: String = "runner-host, runner-ts"
    var remotePort: Int = 7878
    var directURL: String = "http://127.0.0.1:7878"
    var fixture: String = "live"
    var showCounts: Bool = true
    var dense: Bool = false

    var aliasList: [String] {
        aliases.split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init).filter { !$0.isEmpty }
    }

    var transport: TransportConfig {
        switch mode {
        case .tunnel: .tunnel(aliases: aliasList, remotePort: remotePort)
        case .direct: URL(string: directURL).map { .direct($0) } ?? .default
        case .fixture: .fixture(fixture)
        }
    }

    private static let key = "settings.v1"

    static func load(_ defaults: UserDefaults = .standard) -> AppSettings {
        guard let data = defaults.data(forKey: key),
              let s = try? JSONDecoder().decode(AppSettings.self, from: data) else { return AppSettings() }
        return s
    }

    func save(_ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key) }
    }

    init() {}

    // Tolerate settings written by an older build: every field is optional
    // on the way in.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings()
        mode = (try? c.decode(Mode.self, forKey: .mode)) ?? d.mode
        aliases = (try? c.decode(String.self, forKey: .aliases)) ?? d.aliases
        remotePort = (try? c.decode(Int.self, forKey: .remotePort)) ?? d.remotePort
        directURL = (try? c.decode(String.self, forKey: .directURL)) ?? d.directURL
        fixture = (try? c.decode(String.self, forKey: .fixture)) ?? d.fixture
        showCounts = (try? c.decode(Bool.self, forKey: .showCounts)) ?? d.showCounts
        dense = (try? c.decode(Bool.self, forKey: .dense)) ?? d.dense
    }
}
