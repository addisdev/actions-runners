import AppIntents
import Foundation
import CockpitCore

// Shortcuts, Spotlight and Siri. The read intents answer from the app's own
// snapshot file, so they work in a fraction of a second and never open a
// tunnel; the repair intent goes through the running app and its paired token.

struct FleetStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Fleet Status"
    static let description = IntentDescription("The self-hosted runner fleet's verdict in one sentence.")

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let snap = try? SnapshotFile.read(), snap.ageMs() < 5 * 60_000 else {
            return .result(value: "unknown", dialog: "Fleet Cockpit has no current view of the fleet.")
        }
        let v = snap.verdict
        let counts = snap.glance.map { " \($0.counts.running) running, \($0.counts.queued) queued." } ?? ""
        return .result(value: v.id, dialog: "\(v.title). \(v.sentence ?? "")\(counts)")
    }
}

struct WhyQueuedIntent: AppIntent {
    static let title: LocalizedStringResource = "Why Is a Repo Queued"
    static let description = IntentDescription("What the fleet knows about one repository: its runners and why its runs are waiting.")

    @Parameter(title: "Repository", description: "Name or owner/name")
    var repo: String

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let g = (try? SnapshotFile.read())?.glance else {
            return .result(value: "", dialog: "Fleet Cockpit has no current view of the fleet.")
        }
        let match: (String?) -> Bool = { r in guard let r else { return false }; return r == repo || r.hasSuffix("/" + repo) }
        let queue = g.queue.filter { match($0.repo) }
        let runners = g.runners.filter { match($0.repo) }
        var lines: [String] = []
        if runners.isEmpty { lines.append("No runner serves \(repo).") }
        let states = Dictionary(grouping: runners, by: \.state).map { "\($0.value.count) \($0.key.rawValue)" }
        if !states.isEmpty { lines.append("Runners: " + states.joined(separator: ", ") + ".") }
        if queue.isEmpty { lines.append("Nothing queued.") }
        for q in queue {
            let eta = q.etaStartMs.map { " Starts in \(Presenter.range($0))." } ?? ""
            lines.append("\(q.workflow ?? "A run") has waited \(Format.duration(ms: q.queuedMs ?? 0)): \(Presenter.causeLabel(q.cause)).\(eta)")
        }
        let text = lines.joined(separator: " ")
        return .result(value: text, dialog: "\(text)")
    }
}

struct RepairFleetIntent: AppIntent {
    static let title: LocalizedStringResource = "Repair Fleet"
    static let description = IntentDescription("Runs the fleet's health check and repair: restarts runner services that have died.")
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let model = AppModel.shared, model.isPaired, let client = model.store.client else {
            return .result(dialog: "Fleet Cockpit is not running, or this Mac is not paired with the dashboard.")
        }
        try await requestConfirmation(result: .result(dialog: "Run health check and repair on the runner host?"))
        let r = (try? await client.perform("fleet.healthRepair")) ?? ActionResult(ok: false, error: "no reply")
        return .result(dialog: r.ok ? "Repair finished." : "Repair failed: \(r.summary)")
    }
}

struct FleetShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: FleetStatusIntent(), phrases: ["Fleet status in \(.applicationName)", "How is the fleet in \(.applicationName)"],
                    shortTitle: "Fleet Status", systemImageName: "server.rack")
        AppShortcut(intent: RepairFleetIntent(), phrases: ["Repair the fleet in \(.applicationName)"],
                    shortTitle: "Repair Fleet", systemImageName: "wrench.and.screwdriver")
    }
}

/// A Focus filter: while a Focus is on, notify for critical only, or not at all.
struct FleetFocusFilter: SetFocusFilterIntent {
    static let title: LocalizedStringResource = "Fleet Cockpit notifications"
    static let description: IntentDescription? = IntentDescription("Choose which fleet alerts reach you during this Focus.")

    enum Level: String, AppEnum {
        case all, critical, none
        static let typeDisplayRepresentation: TypeDisplayRepresentation = "Alerts"
        static let caseDisplayRepresentations: [Level: DisplayRepresentation] = [
            .all: "Critical and warning", .critical: "Critical only", .none: "None",
        ]
    }

    @Parameter(title: "Alerts", default: .all)
    var level: Level

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "Fleet alerts: \(level.rawValue)")
    }

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(level.rawValue, forKey: "focus.level")
        return .result()
    }
}
