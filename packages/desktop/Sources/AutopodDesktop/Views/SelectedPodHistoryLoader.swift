import AutopodClient
import SwiftUI

/// One owner for the selected pod's initial and navigation-driven history load.
struct SelectedPodHistoryLoader: ViewModifier {
    let selectedPodID: String?
    let api: DaemonAPI?
    let podStore: PodStore
    let eventStream: EventStream?

    func body(content: Content) -> some View {
        content.task(id: selectedPodID) {
            guard let id = selectedPodID, let api else { return }
            await podStore.hydrateSessionIfNeeded(id)
            guard !Task.isCancelled else { return }
            eventStream?.loadHistoricalEvents(podId: id, api: api)
        }
    }
}
