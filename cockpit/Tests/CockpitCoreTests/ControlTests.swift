import Foundation
import Testing
@testable import CockpitCore

private func inc(_ key: String, _ sev: String, rule: String = "offline", opened: Double = 0, dismissed: Bool = false) -> Incident {
    Incident(key: key, rule: rule, severity: sev, title: key, body: nil, openedAt: opened, dismissed: dismissed)
}

@Suite("incident tracker")
struct IncidentTrackerTests {
    let prefs = IncidentTracker.Preferences()

    @Test func whatIsOpenAtLaunchIsNotNews() {
        var t = IncidentTracker()
        #expect(t.update([inc("a", "critical")], prefs: prefs, now: 0, hour: 12).isEmpty)
    }

    @Test func opensOnceAndRecoversWithDuration() {
        var t = IncidentTracker()
        _ = t.update([], prefs: prefs, now: 0, hour: 12)
        let a = inc("a", "critical", opened: 1_000)
        #expect(t.update([a], prefs: prefs, now: 1_000, hour: 12) == [.opened(a)])
        #expect(t.update([a], prefs: prefs, now: 16_000, hour: 12).isEmpty)
        #expect(t.update([], prefs: prefs, now: 601_000, hour: 12) == [.recovered(a, lastedMs: 600_000)])
    }

    @Test func infoAndDismissedStayQuiet_andRecoveryOnlyForAnnounced() {
        var t = IncidentTracker()
        _ = t.update([], prefs: prefs, now: 0, hour: 12)
        let i = inc("i", "info"), d = inc("d", "critical", dismissed: true)
        #expect(t.update([i, d], prefs: prefs, now: 1, hour: 12).isEmpty)
        #expect(t.update([], prefs: prefs, now: 2, hour: 12).isEmpty)
    }

    @Test func criticalOnlyAndQuietHours() {
        var p = prefs
        p.minSeverity = "critical"
        var t = IncidentTracker()
        _ = t.update([], prefs: p, now: 0, hour: 12)
        #expect(t.update([inc("w", "warning")], prefs: p, now: 1, hour: 12).isEmpty)

        var q = prefs
        q.quietStart = 22; q.quietEnd = 7
        #expect(q.inQuietHours(hour: 23) && q.inQuietHours(hour: 3) && !q.inQuietHours(hour: 12))
        var t2 = IncidentTracker()
        _ = t2.update([], prefs: q, now: 0, hour: 2)
        let c = inc("c", "critical")
        #expect(t2.update([inc("w", "warning"), c], prefs: q, now: 1, hour: 2) == [.opened(c)])
    }

    @Test func mutedRulesAndSnoozes() {
        var p = prefs
        p.mutedRules = ["stuck-queue"]
        var t = IncidentTracker()
        _ = t.update([], prefs: p, now: 0, hour: 12)
        #expect(t.update([inc("q", "critical", rule: "stuck-queue")], prefs: p, now: 1, hour: 12).isEmpty)
        t.snooze("s", untilMs: 3_600_000)
        #expect(t.update([inc("q", "critical", rule: "stuck-queue"), inc("s", "critical")], prefs: p, now: 2, hour: 12).isEmpty)
    }

    @Test func aRebootIsOneNotificationNotSixteen() {
        var t = IncidentTracker()
        _ = t.update([], prefs: prefs, now: 0, hour: 12)
        let many = (0..<16).map { inc("r\($0)", $0 == 3 ? "critical" : "warning") }
        let ev = t.update(many, prefs: prefs, now: 1, hour: 12)
        #expect(ev.count == 1)
        guard case .storm(let n, let worst) = ev.first else { Issue.record("no storm"); return }
        #expect(n == 16 && worst.key == "r3")
        #expect(t.update([], prefs: prefs, now: 2, hour: 12) == [.recoveredMany(count: 16)])
    }

    @Test func repairableRules() {
        #expect(inc("drift:launchd-dead:x", "critical", rule: "launchd-dead").isRepairable)
        #expect(inc("drift:stuck-queue:runner-down:x", "critical", rule: "stuck-queue").isRepairable)
        #expect(!inc("account:blocked", "critical", rule: "account-blocked-recurring").isRepairable)
    }
}

@Suite("control against a stub daemon", .serialized)
struct ControlClientTests {
    @Test func catalogueOffersOnlyTheSafeSet() async throws {
        let catalogue = """
        {"readOnly":false,"actions":[{"id":"fleet.healthRepair","label":"Health check and repair","danger":"medium","confirm":null},
        {"id":"runner.deregister","label":"Remove runner","danger":"high","confirm":"This deregisters"},
        {"id":"fleet.cleanupApply","label":"Apply cleanup","danger":"high","confirm":"This deletes DerivedData"}]}
        """
        let server = try StubServer(routes: [
            "/api/actions": .json(200, catalogue),
            "/api/action": .json(200, #"{"ok":true,"command":"./health.sh --repair","code":0,"output":"checking\nrepaired 1 runner\n","durationMs":812}"#),
            "/api/alerts/dismiss": .json(200, #"{"key":"k","scope":"k"}"#),
            "/api/pair": .json(200, #"{"ok":true,"token":"device-token-abc","name":"cockpit"}"#),
        ])
        try await server.start()
        defer { server.stop() }
        let client = FleetClient(base: server.base, token: "t")
        let cat = try await client.actions()
        #expect(cat.action("fleet.healthRepair")?.label == "Health check and repair")
        #expect(cat.action("runner.deregister") == nil)
        #expect(cat.action("fleet.cleanupApply")?.isHighDanger == true)
        let r = try await client.perform("fleet.healthRepair")
        #expect(r.ok && r.summary == "checking\nrepaired 1 runner")
        try await client.dismiss("k")
        #expect(try await client.pair(code: "123456", name: "cockpit") == "device-token-abc")
    }

    @Test func aRefusedActionSaysWhy() async throws {
        let server = try StubServer(routes: ["/api/action": .json(403, #"{"error":"bad token"}"#)])
        try await server.start()
        defer { server.stop() }
        let r = try await FleetClient(base: server.base, token: "wrong").perform("fleet.health")
        #expect(!r.ok && r.summary == "bad token")
    }

    @Test func pairingCodeParsesFromFleetctl() {
        let out = "\nPairing code: 482 913\nOpen on the phone: http://...\n"
        #expect(Pairing.parseCode(out) == "482913")
        #expect(Pairing.parseCode("nothing") == nil)
    }
}
