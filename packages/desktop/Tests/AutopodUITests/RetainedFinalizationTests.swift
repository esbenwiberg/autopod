import AppKit
import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct RetainedFinalizationTests {
  @Test func inspectionAndInvalidReasonsNeverSubmit() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    let model = f.model()
    await model.refresh(f.actions)
    for reason in ["", " short ", String(repeating: "x", count: 4001)] {
      model.reason = reason
      await model.submit(.stopRetain, actions: f.actions)
      #expect(!model.canSubmit(.completeMerged))
    }
    #expect(f.requests.isEmpty && f.loads == 1)
    f.canComplete = false
    await model.refresh(f.actions)
    model.reason = "Preserve recovered work"
    #expect(model.canSubmit(.stopRetain) && !model.canSubmit(.completeMerged))
    await model.submit(.completeMerged, actions: f.actions)
    #expect(f.requests.isEmpty)
  }

  @Test(arguments: [RetainedFinalizationMode.stopRetain, .completeMerged])
  func explicitModeUsesExactObservedSelection(mode: RetainedFinalizationMode) async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "  Preserve recovered work  "
    await model.submit(mode, actions: f.actions)
    let request = try #require(f.requests.first)
    #expect(request.expectedGeneration == 3 && request.expectedBinding == f.binding)
    #expect(request.mode == mode && request.reason == "Preserve recovered work")
    #expect(model.receipt?.state == .pending)
    #expect(!model.canSubmit(.stopRetain) && !model.canSubmit(.completeMerged))
    #expect(f.requests.count == 1)
  }

  @Test func lostResponseSurvivesReopenAndNeverRebindsOrAutomaticallyRetries() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    f.failure = URLError(.networkConnectionLost)
    let first = f.model(); await first.refresh(f.actions)
    first.reason = "Preserve recovered work"
    await first.submit(.stopRetain, actions: f.actions)
    let saved = try #require(first.pending)
    #expect(first.snapshot == nil && !first.canReconcile)
    f.binding = String(repeating: "b", count: 64)
    let reopened = f.model(); await reopened.refresh(f.actions)
    #expect(reopened.pending == saved && reopened.canReconcile && !reopened.canDiscardRejected)
    reopened.reason = "Changed reason must not alter request"
    await reopened.submit(.completeMerged, actions: f.actions)
    #expect(f.requests.count == 1)
    f.failure = nil
    await reopened.reconcile(f.actions)
    #expect(f.requests == [saved, saved])
    #expect(reopened.receipt?.state == .pending)
    f.operation = try f.receipt(saved, state: "finalized")
    await reopened.refresh(f.actions)
    #expect(reopened.receipt?.state == .finalized && !reopened.canReconcile)
    #expect(f.requests.count == 2)
  }

  @Test func rejectedDraftNeedsFreshAbsenceBeforeNewDecision() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    f.failure = DaemonError.serverError(409, "PR is not merged")
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Verify recorded external delivery"
    await model.submit(.completeMerged, actions: f.actions)
    #expect(!model.canDiscardRejected)
    await model.refresh(f.actions)
    #expect(model.canDiscardRejected && !model.canReconcile)
    f.failure = nil
    await model.discardRejected(f.actions)
    #expect(model.pending == nil && model.canSubmit(.stopRetain))
    await model.submit(.stopRetain, actions: f.actions)
    #expect(f.requests.count == 2 && f.requests[0].requestKey != f.requests[1].requestKey)
  }

  @Test func serverIntentCannotBeDiscardedEvenAfterConflict() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    f.failure = DaemonError.serverError(409, "Reconciliation is required")
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Preserve recovered work"
    await model.submit(.stopRetain, actions: f.actions)
    f.operation = try f.receipt(try #require(model.pending))
    await model.refresh(f.actions)
    #expect(!model.canDiscardRejected && model.canReconcile)
    await model.discardRejected(f.actions)
    #expect(model.pending != nil && f.requests.count == 1)
  }

  @Test func corruptJournalAndUnavailableDaemonFailClosed() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    f.failure = URLError(.timedOut)
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Preserve recovered work"
    await model.submit(.stopRetain, actions: f.actions)
    let file = try #require(FileManager.default.contentsOfDirectory(at: f.folder, includingPropertiesForKeys: nil).first)
    try Data("corrupt".utf8).write(to: file)
    let reopened = f.model(); await reopened.refresh(f.actions)
    #expect(!reopened.canReconcile && !reopened.canSubmit(.stopRetain))
    #expect(reopened.error?.contains("unreadable") == true)
    f.loadFailure = DaemonError.notFound("Unsupported API")
    await model.refresh(f.actions)
    #expect(model.snapshot == nil && !model.canReconcile)
    #expect(f.requests.count == 1)
  }

  @Test func connectionChangeAndDuplicateClicksCannotSubmit() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Preserve recovered work"
    let foreign = RetainedFinalizationActions(scope: "foreign", draftScope: "foreign",
      load: f.actions.load, submit: f.actions.submit)
    await model.submit(.stopRetain, actions: foreign)
    #expect(f.requests.isEmpty && model.error?.contains("Connection changed") == true)
    await model.refresh(f.actions)
    f.hold = true
    let task = Task { await model.submit(.stopRetain, actions: f.actions) }
    while f.continuation == nil { await Task.yield() }
    #expect(model.busy)
    await model.submit(.completeMerged, actions: f.actions)
    await model.reconcile(f.actions)
    f.continuation?.resume(); await task.value
    #expect(f.requests.count == 1)
  }

  @Test func anotherSheetCannotOverwriteAnUncertainRequest() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    let first = f.model(); let second = f.model()
    await first.refresh(f.actions); await second.refresh(f.actions)
    first.reason = "Preserve recovered work"; second.reason = "Verify different delivery"
    f.failure = URLError(.timedOut)
    await first.submit(.stopRetain, actions: f.actions)
    await second.submit(.completeMerged, actions: f.actions)
    #expect(f.requests.count == 1 && second.error?.contains("nothing was sent") == true)
    let reopened = f.model(); await reopened.refresh(f.actions)
    #expect(reopened.pending == first.pending)
  }

  @Test func journalFailurePreventsNetworkMutation() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    try Data("not a directory".utf8).write(to: f.folder)
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Preserve recovered work"
    await model.submit(.stopRetain, actions: f.actions)
    #expect(f.requests.isEmpty && model.pending == nil)
    #expect(model.error?.contains("nothing was sent") == true)
  }

  @Test func wrongReceiptIsUnknownNotAConfirmedRejection() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    let model = f.model(); await model.refresh(f.actions)
    model.reason = "Preserve recovered work"; f.responsePodId = "another-pod"
    await model.submit(.stopRetain, actions: f.actions)
    #expect(model.receipt == nil && model.error?.contains("Unexpected finalization receipt") == true)
    await model.refresh(f.actions)
    #expect(model.canReconcile && !model.canDiscardRejected)
    #expect(f.requests.count == 1)
  }

  @Test func nativeActionRequiresSeparateConfirmation() async throws {
    let f = RetainedFinalizationFixture(); defer { f.clean() }
    let model = f.model()
    let host = LaunchComposerHost(RetainedFinalizationSheet(podId: "retained", actions: f.actions, model: model), width: 640)
    defer { host.close() }
    try await host.wait { host.has("retained-finalization-stop") }
    #expect(!host.enabled("retained-finalization-stop"))
    model.reason = "Preserve recovered work"
    try await host.wait { host.enabled("retained-finalization-stop") }
    try host.press("retained-finalization-stop")
    try await host.wait { !host.window.sheets.isEmpty }
    #expect(f.requests.isEmpty)
    func buttons(_ view: NSView) -> [NSButton] {
      (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
    }
    let sheet = try #require(host.window.sheets.first?.contentView)
    let confirm = try #require(buttons(sheet).first { $0.title == "Stop and retain work" })
    confirm.performClick(nil)
    try await host.wait { model.receipt?.state == .pending }
    #expect(f.requests.count == 1 && f.requests[0].mode == .stopRetain)
    #expect(!model.canSubmit(.completeMerged))
  }
}

