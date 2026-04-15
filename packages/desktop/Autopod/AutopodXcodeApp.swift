import SwiftUI
import AutopodUI
import AutopodClient
import AutopodDesktop

/// Xcode app target entry point — has real bundle ID, entitlements, and Edit menu.
@main
struct AutopodXcodeApp: App {
  @State private var connectionManager = ConnectionManager()
  @State private var sessionStore = SessionStore()
  @State private var profileStore = ProfileStore()
  @State private var memoryStore = MemoryStore()
  @State private var scheduledJobStore = ScheduledJobStore()
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
        memoryStore: memoryStore,
        scheduledJobStore: scheduledJobStore,
        actionHandler: actionHandler,
        eventStream: eventStream,
        terminalManager: terminalManager,
        showSetup: $showSetup
      )
      .onAppear {
        if connectionManager.connection == nil {
          showSetup = true
        }
        // Handle race: connection may already be established before onChange is registered
        if connectionManager.isConnected {
          wireUpConnection()
        }
        Task {
          await NotificationService.shared.requestPermission()
          NotificationService.shared.registerCategories()
        }
      }
      .onChange(of: connectionManager.isConnected) { _, connected in
        if connected {
          wireUpConnection()
        } else {
          eventStream?.disconnect()
          eventStream = nil
        }
      }
    }
    .windowStyle(.titleBar)
    .defaultSize(width: 1200, height: 700)
    .commands {
      TextEditingCommands()
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

  /// Configure stores and start streaming once the daemon connection is live.
  private func wireUpConnection() {
    guard let api = connectionManager.api,
          let conn = connectionManager.connection else { return }

    sessionStore.configure(api: api)
    profileStore.configure(api: api)
    memoryStore.configure(api: api)
    scheduledJobStore.configure(api: api)
    actionHandler = ActionHandler(api: api, sessionStore: sessionStore, profileStore: profileStore)

    let connToken = connectionManager.activeToken ?? ""
    terminalManager = TerminalManager(baseURL: conn.url, token: connToken)

    let stream = EventStream(
      sessionStore: sessionStore,
      memoryStore: memoryStore,
      scheduledJobStore: scheduledJobStore
    )
    stream.connect(baseURL: conn.url, token: connToken)
    eventStream = stream

    // Wire notification service for catchup actions
    NotificationService.shared.scheduledJobStore = scheduledJobStore

    Task {
      await sessionStore.loadSessions()
      await profileStore.loadProfiles()
      await scheduledJobStore.load()
    }
  }
}
