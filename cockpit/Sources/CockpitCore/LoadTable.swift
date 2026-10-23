import Foundation

/// GET /api/load-by-busy: host load1 p50/p90 by the number of busy runners,
/// from the dashboard's per-minute host samples. `cockpit load` prints it so
/// the admission lanes' heavy limit can be re-tuned when the job mix changes
/// (actions-runners docs/admission-and-scaling.md, "Tuning the lanes").
public struct LoadTable: Codable, Sendable, Equatable {
    public struct Row: Codable, Sendable, Equatable {
        public var busy: Int
        public var n: Int
        public var p50: Double?
        public var p90: Double?
    }

    public struct Limits: Codable, Sendable, Equatable {
        public var heavy: Int?
        public var light: Int?
        public var total: Int?
    }

    public struct Lanes: Codable, Sendable, Equatable {
        public var mode: String?
        public var limits: Limits?
    }

    public var days: Int
    public var host: String?
    public var samples: Int
    public var cores: Int?
    public var rows: [Row]
    public var lanes: Lanes?

    public static func decode(_ data: Data) throws -> LoadTable {
        try JSONDecoder().decode(LoadTable.self, from: data)
    }

    /// The table as the command line prints it.
    public func text() -> String {
        func num(_ v: Double?) -> String { v.map { String(format: "%.1f", $0) } ?? "–" }
        func pad(_ s: String, _ w: Int) -> String { String(repeating: " ", count: max(0, w - s.count)) + s }
        var out = ["\(host ?? "host"): load1 by busy runners, last \(days) day(s), \(samples) sample(s)"
            + (cores.map { ", \($0) cores" } ?? "")]
        if rows.isEmpty {
            out.append("  no samples in the window")
        } else {
            out.append("  busy  samples  load1 p50  load1 p90" + (cores != nil ? "  p90/core" : ""))
            for r in rows {
                var line = "  " + pad(String(r.busy), 4) + "  " + pad(String(r.n), 7)
                    + "  " + pad(num(r.p50), 9) + "  " + pad(num(r.p90), 9)
                if let cores, cores > 0 { line += "  " + pad(num(r.p90.map { $0 / Double(cores) }), 8) }
                out.append(line)
            }
        }
        if let l = lanes, let mode = l.mode {
            let lim = l.limits
            out.append("lanes \(mode): heavy \(lim?.heavy.map(String.init) ?? "–"), light \(lim?.light.map(String.init) ?? "–"), total \(lim?.total.map(String.init) ?? "–")")
        }
        out.append("busy counts runners GitHub shows busy, including jobs held by admission.")
        return out.joined(separator: "\n")
    }
}
