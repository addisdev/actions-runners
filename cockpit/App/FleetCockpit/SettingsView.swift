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
            Section("Control") {
                LabeledContent("This Mac") {
                    Text(model.isPaired ? "Paired — actions enabled" : "Not paired — read-only")
                        .foregroundStyle(model.isPaired ? .green : .secondary)
                }
                HStack {
                    Button(model.isPaired ? "Pair again" : "Pair this Mac") { Task { await model.pair() } }
                        .disabled(model.store.client == nil || model.settings.mode != .tunnel)
                    if model.isPaired { Button("Forget token") { model.forgetPairing() } }
                }
                if let s = model.pairingStatus { Text(s).font(.caption).foregroundStyle(.secondary) }
                Text("Pairing runs fleetctl.sh pair on the host over your first SSH alias and stores this Mac's own revocable token in the Keychain. The master token never leaves the host.")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("Fleet root on the host", text: $draft.fleetRoot)
            }
            Section("Notifications") {
                Picker("Notify for", selection: $draft.notifications.minSeverity) {
                    Text("Critical and warning").tag("warning")
                    Text("Critical only").tag("critical")
                }
                Toggle("Quiet hours (critical only)", isOn: Binding(
                    get: { draft.notifications.quietStart != nil },
                    set: { on in
                        draft.notifications.quietStart = on ? 22 : nil
                        draft.notifications.quietEnd = on ? 7 : nil
                    }))
                if draft.notifications.quietStart != nil {
                    Stepper("From \(draft.notifications.quietStart ?? 22):00", value: Binding(
                        get: { draft.notifications.quietStart ?? 22 }, set: { draft.notifications.quietStart = $0 }), in: 0...23)
                    Stepper("Until \(draft.notifications.quietEnd ?? 7):00", value: Binding(
                        get: { draft.notifications.quietEnd ?? 7 }, set: { draft.notifications.quietEnd = $0 }), in: 0...23)
                }
                TextField("Muted rules (comma-separated, e.g. stuck-queue, runner-unused)", text: Binding(
                    get: { draft.notifications.mutedRules.sorted().joined(separator: ", ") },
                    set: { draft.notifications.mutedRules = Set($0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }) }))
            }
            Section("Display") {
                Toggle("Show running and queued counts in the menu bar", isOn: $draft.showCounts)
                Toggle("Compact runner dots", isOn: $draft.dense)
                Toggle("Play a sound when a watched commit goes green", isOn: $draft.soundOnGreen)
                LabeledContent("Floating window") { Text("⌃⌥⌘F").font(.system(.body, design: .monospaced)) }
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
