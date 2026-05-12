import AutopodClient
import Foundation

/// Polling helper for the Preview card in OverviewTab.
/// Fetches `GET /pods/:id/preview/status` on mount and every 5 s while active.
/// Tear down by calling `stop()` — the in-flight Task is cancelled immediately.
@Observable
@MainActor
final class PreviewPoller {
    private(set) var status: PreviewStatus? = nil
    /// Last fetch error message, if any. Non-nil signals that `status` is stale
    /// (or absent) and the UI should surface uncertainty rather than trust it.
    private(set) var lastFetchError: String? = nil
    private(set) var isPolling: Bool = false
    private var pollTask: Task<Void, Never>?

    /// Start (or restart) polling. Safe to call when already polling — restarts cleanly.
    func start(podId: String, load: @escaping (String) async throws -> PreviewStatus) {
        stop()
        isPolling = true
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    self.status = try await load(podId)
                    self.lastFetchError = nil
                } catch {
                    // Preserve the last known status to avoid flicker on transient
                    // failures, but surface the error so the card can warn the user.
                    self.lastFetchError = error.localizedDescription
                }
                guard !Task.isCancelled else { return }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    /// Cancel in-flight polling task immediately.
    func stop() {
        pollTask?.cancel()
        pollTask = nil
        isPolling = false
    }

    /// Convenience: stop polling when the pod reaches a terminal status.
    /// Called from the view's `.onChange(of: pod.status)`.
    func stopIfTerminal(status: PodStatus) {
        if status.isTerminal { stop() }
    }
}
