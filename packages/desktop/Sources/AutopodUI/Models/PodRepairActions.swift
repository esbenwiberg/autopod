import AutopodClient
import Foundation
import Observation

public enum PodRepairKind: String, Sendable, Identifiable, CaseIterable {
  case manual, rework, revalidate, resume, prFix
  public var id: String { rawValue }
  public var title: String {
    switch self { case .manual: "Fix manually"; case .rework: "Rework task"; case .revalidate: "Revalidate only"; case .resume: "Resume delivery"; case .prFix: "Send PR feedback" }
  }
}
public struct PodRepairReceipt: Sendable {
  public let message: String
  public let podID: String?
  public let unreadFeedback: Int?
  public init(message: String, podID: String? = nil, unreadFeedback: Int? = nil) {
    self.message = message; self.podID = podID; self.unreadFeedback = unreadFeedback
  }
}
public struct PodRepairObservation: Sendable {
  public let source: Pod
  public let related: [Pod]
  public init(source: Pod, related: [Pod]) { self.source = source; self.related = related }
}
public struct PodRepairActions: Sendable {
  public let scope: String
  public var loadReworkEligibility: @MainActor @Sendable (String) async throws -> ReworkEligibility = { _ in throw URLError(.unsupportedURL) }
  public var submitRework: @MainActor @Sendable (String, ReworkRequest) async throws -> ReworkRequestReceipt = { _, _ in throw URLError(.unsupportedURL) }
  public var inspectRework: @MainActor @Sendable (String, String) async throws -> ReworkRequestReceipt = { _, _ in throw URLError(.unsupportedURL) }
  public var submit: @MainActor @Sendable (String, PodRepairKind, String?) async throws -> PodRepairReceipt
  public var inspect: @MainActor @Sendable (String) async throws -> PodRepairObservation
  public init(scope: String = "", submit: @escaping @MainActor @Sendable (String, PodRepairKind, String?) async throws -> PodRepairReceipt,
    inspect: @escaping @MainActor @Sendable (String) async throws -> PodRepairObservation) {
    self.scope = scope; self.submit = submit; self.inspect = inspect
  }
  public static let unavailable = Self(submit: { _, _, _ in throw DaemonError.networkError("Repair actions are unavailable on this connection.") },
    inspect: { _ in throw DaemonError.networkError("Connect to refresh the source pod.") })
}

