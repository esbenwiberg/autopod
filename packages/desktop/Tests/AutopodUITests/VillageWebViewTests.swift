import AppKit
import Foundation
import Testing
import WebKit
@testable import AutopodUI

@MainActor
@Suite(.serialized)
struct VillageWebViewTests {
    private func fixture() throws -> VillageSnapshot {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("VillageHost/scene.json")
        return try JSONDecoder().decode(VillageSnapshot.self, from: Data(contentsOf: file))
    }

    @Test func bundledRendererLoadsUpdatesAndSelectsThroughRealWebKit() async throws {
        _ = NSApplication.shared
        var selection: VillageActor?
        var failure: String?
        let coordinator = VillageWebView.Coordinator(onSelect: { selection = $0 }, onFailure: { failure = $0 })
        let snapshot = try fixture()
        let webView = VillageWebView.makeWebView(snapshot: snapshot, coordinator: coordinator)
        webView.frame = NSRect(x: 0, y: 0, width: 800, height: 600)
        defer { VillageWebView.dismantleNSView(webView, coordinator: coordinator) }
        var count = 0
        for _ in 0..<100 {
            count = (try? await webView.evaluateJavaScript("document.querySelectorAll('button.actor').length")) as? Int ?? 0
            if count == 3 || failure != nil { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(failure == nil)
        try #require(count == 3, "Bundled scripts, CSP, handshake and initial snapshot must work in WebKit")
        _ = try await webView.evaluateJavaScript("document.querySelector('[data-actor-id=\"managed:pod-a\"]').click()")
        for _ in 0..<20 {
            if selection != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(selection?.source == .managed)
        #expect(selection?.podId == "pod-a")
        coordinator.update(VillageSnapshot(connected: false, activityStreamConnected: false,
            managedDataFresh: false, reducedMotion: true, selectedActorId: nil, actors: []))
        for _ in 0..<30 {
            count = (try? await webView.evaluateJavaScript("document.querySelectorAll('button.actor').length")) as? Int ?? -1
            if count == 0 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(count == 0)
        #expect(failure == nil)
    }

    @Test func preReadyUpdatesCoalesceAndTitlesRemainText() async throws {
        _ = NSApplication.shared
        var selection: VillageActor?
        var failure: String?
        let coordinator = VillageWebView.Coordinator(onSelect: { selection = $0 }, onFailure: { failure = $0 })
        let initial = try fixture()
        let webView = VillageWebView.makeWebView(snapshot: initial, coordinator: coordinator)
        defer { VillageWebView.dismantleNSView(webView, coordinator: coordinator) }
        let title = "<script>window.villageInjected = true</script> ` ${danger}"
        let actor = VillageActor(id: "managed:only", podId: "only", source: .managed,
            detailLevel: .lifecycle, title: title, profile: "test", model: "codex",
            status: "running", stage: .working, statusUpdatedAt: 0, interactive: false, activity: nil)
        coordinator.update(VillageSnapshot(connected: false, activityStreamConnected: false,
            managedDataFresh: false, reducedMotion: true, selectedActorId: nil, actors: [actor]))
        var renderedTitle: String?
        for _ in 0..<100 {
            renderedTitle = (try? await webView.evaluateJavaScript("document.querySelector('.actor-title')?.textContent")) as? String
            if renderedTitle == title || failure != nil { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(failure == nil)
        #expect(renderedTitle == title)
        let count = try await webView.evaluateJavaScript("document.querySelectorAll('button.actor').length") as? Int
        #expect(count == 1)
        let injected = try await webView.evaluateJavaScript("window.villageInjected === true") as? Bool
        #expect(injected == false)
        let moving = try await webView.evaluateJavaScript("document.querySelectorAll('.moving').length") as? Int
        #expect(moving == 0)
        _ = try await webView.evaluateJavaScript("window.webkit.messageHandlers.village.postMessage({type:'select',actorId:'native:pod-a'}); true")
        try await Task.sleep(for: .milliseconds(100))
        #expect(selection == nil)
    }
}
