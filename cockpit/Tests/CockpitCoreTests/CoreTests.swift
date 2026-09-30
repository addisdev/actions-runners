import Foundation
import Testing
@testable import CockpitCore

// The expected rung for each fixture comes from the daemon's own scenarios
// (dashboard/test/fixtures/scenarios.js). If these disagree, the contract has
// drifted between the two sides.
let expectedVerdicts: [String: String] = [
    "live": "account-blocked",
    "quiet": "clear",
    "waiting": "waiting",
    "dead": "dead-service",
    "diskHold": "disk-floor",
    "diskBelowIdle": "disk-floor",
    "saturated": "saturated",
    "accountBlocked": "account-blocked",
    "drift": "config-drift",
    "agentDown": "host-down",
    "blind": "unknown",
]

@Suite("glance decoding")
struct DecodingTests {
    @Test("every bundled fixture decodes to its scenario's verdict", arguments: Fixtures.names)
    func fixture(_ name: String) throws {
        let g = try Fixtures.glance(name)
        #expect(g.schema == 1)
        #expect(g.verdict.id == expectedVerdicts[name])
        #expect(!g.runners.isEmpty)
        #expect(g.verdict.open.first?.id == g.verdict.id)
    }

    @Test func liveFleetShape() throws {
        let g = try Fixtures.glance("live")
        #expect(g.runners.count == 54)
        #expect(g.hosts.contains { $0.local == true })
        #expect(g.hosts.contains { $0.ghOnly == true && $0.id == "elsewhere:mini" })
    }

    @Test func unknownEnumValuesDoNotBreakDecoding() throws {
        var json = String(decoding: try Fixtures.data("quiet"), as: UTF8.self)
        json = json.replacingOccurrences(of: "\"state\": \"idle\"", with: "\"state\": \"hibernating\"")
        json = json.replacingOccurrences(of: "\"tone\": \"ok\"", with: "\"tone\": \"sparkly\"")
        let g = try Glance.decode(Data(json.utf8))
        #expect(g.runners.contains { $0.state == .unknown })
        #expect(g.verdict.tone == .unknown)
    }

    @Test func aNewerSchemaIsRefusedWithAReason() throws {
        let json = String(decoding: try Fixtures.data("quiet"), as: UTF8.self)
            .replacingOccurrences(of: "\"schema\": 1", with: "\"schema\": 2")
        #expect(throws: GlanceError.unsupportedSchema(2)) { try Glance.decode(Data(json.utf8)) }
    }
}

@Suite("SSE parser")
struct SSETests {
    @Test func dataThenBlankDispatches() {
        var p = SSEParser()
        #expect(p.feed(line: "data: {\"a\":1}") == nil)
        #expect(p.feed(line: "") == .data("{\"a\":1}"))
        #expect(p.feed(line: "") == nil)
    }

    @Test func commentsAreKeepalives() {
        var p = SSEParser()
        #expect(p.feed(line: ": keepalive") == .keepalive)
    }

    @Test func multiLineDataJoinsAndCRIsStripped() {
        var p = SSEParser()
        _ = p.feed(line: "data: one\r")
        _ = p.feed(line: "data:two")
        #expect(p.feed(line: "\r") == .data("one\ntwo"))
    }
}

@Suite("backoff and staleness")
struct TimingTests {
    @Test func backoffDoublesToTheCap() {
        let b = Backoff(jitter: 0)
        #expect(b.delay(attempt: 1) == 1)
        #expect(b.delay(attempt: 2) == 2)
        #expect(b.delay(attempt: 5) == 16)
        #expect(b.delay(attempt: 12) == 30)
    }

    @Test func jitterStaysInsideTwentyPercent() {
        let b = Backoff()
        #expect(abs(b.delay(attempt: 3, random: 0) - 3.2) < 1e-9)
        #expect(abs(b.delay(attempt: 3, random: 1) - 4.8) < 1e-9)
    }

    @Test func stalenessNeverUnderAMinute() {
        #expect(Staleness.window(fastMs: 15_000) == 60_000)
        #expect(Staleness.window(fastMs: 45_000) == 112_500)
        #expect(Staleness.isStale(lastEventMs: nil, fastMs: nil, now: 0))
        #expect(!Staleness.isStale(lastEventMs: 1_000, fastMs: 15_000, now: 50_000))
        #expect(Staleness.isStale(lastEventMs: 1_000, fastMs: 15_000, now: 70_000))
    }
}

@Suite("presenter")
struct PresenterTests {
    let now = 1_790_781_986_956.0

