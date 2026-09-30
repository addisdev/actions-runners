import Foundation
import Testing
@testable import CockpitCore

@Suite("history and posture")
struct HistoryTests {
    let H = 3_600_000.0

    func sample(now: Double) -> FleetTimeline {
        FleetTimeline(
            days: 7, generatedAt: now,
            incidents: [
                .init(key: "admission:disk-floor", rule: "admission-hold", severity: "critical", title: "Disk floor holding 3 jobs",
                      openedAt: now - 30 * H, closedAt: now - 28 * H, rung: "disk-floor"),
                .init(key: "drift:launchd-dead:x", rule: "launchd-dead", severity: "critical", title: "Dead", openedAt: now - 5 * H,
                      closedAt: now - 4 * H, rung: "dead-service"),
                .init(key: "host:pressure", rule: "memory-pressure", severity: "warning", title: "Pressure", openedAt: now - H,
                      closedAt: nil, rung: "saturated"),
            ],
            today: .init(since: now - 10 * H, jobs: 40, queueMs: 3.1 * H, buildMs: 2.4 * H, lostJobs: 1, heldSeconds: 1800),
            week: .init(worstWait: [.init(repo: "acme/comet-web", queueMs: 5 * H, jobs: 120)], incidents: 3,
                        byRung: ["disk-floor": 1, "dead-service": 1, "saturated": 1], mttrMs: 1.5 * H),
            flaky: [.init(runner: "build-host-comet-web", lost: 3)],
            samples: [[now - 60_000, 1.6, 3, 49.3, 2]]
        )
    }

    @Test func lanesInLadderOrderClippedToTheWindow() {
        let now = 1_000_000_000.0
        let day = HistoryPresenter.lanes(sample(now: now), windowMs: 24 * H, now: now)
        #expect(day.map(\.id) == ["dead-service", "saturated"], "the 30 h-old disk hold is outside 24 h")
        let week = HistoryPresenter.lanes(sample(now: now), windowMs: 168 * H, now: now)
        #expect(week.map(\.id) == ["disk-floor", "dead-service", "saturated"])
        #expect(week.last?.spans.first?.open == true)
        #expect(week.last?.spans.first?.to == 1)
    }

    @Test func todayAndDigestLines() {
        let t = sample(now: 1e9)
        #expect(HistoryPresenter.todayLine(t) == "40 jobs today: waited 3.1 h, ran 2.4 h, held 30 min by admission, 1 lost to the host.")
        let d = HistoryPresenter.digest(t)
        #expect(d.title == "Fleet week: 3 incidents")
        #expect(d.body.contains("cleared in 1.5 h on average"))
        #expect(d.body.contains("Longest waits: comet-web (5.0 h over 120 jobs)"))
        #expect(d.body.contains("build-host-comet-web lost 3 jobs"))
    }

    @Test("2026-09-12: Spotlight named as the culprit")
    func spotlightDetector() {
        let out = """
        %CPU COMM
        88.0 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores
        61.2 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared
        40.1 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds
        12.0 node
        """
        let top = HostProbe.parseTop(out)
        #expect(top.spotlightCPU > 180)
        #expect(top.verdict.hasPrefix("Spotlight is using 189% CPU"))
        #expect(HostProbe.parseTop("%CPU COMM\n 3.0 node\n").verdict == "Nothing is hogging the CPU right now.")
    }

    @Test func postureAndForecastFromTheLiveFixture() throws {
        let g = try Fixtures.glance("live")
        #expect(g.posture?.items.map(\.id) == ["spotlight", "auto-login"])
        #expect(g.posture?.items.first?.who == "owner")
        var v = try #require(g.hosts.first { $0.local == true }?.vitals)
        v.diskFloorEtaMs = 8 * H
        v.diskRateGbPerHour = -2.1
        #expect(Presenter.disk(v)?.eta == "floor in ~8.0 h (−2.1 GB/h)")
    }
}

@Suite("replay")
struct ReplayTests {
    @Test func everyStepIsABundledFixture() throws {
        for seq in ReplaySequence.all {
            #expect(!seq.steps.isEmpty)
            for step in seq.steps { _ = try Fixtures.glance(step.fixture) }
        }
    }
}
