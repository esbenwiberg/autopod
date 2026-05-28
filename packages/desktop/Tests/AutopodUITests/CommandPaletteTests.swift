import Foundation
import Testing
@testable import AutopodUI

@Test func commandPalettePodSearchUsesMainViewFields() {
    let pods = [
        Pod(
            id: "pod-billing",
            status: .running,
            branch: "feat/internal-refactor",
            profileName: "web",
            task: "Implement checkout reconciliation",
            model: "claude",
            startedAt: Date(timeIntervalSince1970: 0),
            briefTitle: "Billing dashboard",
            seriesName: "Revenue ops"
        ),
    ]

    let results = CommandPalette.results(query: "Billing", pods: pods, profiles: [])

    #expect(results.contains { $0.kind == .pod("pod-billing") })
}

@Test func commandPaletteProfileSearchReturnsShowAndEditActions() {
    let profiles = [
        Profile(name: "base", repoUrl: "https://github.com/acme/base"),
        Profile(
            name: "backend",
            repoUrl: "https://github.com/acme/api",
            extendsProfile: "base"
        ),
    ]

    let results = CommandPalette.results(query: "backend", pods: [], profiles: profiles)

    #expect(results.contains { $0.kind == .showProfilePods("backend") })
    #expect(results.contains { $0.kind == .editProfile("backend") })
}

@Test func commandPaletteProfileSearchMatchesRepoAndParent() {
    let profiles = [
        Profile(name: "backend", repoUrl: "https://github.com/acme/api", extendsProfile: "base"),
        Profile(name: "frontend", repoUrl: "https://github.com/acme/web"),
    ]

    let repoResults = CommandPalette.results(query: "acme api", pods: [], profiles: profiles)
    let parentResults = CommandPalette.results(query: "base", pods: [], profiles: profiles)

    #expect(repoResults.contains { $0.kind == .editProfile("backend") })
    #expect(parentResults.contains { $0.kind == .showProfilePods("backend") })
    #expect(!parentResults.contains { $0.kind == .editProfile("frontend") })
}

@Test func commandPaletteEmptyQueryIncludesCoreActions() {
    let results = CommandPalette.results(query: "", pods: [], profiles: [])

    #expect(results.contains { $0.kind == .action(.newPod) })
    #expect(results.contains { $0.kind == .action(.approveAllValidated) })
    #expect(results.contains { $0.kind == .action(.killAllFailed) })
}

@Test func profileListDeepLinkResolverUsesExactProfileName() {
    let profiles = [
        Profile(name: "backend", repoUrl: "https://github.com/acme/api"),
        Profile(name: "backend-worker", repoUrl: "https://github.com/acme/worker"),
    ]

    let profile = ProfileListView.profile(named: "backend", in: profiles)

    #expect(profile?.name == "backend")
}
