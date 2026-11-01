import AppKit
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor private func readinessLabels(_ node: NSObject) -> [String] {
  let labels = ["accessibilityLabel", "accessibilityValue"].compactMap { key -> String? in
    guard node.responds(to: NSSelectorFromString(key)) else { return nil }
    return node.value(forKey: key) as? String
  }
  guard node.responds(to: NSSelectorFromString("accessibilityChildren")) else { return labels }
  return labels + (node.value(forKey: "accessibilityChildren") as? [NSObject] ?? []).flatMap(readinessLabels)
}

// These render tests share process-global AppKit accessibility settings.
@Suite(.serialized) struct ReadinessRecoveryTests {
@Test(arguments: [540.0, 1100.0]) @MainActor
func readinessRecoveryHasAnActionInsteadOfAnUnexplainedDisabledApproval(width: Double) async throws {
  NSApplication.shared.finishLaunching()
  let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
  let previous = NSApp.accessibilityAttributeValue(enhanced)
  NSApp.accessibilitySetValue(true, forAttribute: enhanced)
  defer { NSApp.accessibilitySetValue(previous ?? false, forAttribute: enhanced) }

  for completed in [false, true] {
    let area: ReadinessArea = completed ? .pr : .validation
    let status: ReadinessStatus = completed ? .needsReview : .risky
    let title = completed ? "Delivered externally — reports pending" : "Blocking validation failed"
    var pod = Pod(id: "readiness-recovery-fixture", status: completed ? .complete : .reviewRequired,
      branch: "fix/example", profileName: "fixture", task: "Repair a task", model: "fixture", startedAt: Date(timeIntervalSince1970: 0))
    pod.readinessReview = ReadinessReview(status: status, summary: title, computedAt: Date(),
      areas: [ReadinessAreaReview(area: area, status: status, title: completed ? "PR" : "Validation", summary: title, sourceRefs: [])],
      findings: [ReadinessFinding(id: "fixture", area: area, severity: completed ? .warning : .error,
        title: title, detail: completed ? "Exact source delivery verified. Original sandbox retained for report recovery; storage can still incur cost." : "Latest validation overall status is fail.", sourceRefs: [])])
    let view = ReadinessTab(pod: pod, seriesReadiness: nil)
      .environment(\.desktopRedesign, true).preferredColorScheme(.dark)
      .transaction { $0.disablesAnimations = true }
    let host = NSHostingView(rootView: view)
    host.sizingOptions = []
    host.appearance = NSAppearance(named: .darkAqua)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 850),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    defer { window.contentView = nil; window.close() }
    window.layoutIfNeeded(); host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
    try await Task.sleep(for: .milliseconds(150))
    let labels = readinessLabels(host).joined(separator: "\n")
    #expect(!labels.contains("Approval reason required"))
    #expect(!labels.contains("Approve with reason"))
    #expect(labels.contains(completed ? "Delivery complete" : "Open validation recovery"))
    #expect(abs(host.bounds.width - width) < 0.5)
    if let directory = ProcessInfo.processInfo.environment["AUTOPOD_RECOVERY_RENDER_DIR"] {
      let url = URL(fileURLWithPath: directory)
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
      host.cacheDisplay(in: host.bounds, to: bitmap)
      try bitmap.representation(using: .png, properties: [:])?.write(to: url.appendingPathComponent("readiness-\(completed ? "delivered" : "blocked")-\(Int(width)).png"))
    }
  }
}

@Test(arguments: [540.0, 1100.0], [false, true]) @MainActor
func readinessExplainsPendingDecisionInsteadOfOfferingApproval(width: Double, orphaned: Bool) async throws {
  NSApplication.shared.finishLaunching()
  let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
  let previous = NSApp.accessibilityAttributeValue(enhanced)
  NSApp.accessibilitySetValue(true, forAttribute: enhanced)
  defer { NSApp.accessibilitySetValue(previous ?? false, forAttribute: enhanced) }
  var pod = Pod(id: "pending-decision-fixture", status: .validated, branch: "fix/example",
    profileName: "fixture", model: "fixture", startedAt: Date(timeIntervalSince1970: 0),
    escalationId: orphaned ? nil : "pending-question", pendingDecisionId: "pending-question")
  pod.validationWaiver = ValidationWaiver(waivedAt: Date(), waivedBy: "Fixture human",
    reason: "PR-only waiver; no merge or additional agent run.", attempt: 1, failedPhases: ["tests"], failedFactIds: [])
  pod.readinessReview = ReadinessReview(status: .waived, summary: "Validation proof was waived.", computedAt: Date(), areas: [], findings: [])
  #expect(pod.hasUnansweredDecision)
  #expect(pod.hasOrphanedValidationDecision == orphaned)
  let host = NSHostingView(rootView: ReadinessTab(pod: pod, seriesReadiness: nil)
    .environment(\.desktopRedesign, true).transaction { $0.disablesAnimations = true })
  host.sizingOptions = []
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 850),
    styleMask: [.titled], backing: .buffered, defer: false)
  window.isReleasedWhenClosed = false
  window.contentView = host
  defer { window.contentView = nil; window.close() }
  window.layoutIfNeeded(); host.layoutSubtreeIfNeeded(); host.displayIfNeeded()
  try await Task.sleep(for: .milliseconds(150))
  let labels = readinessLabels(host).joined(separator: "\n")
  #expect(labels.contains("Human decision blocks approval"))
  #expect(labels.contains("pending-question"))
  #expect(labels.contains(orphaned ? "Open validation decision" : "Open pending question"))
  #expect(!labels.contains("Approval reason required"))
  #expect(!labels.contains("Approve with reason"))

  let validationHost = NSHostingView(rootView: ValidationTab(pod: pod)
    .environment(\.desktopRedesign, true).transaction { $0.disablesAnimations = true })
  validationHost.sizingOptions = []
  window.contentView = validationHost
  window.layoutIfNeeded(); validationHost.layoutSubtreeIfNeeded(); validationHost.displayIfNeeded()
  try await Task.sleep(for: .milliseconds(150))
  let validationLabels = readinessLabels(validationHost).joined(separator: "\n")
  #expect(validationLabels.contains("Reapply validation decision") == orphaned)
}
}
