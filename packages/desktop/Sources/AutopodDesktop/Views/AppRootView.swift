import SwiftUI
import AutopodUI
import AutopodClient

/// Root view that bridges stores into AutopodUI views.
public struct AppRootView: View {
  public let connectionManager: ConnectionManager
  public let sessionStore: SessionStore
  public let profileStore: ProfileStore
  public let actionHandler: ActionHandler?
  public let eventStream: EventStream?
  public let terminalManager: TerminalManager?
  @Binding public var showSetup: Bool

  public init(
    connectionManager: ConnectionManager,
    sessionStore: SessionStore,
    profileStore: ProfileStore,
    actionHandler: ActionHandler?,
    eventStream: EventStream?,
    terminalManager: TerminalManager?,
    showSetup: Binding<Bool>
  ) {
    self.connectionManager = connectionManager
    self.sessionStore = sessionStore
    self.profileStore = profileStore
    self.actionHandler = actionHandler
    self.eventStream = eventStream
    self.terminalManager = terminalManager
    self._showSetup = showSetup
  }

  @State private var showError = false
  @State private var showSettings = false

  public var body: some View {
    MainView(
      sessions: sessionStore.sessions,
      selectedSessionId: Binding(
        get: { sessionStore.selectedSessionId },
        set: { sessionStore.selectedSessionId = $0 }
      ),
      isConnected: connectionManager.isConnected,
      connectionLabel: connectionManager.connectionLabel,
      connectionState: connectionManager.state.label,
      isLoading: sessionStore.isLoading,
      actions: actionHandler?.actions ?? .preview,
      profileNames: profileStore.profileNames,
      sessionEvents: eventStream?.sessionEvents ?? [:],
      sessionDiffs: sessionStore.sessionDiffs,
      terminalState: terminalManager?.state ?? "disconnected",
      terminalDataPipe: terminalManager?.dataPipe,
      onTerminalSendData: { bytes in terminalManager?.sendData(bytes) },
      onTerminalResize: { cols, rows in terminalManager?.resize(cols: cols, rows: rows) },
      onTerminalConnect: { sessionId in terminalManager?.connect(sessionId: sessionId) },
      onTerminalDisconnect: { terminalManager?.disconnect() },
      onRefresh: {
        await sessionStore.loadSessions()
        await profileStore.loadProfiles()
      },
      onSelectSession: { sessionId in
        if let prev = sessionStore.selectedSessionId {
          eventStream?.unsubscribeFromSession(prev)
        }
        if let id = sessionId {
          eventStream?.subscribeToSession(id)
          Task { await sessionStore.loadDiff(id) }
        }
      },
      onShowSettings: {
        showSettings = true
      }
    )
    .alert("Error", isPresented: $showError) {
      Button("OK") { actionHandler?.clearError() }
    } message: {
      Text(actionHandler?.lastError ?? "Unknown error")
    }
    .onChange(of: actionHandler?.lastError) { _, err in
      if err != nil { showError = true }
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
        profileError: profileStore.error,
        onSaveProfile: { [profileStore] profile in
          Task {
            do {
              try await profileStore.saveProfile(profile)
            } catch {
              print("[AppRootView] Failed to save profile: \(error)")
              profileStore.error = error.localizedDescription
            }
          }
        },
        onCreateProfile: { [profileStore] profile in
          Task {
            do {
              try await profileStore.createProfile(profile)
            } catch {
              print("[AppRootView] Failed to create profile: \(error)")
              profileStore.error = error.localizedDescription
            }
          }
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
