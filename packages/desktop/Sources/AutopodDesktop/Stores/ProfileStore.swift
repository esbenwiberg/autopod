import Foundation
import AutopodClient
import AutopodUI

/// Manages profile state — loading from REST, CRUD operations.
@Observable
@MainActor
public final class ProfileStore {

  public private(set) var profiles: [Profile] = []
  public private(set) var isLoading = false
  public private(set) var error: String?

  private var api: DaemonAPI?

  public var profileNames: [String] {
    profiles.map(\.name).sorted()
  }

  public func configure(api: DaemonAPI) {
    self.api = api
  }

  // MARK: - Load

  public func loadProfiles() async {
    guard let api else { return }
    isLoading = true
    error = nil
    do {
      let responses = try await api.listProfiles()
      profiles = ProfileMapper.map(responses)
    } catch {
      self.error = error.localizedDescription
    }
    isLoading = false
  }

  // MARK: - CRUD

  public func deleteProfile(_ name: String) async throws {
    guard let api else { return }
    try await api.deleteProfile(name)
    profiles.removeAll { $0.name == name }
  }

  public func clearError() {
    error = nil
  }
}
