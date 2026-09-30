import SwiftUI
import CockpitCore

struct SettingsView: View {
    @Bindable var model: AppModel
    @State private var draft = AppSettings()
    @State private var loginItem = false

    var body: some View {
        Form {
            Section("Connection") {
                Picker("Reach the dashboard by", selection: $draft.mode) {
                    ForEach(AppSettings.Mode.allCases) { Text($0.label).tag($0) }
                }
                switch draft.mode {
                case .tunnel:
                    TextField("SSH aliases, in order", text: $draft.aliases)
                    Text("Each alias from ~/.ssh/config is tried in turn. Key-based login only; nothing is changed on the host.")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("Dashboard port on the host", value: $draft.remotePort, format: .number.grouping(.never))
                case .direct:
                    TextField("Dashboard URL", text: $draft.directURL)
                    Text("For a dashboard served over Tailscale Serve or bound to the LAN.")
                        .font(.caption).foregroundStyle(.secondary)
                case .fixture:
                    Picker("Scenario", selection: $draft.fixture) {
                        ForEach(Fixtures.names, id: \.self) { Text($0).tag($0) }
                    }
                    Text("A recorded fleet state. Useful for screenshots and trying the app without a fleet.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Display") {
                Toggle("Show running and queued counts in the menu bar", isOn: $draft.showCounts)
                Toggle("Compact runner dots", isOn: $draft.dense)
            }
            Section("System") {
                Toggle("Open at login", isOn: $loginItem)
                    .onChange(of: loginItem) { _, v in model.launchAtLogin = v }
            }
            HStack {
                Spacer()
                Button("Revert") { draft = model.settings }
                    .disabled(draft == model.settings)
                Button("Apply") { model.settings = draft }
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft == model.settings)
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .onAppear {
            draft = model.settings
            loginItem = model.launchAtLogin
        }
    }
}
