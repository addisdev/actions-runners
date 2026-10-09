import Foundation
import Network

/// What the sentinel checks, derived from the last good glance so nothing is
/// configured by hand: a few runners on the coordinator as canaries, and one
/// runner on another machine as the "does the house have power" witness.
public struct SentinelTargets: Sendable, Equatable {
    public var hostName: String
    /// repo (owner/name) → runner names on the host serving it.
    public var canaries: [String: [String]]
    public var other: Other?

    public struct Other: Sendable, Equatable {
        public var repo: String
        public var runner: String
        public var machine: String
    }

    public init(hostName: String, canaries: [String: [String]], other: Other?) {
        self.hostName = hostName; self.canaries = canaries; self.other = other
    }

    /// Three repos' worth of the coordinator's runners (≈ 3 API calls a minute
    /// while the dashboard is down), plus one runner from a GitHub-only lane.
    public static func from(_ g: Glance, maxRepos: Int = 3) -> SentinelTargets? {
        guard let local = g.hosts.first(where: { $0.local == true }) else { return nil }
        var canaries: [String: [String]] = [:]
        let localRunners = g.runners.filter { $0.host == local.id && $0.repo != nil }
        for r in localRunners.sorted(by: { $0.name < $1.name }) {
            guard let repo = r.repo else { continue }
            if canaries[repo] == nil, canaries.count >= maxRepos { continue }
            canaries[repo, default: []].append(r.name)
        }
        let other = g.hosts.first(where: { $0.ghOnly == true }).flatMap { h in
            g.runners.first(where: { $0.host == h.id && $0.repo != nil }).map {
                Other(repo: $0.repo!, runner: $0.name, machine: h.name)
            }
        }
        return canaries.isEmpty ? nil : SentinelTargets(hostName: local.name, canaries: canaries, other: other)
    }
}

/// Runs the probes. Every step is bounded by a short timeout; the whole pass
/// takes a few seconds at worst and runs once a minute while the dashboard is
/// unreachable, never while it answers.
public struct SentinelProbe: Sendable {
    public var aliases: [String]
    public var sshPath = "/usr/bin/ssh"
    public var remotePort = 7878

    public init(aliases: [String]) { self.aliases = aliases }

    public func run(_ targets: SentinelTargets?, localNetwork: Bool) async -> SentinelProbes {
        let targets = targets ?? SentinelTargets(hostName: aliases.first ?? "host", canaries: [:], other: nil)
        var p = SentinelProbes()
        p.localNetwork = localNetwork
        guard localNetwork else { return p }

        async let ssh = firstReachableAlias()
        async let gh = githubRunners(targets)
        async let status = githubActionsStatus()

        let (alias, route) = await ssh
        p.sshReachable = alias != nil
        p.sshRoute = route
        let runners = await gh
        p.githubReachable = runners.reachable
        p.hostRunnersOnline = runners.online
        p.hostRunnersOffline = runners.offline
        p.otherMachineOnline = runners.other
        p.otherMachineName = targets.other?.machine
        p.githubActionsStatus = await status

        if let alias {
            let c = await consoleCheck(alias)
            p.hostUptimeSec = c.uptime
            p.consoleUser = c.user
            p.dashboardAnswered = c.dashboard
        }
        return p
    }

    // MARK: SSH reachability

