import Foundation
import CockpitCore

// `cockpit` — the fleet verdict for scripts and agent sessions.
//
// Reads the menu bar app's live view when it is fresh, and connects by itself
// (same SSH tunnel, same aliases) when the app is not running.

let usage = """
usage: cockpit <command> [options]

commands:
  status              the fleet verdict, one screen
  why <repo>          everything the fleet knows about one repo: its runners, queue with
                      causes and ETAs, recent failures and open alerts
  queue               every queued run, oldest first, with cause and ETA
  wait <repo>         block until a commit's checks finish (--pr N | --sha S | --branch B,
                      --timeout 45m). Exit 0 green, 1 red, 2 waiting is pointless (host
                      down, disk floor, billing block, a check that will never start),
                      3 timed out or nothing readable
  sentinel            check the host out of band (SSH, GitHub, the other machine) —
                      what the app does when the dashboard does not answer
  brief               a markdown incident brief of the current state
  pair                pair this command line with the dashboard (its own revocable token)
  run <action>        run a catalogue action (e.g. fleet.health, fleet.healthRepair,
                      runner.restart --name <runner>); anything but a read needs --yes
  fixtures            list the bundled fixture names

options:
  --json              machine-readable output
  --fixture <name>    use a bundled fixture instead of the live fleet
  --via <alias>       ssh alias to tunnel through (repeatable; default: runner-host, runner-ts)
  --url <url>         reach the dashboard directly
  --fresh             ignore the app's snapshot and connect now
  --port <n>          the dashboard's port on the host (default 7878)
"""

struct Options {
    var command = "status"
    var json = false
    var fixture: String?
    var via: [String] = []
    var url: URL?
    var fresh = false
    var positional: [String] = []
    var flags: [String: String] = [:]

    init() {}
    init(command: String, fresh: Bool, positional: [String], flags: [String: String]) {
        self.command = command; self.fresh = fresh; self.positional = positional; self.flags = flags
    }
}

func parse(_ args: [String]) -> Options {
    var o = Options()
    var i = 0
    var sawCommand = false
    while i < args.count {
        let a = args[i]
        func value() -> String? { i + 1 < args.count ? { i += 1; return args[i] }() : nil }
        switch a {
        case "--json": o.json = true
        case "--fresh": o.fresh = true
        case "--fixture": o.fixture = value()
        case "--via": if let v = value() { o.via.append(v) }
        case "--url": o.url = value().flatMap(URL.init(string:))
        case "-h", "--help": print(usage); exit(0)
        default:
            if a.hasPrefix("--") {
                let key = String(a.dropFirst(2))
                if i + 1 < args.count, !args[i + 1].hasPrefix("--") { o.flags[key] = value() } else { o.flags[key] = "true" }
            } else if !sawCommand {
                o.command = a; sawCommand = true
            } else {
                o.positional.append(a)
            }
        }
        i += 1
    }
    return o
}

func fail(_ msg: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(code)
}

extension Options {
    func with(via: [String], url: URL?) -> Options {
        var o = self
        o.via = via
        o.url = url
        return o
    }
}

struct Source {
    var glance: Glance?
    var verdict: Verdict
    var route: String
    var client: FleetClient?
    var transport: Transport?
}

/// Where the answer comes from, in order of cheapness.
func obtain(_ o: Options) async -> Source {
    if let name = o.fixture {
        do {
            let g = try Fixtures.glance(name)
            return Source(glance: g, verdict: g.verdict, route: "fixture: \(name)")
        } catch { fail("no fixture named \(name) (try: cockpit fixtures)") }
    }
    if !o.fresh, o.url == nil, o.via.isEmpty, let snap = try? SnapshotFile.read(), snap.ageMs() < 90_000 {
        return Source(glance: snap.glance, verdict: snap.verdict, route: "app (\(snap.route ?? "?"), \(Format.ago(snap.writtenAt, now: Format.nowMs())))")
    }
    let transport: Transport = o.url.map { DirectTransport(url: $0) }
        ?? TunnelTransport(aliases: o.via.isEmpty ? ["runner-host", "runner-ts"] : o.via)
    do {
        let route = try await transport.open()
        let client = FleetClient(base: route.baseURL)
        let g = try await client.glance()
        return Source(glance: g, verdict: g.verdict, route: route.label, client: client, transport: transport)
    } catch {
        transport.close()
        let v = Verdict(id: "unreachable", tone: .unknown, title: "Dashboard unreachable",
                        sentence: "Could not reach the dashboard: \(error)", evidence: [], next: nil, rung: nil, open: [])
        return Source(glance: nil, verdict: v, route: "none")
    }
}

