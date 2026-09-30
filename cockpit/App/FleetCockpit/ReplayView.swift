import Combine
import SwiftUI
import CockpitCore

/// Steps through a recorded incident with the real popover, so the verdict,
/// the pills and the buttons can be seen exactly as they read during it.
struct ReplayView: View {
    @State private var model = AppModel(replay: true)
    @State private var sequence = ReplaySequence.all[0]
    @State private var step = 0
    @State private var playing = false
    private let timer = Timer.publish(every: 3, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Picker("Incident", selection: $sequence) {
                    ForEach(ReplaySequence.all) { Text($0.title).tag($0) }
                }
                Button(playing ? "Pause" : "Play") { playing.toggle() }
            }
            Slider(value: Binding(get: { Double(step) }, set: { step = Int($0.rounded()) }),
                   in: 0...Double(max(1, sequence.steps.count - 1)), step: 1)
                .disabled(sequence.steps.count < 2)
            Text("\(step + 1)/\(sequence.steps.count) · \(sequence.steps[min(step, sequence.steps.count - 1)].caption)")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            PopoverView(model: model)
        }
        .padding(12)
        .onAppear(perform: show)
        .onChange(of: step) { _, _ in show() }
        .onChange(of: sequence) { _, _ in step = 0; show() }
        .onReceive(timer) { _ in
            guard playing else { return }
            if step < sequence.steps.count - 1 { step += 1 } else { playing = false }
        }
    }

    private func show() {
        let s = sequence.steps[min(step, sequence.steps.count - 1)]
        if let g = try? Fixtures.glance(s.fixture) { model.store.show(g, as: .fixture(s.fixture)) }
    }
}
