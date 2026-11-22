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
    #expect(BrowseScope.archive.rawValue == "All records")
    #expect(Set(MainView.visiblePods(pods, selection: .all, browseScope: .archive).map(\.id)) == ["retained", "visible"])
    #expect(MainView.visiblePods(pods, selection: .all, query: "retained").map(\.id) == ["retained"])
    retained.fleetArchivedAt = nil
    #expect(MainView.visiblePods([retained], selection: .all).map(\.id) == ["retained"])
    #expect(retained.status == .reviewRequired)
    #expect(retained.branch == "source")
}

@MainActor @Test func fleetArchiveDestinationClearsRepositoryAndRevealsOldExactSelection() {
    let currentRepo = Profile(name: "current", repoUrl: "https://github.com/example/current.git")
    let oldRepo = Profile(name: "retired", repoUrl: "https://github.com/example/retired.git")
    let now = Date()
    let current = Pod(id: "current", status: .running, branch: "current", profileName: "current",
        model: "fixture", startedAt: now, profileSnapshot: currentRepo)
    var old = Pod(id: "retained-1234", status: .reviewRequired, branch: "source", profileName: "retired",
        model: "fixture", startedAt: now.addingTimeInterval(-365 * 86400), profileSnapshot: oldRepo)
    old.fleetArchivedAt = "2026-11-01T12:00:00Z"
    let pods = [current, old]

    let repositoryID = DesktopRepository(url: currentRepo.repoUrl)?.id
    #expect(MainView.visiblePods(pods, selection: .all, limit: 1, repositoryID: repositoryID).map(\.id) == [current.id])

    let destination = MainView.fleetPodDestination(sessionId: old.id, pods: pods)
    #expect(destination.session == old.id)
    #expect(destination.sidebar == .all)
    #expect(destination.repositoryID == nil)
    #expect(destination.query == old.id)
    #expect(MainView.visiblePods(pods, selection: destination.sidebar, query: destination.query,
        selectedPodId: destination.session, limit: 1, repositoryID: destination.repositoryID).map(\.id) == [old.id])
    #expect(MainView.visiblePods(pods, selection: .all, selectedPodId: old.id, limit: 1).map(\.id) == [current.id])
}
