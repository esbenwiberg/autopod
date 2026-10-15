import AppKit
import SwiftUI
import Testing
import AutopodClient
import AutopodDesktop
import AutopodUI

@MainActor @Observable private final class ConnectionRenderModel {
  let store: PodStore
  var handler: ActionHandler
  var connected = true
  var label = "Synthetic connection A"
  init(_ fixture: PodStoreLifetimeFixture) {
    store = fixture.store
    handler = ActionHandler(api: fixture.apiA, podStore: store, profileStore: ProfileStore())
  }
}

@MainActor private struct ConnectionMainHost: View {
  let model: ConnectionRenderModel
  var body: some View {
    MainView(pods: model.store.pods,
      selectedSessionId: Binding(get: { model.store.selectedSessionId }, set: { model.store.selectedSessionId = $0 }),
      isConnected: model.connected, connectionLabel: model.label,
      connectionState: model.connected ? "Connected" : "Disconnected",
      isLoading: model.store.isLoading, actions: model.handler.actions,
      profileNames: [], sessionDiffs: model.store.sessionDiffs, qualityScores: model.store.qualityScores)
  }
}

@MainActor private func connectionAX(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func connectionNodes(_ node: NSObject) -> [NSObject] {
  [node] + (connectionAX(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(connectionNodes)
}

@MainActor private final class ConnectionRenderWindow {
  let hosting: NSHostingView<AnyView>
  let window: NSWindow
  let suite = "autopod-connection-render-\(UUID())"
  let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
  let oldEnhanced: Any?
  init(_ model: ConnectionRenderModel) {
    NSApplication.shared.finishLaunching()
    oldEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    hosting = NSHostingView(rootView: AnyView(ConnectionMainHost(model: model)
      .defaultAppStorage(UserDefaults(suiteName: suite)!)
      .environment(\.colorScheme, .dark)
      .transaction { $0.disablesAnimations = true }))
    hosting.sizingOptions = []
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1450, height: 760),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.appearance = NSAppearance(named: .darkAqua)
    window.orderFront(nil)
  }
  func close() {
    window.contentView = nil; window.close()
    UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
    NSApplication.shared.accessibilitySetValue(oldEnhanced ?? false, forAttribute: enhanced)
  }
  var rows: [String] {
    window.layoutIfNeeded(); hosting.layoutSubtreeIfNeeded(); hosting.displayIfNeeded()
    return connectionNodes(hosting).map { node in
      ["accessibilityLabel", "accessibilityValue"].compactMap { connectionAX(node, $0) as? String }.joined(separator: " ")
    }
  }
  func capture(_ stage: String, decision: String?) async throws {
    try await connectionWait {
      let text = self.rows.joined(separator: "\n")
      if let decision { return text.contains("Question \(decision)?") && text.contains("\(decision) first") }
      return !text.contains("Question A?") && !text.contains("A first") && text.contains("Select a pod")
    }
    let text = rows.joined(separator: "\n")
    if decision != "A" { #expect(!text.contains("Question A?") && !text.contains("A first")) }
    #expect(hosting.bounds.width == 1450 && hosting.bounds.height >= 760)
    // NavigationSplitView may extend the content by its native toolbar height.
    try await Task.sleep(for: .milliseconds(150))
    guard let directory = ProcessInfo.processInfo.environment["AUTOPOD_CONNECTION_RENDER_DIR"] else { return }
    let folder = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: folder.appendingPathComponent(stage + ".png"))
    try ("bounds=\(hosting.bounds)\n" + text).write(to: folder.appendingPathComponent(stage + ".ax.txt"), atomically: true, encoding: .utf8)
  }
}

@MainActor @Suite(.serialized) struct ConnectionOwnershipRenderingTests {
  @Test func mountedProductionFleetAndDetailRespectSourceBoundary() async throws {
    try await withPodStoreLifetimeFixture { f in
      let id = UUID()
      f.store.configure(api: f.apiA, connectionID: id)
      f.store.upsertSession(try decisionPod("A")); f.store.selectedSessionId = "decision"
      let model = ConnectionRenderModel(f)
      let view = ConnectionRenderWindow(model)
      defer { view.close() }
      try await view.capture("01-selected-A", decision: "A")
      f.store.disconnect(); model.connected = false
      try await view.capture("02-disconnected-retains-A", decision: "A")
      let reconnectAPI = f.additionalAPI(for: f.a)
      f.store.configure(api: reconnectAPI, connectionID: id); model.connected = true
      model.handler = ActionHandler(api: reconnectAPI, podStore: f.store, profileStore: ProfileStore())
      try await view.capture("03-same-source-retains-A", decision: "A")
      f.store.configure(api: f.apiB, connectionID: UUID())
      model.handler = ActionHandler(api: f.apiB, podStore: f.store, profileStore: ProfileStore())
      model.label = "Synthetic connection B"
      #expect(f.store.pods.isEmpty && f.store.selectedSessionId == nil)
      try await view.capture("04-different-source-clears-A", decision: nil)
      let load = f.start { await f.store.refreshSession("decision") }
      try await f.next(f.b, "/pods/decision").respond(body: try decisionSnapshot("B"))
      _ = await load.value
      f.store.selectedSessionId = "decision"
      try await view.capture("05-selected-B-same-pod-ID", decision: "B")
      #expect(f.a.requests.isEmpty && f.b.requests.count == 1)
      print("CONNECTION_RENDER production MainView/Detail: A, disconnected A, reconnect A, empty B, same-ID B; private GET=1")
    }
  }
}
