import SwiftUI
import CockpitCore

/// One runner. The shape says the state; the colour only agrees with it.
struct PillView: View {
    let pill: PillModel
    var size: CGFloat = Metrics.pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let c = pill.color.color
        ZStack {
            switch pill.shape {
            case .ring:
                Circle().strokeBorder(c, lineWidth: 2)
            case .progress:
                if let p = pill.progress {
                    Circle().fill(c.opacity(0.18))
                    Circle()
                        .trim(from: 0, to: min(1, p))
                        .stroke(c, style: StrokeStyle(lineWidth: size * 0.5, lineCap: .butt))
                        .rotationEffect(.degrees(-90))
                        .padding(size * 0.25)
                    Circle().strokeBorder(c, lineWidth: 1.5)
                } else {
                    Circle().fill(c)
                }
            case .hourglass:
                Circle().strokeBorder(c, lineWidth: 2)
                Circle().fill(c).padding(size * 0.3)
            case .square:
                RoundedRectangle(cornerRadius: 2.5).fill(c).padding(1)
            case .dashed:
                Circle().strokeBorder(c, style: StrokeStyle(lineWidth: 2, dash: [2.2, 1.8]))
            case .cross:
                Circle().fill(c.opacity(0.2))
                Circle().strokeBorder(c, lineWidth: 1.5)
                Image(systemName: "xmark").font(.system(size: size * 0.55, weight: .heavy)).foregroundStyle(c)
            case .diamond:
                Rectangle().fill(c).rotationEffect(.degrees(45)).scaleEffect(0.62)
            case .arrow:
                Image(systemName: "arrow.right.circle").font(.system(size: size * 0.95, weight: .semibold)).foregroundStyle(c)
            case .question:
                Image(systemName: "questionmark.circle.fill").font(.system(size: size * 0.95)).foregroundStyle(c)
            case .hatched:
                Canvas { ctx, sz in
                    let circle = Path(ellipseIn: CGRect(origin: .zero, size: sz))
                    ctx.clip(to: circle)
                    var stripes = Path()
                    var x: CGFloat = -sz.height
                    while x < sz.width {
                        stripes.move(to: CGPoint(x: x, y: sz.height))
                        stripes.addLine(to: CGPoint(x: x + sz.height, y: 0))
                        x += 3.5
                    }
                    ctx.stroke(stripes, with: .color(c), lineWidth: 1.2)
                    ctx.stroke(circle, with: .color(c), lineWidth: 1.5)
                }
            case .dotted:
                Circle().strokeBorder(c, style: StrokeStyle(lineWidth: 1.5, dash: [1, 2]))
            }
        }
        .frame(width: size, height: size)
        .contentShape(Rectangle())
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: pill.state)
        .accessibilityElement()
        .accessibilityLabel(pill.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}
