import AppKit
import Observation
import SwiftUI
import Testing
@testable import AutopodDesktop
import AutopodUI

@MainActor @Observable private final class HistorySelectionInputs {
    var selected: String? = "A"
    var revision = 0
}

@MainActor private struct HistorySelectionView: View {
    let inputs: HistorySelectionInputs
    let fixture: PodStoreLifetimeFixture
    let stream: EventStream
    var body: some View {
        Text("\(inputs.selected ?? "none") / \(inputs.revision)")
            .modifier(SelectedPodHistoryLoader(selectedPodID: inputs.selected,
                api: fixture.apiA, podStore: fixture.store, eventStream: stream))
    }
}

@MainActor private final class HistorySelectionHost {
    let inputs = HistorySelectionInputs()
    let stream: EventStream
    private let hosting: NSHostingView<HistorySelectionView>
    private let window: NSWindow
    init(_ fixture: PodStoreLifetimeFixture) {
        NSApplication.shared.finishLaunching()
        stream = EventStream(podStore: fixture.store)
        hosting = NSHostingView(rootView: HistorySelectionView(inputs: inputs, fixture: fixture, stream: stream))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = hosting; window.orderFront(nil)
    }
    func close() { window.contentView = nil; window.close() }
    func settle(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        repeat {
            window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded()
            if condition() { return }
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(1))
        } while true
    }
}

@Suite(.serialized) @MainActor struct SelectedPodHistoryLoaderTests {
    @Test func initialSelectionNavigationAndExplicitReloadHaveOneOwner() async throws {
        try await withPodStoreLifetimeFixture { f in
            for id in ["A", "B"] {
                let task = f.start { await f.store.hydrateSessionIfNeeded(id) }
                try await f.next(f.a, "/pods/\(id)").respond(body: lifetimePod(id: id))
                _ = await task.value
            }
            let host = HistorySelectionHost(f)
            defer { host.close() }
            for id in ["A", "B", "A"] {
                host.inputs.selected = id
                try await f.next(f.a, "/pods/\(id)/events").respond(body: "[]")
                try await host.settle { host.stream.historicalLoadState[id] == .loaded }
            }
            let before = f.a.requests.count
            host.inputs.revision += 1
            // Drain real view-update turns with unchanged task identity.
            for _ in 0..<10 { try await host.settle { true }; await Task.yield() }
            #expect(f.a.requests.count == before)
            #expect(f.a.requests.filter { $0.url?.path.hasSuffix("/events") == true }.count == 3)
            host.stream.reloadHistoricalEvents(podId: "A", api: f.apiA)
            try await f.next(f.a, "/pods/A/events").respond(body: "[]")
            try await host.settle { host.stream.historicalLoadState["A"] == .loaded }
            host.stream.loadHistoricalEvents(podId: "A", api: f.apiA, scope: .full)
            let full = try await f.next(f.a, "/pods/A/events")
            #expect(full.request.url?.query?.contains("limit=") != true)
            full.respond(body: "[]")
            try await host.settle { host.stream.historicalLoadState["A"] == .loaded }
            #expect(f.a.requests.filter { $0.url?.path.hasSuffix("/events") == true }.count == 5)
        }
    }

    @Test func cancelledHydrationCannotDispatchSupersededSelectionHistory() async throws {
        try await withPodStoreLifetimeFixture { f in
            let host = HistorySelectionHost(f)
            defer { host.close() }
            let old = try await f.next(f.a, "/pods/A")
            host.inputs.selected = "B"
            try await f.next(f.a, "/pods/B").respond(body: lifetimePod(id: "B"))
            try await f.next(f.a, "/pods/B/events").respond(body: "[]")
            old.respond(body: lifetimePod(id: "A"))
            try await host.settle { host.stream.historicalLoadState["B"] == .loaded && f.a.activeCount == 0 }
            #expect(host.stream.historicalLoadState["A"] == nil)
            #expect(!f.a.requests.contains { $0.url?.path == "/pods/A/events" })
        }
    }
}
