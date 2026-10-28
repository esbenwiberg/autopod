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
