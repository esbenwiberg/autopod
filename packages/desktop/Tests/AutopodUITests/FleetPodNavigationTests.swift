import Foundation
import Testing
@testable import AutopodUI

@MainActor @Test(arguments: ["repository", "search", "both"])
func explicitFleetNavigationRevealsAnArchivedPodAcrossFilters(filter: String) {
    let current = Profile(name: "current", repoUrl: "https://github.com/example/current.git")
    let target = Profile(name: "target", repoUrl: "https://github.com/example/target.git")
    let pods = [
        Pod(id: "recent", status: .complete, branch: "recent", profileName: "current", task: "Current task",
            model: "fixture", startedAt: Date(timeIntervalSince1970: 100), profileSnapshot: current),
        Pod(id: "archived-target", status: .complete, branch: "archive", profileName: "target", task: "Archived repair",
            model: "fixture", startedAt: Date(timeIntervalSince1970: 1), profileSnapshot: target),
    ]
    let query = filter == "repository" ? "" : "Current task"
    let repositoryID = filter == "search" ? nil : DesktopRepository(url: current.repoUrl)?.id
    let before = MainView.visiblePods(pods, selection: .all, query: query, limit: 1, repositoryID: repositoryID)
    #expect(!before.contains { $0.id == "archived-target" })

    let destination = MainView.fleetPodDestination(sessionId: "archived-target")
    let revealed = MainView.visiblePods(pods, selection: destination.sidebar, query: destination.query,
        selectedPodId: destination.session, limit: 1, repositoryID: destination.repositoryID)
    #expect(revealed.contains { $0.id == destination.session },
        "Explicit navigation must reveal the selected pod even when it belongs to another repository or falls outside recent results")
}
