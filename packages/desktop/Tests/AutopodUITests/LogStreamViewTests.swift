import AppKit
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct LogStreamViewTests {
    @Test func startsAtNewestEventAndRetainsSearchFilteringAndExpansion() async throws {
        var events = DesktopPerformanceFixtures.events
        events[299] = AgentEvent(id: 300, timestamp: DesktopPerformanceFixtures.date,
            type: .status, summary: "Newest fixture event 299", detail: "Expanded newest event detail")
        let host = LaunchComposerHost(LogStreamView(events: events, sessionBranch: "fixture"), width: 1_200)
        defer { host.close() }
        func value(_ node: NSObject, _ key: String) -> Any? {
            guard node.responds(to: NSSelectorFromString(key)) else { return nil }
            return node.value(forKey: key)
        }
        func newest() -> NSObject? {
            host.nodes.first {
                (value($0, "accessibilityLabel") as? String ?? "").contains("Newest fixture event 299")
                    && $0.responds(to: NSSelectorFromString("accessibilityPerformPress"))
            }
        }
        try await host.wait { newest() != nil }
        let row = try #require(newest())
        #expect((value(row, "accessibilityLabel") as? String ?? "").contains(events[299].timeString))
        let frame = try #require(value(row, "accessibilityFrame") as? NSValue).rectValue
        #expect(frame.height > 0 && host.window.frame.intersects(frame), "Newest row must start inside the visible window")
        try host.pressLabel(try #require(value(row, "accessibilityLabel") as? String))
        try await host.wait { host.containsText("Expanded newest event detail") }
        try host.editField(placeholder: "Filter logs…", text: "299")
        try await host.wait { host.containsText("1 events") }
        try host.pressLabel("Tool")
        try await host.wait { host.containsText("No matching events") && host.containsText("0 events") }
        try host.pressLabel("Tool")
        try await host.wait { newest() != nil && host.containsText("1 events") }
    }
}
