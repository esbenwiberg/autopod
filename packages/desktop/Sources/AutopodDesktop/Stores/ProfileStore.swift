import Foundation
import AutopodClient
import AutopodUI

/// Manages profile state — loading from REST, CRUD operations.
@Observable
@MainActor
public final class ProfileStore {

  public private(set) var profiles: [Profile] = []
  public private(set) var actionCatalog: [ActionCatalogItem] = []
  public private(set) var isLoading = false
  public var error: String?

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

    // Fetch action catalog in the background (non-blocking, best-effort)
    if actionCatalog.isEmpty {
      await loadActionCatalog()
    }
  }

  public func loadActionCatalog() async {
    guard let api else { return }
    do {
      let entries = try await api.fetchActionCatalog()
      actionCatalog = entries.map {
        ActionCatalogItem(name: $0.name, description: $0.description, group: $0.group)
      }
    } catch {
      print("[ProfileStore] Failed to load action catalog: \(error)")
      // Non-fatal — UI falls back to group checkboxes
    }
  }

  // MARK: - CRUD

  public func saveProfile(_ profile: Profile) async throws {
    guard let api else { return }
    let fields = ProfileMapper.mapToFields(profile)
    let response = try await api.patchProfile(profile.name, fields: fields)
    let updated = ProfileMapper.map(response)
    if let idx = profiles.firstIndex(where: { $0.name == profile.name }) {
      profiles[idx] = updated
    }
  }

  public func createProfile(_ profile: Profile) async throws {
    guard let api else { return }
    var fields = ProfileMapper.mapToFields(profile)
    fields["name"] = profile.name
    let response = try await api.createProfileFromFields(fields)
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
