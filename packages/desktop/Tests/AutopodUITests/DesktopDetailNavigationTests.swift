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
    var connects = 0
    var disconnects = 0
    var sizes: [(Int, Int)] = []
}

@MainActor private struct DetailNavigationFixtureView: View {
    let inputs: DetailNavigationInputs
    var body: some View {
        if !inputs.navigation.isDismissed {
            DesktopDetailNavigationHost(navigation: inputs.navigation) { selected, requested in
                DetailPanelView(pod: inputs.pod, events: [],
                    terminalState: "connected", terminalDataPipe: inputs.pipe,
                    onTerminalResize: { inputs.sizes.append(($0, $1)) },
                    onTerminalConnect: { inputs.connects += 1 },
                    onTerminalDisconnect: { inputs.disconnects += 1 },
                    selectedTab: selected, requestedTab: requested,
                    onClose: { inputs.navigation.close() })
            }.id(inputs.pod.id)
        }
    }
}

@Suite(.serialized) @MainActor struct DesktopDetailNavigationTests {
    @Test func closeKeepsSelectionAndCardReopensSamePodWithTabRetained() async throws {
        let host = try DesktopSelectionPerformanceHost(width: 1_100)
        defer { host.close() }
        try await host.scope("repository")
        try await host.selectTab("work")
        let frame = host.window.frame
        #expect(host.press(try #require(host.find(id: "detail-close"))))
        try await host.wait { host.find(id: "detail-close") == nil }
        #expect(host.inputs.selectedID == "perf-0000")
        #expect(!host.contains("Select a pod"))
        #expect(host.contains("fixture/repository-0"))
        #expect(host.window.frame == frame)
        #expect(host.press(try #require(host.find(label: "Fixture pod perf-0000"))))
        try await host.wait { host.destination("work") }
        #expect(host.press(try #require(host.find(id: "detail-close"))))
        try await host.wait { host.find(id: "detail-close") == nil }
        // A passive selection/hydration change must not reveal dismissed details.
        host.inputs.selectedID = "perf-0010"
        host.layout()
        #expect(host.find(id: "detail-close") == nil)
        #expect(host.press(try #require(host.find(label: "Fixture pod perf-0010"))))
        try await host.wait { host.inputs.selectedID == "perf-0010" && host.destination("work") }
    }

    @Test func listReopensSameAndAnotherPodWithoutChangingViewOrTab() async throws {
        let host = try DesktopSelectionPerformanceHost(redesign: false)
        defer { host.close() }
        try await host.selectTab("work")
        #expect(host.press(try #require(host.find(label: "List"))))
        try await host.wait { host.find(id: "fleet-list-perf-0000") != nil }
        for id in ["perf-0000", "perf-0001"] {
            #expect(host.press(try #require(host.find(id: "detail-close"))))
            try await host.wait { host.find(id: "detail-close") == nil }
            #expect(host.press(try #require(host.find(id: "fleet-list-\(id)"))))
            try await host.wait { host.inputs.selectedID == id && host.destination("work") }
            #expect(host.find(id: "fleet-list-\(id)") != nil)
        }
    }

    @Test func filtersAndRefreshDoNotReopenDismissedDetails() async throws {
        var refreshes = 0
        let host = try DesktopSelectionPerformanceHost { view in
            view.onRefresh = { refreshes += 1 }
        }
        defer { host.close() }
        try await host.scope("repository")
        try await host.selectTab("work")
        #expect(host.press(try #require(host.find(id: "detail-close"))))
        try await host.wait { host.find(id: "detail-close") == nil }
        try host.edit("Search pods", "perf-0010")
        try await host.wait { host.contains("1 pod · fixture/repository-0") }
        try host.key(15, characters: "r", modifiers: .command)
        try await host.wait { refreshes == 1 }
        #expect(host.find(id: "detail-close") == nil)
        #expect(host.press(try #require(host.find(label: "Fixture pod perf-0010"))))
        try await host.wait { host.destination("work") }
        #expect(host.contains("1 pod · fixture/repository-0"))
    }

