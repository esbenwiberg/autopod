import AppKit
import AutopodClient
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor private final class RecoveryHarness {
  var state = ValidationRecoveryState(generation: 3, validationTimestamp: "2026-10-27T17:18:10Z",
    fixValidation: .init(allowed: true), retryChecks: .init(allowed: true))
  var requests: [ValidationRecoveryRequest] = []
  var gate: CheckedContinuation<Void, Never>?
  var holdRequest = false
  var failPost = false
  var failLoad = false
  var actions: PodActions {
    PodActions(loadValidationRecovery: { [self] _ in
      if failLoad { throw URLError(.notConnectedToInternet) }
      return state
    }, requestValidationRecovery: { [self] _, input in
      requests.append(input)
      if holdRequest { await withCheckedContinuation { gate = $0 } }
      if failPost { throw URLError(.networkConnectionLost) }
    })
  }
}

@MainActor @Test func failedValidationCanBeRepairedWithoutAWorkerFailure() async {
  let harness = RecoveryHarness()
  let controller = ValidationRecoveryController(podId: "pod", actions: harness.actions)
  await controller.refresh()
  #expect(controller.canRequest("fix-validation"))
  #expect(controller.canRequest("retry-checks"))
  await controller.request("fix-validation")
  #expect(harness.requests.count == 1)
  #expect(harness.requests[0].action == "fix-validation")
  #expect(harness.requests[0].expectedGeneration == 3)
}

@MainActor @Test func duplicateClicksDoNotSubmitAnotherRecovery() async {
  let harness = RecoveryHarness()
  harness.holdRequest = true
  let controller = ValidationRecoveryController(podId: "pod", actions: harness.actions)
  await controller.refresh()
  let first = Task { await controller.request("retry-checks") }
  for _ in 0..<20 where harness.gate == nil { await Task.yield() }
  #expect(controller.isPending)
  #expect(!controller.canRequest("fix-validation"))
  await controller.request("retry-checks")
  #expect(harness.requests.count == 1)
  harness.gate?.resume()
  await first.value
}

@MainActor @Test func blockedOrUnavailableEligibilityCannotDispatch() async {
  let harness = RecoveryHarness()
  harness.state = .init(generation: 3, validationTimestamp: "result",
    fixValidation: .init(allowed: false, reason: "Execution unverified", code: "VALIDATION_EXECUTION_UNVERIFIED"),
    retryChecks: .init(allowed: false, reason: "Execution unverified"))
  let controller = ValidationRecoveryController(podId: "pod", actions: harness.actions)
  await controller.refresh()
  await controller.request("fix-validation")
  #expect(harness.requests.isEmpty)
  harness.failLoad = true
  await controller.refresh()
  #expect(controller.loadError != nil)
  #expect(!controller.canRequest("retry-checks"))
}

@MainActor @Test func lostResponseObservesDaemonInsteadOfRepeatingThePost() async {
  let harness = RecoveryHarness()
  harness.failPost = true
  let controller = ValidationRecoveryController(podId: "pod", actions: harness.actions)
  await controller.refresh()
  // The daemon accepted before the connection was lost. A later poll sees it active.
  harness.state = .init(generation: 3, validationTimestamp: "result",
    fixValidation: .init(allowed: false), retryChecks: .init(allowed: false), activeAction: "retry-checks")
  await controller.request("retry-checks")
  #expect(harness.requests.count == 1)
  #expect(controller.requestError != nil)
  #expect(controller.isPending)
  await controller.request("retry-checks")
  #expect(harness.requests.count == 1)
}

@Test func actualCapsuleFailureIsShownInsteadOfSuccessfulCapsuleLines() {
  let output = String(repeating: "✓ .capsules/cap-error-in-name.capsule.yaml\n", count: 1000)
    + "\n✗ capsule check failed\n  - non-capsule commits not covered by capsule commit_range: d6bae2a35390fb489c199a639898883a8757563f\n"
  let summary = validationFailureSummary(output)
  #expect(summary?.contains("non-capsule commits not covered") == true)
  #expect(summary?.contains("d6bae2a35390fb489c199a639898883a8757563f") == true)
  #expect(summary?.contains("cap-error-in-name") == false)
  #expect(validationFailureSummary("✓ all checks passed") == nil)
  #expect(validationFailureSummary("\u{001B}[31mERROR: broken\u{001B}[0m") == "ERROR: broken")
}

@MainActor @Test(arguments: [540.0, 1100.0])
func validationRecoveryLayoutAndOwnedRendering(width: Double) async throws {
  let harness = RecoveryHarness()
  let output = String(repeating: "✓ capsule passed\n", count: 530)
    + "✗ capsule check failed\n - non-capsule commits not covered by capsule commit_range: d6bae2a35390fb489c199a639898883a8757563f\n"
  let pod = Pod(id: "fixture", status: .failed, hasWorktree: true, branch: "feat/export",
    profileName: "fixture", model: "fixture", startedAt: Date(),
    validationChecks: ValidationChecks(smoke: true, setup: true, build: true, tests: true, lint: false,
      sast: true, lintOutput: output))
  let view = ValidationTab(pod: pod, actions: harness.actions).environment(\.desktopRedesign, true)
  let host = NSHostingView(rootView: view)
  // Match the app's allocated detail pane rather than letting ideal scroll-row
  // sizing enlarge the test window to the width of all nine phase cards.
  host.sizingOptions = []
  host.frame = NSRect(x: 0, y: 0, width: width, height: 900)
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 900),
    styleMask: [.titled], backing: .buffered, defer: false)
  window.isReleasedWhenClosed = false
  defer { window.close() }
  window.contentView = host
  host.appearance = NSAppearance(named: .darkAqua)
  window.layoutIfNeeded()
  host.layoutSubtreeIfNeeded()
  try await Task.sleep(for: .milliseconds(150))
  host.layoutSubtreeIfNeeded()
  // Phase navigation intentionally scrolls horizontally (its ideal fittingSize is
  // wider than the viewport). Verify the real allocated viewport, then render it.
  #expect(abs(host.bounds.width - width) < 0.5)
  if let directory = ProcessInfo.processInfo.environment["AUTOPOD_RECOVERY_RENDER_DIR"] {
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
    let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: bitmap)
    let png = try #require(bitmap.representation(using: .png, properties: [:]))
    try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("validation-\(Int(width)).png"))
  }
}

@MainActor @Test func unverifiedValidationOffersReadOnlyReconciliationWithoutDispatchingWork() async {
  let harness = RecoveryHarness()
  harness.state = .init(generation: 1, validationTimestamp: "legacy-result",
    fixValidation: .init(allowed: false, reason: "Termination proof required", code: "VALIDATION_EXECUTION_UNVERIFIED"),
    retryChecks: .init(allowed: false, code: "VALIDATION_EXECUTION_UNVERIFIED"))
  let controller = ValidationRecoveryController(podId: "recovery-example", actions: harness.actions)
  await controller.refresh()
  #expect(controller.reconciliationCommand == "ap reconcile-validation recovery-example --json")
  #expect(!controller.canRequest("fix-validation"))
  #expect(!controller.canRequest("retry-checks"))
  #expect(harness.requests.isEmpty)
  harness.state = .init(generation: 1, validationTimestamp: "legacy-result",
    fixValidation: .init(allowed: true), retryChecks: .init(allowed: false, code: "VALIDATION_RESOURCE_UNAVAILABLE"))
  await controller.refresh()
  #expect(controller.reconciliationCommand == nil)
  #expect(controller.canRequest("fix-validation"))
  #expect(!controller.canRequest("retry-checks"))
}
