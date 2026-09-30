import Foundation
import UserNotifications
import CockpitCore

/// macOS notifications. Transitions only, never levels: a condition announces
/// itself once when it opens and once when it clears, with how long it lasted.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    /// The out-of-band condition last announced, and when it opened.
    private var cockpitOpen: (id: String, title: String, since: Date)?
    var onAction: ((String, [String: String]) -> Void)?

    override init() {
        super.init()
        center.delegate = self
    }

    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    /// Conditions only this Mac can see: host down, dashboard down, blind.
    func cockpit(_ verdict: Verdict?) {
        if let v = verdict, v.tone == .critical || v.tone == .warning || v.id == "blind" {
            guard cockpitOpen?.id != v.id || cockpitOpen?.title != v.title else { return }
            cockpitOpen = (v.id, v.title, cockpitOpen?.since ?? Date())
            post(id: "cockpit:\(v.id)", title: v.title, body: v.sentence ?? "", critical: v.tone == .critical,
                 info: ["kind": "cockpit", "verdict": v.id])
        } else if let open = cockpitOpen {
            let lasted = Format.duration(ms: Date().timeIntervalSince(open.since) * 1000)
            cockpitOpen = nil
            post(id: "cockpit:recovered", title: "Fleet reachable again",
                 body: "\(open.title) — resolved after \(lasted).", critical: false, info: ["kind": "cockpit"])
        }
    }

    func post(id: String, title: String, body: String, critical: Bool, info: [String: String],
              category: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = info
        content.sound = critical ? .defaultCritical : nil
        content.interruptionLevel = critical ? .timeSensitive : .active
        if let category { content.categoryIdentifier = category }
        center.add(UNNotificationRequest(identifier: "\(id):\(UUID().uuidString)", content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let action = response.actionIdentifier
        let info = (response.notification.request.content.userInfo as? [String: String]) ?? [:]
        Task { @MainActor in self.onAction?(action, info) }
        completionHandler()
    }
}
