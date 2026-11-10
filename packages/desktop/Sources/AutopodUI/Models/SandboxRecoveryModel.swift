import AutopodClient
import Foundation
import Observation

/// Start and loss-accepting abandonment are different decisions. Preserve each exact
/// request across navigation/restart; an unknown Start can never authorize another Start.
@MainActor @Observable final class SandboxRecoveryModel {
  let podId: String
  private let scope: String
  private let draftScope: String
  private let directory: URL
  private let startJournal: RepairContinuationJournal<SandboxRecoveryRequest>
  private var loadedJournal = false
  private var invalidJournal = false
  private var rejectedRequest: SandboxRecoveryRequest?
  var reason = ""
  var acknowledgeLoss = false
  private(set) var snapshot: SandboxRecoveryState?
  private(set) var pendingStart: SandboxRecoveryRequest?
  private(set) var pendingAbandons: [String: SandboxRecoveryRequest] = [:]
  var pendingAbandon: SandboxRecoveryRequest? { pendingAbandons.values.sorted { $0.id < $1.id }.first }
  private(set) var busy = false
  private(set) var error: String?
  private(set) var notice: String?
  private(set) var podDeleted = false

  var pending: SandboxRecoveryRequest? { pendingAbandon ?? pendingStart }
  var recordedPending: SandboxRecoveryReceipt? {
    snapshot?.operations.last { $0.completedAt == nil }
  }

