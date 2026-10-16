import AppKit
import SwiftUI
import Testing
import AutopodDesktop
import AutopodUI

@MainActor private final class DecisionMountProbe { var appearances = 0 }

/// This host remains mounted while production EventStream/PodStore mutate its Pod.
/// No replacement rootView, custom decision renderer, or application startup.
@MainActor private struct DecisionDetailHost: View {
  let fixture: DecisionIdentityFixture
  let actions: PodActions
  let probe: DecisionMountProbe
  @State private var tab: DetailTab? = .overview

  var body: some View {
    if let pod = fixture.store.selectedSession {
      DetailPanelView(pod: pod, events: [], actions: actions, selectedTab: $tab)
        .onAppear { probe.appearances += 1 }
    }
  }
}

@MainActor private func decisionAX(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}

@MainActor private func decisionNodes(_ root: NSObject) -> [NSObject] {
  [root] + (decisionAX(root, "accessibilityChildren") as? [NSObject] ?? []).flatMap { decisionNodes($0) }
}

@MainActor private final class DecisionRenderWindow {
  let hosting: NSHostingView<AnyView>
  let window: NSWindow
  let handler: ActionHandler
  let probe = DecisionMountProbe()
  let suite = "autopod-decision-render-\(UUID().uuidString)"
  let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
  let oldEnhanced: Any?
  let width: CGFloat

  init(_ fixture: DecisionIdentityFixture, width: CGFloat) {
    self.width = width
    handler = ActionHandler(api: fixture.rest.apiA, podStore: fixture.store, profileStore: ProfileStore())
    var actions = handler.actions
    let prepare = actions.decisionReply.prepare
    actions.decisionReply.prepare = { id in
      await fixture.rest.track(Task { await prepare(id) }).value
    }
    NSApplication.shared.finishLaunching()
    oldEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    hosting = NSHostingView(rootView: AnyView(DecisionDetailHost(fixture: fixture, actions: actions, probe: probe)
      .defaultAppStorage(UserDefaults(suiteName: suite)!)
      .transaction { $0.disablesAnimations = true }))
    hosting.sizingOptions = []
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 760),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.appearance = NSAppearance(named: .darkAqua)
    window.orderFront(nil)
  }

  func close() {
    window.contentView = nil
    window.close()
    UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
    NSApplication.shared.accessibilitySetValue(oldEnhanced ?? false, forAttribute: enhanced)
  }

  var nodes: [NSObject] {
    window.layoutIfNeeded()
    hosting.layoutSubtreeIfNeeded()
    hosting.displayIfNeeded()
    return decisionNodes(hosting)
  }

  func text(_ node: NSObject) -> String {
    ["accessibilityLabel", "accessibilityValue"].compactMap { decisionAX(node, $0) as? String }.joined(separator: " ")
  }

  func verifyAndCapture(_ decision: String, stage: String) async throws {
    let expected = ["Question \(decision)?", "\(decision) first", "\(decision) second"]
    try await decisionWait {
      let text = self.nodes.map { self.text($0) }.joined(separator: "\n")
      return expected.allSatisfy { text.contains($0) }
    }
    let nodes = nodes
    let allText = nodes.map { text($0) }.joined(separator: "\n")
    #expect(!allText.contains("Question A?"))
    if decision == "C" { #expect(!allText.contains("Question B?")) }
    #expect(probe.appearances == 1)
    #expect(hosting.bounds.width == width && hosting.bounds.height == 760)
    let visible = window.convertToScreen(hosting.convert(hosting.bounds, to: nil))
    for label in expected {
      let node = try #require(nodes.first { text($0).contains(label) })
      let frame = try #require(decisionAX(node, "accessibilityFrame") as? NSValue).rectValue
      #expect(frame.width > 0 && frame.height > 0)
      #expect(visible.insetBy(dx: -1, dy: -1).contains(frame))
    }
    guard let directory = ProcessInfo.processInfo.environment["AUTOPOD_DECISION_RENDER_DIR"] else { return }
    let url = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    let name = "detail\(Int(width))-\(stage)"
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: url.appendingPathComponent(name + ".png"))
    let rows = nodes.map { "\(text($0)) | frame=\(decisionAX($0, "accessibilityFrame") ?? "-")" }
    try (["mounts=\(probe.appearances) bounds=\(hosting.bounds)"] + rows).joined(separator: "\n")
      .write(to: url.appendingPathComponent(name + ".ax.txt"), atomically: true, encoding: .utf8)
  }
}

@MainActor @Suite(.serialized) struct DecisionIdentityRenderingTests {
  @Test(arguments: [600, 900]) func mountedDetailRetainsCurrentDecision(width: Int) async throws {
    try await withDecisionIdentityFixture { f in
      let task = f.rest.start { await f.store.refreshSession(f.id) }
      let held = try await f.rest.next(f.rest.a, "/pods/decision")
      try await f.created("B")
      let view = DecisionRenderWindow(f, width: CGFloat(width))
      defer { view.close() }
      try await view.verifyAndCapture("B", stage: "current-B")
      let staleResolutionRefresh = try await f.resolved("A")
      held.respond(body: try decisionSnapshot("A"))
      _ = await task.value
      staleResolutionRefresh.fail(URLError(.cannotConnectToHost))
      try f.expectDecision("B")
      #expect(f.store.selectedSession?.status == .awaitingInput)
      try await view.verifyAndCapture("B", stage: "after-stale-A")
      let reconciliation = try await f.resolved("B")
      try f.expectDecision(nil)
      #expect(f.store.selectedSession?.status == .awaitingInput)
      // R04f's mounted unknown composer performs its own result-bearing detail
      // preparation. Hold it independently of EventStream reconciliation.
      let preparation = try await f.rest.next(f.rest.a, "/pods/decision")
      reconciliation.respond(body: try decisionSnapshot("C"))
      try await decisionWait { f.store.selectedSession?.escalationId == "C" }
      try await view.verifyAndCapture("C", stage: "reconciled-C")
      preparation.fail(URLError(.cannotConnectToHost))
      try f.expectDecision("C")
      #expect(f.rest.a.requests.count == 4)
      #expect(f.rest.a.requests.allSatisfy { $0.httpMethod == "GET" && $0.url?.path == "/pods/decision" })
      #expect(f.notifications.values == ["decision:Question B?"])
      print("DECISION_RENDER width=\(width) mounts=\(view.probe.appearances) GET=4 stages=B,retained-B,C")
    }
  }
}