@MainActor private final class RetainedFinalizationFixture {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("retained-ui-\(UUID())")
  var responsePodId = "retained"
  var binding = String(repeating: "a", count: 64)
  var canComplete = true
  var loads = 0
  var requests: [RetainedFinalizationRequest] = []
  var failure: (any Error)?
  var loadFailure: (any Error)?
  var operation: RetainedFinalizationReceipt?
  var hold = false
  var continuation: CheckedContinuation<Void, Never>?
  func clean() { try? FileManager.default.removeItem(at: folder) }
  func model() -> RetainedFinalizationModel { .init(podId: "retained", actions: actions) }
  var actions: RetainedFinalizationActions {
    .init(scope: "fixture", draftScope: "fixture", journalDirectory: folder, load: { [self] id in
      loads += 1
      if let loadFailure { throw loadFailure }
      let operationJSON: Any = try operation.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) } ?? NSNull()
      let json: [String: Any] = ["podId": id, "generation": 3, "status": "review_required", "binding": binding,
        "custody": [["kind": "continuation", "id": "owner"]], "canStop": true, "canCompleteMerged": canComplete,
        "blockers": [], "operation": operationJSON]
      return try JSONDecoder().decode(RetainedFinalizationView.self, from: JSONSerialization.data(withJSONObject: json))
    }, submit: { [self] _, input in
      requests.append(input)
      if hold { await withCheckedContinuation { continuation = $0 } }
      if let failure { throw failure }
      return try receipt(input)
    })
  }
  func receipt(_ input: RetainedFinalizationRequest, state: String = "pending") throws -> RetainedFinalizationReceipt {
    let json: [String: Any] = ["podId": responsePodId, "request": try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)),
      "actor": ["type": "human", "userId": "fixture"], "state": state, "createdAt": "2026-11-05T12:00:00Z",
      "finalizedAt": state == "finalized" ? "2026-11-05T12:01:00Z" as Any : NSNull(),
      "message": "Resources remain retained", "resourcesRetained": true]
    return try JSONDecoder().decode(RetainedFinalizationReceipt.self, from: JSONSerialization.data(withJSONObject: json))
  }
}
