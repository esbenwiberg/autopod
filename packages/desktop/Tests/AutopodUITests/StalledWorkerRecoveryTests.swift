import AppKit
import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct StalledWorkerRecoveryTests {
  @Test func inspectionAndInvalidReasonsDoNotStopRunningTasks() async throws {
    let f = StalledRecoveryFixture(); defer { f.clean() }
    let model = f.model()
    await model.refresh(f.actions)
    #expect(model.snapshot?.status == "running" && f.requests.isEmpty)
    for reason in ["", "short", String(repeating: "x", count: 4001), String(repeating: "😀", count: 2001)] {
      model.reason = reason
      await model.submit(actions: f.actions)
      #expect(f.requests.isEmpty)
    }
    model.reason = "  Preserve all retained work  "
    #expect(model.canSubmit)
    await model.submit(actions: f.actions)
    let request = try #require(f.requests.first)
    #expect(request.expectedGeneration == 3 && request.expectedBinding == f.binding)
    #expect(request.reason == "Preserve all retained work")
    #expect(model.receipt?.state == .pending && !model.canSubmit)
  }

  @Test func lostResponseReopenObservesAndReconcilesOnlyTheSavedRequest() async throws {
    let f = StalledRecoveryFixture(); defer { f.clean() }
    f.failure = DaemonError.networkError("response lost")
    let first = f.model(); await first.refresh(f.actions)
    first.reason = "Stop and preserve this blocked execution"
    await first.submit(actions: f.actions)
    let saved = try #require(first.pending)
    #expect(first.snapshot == nil && !first.canReconcile)
    f.binding = String(repeating: "b", count: 64)
    let reopened = f.model(); await reopened.refresh(f.actions)
    #expect(reopened.pending == saved && reopened.canReconcile)
    #expect(f.requests.count == 1)
    reopened.reason = "A new reason must not change the admitted request"
    await reopened.submit(actions: f.actions)
    #expect(f.requests.count == 1)
    f.failure = nil
    await reopened.reconcile(f.actions)
    #expect(f.requests == [saved, saved])
    f.operation = try f.receipt(saved, state: "settled")
    await reopened.refresh(f.actions)
    #expect(reopened.receipt?.state == .settled && !reopened.canReconcile && !reopened.canSubmit)
    #expect(f.requests.count == 2)
  }

  @Test func rejectedRequestNeedsFreshAbsenceAndNeverDiscardsAServerIntent() async throws {
    let f = StalledRecoveryFixture(); defer { f.clean() }
    f.failure = DaemonError.serverError(409, "Selection changed")
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Preserve all retained work"
    await model.submit(actions: f.actions)
    #expect(!model.canDiscardRejected)
    await model.refresh(f.actions)
    #expect(model.canDiscardRejected && !model.canReconcile)
    f.operation = try f.receipt(try #require(model.pending))
    await model.refresh(f.actions)
    #expect(!model.canDiscardRejected && model.canReconcile)
    await model.discardRejected(f.actions)
    #expect(model.pending != nil)
  }

  @Test func unknownAndOldDaemonStayDisabledWithoutFallback() async throws {
    let f = StalledRecoveryFixture(); defer { f.clean() }
    f.loadFailure = DaemonError.notFound("older daemon")
    let model = f.model(); await model.refresh(f.actions)
    #expect(model.error?.contains("does not support") == true && !model.canSubmit)
    #expect(f.requests.isEmpty)
    f.loadFailure = nil; f.allowed = false
    await model.refresh(f.actions)
    model.reason = "Preserve all retained work"
    #expect(!model.canSubmit && model.snapshot?.blockers == ["Exact execution identity unavailable"])
  }

  @Test func wrongReceiptCannotClaimSettlement() async throws {
    let f = StalledRecoveryFixture(); defer { f.clean() }
    f.wrongPod = true
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Preserve all retained work"
    await model.submit(actions: f.actions)
    #expect(model.receipt == nil && model.pending != nil && model.error != nil)
  }

  @Test func connectionChangeSuppressesLateObservation() async throws {
    let f = StalledRecoveryFixture(); defer { f.clean() }
    let model = f.model()
    f.onLoad = { f.current = false }
    await model.refresh(f.actions)
    #expect(model.snapshot == nil && !model.canSubmit && model.error?.contains("Connection changed") == true)
    #expect(f.requests.isEmpty)
  }

  @Test func duplicateTapDoesNotSendASecondPost() async throws {
    let f = StalledRecoveryFixture(); defer { f.clean() }
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Preserve all retained work"
    f.onSubmit = { await model.submit(actions: f.actions) }
    await model.submit(actions: f.actions)
    #expect(f.requests.count == 1)
  }

  @Test(arguments: [false, true])
  func runningDetailAndInspectionSheetRenderWithoutAnAutomaticStop(sheet: Bool) async throws {
    let f = StalledRecoveryFixture(); defer { f.clean() }
    var pod = Pod(id: "orphan", status: .running, branch: "main", profileName: "fixture", model: "fixture", startedAt: .distantPast, errorSummary: "Configured tests incomplete")
    pod.executionRecoveryNote = "Restart retained unresolved execution"
    var actions = PodActions.preview; actions.stalledWorkerRecovery = f.actions
    NSApplication.shared.finishLaunching()
    let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
    let prior = NSApplication.shared.accessibilityAttributeValue(enhanced)
    NSApplication.shared.accessibilitySetValue(true, forAttribute: enhanced)
    defer { NSApplication.shared.accessibilitySetValue(prior, forAttribute: enhanced) }
    let root: AnyView = sheet
      ? AnyView(StalledWorkerRecoverySheet(podId: pod.id, actions: f.actions))
      : AnyView(DetailPanelView(pod: pod, events: [], actions: actions))
    let view = NSHostingView(rootView: root)
    let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 900, height: 1000), styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.contentView = view; window.orderBack(nil)
    defer { window.close() }
    try await Task.sleep(for: .milliseconds(200)); view.layoutSubtreeIfNeeded()
    let nodes = stalledRecoveryNodes(view)
    let identifier = sheet ? "stalled-worker-recovery-confirm" : "recovery-hub-open"
    let buttons = nodes.filter { stalledRecoveryValue($0, "accessibilityIdentifier") as? String == identifier }
    #expect(!buttons.isEmpty)
    if sheet { #expect(buttons.contains { stalledRecoveryValue($0, "accessibilityEnabled") as? Bool == false }) }
    #expect(f.requests.isEmpty && f.loads == 1)
  }

  @Test func statusRequiresRecordedRecoveryEvidenceNotAge() {
    var pod = Pod(status: .running, branch: "main", profileName: "fixture", model: "fixture", startedAt: .distantPast, errorSummary: "Old test failure")
    #expect(!pod.needsExecutionInspection)
    pod.executionRecoveryNote = "Recovery paused: execution remains unresolved"
    #expect(pod.needsExecutionInspection)
    pod.status = .failed
    #expect(!pod.needsExecutionInspection)
  }
}

@MainActor private func stalledRecoveryValue(_ node: NSObject, _ key: String) -> Any? {
  let getter = key == "accessibilityEnabled" ? "isAccessibilityEnabled" : key
  guard node.responds(to: NSSelectorFromString(getter)) || node.responds(to: NSSelectorFromString(key)) else { return nil }
  return node.value(forKey: key)
}
@MainActor private func stalledRecoveryNodes(_ node: NSObject) -> [NSObject] {
  [node] + (stalledRecoveryValue(node, "accessibilityChildren") as? [NSObject] ?? []).flatMap(stalledRecoveryNodes)
}

@MainActor private final class StalledRecoveryFixture {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  var binding = String(repeating: "a", count: 64)
  var requests: [StalledWorkerRecoveryRequest] = []
  var loads = 0
  var failure: Error?
  var loadFailure: Error?
  var allowed = true
  var current = true
  var wrongPod = false
  var operation: StalledWorkerRecoveryReceipt?
  var onLoad: (() -> Void)?
  var onSubmit: (() async -> Void)?
  func clean() { try? FileManager.default.removeItem(at: folder) }
  func model() -> StalledWorkerRecoveryModel { .init(podId: "orphan", actions: actions) }
  var actions: StalledWorkerRecoveryActions {
    .init(scope: "fixture", draftScope: "daemon:user", journalDirectory: folder, isCurrent: { [self] in current }, load: { [self] id in
      loads += 1
      if let loadFailure { throw loadFailure }
      onLoad?()
      let object: [String: Any] = ["schemaVersion": 1, "podId": id, "generation": 3, "status": "running", "binding": binding,
        "canStop": allowed, "blockers": allowed ? [] : ["Exact execution identity unavailable"],
        "failureReason": "Configured tests remain failed", "guidanceBlocker": "Queued nudge not collected",
        "operation": try operation.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull()]
      return try JSONDecoder().decode(StalledWorkerRecoveryView.self, from: JSONSerialization.data(withJSONObject: object))
    }, submit: { [self] _, input in
      requests.append(input)
      await onSubmit?()
      if let failure { throw failure }
      return try receipt(input, podId: wrongPod ? "different-pod" : "orphan")
    })
  }
  func receipt(_ input: StalledWorkerRecoveryRequest, state: String = "pending", podId: String = "orphan") throws -> StalledWorkerRecoveryReceipt {
    let object: [String: Any] = ["podId": podId,
      "request": try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)),
      "actor": ["type": "human", "userId": "operator"], "state": state, "createdAt": "2026-11-07T07:00:00Z",
      "settledAt": state == "settled" ? "2026-11-07T07:01:00Z" : NSNull(),
      "message": "Source and reports retained; checks have NOT passed", "resourcesRetained": true]
    return try JSONDecoder().decode(StalledWorkerRecoveryReceipt.self, from: JSONSerialization.data(withJSONObject: object))
  }
}
