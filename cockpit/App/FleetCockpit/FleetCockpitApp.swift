import SwiftUI
import CockpitCore

@main
struct FleetCockpitApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            PopoverView(model: model)
        } label: {
            MenuBarLabel(model: model)
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
