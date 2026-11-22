import AppKit
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct PreviouslyArchivedNavigationTests {
    @Test(arguments: [false, true])
    func historySearchOpensTheExactArchivedPod(redesign: Bool) async throws {
        let target = "perf-0001"
        let host = try DesktopSelectionPerformanceHost(redesign: redesign) { view in
            view.pods = Array(view.pods.prefix(3))
            view.pods[1].startedAt = Date().addingTimeInterval(-365 * 86400)
            view.pods[1].status = .reviewRequired
            view.pods[1].fleetArchivedAt = "2026-11-01T12:00:00Z"
            view.pods[2].status = .failed
            view.pods[2].task = "Unarchived mention of \(target)"
        }
        defer { host.close() }

        func wait(_ step: String, _ predicate: () -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async throws {
            do { try await host.wait(predicate) }
            catch { Issue.record("Timed out: \(step)", sourceLocation: sourceLocation); throw error }
        }

        if redesign {
            try await wait("History sidebar") { host.find(label: "History") != nil }
            host.press(try #require(host.find(label: "History")))
            try await wait("redesigned History tabs") { host.find(label: PreviouslyArchivedPods.title) != nil }
            host.press(try #require(host.find(label: PreviouslyArchivedPods.title)))
        } else {
            // The legacy sidebar uses an outline, whose virtual AX rows have no labels in the host.
            // History is the ninth item in the Pods section (the section header is row 0).
            func sidebar(in view: NSView) -> NSOutlineView? {
                (view as? NSOutlineView) ?? view.subviews.lazy.compactMap(sidebar).first
            }
            try await wait("legacy sidebar outline") { sidebar(in: host.hosting) != nil }
            let table = try #require(sidebar(in: host.hosting))
            table.selectRowIndexes(IndexSet(integer: 9), byExtendingSelection: false)
            try await wait("legacy History segments") { host.fleetSegment(PreviouslyArchivedPods.title) != nil }
            try host.selectFleetSegment(PreviouslyArchivedPods.title)
        }

        let openID = "previously-archived-open-\(target)"
        try await wait("unfiltered archive row") { host.find(id: openID) != nil }
        #expect(host.contains("Archived pods may still hold resources"))
        try host.edit("Search archived pods by ID, task, or repository", "perf-0002")
        try await wait("empty search result") { host.contains("No matching archived pods") }
        #expect(host.find(id: openID) == nil)

        try host.edit("Search archived pods by ID, task, or repository", target)
        try await wait("exact archived search result") { host.find(id: openID) != nil }
        #expect(host.inputs.selectedID == "perf-0000", "Typing does not change the pod selection")
        if redesign {
            try host.key(36, characters: "\r") // Return submits the exact ID.
        } else {
            host.press(try #require(host.find(id: openID)))
        }
        try await wait("archived detail opens") {
            host.inputs.selectedID == target && host.find(id: "detail-close") != nil
        }
        try await host.selectTab("work")
        #expect(host.contains("Fixture summary for \(target)"))
    }
}
