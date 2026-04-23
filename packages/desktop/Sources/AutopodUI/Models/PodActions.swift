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
  public var createPod: @MainActor @Sendable (String, String, String?, PodConfigRequest?, [AcDefinition]?, String?, String?, [PimGroupRequest]?, [String]?) async -> String?
  // createPod params: profileName, task, model, pod, acceptanceCriteria, baseBranch, acFrom, pimGroups, requireSidecars → returns pod ID or nil
  /// Promote an interactive pod to agent-driven in place. `targetOutput` ∈ {pr, branch, artifact, none}.
  public var promote: @MainActor @Sendable (String, String?) async -> Void
  public var attachTerminal: @MainActor @Sendable (String) -> Void
  public var approveAll: @MainActor @Sendable () async -> Void
  public var killAllFailed: @MainActor @Sendable () async -> Void
  public var extendAttempts: @MainActor @Sendable (String, Int) async -> Void
  public var extendPrAttempts: @MainActor @Sendable (String, Int) async -> Void
  public var fork: @MainActor @Sendable (String) async -> String?
  public var delete: @MainActor @Sendable (String) async -> Void
  public var deleteSeries: @MainActor @Sendable (String) async -> Void
  public var createHistoryWorkspace: @MainActor @Sendable (String?, Int) async -> Void
  /// Start/restart the preview container and open the app URL
  public var openLiveApp: @MainActor @Sendable (String) async -> Void
  /// Look up the workerProfile for a given profile name (returns nil if not set)
  public var workerProfileForProfile: @MainActor @Sendable (String) -> String?
  /// Abort the currently running validation for the pod (no-op if not validating)
  public var interruptValidation: @MainActor @Sendable (String) async -> Void
  /// Enqueue a finding override — params: podId, findingId, description, action, reason?, guidance?
  public var addValidationOverride: @MainActor @Sendable (String, String, String, String, String?, String?) async -> Void
  /// Manually force-spawn a fix pod for a merge_pending/complete pod. Optional message is forwarded
  /// to the fix pod as explicit reviewer instructions alongside auto-detected CI/review failures.
  public var spawnFix: @MainActor @Sendable (String, String?) async -> Void
  /// Retry PR creation for a complete pod whose PR was never successfully created
  public var retryCreatePr: @MainActor @Sendable (String) async -> Void
  /// Ask the daemon to parse a local brief folder and return the DAG preview.
  public var previewSeriesFolder: @MainActor @Sendable (String) async -> SeriesPreviewResponse?
  /// Ask the daemon to parse a brief folder on a git branch.
  public var previewSeriesOnBranch: @MainActor @Sendable (
    _ profileName: String, _ branch: String, _ path: String
  ) async -> SeriesPreviewResponse?
  /// Most recent error from any preview call (nil if the last call succeeded
  /// or if no preview has been attempted). The sheet uses this to surface the
  /// real daemon error instead of a generic message.
  public var lastPreviewError: @MainActor @Sendable () -> String?
  /// Launch a pod series. Returns the seriesId on success.
  public var createSeries: @MainActor @Sendable (CreateSeriesRequest) async -> String?
  /// Spawn a new pod that depends on the given parent pod IDs, optionally
  /// attaching it to an existing series. Returns the new pod id.
  public var spawnDependent: @MainActor @Sendable (
    _ profileName: String,
    _ task: String,
    _ dependsOnPodIds: [String],
    _ seriesId: String?,
    _ seriesName: String?,
    _ acceptanceCriteria: [AcDefinition]?,
    _ baseBranch: String?
  ) async -> String?

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
    createPod: @escaping @MainActor @Sendable (String, String, String?, PodConfigRequest?, [AcDefinition]?, String?, String?, [PimGroupRequest]?, [String]?) async -> String? = { _, _, _, _, _, _, _, _, _ in nil },
    promote: @escaping @MainActor @Sendable (String, String?) async -> Void = { _, _ in },
    attachTerminal: @escaping @MainActor @Sendable (String) -> Void = { _ in },
    approveAll: @escaping @MainActor @Sendable () async -> Void = {},
    killAllFailed: @escaping @MainActor @Sendable () async -> Void = {},
    extendAttempts: @escaping @MainActor @Sendable (String, Int) async -> Void = { _, _ in },
    extendPrAttempts: @escaping @MainActor @Sendable (String, Int) async -> Void = { _, _ in },
    fork: @escaping @MainActor @Sendable (String) async -> String? = { _ in nil },
    delete: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    deleteSeries: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    createHistoryWorkspace: @escaping @MainActor @Sendable (String?, Int) async -> Void = { _, _ in },
    openLiveApp: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    workerProfileForProfile: @escaping @MainActor @Sendable (String) -> String? = { _ in nil },
    interruptValidation: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    addValidationOverride: @escaping @MainActor @Sendable (String, String, String, String, String?, String?) async -> Void = { _, _, _, _, _, _ in },
    spawnFix: @escaping @MainActor @Sendable (String, String?) async -> Void = { _, _ in },
    retryCreatePr: @escaping @MainActor @Sendable (String) async -> Void = { _ in },
    previewSeriesFolder: @escaping @MainActor @Sendable (String) async -> SeriesPreviewResponse? = { _ in nil },
    previewSeriesOnBranch: @escaping @MainActor @Sendable (String, String, String) async -> SeriesPreviewResponse? = { _, _, _ in nil },
    lastPreviewError: @escaping @MainActor @Sendable () -> String? = { nil },
    createSeries: @escaping @MainActor @Sendable (CreateSeriesRequest) async -> String? = { _ in nil },
    spawnDependent: @escaping @MainActor @Sendable (String, String, [String], String?, String?, [AcDefinition]?, String?) async -> String? = { _, _, _, _, _, _, _ in nil }
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
    self.deleteSeries = deleteSeries
    self.createHistoryWorkspace = createHistoryWorkspace
    self.openLiveApp = openLiveApp
    self.workerProfileForProfile = workerProfileForProfile
    self.interruptValidation = interruptValidation
    self.addValidationOverride = addValidationOverride
    self.spawnFix = spawnFix
    self.retryCreatePr = retryCreatePr
    self.previewSeriesFolder = previewSeriesFolder
    self.previewSeriesOnBranch = previewSeriesOnBranch
    self.lastPreviewError = lastPreviewError
    self.createSeries = createSeries
    self.spawnDependent = spawnDependent
  }

  /// No-op instance for previews
  public static let preview = PodActions()
}
