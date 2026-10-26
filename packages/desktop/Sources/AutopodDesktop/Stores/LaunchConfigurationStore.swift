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
  private var pimDiscovery: ConfigurationJSON?
  private let journalDirectory: URL?
  public init(journalDirectory: URL? = nil) { self.journalDirectory = journalDirectory }
  public func disconnect() {
    api = nil; generation = UUID(); pimDiscovery = nil; documents = []; capabilities = .object([:]); supported = false; loading = false
    error = "Connect to a daemon with composable configuration support."
  }
  public func configure(api: DaemonAPI) {
    self.api = api; generation = UUID(); pimDiscovery = nil; documents = []; capabilities = .object([:]); supported = false; loading = false; error = nil
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
  private func onConnection<T: Sendable>(_ owner: UUID, operation: @MainActor (DaemonAPI) async throws -> T) async throws -> T {
    guard generation == owner else { throw DaemonError.networkError("Connection changed. Reopen this launch on the current daemon.") }
    let api = try connectedAPI()
    do {
      let value = try await operation(api)
      guard generation == owner else { throw DaemonError.networkError("Connection changed. The earlier daemon may have accepted the request.") }
      return value
    } catch {
      guard generation == owner else { throw DaemonError.networkError("Connection changed. Check the earlier daemon before repeating the request.") }
      throw error
    }
  }
  /// The refresh can suspend after launch admission. Navigation must still belong
  /// to the same configuration generation and fleet owner when it completes.
  public func actions(selectingIn podStore: PodStore) -> LaunchConfigurationActions {
    let connection = generation
    let owner = api.flatMap { podStore.ownership(for: $0) }
    let isCurrent = { self.generation == connection && podStore.isCurrent(owner) }
    var actions = actions(onCreated: { id in
      guard isCurrent() else { return }
      await podStore.loadSessions()
      guard isCurrent() else { return }
      podStore.selectedSessionId = id
    })
    let launch = actions.launch
    actions.launch = { request in
      guard isCurrent() else { throw DaemonError.networkError("Connection changed. Reopen this launch on the current daemon.") }
      let id = try await launch(request)
      guard isCurrent() else { throw DaemonError.networkError("Connection changed. Check the original daemon for the accepted launch.") }
      return id
    }
    return actions
  }
  public func actions(onCreated: @escaping (String) async -> Void) -> LaunchConfigurationActions {
    let owner = generation
    var actions = LaunchConfigurationActions(documents: documents, capabilities: capabilities, loadError: error,
      reload: { await self.load() },
      resolve: { value in try await self.onConnection(owner) { try await $0.resolveLaunch(value) } },
      launch: { request in
        let pod = try await self.onConnection(owner) { api in
          _ = try LaunchRequestJournal.save(request, directory: self.journalDirectory)
          return try await api.launchPod(request)
        }
        await onCreated(pod.id)
        guard self.generation == owner else {
          throw DaemonError.networkError("Connection changed after launch admission. Check the original daemon before retrying.")
        }
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
      discoverPim: { fresh in
        let current = self.generation
        let value = try await self.connectedAPI().discoverPimEligibility(fresh: fresh)
        // A reply for a previous daemon connection must not seed the next one's picker.
        if self.generation == current { self.pimDiscovery = value }
        return value
      },
      saveFromLaunch: { try await self.connectedAPI().saveProfileFromLaunch($0) },
      listWatchers: { try await self.connectedAPI().listWatcherBindings() },
      saveWatcher: { try await self.connectedAPI().writeWatcherBinding($0) },
      readLaunch: { id in try await self.onConnection(owner) { try await $0.getLaunchConfiguration(id) } })
    actions.connectionID = owner.uuidString
    actions.cachedPim = { self.pimDiscovery }
    actions.listRegistryCredentials = { try await self.connectedAPI().listRegistryCredentials() }
    actions.saveRegistryCredential = { try await self.connectedAPI().saveRegistryCredential($0, body: $1) }
    actions.testPackageFeed = { try await self.connectedAPI().testPackageFeed($0, revision: $1) }
    actions.listDeployments = { try await self.connectedAPI().listDeployments() }
    actions.reviewDeployment = { try await self.connectedAPI().reviewDeployment($0) }
    actions.decideDeployment = { try await self.connectedAPI().decideDeployment($0, body: $1) }
    actions.reconcileDeployment = { try await self.connectedAPI().reconcileDeployment($0, body: $1) }
    return actions
  }
}
