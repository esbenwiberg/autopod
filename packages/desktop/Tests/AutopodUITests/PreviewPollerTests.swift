import Testing
@testable import AutopodUI
import AutopodClient

// MARK: - PreviewPoller unit tests (brief 02)

/// Verifies that `PreviewPoller.start()` fetches immediately and `stop()` tears
/// down the poll task so no further fetches occur.
@MainActor
@Test func pollerFetchesOnStart() async throws {
    var fetchCount = 0
    let expected = PreviewStatus(
        running: true, reachable: true, restartCount: 0, lastError: nil,
        previewUrl: "http://127.0.0.1:17668"
    )
    let poller = PreviewPoller()

    poller.start(podId: "test-pod") { _ in
        fetchCount += 1
        return expected
    }

    // Give the initial in-task fetch time to run.
    try await Task.sleep(for: .milliseconds(200))

    #expect(fetchCount >= 1)
    #expect(poller.status?.running == true)
    #expect(poller.status?.reachable == true)
    #expect(poller.status?.previewUrl == "http://127.0.0.1:17668")
    #expect(poller.isPolling == true)

    poller.stop()
    #expect(poller.isPolling == false)
}

/// Verifies `stop()` cancels the poll task — no more fetches after stop.
@MainActor
@Test func pollerStopsOnStop() async throws {
    var fetchCount = 0
    let poller = PreviewPoller()

    poller.start(podId: "test-pod") { _ in
        fetchCount += 1
        return PreviewStatus(running: true, reachable: true, restartCount: 0, lastError: nil, previewUrl: nil)
    }

    try await Task.sleep(for: .milliseconds(100))
    poller.stop()
    let countAfterStop = fetchCount

    // Wait longer than the 5s sleep — if not cancelled, fetchCount would increment.
    // We only wait 200ms here to keep tests fast; the real guarantee is that
    // stop() cancels the Task so the sleep exits immediately.
    try await Task.sleep(for: .milliseconds(200))

    #expect(poller.isPolling == false)
    // No additional fetches should have happened after stop.
    #expect(fetchCount == countAfterStop)
}

/// `stopIfTerminal` with a terminal status stops polling within one tick.
@MainActor
@Test func pollerStopsOnTerminalStatus() async throws {
    let poller = PreviewPoller()

    poller.start(podId: "test-pod") { _ in
        PreviewStatus(running: true, reachable: true, restartCount: 0, lastError: nil, previewUrl: nil)
    }

    try await Task.sleep(for: .milliseconds(100))
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

    try await Task.sleep(for: .milliseconds(100))
    #expect(poller.isPolling == true)

    poller.stopIfTerminal(status: .running)
    #expect(poller.isPolling == true)

    poller.stop()
}

/// `start()` called twice restarts cleanly — no duplicate poll tasks.
@MainActor
@Test func pollerRestartIsClean() async throws {
    var fetchCount = 0
    let poller = PreviewPoller()

    poller.start(podId: "pod-1") { _ in
        fetchCount += 1
        return PreviewStatus(running: false, reachable: false, restartCount: 0, lastError: nil, previewUrl: nil)
    }
    try await Task.sleep(for: .milliseconds(50))
    let afterFirst = fetchCount

    poller.start(podId: "pod-2") { _ in
        fetchCount += 1
        return PreviewStatus(running: true, reachable: true, restartCount: 0, lastError: nil, previewUrl: nil)
    }
    try await Task.sleep(for: .milliseconds(100))

    #expect(fetchCount > afterFirst)
    #expect(poller.status?.running == true)
    #expect(poller.isPolling == true)

    poller.stop()
}
