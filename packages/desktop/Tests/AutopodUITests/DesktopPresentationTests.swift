import Foundation
import Testing
@testable import AutopodUI

private func presentationPod(_ id: String, status: PodStatus = .complete,
                             snapshot: Profile? = nil, age: Double = 60) -> Pod {
    Pod(id: id, status: status, branch: "work/\(id)", profileName: "backend",
        model: "test", startedAt: Date().addingTimeInterval(-age),
        updatedAt: Date().addingTimeInterval(-age), profileSnapshot: snapshot)
}

@Test func repositoryDisplayStripsCredentialsAndTransportDetails() {
    let https = DesktopRepository(url: "https://secret-user:secret-token@github.com/acme/api.git?token=hidden#fragment")
    let ssh = DesktopRepository(url: "git@github.com:acme/api.git")
    #expect(https?.label == "acme/api")
    #expect(https?.id == ssh?.id)
    #expect(DesktopRepository(url: "/Users/private/checkouts/api") == nil)
    #expect(DesktopRepository(url: "https://github.com") == nil)
}

@Test func capturedRepositoryWinsOverEditedProfile() {
    let captured = Profile(name: "backend", repoUrl: "https://github.com/acme/original.git")
    let edited = Profile(name: "backend", repoUrl: "https://github.com/acme/different.git")
    let pod = presentationPod("captured", snapshot: captured)
    #expect(DesktopRepository.resolve(pod, profiles: [edited])?.label == "acme/original")
    #expect(DesktopRepository.resolve(pod, profiles: [edited])?.isSnapshot == true)
    let legacy = presentationPod("legacy")
    #expect(DesktopRepository.resolve(legacy, profiles: [edited])?.isSnapshot == false)
    #expect(DesktopRepository.resolve(legacy, profiles: []) == nil)
}

@MainActor @Test func repositoryFilteringHappensBeforeRecentArchiveLimit() {
    let a = Profile(name: "backend", repoUrl: "https://github.com/acme/a.git")
    let b = Profile(name: "backend", repoUrl: "https://github.com/acme/b.git")
    let pods = [presentationPod("newer", snapshot: a, age: 10), presentationPod("older", snapshot: b, age: 600)]
    let visible = MainView.visiblePods(pods, selection: .all, limit: 1,
        repositoryID: DesktopRepository(url: b.repoUrl)?.id)
    #expect(visible.map(\.id) == ["older"])
    let searched = MainView.visiblePods(pods, selection: .all, query: "acme/b")
    #expect(searched.map(\.id) == ["older"])
    let running = MainView.visiblePods(pods, selection: .running, repositoryID: DesktopRepository(url: b.repoUrl)?.id)
    #expect(running.isEmpty)
}

@Test func repositoryIdentityDistinguishesHosts() {
    let github = DesktopRepository(url: "https://github.com/acme/api.git")
    let gitlab = DesktopRepository(url: "https://gitlab.com/acme/api.git")
    #expect(github?.id != gitlab?.id)
    #expect(DesktopRepository(url: "https://dev.azure.com/acme/project/_git/api")?.label == "acme/project/api")
}

@Test func milestoneIsIndependentOfPlanAndLifecycle() {
    var pod = presentationPod("milestones", status: .running)
    pod.plan = SessionPlan(summary: "A short plan", steps: ["Inspect", "Implement"])
    pod.phase = PhaseProgress(current: 3, total: 9, description: "Reported third milestone")
    #expect(pod.desktopMilestoneToken == "M3/9")
    #expect(pod.desktopLifecycleStage == .running)
    pod.phase = PhaseProgress(current: 0, total: 0, description: "Unavailable")
    #expect(pod.desktopMilestoneToken == nil)
    pod.phase = PhaseProgress(current: 9, total: 3, description: "Invalid")
    #expect(pod.desktopMilestoneToken == nil)
}

@Test func artifactLifecycleDoesNotImplyValidationOrPrApproval() {
    var pod = presentationPod("artifact")
    pod.pod = PodConfig(output: .artifact, validate: false)
    #expect(pod.desktopLifecycleStages == [.queued, .provisioning, .running, .complete])
    pod.status = .failed
    #expect(pod.desktopLifecycleStage == nil)
}
