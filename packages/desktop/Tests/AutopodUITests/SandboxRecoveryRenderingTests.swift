import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Suite(.serialized) struct SandboxRecoveryRenderingTests {
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
    let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 680, height: 650),
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
    if let path = ProcessInfo.processInfo.environment["AUTOPOD_RECOVERY_SCREENSHOT"] {
      let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
      view.cacheDisplay(in: view.bounds, to: bitmap)
      let data = try #require(bitmap.representation(using: .png, properties: [:]))
      try data.write(to: URL(fileURLWithPath: path))
    }
    let nodes = recoveryNodes(view)
    let start = try #require(nodes.first { recoveryValue($0, "accessibilityIdentifier") as? String == "sandbox-recovery-start" })
    let abandon = try #require(nodes.first { recoveryValue($0, "accessibilityIdentifier") as? String == "sandbox-recovery-abandon" })
    #expect(recoveryValue(start, "accessibilityEnabled") as? Bool == false)
    #expect(recoveryValue(abandon, "accessibilityEnabled") as? Bool == false)
  }
}

@MainActor private func recoveryValue(_ node: NSObject, _ key: String) -> Any? {
  guard node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func recoveryNodes(_ node: NSObject) -> [NSObject] {
  [node] + (recoveryValue(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(recoveryNodes)
}
