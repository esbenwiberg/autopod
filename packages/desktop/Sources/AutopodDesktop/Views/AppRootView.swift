import SwiftUI
import AutopodUI
import AutopodClient

/// Root view that bridges stores into AutopodUI views.
public struct AppRootView: View {
  public let connectionManager: ConnectionManager
  public let podStore: PodStore
  public let profileStore: ProfileStore
  public let memoryStore: MemoryStore
  public let scheduledJobStore: ScheduledJobStore
  public let actionHandler: ActionHandler?
  public let eventStream: EventStream?
  public let terminalManager: TerminalManager?
  @Binding public var showSetup: Bool

  public init(
    connectionManager: ConnectionManager,
    podStore: PodStore,
    profileStore: ProfileStore,
    memoryStore: MemoryStore,
    scheduledJobStore: ScheduledJobStore,
    actionHandler: ActionHandler?,
    eventStream: EventStream?,
    terminalManager: TerminalManager?,
    showSetup: Binding<Bool>
  ) {
    self.connectionManager = connectionManager
    self.podStore = podStore
    self.profileStore = profileStore
    self.memoryStore = memoryStore
    self.scheduledJobStore = scheduledJobStore
    self.actionHandler = actionHandler
    self.eventStream = eventStream
    self.terminalManager = terminalManager
    self._showSetup = showSetup
  }

  @State private var showError = false
  @State private var showSettings = false

  /// Only read events for the selected pod — avoids observing the entire dictionary
  /// and triggering full view recomputation on every agent event.
  private var selectedSessionEvents: [AgentEvent] {
    guard let id = podStore.selectedSessionId else { return [] }
    return eventStream?.sessionEvents[id] ?? []
  }

  private var selectedSessionIsLoadingLogs: Bool {
    guard let id = podStore.selectedSessionId else { return false }
    return eventStream?.historicalLoadState[id] == .some(.loading)
  }

  private var selectedSessionLogsError: String? {
    guard let id = podStore.selectedSessionId,
          let state = eventStream?.historicalLoadState[id] else { return nil }
    if case .failed(let msg) = state { return msg }
    return nil
  }

