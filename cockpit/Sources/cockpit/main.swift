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
                      causes and ETAs, checks, orphaned jobs, recent failures and open alerts
  queue               every queued run, oldest first, with cause and ETA
  wait <repo>         block until a commit's checks finish (--pr N | --sha S | --branch B,
                      --timeout 45m). Exit 0 green, 1 red, 2 waiting is pointless (host
                      down, disk floor, billing block, a check that will never start, a
                      job orphaned by a draining runner), 3 timed out or nothing readable.
                      --recover (with --pr): recover this PR's orphaned runs (force-cancel,
                      then re-run) instead of stopping; recorded in the dashboard's action log
  top                 the host's top CPU users, naming Spotlight when it is the culprit
  load                host load1 p50/p90 by number of busy runners (--days N, default 7),
                      to re-tune the admission lanes' heavy limit
  sentinel            check the host out of band (SSH, GitHub, the other machine) —
                      what the app does when the dashboard does not answer
  brief               a markdown incident brief of the current state
  pair                pair this command line with the dashboard (its own revocable token)
  run <action>        run a catalogue action (e.g. fleet.health, fleet.healthRepair,
                      runner.restart --name <runner>, run.recoverOrphan --repo o/r --run N);
                      anything but a read needs --yes
  mcp                 the dashboard's MCP tools over stdio (fleet_status, diagnose_repo,
                      wait_for_checks, list_queue, …). Read-only unless FLEET_API_TOKEN
                      holds a scoped token (./fleetctl.sh api-token <name> --scopes read,act).
                      The tunnel opens when a call needs it and closes after --idle seconds
                      with none (default 90; 0 holds it for the whole session)
  fixtures            list the bundled fixture names

options:
  --json              machine-readable output
  --fixture <name>    use a bundled fixture instead of the live fleet
  --via <alias>       ssh alias to tunnel through (repeatable; default: \(TransportConfig.defaultAliases.joined(separator: ", ")))
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

/// The daemon's verdict, unless its view is too old to stand behind: an app
/// still connected to a stalled collector rewrites its snapshot with the last
/// glance, and that glance's verdict ("Working") was true 27 minutes earlier.
func trusted(_ v: Verdict, _ g: Glance?) -> Verdict {
    guard let g, g.isCollectorStale(), v.id != "unknown" else { return v }
    return CockpitVerdict.effective(glance: g, connection: .collectorStale, outOfBand: nil, lastGlanceMs: nil)
}

/// Where the answer comes from, in order of cheapness.
func obtain(_ o: Options) async -> Source {
    if let name = o.fixture {
        do {
            let g = try Fixtures.glance(name)
            return Source(glance: g, verdict: g.verdict, route: "fixture: \(name)")
        } catch { fail("no fixture named \(name) (try: cockpit fixtures)") }
    }
    // The app's view when it is fresh. If the app is not connected right now,
    // try our own route first and keep its view (which may carry an
    // out-of-band "host down") as the answer only when ours fails too.
    let snap = (!o.fresh && o.url == nil && o.via.isEmpty) ? (try? SnapshotFile.read()).flatMap { $0.ageMs() < 90_000 ? $0 : nil } : nil
    func fromApp(_ s: SnapshotFile) -> Source {
        Source(glance: s.glance, verdict: trusted(s.verdict, s.glance), route: "app (\(s.route ?? "?"), \(Format.ago(s.writtenAt, now: Format.nowMs())))")
    }
    if let snap, snap.isConnected { return fromApp(snap) }
    let transport: Transport = o.url.map { DirectTransport(url: $0) }
        ?? TunnelTransport(aliases: o.via.isEmpty ? defaultAliases : o.via)
    do {
        let route = try await transport.open()
        let client = FleetClient(base: route.baseURL)
        let g = try await client.glance()
        return Source(glance: g, verdict: trusted(g.verdict, g), route: route.label, client: client, transport: transport)
    } catch {
        transport.close()
        if let snap { return fromApp(snap) }
        let v = Verdict(id: "unreachable", tone: .unknown, title: "Dashboard unreachable",
                        sentence: "Could not reach the dashboard: \(error)", evidence: [], next: nil, rung: nil, open: [])
        return Source(glance: nil, verdict: v, route: "none")
    }
}

