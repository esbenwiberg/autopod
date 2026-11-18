import Observation

@Observable @MainActor final class DesktopDetailNavigation {
    var selectedTab: DetailTab?
    var requestedTab: DetailTab?
    private(set) var isDismissed = false

    func close() { isDismissed = true }
    func reveal() { isDismissed = false }

    func request(_ tab: DetailTab) {
        selectedTab = tab
        requestedTab = tab
    }
}
