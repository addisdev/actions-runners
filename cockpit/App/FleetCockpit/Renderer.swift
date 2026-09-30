import AppKit
import SwiftUI
import CockpitCore

/// `Fleet Cockpit --fixture diskHold --render out.png [--dark]`: draws the
/// popover for a recorded fleet state to a PNG and exits. Used for README
/// screenshots and for checking a layout change without clicking the menu bar.
@MainActor
enum Renderer {
    static func runIfRequested(_ model: AppModel) {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "--render"), i + 1 < args.count else { return }
        let out = URL(fileURLWithPath: args[i + 1])
        let dark = args.contains("--dark")
        model.showLadder = args.contains("--why")
        if let j = args.firstIndex(of: "--hover"), j + 1 < args.count, let g = model.store.glance {
            let name = args[j + 1]
            model.hovered = Presenter.lanes(g, now: Format.nowMs()).flatMap { $0.groups.flatMap(\.pills) }
                .first { $0.name.hasSuffix(name) }
        }
        if args.contains("--pending") {
            model.pending = (ActionDef(id: "fleet.cleanupApply", label: "Apply cleanup", danger: "high",
                                       confirm: "This deletes DerivedData, dead simulators and old _diag logs. Preview first."), [:])
        }
        if let j = args.firstIndex(of: "--select"), j + 1 < args.count, let g = model.store.glance {
            model.selectedRunner = Presenter.lanes(g, now: model.clockMs()).flatMap { $0.groups.flatMap(\.pills) }
                .first { $0.name.hasSuffix(args[j + 1]) }
            let sample = """
            {"remote":false,"events":[{"ts":\(model.clockMs() - 840_000),"kind":"state","detail":"running|online|idle -> dead|offline|busy"}],
             "jobs":[{"id":1,"name":"ci / test","status":"completed","conclusion":"failure"}],
             "utilization":{"days":7,"jobCount":27,"failureCount":2,"totalMs":6520000}}
            """
            model.runnerDetail = try? JSONDecoder().decode(RunnerDetail.self, from: Data(sample.utf8))
        }
        if args.contains("--history") {
            let now = model.clockMs(), H = 3_600_000.0
            var samples: [[Double?]] = []
            for i in 0..<40 {
                let x = Double(i)
                let ts: Double = now - (40 - x) * 180_000
                let load: Double = 1.2 + sin(x / 5) * 0.6
                let swap: Double = i % 7 == 0 ? 60 : 3
                let disk: Double = 60 - x * 0.25
                samples.append([ts, load, swap, disk, 2])
            }
            let json = """
            {"days":7,"generatedAt":\(now),"flaky":[{"runner":"build-host-comet-web","lost":3}],"samples":[],
             "incidents":[
              {"key":"admission:disk-floor","rule":"admission-hold","severity":"critical","title":"Disk floor holding 3 jobs","openedAt":\(now - 30 * H),"closedAt":\(now - 28 * H),"rung":"disk-floor"},
              {"key":"drift:launchd-dead:x","rule":"launchd-dead","severity":"critical","title":"Runner service is dead","openedAt":\(now - 5 * H),"closedAt":\(now - 4.5 * H),"rung":"dead-service"},
              {"key":"host:saturated","rule":"host-saturated","severity":"warning","title":"2 jobs lost contact","openedAt":\(now - 60 * H),"closedAt":\(now - 58 * H),"rung":"saturated"},
              {"key":"account:blocked","rule":"account-blocked-recurring","severity":"critical","title":"Account blocked","openedAt":\(now - 20 * H),"rung":"account-blocked"}],
             "today":{"since":\(now - 10 * H),"jobs":43,"queueMs":\(3.1 * H),"buildMs":\(2.4 * H),"lostJobs":0,"heldSeconds":1800},
             "week":{"worstWait":[{"repo":"acme/comet-web","queueMs":\(5 * H),"jobs":120}],"incidents":4,"byRung":{"disk-floor":1},"mttrMs":\(1.4 * H)}}
            """
            var tl = try? JSONDecoder().decode(Timeline.self, from: Data(json.utf8))
            tl?.samples = samples
            model.timeline = tl
            model.showHistory = true
            model.historyWindowDays = 7
            model.showPosture = true
        }
        DispatchQueue.main.async {
            let view = PopoverView(model: model)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, dark ? .dark : .light)
                .environment(\.isRendering, true)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            guard let cg = renderer.cgImage else { FileHandle.standardError.write(Data("render failed\n".utf8)); exit(1) }
            let rep = NSBitmapImageRep(cgImage: cg)
            try? rep.representation(using: .png, properties: [:])?.write(to: out)
            print("wrote \(out.path) \(cg.width)x\(cg.height)")
            exit(0)
        }
    }
}
