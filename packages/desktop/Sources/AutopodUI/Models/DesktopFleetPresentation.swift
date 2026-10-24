import Foundation

struct DesktopRepositoryIndex {
    var byPodID: [String: DesktopRepository] = [:]
    var repositories: [DesktopRepository] = []
    var countsByRepositoryID: [String: Int] = [:]
}

/// Memoization only: no observable writes while SwiftUI evaluates a body.
@MainActor final class DesktopRepositoryIndexCache {
    private struct Entry {
        let source: DesktopRepository.Source
        let repository: DesktopRepository?
    }
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private var index = DesktopRepositoryIndex()
    private let normalize: (String, Bool) -> DesktopRepository?

    init(normalize: @escaping (String, Bool) -> DesktopRepository? = {
        DesktopRepository(url: $0, isSnapshot: $1)
    }) { self.normalize = normalize }

    func snapshot(pods: [Pod], profiles: [Profile]) -> DesktopRepositoryIndex {
        var profilesByName: [String: String] = [:]
        for profile in profiles where profilesByName[profile.name] == nil {
            profilesByName[profile.name] = profile.repoUrl
        }
        let nextOrder = pods.map(\.id)
        var changed = nextOrder != order
        for pod in pods {
            let source = DesktopRepository.source(pod, legacyRemote: profilesByName[pod.profileName])
            if entries[pod.id]?.source != source {
                entries[pod.id] = Entry(source: source, repository: source.resolve(using: normalize))
                changed = true
            }
        }
        guard changed else { return index }
        let retained = Set(nextOrder)
        entries = entries.filter { retained.contains($0.key) }
        var next = DesktopRepositoryIndex()
        var seen = Set<String>()
        for id in nextOrder {
            guard let repository = entries[id]?.repository else { continue }
            next.byPodID[id] = repository
            next.countsByRepositoryID[repository.id, default: 0] += 1
            if seen.insert(repository.id).inserted { next.repositories.append(repository) }
        }
        next.repositories.sort {
            $0.label.localizedStandardCompare($1.label) == .orderedAscending
        }
        order = nextOrder
        index = next
        return next
    }
}

@MainActor struct DesktopFleetPresentation {
    let visible: [Pod]
    let attention: [Pod]
    let remainder: [Pod]
    let scopedTotal: Int

    init(pods: [Pod], index: DesktopRepositoryIndex, selection: SidebarItem,
         browseScope: BrowseScope, query: String, sortOrder: SortOrder,
         selectedPodID: String?, repositoryID: String?) {
        visible = MainView.visiblePods(pods, selection: selection, browseScope: browseScope,
            query: query, sortOrder: sortOrder, selectedPodId: selectedPodID,
            repositoryID: repositoryID, repositoryIndex: index)
        attention = visible.filter { $0.status.needsAttention }
        remainder = visible.filter { !$0.status.needsAttention }
        scopedTotal = repositoryID.map { index.countsByRepositoryID[$0, default: 0] } ?? pods.count
    }
}
