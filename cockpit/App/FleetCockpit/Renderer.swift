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