let defaultAliases = TransportConfig.defaultAliases

func transport(_ o: Options) -> Transport {
    o.url.map { DirectTransport(url: $0) } ?? TunnelTransport(aliases: o.via.isEmpty ? defaultAliases : o.via)
}

/// The dashboard over the usual route, for /api/v1. Reads need no token: the
/// tunnel arrives on the host's loopback.
func connect(_ o: Options) async -> (FleetClient, Transport) {
    let t = transport(o)
    do {
        return (FleetClient(base: try await t.open().baseURL), t)
    } catch {
        t.close()
        fail("? dashboard unreachable (\(error.localizedDescription)) — try `cockpit sentinel`", code: 3)
    }
}

/// The token `cockpit pair` saved for this dashboard.
func pairedToken(_ c: FleetClient, _ o: Options) async -> String? {
    let local = (try? await c.hosts())?.first { $0.local == true }?.id
    return [local, o.via.first ?? defaultAliases[0]].compactMap { $0 }.lazy.compactMap { CLITokenFile.load(account: "cli:" + $0) }.first
}

func fail(_ e: Error, code: Int32 = 3) -> Never {
    fail("✖ \(e)", code: code)
}

func printRaw(_ data: Data) {
    print(String(decoding: data, as: UTF8.self))
}

func printJSON<T: Encodable>(_ v: T) {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    print(String(decoding: try! enc.encode(v), as: UTF8.self))
}

func mark(_ t: Tone) -> String { t.mark }

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
    if let t = glance?.tiers { print("  \(t.line)") }
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
case "mcp":
    let idle = opts.flags["idle"].flatMap(TimeInterval.init) ?? MCPBridge.idle
    await MCPBridge.run(transport(opts), idle: idle > 0 ? idle : nil)
case "fixtures":
    for n in Fixtures.names { print(n) }
case "status":
    let src = await obtain(opts)
    defer { src.transport?.close() }
    if opts.json {
        struct Out: Encodable { let verdict: Verdict; let route: String; let counts: Counts?; let tiers: Tiers? }
        printJSON(Out(verdict: src.verdict, route: src.route, counts: src.glance?.counts, tiers: src.glance?.tiers))
    } else {
        printVerdict(src.verdict, route: src.route, glance: src.glance)
    }
    src.transport?.close()
    exit(exitCode(src.verdict))
case "sentinel":
    let aliases = opts.via.isEmpty ? defaultAliases : opts.via
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
    let alias = opts.via.first ?? defaultAliases[0]
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
    guard let action = opts.positional.first else {
        fail("usage: cockpit run <action> [--name <runner>] [--host <host id>] [--repo o/r --run N] [--yes]", code: 64)
    }
    let (anon, link) = await connect(opts)
    guard let token = await pairedToken(anon, opts) else { link.close(); fail("not paired: run `cockpit pair` first") }
    var client = anon
    client.token = token
    // Flags are the action's arguments, under the daemon's names; it refuses
    // any the action does not take and says which it does. Host actions
    // without --host act on the dashboard's own host.
    let renamed = ["host": "hostId", "run": "runId"]
    var args: [String: Any] = [:]
    for (k, v) in opts.flags where k != "yes" { args[renamed[k] ?? k] = v }
    do {
        let (preview, _) = try await client.action(action, args: args)
        // Anything that changes the fleet needs an explicit --yes: an agent
        // exploring the CLI must not repair or restart by accident.
        if (preview.danger ?? "none") != "none" && opts.flags["yes"] == nil {
            link.close()
            var lines = ["\(preview.label ?? action) (\(preview.danger ?? "?") danger): \(preview.effect ?? "changes the fleet")"]
            if let c = preview.command { lines.append("  would run: \(c)") }
            lines.append("Re-run with --yes to proceed.")
            fail(lines.joined(separator: "\n"), code: 2)
        }
        let (r, raw) = try await client.action(action, args: args, confirm: preview.confirm)
        link.close()
        if opts.json { printRaw(raw) } else {
            print(r.ok == true ? "✔ \(r.label ?? preview.label ?? action)" : "✖ \(r.label ?? preview.label ?? action)")
            if let o = r.output, !o.isEmpty { print(o) }
        }
        exit(r.ok == true ? 0 : 1)
    } catch {
        link.close()
        fail(error, code: 1)
    }
