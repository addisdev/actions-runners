// Draws Fleet Cockpit's app icon at every size the asset catalog needs.
//   swiftc -O draw-icon.swift -o /tmp/draw-icon && /tmp/draw-icon <out-dir>
// then copy icon_<px>.png into FleetCockpit/Assets.xcassets/AppIcon.appiconset
// (icon_16x16.png = 16 px, icon_16x16@2x.png = 32 px, and so on up to 1024).

import AppKit
import CoreGraphics

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

func render(_ px: Int) -> Data {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)
    // Work top-down like the design grid.
    ctx.translateBy(x: 0, y: 1024); ctx.scaleBy(x: 1, y: -1)
    ctx.interpolationQuality = .high

    // Background squircle on Apple's 1024 grid (824 body, 100 inset).
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let bodyPath = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: rgb(0x000000, 0.35))
    ctx.addPath(bodyPath); ctx.setFillColor(rgb(0x131B2E)); ctx.fillPath()
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(bodyPath); ctx.clip()
    let bg = CGGradient(colorsSpace: cs, colors: [rgb(0x24335A), rgb(0x0D1322)] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    let glow = CGGradient(colorsSpace: cs, colors: [rgb(0xFFFFFF, 0.10), rgb(0xFFFFFF, 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 120), startRadius: 0,
                           endCenter: CGPoint(x: 512, y: 120), endRadius: 560, options: [])
    ctx.restoreGState()
    ctx.addPath(CGPath(roundedRect: body.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 184, cornerHeight: 184, transform: nil))
    ctx.setStrokeColor(rgb(0xFFFFFF, 0.10)); ctx.setLineWidth(3); ctx.strokePath()

    func pill(_ r: CGRect, _ c: CGColor, glow: Bool = true) {
        let p = CGPath(roundedRect: r, cornerWidth: r.height / 2, cornerHeight: r.height / 2, transform: nil)
        ctx.saveGState()
        if glow { ctx.setShadow(offset: .zero, blur: 18, color: c.copy(alpha: 0.55)) }
        ctx.addPath(p); ctx.setFillColor(c); ctx.fillPath()
        ctx.restoreGState()
        // soft top sheen
        ctx.saveGState(); ctx.addPath(p); ctx.clip()
        let sheen = CGGradient(colorsSpace: cs, colors: [rgb(0xFFFFFF, 0.28), rgb(0xFFFFFF, 0)] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(sheen, start: CGPoint(x: r.midX, y: r.minY), end: CGPoint(x: r.midX, y: r.midY), options: [])
        ctx.restoreGState()
    }

    // Verdict banner.
    let banner = CGRect(x: 212, y: 290, width: 600, height: 100)
    let bp = CGPath(roundedRect: banner, cornerWidth: 30, cornerHeight: 30, transform: nil)
    ctx.addPath(bp); ctx.setFillColor(rgb(0x34C759, 0.16)); ctx.fillPath()
    ctx.addPath(bp); ctx.setStrokeColor(rgb(0x34C759, 0.55)); ctx.setLineWidth(4); ctx.strokePath()
    let dot = CGRect(x: 240, y: 308, width: 64, height: 64)
    ctx.saveGState(); ctx.setShadow(offset: .zero, blur: 16, color: rgb(0x34C759, 0.6))
    ctx.setFillColor(rgb(0x34C759)); ctx.fillEllipse(in: dot); ctx.restoreGState()
    ctx.setStrokeColor(rgb(0x0D1322)); ctx.setLineWidth(9); ctx.setLineCap(.round); ctx.setLineJoin(.round)
    ctx.move(to: CGPoint(x: 256, y: 341)); ctx.addLine(to: CGPoint(x: 268, y: 354)); ctx.addLine(to: CGPoint(x: 290, y: 327))
    ctx.strokePath()
    for (x, w, a) in [(332.0, 300.0, 0.55), (332.0, 190.0, 0.25)] as [(CGFloat, CGFloat, CGFloat)] {
        let y: CGFloat = a > 0.3 ? 318 : 350
        ctx.addPath(CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: 14), cornerWidth: 7, cornerHeight: 7, transform: nil))
        ctx.setFillColor(rgb(0xFFFFFF, a)); ctx.fillPath()
    }

    // Runner lanes: 3 rows x 4 pills.
    let g = rgb(0x34C759), b = rgb(0x0A84FF), a = rgb(0xFF9F0A), idle = rgb(0x3A4766)
    let rows: [[CGColor]] = [[g, g, b, g], [g, b, g, a], [g, g, idle, idle]]
    let w: CGFloat = 132, h: CGFloat = 68, gapX: CGFloat = 24, gapY: CGFloat = 34
    for (ri, row) in rows.enumerated() {
        for (ci, c) in row.enumerated() {
            let r = CGRect(x: 212 + CGFloat(ci) * (w + gapX), y: 446 + CGFloat(ri) * (h + gapY), width: w, height: h)
            pill(r, c, glow: c !== idle)
        }
    }
    let img = ctx.makeImage()!
    return NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])!
}

let out = CommandLine.arguments[1]
for px in [16, 32, 64, 128, 256, 512, 1024] {
    try! render(px).write(to: URL(fileURLWithPath: "\(out)/icon_\(px).png"))
}
print("ok")
