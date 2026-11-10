import AutopodClient
import Foundation
import Observation

enum RecoveryRoute: String, CaseIterable {
  case overview, continueWork, recoverFiles, freeStorage, repair, stalled, finalization, checks, freshPod
}

func repairProgressDescription(_ state: RepairContinuationStateV1) -> String {
  switch state {
  case .claimed: "Repair decision recorded — not yet executed"
  case .preparing: "Preparing the selected source"
  case .provisioning: "Creating the replacement environment"
  case .qualifying: "Testing the actual replacement before coding"
  case .qualified: "Replacement qualified — coding completion not confirmed"
  case .coding: "Coding continuation admitted"
  case .sealing: "Saving the coding continuation's final source"
  case .checking: "Running fresh checks"
  case .validated: "Fresh checks passed — separate human approval is still required"
  case .failed: "Repair attempt failed — original resources remain retained"
  case .unknown: "Repair outcome could not be verified — check the saved decision"
  }
}

/// A display composition, never a source of mutation permission. Each owning controller
/// still refreshes and binds its own exact resource/source/request before taking action.
@MainActor @Observable final class RecoveryHubModel {
  let repair: RepairContinuationModel
  let stalled: StalledWorkerRecoveryModel
  let finalization: RetainedFinalizationModel
  let sandbox: SandboxRecoveryModel
  let files: FileRecoveryModel
  let fork: RecoveryForkModel
  private(set) var refreshing = false
  private(set) var inspected = false
  private(set) var checkedAt: Date?
  private var inspectingFork = false
  private var inspectingSandbox = false
  private var inspectingRepair = false
  private var inspectingStalled = false
  private var inspectingFinalization = false

  init(podId: String, actions: PodActions) {
    repair = RepairContinuationModel(podId: podId, actions: actions.repairContinuation)
    stalled = StalledWorkerRecoveryModel(podId: podId, actions: actions.stalledWorkerRecovery)
    finalization = RetainedFinalizationModel(podId: podId, actions: actions.retainedFinalization)
    sandbox = SandboxRecoveryModel(podId: podId, actions: actions.sandboxRecovery)
    files = FileRecoveryModel(podId: podId, actions: actions.fileRecovery)
    fork = RecoveryForkModel(podId: podId, actions: actions.recoveryFork)
  }

  static func scope(_ actions: PodActions) -> String {
    [actions.sandboxRecovery.scope, actions.repairContinuation.scope,
     actions.retainedFinalization.scope, actions.stalledWorkerRecovery.scope, actions.fileRecovery.scope, actions.recoveryFork.scope]
      .map { "\($0.utf8.count):\($0)" }.joined()
  }

  static func available(_ actions: PodActions, workspace: Bool) -> Bool {
    actions.fileRecovery.available || actions.sandboxRecovery.available || (!workspace && (actions.recoveryFork.available || actions.repairContinuation.available
      || actions.retainedFinalization.available || actions.stalledWorkerRecovery.available))
  }

  static func canInspectSandbox(_ pod: Pod) -> Bool {
    [.failed, .reviewRequired, .validated, .complete, .killed].contains(pod.status)
  }

  var busy: Bool { refreshing || repair.busy || stalled.busy || finalization.busy || sandbox.busy || files.busy || fork.busy }

  var pendingRoute: RecoveryRoute? {
    if fork.needsObservation || fork.invalidJournal { return .freshPod }
    if repair.pending != nil && ![.validated, .failed].contains(repair.operation?.state) { return .repair }
    if stalled.pending != nil && stalled.receipt?.state != .settled { return .stalled }
    if finalization.pending != nil && finalization.receipt?.state != .finalized { return .finalization }
    if let pending = sandbox.pending { return pending.action == "abandon" ? .freeStorage : .recoverFiles }
    if let recorded = sandbox.recordedPending { return recorded.action == "abandon" ? .freeStorage : .recoverFiles }
    return nil
  }

  var hasRetention: Bool {
    sandbox.snapshot?.resources.contains { $0.providerState != "deleted" } == true
      || finalization.snapshot?.custody.isEmpty == false || repair.operation != nil || fork.operation != nil
  }

  var errors: [String] {
    [inspectingFork ? fork.error : nil, inspectingSandbox ? sandbox.error : nil, inspectingRepair ? repair.error : nil,
     inspectingStalled ? stalled.error : nil, inspectingFinalization ? finalization.error : nil].compactMap { $0 }
  }

  var observationsDisagree: Bool {
    let generations = [inspectingFork ? fork.inspection?.generation : nil, inspectingSandbox ? sandbox.snapshot?.generation : nil,
      inspectingRepair ? repair.snapshot?.generation : nil,
      inspectingStalled ? stalled.snapshot?.generation : nil,
      inspectingFinalization ? finalization.snapshot?.generation : nil,
      inspectingRepair ? repair.context?.retained?.inspection?.generation : nil].compactMap { $0 }
    return Set(generations).count > 1
  }

  var savedWork: String {
    guard !observationsDisagree else { return "Changed during inspection — check status again." }
    if contextIsCurrent && repair.context?.retained?.inspection?.prerequisites.sourcePreservationRecorded == true {
      return "A saved source checkpoint is recorded. Final files and reports may still be missing."
    }
    return "Complete file and report preservation has not been verified here. Keep the original environment."
  }

