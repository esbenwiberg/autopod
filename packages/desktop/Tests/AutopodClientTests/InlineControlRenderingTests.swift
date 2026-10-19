import AppKit
import SwiftUI
import Testing
import AutopodDesktop
import AutopodUI

/// Production compositions with real wired actions. The host never reads pendingControl:
/// its updates must be observed by the production view, without remounting the host.
@MainActor private struct InlineControlHost: View {
  let fixture: ConfirmedActionFixture
  let actions: PodActions
  let surface: String
  @State private var tab: DetailTab? = .overview

  var body: some View {
    if let pod = fixture.store.selectedSession {
      switch surface {
      case "compact", "detailed":
        SessionCardFinal(pod: pod, actions: actions, density: surface == "compact" ? .compact : .detailed)
          .padding(8)
      case "series":
        SeriesPipelineView(pods: [pod], panelEnabled: true, actions: actions)
      case "main":
        MainView(pods: fixture.store.pods, selectedSessionId: .constant(fixture.id),
          connectionLabel: "Isolated rendering fixture", actions: actions, profileNames: [])
      default:
        DetailPanelView(pod: pod, events: [], actions: actions, selectedTab: $tab)
      }
    }
  }
}

// SwiftUI AccessibilityNode implements these public AppKit selectors without declaring
// NSAccessibilityProtocol conformance. KVC boxes the native BOOL/frame getters safely.
@MainActor private func inlineAX(_ element: NSObject, _ key: String) -> Any? {
  guard element.responds(to: NSSelectorFromString(key))
    || element.responds(to: NSSelectorFromString("is" + key.prefix(1).uppercased() + key.dropFirst())) else { return nil }
  return element.value(forKey: key)
}

@MainActor private func inlineElements(_ root: NSObject) -> [NSObject] {
  let children = inlineAX(root, "accessibilityChildren") as? [NSObject] ?? []
  return [root] + children.flatMap { inlineElements($0) }
}

@MainActor private final class InlineRenderWindow {
  let hosting: NSHostingView<AnyView>
  let window: NSWindow
  let surface: String
  let viewport: NSSize
  let suite = "autopod-inline-render-\(UUID().uuidString)"
  let oldEnhanced: Any?
  let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")

