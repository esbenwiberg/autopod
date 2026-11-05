import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct PodRepairReworkTests {
  private func eligibility(_ status: String = "eligible") throws -> ReworkEligibility {
    try JSONDecoder().decode(ReworkEligibility.self, from: Data("""
      {"eligible":\(status == "eligible" || status == "grant_recorded"),"status":"\(status)","reason":"Daemon admission projection","generation":2,"failureId":"failure"}
      """.utf8))
  }
  private func pod() -> Pod {
    Pod(id: "rework-fixture", status: .failed, hasWorktree: true, branch: "repair",
      profileName: "fixture", task: "Continue repair", model: "fixture", startedAt: .now)
  }
  @Test(arguments: ["authorization_needed", "cooldown", "blocked", "unavailable"])
  func renderedHandoffBlocksFooterAndBudgetContinuation(status: String) async throws {
    let scope = UUID().uuidString
    let model = PodRepairModel(kind: .rework, scope: scope, ordinaryRework: true)
    var actions = PodActions()
    actions.retryDraftScope = scope
    actions.repair = PodRepairActions(scope: scope, submit: { _, _, _ in
      Issue.record("Legacy submit must never handle ordinary Rework"); throw URLError(.unsupportedURL)
    }, inspect: { _ in PodRepairObservation(source: pod(), related: []) })
    let projection = try eligibility(status)
    actions.repair.loadReworkEligibility = { _ in
      if status == "unavailable" { throw DaemonError.notFound("older daemon") }
      return projection
    }
    let host = LaunchComposerHost(PodRepairSheet(isPresented: .constant(true), pod: pod(), kind: .rework,
      relatedPods: [], actions: actions, model: model), width: 1120)
    defer { host.close() }
    try await host.wait { model.ordinaryRework && !model.eligibilityLoading && (model.eligibility != nil || model.error != nil) }
    #expect(!model.canSubmit)
    #expect(!host.enabled("repair-submit"))
    #expect(!host.has("task-budget-save-continue"))
    #expect(host.has("repair-continuation-guidance"))
    #expect(host.has("repair-authorize-retry") == (status == "authorization_needed"))
  }
  @Test(arguments: ["rejected", "dropped"])
  func submissionRetainsGuidanceAndNeverAutomaticallyRepeats(outcome: String) async throws {
    let scope = UUID().uuidString
    let source = pod()
    let model = PodRepairModel(kind: .rework, scope: scope); model.ordinaryRework = true
    let counter = ReworkPendingFixture()
    var actions = PodRepairActions(scope: scope, submit: { _, _, _ in
      Issue.record("Must use versioned transport"); throw URLError(.unsupportedURL)
    }, inspect: { _ in PodRepairObservation(source: source, related: []) })
    let projection = try eligibility()
    actions.loadReworkEligibility = { _ in projection }
    actions.submitRework = { _, request in
      counter.submissions += 1
      #expect(request.guidance == "Keep existing edits")
      #expect(request.generation == 2)
      if outcome == "rejected" { throw DaemonError.serverError(409, "Lifecycle changed") }
      throw DaemonError.networkError("Response dropped")
    }
    await model.prepareRework(id: source.id, actions: actions, draftScope: scope)
    model.guidance = "Keep existing edits"
    await model.submit(id: source.id, actions: actions)
    #expect(counter.submissions == 1 && model.guidance == "Keep existing edits")
    #expect(model.uncertain == (outcome == "dropped"))
    let reopened = PodRepairModel(kind: .rework, scope: scope); reopened.ordinaryRework = true
    await reopened.prepareRework(id: source.id, actions: actions, draftScope: scope)
    #expect(reopened.guidance == "Keep existing edits")
    if outcome == "dropped" {
      await reopened.submit(id: source.id, actions: actions)
      #expect(counter.submissions == 1)
    }
    var changed = actions
    changed = PodRepairActions(scope: "other-daemon", submit: changed.submit, inspect: changed.inspect)
    await model.submit(id: source.id, actions: changed)
    #expect(counter.submissions == 1)
    UserDefaults.standard.removeObject(forKey: "autopod.rework-v1.\(scope).\(source.id).worker")
    UserDefaults.standard.removeObject(forKey: "autopod.rework-v1.\(scope).\(source.id).worker.rejected")
  }
  @Test func legacyPendingDecisionRemainsVisibleWhenEligibilityIsUnavailable() async throws {
    let scope = UUID().uuidString
    let source = pod()
    let key = RetryAuthorizationDraft.key(scope: scope, podId: source.id, stage: "worker")
    try RetryAuthorizationDraft.save(TaskRetryAuthorizationRequest(requestKey: "legacy-key", reason: "Inspected earlier work", stage: "worker"), key: key)
    defer { RetryAuthorizationDraft.clear(key) }
    let model = PodRepairModel(kind: .rework, scope: scope, ordinaryRework: true)
    var actions = PodActions(); actions.retryDraftScope = scope
    actions.repair = PodRepairActions(scope: scope, submit: { _, _, _ in
      Issue.record("No execution"); throw URLError(.unsupportedURL)
    }, inspect: { _ in PodRepairObservation(source: source, related: []) })
    actions.repair.loadReworkEligibility = { _ in throw DaemonError.networkError("Unavailable") }
    let state = try JSONDecoder().decode(TaskRetryState.self, from: Data(#"{"taskId":"task","stage":"worker","admissionCount":1,"executedCount":1,"transientRetryCount":0,"interruptedCount":0,"latest":{"id":"inspected-failure","outcome":"unknown"},"authorizations":[],"telemetry":"partial"}"#.utf8))
    actions.loadRetryState = { _, _ in state }
    let host = LaunchComposerHost(PodRepairSheet(isPresented: .constant(true), pod: source, kind: .rework,
      relatedPods: [], actions: actions, model: model), width: 1120)
    defer { host.close() }
    try await host.wait { host.has("repair-inspect-retry-decision") && !model.eligibilityLoading }
    #expect(!model.canSubmit && host.has("repair-authorize-retry"))
    #expect(!host.enabled("repair-authorize-retry"))
    await model.inspectRetryDecision(id: source.id, actions: actions)
    model.bindLegacyDecisionToInspectedFailure()
    #expect(model.authorizationPending?.requestKey == "legacy-key")
    #expect(model.authorizationPending?.expectedFailureId == "inspected-failure")
    #expect(try RetryAuthorizationDraft.load(key)?.expectedFailureId == "inspected-failure")
    #expect(!model.canSubmit)
  }

  @Test func authorizationIsFailureBoundAndSeparateFromConcurrentReworkSubmits() async throws {
    let scope = UUID().uuidString
    let source = pod()
    let holder = ReworkPendingFixture()
    let model = PodRepairModel(kind: .rework, scope: scope); model.ordinaryRework = true
    var actions = PodActions(); actions.retryDraftScope = scope
    actions.repair = PodRepairActions(scope: scope, submit: { _, _, _ in
      Issue.record("No legacy execution"); throw URLError(.unsupportedURL)
    }, inspect: { _ in PodRepairObservation(source: source, related: []) })
    let needed = try eligibility("authorization_needed")
    let available = try eligibility("grant_recorded")
    actions.repair.loadReworkEligibility = { _ in holder.authorized ? available : needed }
    let grant = try JSONDecoder().decode(TaskRetryAuthorization.self, from: Data(#"{"id":"grant","requestKey":"stable","failureId":"failure","reason":"Inspected","createdAt":"now","usedByAttemptId":null}"#.utf8))
    actions.authorizeRetry = { _, request in
      #expect(request.expectedFailureId == "failure" && request.stage == "worker")
      #expect(request.reason == "Inspected partial work")
      holder.authorizations += 1; holder.authorized = true
      return grant
    }
    actions.repair.submitRework = { _, _ in
      holder.submissions += 1
      await withCheckedContinuation { holder.pending = $0 }
      throw DaemonError.networkError("Response lost")
    }
    await model.prepareRework(id: source.id, actions: actions.repair, draftScope: scope)
    #expect(!model.canSubmit)
    model.retryReason = "Inspected partial work"
    await model.authorize(id: source.id, actions: actions)
    #expect(holder.authorizations == 1 && holder.submissions == 0 && model.canSubmit)
    let submission = Task { await model.submit(id: source.id, actions: actions.repair) }
    for _ in 0..<200 {
      if holder.pending != nil { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(holder.pending != nil)
    await model.submit(id: source.id, actions: actions.repair)
    #expect(holder.submissions == 1)
    holder.pending?.resume(); holder.pending = nil
    await submission.value
    #expect(model.uncertain && !model.canSubmit)
    UserDefaults.standard.removeObject(forKey: "autopod.rework-v1.\(scope).\(source.id).worker")
  }

}

@MainActor private final class ReworkPendingFixture {
  var authorizations = 0
  var submissions = 0
  var authorized = false
  var pending: CheckedContinuation<Void, Never>?
}