    @Test func sortAndDensitySurviveCloseReopen() async throws {
        let host = try DesktopSelectionPerformanceHost(width: 2_600, redesign: false)
        defer { host.close() }
        try await host.selectTab("work")
        #expect(host.press(try #require(host.find(label: "Last Active"))))
        #expect(host.press(try #require(host.find(label: "Compact"))))
        func selected(_ label: String) -> Bool {
            guard let node = host.find(label: label) else { return false }
            return host.value(node, "accessibilitySelected") as? Bool == true
                || host.value(node, "accessibilityValue") as? Int == 1
        }
        try await host.wait { selected("Last Active") && selected("Compact") }
        #expect(host.press(try #require(host.find(id: "detail-close"))))
        try await host.wait { host.find(id: "detail-close") == nil }
        #expect(selected("Last Active"))
        #expect(selected("Compact"))
        #expect(host.press(try #require(host.find(label: "Fixture pod perf-0000"))))
        try await host.wait { host.destination("work") }
        #expect(selected("Last Active"))
        #expect(selected("Compact"))
    }

    @Test func commandPaletteIntentionallyRevealsDismissedDetails() async throws {
        let host = try DesktopSelectionPerformanceHost()
        defer { host.close() }
        try await host.selectTab("work")
        #expect(host.press(try #require(host.find(id: "detail-close"))))
        try await host.wait { host.find(id: "detail-close") == nil }
        try host.key(40, characters: "k", modifiers: .command)
        try await host.wait { host.contains("FLEET / QUICK ACTIONS") }
        try host.edit("Type a command or search…", "perf-0001")
        try host.key(36, characters: "\r")
        try await host.wait { host.inputs.selectedID == "perf-0001" && host.destination("work") }
    }

    @Test func seriesWorkspaceIntentionallyRevealsDismissedDetails() async throws {
        let host = try DesktopSelectionPerformanceHost { view in
            view.pods[0].seriesId = "close-reopen-series"
            view.pods[0].seriesName = "Close/reopen series"
        }
        defer { host.close() }
        try await host.selectTab("work")
        #expect(host.press(try #require(host.find(id: "detail-close"))))
        try await host.wait { host.find(id: "detail-close") == nil }
        #expect(host.press(try #require(host.find(label: "Series"))))
        try await host.wait { host.find(id: "desktop-series-close-reopen-series") != nil }
        #expect(host.press(try #require(host.find(id: "desktop-series-close-reopen-series"))))
        #expect(host.find(id: "detail-close") == nil, "Series owns a separate detail column")
        #expect(host.press(try #require(host.find(label: "Summary"))))
        try await host.wait { host.find(label: "perf-0000") != nil }
        #expect(host.press(try #require(host.find(label: "perf-0000"))))
        try await host.wait { host.inputs.selectedID == "perf-0000" && host.destination("overview") }
    }

    @Test func dismissalSurvivesPassiveSelectionAndTabUpdates() {
        let navigation = DesktopDetailNavigation()
        navigation.request(.work)
        navigation.close()
        navigation.request(.logs)
        #expect(navigation.isDismissed)
        #expect(navigation.selectedTab == .logs)
        navigation.reveal()
        #expect(!navigation.isDismissed)
        #expect(navigation.selectedTab == .logs)
    }
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
        #expect(host.press(try #require(host.find(id: "detail-close"))))
        try await wait("dismissed detail") { host.find(id: "detail-close") == nil }
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
        try await host.wait { inputs.navigation.selectedTab == .terminal }
        try host.press("detail-close")
        try await host.wait { terminal(host.hosting) == nil }
        #expect(inputs.connects == 0)
        #expect(inputs.disconnects == 0)
        inputs.pipe.feed(Data("output while closed\r\n".utf8))
        inputs.navigation.reveal()
        try await host.wait { terminal(host.hosting) != nil }
        let reopened = try #require(terminal(host.hosting))
        #expect(reopened.terminalView === original.terminalView)
        let engine = reopened.terminalView.getTerminal()
        try await host.wait {
            let lines = (0..<engine.rows).compactMap {
                engine.getLine(row: $0)?.translateToString(trimRight: true)
            }.joined(separator: "\n")
            return lines.contains("retained scrollback") && lines.contains("output while closed")
        }
        #expect(inputs.navigation.selectedTab == .terminal)
        #expect(inputs.connects == 0)
        #expect(inputs.disconnects == 0)
        #expect(inputs.sizes.allSatisfy { $0.0 > 0 && $0.1 > 0 })
        inputs.pod = DesktopPerformanceFixtures.pods[1]
        try await host.wait { inputs.navigation.selectedTab == .overview }
        #expect(terminal(host.hosting) == nil)
    }
}
