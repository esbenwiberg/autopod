import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) struct AnalyticsLoadingTests {
    @MainActor @Test(arguments: [false, true], [CGFloat(320), CGFloat(560)])
    func analyticsCardKeepsItsSizeWhileLoading(redesign: Bool, width: CGFloat) {
        func size(loading: Bool, populated: Bool) -> CGSize {
            let card = AnalyticsCard(title: "Models", value: populated ? "codex-model" : "—",
                sparkline: populated ? [1, 4, 2, 6] : nil,
                delta: populated ? AnalyticsCardDelta(value: "+$0.25/PR", direction: .up) : nil,
                subline: populated ? "best process: model\nmost used: codex-model (28 pods)" : nil,
                isLoading: loading, onClick: {})
                .environment(\.desktopRedesign, redesign).frame(width: width)
            let hosting = NSHostingView(rootView: card)
            hosting.layoutSubtreeIfNeeded()
            return hosting.fittingSize
        }
        let loading = size(loading: true, populated: false)
        #expect(loading == size(loading: false, populated: true))
        #expect(loading == size(loading: false, populated: false))
        #expect(loading.width == width)
    }

}

@MainActor private final class AnalyticsLoadGate<Value: Sendable> {
    var pending: [Int: CheckedContinuation<Value, any Error>] = [:]

    func load(_ days: Int) async throws -> Value {
        return try await withCheckedThrowingContinuation { pending[days] = $0 }
    }

    func finish(_ days: Int, _ result: Result<Value, any Error>) {
        pending.removeValue(forKey: days)?.resume(with: result)
    }
}

@MainActor @Observable private final class AnalyticsWindow {
    var days = 30
}

extension AnalyticsLoadingTests {
    @MainActor @Test(arguments: [CGFloat(600), CGFloat(1300)])
    func analyticsCardsFinishIndependentlyWithoutMoving(width: CGFloat) async throws {
        NSApplication.shared.finishLaunching()
        let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
        let previous = NSApplication.shared.accessibilityAttributeValue(enhanced)
        NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
        defer { NSApplication.shared.accessibilitySetValue(previous ?? false, forAttribute: enhanced) }
        let cost = AnalyticsLoadGate<CostAnalyticsResponse>()
        let scores = AnalyticsLoadGate<[PodQualityScore]>()
        let inputs = AnalyticsWindow()
        let root = AnalyticsLoadingHost(inputs: inputs, cost: cost, scores: scores)
            .environment(\.desktopRedesign, true).environment(\.colorScheme, .dark)
        let hosting = NSHostingView(rootView: root)
        hosting.sizingOptions = []
        hosting.appearance = NSAppearance(named: .darkAqua)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 950),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFront(nil)
        defer {
            for days in cost.pending.keys { cost.finish(days, .failure(CancellationError())) }
            for days in scores.pending.keys { scores.finish(days, .failure(CancellationError())) }
            window.contentView = nil
            window.close()
        }

        func node(_ title: String) -> NSObject? {
            window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded(); hosting.displayIfNeeded()
            return analyticsAXNodes(hosting).first { analyticsAX($0, "accessibilityLabel") as? String == title }
        }
        func value(_ title: String) -> String? { node(title).flatMap { analyticsAX($0, "accessibilityValue") as? String } }
        func frame(_ title: String) throws -> CGRect {
            let object = try #require(node(title))
            let frame = analyticsAX(object, "accessibilityFrame")
            let screenFrame: CGRect
            if let rect = frame as? CGRect { screenFrame = rect }
            else { screenFrame = try #require(frame as? NSValue).rectValue }
            // Accessibility frames use screen coordinates. Measure the card inside
            // its hosting view so AppKit window placement cannot look like a layout jump.
            let hostFrame = window.convertToScreen(hosting.convert(hosting.bounds, to: nil))
            let localFrame = screenFrame.offsetBy(dx: -hostFrame.minX, dy: -hostFrame.minY)
            return localFrame
        }
        func wait(_ condition: () -> Bool) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while !condition() {
                guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        func capture(_ state: String) throws {
            guard let directory = ProcessInfo.processInfo.environment["AUTOPOD_ANALYTICS_RENDER_DIR"] else { return }
            _ = node("Cost")
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("analytics-\(Int(width))-\(state).png"))
        }

        try await wait { cost.pending[30] != nil && scores.pending[30] != nil && value("Cost") == "Loading" }
        #expect(value("Process Health") == "Loading")
        #expect(value("Status distribution") != "Loading")
        // Finish the native window/scrollbar layout while both responses are held.
        // In the full UI suite AppKit may reserve its scrollbar gutter one turn later.
        var settledFrame = try frame("Cost")
        var stableObservations = 0
        try await wait {
            guard let current = try? frame("Cost") else { return false }
            if current == settledFrame { stableObservations += 1 }
            else { settledFrame = current; stableObservations = 0 }
            return stableObservations >= 3
        }
        #expect(cost.pending[30] != nil && scores.pending[30] != nil)
        let initialFrame = try frame("Cost")
        try capture("loading")
        let response = try JSONDecoder().decode(CostAnalyticsResponse.self, from: Data(#"{"total":46.02,"sparkline":[{"day":"2026-10-18","costUsd":12},{"day":"2026-10-19","costUsd":34.02}],"deltaVsPrior":{"value":-5,"direction":"down"},"byPhase":[],"byProfileModel":[],"top10":[],"waste":{"total":0,"podCount":0}}"#.utf8))
        cost.finish(30, .success(response))
        try await wait { value("Cost")?.contains("$46.02") == true }
        #expect(value("Process Health") == "Loading")
        #expect(try frame("Cost") == initialFrame)
        try capture("partial")
        scores.finish(30, .success([]))
        try await wait { value("Process Health") == "—" }
        #expect(try frame("Cost") == initialFrame)
        try capture("loaded")

        inputs.days = 7
        try await wait { cost.pending[7] != nil && value("Cost") == "Loading" }
        #expect(try frame("Cost") == initialFrame)
        cost.finish(7, .failure(URLError(.cannotConnectToHost)))
        scores.finish(7, .success([]))
        try await wait { value("Cost") != "Loading" }
        #expect(try frame("Cost") == initialFrame)
        try capture("error")
    }

}

@MainActor private struct AnalyticsLoadingHost: View {
    var inputs: AnalyticsWindow
    var cost: AnalyticsLoadGate<CostAnalyticsResponse>
    var scores: AnalyticsLoadGate<[PodQualityScore]>
    var body: some View {
        AnalyticsView(pods: [], loadScores: { try await scores.load(inputs.days) },
            loadCost: { try await cost.load($0) })
            .environment(\.desktopAnalyticsWindow, inputs.days)
    }
}

@MainActor private func analyticsAX(_ node: NSObject, _ key: String) -> Any? {
    guard node.responds(to: NSSelectorFromString(key)) else { return nil }
    return node.value(forKey: key)
}

@MainActor private func analyticsAXNodes(_ node: NSObject) -> [NSObject] {
    [node] + (analyticsAX(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(analyticsAXNodes)
}
