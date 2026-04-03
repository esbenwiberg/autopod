import Foundation

/// Closure-based action dispatch for session operations.
/// Views call these; the app layer provides real implementations.
/// All closures default to no-ops so previews work without wiring.
public struct SessionActions: Sendable {
  public var approve: @MainActor @Sendable (String) async -> Void
  public var reject: @MainActor @Sendable (String, String?) async -> Void
  public var reply: @MainActor @Sendable (String, String) async -> Void
  public var nudge: @MainActor @Sendable (String) async -> Void
  public var kill: @MainActor @Sendable (String) async -> Void
  public var complete: @MainActor @Sendable (String) async -> Void
  public var pause: @MainActor @Sendable (String) async -> Void
  public var rework: @MainActor @Sendable (String) async -> Void
  public var fixManually: @MainActor @Sendable (String) async -> String?
  public var revalidate: @MainActor @Sendable (String) async -> Void
  public var createSession: @MainActor @Sendable (String, String, String, String?, [String]?, String?, String?) async -> String?
  // createSession params: profileName, task, model, outputMode, acceptanceCriteria, baseBranch, acFrom → returns session ID or nil
  public var attachTerminal: @MainActor @Sendable (String) -> Void
  public var approveAll: @MainActor @Sendable () async -> Void
  public var killAllFailed: @MainActor @Sendable () async -> Void

  public init(
    approve: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    reject: @escaping @MainActor @Sendable (String, String?) async -> Void = { _, _ in },
    reply: @escaping @MainActor @Sendable (String, String) async -> Void = { _, _ in },
    nudge: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    kill: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    complete: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    pause: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    rework: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    fixManually: @escaping @MainActor @Sendable (String) async -> String? = { _ in nil },
    revalidate: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    createSession: @escaping @MainActor @Sendable (String, String, String, String?, [String]?, String?, String?) async -> String? = { _, _, _, _, _, _, _ in nil },
    attachTerminal: @escaping @MainActor @Sendable (String) -> Void = { _ in },
    approveAll: @escaping @MainActor @Sendable () async -> Void = {},
    killAllFailed: @escaping @MainActor @Sendable () async -> Void = {}
  ) {
    self.approve = approve
    self.reject = reject
    self.reply = reply
    self.nudge = nudge
    self.kill = kill
    self.complete = complete
    self.pause = pause
    self.rework = rework
    self.fixManually = fixManually
    self.revalidate = revalidate
    self.createSession = createSession
    self.attachTerminal = attachTerminal
    self.approveAll = approveAll
    self.killAllFailed = killAllFailed
  }

  /// No-op instance for previews
  public static let preview = SessionActions()
}
