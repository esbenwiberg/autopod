import AutopodClient
import Foundation

/// Polling helper for the Preview card in OverviewTab.
/// Fetches `GET /pods/:id/preview/status` on mount and every 5 s while active.
/// Tear down by calling `stop()` — the in-flight Task is cancelled immediately.
@Observable
@MainActor
final class PreviewPoller {
    private(set) var status: PreviewStatus? = nil
    private(set) var isPolling: Bool = false
    private var pollTask: Task<Void, Never>?

    /// Start (or restart) polling. Safe to call when already polling — restarts cleanly.
    func start(podId: String, load: @escaping (String) async throws -> PreviewStatus) {
        stop()
        isPolling = true
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do { self.status = try await load(podId) } catch {}
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
