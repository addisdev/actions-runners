import AppKit
import Carbon
import SwiftUI
import CockpitCore

/// URLs arrive through the app delegate: a menu bar app has no window for
/// SwiftUI's onOpenURL to hang off until the popover has been opened.
final class AppDelegate: NSObject, NSApplicationDelegate {
    var onURL: ((URL) -> Void)? {
        didSet { pending.forEach { onURL?($0) }; pending.removeAll() }
    }
    private var pending: [URL] = []

    // Registered directly with the Apple Event manager: once an app declares
    // Window scenes, SwiftUI claims incoming URLs to open windows and stops
    // passing them to application(_:open:).
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass),
                                                     andEventID: AEEventID(kAEGetURL))
    }

    @objc func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: s) else { return }
        if let onURL { onURL(url) } else { pending.append(url) }
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
                .modifier(PanelOpener(model: model))
        }
        .menuBarExtraStyle(.window)

        // The popover as an ordinary window that floats above the others, for a
        // second display during an incident. ⌃⌥⌘F toggles it from anywhere.
        Window("Fleet Cockpit", id: "panel") {
            PopoverView(model: model)
                .background(FloatingWindow())
        }
        .windowResizability(.contentSize)

        Window("Incident Replay", id: "replay") {
            ReplayView()
        }
        .windowResizability(.contentSize)

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

/// Hands the model a way to open the panel window: only a SwiftUI view can
/// hold `openWindow`, and the hotkey arrives in AppKit.
struct PanelOpener: ViewModifier {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    func body(content: Content) -> some View {
        content.task { model.openPanel = { openWindow(id: "panel") } }
    }
}

/// Raises the hosting window to the floating level.
struct FloatingWindow: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { v.window?.level = .floating; v.window?.collectionBehavior.insert(.canJoinAllSpaces) }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
