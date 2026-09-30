import AppKit
import SwiftUI
import CockpitCore

/// URLs arrive through the app delegate: a menu bar app has no window for
/// SwiftUI's onOpenURL to hang off until the popover has been opened.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var onURL: ((URL) -> Void)?
    func application(_ application: NSApplication, open urls: [URL]) {
        for u in urls { onURL?(u) }
    }
}

@main
struct FleetCockpitApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    init() {}

    var body: some Scene {
        MenuBarExtra {
            PopoverView(model: model)
        } label: {
            MenuBarLabel(model: model)
                .task { delegate.onURL = { [model] url in model.handle(url) } }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: model)
        }
    }
}

struct MenuBarLabel: View {
    let model: AppModel

    var body: some View {
        let m = model.menuBar
        HStack(spacing: 3) {
            Image(systemName: m.symbol)
            if !m.counts.isEmpty {
                Text(m.counts).monospacedDigit()
            }
        }
        .help(m.tooltip)
        .accessibilityLabel("Fleet: \(m.tooltip)")
    }
}
