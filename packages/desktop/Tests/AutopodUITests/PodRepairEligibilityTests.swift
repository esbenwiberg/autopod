import AutopodClient
import Foundation
import SwiftUI
import Testing
@testable import AutopodUI

@Suite(.serialized) @MainActor struct PodRepairEligibilityTests {
  private func projection(code: String? = nil, eligible: Bool = true) throws -> ReworkEligibility {
    let object: [String: Any] = ["eligible": eligible, "status": eligible ? "eligible" : "blocked",
      "reason": "Authoritative lifecycle reason", "generation": 3,
      "code": code as Any? ?? NSNull()]
    return try JSONDecoder().decode(ReworkEligibility.self, from: JSONSerialization.data(withJSONObject: object))
  }

  @Test(arguments: [PodRepairKind.rework, .revalidate, .resume],
    ["INFRASTRUCTURE_BLOCKED", "DELIVERY_RECONCILIATION_REQUIRED", "CONTINUATION_SOURCE_HELD"])
  func lifecycleHoldBlocksEveryOrdinaryAction(kind: PodRepairKind, code: String) async throws {
    let model = PodRepairModel(kind: kind, ordinaryRework: true)
    let held = try projection(code: code, eligible: false)
    var actions = PodRepairActions(submit: { _, _, _ in
      Issue.record("Held recovery must not dispatch"); return PodRepairReceipt(message: "unexpected")
    }, inspect: { _ in throw URLError(.unsupportedURL) })
    actions.loadReworkEligibility = { _ in held }
    #expect(!model.canSubmit)
    await model.refreshEligibility(id: "synthetic", actions: actions)
    #expect(model.recoveryBlock == held.reason)
    #expect(!model.canSubmit)
    model.ordinaryRework = false // Native Goal routing does not remove an infrastructure hold.
    #expect(!model.canSubmit)
    model.ordinaryRework = true
    await model.submit(id: "synthetic", actions: actions)
    #expect(model.receipt == nil)
    let pod = Pod(id: "synthetic", status: .failed, hasWorktree: true, branch: "synthetic",
      profileName: "fixture", task: "Repair synthetic source", model: "fixture", startedAt: .now)
    var podActions = PodActions()
    podActions.repair = actions
    let host = LaunchComposerHost(PodRepairSheet(isPresented: .constant(true), pod: pod,
      kind: kind, relatedPods: [], actions: podActions, model: model), width: 1120)
    defer { host.close() }
    try await host.wait { host.has("repair-submit") && !model.eligibilityLoading }
    #expect(!host.enabled("repair-submit"))
    #expect(!host.has("task-budget-save-continue"))
  }

  @Test(arguments: ["unchanged", "retargeted", "cancelled"])
  func pendingEligibilityOwnsTheActionAndCannotDispatchAfterCancellation(outcome: String) async throws {
    let model = PodRepairModel(kind: .revalidate, ordinaryRework: true)
    let eligible = try projection()
    let deferred = DeferredRepairEligibility()
    var submissions: [PodRepairKind] = []
    var submittedFeedback: [String?] = []
    var actions = PodRepairActions(submit: { _, kind, feedback in
      submissions.append(kind); submittedFeedback.append(feedback)
      return PodRepairReceipt(message: "Accepted")
    }, inspect: { _ in throw URLError(.unsupportedURL) })
    actions.loadReworkEligibility = { _ in eligible }
    await model.refreshEligibility(id: "synthetic", actions: actions)
    model.feedback = "Original confirmed feedback"
    actions.loadReworkEligibility = { _ in await deferred.load() }
    let submittedActions = actions
    let submission = Task { await model.submit(id: "synthetic", actions: submittedActions) }
    await deferred.waitForRequest()
    defer { submission.cancel(); deferred.release(eligible) }
    #expect(model.busy && !model.canSubmit && submissions.isEmpty)
    let pod = Pod(id: "synthetic", status: .failed, hasWorktree: true, branch: "synthetic",
      profileName: "fixture", task: "Repair source", model: "fixture", startedAt: .now)
    var podActions = PodActions(); podActions.repair = submittedActions
    let host = LaunchComposerHost(PodRepairSheet(isPresented: .constant(true), pod: pod,
      kind: .revalidate, relatedPods: [], actions: podActions, model: model), width: 1120)
    defer { host.close() }
    try await host.wait { host.has("repair-close") && host.has("repair-kind-resume") }
    #expect(!host.enabled("repair-close") && !host.enabled("repair-kind-resume"))
    model.feedback = "Changed while awaiting preflight"
    if outcome == "retargeted" { model.kind = .resume }
    if outcome == "cancelled" { submission.cancel() }
    deferred.release(eligible)
    await submission.value
    #expect(!model.busy)
    if outcome == "unchanged" {
      #expect(submissions == [.revalidate])
      #expect(submittedFeedback == ["Original confirmed feedback"])
    } else {
      #expect(submissions.isEmpty && model.receipt == nil)
    }
  }

  @Test(arguments: ["INFRASTRUCTURE_BLOCKED", "DELIVERY_RECONCILIATION_REQUIRED", "CONTINUATION_SOURCE_HELD"])
  func nonHeldFailureRefreshAndNetworkFailureRemainHonest(code: String) async throws {
    let model = PodRepairModel(kind: .resume, ordinaryRework: true)
    let nonHeld = try projection(code: "TASK_RETRY_AUTHORIZATION_REQUIRED", eligible: false)
    let held = try projection(code: code, eligible: false)
    var actions = PodRepairActions(submit: { _, _, _ in
      Issue.record("Changed or unavailable eligibility must stop submission")
      return PodRepairReceipt(message: "unexpected")
    }, inspect: { _ in throw URLError(.unsupportedURL) })
    actions.loadReworkEligibility = { _ in nonHeld }
    await model.refreshEligibility(id: "synthetic", actions: actions)
    #expect(model.canSubmit) // A Rework restriction does not prohibit Resume or Revalidate.
    model.kind = .revalidate
    #expect(model.canSubmit)
    model.kind = .rework
    #expect(!model.canSubmit)
    model.kind = .resume
    actions.loadReworkEligibility = { _ in held }
    await model.submit(id: "synthetic", actions: actions) // Rechecks admission before POST.
    #expect(!model.canSubmit && model.receipt == nil)
    actions.loadReworkEligibility = { _ in throw DaemonError.networkError("Disconnected") }
    await model.refreshEligibility(id: "synthetic", actions: actions)
    #expect(model.eligibility == nil && !model.canSubmit && model.error != nil)
    actions.loadReworkEligibility = { _ in nonHeld }
    await model.refreshEligibility(id: "synthetic", actions: actions)
    #expect(model.canSubmit)
  }
}

@MainActor private final class DeferredRepairEligibility {
  private var pending: CheckedContinuation<ReworkEligibility, Never>?
  private var requested: CheckedContinuation<Void, Never>?
  func load() async -> ReworkEligibility {
    await withCheckedContinuation {
      pending = $0; requested?.resume(); requested = nil
    }
  }
  func waitForRequest() async {
    if pending != nil { return }
    await withCheckedContinuation { requested = $0 }
  }
  func release(_ eligibility: ReworkEligibility) {
    pending?.resume(returning: eligibility); pending = nil
  }
}