func printJSON<T: Encodable>(_ v: T) {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try! enc.encode(v), as: UTF8.self))
}

func mark(_ t: Tone) -> String {
    switch t {
    case .critical: "✖"
    case .warning: "▲"
    case .unknown: "?"
    case .info, .ok: "✔"
    }
}

func printVerdict(_ v: Verdict, route: String, glance: Glance?) {
    print("\(mark(v.tone)) \(v.title)")
    if let s = v.sentence { print("  \(s)") }
    for e in v.evidence { print("  · \(e)") }
    if let n = v.next, n.kind != "none" {
        var line = "  → \(n.label)"
        if let c = n.command { line += ": \(c)" }
        if let u = n.url { line += ": \(u)" }
        print(line)
    }
    let others = v.open.dropFirst()
    if !others.isEmpty {
        print("  also open: " + others.map { "\($0.title) (\($0.tone.rawValue))" }.joined(separator: "; "))
    }
    if let g = glance {
        print("  \(g.counts.running) running, \(g.counts.queued) queued, \(g.counts.held) held, \(g.counts.runners) runners · via \(route)")
    } else {
        print("  via \(route)")
    }
}

/// Exit codes shared by every command: 0 fine or healthy waiting, 1 a real
/// fault, 3 nothing could be read. `wait` adds 2 (see its help).
func exitCode(_ v: Verdict) -> Int32 {
    switch v.tone {
    case .ok, .info: 0
    case .unknown: 3
    case .warning, .critical: 1
    }
}

let opts = parse(Array(CommandLine.arguments.dropFirst()))