    @Test func lanesPutTheCoordinatorFirstAndGitHubOnlyLast() throws {
        let lanes = Presenter.lanes(try Fixtures.glance("live"), now: now)
        #expect(lanes.first?.id == "build-host")
        #expect(lanes.first?.runnerCount == 48)
        #expect(lanes.last?.ghOnly == true)
        #expect(lanes.last?.runnerCount == 6)
        #expect(lanes.first?.groups.last?.name == "other")
        #expect(lanes.last?.groups.map(\.name) == ["all"], "a small lane is one row")
        #expect(lanes.first?.title == "build-host · 48 runners")
        #expect(lanes.first?.subtitle.hasPrefix("up ") == true)
    }

    @Test func pillNamesDropTheHostPrefix() throws {
        let lanes = Presenter.lanes(try Fixtures.glance("live"), now: now)
        let names = lanes.flatMap { $0.groups.flatMap { $0.pills.map(\.shortName) } }
        #expect(names.contains("comet-web"))
        #expect(!names.contains { $0.hasPrefix("build-host-") })
    }

    @Test func everyStateHasADistinctShapeOrColour() {
        var seen = Set<String>()
        for s in RunnerState.allCases {
            let r = Runner(name: "h-x", repo: nil, project: nil, host: "h", state: s, detail: nil, since: nil, lostAt: nil, job: nil)
            let p = Presenter.pill(r, hostName: "h", now: 0)
            seen.insert("\(p.shape)-\(p.color)")
            #expect(p.accessibilityLabel.hasPrefix("x, "))
        }
        // offline and dead share a glyph on purpose: both need the same repair.
        #expect(seen.count == RunnerState.allCases.count - 1)
    }

    @Test func diskGaugeTonesTrackTheFloor() throws {
        let hold = Presenter.lanes(try Fixtures.glance("diskHold"), now: now).first!.disk!
        #expect(hold.tone == .critical)
        #expect(hold.caption == "36.6 GB free · 3.4 GB BELOW the 40 GB floor")
        let live = Presenter.lanes(try Fixtures.glance("live"), now: now).first!.disk!
        #expect(live.tone == .warning)
        #expect(live.floorFraction! < live.freeFraction)
    }

    @Test func queueRowsOldestFirstWithPlainCauses() throws {
        let rows = Presenter.queue(try Fixtures.glance("dead"))
        #expect(rows.first?.cause == "runner down")
        #expect(rows.first?.causeTone == .critical)
    }

    @Test func menuBarCounts() throws {
        let g = try Fixtures.glance("waiting")
        let m = Presenter.menuBar(verdict: g.verdict, counts: g.counts, showCounts: true)
        #expect(m.counts.contains("1◷"))
        #expect(Presenter.menuBar(verdict: g.verdict, counts: g.counts, showCounts: false).counts.isEmpty)
        #expect(Presenter.symbol(for: .critical, verdictId: "disk-floor") == "externaldrive.badge.exclamationmark")
    }

    @Test func durations() {
        #expect(Format.duration(ms: 20_000) == "under a minute")
        #expect(Format.duration(ms: 7 * 60_000) == "7 min")
        #expect(Format.duration(ms: 84 * 60_000) == "84 min")
        #expect(Format.duration(ms: 3 * 3_600_000) == "3.0 h")
        #expect(Format.short(ms: 45_000) == "45s")
    }
}

@Suite("cockpit verdict")
struct CockpitVerdictTests {
    @Test func aLostStreamIsNeverGreen() throws {
        let g = try Fixtures.glance("quiet")
        let v = CockpitVerdict.effective(glance: g, connection: .reconnecting(attempt: 2, error: "timed out"),
                                         outOfBand: nil, lastGlanceMs: 0, now: 120_000)
        #expect(v.id == "unreachable")
        #expect(v.tone == .unknown)
        #expect(v.sentence?.contains("2 min old") == true)
    }

    @Test func aStalledCollectorAbstains() throws {
        let v = CockpitVerdict.effective(glance: try Fixtures.glance("quiet"), connection: .collectorStale,
                                         outOfBand: nil, lastGlanceMs: nil)
        #expect(v.title == "Collector stalled")
    }

    @Test func outOfBandWins() throws {
        let oob = Verdict(id: "host-down", tone: .critical, title: "Host down", sentence: nil, evidence: [], next: nil, rung: 1, open: [])
        let v = CockpitVerdict.effective(glance: try Fixtures.glance("quiet"), connection: .live, outOfBand: oob, lastGlanceMs: nil)
        #expect(v.id == "host-down")
    }

