import Foundation

// The out-of-band sentinel: what the cockpit can still find out when the
// dashboard does not answer.
//
// Two of the fleet's failure modes can never be reported from the runner host:
// the host being down takes the dashboard, its watchdog and phone push with it,
// and a dashboard that has died cannot announce its own absence. So when the
// stream drops, the cockpit asks three other witnesses — can this Mac reach the
// host's SSH port, what does GitHub say about the host's runners, and is the
// runner on a *different* machine in the same house still online — and reads
// the answers against the table below. The table is the whole of the logic and
// is tested row by row.

public struct SentinelProbes: Sendable, Equatable {
    /// This Mac has a usable network path at all.
    public var localNetwork: Bool = true
    /// TCP to the host's SSH port answered on any route (LAN or tailnet).
    public var sshReachable: Bool?
    /// The route that answered, for the evidence line.
    public var sshRoute: String?
    /// api.github.com answered at all.
    public var githubReachable: Bool?
    /// Of the host's canary runners GitHub reported on: how many online, how many offline.
    public var hostRunnersOnline: Int?
    public var hostRunnersOffline: Int?
    /// A runner on another machine (the discriminator): online, offline, or not checked.
    public var otherMachineOnline: Bool?
    public var otherMachineName: String?
    /// githubstatus.com's Actions component, when it is not "operational".
    public var githubActionsStatus: String?
    /// From `ssh <host>` when the SSH port answered.
    public var hostUptimeSec: Double?
    public var consoleUser: String?
    /// The dashboard port answered through the tunnel even though the stream did not.
    public var dashboardAnswered: Bool?

    public init() {}
}

public enum Sentinel {
    /// Reads the probes. `hostName` is what the evidence calls the host.
    public static func classify(_ p: SentinelProbes, hostName: String, now: Double = Format.nowMs()) -> Verdict {
        func v(_ id: String, _ tone: Tone, _ title: String, _ sentence: String, _ evidence: [String], _ next: NextMove?) -> Verdict {
            Verdict(id: id, tone: tone, title: title, sentence: sentence, evidence: evidence, next: next,
                    rung: id == "blind" ? -1 : id == "host-down" ? 1 : nil,
                    open: [Finding(id: id, tone: tone, title: title, sentence: sentence, evidence: evidence, next: next)])
        }

        var evidence: [String] = []
        if let r = p.sshReachable { evidence.append(r ? "SSH port answers\(p.sshRoute.map { " via \($0)" } ?? "")" : "SSH port closed on every route") }
        if let on = p.hostRunnersOnline, let off = p.hostRunnersOffline {
            evidence.append("GitHub: \(on) of \(on + off) checked runners on \(hostName) online")
        }
        if let other = p.otherMachineOnline {
            evidence.append("\(p.otherMachineName ?? "other machine"): \(other ? "online" : "offline")")
        }
        if let s = p.githubActionsStatus { evidence.append("githubstatus.com: Actions \(s)") }

        // Nothing leaves this Mac: the only honest verdict is about this Mac.
        if !p.localNetwork || (p.sshReachable == false && p.githubReachable == false) {
            return v("blind", .unknown, "This Mac is offline",
                     "Neither the host nor GitHub answers, so nothing can be said about the fleet.",
                     evidence, NextMove(label: "Check this Mac's network", kind: "owner"))
        }

        let offline = (p.hostRunnersOnline ?? 0) == 0 && (p.hostRunnersOffline ?? 0) > 0
        let online = (p.hostRunnersOnline ?? 0) > 0

        if p.sshReachable == true {
            if p.dashboardAnswered == true {
                return v("unreachable", .unknown, "Dashboard reachable, stream failing",
                         "The host and its dashboard answer, but the live stream does not. Retrying.",
                         evidence, NextMove(label: "Reconnect now", kind: "reconnect"))
            }
            if offline {
                let recent = (p.hostUptimeSec ?? .infinity) < 30 * 60
                let nobody = p.consoleUser.map { $0 == "root" || $0 == "loginwindow" || $0.isEmpty } ?? false
                if nobody || recent && p.consoleUser == nil {
                    var e = evidence
                    if let up = p.hostUptimeSec { e.append("Up \(Format.duration(ms: up * 1000))") }
                    if let u = p.consoleUser { e.append("Console: \(u.isEmpty ? "nobody" : u)") }
                    return v("host-down", .critical, "\(hostName) rebooted and nobody has logged in",
                             "Runners are LaunchAgents: they start at login, and there is no auto-login, so every one is stranded until someone logs in.",
                             e, NextMove(label: "Log in at the console or over Screen Sharing", kind: "url", url: "vnc://\(p.sshRoute ?? hostName)"))
                }
                return v("dead-service", .critical, "Every runner service on \(hostName) is down",
                         "The host answers but GitHub sees none of its runners, and the dashboard is down with them.",
                         evidence, NextMove(label: "Run health.sh --repair on the host", kind: "command",
                                            command: "~/actions-runners/health.sh --repair && ~/actions-runners/dashboard/fleetctl.sh restart"))
            }
            if online {
                return v("dashboard-down", .warning, "Dashboard down, fleet working",
                         "GitHub sees \(hostName)'s runners online, so jobs are running; only the dashboard is not answering.",
                         evidence, NextMove(label: "Restart the dashboard on the host", kind: "command",
                                            command: "~/actions-runners/dashboard/fleetctl.sh restart"))
            }
            return v("dashboard-down", .warning, "Dashboard not answering",
                     "The host answers on SSH; the dashboard does not, and GitHub could not be checked.",
                     evidence, NextMove(label: "Restart the dashboard on the host", kind: "command",
                                        command: "~/actions-runners/dashboard/fleetctl.sh restart"))
        }

        // SSH does not answer on any route.
        if online {
            return v("off-network", .info, "Fleet working, out of reach from here",
                     "GitHub sees \(hostName)'s runners online, but this Mac cannot reach the host. Showing what GitHub can say.",
                     evidence, NextMove(label: "Connect to the tailnet or home network", kind: "owner"))
        }
        if offline {
            if p.githubActionsStatus != nil {
                return v("host-down", .warning, "GitHub Actions is having trouble",
                         "GitHub reports an incident and the host's runners read offline; the host may be fine.",
                         evidence, NextMove(label: "Open githubstatus.com", kind: "url", url: "https://www.githubstatus.com"))
            }
            if p.otherMachineOnline == true {
                return v("host-down", .critical, "\(hostName) is asleep, off or off the network",
                         "\(p.otherMachineName ?? "Another machine") in the same house is online, so power and the network are fine. Only someone there can wake it.",
                         evidence, NextMove(label: "Wake it in person", kind: "owner"))
            }
            if p.otherMachineOnline == false {
                return v("host-down", .critical, "Home network or power is out",
                         "\(hostName) and \(p.otherMachineName ?? "the other machine") are both offline to GitHub.",
                         evidence, NextMove(label: "Check power and the router", kind: "owner"))
            }
            return v("host-down", .critical, "\(hostName) is down",
                     "The host does not answer and GitHub sees its runners offline.",
                     evidence, NextMove(label: "Wake it in person", kind: "owner"))
        }
        return v("host-down", .critical, "\(hostName) is unreachable",
                 "The host does not answer on SSH, and GitHub could not be asked about its runners.",
                 evidence, NextMove(label: "Check the host", kind: "owner"))
    }
}