switch opts.command {
case "fixtures":
    for n in Fixtures.names { print(n) }
case "status":
    let src = await obtain(opts)
    defer { src.transport?.close() }
    if opts.json {
        struct Out: Encodable { let verdict: Verdict; let route: String; let counts: Counts? }
        printJSON(Out(verdict: src.verdict, route: src.route, counts: src.glance?.counts))
    } else {
        printVerdict(src.verdict, route: src.route, glance: src.glance)
    }
    src.transport?.close()
    exit(exitCode(src.verdict))
case "sentinel":
    let aliases = opts.via.isEmpty ? ["runner-host", "runner-ts"] : opts.via
    let targets = (try? SnapshotFile.read())?.glance.flatMap { SentinelTargets.from($0) }
    var probe = SentinelProbe(aliases: aliases)
    if let port = opts.flags["port"].flatMap(Int.init) { probe.remotePort = port }
    let probes = await probe.run(targets, localNetwork: true)
    let v = Sentinel.classify(probes, hostName: targets?.hostName ?? aliases.first ?? "host")
    if opts.json {
        printJSON(v)
    } else {
        printVerdict(v, route: "out of band", glance: nil)
        if targets == nil { print("  (no snapshot from the app yet: GitHub runner checks skipped)") }
    }
    exit(exitCode(v))
case "pair":
    let alias = opts.via.first ?? "runner-host"
    let src = await obtain(Options(command: "status", fresh: true, positional: [], flags: [:]).with(via: opts.via, url: opts.url))
    guard let client = src.client, let g = src.glance else { fail("cannot reach the dashboard to pair") }
    let account = "cli:" + (g.hosts.first { $0.local == true }?.id ?? alias)
    guard let code = await Pairing.mintCode(alias: alias, fleetRoot: opts.flags["fleet-root"] ?? "~/actions-runners") else {
        fail("could not get a pairing code from \(alias) (is fleetctl.sh there?)")
    }
    do {
        let token = try await client.pair(code: code, name: "cockpit CLI on \(Foundation.Host.current().localizedName ?? "this Mac")")
        do { try CLITokenFile.save(token, account: account) } catch { fail("paired, but the token could not be saved: \(error)") }
        print("paired; token saved for \(account) (mode 0600). Revoke on the host with ./fleetctl.sh revoke")
    } catch { fail("pairing failed: \(error)") }
    src.transport?.close()
case "run":
    guard let action = opts.positional.first else { fail("usage: cockpit run <action> [--name <runner>] [--yes]", code: 64) }
    var src = await obtain(Options(command: "status", fresh: true, positional: [], flags: [:]).with(via: opts.via, url: opts.url))
    guard var client = src.client, let g = src.glance else { fail("cannot reach the dashboard") }
    let account = "cli:" + (g.hosts.first { $0.local == true }?.id ?? "fleet")
    guard let token = CLITokenFile.load(account: account) else { fail("not paired: run `cockpit pair` first") }
    client.token = token
    guard let def = (try? await client.actions())?.action(action) else {
        fail("\(action) is not an action the cockpit offers (see GET /api/actions)")
    }
    // Anything that changes the fleet needs an explicit --yes: an agent
    // exploring the CLI must not repair or restart by accident.
    if (def.danger ?? "none") != "none" && opts.flags["yes"] == nil {
        fail("\(def.label) (\(def.danger ?? "?") danger): \(def.confirm ?? "changes the fleet"). Re-run with --yes to proceed.", code: 2)
    }
    var args: [String: Any] = [:]
    if let n = opts.flags["name"] { args["name"] = n }
    let r = await (try? client.perform(action, args: args)) ?? ActionResult(ok: false, error: "request failed")
    if opts.json { printJSON(r) } else { print(r.ok ? "✔ \(def.label)" : "✖ \(def.label)"); if !r.summary.isEmpty { print(r.summary) } }
    src.transport?.close()
    src.transport = nil
    exit(r.ok ? 0 : 1)
case "why":
    guard let repo = opts.positional.first else { fail("usage: cockpit why <repo>", code: 64) }
    let src = await obtain(opts)
    src.transport?.close()
    guard let g = src.glance else { printVerdict(src.verdict, route: src.route, glance: nil); exit(3) }
    let match: (String?) -> Bool = { r in guard let r else { return false }; return r == repo || r.hasSuffix("/" + repo) }
    let runners = g.runners.filter { match($0.repo) }
    let queue = g.queue.filter { match($0.repo) }
    let failures = (g.failures ?? []).filter { match($0.repo) }
    let short = repo.split(separator: "/").last.map(String.init) ?? repo
    let incidents = g.incidents.filter { $0.key.contains(short) || $0.title.contains(short) }
    if opts.json {
        struct Why: Encodable { let verdict: Verdict; let runners: [Runner]; let queue: [QueueItem]; let failures: [FailureRow]; let incidents: [Incident]; let checks: [String] }
        printJSON(Why(verdict: g.verdict, runners: runners, queue: queue, failures: failures, incidents: incidents,
                      checks: Rollup.checkSets(g).filter { match($0.repo) }.map { "\($0.label): \($0.progress)" }))
    } else {
        print("Fleet: \(mark(g.verdict.tone)) \(g.verdict.title)")
        print("\n\(short): \(runners.count) runner(s)")
        if runners.isEmpty { print("  none registered — jobs for this repo can only queue (unserved)") }
        for r in runners { print("  \(r.state.rawValue.padding(toLength: 13, withPad: " ", startingAt: 0)) \(r.name)  \(r.detail ?? "")") }
        if !queue.isEmpty {
            print("\nQueued:")
            for q in queue {
                let eta = q.etaStartMs.map { "starts in \(Presenter.range($0))" } ?? (q.cause.map { ["runner-down","unserved","role-unserved","label-mismatch","github-hosted"].contains($0) } == true ? "will not start on its own" : "no estimate")
                print("  \(q.workflow ?? "?") — \(Format.short(ms: q.queuedMs ?? 0)), \(Presenter.causeLabel(q.cause)) (\(q.confidence ?? "?")); \(eta)")
                for e in q.evidence ?? [] { print("    · \(e)") }
                if let r = q.recommended { print("    → \(r)") }
            }
        }
        let sets = Rollup.checkSets(g).filter { match($0.repo) }
        if !sets.isEmpty {
            print("\nChecks:")
            for s in sets.prefix(5) { print("  \(s.label): \(s.progress)\(s.etaGreenMs.map { ", done in \(Presenter.range($0))" } ?? "")") }
        }
        if !failures.isEmpty {
            print("\nFailed in the last 2 hours:")
            for f in failures { print("  \(f.workflow ?? "?"): \(f.label)\(f.notYourCode == true ? "  [not your code]" : "")") }
        }
        if !incidents.isEmpty {
            print("\nOpen alerts:")
            for i in incidents { print("  [\(i.severity ?? "?")] \(i.title)") }
        }
    }
    exit(exitCode(g.verdict))
case "queue":
    let src = await obtain(opts)
    src.transport?.close()
    guard let g = src.glance else { printVerdict(src.verdict, route: src.route, glance: nil); exit(3) }
    if opts.json { printJSON(g.queue) } else if g.queue.isEmpty { print("nothing queued") } else {
        for r in Presenter.queue(g) { print("\(r.age.padding(toLength: 6, withPad: " ", startingAt: 0)) \(r.title) — \(r.cause)\(r.eta.map { "; \($0)" } ?? "")") }
    }
case "wait":
    guard let repo = opts.positional.first else { fail("usage: cockpit wait <repo> [--pr N | --sha S | --branch B] [--timeout 45m]", code: 64) }
    let target = WaitTarget(repo: repo, pr: opts.flags["pr"].flatMap(Int.init), sha: opts.flags["sha"], branch: opts.flags["branch"])
    let timeout: Double = {
        let raw = opts.flags["timeout"] ?? "45m"
        let n = Double(raw.dropLast()) ?? Double(raw) ?? 45
        return raw.hasSuffix("h") ? n * 3600 : raw.hasSuffix("s") ? n : n * 60
    }()
    let transport: Transport = opts.url.map { DirectTransport(url: $0) }
        ?? TunnelTransport(aliases: opts.via.isEmpty ? ["runner-host", "runner-ts"] : opts.via)
    let deadline = Date().addingTimeInterval(timeout)
    var last: WaitDecision = .waiting(nil)
    func report(_ d: WaitDecision) -> Never {
        transport.close()
        switch d {
        case .green(let s): print("✔ \(target.label): \(s.progress)")
        case .red(let s):
            print("✖ \(target.label): \(s.progress)")
            for f in s.failed { print("  \(f.workflow ?? "?")\(f.url.map { " — \($0)" } ?? "")") }
        case .pointless(let why): print("⏹ \(target.label): not waiting — \(why)")
        case .waiting(let s): print("… \(target.label): timed out\(s.map { " at \($0.progress)" } ?? " (no runs seen)")")
        }
        exit(d.exitCode)
    }
    guard let route = try? await transport.open() else { print("? dashboard unreachable — try `cockpit sentinel`"); exit(3) }
    let client = FleetClient(base: route.baseURL)
    var announced = ""
    while Date() < deadline {
        do {
            for try await ev in client.stream() {
                guard case .glance(let g) = ev else { continue }
                let d = Waiter.decide(g, verdict: g.verdict, target: target)
                last = d
                switch d {
                case .waiting(let s):
                    let line = s.map { "\($0.progress)\($0.etaGreenMs.map { ", done in \(Presenter.range($0))" } ?? "")" } ?? "no runs yet"
                    if line != announced && !opts.json { FileHandle.standardError.write(Data("… \(target.label): \(line)\n".utf8)); announced = line }
                default: report(d)
                }
                if Date() >= deadline { report(last) }
            }
        } catch {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }
    report(last)
case "brief":
    let src = await obtain(opts)
    print(IncidentBrief.markdown(verdict: src.verdict, glance: src.glance, route: src.route, connection: "cli"))
    src.transport?.close()
    exit(exitCode(src.verdict))
default:
    fail("unknown command \(opts.command)\n\n\(usage)", code: 64)
}
