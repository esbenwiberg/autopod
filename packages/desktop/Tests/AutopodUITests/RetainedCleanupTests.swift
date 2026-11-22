import AppKit
import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@MainActor @Suite(.serialized) struct RetainedCleanupTests {
  @Test func nativeFreeStorageShowsExactInventoryAndRequiresConsentAndReason() async throws {
    let f = CleanupUIFixture(); defer { f.clean() }
    let actions = f.podActions
    let model = RecoveryHubModel(podId: f.pod.id, actions: actions)
    let host = LaunchComposerHost(RecoveryHubSheet(pod: f.pod, actions: actions, model: model), width: 840)
    defer { host.close() }
    try await host.wait { host.enabled("recovery-route-freeStorage") }
    #expect(f.inspections.isEmpty && f.requests.isEmpty)
    try host.press("recovery-route-freeStorage")
    try await host.wait { host.has("retained-cleanup-apply") }
    #expect(host.containsText("Guest execution") && host.containsText("Owned Docker bridge"))
    #expect(host.containsText("/fixture-private/worktrees/retained-task"))
    #expect(host.containsText("Writable container layers and logs") && host.containsText("Unpublished files"))
    #expect(host.containsText("External PRs, refs and History") && host.containsText("Shared caches, volumes and images"))
    #expect(!host.has("sandbox-recovery-abandon") && !host.has("retained-finalization-stop"))
    #expect(!host.enabled("retained-cleanup-apply"))
    try host.press("retained-cleanup-acknowledge")
    #expect(!host.enabled("retained-cleanup-apply"))
    model.cleanup.reason = "  Discard findings after exporting the report  "
    try await host.wait { host.enabled("retained-cleanup-apply") }
    try host.press("retained-cleanup-apply")
    try await host.wait { host.containsText("Partial — cleanup remains owned") }
    #expect(host.containsText("Still held — pending") && host.containsText("Removal sent — absence unconfirmed"))
    #expect(f.requests.count == 1 && f.requests[0].reason == "Discard findings after exporting the report")
    try host.press("retained-cleanup-observe")
    try await host.wait { f.observations.count == 1 && host.enabled("retained-cleanup-reconcile") }
    #expect(f.requests.count == 1)
    f.deleteOnSubmit = true
    try host.press("retained-cleanup-reconcile")
    try await host.wait { host.containsText("all selected resources confirmed absent") }
    #expect(f.requests.count == 2 && f.requests[0] == f.requests[1])
    #expect(f.removals == [f.pod.id])
  }

  @Test(arguments: ["blocked", "unsupported"])
  func nativeRefusalsShowGuidanceWithoutAction(state: String) async throws {
    let f = CleanupUIFixture(); defer { f.clean() }
    f.previewOutcome = state
    let actions = f.podActions
    let host = LaunchComposerHost(RecoveryHubSheet(pod: f.pod, actions: actions,
      model: RecoveryHubModel(podId: f.pod.id, actions: actions), initialRoute: .freeStorage), width: 840)
    defer { host.close() }
    if state == "blocked" {
      try await host.wait { host.containsText("No exact host mount proof for the old run") }
      #expect(host.containsText("HOST_PROOF_UNAVAILABLE"))
    } else {
      try await host.wait { host.containsText("daemon does not expose retained cleanup") }
    }
    #expect(!host.has("retained-cleanup-apply") && !host.has("retained-cleanup-reconcile"))
    #expect(f.requests.isEmpty)
  }

  @Test(arguments: [PodStatus.failed, .reviewRequired, .killing, .killed])
  func retainedCardOpensRecoveryWithoutKillingOrDeleting(status: PodStatus) async throws {
    let f = CleanupUIFixture(); defer { f.clean() }
    var pod = f.pod; pod.status = status
    let host = LaunchComposerHost(SessionCardFinal(pod: pod, actions: f.podActions, density: .compact), width: 485)
    defer {
      for sheet in host.window.sheets { host.window.endSheet(sheet); sheet.close() }
      host.close()
    }
    let button = "pod-control-cleanup-retained-\(pod.id)"
    try await host.wait { host.enabled(button) }
    #expect(host.has("pod-control-stop-retain-\(pod.id)") == (status != .killed))
    #expect(!host.has("pod-control-delete-\(pod.id)") && !host.has("pod-control-kill-\(pod.id)"))
    try host.press(button)
    try await host.wait { host.window.attachedSheet != nil && f.inspections == [pod.id] }
    #expect(f.requests.isEmpty && f.observations.isEmpty)
  }

  @Test func staleAndUncertainRequestsAreNotReplacedOrSentOnCardAndConnectionChanges() async throws {
    let f = CleanupUIFixture(); defer { f.clean() }
    let actions = f.actions()
    let first = RetainedCleanupModel(podId: f.pod.id, actions: actions)
    await first.refresh(actions)
    let original = try #require(first.plan)
    f.binding = String(repeating: "b", count: 64)
    await first.refresh(actions)
    first.reason = "Discard the unpublished experiment"; first.acknowledgesLoss = true
    await first.apply(reviewed: original, actions: actions)
    #expect(f.requests.isEmpty)
    await first.refresh(actions)
    let reviewed = try #require(first.plan)
    first.reason = "Discard the unpublished experiment"; first.acknowledgesLoss = true
    f.postError = DaemonError.serverError(409, "Reviewed cleanup selection is stale")
    await first.apply(reviewed: reviewed, actions: actions)
    let saved = try #require(first.pending)
    #expect(first.error?.contains("stale") == true && f.requests == [saved] && !first.canReconcile)
    let otherCard = RetainedCleanupModel(podId: "other-card", actions: actions)
    #expect(otherCard.pending == nil)
    let otherConnection = f.actions(scope: "replacement", connection: "other-daemon")
    let otherDaemon = RetainedCleanupModel(podId: f.pod.id, actions: otherConnection)
    #expect(otherDaemon.pending == nil)
    await first.reconcile(otherConnection)
    #expect(f.requests == [saved])

    let reopened = RetainedCleanupModel(podId: f.pod.id, actions: actions)
    f.postError = nil
    await reopened.refresh(actions)
    #expect(reopened.pending == saved && reopened.canReconcile)
    #expect(f.observations == [saved.id] && f.requests == [saved])
    await reopened.reconcile(actions)
    #expect(f.requests == [saved, saved])
  }

  @Test func requestedFromAnotherClientIsReadOnlyAndNeverManufacturesAReplay() async throws {
    let f = CleanupUIFixture(); defer { f.clean() }
    let source = RetainedCleanupModel(podId: f.pod.id, actions: f.actions())
    await source.refresh(f.actions())
    let exact = RetainedCleanupRequest(id: "other-client-key", plan: try #require(source.plan),
      reason: "External operator reviewed these targets")
    f.externalRequest = exact
    await source.refresh(f.actions())
    #expect(source.requestId == exact.id && source.receipt?.state == .partial)
    #expect(source.pending == nil && !source.canReconcile && !source.canSubmit)
    #expect(f.observations == [exact.id] && f.requests.isEmpty)
  }
}

