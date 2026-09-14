import AutopodClient
import Foundation

@MainActor
public struct LaunchConfigurationActions {
  public var documents: [ConfigurationDocument]
  public var listDeployments: () async throws -> [ConfigurationJSON] = { throw DaemonError.badRequest("Deployment is unavailable") }
  public var reviewDeployment: (String) async throws -> ConfigurationJSON = { _ in throw DaemonError.badRequest("Deployment is unavailable") }
  public var decideDeployment: (String, ConfigurationJSON) async throws -> ConfigurationJSON = { _, _ in throw DaemonError.badRequest("Deployment is unavailable") }
  public var reconcileDeployment: (String, ConfigurationJSON) async throws -> ConfigurationJSON = { _, _ in throw DaemonError.badRequest("Deployment is unavailable") }
  public var readLaunch: (String) async throws -> EffectiveLaunchPreview
  public var listWatchers: () async throws -> [WatcherBindingResponse]
  public var saveWatcher: (WatcherBindingWrite) async throws -> WatcherBindingResponse
  public var capabilities: ConfigurationJSON
  public var loadError: String?
  public var reload: () async -> Void
  public var resolve: (ComposableLaunchRequest) async throws -> EffectiveLaunchPreview
  public var launch: (ComposableLaunchRequest) async throws -> String
  public var save: (ConfigurationKind, ConfigurationWriteRequest) async throws -> ConfigurationDocument
  public var archive: (ConfigurationDocument) async throws -> Void
  public var discoverGitHubRepositories: () async throws -> [ConfigurationJSON]
  public var discoverGitHubWorkflows: (String) async throws -> [ConfigurationJSON]
  public var loadProviderAccounts: () async throws -> [PublicProviderAccountResponse]
  public var discoverPim: () async throws -> ConfigurationJSON
  public var saveFromLaunch: (ConfigurationJSON) async throws -> ConfigurationJSON
  public init(documents: [ConfigurationDocument], capabilities: ConfigurationJSON, loadError: String? = nil,
    reload: @escaping () async -> Void,
    resolve: @escaping (ComposableLaunchRequest) async throws -> EffectiveLaunchPreview,
    launch: @escaping (ComposableLaunchRequest) async throws -> String,
    save: @escaping (ConfigurationKind, ConfigurationWriteRequest) async throws -> ConfigurationDocument,
    archive: @escaping (ConfigurationDocument) async throws -> Void,
    discoverGitHubRepositories: @escaping () async throws -> [ConfigurationJSON],
    discoverGitHubWorkflows: @escaping (String) async throws -> [ConfigurationJSON],
    loadProviderAccounts: @escaping () async throws -> [PublicProviderAccountResponse],
    discoverPim: @escaping () async throws -> ConfigurationJSON,
    saveFromLaunch: @escaping (ConfigurationJSON) async throws -> ConfigurationJSON,
    listWatchers: @escaping () async throws -> [WatcherBindingResponse] = { throw DaemonError.badRequest("Issue watcher configuration is unavailable") },
    saveWatcher: @escaping (WatcherBindingWrite) async throws -> WatcherBindingResponse = { _ in throw DaemonError.badRequest("Issue watcher configuration is unavailable") },
    readLaunch: @escaping (String) async throws -> EffectiveLaunchPreview = { _ in throw DaemonError.badRequest("Source launch configuration is unavailable") }) {
    self.documents = documents; self.capabilities = capabilities; self.loadError = loadError; self.reload = reload
    self.resolve = resolve; self.launch = launch; self.save = save; self.archive = archive
    self.discoverGitHubRepositories = discoverGitHubRepositories; self.discoverGitHubWorkflows = discoverGitHubWorkflows
    self.loadProviderAccounts = loadProviderAccounts
    self.discoverPim = discoverPim; self.saveFromLaunch = saveFromLaunch
    self.listWatchers = listWatchers; self.saveWatcher = saveWatcher
    self.readLaunch = readLaunch
  }
  public func list(_ kind: ConfigurationKind) -> [ConfigurationDocument] {
    documents.filter { $0.kind == kind && !$0.archived }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }
}
