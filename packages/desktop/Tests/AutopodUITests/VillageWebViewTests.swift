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
        let rendered = try await webView.evaluateJavaScript("document.querySelector('canvas').dataset.renderedActors") as? String
        #expect(rendered == "3")
        let camera = try await webView.evaluateJavaScript("document.querySelector('canvas').dataset.camera") as? String
        let cameraScale = try await webView.evaluateJavaScript("Number(document.querySelector('canvas').dataset.cameraScale)") as? Double
        #expect(camera == "follow")
        #expect(cameraScale == 2, "Reduced-motion follow uses upstream's two-times camera")
        if let screenshot = ProcessInfo.processInfo.environment["AUTOPOD_VILLAGE_SCREENSHOT"] {
            let image = try await webView.takeSnapshot(configuration: nil)
            let tiff = try #require(image.tiffRepresentation)
            let png = try #require(NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: screenshot))
        }
        // The attention actor is at the upstream noticeboard; clicking its canvas hit target
        // must use the same namespaced selection path as the accessible list.
        _ = try await webView.evaluateJavaScript("document.querySelector('.camera-village').click(); true")
        _ = try await webView.evaluateJavaScript("{ const c=document.querySelector('canvas'), r=c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', {clientX:r.left+r.width*.065, clientY:r.top+r.height*(.305*768-20)/928})); }; true")
        for _ in 0..<20 {
            if selection != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(selection?.id == "native:pod-b")
        _ = try await webView.evaluateJavaScript("document.querySelector('.camera-follow').click(); true")
        let followed = try await webView.evaluateJavaScript("document.querySelector('canvas').dataset.focus") as? String
        #expect(followed == "native:pod-b")
        // The noticeboard is clamped to the camera's top-left, so its rendered
        // position doubles. Hit testing must apply the same upstream transform.
        selection = nil
        _ = try await webView.evaluateJavaScript("{ const c=document.querySelector('canvas'), r=c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', {clientX:r.left+r.width*.065*2, clientY:r.top+r.height*(.305*768-20)*2/928})); }; true")
        for _ in 0..<20 {
            if selection != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(selection?.id == "native:pod-b")
        selection = nil
        _ = try await webView.evaluateJavaScript("document.querySelector('[data-actor-id=\"managed:pod-a\"]').click()")
        for _ in 0..<20 {
            if selection != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(selection?.source == .managed)
        #expect(selection?.podId == "pod-a")
        // Offscreen WebKit throttles RAF. Drive the requested frames deterministically
        // while exercising the real bundled drawing code and its cancellation behavior.
        _ = try await webView.evaluateJavaScript("{ window.villagePaints=0; window.requestAnimationFrame=cb=>{window.villageFrame=cb;return 1;}; window.cancelAnimationFrame=()=>{window.villageFrame=null;}; const c=document.querySelector('canvas').getContext('2d'), draw=c.drawImage; c.drawImage=function(...args){window.villagePaints++; return draw.apply(this,args);}; }; true")
        coordinator.update(VillageSnapshot(connected: true, activityStreamConnected: true,
            managedDataFresh: true, reducedMotion: false, selectedActorId: nil, actors: snapshot.actors))
        for _ in 0..<30 {
            if (try await webView.evaluateJavaScript("typeof window.villageFrame === 'function'") as? Bool) == true { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        _ = try await webView.evaluateJavaScript("window.villageFrame?.(performance.now()+1000); true")
        let paints = try await webView.evaluateJavaScript("window.villagePaints") as? Int
        #expect((paints ?? 0) > 4, "Live characters should animate between native snapshots")
        coordinator.update(VillageSnapshot(connected: false, activityStreamConnected: false,
            managedDataFresh: false, reducedMotion: true, selectedActorId: nil, actors: []))
        for _ in 0..<30 {
            count = (try? await webView.evaluateJavaScript("document.querySelectorAll('button.actor').length")) as? Int ?? -1
            if count == 0 { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(count == 0)
        #expect(failure == nil)
        let stoppedPaints = try await webView.evaluateJavaScript("window.villagePaints") as? Int
        let pendingFrame = try await webView.evaluateJavaScript("typeof window.villageFrame === 'function'") as? Bool
        #expect(pendingFrame == false)
        try await Task.sleep(for: .milliseconds(150))
        let laterPaints = try await webView.evaluateJavaScript("window.villagePaints") as? Int
        #expect(laterPaints == stoppedPaints, "Empty, disconnected/reduced-motion views must stop repainting")
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
