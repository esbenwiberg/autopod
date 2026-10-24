import Observation

@Observable @MainActor final class DesktopDetailNavigation {
    var selectedTab: DetailTab?
    var requestedTab: DetailTab?

    func request(_ tab: DetailTab) {
        selectedTab = tab
        requestedTab = tab
    }
}
