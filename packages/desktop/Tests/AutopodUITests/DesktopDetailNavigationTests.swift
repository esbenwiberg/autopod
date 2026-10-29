import AppKit
import Observation
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor private class NavigationLabelAXFixture: NSObject {
    @objc var accessibilityIdentifier: String { "duplicate-tab" }
}
@MainActor private final class NavigationActionAXFixture: NavigationLabelAXFixture {
    private(set) var presses = 0
    @objc func accessibilityPerformPress() -> Bool { presses += 1; return true }
}

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
    @Test func duplicateIdentifierSelectsTheActionNotItsNoninteractiveLabel() throws {
        let host = try DesktopSelectionPerformanceHost()
        defer { host.close() }
        let label = NavigationLabelAXFixture()
        let action = NavigationActionAXFixture()
        let node = try #require(host.find(id: "duplicate-tab", in: [label, action]))
        #expect(node === action)
        #expect(host.press(node))
        #expect(action.presses == 1)
        #expect(!host.press(label))
    }

    @Test func diffRemainsAvailableAfterRepeatedEvidenceNavigation() async throws {
        let host = try DesktopSelectionPerformanceHost()
        defer { host.close() }
        try await host.scope("repository")
        for iteration in 0..<120 {
            for tab in ["overview", "evidence"] {
                do { try await host.selectTab(tab) }
                catch {
                    print("Repeated evidence navigation failed at iteration \(iteration), destination \(tab), pod \(host.inputs.selectedID ?? "none")")
                    throw error
                }
            }
        }
        do {
            try await host.selectTab("overview")
            _ = try await host.transition(tab: "diff", podID: "perf-0000")
        } catch {
            print("Repeated evidence navigation failed at final overview/diff transition")
            throw error
        }
    }

    @Test func historyOpensArchivedPodAndClearsFleetFiltersWithTabRetained() async throws {
        let host = try DesktopSelectionPerformanceHost()
        defer { host.close() }
        func firstNode(where predicate: (NSObject) -> Bool) -> NSObject? {
            func visit(_ node: NSObject) -> NSObject? {
                if predicate(node) { return node }
                for child in host.value(node, "accessibilityChildren") as? [NSObject] ?? [] {
                    if let found = visit(child) { return found }
                }
                return nil
            }
            return visit(host.hosting)
        }
        func wait(_ checkpoint: String, _ predicate: () -> Bool) async throws {
            do { try await host.wait(predicate) }
            catch {
                print("History navigation timed out at: \(checkpoint)")
                throw error
            }
        }
        func textField(_ placeholder: String) -> NSTextField? {
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            return descendants(host.hosting).compactMap { $0 as? NSTextField }
                .first { $0.placeholderString == placeholder }
        }
        func edit(_ placeholder: String, _ text: String) throws {
            let field = try #require(textField(placeholder))
            host.window.makeFirstResponder(field)
            let editor = try #require(field.currentEditor() as? NSTextView)
            editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        }
        try await host.scope("repository")
        try await host.selectTab("work")
        try edit("Search pods", "perf-0000")
        try await wait("fleet search") { host.contains("1 pod · fixture/repository-0") }
        host.press(try #require(host.find(label: "History")))
        // This is unmeasured workspace setup, not a cached selection transition.
        // Locate the native field used by edit(), without depending on SwiftUI's
        // version-specific AX identifier forwarding or enumerating 1,000 rows.
        let historyStart = ContinuousClock.now
        let historyDeadline = historyStart.advanced(by: .seconds(20))
        while true {
            host.layout()
            if textField("Search tasks, repositories, pod IDs…") != nil { break }
            guard ContinuousClock.now < historyDeadline else {
                print("History native search control did not mount")
                throw URLError(.timedOut)
            }
            try await Task.sleep(for: .milliseconds(1))
        }
        print("History native search mounted after \(historyStart.duration(to: ContinuousClock.now))")
        try edit("Search tasks, repositories, pod IDs…", "perf-0999")
        try await wait("History search result") {
            let row = firstNode {
                host.label($0).hasPrefix("Fixture pod perf-")
                    && $0.responds(to: NSSelectorFromString("accessibilityPerformPress"))
            }
            return row.map { host.label($0).contains("perf-0999") } ?? false
        }
        #expect(host.contains("1 matching loaded records"))
        host.press(try #require(firstNode { host.label($0) == "Open pod ↗"
            && $0.responds(to: NSSelectorFromString("accessibilityPerformPress")) }))
        try await wait("archived Work destination") {
            host.inputs.selectedID == "perf-0999" && host.destination("work")
        }
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