  init(_ fixture: ConfirmedActionFixture, surface: String, width: CGFloat) {
    self.surface = surface
    viewport = NSSize(width: width, height: surface == "compact" ? 180 : surface == "detailed" ? 320 : surface == "main" ? 800 : 760)
    NSApplication.shared.finishLaunching()
    oldEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    let defaults = UserDefaults(suiteName: suite)!
    hosting = NSHostingView(rootView: AnyView(InlineControlHost(fixture: fixture,
      actions: fixture.handler.actions, surface: surface).defaultAppStorage(defaults)
      // Snapshots prove settled presentation, not animation timing.
      .transaction { $0.disablesAnimations = true }))
    hosting.sizingOptions = []
    window = NSWindow(contentRect: NSRect(origin: .zero, size: viewport),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.appearance = NSAppearance(named: .darkAqua)
    window.orderFront(nil)
  }

  func close() {
    for sheet in window.sheets { window.endSheet(sheet); sheet.close() }
    window.contentView = nil
    window.close()
    UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
    NSApplication.shared.accessibilitySetValue(oldEnhanced ?? false, forAttribute: enhanced)
  }

  var elements: [NSObject] {
    window.layoutIfNeeded()
    hosting.layoutSubtreeIfNeeded()
    hosting.displayIfNeeded()
    return inlineElements(hosting)
  }

  func identified(_ id: String) -> [NSObject] {
    elements.filter { inlineAX($0, "accessibilityIdentifier") as? String == id }
  }

  func text(_ element: NSObject) -> String {
    ["accessibilityLabel", "accessibilityValue"].compactMap { inlineAX(element, $0) as? String }.joined(separator: " ")
  }

  func wait(_ fixture: ConfirmedActionFixture, pending: PendingPodControl?, status: PodStatus) async throws {
    try await inlineWait {
      let nodes = self.elements
      let notices = nodes.filter { inlineAX($0, "accessibilityIdentifier") as? String == "pod-control-notice-\(fixture.id)" }
      let noticeMatches = pending.map { kind in notices.contains { self.text($0).contains(kind.notice) } } ?? notices.isEmpty
      let statusMatches = nodes.contains { self.text($0).contains(status.label) }
      return noticeMatches && statusMatches
    }
    #expect(hosting.bounds.width == viewport.width)
    // This native MainView host measures taller than the requested content size.
    // Record its actual bounds; this test does not establish the cause.
    if surface != "main" { #expect(hosting.bounds.height == viewport.height) }
    else { #expect(hosting.bounds.height >= viewport.height) }
    #expect(fixture.store.selectedSession?.status == status)
    if pending != nil {
      let visible = window.convertToScreen(hosting.convert(hosting.bounds, to: nil))
      for notice in identified("pod-control-notice-\(fixture.id)") {
        let frame = try #require(inlineAX(notice, "accessibilityFrame") as? NSValue).rectValue
        #expect(frame.width > 0 && frame.height > 0)
        #expect(visible.insetBy(dx: -1, dy: -1).contains(frame))
      }
      for kind in ["pause", "kill", "delete"] {
        for button in identified("pod-control-\(kind)-\(fixture.id)") {
          #expect(inlineAX(button, "accessibilityEnabled") as? Bool == false)
        }
      }
      if surface.hasPrefix("detail") || surface == "main" || surface == "series" || surface == "detailed" {
        // A running surface must expose at least one real disabled control.
        if status == .running {
          #expect(!identified("pod-control-pause-\(fixture.id)").isEmpty)
        }
      }
    }
  }

  func press(_ node: NSObject) throws {
    #expect(inlineAX(node, "accessibilityEnabled") as? Bool == true)
    // Native alert proxies may return false despite dispatching their action. The
    // held transport request below, rather than this return value, proves activation.
    #expect(node.responds(to: NSSelectorFromString("accessibilityPerformPress")))
    _ = inlineAX(node, "accessibilityPerformPress")
  }

  func capture(_ name: String) async throws {
    guard let directory = ProcessInfo.processInfo.environment["AUTOPOD_INLINE_RENDER_DIR"] else { return }
    let url = URL(fileURLWithPath: directory, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
    try #require(bitmap.representation(using: .png, properties: [:])).write(to: url.appendingPathComponent(name + ".png"))
    let rows = elements.map { node in
      "\(inlineAX(node, "accessibilityIdentifier") ?? "-") | \(text(node)) | enabled=\(inlineAX(node, "accessibilityEnabled") ?? "-") | frame=\(inlineAX(node, "accessibilityFrame") ?? "-")"
    }
    try (["bounds=\(hosting.bounds)"] + rows).joined(separator: "\n").write(to: url.appendingPathComponent(name + ".ax.txt"), atomically: true, encoding: .utf8)
  }
}

@Suite(.serialized) @MainActor struct InlineControlRenderingTests {
  @Test(arguments: ["detail900", "detail600", "compact", "detailed"])
  func inlineRendersMountedControls(surface: String) async throws {
    for action in ConfirmedAction.allCases {
      for rejected in [false, true] {
        try await withConfirmedActionFixture { f in
          let width: CGFloat = surface == "detail900" ? 900 : surface == "detail600" ? 600 : 276
          let view = InlineRenderWindow(f, surface: surface, width: width)
          defer { view.close() }
          try await view.wait(f, pending: nil, status: .running)
          if action == .pause && !rejected { try await view.capture(surface + "-initial") }
          let task = f.start(action)
          let post = try await f.next("POST", action: action)
          let kind: PendingPodControl = action == .pause ? .pause : .kill
          try await view.wait(f, pending: kind, status: .running)
          if !rejected { try await view.capture(surface + "-" + action.rawValue + "-pending") }
          if rejected {
            post.respond(status: 409, body: #"{"error":"control rejected"}"#)
          } else {
            post.respond(body: #"{"ok":true}"#)
            let get = try await f.next("GET")
            try await view.wait(f, pending: kind, status: .running)
            get.respond(body: f.snapshot(status: action == .pause ? .paused : .killed))
          }
          await task.value
          let status: PodStatus = rejected ? .running : action == .pause ? .paused : .killed
          try await view.wait(f, pending: nil, status: status)
          try await view.capture(surface + "-" + action.rawValue + (rejected ? "-rejected" : "-confirmed"))
          #expect((f.handler.lastError != nil) == rejected)
        }
      }
    }
  }

  @Test(arguments: ["series", "main"])
  func inlineRendersComposedPause(surface: String) async throws {
    try await withConfirmedActionFixture { f in
      let view = InlineRenderWindow(f, surface: surface, width: surface == "main" ? 1400 : 900)
      defer { view.close() }
      if surface == "series" {
        try await inlineWait { view.elements.contains { view.text($0).contains(f.store.selectedSession!.task) && inlineAX($0, "accessibilityRole") as? String == "AXButton" } }
        let node = try #require(view.elements.first { view.text($0).contains(f.store.selectedSession!.task) && inlineAX($0, "accessibilityRole") as? String == "AXButton" })
        try view.press(node)
      }
      try await view.wait(f, pending: nil, status: .running)
      try await inlineWait { !view.identified("pod-control-pause-\(f.id)").isEmpty }
      try await view.capture(surface + "-initial")
      // Exercise the actual production button, including MainView's copied actions.
      try view.press(try #require(view.identified("pod-control-pause-\(f.id)").last))
      let post = try await f.next("POST", action: .pause)
      try await view.wait(f, pending: .pause, status: .running)
      try await view.capture(surface + "-pause-pending")
      post.respond(body: #"{"ok":true}"#)
      let get = try await f.next("GET")
      try await view.wait(f, pending: .pause, status: .running)
      get.respond(body: f.snapshot(status: .paused))
      try await inlineWait { f.handler.pendingControl(f.id) == nil }
      try await view.wait(f, pending: nil, status: .paused)
      try await view.capture(surface + "-pause-confirmed")
      #expect(f.peer.requests.count == 2)
    }
  }

  @Test(arguments: ["compact", "detailed"])
  func inlineContextMenuAndDeleteConfirmation(surface: String) async throws {
    try await withConfirmedActionFixture { f in
      let view = InlineRenderWindow(f, surface: surface, width: 276)
      defer { view.close() }
      try await view.wait(f, pending: nil, status: .running)
      @MainActor func menu() throws -> NSMenu {
        let event = try #require(NSEvent.mouseEvent(with: .rightMouseDown,
          location: NSPoint(x: 100, y: view.hosting.bounds.midY), modifierFlags: [], timestamp: 0,
          windowNumber: view.window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1))
        return try #require(view.hosting.menu(for: event))
      }
      let initial = try menu()
      let killIndex = try #require(initial.items.firstIndex { $0.title == "Kill" })
      #expect(initial.items[killIndex].isEnabled)
      initial.performActionForItem(at: killIndex)
      let kill = try await f.next("POST", action: .kill)
      try await view.wait(f, pending: .kill, status: .running)
      let busy = try menu()
      #expect(try #require(busy.items.first { $0.title == "Killing…" }).isEnabled == false)
      #expect(try #require(busy.items.first { $0.title == "Delete" }).isEnabled == false)
      kill.respond(status: 409, body: #"{"error":"context kill rejected"}"#)
      try await inlineWait { f.handler.pendingControl(f.id) == nil }
      try await view.wait(f, pending: nil, status: .running)
      let deletion = try menu()
      deletion.performActionForItem(at: try #require(deletion.items.firstIndex { $0.title == "Delete" }))
      try await inlineWait { !view.window.sheets.isEmpty }
      let sheet = try #require(view.window.sheets.first)
      let confirm = try #require(inlineElements(sheet).first { inlineAX($0, "accessibilityIdentifier") as? String == "pod-control-delete-confirm-\(f.id)" })
      #expect(view.text(confirm) == "Kill and delete")
      if let directory = ProcessInfo.processInfo.environment["AUTOPOD_INLINE_RENDER_DIR"] {
        let content = try #require(sheet.contentView)
        content.layoutSubtreeIfNeeded()
        let bitmap = try #require(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: bitmap)
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent(surface + "-delete-confirmation.png"))
      }
      try view.press(confirm)
      let combinedKill = try await f.next("POST", action: .kill)
      try await view.wait(f, pending: .killAndDelete, status: .running)
      combinedKill.respond(body: #"{"ok":true}"#)
      try await f.next("GET").respond(body: f.snapshot(status: .killed))
      let combinedDelete = try await f.next("DELETE")
      try await view.wait(f, pending: .killAndDelete, status: .killed)
      #expect(try #require(try menu().items.first { $0.title == "Delete" }).isEnabled == false)
      combinedDelete.respond(status: 409, body: #"{"error":"deletion rejected"}"#)
      try await inlineWait { f.handler.pendingControl(f.id) == nil }
      try await view.wait(f, pending: nil, status: .killed)
      #expect(f.peer.requests.count == 4)
    }
  }

  @Test(arguments: ["detail900", "detail600"])
  func inlineDetailKeepsDeleteDisabled(surface: String) async throws {
    for combined in [false, true] {
      try await withConfirmedActionFixture { f in
        let view = InlineRenderWindow(f, surface: surface, width: surface == "detail900" ? 900 : 600)
        defer { view.close() }
        try await view.wait(f, pending: nil, status: .running)
        let task = f.start {
          if combined { await f.handler.actions.killAndDelete(f.id) }
          else { await f.handler.actions.pause(f.id) }
        }
        let post = try await f.next("POST", action: combined ? .kill : .pause)
        let held: ConfirmedActionRequest
        if combined {
          post.respond(body: #"{"ok":true}"#)
          try await f.next("GET").respond(body: f.snapshot(status: .killed))
          held = try await f.next("DELETE")
        } else {
          // A newer server event may make Delete eligible while Pause is still held.
          f.store.updateStatus(f.id, to: .killed)
          held = post
        }
        try await view.wait(f, pending: combined ? .killAndDelete : .pause, status: .killed)
        let button = try #require(view.elements.first {
          view.text($0) == "Delete" && inlineAX($0, "accessibilityRole") as? String == "AXButton"
        })
        #expect(inlineAX(button, "accessibilityEnabled") as? Bool == false)
        let prefix = surface + (combined ? "-combined-delete" : "-newer-killed")
        try await view.capture(prefix + "-pending")
        held.respond(status: 409, body: #"{"error":"operation rejected"}"#)
        await task.value
        try await view.wait(f, pending: nil, status: .killed)
        let enabled = try #require(view.elements.first {
          view.text($0) == "Delete" && inlineAX($0, "accessibilityRole") as? String == "AXButton"
        })
        #expect(inlineAX(enabled, "accessibilityEnabled") as? Bool == true)
        try await view.capture(prefix + "-rejected")
      }
    }
  }

  @Test func inlineCardKeepsDeleteDisabledThroughCombinedWorkflow() async throws {
    try await withConfirmedActionFixture { f in
      let view = InlineRenderWindow(f, surface: "detailed", width: 276)
      defer { view.close() }
      try await view.wait(f, pending: nil, status: .running)
      let task = f.start { await f.handler.actions.killAndDelete(f.id) }
      let post = try await f.next("POST", action: .kill)
      try await view.wait(f, pending: .killAndDelete, status: .running)
      try await view.capture("combined-kill-pending")
      post.respond(body: #"{"ok":true}"#)
      try await f.next("GET").respond(body: f.snapshot(status: .killed))
      let deletion = try await f.next("DELETE")
      try await view.wait(f, pending: .killAndDelete, status: .killed)
      let button = try #require(view.identified("pod-control-delete-\(f.id)").first)
      #expect(inlineAX(button, "accessibilityEnabled") as? Bool == false)
      try await view.capture("combined-delete-pending")
      deletion.respond(status: 409, body: #"{"error":"deletion rejected"}"#)
      await task.value
      try await view.wait(f, pending: nil, status: .killed)
      #expect(inlineAX(try #require(view.identified("pod-control-delete-\(f.id)").first), "accessibilityEnabled") as? Bool == true)
      try await view.capture("combined-delete-rejected")
    }
  }
}