    @Test func liveShowsTheDaemonsVerdict() throws {
        let g = try Fixtures.glance("diskHold")
        #expect(CockpitVerdict.effective(glance: g, connection: .live, outOfBand: nil, lastGlanceMs: nil) == g.verdict)
    }
}

@Suite("snapshot file")
struct SnapshotFileTests {
    @Test func roundTripsAtomicallyWithPrivatePermissions() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cockpit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("glance.json")
        let g = try Fixtures.glance("live")
        let snap = SnapshotFile(writtenAt: 1000, route: "runner-host", connection: "live", verdict: g.verdict, glance: g)
        try snap.write(to: url)
        try snap.write(to: url) // replace path
        #expect(try SnapshotFile.read(from: url) == snap)
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }
}

@Suite("transport and client against a stub daemon", .serialized)
struct ClientTests {
    @Test func directTransportAndGlanceStream() async throws {
        let quiet = String(decoding: try Fixtures.data("quiet"), as: UTF8.self)
            .replacingOccurrences(of: "\n", with: "")
        let waiting = String(decoding: try Fixtures.data("waiting"), as: UTF8.self)
            .replacingOccurrences(of: "\n", with: "")
        let server = try StubServer(routes: [
            "/api/health": .json(200, "{\"ok\":true}"),
            "/api/glance": .json(200, quiet),
            "/api/stream?view=glance": .sse([quiet, ": keepalive", waiting], hold: 0.2),
        ])
        try await server.start()
        defer { server.stop() }

        let route = try await DirectTransport(url: server.base).open()
        let client = FleetClient(base: route.baseURL)
        #expect(try await client.glance().verdict.id == "clear")

        var events: [FleetClient.StreamEvent] = []
        do {
            for try await e in client.stream() { events.append(e) }
        } catch {}
        let ids = events.compactMap { if case .glance(let g) = $0 { g.verdict.id } else { nil } }
        #expect(ids == ["clear", "waiting"])
        #expect(events.contains(.keepalive))
        #expect(server.seen().contains("/api/stream?view=glance"))
    }

    @Test func anOldDaemonSaysWhatToUpdate() async throws {
        let server = try StubServer(routes: ["/api/health": .json(200, "{}")])
        try await server.start()
        defer { server.stop() }
        await #expect(throws: FleetClient.ClientError.notGlance) {
            _ = try await FleetClient(base: server.base).glance()
        }
    }

    @Test func noRouteNamesWhatWasTried() async throws {
        let t = DirectTransport(url: URL(string: "http://127.0.0.1:1")!)
        await #expect(throws: (any Error).self) { _ = try await t.open() }
    }

    @Test func freePortsAreUsable() throws {
        let p = try #require(freeLocalPort())
        #expect(p > 1024)
    }
}

@Suite("glance store", .serialized)
@MainActor
struct StoreTests {
    @Test func fixtureModeShowsTheFixture() async throws {
        let store = GlanceStore(config: .fixture("diskHold"))
        store.start()
        #expect(store.glance?.verdict.id == "disk-floor")
        #expect(store.connection == .fixture("diskHold"))
        store.stop()
    }

    @Test func connectsAndStreamsThroughATransport() async throws {
        let quiet = String(decoding: try Fixtures.data("quiet"), as: UTF8.self).replacingOccurrences(of: "\n", with: "")
        let dead = String(decoding: try Fixtures.data("dead"), as: UTF8.self).replacingOccurrences(of: "\n", with: "")
        let server = try StubServer(routes: [
            "/api/health": .json(200, "{\"ok\":true}"),
            "/api/glance": .json(200, quiet),
            "/api/stream?view=glance": .sse([dead], hold: 30),
        ])
        try await server.start()
        defer { server.stop() }
        let store = GlanceStore(config: .direct(server.base))
        var seen: [String] = []
        store.onGlance = { seen.append($0.verdict.id) }
        store.start()
        for _ in 0..<50 where seen.count < 2 { try await Task.sleep(nanoseconds: 100_000_000) }
        #expect(seen.prefix(2) == ["clear", "dead-service"])
        #expect(store.connection == .live)
        store.stop()
    }

    @Test func anUnreachableDaemonBacksOffAndSaysWhy() async throws {
        let store = GlanceStore(config: .direct(URL(string: "http://127.0.0.1:1")!), backoff: Backoff(base: 5))
        store.start()
        for _ in 0..<40 {
            if case .reconnecting = store.connection { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard case .reconnecting(let attempt, _) = store.connection else {
            Issue.record("expected reconnecting, got \(store.connection)"); return
        }
        #expect(attempt == 1)
        store.stop()
    }
}
