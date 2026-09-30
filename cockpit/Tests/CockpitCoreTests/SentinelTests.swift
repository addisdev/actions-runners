import Foundation
import Testing
@testable import CockpitCore

// One test per row of the out-of-band decision table. The named rows are the
// incidents that made the table necessary.

private func probes(ssh: Bool?, on: Int? = nil, off: Int? = nil, other: Bool? = nil,
                    github: Bool? = true, status: String? = nil,
                    uptime: Double? = nil, console: String? = nil, dashboard: Bool? = nil,
                    local: Bool = true) -> SentinelProbes {
    var p = SentinelProbes()
    p.localNetwork = local
    p.sshReachable = ssh
    p.sshRoute = ssh == true ? "build-host.local" : nil
    p.githubReachable = github
    p.hostRunnersOnline = on
    p.hostRunnersOffline = off
    p.otherMachineOnline = other
    p.otherMachineName = other == nil ? nil : "mini"
    p.githubActionsStatus = status
    p.hostUptimeSec = uptime
    p.consoleUser = console
    p.dashboardAnswered = dashboard
    return p
}

private func classify(_ p: SentinelProbes) -> Verdict { Sentinel.classify(p, hostName: "build-host") }

@Suite("sentinel decision table")
struct SentinelTableTests {
    @Test("2026-09-05: host asleep, the Mini online — the house has power")
    func hostAsleep() {
        let v = classify(probes(ssh: false, on: 0, off: 5, other: true))
        #expect(v.id == "host-down")
        #expect(v.tone == .critical)
        #expect(v.title == "build-host is asleep, off or off the network")
        #expect(v.next?.kind == "owner")
        #expect(v.evidence.contains("mini: online"))
    }

    @Test func homeNetworkOrPowerOut() {
        let v = classify(probes(ssh: false, on: 0, off: 5, other: false))
        #expect(v.title == "Home network or power is out")
    }

    @Test func githubIncidentIsNotTheHost() {
        let v = classify(probes(ssh: false, on: 0, off: 5, other: true, status: "partial outage"))
        #expect(v.title == "GitHub Actions is having trouble")
        #expect(v.tone == .warning)
    }

    @Test("rebooted while away: LaunchAgents stranded until someone logs in")
    func rebootedNobodyLoggedIn() {
        let v = classify(probes(ssh: true, on: 0, off: 5, uptime: 600, console: "root"))
        #expect(v.id == "host-down")
        #expect(v.title == "build-host rebooted and nobody has logged in")
        #expect(v.next?.url == "vnc://build-host.local")
        #expect(v.evidence.contains("Console: root"))
    }

    @Test func everyServiceDead() {
        let v = classify(probes(ssh: true, on: 0, off: 5, uptime: 3 * 86_400, console: "ci"))
        #expect(v.id == "dead-service")
        #expect(v.next?.command?.contains("health.sh --repair") == true)
    }

    @Test func dashboardDownFleetWorking() {
        let v = classify(probes(ssh: true, on: 4, off: 1))
        #expect(v.id == "dashboard-down")
        #expect(v.title == "Dashboard down, fleet working")
        #expect(v.next?.command?.contains("fleetctl.sh restart") == true)
    }

    @Test func dashboardAnswersButStreamDoesNot() {
        let v = classify(probes(ssh: true, on: 4, off: 0, dashboard: true))
        #expect(v.id == "unreachable")
        #expect(v.next?.kind == "reconnect")
    }

    @Test func offNetworkFleetFine() {
        let v = classify(probes(ssh: false, on: 5, off: 0))
        #expect(v.id == "off-network")
        #expect(v.tone == .info)
    }

    @Test func blindWhenNothingAnswers() {
        #expect(classify(probes(ssh: false, github: false)).id == "blind")
        #expect(classify(probes(ssh: nil, local: false)).id == "blind")
    }

    @Test func noTokenStillSaysSomething() {
        let v = classify(probes(ssh: false, github: true))
        #expect(v.id == "host-down")
        #expect(v.title == "build-host is unreachable")
    }

    @Test func everyVerdictHasAnOpenFindingAndANextMove() {
        let rows: [SentinelProbes] = [
            probes(ssh: false, on: 0, off: 5, other: true), probes(ssh: true, on: 4, off: 1),
            probes(ssh: true, on: 0, off: 5, uptime: 600, console: "root"), probes(ssh: false, github: false),
        ]
        for p in rows {
            let v = classify(p)
            #expect(v.open.first?.id == v.id)
            #expect(v.next != nil)
        }
    }
}

@Suite("sentinel targets")
struct SentinelTargetTests {
    @Test func derivedFromTheLastGlance() throws {
        let t = try #require(SentinelTargets.from(try Fixtures.glance("live")))
        #expect(t.hostName == "build-host")
        #expect(t.canaries.count == 3)
        #expect(t.canaries.values.allSatisfy { $0.allSatisfy { $0.hasPrefix("build-host-") } })
        #expect(t.other?.machine == "mini")
        #expect(t.other?.runner.hasPrefix("mini-") == true)
    }
}

@Suite("ladder and brief")
struct LadderTests {
    @Test func theVerdictLightsItsRungAndOthersShowOpen() throws {
        var v = try Fixtures.glance("live").verdict
        v.open.append(Finding(id: "config-drift", tone: .warning, title: "Configuration drift",
                              sentence: nil, evidence: ["ion · CI: label-mismatch"], next: nil))
        let rungs = Ladder.build(v)
        #expect(rungs.filter(\.lit).map(\.id) == ["account-blocked"])
        #expect(rungs.first { $0.id == "config-drift" }?.evidence == ["ion · CI: label-mismatch"])
        #expect(rungs.first { $0.id == "config-drift" }?.open == true)
        #expect(rungs.first { $0.id == "clear" }?.open == false)
        #expect(rungs.count == 10)
    }

    @Test func cockpitOnlyVerdictsLandOnTheUnknownRung() {
        let v = Verdict(id: "dashboard-down", tone: .warning, title: "Dashboard down, fleet working", sentence: nil,
                        evidence: [], next: nil, rung: nil, open: [])
        #expect(Ladder.build(v).first(where: \.lit)?.id == "unknown")
    }

    @Test func briefCarriesVerdictEvidenceAndTroubledRunners() throws {
        let g = try Fixtures.glance("dead")
        let md = IncidentBrief.markdown(verdict: g.verdict, glance: g, route: "runner-host", connection: "live",
                                        now: Date(timeIntervalSince1970: 0))
        #expect(md.hasPrefix("## Fleet: Runner service is down: build-host-ember-ios"))
        #expect(md.contains("**Next move:** Health check and repair"))
        #expect(md.contains("`build-host-ember-ios` dead"))
        #expect(md.contains("**Queue**"))
        #expect(md.contains("disk 49.3 GB free (floor 40 GB)"))
    }
}
