import SwiftUI
import CockpitCore

extension Tone {
    var color: Color {
        switch self {
        case .critical: .red
        case .warning: .orange
        case .unknown: .gray
        case .info: .blue
        case .ok: .green
        }
    }
}

extension PillColor {
    var color: Color {
        switch self {
        case .idle: .green
        case .busy: .accentColor
        case .caution: .orange
        case .neutral: .secondary
        case .critical: .red
        case .config: .purple
        case .faint: .gray.opacity(0.55)
        }
    }
}

enum Metrics {
    static let popoverWidth: CGFloat = 440
    static let pill: CGFloat = 14
    static let densePill: CGFloat = 10
}