  init(podId: String, actions: SandboxRecoveryActions) {
    self.podId = podId; scope = actions.scope; draftScope = actions.draftScope
    let directory = actions.journalDirectory ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".autopod/sandbox-recovery", isDirectory: true)
    self.directory = directory
    startJournal = RepairContinuationJournal(scope: actions.draftScope + "\0start", podId: podId, directory: directory)
  }

  private var validReason: Bool {
    (10...4000).contains(reason.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
  }

  func canStart(_ resource: SandboxRecoveryResource) -> Bool {
    pending == nil && recordedPending == nil && !invalidJournal && error == nil && validReason
      && SandboxRecoveryControlPolicy.canStart(resource, reason: reason, busy: busy)
  }

  func canAbandon(_ resource: SandboxRecoveryResource) -> Bool {
    guard !invalidJournal, error == nil, let snapshot else { return false }
    if let pendingAbandon = pendingAbandons[resource.resourceKey] {
      guard pendingAbandon.sandboxId == resource.sandboxId else { return false }
    } else {
      let continuingOwnDecision = resource.abandonment.map { $0.userId == snapshot.currentUserId } ?? false
      if !continuingOwnDecision && !validReason { return false }
    }
    // An unknown Start is NOT replayed or cleared. A separate explicit loss decision
    // can still be reviewed if this exact resource's owning policy permits deletion.
    return SandboxRecoveryControlPolicy.canAbandon(resource, currentUserId: snapshot.currentUserId,
      reason: pendingAbandons[resource.resourceKey]?.reason ?? reason, acceptsLoss: acknowledgeLoss, busy: busy)
  }

  var canDiscardRejected: Bool {
    guard !busy, !invalidJournal, let rejectedRequest, let snapshot else { return false }
    return !snapshot.operations.contains { $0.id == rejectedRequest.id }
      && !snapshot.resources.contains { !$0.pendingIntentIds.isEmpty }
  }

  func refresh(_ actions: SandboxRecoveryActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; error = nil; snapshot = nil
    defer { busy = false }
    do {
      if !loadedJournal {
        do {
          pendingStart = try startJournal.load()
          guard pendingStart == nil || pendingStart?.action == "start" else {
            throw DaemonError.badRequest("Saved decision has an unexpected action. Preserve it for inspection.")
          }
          if let pending { reason = pending.reason; acknowledgeLoss = pending.acknowledgeDataLoss }
          loadedJournal = true
        } catch { invalidJournal = true; throw error }
      }
      let value = try await actions.load(podId)
      guard bind(actions), !Task.isCancelled else { return }
      guard value.podId == podId else { throw DaemonError.decodingError("Recovery observation belongs to another pod.") }
      snapshot = value
      // Only current-generation, exact-resource decisions are resumable. Older
      // immutable journals stay on disk and server history remains visible; a
      // changed selection needs a fresh reason, loss acknowledgement and confirmation.
      do {
        var current: [String: SandboxRecoveryRequest] = [:]
        for resource in value.resources {
          if let decision = try abandonmentJournal(generation: value.generation, resourceKey: resource.resourceKey).load() {
            guard decision.action == "abandon", decision.expectedGeneration == value.generation,
              decision.expectedResourceKey == resource.resourceKey, decision.sandboxId == resource.sandboxId else {
              throw DaemonError.badRequest("Saved deletion does not match this exact selection.")
            }
            current[resource.resourceKey] = decision
          }
        }
        let selectionChanged = !pendingAbandons.isEmpty && current != pendingAbandons
        pendingAbandons = current
        if selectionChanged && current.isEmpty { reason = ""; acknowledgeLoss = false }
        if let pendingAbandon {
          if reason.isEmpty { reason = pendingAbandon.reason }
          acknowledgeLoss = pendingAbandon.acknowledgeDataLoss
        }
        try loadRejectionEvidence()
      } catch { invalidJournal = true; throw error }
      if let pendingStart,
         value.operations.contains(where: { matches($0, pendingStart) && $0.completedAt != nil }) {
        try clearDecision(pendingStart)
        notice = "Machine start confirmed. The coding agent was not resumed."
      }
    } catch {
      guard bind(actions), !Task.isCancelled else { return }
      self.error = "Could not check the original environment: \(error.localizedDescription). No recovery or deletion was performed by this inspection."
    }
  }

  func submit(_ resource: SandboxRecoveryResource, action: String, actions: SandboxRecoveryActions) async {
    guard bind(actions), let snapshot,
      action == "start" ? canStart(resource) : action == "abandon" && canAbandon(resource) else { return }
    let request: SandboxRecoveryRequest
    if action == "abandon", let pendingAbandon = pendingAbandons[resource.resourceKey] { request = pendingAbandon }
    else if action == "abandon", let prior = resource.abandonment,
      prior.userId == snapshot.currentUserId { request = SandboxRecoveryRequest(abandonment: prior) }
    else {
      request = SandboxRecoveryRequest(action: action, sandboxId: resource.sandboxId,
        expectedGeneration: snapshot.generation, expectedResourceKey: resource.resourceKey,
        reason: reason.trimmingCharacters(in: .whitespacesAndNewlines),
        acknowledgeDataLoss: action == "abandon" && acknowledgeLoss)
    }
    do {
      try journal(for: request).save(request)
      if action == "start" { pendingStart = request } else { pendingAbandons[resource.resourceKey] = request }
    } catch { invalidJournal = true; self.error = "Could not save this decision; nothing was sent: \(error.localizedDescription)"; return }
    busy = true; error = nil; notice = nil
    do {
      let result = try await actions.submit(podId, request)
      guard bind(actions), !Task.isCancelled else { busy = false; return }
      guard matches(result.operation, request),
        !result.podDeleted || (request.action == "abandon" && result.operation.completedAt != nil) else {
        throw DaemonError.networkError("Uncorrelated recovery receipt. Observe the saved decision.")
      }
      rejectedRequest = nil
      if result.podDeleted { try clearDecision(request); podDeleted = true }
      else if action == "start", result.operation.completedAt != nil {
        try clearDecision(request); notice = "Machine start confirmed. The coding agent was not resumed."
      } else if action == "abandon", result.operation.completedAt != nil {
        notice = result.cleanupError.map { "Environment deleted; pod cleanup is still blocked: \($0)" }
          ?? "Environment deletion confirmed. Pod cleanup is not confirmed."
      } else {
        notice = "Decision recorded. Check status for the confirmed outcome."
      }
    } catch {
      guard bind(actions), !Task.isCancelled else { busy = false; return }
      if FollowUpFailure.isDefiniteRejection(error) {
        do { try rejectionJournal(for: request).save(request); rejectedRequest = request }
        catch { invalidJournal = true }
      }
      self.error = "\(error.localizedDescription) Outcome unconfirmed. Check status; do not create another request."
    }
    busy = false
    let priorError = error
    if !podDeleted { await refresh(actions) }
    if let priorError { error = priorError }
  }

  /// A definite rejection plus fresh absence of any resume intent allows an explicit new decision.
  func discardRejected(_ actions: SandboxRecoveryActions) async {
    guard bind(actions), canDiscardRejected, let rejectedRequest else { return }
    do { try clearDecision(rejectedRequest); self.rejectedRequest = nil; await refresh(actions) }
    catch { self.error = error.localizedDescription }
  }

  private func abandonmentJournal(generation: Int, resourceKey: String) -> RepairContinuationJournal<SandboxRecoveryRequest> {
    RepairContinuationJournal(scope: draftScope + "\0abandon\0\(generation)\0" + resourceKey, podId: podId, directory: directory)
  }

  private func journal(for request: SandboxRecoveryRequest) -> RepairContinuationJournal<SandboxRecoveryRequest> {
    request.action == "start" ? startJournal
      : abandonmentJournal(generation: request.expectedGeneration, resourceKey: request.expectedResourceKey)
  }

  /// Rejection evidence is separate from the immutable request body and bound to its exact ID/body.
  private func rejectionJournal(for request: SandboxRecoveryRequest) -> RepairContinuationJournal<SandboxRecoveryRequest> {
    RepairContinuationJournal(scope: draftScope + "\0rejected\0" + request.id, podId: podId, directory: directory)
  }

  private func loadRejectionEvidence() throws {
    rejectedRequest = nil
    for request in Array(pendingAbandons.values) + [pendingStart].compactMap({ $0 }) {
      if let evidence = try rejectionJournal(for: request).load() {
        guard evidence == request else { throw DaemonError.badRequest("Rejection evidence does not match the saved decision.") }
        rejectedRequest = request
        return
      }
    }
  }

  private func matches(_ receipt: SandboxRecoveryReceipt, _ request: SandboxRecoveryRequest) -> Bool {
    receipt.id == request.id && receipt.podId == podId && receipt.action == request.action
      && receipt.sandboxId == request.sandboxId && receipt.resourceKey == request.expectedResourceKey
      && receipt.generation == request.expectedGeneration && receipt.reason == request.reason
  }

  private func clearDecision(_ request: SandboxRecoveryRequest) throws {
    let journal = journal(for: request)
    let rejection = rejectionJournal(for: request)
    let evidence = try rejection.load()
    guard evidence == nil || evidence == request else {
      throw DaemonError.badRequest("Different rejection evidence was retained. Reopen recovery.")
    }
    if let saved = try journal.load() {
      guard saved == request else { throw DaemonError.badRequest("A newer saved decision was not discarded. Reopen recovery.") }
      try FileManager.default.removeItem(at: journal.url)
    }
    if evidence != nil { try FileManager.default.removeItem(at: rejection.url) }
    if request.action == "start" { pendingStart = nil }
    else if pendingAbandons[request.expectedResourceKey] == request { pendingAbandons.removeValue(forKey: request.expectedResourceKey) }
  }

  private func bind(_ actions: SandboxRecoveryActions) -> Bool {
    guard actions.available, actions.scope == scope, actions.isCurrent() else {
      snapshot = nil
      error = "Connection changed. Reopen recovery on the owning daemon; the saved decision was retained."
      return false
    }
    return true
  }
}
