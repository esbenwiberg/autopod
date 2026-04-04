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

  public init() {}

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
      print("[ProfileStore] Failed to load profiles: \(error)")
      self.error = error.localizedDescription
    }
    isLoading = false
  }

  // MARK: - CRUD

  public func saveProfile(_ profile: Profile) async throws {
    guard let api else { return }
    let body = ProfileMapper.mapToResponse(profile)
    let response = try await api.updateProfile(profile.name, body: body)
    let updated = ProfileMapper.map(response)
    if let idx = profiles.firstIndex(where: { $0.name == profile.name }) {
      profiles[idx] = updated
    }
  }

  public func createProfile(_ profile: Profile) async throws {
    guard let api else { return }
    let body = ProfileMapper.mapToResponse(profile)
    let response = try await api.createProfile(body)
    let created = ProfileMapper.map(response)
    profiles.append(created)
  }

  public func deleteProfile(_ name: String) async throws {
    guard let api else { return }
    try await api.deleteProfile(name)
    profiles.removeAll { $0.name == name }
  }

  public func clearError() {
    error = nil
  }
}
