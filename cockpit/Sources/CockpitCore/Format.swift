import Foundation

public enum Format {
    /// "under a minute", "7 min", "1.4 h", "3 d" — the same wording fleetd uses.
    public static func duration(ms: Double) -> String {
        let m = (ms / 60_000).rounded()
        if m < 1 { return "under a minute" }
        if m < 90 { return "\(Int(m)) min" }
        let h = ms / 3_600_000
        if h < 48 { return String(format: "%.1f h", h) }
        return "\(Int((h / 24).rounded())) d"
    }

    /// Compact form for tight places: "45s", "7m", "1.4h".
    public static func short(ms: Double) -> String {
        let s = ms / 1000
        if s < 60 { return "\(Int(s.rounded()))s" }
        let m = s / 60
        if m < 90 { return "\(Int(m.rounded()))m" }
        return String(format: "%.1fh", m / 60)
    }

    public static func gb(_ v: Double?) -> String {
        guard let v else { return "–" }
        return v < 100 ? String(format: "%.1f GB", v) : "\(Int(v.rounded())) GB"
    }

    public static func ago(_ ms: Double?, now: Double) -> String {
        guard let ms else { return "never" }
        let d = max(0, now - ms)
        return d < 5_000 ? "just now" : "\(short(ms: d)) ago"
    }

    public static func nowMs(_ date: Date = Date()) -> Double { date.timeIntervalSince1970 * 1000 }
}
