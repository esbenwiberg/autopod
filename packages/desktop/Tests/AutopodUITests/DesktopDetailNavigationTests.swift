import AppKit
import Observation
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Observable private final class DetailNavigationInputs {
    var pod = DesktopPerformanceFixtures.pods[0]
    let navigation = DesktopDetailNavigation()
    let pipe = TerminalDataPipe()
}

@MainActor private struct DetailNavigationFixtureView: View {
    let inputs: DetailNavigationInputs
    var body: some View {
        DesktopDetailNavigationHost(navigation: inputs.navigation) { selected, requested in
            DetailPanelView(pod: inputs.pod, events: [],
                terminalState: "connected", terminalDataPipe: inputs.pipe,
                selectedTab: selected, requestedTab: requested)
        }.id(inputs.pod.id)
    }
}

@Suite(.serialized) @MainActor struct DesktopDetailNavigationTests {
    @Test func diffRemainsAvailableAfterRepeatedEvidenceNavigation() async throws {
        let host = try DesktopSelectionPerformanceHost()
        defer { host.close() }
        try await host.scope("repository")
        for _ in 0..<120 {
            try await host.selectTab("overview")
            try await host.selectTab("evidence")
        }
        try await host.selectTab("overview")
        _ = try await host.transition(tab: "diff", podID: "perf-0000")
    }

    @Test func historyOpensArchivedPodAndClearsFleetFiltersWithTabRetained() async throws {
        let host = try DesktopSelectionPerformanceHost()
        defer { host.close() }
        func edit(_ placeholder: String, _ text: String) throws {
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            let field = try #require(descendants(host.hosting).compactMap { $0 as? NSTextField }
                .first { $0.placeholderString == placeholder })
            host.window.makeFirstResponder(field)
            let editor = try #require(field.currentEditor() as? NSTextView)
            editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        }
        try await host.scope("repository")
        try await host.selectTab("work")
        try edit("Search pods", "perf-0000")
        try await host.wait { host.contains("1 pod · fixture/repository-0") }
        host.press(try #require(host.find(label: "History")))
        try await host.wait { host.find(id: "history-search") != nil }
        try edit("Search tasks, repositories, pod IDs…", "perf-0999")
        try await host.wait { host.contains("1 matching loaded records") }
        host.press(try #require(host.find(label: "Open pod ↗")))
        try await host.wait { host.inputs.selectedID == "perf-0999" && host.destination("work") }
        #expect(host.contains("51 pods · All repositories"))
        #expect(host.contains("Fixture summary for perf-0999"))
    }

    @Test func mountedTabRequestsAndPodChangesRetainValidSelection() async throws {
        let inputs = DetailNavigationInputs()
        let host = LaunchComposerHost(DetailNavigationFixtureView(inputs: inputs), width: 1_200)
        defer { host.close() }
        try await host.wait { host.has("detail-tab-work") }
        try host.press("detail-tab-work")
        try await host.wait { host.containsText("Fixture summary for perf-0000") }
        inputs.pod = DesktopPerformanceFixtures.pods[1]
        try await host.wait { host.containsText("Fixture summary for perf-0001") }
        #expect(inputs.navigation.selectedTab == .work)
        for _ in 0..<2 {
            inputs.navigation.request(.logs)
            try await host.wait { inputs.navigation.selectedTab == .logs && inputs.navigation.requestedTab == nil }
        }
        inputs.navigation.request(.diff)
        try await host.wait { inputs.navigation.selectedTab == .diff && inputs.navigation.requestedTab == nil }
        inputs.pod = DesktopPerformanceFixtures.pods[2]
        try await host.wait { host.containsText("perf-0002") }
        #expect(inputs.navigation.selectedTab == .diff)
        inputs.navigation.requestedTab = .terminal
        try await host.wait { inputs.navigation.requestedTab == nil }
        #expect(inputs.navigation.selectedTab == .diff, "An unavailable requested tab is ignored")
    }

    @Test func terminalViewRetainsIdentityAcrossTabsAndFallsBackForAnotherPod() async throws {
        let inputs = DetailNavigationInputs()
        inputs.pod.pod.agentMode = .interactive
        let host = LaunchComposerHost(DetailNavigationFixtureView(inputs: inputs), width: 1_200)
        defer { host.close() }
        func terminal(_ root: NSView) -> TerminalScrollInterceptor? {
            if let found = root as? TerminalScrollInterceptor { return found }
            return root.subviews.lazy.compactMap(terminal).first
        }
        try await host.wait { terminal(host.hosting) != nil }
        let original = try #require(terminal(host.hosting))
        try host.press("detail-tab-terminal")
        try await host.wait { inputs.navigation.selectedTab == .terminal }
        inputs.pipe.feed(Data("retained scrollback\r\n".utf8))
        try host.press("detail-tab-work")
        try await host.wait { inputs.navigation.selectedTab == .work }
        #expect(terminal(host.hosting) === original)
        try host.press("detail-tab-terminal")
        inputs.pod = DesktopPerformanceFixtures.pods[1]
        try await host.wait { inputs.navigation.selectedTab == .overview }
        #expect(terminal(host.hosting) == nil)
    }
}