  var execution: String {
    guard !observationsDisagree else { return "Not verified for one current lifecycle." }
    if inspectingStalled && stalled.receipt?.state == .settled {
      return "The selected worker run is stopped and retained. This does not mean checks passed."
    }
    if contextIsCurrent && repair.context?.retained?.inspection?.prerequisites.workerSettlementRecorded == true {
      return "Worker stop is recorded. Validation can still have a separate execution hold."
    }
    return "Stop has not been verified here. A quiet or stopped machine is not proof that an old operation failed."
  }

  var storage: String {
    guard !observationsDisagree else { return "Retention needs a fresh status check." }
    let retained = sandbox.snapshot?.resources.filter { $0.providerState != "deleted" }.count ?? 0
    if retained > 0 { return "\(retained) retained sandbox environment\(retained == 1 ? "" : "s"). Storage charges may continue." }
    if hasRetention { return "Recovery resources remain retained. Stopping or finalizing does not free their storage." }
    return "No retained sandbox is confirmed by this inspection. Independent cloud assets are not inventoried here."
  }

  private var contextIsCurrent: Bool {
    guard inspected, !refreshing, inspectingRepair,
      let generation = repair.context?.retained?.inspection?.generation else { return false }
    return generation == repair.snapshot?.generation && !observationsDisagree
  }

  func invalidateObservation() { inspected = false; checkedAt = nil }

  func failureSummary(for pod: Pod) -> String? {
    if let failure = pod.validationChecks?.infrastructureFailure { return failure.executionSummary }
    if let checks = pod.validationChecks {
      let failed: [String] = [("setup", checks.setup), ("build", checks.build), ("tests", checks.tests),
        ("lint", checks.lint), ("security checks", checks.sast), ("required facts", checks.factValidation),
        ("independent review", checks.review)].compactMap { name, passed in passed == false ? name : nil }
      if !failed.isEmpty { return "Recorded checks did not pass: " + failed.joined(separator: ", ") + "." }
    }
    guard let error = pod.errorSummary, !error.isEmpty else { return nil }
    return error
  }

  func explanation(for pod: Pod) -> String {
    if pendingRoute != nil { return "An earlier recovery decision needs an outcome check before a new action." }
    if let child = fork.operation?.childPodId { return "A separate continuation pod is recorded: \(child). This original remains retained; inspect the linked pod for coding and check outcomes." }
    if fork.inspection?.lineage != nil { return "This pod continues a retained checkpoint. The original and its history remain separately available; task spending and retry limits are shared." }
    switch pod.status {
    case .failed: return "This task stopped before successful completion. Review what was saved and choose how to proceed."
    case .reviewRequired: return "Checks or review need attention. Inspect the failure before deciding whether to retry or repair."
    case .running: return "If this task has stopped progressing, inspect its execution before interrupting or retrying it."
    case .validated: return "Checks are recorded, but retained environments and delivery approval are separate decisions."
    case .complete, .killed: return "The task has ended. Retained environments can still hold unsaved files and incur storage charges."
    default: return "Review the recorded state before choosing a recovery action."
    }
  }

  /// Navigation is not authorization. An unresolved saved intent is surfaced first,
  /// and unrelated mutating workflows are not offered as a workaround.
  func canOpen(_ route: RecoveryRoute) -> Bool {
    guard !busy else { return false }
    if let pendingRoute {
      // A separately confirmed data-loss decision may discard an unknown sandbox
      // Start, when its owning policy allows it. It is never a replay or a retry.
      return route == pendingRoute || route == .overview
        || (pendingRoute == .recoverFiles && route == .freeStorage)
    }
    return !observationsDisagree || route == .overview
  }

  func refresh(pod: Pod, actions: PodActions) async {
    // A lifecycle event can arrive while a child mutation is finishing. Keep the
    // same sheet/model and observe afterward, instead of destroying its outcome.
    while busy {
      do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
    }
    guard !Task.isCancelled else { return }
    refreshing = true; inspected = false
    inspectingFork = !pod.isWorkspace && actions.recoveryFork.available
      && ([.failed, .reviewRequired].contains(pod.status) || fork.needsObservation || fork.operation != nil)
    inspectingSandbox = actions.sandboxRecovery.available && Self.canInspectSandbox(pod)
    inspectingFinalization = !pod.isWorkspace && actions.retainedFinalization.available && Self.canInspectSandbox(pod)
    inspectingStalled = !pod.isWorkspace && actions.stalledWorkerRecovery.available
      && [.running, .failed, .reviewRequired].contains(pod.status)
    inspectingRepair = !pod.isWorkspace && actions.repairContinuation.available
      && [.failed, .reviewRequired, .validated].contains(pod.status)
    defer { refreshing = false }
    if inspectingFork { await fork.refresh(actions.recoveryFork) }
    guard !Task.isCancelled else { return }
    if inspectingSandbox {
      await sandbox.refresh(actions.sandboxRecovery)
    }
    guard !Task.isCancelled else { return }
    if !pod.isWorkspace {
      if inspectingFinalization {
        await finalization.refresh(actions.retainedFinalization)
      }
      guard !Task.isCancelled else { return }
      if inspectingStalled {
        await stalled.refresh(actions.stalledWorkerRecovery)
      }
      guard !Task.isCancelled else { return }
      if inspectingRepair {
        await repair.refresh(actions.repairContinuation)
      }
    }
    guard !Task.isCancelled else { return }
    if let generation = files.snapshot?.generation, let current = sandbox.snapshot?.generation, generation != current { files.invalidateObservation() }
    inspected = true; checkedAt = Date()
  }
}