case "why":
    guard let repo = opts.positional.first else { fail("usage: cockpit why <repo>", code: 64) }
    if opts.fixture != nil { fail("why asks the live dashboard; fixtures cover status, queue and brief", code: 64) }
    let (client, link) = await connect(opts)
    let d: V1Diagnosis, raw: Data
    do { (d, raw) = try await client.diagnosis(try await client.fullName(repo)) } catch { link.close(); fail(error) }
    link.close()
    let code = d.freshness.stale ? 3 : exitCode(d.verdict)
    if opts.json { printRaw(raw); exit(code) }
    print(Why.text(d, repo: repo))
    exit(code)
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
    // Recovery acts on GitHub, so it is opt-in and scoped to the caller's own
    // PR: a sha or branch could be anyone's, and a fleet-wide cancel kills
    // other sessions' runs (2026-10-04).
    let recover = opts.flags["recover"] != nil
    if recover, target.pr == nil { fail("--recover needs --pr: it only acts on your own PR's runs", code: 64) }
    let timeout: Double = {
        let raw = opts.flags["timeout"] ?? "45m"
        let n = Double(raw.dropLast()) ?? Double(raw) ?? 45
        return raw.hasSuffix("h") ? n * 3600 : raw.hasSuffix("s") ? n : n * 60
    }()
    if opts.fixture != nil { fail("wait asks the live dashboard; fixtures cover status, queue and brief", code: 64) }
    let link = transport(opts)
    let routes = OnDemandRoute(link)
    // The last word on the deadline, outside Swift concurrency altogether: if
    // anything below still has not answered `timeout` + 30 s from now, say so
    // and exit (2026-10-09: waits ran 1.5 h past --timeout).
    DispatchQueue.global().asyncAfter(wallDeadline: .now() + timeout + 30) {
        print("… \(target.label): timed out (no answer from the dashboard or GitHub by the deadline)")
        link.close()
        exit(3)
    }
    let reachable = (try? await routes.base()) != nil
    // Only a PR can be asked of GitHub directly; anything else needs the dashboard.
    if !reachable, target.pr == nil { print("? dashboard unreachable — try `cockpit sentinel`"); exit(3) }
    var full = repo.contains("/") ? repo : nil
    if full == nil, reachable {
        do { full = try await FleetClient(base: try await routes.base()).fullName(repo) } catch let e as APIError { link.close(); fail(e) } catch {}
    }
    if full == nil { full = await GHChecksProbe.fullName(repo, glance: nil) }
    guard let full else { print("? cannot tell which repository \(repo) is: give it as owner/name"); exit(3) }
    let goal = WaitTarget(repo: full, pr: target.pr, sha: target.sha, branch: target.branch)
    var token: String?
    if recover {
        let base = try? await routes.base()
        guard let base, let t = await pairedToken(FleetClient(base: base), opts) else {
            link.close()
            fail("--recover runs an action on the dashboard: pair first with `cockpit pair`", code: 64)
        }
        token = t
    }
    var wait = CheckWait(deadline: Format.nowMs() + timeout * 1000) { w in
        try await FleetClient(base: try await routes.base()).checks(goal, wait: w)
    }
    if let pr = goal.pr {
        wait.github = { await GHChecksProbe(repo: full, pr: pr).fetch()?.checkSet(repo: full, pr: pr) }
    }
    if let token {
        wait.recover = { orphans in
            do {
                let c = FleetClient(base: try await routes.base(), token: token)
                for o in orphans {
                    let args: [String: Any] = ["repo": o.repo, "runId": o.runId]
                    let (preview, _) = try await c.action("run.recoverOrphan", args: args)
                    let (done, _) = try await c.action("run.recoverOrphan", args: args, confirm: preview.confirm)
                    if done.ok != true { return done.output ?? "run.recoverOrphan failed for run \(o.runId)" }
                }
                return nil
            } catch {
                return "\(error)"
            }
        }
    }
    wait.onDrop = { routes.invalidate() }
    if !opts.json { wait.progress = { FileHandle.standardError.write(Data("… \(target.label): \($0)\n".utf8)) } }
    let recoverCommand = goal.pr.map { "cockpit wait \(repo) --pr \($0) --recover" }
    let outcome = await wait.run()
    link.close()
    switch outcome {
    case .answer(let a, let raw):
        if opts.json { printRaw(raw) } else { print(CheckWait.text(a, label: target.label, recoverCommand: recover ? nil : recoverCommand)) }
        exit(a.exitCode)
    case .recoveryFailed(let a, let raw, let why):
        if opts.json { printRaw(raw) } else { print(CheckWait.text(a, label: target.label)) }
        fail("  recovery failed: \(why)", code: 2)
    case .github(let s):
        let mark = s.state == .green ? "✔" : "✖"
        print("\(mark) \(target.label): \(s.progress) (from GitHub)")
        for f in s.failed { print("  \(f.workflow ?? "?")\(f.cancelled ? " (cancelled)" : "")\(f.url.map { " — \($0)" } ?? "")") }
        exit(s.state == .green ? 0 : 1)
    case .timeout(let a, let raw, let reached):
        if opts.json, let raw { printRaw(raw) } else {
            print("… \(target.label): timed out\(a?.checks.map { " at \($0.progress)" } ?? " (no runs seen)")")
            if !reached { print("? dashboard unreachable — try `cockpit sentinel`") }
        }
        exit(3)
    case .refused(let e):
        fail(e)
    }
