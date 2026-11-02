import Foundation
import Testing
@testable import AutopodUI

@MainActor @Test func retainedArchiveLeavesDefaultFleetButRemainsSearchableAndRestorable() {
    var retained = Pod(id: "retained", status: .reviewRequired, branch: "source", profileName: "test",
        model: "fixture", startedAt: Date())
    retained.fleetArchivedAt = "2026-11-01T12:00:00Z"
    let visible = Pod(id: "visible", status: .failed, branch: "source", profileName: "test",
        model: "fixture", startedAt: Date())
    let pods = [retained, visible]
    #expect(MainView.visiblePods(pods, selection: .all).map(\.id) == ["visible"])
    #expect(MainView.visiblePods(pods, selection: .all, selectedPodId: "retained").map(\.id) == ["visible"])
    #expect(MainView.visiblePods(pods, selection: .attention).map(\.id) == ["visible"])
    #expect(MainView.visiblePods(pods, selection: .all, browseScope: .archive).count == 2)
    #expect(MainView.visiblePods(pods, selection: .all, query: "retained").map(\.id) == ["retained"])
    retained.fleetArchivedAt = nil
    #expect(MainView.visiblePods([retained], selection: .all).map(\.id) == ["retained"])
    #expect(retained.status == .reviewRequired)
    #expect(retained.branch == "source")
}
