import AutopodClient
import Foundation

/// Read-only managed-attempt inventory. Managed pods remain separate from native pod state.
@Observable
@MainActor
public final class ManagedPodStore {
  public private(set) var pods: [ManagedPodSummary] = []
  public var selectedPodId: String?
  public private(set) var isLoading = false
  public private(set) var error: String?

  private var api: DaemonAPI?

  public init() {}

  public func configure(api: DaemonAPI) {
    // A new client can represent a different signed-in installation even when
    // it targets the same daemon URL. Never carry one installation's inventory
    // across a reconnect.
    pods = []
    selectedPodId = nil
    error = nil
    self.api = api
  }

  public func refresh() async {
    guard let api else {
      error = "API client not configured — try disconnecting and reconnecting"
      return
    }
    isLoading = true
    defer { isLoading = false }
    do {
      let fresh = try await api.listAllManagedPods()
      pods = fresh
      if let selectedPodId, !fresh.contains(where: { $0.id == selectedPodId }) {
        self.selectedPodId = nil
      }
      error = nil
    } catch {
      // Keep the last visible inventory useful during transient daemon failures.
      self.error = error.localizedDescription
    }
  }
}
