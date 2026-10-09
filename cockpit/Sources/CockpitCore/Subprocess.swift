import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Runs a short-lived program and always answers by its deadline.
///
/// 2026-10-09: three `cockpit wait --pr` sessions hung for 1 h 37 min, each
/// parked in `-[NSConcreteTask waitUntilExit]` with no child left (`sample`
/// on pids 58321, 58340, 68289). `gh` had outlived its 20 s budget, the
/// timeout called `terminate()` from another thread while a worker sat in
/// `waitUntilExit()`, and Foundation never marked the task finished: the
/// child was reaped, `isRunning` stayed true, the poll spun forever. A
/// stand-alone repro (`/bin/sleep 5`, terminate at 0.2 s) hangs within a few
/// tries. So nothing here calls `waitUntilExit`: the termination handler or
/// the deadline answers, whichever comes first, and the deadline never waits
/// on the child at all.
public enum Subprocess {
    public struct Result: Sendable, Equatable {
        public var status: Int32
        public var stdout: Data
    }

    /// Stdout and exit status, or nil when the program could not start or did
    /// not finish within `timeout` (it is then sent SIGTERM, and SIGKILL two
    /// seconds later if it is still there).
    public static func run(_ path: String, _ args: [String], timeout: TimeInterval) async -> Result? {
        await withCheckedContinuation { (c: CheckedContinuation<Result?, Never>) in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: path)
            p.arguments = args
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            p.standardInput = FileHandle.nullDevice
            let once = Once()
            let collected = Collected()

            // Drain stdout while the program runs: a reply larger than the pipe
            // buffer would otherwise block it on write and it would never exit.
            let reader = out.fileHandleForReading
            Thread.detachNewThread {
                let data = reader.readDataToEndOfFile()
                collected.finish(data)
            }
            p.terminationHandler = { proc in
                // A grandchild holding the pipe open must not hold the answer.
                let data = collected.wait(upTo: 2) ?? Data()
                if once.claim() { c.resume(returning: Result(status: proc.terminationStatus, stdout: data)) }
            }
            do { try p.run() } catch {
                try? out.fileHandleForWriting.close()
                if once.claim() { c.resume(returning: nil) }
                return
            }
            // Our copy of the write end: only the child should keep the pipe open.
            try? out.fileHandleForWriting.close()
            let pid = p.processIdentifier
            DispatchQueue.global().asyncAfter(wallDeadline: .now() + timeout) {
                guard once.claim() else { return }
                c.resume(returning: nil)
                kill(pid, SIGTERM)
                DispatchQueue.global().asyncAfter(wallDeadline: .now() + 2) {
                    if p.isRunning { kill(pid, SIGKILL) }
                }
            }
        }
    }

    private final class Collected: @unchecked Sendable {
        private let done = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var data: Data?
        func finish(_ d: Data) { lock.withLock { data = d }; done.signal() }
        func wait(upTo seconds: TimeInterval) -> Data? {
            guard done.wait(timeout: .now() + seconds) == .success else { return nil }
            done.signal() // let a second waiter through too
            return lock.withLock { data }
        }
    }
}

/// Races an async operation against a wall-clock deadline without waiting for
/// the loser: a task group would await a child stuck in a continuation that
/// never resumes, which is exactly the hang a deadline is for. The timer is a
/// Dispatch wall-clock timer, so it fires even when the cooperative pool is
/// busy and counts time the Mac spent asleep.
public enum Deadline {
    public static func race<T: Sendable>(seconds: TimeInterval,
                                         _ operation: @escaping @Sendable () async -> T,
                                         onTimeout: @escaping @Sendable () -> T) async -> T {
        let once = Once()
        let box = TaskBox()
        return await withCheckedContinuation { (c: CheckedContinuation<T, Never>) in
            let task = Task {
                let v = await operation()
                if once.claim() { c.resume(returning: v) }
            }
            box.set(task)
            DispatchQueue.global().asyncAfter(wallDeadline: .now() + max(0, seconds)) {
                if once.claim() {
                    c.resume(returning: onTimeout())
                    box.cancel()
                }
            }
        }
    }

    private final class TaskBox: @unchecked Sendable {
        private let lock = NSLock()
        private var task: Task<Void, Never>?
        func set(_ t: Task<Void, Never>) { lock.withLock { task = t } }
        func cancel() { lock.withLock { task }?.cancel() }
    }
}