    /// `ssh -G` resolves each alias the way ssh itself would (HostName, Port,
    /// ProxyJump is ignored — a jump route is only as up as its first hop).
    func resolve(_ alias: String) async -> (host: String, port: UInt16)? {
        guard let out = await Shell.run(sshPath, ["-G", alias], timeout: 3) else { return nil }
        var host: String?, port: UInt16 = 22
        for line in out.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            if parts[0] == "hostname" { host = parts[1] }
            if parts[0] == "port", let n = UInt16(parts[1]) { port = n }
        }
        return host.map { ($0, port) }
    }

    func firstReachableAlias() async -> (String?, String?) {
        for alias in aliases {
            guard let (host, port) = await resolve(alias) else { continue }
            if await Self.tcpOpen(host: host, port: port, timeout: 4) { return (alias, host) }
        }
        return (nil, nil)
    }

    public static func tcpOpen(host: String, port: UInt16, timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let conn = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
            let once = Once()
            let finish: @Sendable (Bool) -> Void = { ok in
                if once.claim() { conn.cancel(); c.resume(returning: ok) }
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(true)
                case .failed, .cancelled: finish(false)
                case .waiting: finish(false)
                default: break
                }
            }
            conn.start(queue: .global(qos: .utility))
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(false) }
        }
    }

    // MARK: on the host

    func consoleCheck(_ alias: String) async -> (uptime: Double?, user: String?, dashboard: Bool?) {
        let cmd = "sysctl -n kern.boottime; stat -f%Su /dev/console; "
            + "curl -s -o /dev/null -m 3 -w '%{http_code}\\n' http://127.0.0.1:\(remotePort)/api/health"
        guard let out = await Shell.run(sshPath, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-T", alias, cmd], timeout: 12)
        else { return (nil, nil, nil) }
        let lines = out.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        var uptime: Double?
        if let boot = lines.first, let r = boot.range(of: #"sec = (\d+)"#, options: .regularExpression) {
            let digits = boot[r].filter(\.isNumber)
            if let sec = Double(digits) { uptime = Date().timeIntervalSince1970 - sec }
        }
        let user = lines.count > 1 ? lines[1] : nil
        let dashboard = lines.count > 2 ? lines[2] == "200" : nil
        return (uptime, user, dashboard)
    }

    // MARK: GitHub

    struct RunnerCounts: Sendable { var reachable: Bool?; var online: Int?; var offline: Int?; var other: Bool? }

    func githubRunners(_ t: SentinelTargets) async -> RunnerCounts {
        guard !t.canaries.isEmpty, let token = await GitHubToken.current() else {
            // Still worth knowing whether GitHub answers at all.
            let up = (try? await URLSession.shared.data(from: URL(string: "https://api.github.com/zen")!)) != nil
            return RunnerCounts(reachable: up)
        }
        var online = 0, offline = 0, reachable = false
        var other: Bool?
        var lists: [String: [String: String]] = [:]
        var repos = Array(t.canaries.keys)
        if let o = t.other, !repos.contains(o.repo) { repos.append(o.repo) }
        for repo in repos {
            guard let statuses = await runnerStatuses(repo, token: token) else { continue }
            reachable = true
            lists[repo] = statuses
        }
        for (repo, names) in t.canaries {
            for n in names {
                switch lists[repo]?[n] {
                case "online": online += 1
                case "offline": offline += 1
                default: break
                }
            }
        }
        if let o = t.other, let s = lists[o.repo]?[o.runner] { other = s == "online" }
        return RunnerCounts(reachable: reachable, online: online + offline > 0 ? online : nil,
                            offline: online + offline > 0 ? offline : nil, other: other)
    }

    func runnerStatuses(_ repo: String, token: String) async -> [String: String]? {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(repo)/actions/runners?per_page=100")!)
        req.timeoutInterval = 8
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "accept")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let runners = obj["runners"] as? [[String: Any]] else { return nil }
        var out: [String: String] = [:]
        for r in runners {
            if let n = r["name"] as? String, let s = r["status"] as? String { out[n] = s }
        }
        return out
    }

    /// The Actions component's status when it is anything but operational.
    func githubActionsStatus() async -> String? {
        var req = URLRequest(url: URL(string: "https://www.githubstatus.com/api/v2/components.json")!)
        req.timeoutInterval = 6
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let comps = obj["components"] as? [[String: Any]],
              let actions = comps.first(where: { ($0["name"] as? String) == "Actions" }),
              let status = actions["status"] as? String else { return nil }
        return status == "operational" ? nil : status.replacingOccurrences(of: "_", with: " ")
    }
}

/// The user's own `gh` credential, asked for at the moment it is needed and
/// never stored. Apps started from Finder have no PATH, hence the list.
public enum GitHubToken {
    static let candidates = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]

    public static func current() async -> String? {
        if let env = ProcessInfo.processInfo.environment["GH_TOKEN"] ?? ProcessInfo.processInfo.environment["GITHUB_TOKEN"],
           !env.isEmpty { return env }
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            if let out = await Shell.run(path, ["auth", "token"], timeout: 5)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !out.isEmpty { return out }
        }
        return nil
    }
}

enum Shell {
    /// Runs a program, returns stdout if it exits 0 within the timeout.
    static func run(_ path: String, _ args: [String], timeout: TimeInterval) async -> String? {
        guard let r = await Subprocess.run(path, args, timeout: timeout), r.status == 0 else { return nil }
        return String(decoding: r.stdout, as: UTF8.self)
    }
}

final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.withLock { defer { done = true }; return !done } }
}
