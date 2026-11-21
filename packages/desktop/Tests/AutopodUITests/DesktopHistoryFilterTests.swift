import Foundation
import Testing
@testable import AutopodUI

@Test func historyFiltersUseRepositoryIdentityAndExcludeWorkspaces() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let repo = DesktopRepository(url: "https://user:secret@github.com/acme/service.git")!
    var worker = historyPod("worker", now: now)
    worker.task = "Repair checkpoint retries"
    var workspace = historyPod("workspace", now: now)
    workspace.pod.agentMode = .interactive
    var filter = DesktopHistoryFilter()
    filter.repository = repo.id
    filter.query = "checkpoint"
    #expect(filter.matches(worker, repository: repo, now: now))
    #expect(!filter.matches(worker, repository: nil, now: now))
    #expect(!filter.matches(workspace, repository: repo, now: now))
    #expect(repo.id == "github.com/acme/service")
    #expect(!repo.label.contains("secret"))
}

@Test func historyDateWindowHasAnInclusiveBoundaryAndAllLoadedEscape() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    var filter = DesktopHistoryFilter()
    filter.days = 7
    let edge = historyPod("edge", now: now.addingTimeInterval(-7 * 86400))
    let old = historyPod("old", now: edge.startedAt.addingTimeInterval(-1))
    #expect(filter.matches(edge, repository: nil, now: now))
    #expect(!filter.matches(old, repository: nil, now: now))
    filter.days = 0
    #expect(filter.matches(old, repository: nil, now: now))
}

@Test func historyUnknownRepositoryAndAttentionFiltersRemainDistinct() {
    let now = Date()
    var filter = DesktopHistoryFilter()
    filter.repository = "unknown"; filter.profile = "backend"; filter.outcome = "attention"
    var pod = historyPod("failure", now: now)
    for status in [PodStatus.failed, .killed, .reviewRequired] {
        pod.status = status
        #expect(filter.matches(pod, repository: nil, now: now))
    }
    pod.status = .complete
    #expect(!filter.matches(pod, repository: nil, now: now))
    pod.status = .failed
    #expect(!filter.matches(pod, repository: DesktopRepository(url: "https://github.com/acme/app"), now: now))
    filter.profile = "another-profile"
    #expect(!filter.matches(pod, repository: nil, now: now))
}

@Test(arguments: PodStatus.allCases)
func previouslyArchivedFilterUsesOnlyTheArchiveFlag(status: PodStatus) {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    var archived = historyPod("archived", now: now.addingTimeInterval(-365 * 86400))
    archived.status = status
    archived.fleetArchivedAt = "2026-11-01T12:00:00Z"
    var current = historyPod("current", now: now)
    current.status = status
    let matches = PreviouslyArchivedPods.matches([current, archived], query: "")
    #expect(matches.map(\.id) == ["archived"])
    #expect(matches.first?.status == status)
}

@Test func previouslyArchivedSearchFindsOldWorkspacesAndPrefersExactIDOverTaskMatches() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let repo = DesktopRepository(url: "https://github.com/example/retired-repository.git")!
    var old = historyPod("old-abc", now: now.addingTimeInterval(-365 * 86400))
    old.pod.agentMode = .interactive
    old.task = "Retained checkpoint"
    old.fleetArchivedAt = "2026-11-01T12:00:00Z"
    var newer = historyPod("newer", now: now)
    newer.task = "Follow-up for old-abc"
    newer.fleetArchivedAt = "2027-01-01T12:00:00Z"
    var live = historyPod("live", now: now)
    live.task = old.task
    let pods = [old, newer, live]
    let repositories = [old.id: repo]

    #expect(!DesktopHistoryFilter().matches(old, repository: repo, now: now))
    #expect(PreviouslyArchivedPods.matches(pods, query: "").map(\.id) == [newer.id, old.id])
    #expect(PreviouslyArchivedPods.matches(pods, query: "  old-abc \n").map(\.id) == [old.id])
    #expect(PreviouslyArchivedPods.matches(pods, query: "checkpoint").map(\.id) == [old.id])
    #expect(PreviouslyArchivedPods.matches(pods, query: "retired-repository", repositories: repositories).map(\.id) == [old.id])
    #expect(PreviouslyArchivedPods.matches(pods, query: "live").isEmpty)
    #expect(PreviouslyArchivedPods.exactMatch(pods, query: "old-abc")?.id == old.id)
    #expect(PreviouslyArchivedPods.exactMatch(pods, query: "old-ab") == nil)
    #expect(PreviouslyArchivedPods.exactMatch(pods, query: "live") == nil)
}

private func historyPod(_ id: String, now: Date) -> Pod {
    Pod(id: id, status: .complete, branch: "history", profileName: "backend", task: "Task", model: "Model A", startedAt: now)
}
