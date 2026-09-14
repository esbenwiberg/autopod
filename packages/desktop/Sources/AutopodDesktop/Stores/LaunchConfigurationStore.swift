import AutopodClient
import AutopodUI
import Foundation

@Observable @MainActor
public final class LaunchConfigurationStore {
  public private(set) var documents: [ConfigurationDocument] = []
  public private(set) var capabilities: ConfigurationJSON = .object([:])
  public private(set) var supported = false
  public private(set) var loading = false
  public var error: String?
  private var api: DaemonAPI?
  private var generation = UUID()
  public init() {}
  public func disconnect() {
    api = nil; generation = UUID(); documents = []; capabilities = .object([:]); supported = false; loading = false
    error = "Connect to a daemon with composable configuration support."
  }
  public func configure(api: DaemonAPI) {
    self.api = api; generation = UUID(); documents = []; capabilities = .object([:]); supported = false; loading = false; error = nil
  }
  public func load() async {
    guard let api else { return }
    let current = generation; loading = true; error = nil
    defer { if generation == current { loading = false } }
    do {
      let caps = try await api.configurationCapabilities()
      guard generation == current else { return }
      capabilities = caps; supported = true
      let loaded = try await withThrowingTaskGroup(of: [ConfigurationDocument].self) { group in
        for kind in ConfigurationKind.allCases { group.addTask { try await api.listConfigurations(kind) } }
        var all: [ConfigurationDocument] = []
        for try await entries in group { all.append(contentsOf: entries) }
        return all
      }
      guard generation == current else { return }
      documents = loaded
    } catch {
      guard generation == current else { return }
      self.error = error.localizedDescription
    }
  }
  private func connectedAPI() throws -> DaemonAPI {
    guard let api else { throw DaemonError.networkError("Connect to the daemon first") }; return api
  }
  public func actions(onCreated: @escaping (String) async -> Void) -> LaunchConfigurationActions {
    var actions = LaunchConfigurationActions(documents: documents, capabilities: capabilities, loadError: error,
      reload: { await self.load() },
      resolve: { try await self.connectedAPI().resolveLaunch($0) },
      launch: { request in
        _ = try LaunchRequestJournal.save(request)
        let pod = try await self.connectedAPI().launchPod(request)
        await onCreated(pod.id)
        return pod.id
      },
      save: { kind, request in
        let result = try await self.connectedAPI().writeConfiguration(kind, body: request)
        if let index = self.documents.firstIndex(where: { $0.id == result.id }) { self.documents[index] = result }
        else { self.documents.append(result) }
        return result
      },
      archive: { document in
        try await self.connectedAPI().archiveConfiguration(document.kind, id: document.id, expectedRevision: document.revision)
        self.documents.removeAll { $0.id == document.id }
      },
      discoverGitHubRepositories: { try await self.connectedAPI().discoverGitHubRepositories() },
      discoverGitHubWorkflows: { try await self.connectedAPI().discoverGitHubWorkflows(repositoryId: $0) },
      loadProviderAccounts: { try await self.connectedAPI().listProviderAccounts() },
      discoverPim: { try await self.connectedAPI().discoverPimEligibility() },
      saveFromLaunch: { try await self.connectedAPI().saveProfileFromLaunch($0) },
      listWatchers: { try await self.connectedAPI().listWatcherBindings() },
      saveWatcher: { try await self.connectedAPI().writeWatcherBinding($0) },
      readLaunch: { try await self.connectedAPI().getLaunchConfiguration($0) })
    actions.listDeployments = { try await self.connectedAPI().listDeployments() }
    actions.reviewDeployment = { try await self.connectedAPI().reviewDeployment($0) }
    actions.decideDeployment = { try await self.connectedAPI().decideDeployment($0, body: $1) }
    actions.reconcileDeployment = { try await self.connectedAPI().reconcileDeployment($0, body: $1) }
    return actions
  }
}
