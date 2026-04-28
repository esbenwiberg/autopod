import SwiftUI
import AutopodUI
import AutopodClient
import AutopodDesktop

/// Xcode app target entry point — has real bundle ID, entitlements, and Edit menu.
@main
struct AutopodXcodeApp: App {
  @State private var connectionManager = ConnectionManager()
  @State private var podStore = PodStore()
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
        podStore: podStore,
        profileStore: profileStore,
        memoryStore: memoryStore,
        scheduledJobStore: scheduledJobStore,
        actionHandler: actionHandler,
        eventStream: eventStream,
        terminalManager: terminalManager,
        showSetup: $showSetup
      )
      .environment(\.controlActiveState, .key)
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
        pods: podStore.pods,
        actions: actionHandler?.actions ?? .preview
      )
    } label: {
      let count = podStore.attentionSessions.count
      Image(systemName: count > 0 ? "\(min(count, 50)).circle.fill" : "circle")
    }
    .menuBarExtraStyle(.window)
  }

  /// Configure stores and start streaming once the daemon connection is live.
  private func wireUpConnection() {
    guard let api = connectionManager.api,
          let conn = connectionManager.connection else { return }

    podStore.configure(api: api)
    profileStore.configure(api: api)
    memoryStore.configure(api: api)
    scheduledJobStore.configure(api: api)
    actionHandler = ActionHandler(api: api, podStore: podStore, profileStore: profileStore)

    let connToken = connectionManager.activeToken ?? ""
    terminalManager = TerminalManager(baseURL: conn.url, token: connToken)

    let stream = EventStream(
      podStore: podStore,
      memoryStore: memoryStore,
      scheduledJobStore: scheduledJobStore
    )
    stream.connect(baseURL: conn.url, token: connToken)
    eventStream = stream

    // Reload historical events for the currently selected pod — the EventStream was just
    // replaced, so its sessionEvents buffer is empty and the .task(id: selectedSessionId)
    // in AppRootView won't re-fire (selectedSessionId didn't change).
    if let selectedId = podStore.selectedSessionId {
      stream.loadHistoricalEvents(podId: selectedId, api: api)
    }

    // Wire notification service for catchup actions
    NotificationService.shared.scheduledJobStore = scheduledJobStore

    Task {
      await podStore.loadSessions()
      await profileStore.loadProfiles()
      await scheduledJobStore.load()
    }
  }
}
