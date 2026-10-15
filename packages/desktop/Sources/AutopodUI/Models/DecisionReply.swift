import Foundation

public enum DecisionReplyOutcome: Sendable, Equatable {
  case acknowledged
  case unconfirmed
  case notAdmitted
}

public struct DecisionReplySnapshot: Sendable {
  public var text: String = ""
  public var canEdit = false
  public var canSubmit = false
  public var pending = false
  public var acknowledged = false
  public var notice: String?

  public init() {}
}

public enum DecisionReplyPreparation: Sendable, Equatable {
  case ready
  case unavailable(String)
}

/// Decision replies have a result and a synchronously admitted, independently owned task.
/// Legacy paused guidance continues to use PodActions.reply.
public struct DecisionReplyActions: Sendable {
  public var contextID: UUID
  public var pod: @MainActor @Sendable (String) -> Pod?
  public var snapshot: @MainActor @Sendable (String, String?) -> DecisionReplySnapshot
  public var edit: @MainActor @Sendable (String, String, String) -> Void
  public var discard: @MainActor @Sendable (String, String) -> Void
  public var prepare: @MainActor @Sendable (String) async -> DecisionReplyPreparation
  public var submit: @MainActor @Sendable (String, String) -> Task<DecisionReplyOutcome, Never>

  public init(
    contextID: UUID = UUID(),
    pod: @escaping @MainActor @Sendable (String) -> Pod? = { _ in nil },
    snapshot: @escaping @MainActor @Sendable (String, String?) -> DecisionReplySnapshot = { _, _ in .init() },
    edit: @escaping @MainActor @Sendable (String, String, String) -> Void = { _, _, _ in },
    discard: @escaping @MainActor @Sendable (String, String) -> Void = { _, _ in },
    prepare: @escaping @MainActor @Sendable (String) async -> DecisionReplyPreparation = { _ in .unavailable("Connect to load this question.") },
    submit: @escaping @MainActor @Sendable (String, String) -> Task<DecisionReplyOutcome, Never> = { _, _ in Task { .notAdmitted } }
  ) {
    self.contextID = contextID
    self.pod = pod
    self.snapshot = snapshot
    self.edit = edit
    self.discard = discard
    self.prepare = prepare
    self.submit = submit
  }
}
