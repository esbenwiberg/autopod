import Foundation
import AutopodClient

/// Closure-based action dispatch for pod operations.
/// Views call these; the app layer provides real implementations.
/// All closures default to no-ops so previews work without wiring.
public struct PodActions: Sendable {
  public var approve: @MainActor @Sendable (String) async -> Void
  public var reject: @MainActor @Sendable (String, String?) async -> Void
  public var reply: @MainActor @Sendable (String, String) async -> Void
  public var nudge: @MainActor @Sendable (String, String) async -> Void
  public var kill: @MainActor @Sendable (String) async -> Void
  public var complete: @MainActor @Sendable (String) async -> Void
  public var pause: @MainActor @Sendable (String) async -> Void
  public var rework: @MainActor @Sendable (String) async -> Void
  public var fixManually: @MainActor @Sendable (String) async -> String?
  public var revalidate: @MainActor @Sendable (String) async -> Void
  public var createPod: @MainActor @Sendable (String, String, String?, PodConfigRequest?, [String]?, String?, String?, [PimGroupRequest]?) async -> String?
  // createPod params: profileName, task, model, pod, acceptanceCriteria, baseBranch, acFrom, pimGroups → returns pod ID or nil
  /// Promote an interactive pod to agent-driven in place. `targetOutput` ∈ {pr, branch, artifact, none}.
  public var promote: @MainActor @Sendable (String, String?) async -> Void
  public var attachTerminal: @MainActor @Sendable (String) -> Void
  public var approveAll: @MainActor @Sendable () async -> Void
  public var killAllFailed: @MainActor @Sendable () async -> Void
  public var extendAttempts: @MainActor @Sendable (String, Int) async -> Void
  public var extendPrAttempts: @MainActor @Sendable (String, Int) async -> Void
  public var fork: @MainActor @Sendable (String) async -> String?
  public var delete: @MainActor @Sendable (String) async -> Void
  public var createHistoryWorkspace: @MainActor @Sendable (String?, Int) async -> Void
  /// Start/restart the preview container and open the app URL
  public var openLiveApp: @MainActor @Sendable (String) async -> Void
  /// Look up the workerProfile for a given profile name (returns nil if not set)
  public var workerProfileForProfile: @MainActor @Sendable (String) -> String?
  /// Abort the currently running validation for the pod (no-op if not validating)
  public var interruptValidation: @MainActor @Sendable (String) async -> Void
  /// Enqueue a finding override — params: podId, findingId, description, action, reason?, guidance?
  public var addValidationOverride: @MainActor @Sendable (String, String, String, String, String?, String?) async -> Void
  /// Manually force-spawn a fix pod for a merge_pending pod, bypassing auto-detection guards
  public var spawnFix: @MainActor @Sendable (String) async -> Void

  public init(
    approve: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    reject: @escaping @MainActor @Sendable (String, String?) async -> Void = { _, _ in },
    reply: @escaping @MainActor @Sendable (String, String) async -> Void = { _, _ in },
    nudge: @escaping @MainActor @Sendable (String, String) async -> Void = { _, _ in },
    kill: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    complete: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    pause: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    rework: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    fixManually: @escaping @MainActor @Sendable (String) async -> String? = { _ in nil },
    revalidate: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    createPod: @escaping @MainActor @Sendable (String, String, String?, PodConfigRequest?, [String]?, String?, String?, [PimGroupRequest]?) async -> String? = { _, _, _, _, _, _, _, _ in nil },
    promote: @escaping @MainActor @Sendable (String, String?) async -> Void = { _, _ in },
    attachTerminal: @escaping @MainActor @Sendable (String) -> Void = { _ in },
    approveAll: @escaping @MainActor @Sendable () async -> Void = {},
    killAllFailed: @escaping @MainActor @Sendable () async -> Void = {},
    extendAttempts: @escaping @MainActor @Sendable (String, Int) async -> Void = { _, _ in },
    extendPrAttempts: @escaping @MainActor @Sendable (String, Int) async -> Void = { _, _ in },
    fork: @escaping @MainActor @Sendable (String) async -> String? = { _ in nil },
    delete: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    createHistoryWorkspace: @escaping @MainActor @Sendable (String?, Int) async -> Void = { _, _ in },
    openLiveApp: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    workerProfileForProfile: @escaping @MainActor @Sendable (String) -> String? = { _ in nil },
    interruptValidation: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    addValidationOverride: @escaping @MainActor @Sendable (String, String, String, String, String?, String?) async -> Void = { _, _, _, _, _, _ in },
    spawnFix: @escaping @MainActor @Sendable (String) async -> Void = { _ in }
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
    self.createPod = createPod
    self.promote = promote
    self.attachTerminal = attachTerminal
    self.approveAll = approveAll
    self.killAllFailed = killAllFailed
    self.extendAttempts = extendAttempts
    self.extendPrAttempts = extendPrAttempts
    self.fork = fork
    self.delete = delete
    self.createHistoryWorkspace = createHistoryWorkspace
    self.openLiveApp = openLiveApp
    self.workerProfileForProfile = workerProfileForProfile
    self.interruptValidation = interruptValidation
    self.addValidationOverride = addValidationOverride
    self.spawnFix = spawnFix
  }

  /// No-op instance for previews
  public static let preview = PodActions()
}
