import AppKit
import Foundation
import Testing
import WebKit
import AutopodClient
import AutopodDesktop
@testable import AutopodUI

/// Explicitly opted-in, read-only acceptance check. Never runs against a daemon in normal CI.
@MainActor
@Suite(.enabled(if: ProcessInfo.processInfo.environment["AUTOPOD_LIVE_VILLAGE_TEST"] == "1"))
struct LiveVillageConnectionTests {
    @Test func configuredDaemonReachesStoresEventsAndBundledVillage() async throws {
        let environment = ProcessInfo.processInfo.environment
        let base = try #require(environment["AUTOPOD_LIVE_DAEMON_URL"].flatMap(URL.init(string:)))
        let credentialsURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".autopod/credentials.json")
        let credentials = try JSONSerialization.jsonObject(with: Data(contentsOf: credentialsURL)) as? [String: Any]
        let token = try #require(credentials?["accessToken"] as? String)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let api = DaemonAPI(baseURL: base, token: token, session: session)
        #expect(try await api.healthCheck())
        _ = try await api.getSessionStats()

        let native = PodStore()
        let managed = ManagedPodStore()
        native.configure(api: api)
        managed.configure(api: api)
        await native.loadSessions()
        await managed.refresh()
        try #require(native.error == nil, "Native fleet REST decoding failed")
        try #require(managed.error == nil, "Managed fleet REST decoding failed")
        try #require(!native.pods.isEmpty || !managed.pods.isEmpty, "Need real fleet data for this acceptance check")

        // A server acknowledgement proves authentication and subscription, beyond a
        // client's optimistic 'Connected' flag. This socket only subscribes/reads.
        var components = try #require(URLComponents(url: base.appendingPathComponent("events"), resolvingAgainstBaseURL: false))
        components.scheme = base.scheme == "https" ? "wss" : "ws"
        var request = URLRequest(url: try #require(components.url))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request)
        socket.resume()
        let timeout = Task { try? await Task.sleep(for: .seconds(15)); socket.cancel(with: .goingAway, reason: nil) }
        defer { timeout.cancel(); socket.cancel(with: .normalClosure, reason: nil) }
        try await socket.send(.string("{\"type\":\"subscribe_all\"}"))
        var acknowledged = false
        for _ in 0..<20 {
            let message = try await socket.receive()
            if case .string(let text) = message,
               let data = text.data(using: .utf8),
               let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               value["type"] as? String == "subscribed_all" {
                acknowledged = true
                break
            }
        }
        try #require(acknowledged, "The live daemon must acknowledge the fleet subscription")
        timeout.cancel()

        let stream = EventStream(podStore: native)
        stream.connect(baseURL: base, token: token, api: api)
        defer { stream.disconnect() }
        var historicalCount = 0
        for pod in native.pods.sorted(by: { $0.updatedAt > $1.updatedAt }).prefix(5) {
            stream.loadHistoricalEvents(podId: pod.id, api: api, scope: .latest(30))
            for _ in 0..<150 {
                if stream.historicalLoadState[pod.id] != .loading { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            try #require(stream.historicalLoadState[pod.id] == .loaded, "Real historical events must decode through EventStream")
            historicalCount += stream.sessionEvents[pod.id]?.count ?? 0
            if historicalCount > 0 { break }
        }
        let allActors = native.pods.map { VillageScene.native($0, events: stream.sessionEvents[$0.id] ?? [], now: .now) }
            + managed.pods.map(VillageScene.managed)
        let visible = allActors.filter { !$0.isFinished }.sorted { $0.id < $1.id }
        // Match the default Village filter; if the fleet is entirely finished, include history.
        let actors = visible.isEmpty ? allActors : visible
        let snapshot = VillageSnapshot(connected: true, activityStreamConnected: true,
            managedDataFresh: true, reducedMotion: true, selectedActorId: nil, actors: actors)

        _ = NSApplication.shared
        var selected: VillageActor?
        var failure: String?
        let coordinator = VillageWebView.Coordinator(onSelect: { selected = $0 }, onFailure: { failure = $0 })
        let webView = VillageWebView.makeWebView(snapshot: snapshot, coordinator: coordinator)
        webView.frame = NSRect(x: 0, y: 0, width: 1200, height: 850)
        defer { VillageWebView.dismantleNSView(webView, coordinator: coordinator) }
        var renderedCount = -1
        for _ in 0..<150 {
            renderedCount = (try? await webView.evaluateJavaScript("document.querySelectorAll('button.actor').length")) as? Int ?? -1
            if renderedCount == actors.count || failure != nil { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        try #require(failure == nil && renderedCount == actors.count, "Real fleet must reach the bundled renderer")
        let painted = try await webView.evaluateJavaScript("document.querySelector('canvas').dataset.renderedActors") as? String
        #expect(painted == String(actors.count))
        for source in [VillageActor.Source.native, .managed] {
            guard let actor = actors.first(where: { $0.source == source }) else { continue }
            selected = nil
            _ = try await webView.callAsyncJavaScript("const button=[...document.querySelectorAll('button.actor')].find(b=>b.dataset.actorId===id);button.click();return true", arguments: ["id": actor.id], in: nil, contentWorld: .page)
            for _ in 0..<30 {
                if selected != nil { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            try #require(selected?.id == actor.id, "Selection must return the exact real fleet identity")
            if source == .native { _ = try await api.getPod(actor.podId) }
            else { _ = try await api.getManagedPod(actor.podId) }
        }
        if let path = environment["AUTOPOD_LIVE_VILLAGE_SCREENSHOT"] {
            let image = try await webView.takeSnapshot(configuration: nil)
            let tiff = try #require(image.tiffRepresentation)
            let png = try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: path))
        }
        // Keep a real observation window: no synthetic events or test pods are sent.
        let before = stream.recentEvents.count
        try await Task.sleep(for: .seconds(5))
        #expect(stream.connectionState == "Connected")
        let liveEvents = stream.recentEvents.count - before
        let stages = Dictionary(grouping: allActors, by: { $0.stage.rawValue }).mapValues(\.count)
        print("LIVE_VILLAGE native=\(native.pods.count) managed=\(managed.pods.count) rendered=\(actors.count) historicalEvents=\(historicalCount) observedLiveEvents=\(liveEvents) websocketAcknowledged=\(acknowledged) stages=\(stages)")
    }
}
