import SwiftUI
import AutopodUI
import AutopodClient

@main
struct AutopodApp: App {
  @State private var connectionManager = ConnectionManager()
  @State private var sessionStore = SessionStore()
  @State private var profileStore = ProfileStore()
  @State private var actionHandler: ActionHandler?
  @State private var eventStream: EventStream?
  @State private var terminalManager: TerminalManager?
  @State private var showSetup = false

  var body: some Scene {
    WindowGroup {
      AppRootView(
        connectionManager: connectionManager,
        sessionStore: sessionStore,
        profileStore: profileStore,
        actionHandler: actionHandler,
        eventStream: eventStream,
        terminalManager: terminalManager,
        showSetup: $showSetup
      )
      .onAppear {
        if connectionManager.connection == nil {
          showSetup = true
        }
        Task {
          await NotificationService.shared.requestPermission()
          NotificationService.shared.registerCategories()
        }
      }
      .onChange(of: connectionManager.isConnected) { _, connected in
        if connected, let api = connectionManager.api, let conn = connectionManager.connection {
          sessionStore.configure(api: api)
          profileStore.configure(api: api)
          actionHandler = ActionHandler(api: api, sessionStore: sessionStore)
          Task {
            await sessionStore.loadSessions()
            await profileStore.loadProfiles()
          }

          // Terminal manager
          let connToken = KeychainHelper.load(for: conn.id) ?? ""
          terminalManager = TerminalManager(baseURL: conn.url, token: connToken)

          // Start event stream
          let token = connToken
          let stream = EventStream(sessionStore: sessionStore)
          stream.connect(baseURL: conn.url, token: token)
          eventStream = stream
        } else {
          eventStream?.disconnect()
          eventStream = nil
        }
      }
    }
    .windowStyle(.titleBar)
    .defaultSize(width: 1200, height: 700)
    .commands {
      // Required for text fields to work in SPM executables (no default Edit menu)
      CommandGroup(replacing: .textEditing) {}
    }

    MenuBarExtra {
      MenuBarView(
        sessions: sessionStore.sessions,
        actions: actionHandler?.actions ?? .preview
      )
    } label: {
      let count = sessionStore.attentionSessions.count
      Image(systemName: count > 0 ? "\(min(count, 50)).circle.fill" : "circle")
    }
    .menuBarExtraStyle(.window)
  }
}

/// Root view that bridges stores into AutopodUI views.
struct AppRootView: View {
  let connectionManager: ConnectionManager
  let sessionStore: SessionStore
  let profileStore: ProfileStore
  let actionHandler: ActionHandler?
  let eventStream: EventStream?
  let terminalManager: TerminalManager?
  @Binding var showSetup: Bool

  @State private var showError = false
  @State private var showSettings = false

  var body: some View {
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
      terminalOutput: terminalManager?.output ?? "",
      terminalState: terminalManager?.state ?? "disconnected",
      onTerminalInput: { text in terminalManager?.sendInput(text) },
      onTerminalConnect: { sessionId in terminalManager?.connect(sessionId: sessionId) },
      onTerminalDisconnect: { terminalManager?.disconnect() },
      onRefresh: {
        await sessionStore.loadSessions()
        await profileStore.loadProfiles()
      },
      onSelectSession: { sessionId in
        // Unsubscribe from previous, subscribe to new
        if let prev = sessionStore.selectedSessionId {
          eventStream?.unsubscribeFromSession(prev)
        }
        if let id = sessionId {
          eventStream?.subscribeToSession(id)
          // Load diff for the selected session
          Task { await sessionStore.loadDiff(id) }
        }
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
        isPresented: $showSettings
      )
    }
    .toolbar {
      ToolbarItem(placement: .automatic) {
        HStack(spacing: 12) {
          // Settings
          Button {
            showSettings = true
          } label: {
            Image(systemName: "gearshape")
          }
          .help("Settings")

          // Refresh button
          Button {
            Task { await sessionStore.loadSessions() }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .help("Refresh sessions")
          .disabled(!connectionManager.isConnected)

          // Connection indicator
          HStack(spacing: 5) {
            Circle()
              .fill(connectionManager.isConnected ? .green : .red)
              .frame(width: 7, height: 7)
            Text(connectionManager.connectionLabel)
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(.secondary)
            if let ws = eventStream?.connectionState, ws != "Connected" && ws != "Disconnected" {
              Text("(\(ws))")
                .font(.system(.caption2))
                .foregroundStyle(.orange)
            }
          }
          .onTapGesture { showSetup = true }
          .help(connectionManager.state.label)
        }
      }
    }
  }
}