  public var body: some View {
    MainView(
      pods: podStore.pods,
      scheduledJobs: scheduledJobStore.jobs,
      selectedSessionId: Binding(
        get: { podStore.selectedSessionId },
        set: { podStore.selectedSessionId = $0 }
      ),
      isConnected: connectionManager.isConnected,
      connectionLabel: connectionManager.connectionLabel,
      connectionState: connectionManager.state.label,
      isLoading: podStore.isLoading,
      actions: actionHandler?.actions ?? .preview,
      profileNames: profileStore.profileNames,
      selectedSessionEvents: selectedSessionEvents,
      isLoadingLogs: selectedSessionIsLoadingLogs,
      logsLoadError: selectedSessionLogsError,
      onReloadLogs: {
        guard let id = podStore.selectedSessionId, let api = connectionManager.api else { return }
        eventStream?.loadHistoricalEvents(podId: id, api: api)
      },
      sessionDiffs: podStore.sessionDiffs,
      terminalState: terminalManager?.state ?? "disconnected",
      terminalDataPipe: terminalManager?.dataPipe,
      onTerminalSendData: { bytes in terminalManager?.sendData(bytes) },
      onTerminalResize: { cols, rows in terminalManager?.resize(cols: cols, rows: rows) },
      onTerminalConnect: { podId in terminalManager?.connect(podId: podId) },
      onTerminalDisconnect: { terminalManager?.disconnect() },
      onRefresh: {
        await podStore.loadSessions()
        await profileStore.loadProfiles()
      },
      onSelectSession: { podId in
        if let prev = podStore.selectedSessionId {
          eventStream?.unsubscribeFromSession(prev)
        }
        if let id = podId {
          eventStream?.subscribeToSession(id)
          Task { await podStore.loadDiff(id) }
          if let api = connectionManager.api {
            eventStream?.loadHistoricalEvents(podId: id, api: api)
          }
        }
      },
      onRefreshDiff: { podId in
        Task { await podStore.loadDiff(podId) }
      },
      onShowSettings: {
        showSettings = true
      },
      loadFiles: { [connectionManager] (id: String) in
        guard let api = connectionManager.api else { throw URLError(.notConnectedToInternet) }
        return try await api.listSessionFiles(id)
      },
      loadContent: { [connectionManager] (id: String, path: String) in
        guard let api = connectionManager.api else { throw URLError(.notConnectedToInternet) }
        return try await api.getSessionFileContent(id, path: path)
      },
      loadQuality: { [connectionManager] (id: String) in
        guard let api = connectionManager.api else { throw URLError(.notConnectedToInternet) }
        return try await api.getPodQuality(id)
      },
      loadQualityScores: { [connectionManager] in
        guard let api = connectionManager.api else { throw URLError(.notConnectedToInternet) }
        return try await api.listQualityScores()
      },
      onRunCatchup: { job in Task { try? await scheduledJobStore.runCatchup(job.id) } },
      onSkipCatchup: { job in Task { try? await scheduledJobStore.skipCatchup(job.id) } },
      onTriggerJob: { job in Task { try? await scheduledJobStore.triggerJob(job.id) } },
      onCreateJob: { req in Task { try? await scheduledJobStore.createJob(req) } },
      onEditJob: { id, req in Task { try? await scheduledJobStore.updateJob(id, req) } },
      onDeleteJob: { job in Task { try? await scheduledJobStore.deleteJob(job.id) } },
      memoryEntries: memoryStore.entries,
      pendingMemoryCount: memoryStore.pendingCount,
      onApproveMemory: { id in Task { await memoryStore.approve(id) } },
      onRejectMemory: { id in Task { await memoryStore.reject(id) } },
      onDeleteMemory: { id in Task { await memoryStore.delete(id) } },
      onEditMemory: { id, content in Task { await memoryStore.update(id, content: content) } },
      onCreateMemory: { scope, scopeId, path, content in
        Task { await memoryStore.create(scope: scope, scopeId: scopeId, path: path, content: content) }
      },
      onLoadMemories: { await memoryStore.loadMemories() }
    )
    .task(id: podStore.selectedSessionId) {
      // Fires on initial appear AND whenever the selected pod changes.
      // `.onChange` (used by onSelectSession) doesn't fire on mount, so a pod
      // that's already selected at launch would never trigger the historical fetch.
      guard let id = podStore.selectedSessionId, let api = connectionManager.api else { return }
      eventStream?.loadHistoricalEvents(podId: id, api: api)
    }
    .alert("Error", isPresented: $showError) {
      Button("OK") { actionHandler?.clearError() }
    } message: {
      Text(actionHandler?.lastError ?? "Unknown error")
    }
    .onChange(of: actionHandler?.lastError) { old, new in
      if new != nil, new != old { showError = true }
    }
    .sheet(isPresented: $showSetup) {
      SetupSheet(
        isPresented: $showSetup,
        connectionManager: connectionManager
      )
    }
    .sheet(isPresented: $showSettings) {
      SettingsView(
        connectionManager: connectionManager,
        profiles: profileStore.profiles,
        actionCatalog: profileStore.actionCatalog,
        profileError: profileStore.error,
        onSaveProfile: { [profileStore] profile in
          try await profileStore.saveProfile(profile)
        },
        onCreateProfile: { [profileStore] profile in
          try await profileStore.createProfile(profile)
        },
        onAuthenticateProfile: { [connectionManager, profileStore] (name: String, provider: String, completion: @escaping (String?) -> Void) in
          guard let api = connectionManager.api else {
            completion("Not connected to daemon")
            return
          }
          let authenticator = ProfileAuthenticator(api: api)
          Task {
            do {
              let msg: String
              switch provider {
              case "max":
                msg = try await authenticator.authenticateMax(profileName: name)
              case "copilot":
                msg = try await authenticator.authenticateCopilot(profileName: name)
              default:
                completion("Unknown provider: \(provider)")
                return
              }
              print("[AppRootView] \(msg)")
              await profileStore.loadProfiles()
              await MainActor.run { completion(nil) }
            } catch {
              print("[AppRootView] Auth failed: \(error)")
              await MainActor.run { completion(error.localizedDescription) }
            }
          }
        },
        onLoadProfileEditor: { [connectionManager] name in
          guard let api = connectionManager.api else {
            throw DaemonError.networkError("Not connected to daemon")
          }
          return try await api.getProfileEditor(name)
        },
        onSaveProfileWithInheritance: { [profileStore] profile, current, initial, mergeStrategy in
          try await profileStore.saveProfileWithInheritance(
            profile,
            currentInherited: current,
            initialInherited: initial,
            mergeStrategy: mergeStrategy
          )
        },
        onCreateProfileWithInheritance: { [profileStore] profile, current, mergeStrategy in
          try await profileStore.createProfileWithInheritance(
            profile,
            currentInherited: current,
            mergeStrategy: mergeStrategy
          )
        },
        onDeleteProfile: { [profileStore] name in
          try await profileStore.deleteProfile(name)
        },
        isPresented: $showSettings
      )
    }
    .onChange(of: showSettings) { _, isShowing in
      if isShowing {
        Task { await profileStore.loadProfiles() }
      }
    }
  }
}