@MainActor private final class CleanupUIFixture {
  let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cleanup-fixture-\(UUID())")
  var inspections: [String] = []
  var observations: [String] = []
  var requests: [RetainedCleanupRequest] = []
  var removals: [String] = []
  var binding = String(repeating: "a", count: 64)
  var previewOutcome = "eligible"
  var postError: (any Error)?
  var deleteOnSubmit = false
  var externalRequest: RetainedCleanupRequest?
  var pod: Pod {
    var value = Pod(id: "retained-task", status: .failed, hasWorktree: true, branch: "fixture/failed",
      profileName: "Isolated Docker", model: "fixture", startedAt: .now)
    value.executionTarget = "local"
    return value
  }
  var podActions: PodActions {
    var value = PodActions()
    value.retainedCleanup = actions()
    return value
  }
  func clean() { try? FileManager.default.removeItem(at: folder) }
  func actions(scope: String = "fixture-epoch", connection: String = "fixture-daemon") -> RetainedCleanupActions {
    .init(scope: scope, connection: connection, journalDirectory: folder, isCurrent: { true },
      inspect: { [self] id in
        inspections.append(id)
        switch previewOutcome {
        case "unsupported": throw RetainedCleanupError.unsupported
        case "blocked":
          return try decode(["podId": id, "state": "blocked", "blockers": [
            ["code": "HOST_PROOF_UNAVAILABLE", "message": "No exact host mount proof for the old run"]
          ]])
        default:
          if let externalRequest { return try decode(["podId": id, "state": "requested", "requestId": externalRequest.id]) }
          return try decode(["podId": id, "state": "eligible", "plan": plan()])
        }
      }, observe: { [self] id, key in
        observations.append(key)
        guard let request = externalRequest ?? (postError == nil ? requests.last : nil), request.id == key else {
          throw RetainedCleanupError.notFound
        }
        return try receipt(id, request)
      }, submit: { [self] id, request in
        requests.append(request)
        if let postError { throw postError }
        return .receipt(try receipt(id, request))
      }, confirmDeleted: { [self] in removals.append($0.podId) })
  }

  private func plan() throws -> [String: Any] {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/retained-cleanup-v1.json")
    var value = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]
    value["binding"] = binding
    return value
  }

  private func receipt(_ id: String, _ request: RetainedCleanupRequest) throws -> RetainedCleanupReceipt {
    let plan = try plan()
    let targets = plan["resources"] as! [[String: String]]
    return try decode(["podId": id, "state": deleteOnSubmit ? "deleted" : "partial",
      "plan": plan, "request": try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)),
      "actor": ["type": "human", "userId": "fixture"],
      "resources": targets.enumerated().map { index, target in
        target.merging(["state": deleteOnSubmit ? "confirmed_absent" : index == 0 ? "removal_unconfirmed" : "pending"]) { _, new in new }
      }, "createdAt": "2026-11-19T10:00:00.000Z", "updatedAt": "2026-11-19T10:00:00.000Z", "blockers": []])
  }
  private func decode<T: Decodable>(_ value: [String: Any]) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value))
  }
}
