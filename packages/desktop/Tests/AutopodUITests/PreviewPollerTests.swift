import Testing
@testable import AutopodUI
import AutopodClient

// MARK: - PreviewPoller unit tests (brief 02)
//
// Synchronization rationale: all tests use `waitUntil` (yield-bounded polling on
// observable state) rather than wall-clock `Task.sleep`. `Task.yield()` always
// makes progress regardless of load on the runner, so 10 000 yields is a hard
// upper bound that fails the test deterministically if the poll task is
// genuinely stuck — never a flaky timeout because CI was busy for 200 ms.

private struct WaitTimeoutError: Error, CustomStringConvertible {
    let yields: Int
    var description: String { "waitUntil timed out after \(yields) yields" }
}

/// Yield to the runloop until `condition` is true. Bounded by `maxYields` so
/// a stuck condition fails the test rather than hanging.
@MainActor
private func waitUntil(
    _ condition: @MainActor () -> Bool,
    maxYields: Int = 10_000
) async throws {
    for _ in 0..<maxYields {
        if condition() { return }
        await Task.yield()
    }
    throw WaitTimeoutError(yields: maxYields)
}

/// Tiny @MainActor-isolated counter so closures and tests can share a count
/// without captured-var concurrency warnings. Avoids actor-hop overhead in
/// closures already pinned to the main actor.
@MainActor
private final class CallCounter {
    private(set) var count: Int = 0
    func tick() { count += 1 }
}

/// Verifies that `PreviewPoller.start()` fetches immediately and `stop()` tears
/// down the poll task so no further fetches occur.
@MainActor
@Test func pollerFetchesOnStart() async throws {
    let counter = CallCounter()
    let expected = PreviewStatus(
        running: true, reachable: true, restartCount: 0, lastError: nil,
        previewUrl: "http://127.0.0.1:17668"
    )
    let poller = PreviewPoller()

    poller.start(podId: "test-pod") { _ in
        counter.tick()
        return expected
    }

    try await waitUntil { poller.status != nil }

    #expect(counter.count >= 1)
    #expect(poller.status?.running == true)
    #expect(poller.status?.reachable == true)
    #expect(poller.status?.previewUrl == "http://127.0.0.1:17668")
    #expect(poller.isPolling == true)

    poller.stop()
    #expect(poller.isPolling == false)
}

/// Verifies `stop()` cancels the poll task — `isPolling` flips synchronously
/// and the cancelled task is no longer driving fetches.
@MainActor
@Test func pollerStopsOnStop() async throws {
    let counter = CallCounter()
    let poller = PreviewPoller()

    poller.start(podId: "test-pod") { _ in
        counter.tick()
        return PreviewStatus(running: true, reachable: true, restartCount: 0, lastError: nil, previewUrl: nil)
    }

    try await waitUntil { poller.status != nil }
    let countAfterFirstFetch = counter.count

    poller.stop()
    #expect(poller.isPolling == false)

    // After stop(), the poll task is cancelled. Yield to let it observe the
    // cancellation and exit; verify no new fetches snuck in.
    for _ in 0..<100 { await Task.yield() }
    #expect(counter.count == countAfterFirstFetch)
}

/// `stopIfTerminal` with a terminal status stops polling within one tick.
@MainActor
@Test func pollerStopsOnTerminalStatus() async throws {
    let poller = PreviewPoller()

    poller.start(podId: "test-pod") { _ in
        PreviewStatus(running: true, reachable: true, restartCount: 0, lastError: nil, previewUrl: nil)
    }

    try await waitUntil { poller.status != nil }
    #expect(poller.isPolling == true)

    poller.stopIfTerminal(status: .complete)
    #expect(poller.isPolling == false)
}

/// `stopIfTerminal` with a non-terminal status does NOT stop polling.
@MainActor
@Test func pollerContinuesOnNonTerminalStatus() async throws {
    let poller = PreviewPoller()

    poller.start(podId: "test-pod") { _ in
        PreviewStatus(running: true, reachable: true, restartCount: 0, lastError: nil, previewUrl: nil)
    }

    try await waitUntil { poller.status != nil }
    #expect(poller.isPolling == true)

    poller.stopIfTerminal(status: .running)
    #expect(poller.isPolling == true)

    poller.stop()
}

/// On fetch error, `lastFetchError` is populated; stale status (if any) is preserved
/// rather than silently cleared. This prevents the UI from showing confident
/// "Running"/"Stopped" state when the daemon is unreachable.
@MainActor
@Test func pollerCapturesFetchError() async throws {
    struct LoadError: LocalizedError {
        var errorDescription: String? { "network down" }
    }
    let poller = PreviewPoller()

    poller.start(podId: "test-pod") { _ in
        throw LoadError()
    }

    try await waitUntil { poller.lastFetchError != nil }

    #expect(poller.lastFetchError == "network down")
    #expect(poller.status == nil)
    #expect(poller.isPolling == true)

    poller.stop()
}

/// A successful fetch after a prior error clears `lastFetchError`.
@MainActor
@Test func pollerClearsErrorOnSuccess() async throws {
    struct LoadError: Error {}
    let poller = PreviewPoller()
    let success = PreviewStatus(
        running: true, reachable: true, restartCount: 0, lastError: nil,
        previewUrl: "http://127.0.0.1:1234"
    )

    poller.start(podId: "test-pod") { _ in throw LoadError() }
    try await waitUntil { poller.lastFetchError != nil }

    // Restart with a successful loader; start() triggers an immediate fetch
    // which clears lastFetchError on success.
    poller.start(podId: "test-pod") { _ in success }
    try await waitUntil { poller.status?.running == true && poller.lastFetchError == nil }

    poller.stop()
}

/// `start()` called twice restarts cleanly — no duplicate poll tasks.
@MainActor
@Test func pollerRestartIsClean() async throws {
    let counter = CallCounter()
    let poller = PreviewPoller()

    poller.start(podId: "pod-1") { _ in
        counter.tick()
        return PreviewStatus(running: false, reachable: false, restartCount: 0, lastError: nil, previewUrl: nil)
    }
    try await waitUntil { poller.status != nil }
    let afterFirst = counter.count

    poller.start(podId: "pod-2") { _ in
        counter.tick()
        return PreviewStatus(running: true, reachable: true, restartCount: 0, lastError: nil, previewUrl: nil)
    }
    // Restart's new fetch overwrites status with running: true.
    try await waitUntil { poller.status?.running == true }

    #expect(counter.count > afterFirst)
    #expect(poller.isPolling == true)

    poller.stop()
}
