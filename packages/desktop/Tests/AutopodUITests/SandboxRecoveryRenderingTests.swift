import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Suite(.serialized) struct SandboxRecoveryRenderingTests {
  @Test(arguments: ["retained", "empty", "unavailable"])
  func recoveryCardObservesOnFirstAppearanceWithoutAutomaticDispatch(scenario: String) async throws {
    let resource = #"{"sandboxId":"sandbox","resourceKey":"provider/sandbox","providerState":"stopped","observedAt":"2026-11-01T16:30:00Z","pendingIntentIds":["original-wakeup"],"startBlocked":"Original resume outcome is unknown."}"#
    let json = """
      {"podId":"insufficient-takin","generation":2,"resources":[\(scenario == "retained" ? resource : "")],"operations":[],"wakeups":[]}
      """
    let state = try JSONDecoder().decode(SandboxRecoveryState.self, from: Data(json.utf8))
    var observations = 0
    var mutations = 0
    let actions = SandboxRecoveryActions(scope: "card-fixture", load: { id in
      #expect(id == state.podId)
      observations += 1
      if scenario == "unavailable" { throw DaemonError.notFound("Recovery unavailable") }
      return state
    }, submit: { _, _ in
      mutations += 1; throw URLError(.unsupportedURL)
    })
    NSApplication.shared.finishLaunching()
    let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
    let priorEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    defer { NSApplication.shared.accessibilitySetValue(priorEnhanced, forAttribute: enhanced) }
    // Match DetailPanelView: the initially empty card is a child of a stack,
    // not the hosting root (which can supply its own lifecycle callbacks).
    let view = NSHostingView(rootView: VStack(spacing: 0) {
      Text("Pod header")
      SandboxRecoveryCard(podId: state.podId, actions: actions)
      Text("Detail tabs")
    })
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 900, height: 100),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    window.orderBack(nil)
    defer { window.close() }
    for _ in 0..<50 {
      if observations > 0 { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    try await Task.sleep(for: .milliseconds(100))
    view.layoutSubtreeIfNeeded()
    #expect(observations == 1)
    #expect(mutations == 0)
    let nodes = recoveryNodes(view)
    let buttons = nodes.filter {
      recoveryValue($0, "accessibilityIdentifier") as? String == "sandbox-recovery-open"
    }
    if scenario == "retained" {
      #expect(!buttons.isEmpty)
      #expect(buttons.contains { recoveryValue($0, "accessibilityEnabled") as? Bool == true })
    } else {
      #expect(buttons.isEmpty)
    }
    if scenario == "unavailable" {
      #expect(nodes.contains {
        recoveryValue($0, "accessibilityLabel") as? String == "Check recovery status"
      })
    }
  }

  @Test func heldSandboxShowsEvidenceAndDisabledMutationsWithoutAutomaticDispatch() async throws {
    let json = #"{"podId":"insufficient-takin","generation":1,"currentUserId":"human","resources":[{"sandboxId":"1826acd8-69ab-4285-aa97-05570e98c5ee","resourceKey":"https://management.northeurope.azuredevcompute.io/subscriptions/example/resourcegroups/ewi-sandboxes/sandboxgroups/autopod-spike-neu/sandboxes/1826acd8-69ab-4285-aa97-05570e98c5ee","providerState":"stopped","observedAt":"2026-11-01T16:30:00Z","observationError":null,"pendingIntentIds":["original-wakeup"],"startBlocked":"Original resume outcome is unknown. No blind replay is permitted; Azure operation evidence is required.","abandonBlocked":null,"abandonment":null}],"operations":[],"wakeups":[{"id":"original-wakeup","sandboxId":"1826acd8-69ab-4285-aa97-05570e98c5ee","startedAt":"2026-10-30T20:31:06Z","dispatchStartedAt":"2026-10-30T20:31:06Z","endedAt":null,"settledBy":null,"evidence":[]}]}"#
    let state = try JSONDecoder().decode(SandboxRecoveryState.self, from: Data(json.utf8))
    var observations = 0
    var mutations = 0
    let actions = SandboxRecoveryActions(scope: "rendering-fixture", load: { _ in
      observations += 1; return state
    }, submit: { _, _ in
      mutations += 1; throw URLError(.unsupportedURL)
    })
    NSApplication.shared.finishLaunching()
    let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
    let priorEnhanced = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    defer { NSApplication.shared.accessibilitySetValue(priorEnhanced, forAttribute: enhanced) }
    let view = NSHostingView(rootView: SandboxRecoverySheet(podId: state.podId, actions: actions)
      .preferredColorScheme(.dark))
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 680, height: 650),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: .darkAqua)
    view.appearance = NSAppearance(named: .darkAqua)
    window.contentView = view
    window.orderBack(nil)
    defer { window.close() }
    for _ in 0..<50 {
      if observations > 0 { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    try await Task.sleep(for: .milliseconds(100))
    view.layoutSubtreeIfNeeded()
    #expect(observations == 1)
    #expect(mutations == 0)
    if let path = ProcessInfo.processInfo.environment["AUTOPOD_RECOVERY_SCREENSHOT"] {
      let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.cacheDisplay(in: view.bounds, to: bitmap)
      let data = try #require(bitmap.representation(using: .png, properties: [:]))
      try data.write(to: URL(fileURLWithPath: path))
    }
    let nodes = recoveryNodes(view)
    for id in ["sandbox-recovery-start", "sandbox-recovery-abandon"] {
      let candidates = nodes.filter { recoveryValue($0, "accessibilityIdentifier") as? String == id }
      #expect(!candidates.isEmpty)
      #expect(candidates.contains { recoveryValue($0, "accessibilityEnabled") as? Bool == false })
    }
  }
}

@MainActor private func recoveryValue(_ node: NSObject, _ key: String) -> Any? {
  let getter = key == "accessibilityEnabled" ? "isAccessibilityEnabled" : key
  guard node.responds(to: NSSelectorFromString(getter)) || node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func recoveryNodes(_ node: NSObject) -> [NSObject] {
  [node] + (recoveryValue(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(recoveryNodes)
}
