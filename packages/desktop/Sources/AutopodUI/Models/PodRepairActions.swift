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
  private(set) var busy = false
  private(set) var uncertain = false
  private(set) var receipt: PodRepairReceipt?
  private(set) var observation: PodRepairObservation?
  private(set) var error: String?
  init(kind: PodRepairKind, scope: String? = nil) { self.kind = kind; self.scope = scope }
  func submit(id: String, actions: PodRepairActions) async {
    guard !busy, !uncertain, receipt == nil else { return }
    guard bind(actions) else { return }
    busy = true; error = nil; observation = nil
    defer { busy = false }
    do { receipt = try await actions.submit(id, kind, feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : feedback) }
    catch {
      uncertain = !FollowUpFailure.isDefiniteRejection(error)
      self.error = error.localizedDescription
    }
  }
  func inspect(id: String, actions: PodRepairActions) async {
    guard !busy, bind(actions) else { return }
    busy = true; error = nil
    defer { busy = false }
    do { observation = try await actions.inspect(id) }
    catch { self.error = error.localizedDescription }
  }
  private func bind(_ actions: PodRepairActions) -> Bool {
    if let scope, scope != actions.scope { error = "Connection changed. Close this handoff and reopen it on the current daemon."; return false }
    scope = actions.scope; return true
  }
  /// Only a deliberate operator decision after inspection permits another attempt.
  func reviewAnotherAttempt() {
    guard !busy, observation != nil else { return }
    uncertain = false; receipt = nil; error = nil
  }
}
