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

          let connToken = KeychainHelper.load(for: conn.id) ?? ConnectionStore.loadToken(for: conn.id) ?? ""
          terminalManager = TerminalManager(baseURL: conn.url, token: connToken)

          let stream = EventStream(sessionStore: sessionStore)
          stream.connect(baseURL: conn.url, token: connToken)
          eventStream = stream

          Task {
            await sessionStore.loadSessions()
            await profileStore.loadProfiles()
          }
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
}
