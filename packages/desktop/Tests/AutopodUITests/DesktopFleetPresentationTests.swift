import AutopodClient
import Foundation
import Testing
@testable import AutopodUI

@Suite @MainActor struct DesktopFleetPresentationTests {
    @Test func duplicateIdentityUsesCurrentFirstPodWithoutReparsingOnReorder() throws {
        let captured = DesktopPerformanceFixtures.pods[0]
        var legacy = DesktopPerformanceFixtures.pods[1]
        legacy.profileName = captured.profileName
        legacy.profileSnapshot = nil
        let profile = try #require(captured.profileSnapshot)
        var parses = 0
        let cache = DesktopRepositoryIndexCache { remote, snapshot in
            parses += 1
            return DesktopRepository(url: remote, isSnapshot: snapshot)
        }
        let first = cache.snapshot(pods: [captured, legacy], profiles: [profile])
        #expect(first.repositories.count == 1 && first.repositories.first?.isSnapshot == true)
        #expect(first.countsByRepositoryID.values.first == 2)
        let reordered = cache.snapshot(pods: [legacy, captured], profiles: [profile])
        #expect(parses == 2)
        #expect(reordered.repositories.first?.isSnapshot == false)
        #expect(reordered.byPodID[captured.id]?.isSnapshot == true)
        #expect(reordered.byPodID[legacy.id]?.isSnapshot == false)
    }

    @Test func unchangedAndUnrelatedUpdatesDoNotReparseThousandPodIndex() throws {
        var parses = 0
        let cache = DesktopRepositoryIndexCache { remote, captured in
            parses += 1
            return DesktopRepository(url: remote, isSnapshot: captured)
        }
        var pods = DesktopPerformanceFixtures.pods
        let coldStart = ContinuousClock.now
        let initial = cache.snapshot(pods: pods, profiles: [])
        let cold = coldStart.duration(to: .now).components
        print("Repository index cold construction (1,000 pods): \(Double(cold.seconds) * 1_000 + Double(cold.attoseconds) / 1e15) ms")
        #expect(parses == 1_000 && initial.repositories.count == 10)
        #expect(initial.countsByRepositoryID.values.allSatisfy { $0 == 100 })
        pods[0].latestActivity = "New activity"
        pods[0].inputTokens += 100
        let cachedStart = ContinuousClock.now
        _ = cache.snapshot(pods: pods, profiles: [])
        let cached = cachedStart.duration(to: .now).components
        print("Repository index unchanged-source refresh: \(Double(cached.seconds) * 1_000 + Double(cached.attoseconds) / 1e15) ms; extra normalizations: \(parses - 1_000)")
        #expect(parses == 1_000)
        pods[0].fleetDisplay = .init(repository: .init(kind: "repository", remote: "https://github.com/new/repository"))
        let changed = cache.snapshot(pods: pods, profiles: [])
        #expect(parses == 1_001 && changed.repositories.count == 11)
        #expect(changed.byPodID[pods[0].id]?.label == "new/repository")
        let removed = pods.removeFirst()
        #expect(cache.snapshot(pods: pods, profiles: []).byPodID[removed.id] == nil)
        pods.insert(removed, at: 0)
        _ = cache.snapshot(pods: pods, profiles: [])
        #expect(parses == 1_002, "Removed entries must be evicted and parsed on reinsert")
        #expect(cache.snapshot(pods: [], profiles: []).repositories.isEmpty)
    }

    @Test func precedenceAndLegacyProfileInvalidationPreserveExplicitEmpty() {
        let profile = Profile(name: "legacy", repoUrl: "https://github.com/fixture/old")
        var captured = DesktopPerformanceFixtures.pods[0]
        captured.profileName = "legacy"
        var legacy = DesktopPerformanceFixtures.pods[1]
        legacy.profileName = "legacy"; legacy.profileSnapshot = nil
        var empty = DesktopPerformanceFixtures.pods[2]
        empty.profileName = "legacy"; empty.fleetDisplay = .init(repository: .init(kind: "empty"))
        var parses = 0
        let cache = DesktopRepositoryIndexCache { remote, snapshot in
            parses += 1; return DesktopRepository(url: remote, isSnapshot: snapshot)
        }
        var pods = [captured, legacy, empty]
        let initial = cache.snapshot(pods: pods, profiles: [profile])
        #expect(parses == 2 && initial.byPodID[empty.id] == nil)
        #expect(initial.byPodID[legacy.id]?.isSnapshot == false)
        let edited = Profile(name: "legacy", repoUrl: "https://user:secret@github.com/fixture/new.git?private=1")
        let updated = cache.snapshot(pods: pods, profiles: [edited, profile])
        #expect(parses == 3)
        #expect(updated.byPodID[legacy.id]?.label == "fixture/new")
        #expect(updated.byPodID[captured.id] == initial.byPodID[captured.id])
        pods[2].fleetDisplay = .init(repository: .init(kind: "unavailable"))
        #expect(cache.snapshot(pods: pods, profiles: [edited]).byPodID[empty.id] == nil)
        #expect(parses == 3)
        pods[2].fleetDisplay = .init(repository: .init(kind: "repository", remote: "not-a-remote"))
        _ = cache.snapshot(pods: pods, profiles: [edited])
        _ = cache.snapshot(pods: pods, profiles: [edited])
        #expect(parses == 4, "Invalid remote results must also be memoized")
        pods[2].fleetDisplay = nil
        #expect(cache.snapshot(pods: pods, profiles: [edited]).byPodID[empty.id]?.isSnapshot == true)
    }

    @Test func sharedPresentationKeepsArchiveSearchSelectionAndCurrentPodValues() {
        var pods = DesktopPerformanceFixtures.pods
        let cache = DesktopRepositoryIndexCache()
        let index = cache.snapshot(pods: pods, profiles: [])
        func presentation(query: String = "", selected: String? = nil, repository: String? = nil) -> DesktopFleetPresentation {
            DesktopFleetPresentation(pods: pods, index: index, selection: .all,
                browseScope: .recent, query: query, sortOrder: .created,
                selectedPodID: selected, repositoryID: repository)
        }
        #expect(presentation().visible.count == 50)
        #expect(presentation(selected: "perf-0990").visible.count == 51)
        #expect(presentation(query: "perf-0990").visible.map(\.id) == ["perf-0990"])
        let filtered = presentation(repository: "github.com/fixture/repository-0")
        #expect(filtered.scopedTotal == 100 && filtered.visible.count == 50)
        #expect(filtered.visible.allSatisfy { index.byPodID[$0.id]?.id == "github.com/fixture/repository-0" })
        pods[0].latestActivity = "Changed after index construction"
        pods[0].status = .failed
        let fresh = presentation()
        #expect(fresh.visible.first { $0.id == "perf-0000" }?.latestActivity == "Changed after index construction")
        #expect(fresh.attention.contains { $0.id == "perf-0000" && $0.status == .failed })
        #expect(fresh.attention.count + fresh.remainder.count == fresh.visible.count)
    }
}