case "top":
    let alias = opts.via.first ?? defaultAliases[0]
    guard let top = await HostProbe.topCPU(alias: alias) else { fail("could not run ps on \(alias)", code: 3) }
    if opts.json {
        struct Top: Encodable { let verdict: String; let spotlightCPU: Double; let top: [String] }
        printJSON(Top(verdict: top.verdict, spotlightCPU: top.spotlightCPU, top: top.lines.map { String(format: "%.1f %@", $0.cpu, $0.command) }))
    } else {
        print(top.verdict)
        for l in top.lines.prefix(10) { print(String(format: "  %5.1f%%  %@", l.cpu, (l.command as NSString).lastPathComponent)) }
    }
    exit(top.spotlightCPU >= 50 ? 1 : 0)
case "load":
    if opts.fixture != nil { fail("load asks the live dashboard", code: 64) }
    let days = opts.flags["days"].flatMap(Int.init) ?? 7
    let (client, link) = await connect(opts)
    let raw: Data
    do { raw = try await client.get("/api/load-by-busy", query: ["days": String(days)]) } catch { link.close(); fail(error) }
    link.close()
    if opts.json { printRaw(raw); exit(0) }
    do { print(try LoadTable.decode(raw).text()) } catch { fail("the dashboard's answer did not parse: \(error)", code: 3) }
case "brief":
    let src = await obtain(opts)
    print(IncidentBrief.markdown(verdict: src.verdict, glance: src.glance, route: src.route, connection: "cli"))
    src.transport?.close()
    exit(exitCode(src.verdict))
default:
    fail("unknown command \(opts.command)\n\n\(usage)", code: 64)
}