/// Non-idempotent controls never automatically retry after an ambiguous response.
@Observable @MainActor internal final class PodRepairModel {
  var kind: PodRepairKind
  private var scope: String?
  var feedback = ""
  var guidance = ""
  var retryReason = ""
  private(set) var eligibility: ReworkEligibility?
  private(set) var eligibilityLoading = false
  private(set) var authorizationMessage: String?
  private(set) var authorizationPending: TaskRetryAuthorizationRequest?
  private(set) var reworkDraft: ReworkRequest?
  private var reworkSettled = false
  private var reworkRejected = false
  var canReviewAnotherAttempt: Bool {
    guard !busy, let observation else { return false }
    if reworkDraft == nil { return true }
    return reworkRejected || (reworkSettled && [.failed, .reviewRequired, .killed, .validated].contains(observation.source.status))
  }
  private(set) var authorizationRejected = false
  func discardRejectedAuthorization() {
    guard !busy, authorizationRejected, let authorizationKey else { return }
    RetryAuthorizationDraft.clear(authorizationKey); authorizationPending = nil; authorizationRejected = false
  }
  var ordinaryRework = false
  private var draftKey: String?
  private var authorizationKey: String?
  var canSubmit: Bool {
    !busy && !uncertain && receipt == nil && (!ordinaryRework || kind != .rework || (eligibility?.eligible == true && !eligibilityLoading && authorizationPending == nil))
  }
  func prepareRework(id: String, actions: PodRepairActions, draftScope: String) async {
    guard bind(actions) else { return }
    draftKey = "autopod.rework-v1.\(draftScope).\(id).worker"
    authorizationKey = RetryAuthorizationDraft.key(scope: draftScope, podId: id, stage: "worker")
    if let key = draftKey, let data = UserDefaults.standard.data(forKey: key) {
      do {
        let draft = try JSONDecoder().decode(ReworkRequest.self, from: data)
        reworkDraft = draft; guidance = draft.guidance; reworkRejected = UserDefaults.standard.bool(forKey: key + ".rejected"); uncertain = !reworkRejected
      } catch { uncertain = true; self.error = "Saved Rework request is unreadable; inspect the pod before continuing." }
    }
    if let key = authorizationKey {
      do {
        authorizationPending = try RetryAuthorizationDraft.load(key); retryReason = authorizationPending?.reason ?? ""
        if let pending = authorizationPending, pending.expectedFailureId == nil {
          self.error = "A legacy retry decision is pending without a displayed failure binding. Inspect retry accounting before resolving that decision."
        }
      }
      catch { uncertain = true; self.error = "Saved retry decision is unreadable." }
    }
    await refreshEligibility(id: id, actions: actions)
  }
  func refreshEligibility(id: String, actions: PodRepairActions) async {
    guard !busy, !eligibilityLoading, bind(actions) else { return }
    eligibilityLoading = true; eligibility = nil
    defer { eligibilityLoading = false }
    do { eligibility = try await actions.loadReworkEligibility(id) }
    catch { self.error = "Rework eligibility unavailable: \(error.localizedDescription). A compatible daemon is required." }
  }
  func authorize(id: String, actions: PodActions) async {
    guard ordinaryRework, kind == .rework, !busy, !eligibilityLoading, bind(actions.repair),
      authorizationPending == nil || authorizationPending?.expectedFailureId != nil,
      let key = authorizationKey,
      authorizationPending != nil || eligibility?.status == "authorization_needed",
      let failureId = authorizationPending?.expectedFailureId ?? eligibility?.failureId,
      !retryReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    busy = true; error = nil
    do {
      let draft = authorizationPending ?? TaskRetryAuthorizationRequest(requestKey: UUID().uuidString,
        reason: retryReason.trimmingCharacters(in: .whitespacesAndNewlines), stage: "worker", expectedFailureId: failureId)
      try RetryAuthorizationDraft.save(draft, key: key); authorizationPending = draft
      _ = try await actions.authorizeRetry(id, draft)
      RetryAuthorizationDraft.clear(key); authorizationPending = nil; retryReason = ""
      authorizationMessage = "One retry authorization recorded. Rework is a separate action."
    } catch { authorizationRejected = FollowUpFailure.isDefiniteRejection(error); self.error = error.localizedDescription }
    busy = false
    await refreshEligibility(id: id, actions: actions.repair)
  }
  private(set) var busy = false
  private(set) var uncertain = false
  private(set) var receipt: PodRepairReceipt?
  private(set) var observation: PodRepairObservation?
  private(set) var error: String?
  init(kind: PodRepairKind, scope: String? = nil, ordinaryRework: Bool = false) { self.kind = kind; self.scope = scope; self.ordinaryRework = ordinaryRework }
  func submit(id: String, actions: PodRepairActions) async {
    guard canSubmit else { return }
    guard bind(actions) else { return }
    busy = true; error = nil; observation = nil
    defer { busy = false }
    do {
      if ordinaryRework && kind == .rework {
        guard let eligibility, let draftKey else { throw URLError(.unsupportedURL) }
        let draft = ReworkRequest(requestKey: UUID().uuidString, generation: eligibility.generation, guidance: guidance)
        UserDefaults.standard.set(try JSONEncoder().encode(draft), forKey: draftKey)
        reworkDraft = draft; reworkRejected = false
        UserDefaults.standard.removeObject(forKey: draftKey + ".rejected")
        let result = try await actions.submitRework(id, draft)
        receipt = PodRepairReceipt(message: result.error.map { "Request recorded; dispatch failed: \($0). Guidance remains saved." } ?? "Rework request accepted. Inspect observed state for provisioning and worker execution. Guidance remains queued until the worker acknowledges receipt; acknowledgment does not prove it was applied.")
        return
      }
      receipt = try await actions.submit(id, kind, feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : feedback) }
    catch {
      uncertain = !FollowUpFailure.isDefiniteRejection(error)
      if ordinaryRework && kind == .rework, let draftKey {
        reworkRejected = !uncertain
        UserDefaults.standard.set(reworkRejected, forKey: draftKey + ".rejected")
      }
      self.error = error.localizedDescription
    }
  }
  func inspect(id: String, actions: PodRepairActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; error = nil
    defer { busy = false }
    do {
      observation = try await actions.inspect(id)
      if ordinaryRework, let draft = reworkDraft {
        let result = try await actions.inspectRework(id, draft.requestKey)
        receipt = PodRepairReceipt(message: result.error.map { "Request recorded; dispatch failed: \($0). Guidance remains saved." } ?? (result.settledAt == nil ? "Request recorded; dispatch outcome unresolved. Inspect pod state. Execution will not be replayed." : "Rework dispatch completed. Inspect observed worker state; guidance acknowledgment is separate."))
        reworkSettled = result.settledAt != nil
        uncertain = false
      }
    }
    catch { self.error = error.localizedDescription }
  }
  private func bind(_ actions: PodRepairActions) -> Bool {
    if let scope, scope != actions.scope { error = "Connection changed. Close this handoff and reopen it on the current daemon."; return false }
    scope = actions.scope; return true
  }
  /// Only a deliberate operator decision after inspection permits another attempt.
  func reviewAnotherAttempt() {
    guard canReviewAnotherAttempt else { return }
    if let draftKey {
      UserDefaults.standard.removeObject(forKey: draftKey)
      UserDefaults.standard.removeObject(forKey: draftKey + ".rejected")
    }
    reworkDraft = nil; reworkSettled = false; reworkRejected = false; eligibility = nil
    uncertain = false; receipt = nil; error = nil
  }
}
