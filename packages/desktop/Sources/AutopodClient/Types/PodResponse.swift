import Foundation

// MARK: - Pod config (mirrors packages/shared/src/types/pod.ts)

/// Orthogonal pod configuration axes. Replaces the single `outputMode` enum.
public struct PodConfigResponse: Codable, Sendable {
  public var agentMode: String         // "auto" | "interactive"
  public var output: String            // "pr" | "branch" | "artifact" | "none"
  public var validate: Bool
  public var promotable: Bool

  public init(agentMode: String, output: String, validate: Bool, promotable: Bool) {
    self.agentMode = agentMode
    self.output = output
    self.validate = validate
    self.promotable = promotable
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    agentMode = try c.decode(String.self, forKey: .agentMode)
    output = try c.decode(String.self, forKey: .output)
    validate = try decodeBoolOrInt(c, key: .validate)
    promotable = try decodeBoolOrInt(c, key: .promotable)
  }

  private enum CodingKeys: String, CodingKey {
    case agentMode, output, validate, promotable
  }
}

// Partial PodConfig for create/update requests — every field is optional.
public struct PodConfigRequest: Codable, Sendable {
  public var agentMode: String?
  public var output: String?
  public var validate: Bool?
  public var promotable: Bool?

  public init(
    agentMode: String? = nil,
    output: String? = nil,
    validate: Bool? = nil,
    promotable: Bool? = nil
  ) {
    self.agentMode = agentMode
    self.output = output
    self.validate = validate
    self.promotable = promotable
  }
}

// MARK: - Pod response (mirrors packages/shared/src/types/pod.ts)

public struct SessionResponse: Codable, Sendable {
  public let id: String
  public let profileName: String
  public let task: String
  public let status: String
  public let model: String
  public let runtime: String
  public let executionTarget: String
  public let branch: String
  public let containerId: String?
  public let worktreePath: String?
  public let validationAttempts: Int
  public let maxValidationAttempts: Int
  public let lastValidationResult: ValidationResponse?
  public let validationWaiver: ValidationWaiverResponse?
  public let lastValidationFindings: [ValidationFindingResponse]?
  public let pendingEscalation: EscalationResponse?
  public let escalationCount: Int
  public let skipValidation: Bool
  public let createdAt: String
  public let startedAt: String?
  public let runningAt: String?
  public let completedAt: String?
  public let updatedAt: String
  public let userId: String
  public let filesChanged: Int
  public let linesAdded: Int
  public let linesRemoved: Int
  public let previewUrl: String?
  public let hasWebUi: Bool?
  public let prUrl: String?
  public let mergeBlockReason: String?
  public let plan: PlanResponse?
  public let progress: ProgressResponse?
  public let contract: SpecContractResponse?
  public let claudeSessionId: String?
  public let outputMode: String
  public let pod: PodConfigResponse?
  public let baseBranch: String?
  public let recoveryWorktreePath: String?
  public let lastHeartbeatAt: String?
  public let inputTokens: Int
  public let outputTokens: Int
  public let costUsd: Double
  public let commitCount: Int
  public let lastCommitAt: String?
  public let linkedPodId: String?
  public let linkedSessionId: String?
  public let taskSummary: TaskSummaryResponse?
  public let lastCorrectionMessage: String?
  public let profileSnapshot: ProfileResponse?
  // Series fields (optional for back-compat with pre-#88 responses).
  public let dependsOnPodId: String?
  public let dependsOnPodIds: [String]?
  public let seriesId: String?
  public let seriesName: String?
  /// Overall spec description (from context.md) shared across all pods in a series.
  public let seriesDescription: String?
  /// Series design notes (from design.md) shared across all pods in a series.
  public let seriesDesign: String?
  public let dependencyStartedAt: String?
  public let artifactsPath: String?
  /// Names of sidecars this pod requested (e.g. ["dagger"]).
  public let requireSidecars: [String]?
  /// Map of sidecar name → container id.
  public let sidecarContainerIds: [String: String]?
  /// Branches this pod pushed to the configured test repo (cleared on pod end).
  public let testRunBranches: [String]?
  /// Set by the daemon when the auto-commit deletion guard aborted a commit —
  /// the host worktree is out of sync with the container and retry/merge
  /// actions would commit a phantom mass-deletion. Optional for back-compat
  /// with pre-#056 daemon responses; nil is treated as false.
  public let worktreeCompromised: Bool?
  public let validationOverrides: [ValidationOverrideResponse]?
  /// Human-readable title from the brief's YAML frontmatter `title` field.
  /// Nil for standalone pods or briefs without an explicit title.
  public let briefTitle: String?
  /// Reference repos cloned read-only into the container at /repos/<mountPath>/.
  /// Optional for back-compat with daemons that don't surface this field.
  public let referenceRepos: [ReferenceRepoSummary]?
  /// Number of times this pod has been reworked (never resets). Zero for the original run.
  public let reworkCount: Int?
  /// Cached verdict from the agent's `pre_submit_review` MCP tool call.
  /// Surfaced in the pod detail view so reviewers can see what the critic
  /// flagged before the daemon's full validation runs.
  public let preSubmitReview: PreSubmitReviewSnapshotResponse?
  /// Number of PR fix sessions spawned/recycled for this parent pod.
  public let prFixAttempts: Int?
  /// Maximum PR fix sessions allowed before the parent pod fails.
  public let maxPrFixAttempts: Int?
  /// Canonical fix pod currently associated with this parent pod.
  public let fixPodId: String?
  /// Iteration counter for the canonical fix pod. 0 for non-fix pods or the
  /// first round; increments each time the fix pod is re-enqueued for a new
  /// round of CI / review feedback.
  public let fixIteration: Int?
  /// Number of messages currently in the fix-feedback queue for this parent pod.
  /// Zero for non-parent pods or when no feedback is queued.
  public let queueLength: Int?
  /// Up to 10 most-recent queued feedback messages for the popover.
  /// Absent from pre-brief-02 daemon responses; decode defensively.
  public let recentQueueMessages: [QueueMessageResponse]?

  // Backend serializes PodOptions under the key `options`; the Swift field is
  // named `pod` for readability (matches the domain model). Remap on the wire.
  private enum CodingKeys: String, CodingKey {
    case id, profileName, task, status, model, runtime, executionTarget, branch
    case containerId, worktreePath, validationAttempts, maxValidationAttempts, reworkCount
    case lastValidationResult, validationWaiver, lastValidationFindings, pendingEscalation, escalationCount, skipValidation
    case createdAt, startedAt, runningAt, completedAt, updatedAt, userId
    case filesChanged, linesAdded, linesRemoved, previewUrl, hasWebUi, prUrl
    case mergeBlockReason, plan, progress, contract, claudeSessionId
    case outputMode
    case pod = "options"
    case baseBranch, recoveryWorktreePath, lastHeartbeatAt
    case inputTokens, outputTokens, costUsd, commitCount, lastCommitAt
    case linkedPodId, linkedSessionId, taskSummary, lastCorrectionMessage, profileSnapshot
    case dependsOnPodId, dependsOnPodIds, seriesId, seriesName, seriesDescription, seriesDesign, dependencyStartedAt
    case artifactsPath
    case requireSidecars, sidecarContainerIds, testRunBranches
    case worktreeCompromised
    case validationOverrides
    case briefTitle
    case referenceRepos
    case preSubmitReview
    case prFixAttempts
    case maxPrFixAttempts
    case fixPodId
    case fixIteration
    case queueLength
    case recentQueueMessages
  }
}

public struct ValidationWaiverResponse: Codable, Sendable {
  public let waivedAt: String
  public let waivedBy: String
  public let reason: String
  public let attempt: Int?
  public let failedPhases: [String]
  public let failedFactIds: [String]
}

/// Wire type for a single queued feedback message (mirrors `FixFeedback` from
/// the daemon's `FixFeedbackRepository`).
public struct QueueMessageResponse: Codable, Sendable {
  public let id: String
  public let message: String
  /// Millisecond epoch timestamp.
  public let createdAt: Int64
}

public struct PreSubmitReviewSnapshotResponse: Codable, Sendable {
  /// "pass" | "fail" | "uncertain" | "skipped"
  public let status: String
  /// Hash of the diff this verdict applies to. Used by the daemon to skip
  /// Tier 1 of its full reviewer when nothing has changed since this pass.
  public let diffHash: String
  public let reasoning: String
  public let issues: [String]
  public let model: String
  public let checkedAt: String
}

public struct DeviationResponse: Codable, Sendable {
  public let step: String
  public let planned: String
  public let actual: String
  public let reason: String
}

public struct TaskSummaryResponse: Codable, Sendable {
  public let actualSummary: String
  public let deviations: [DeviationResponse]
  public let factEvidence: [FactEvidenceResponse]?
}

// MARK: - Nested types

public struct PlanResponse: Codable, Sendable {
  public let summary: String
  public let steps: [String]
}

public struct ProgressResponse: Codable, Sendable {
  public let phase: String
  public let description: String
  public let currentPhase: Int
  public let totalPhases: Int
}

public struct EscalationResponse: Codable, Sendable {
  public let id: String
  public let podId: String
  public let type: String
  public let timestamp: String
  public let payload: EscalationPayload
  public let response: EscalationReply?
}

public struct EscalationPayload: Codable, Sendable {
  // Union type — fields from all payload variants, all optional
  public let question: String?
  public let context: String?
  public let options: [String]?
  public let domain: String?
  public let description: String?
  public let reason: String?
  public let service: String?
  public let source: String?
  public let attempted: [String]?
  public let needs: String?
  // Action approval fields
  public let actionName: String?
  public let params: [String: AnyCodable]?
  // Validation override fields (when escalation type == "validation_override")
  public let findings: [ValidationFindingResponse]?
  public let attempt: Int?
  public let maxAttempts: Int?
}

public struct EscalationReply: Codable, Sendable {
  public let respondedAt: String
  public let respondedBy: String
  public let response: String
  public let model: String?
}

// MARK: - Pod summary (used in events)

public struct SessionSummaryResponse: Codable, Sendable {
  public let id: String
  public let profileName: String
  public let task: String
  public let status: String
  public let model: String
  public let runtime: String
  public let duration: Int?
  public let filesChanged: Int
  public let createdAt: String
}

// MARK: - Reference repos

public struct ReferenceRepoRequest: Codable, Sendable, Hashable {
  public let url: String
  /// When the user picked this URL from a profile, this carries that
  /// profile's name so the daemon can authenticate the clone with the
  /// profile's `githubPat` / `adoPat`. Nil for ad-hoc URLs.
  public let sourceProfile: String?
  public init(url: String, sourceProfile: String? = nil) {
    self.url = url
    self.sourceProfile = sourceProfile
  }
}

public struct ReferenceRepoSummary: Codable, Sendable, Hashable {
  public let url: String
  public let mountPath: String
  public init(url: String, mountPath: String) {
    self.url = url
    self.mountPath = mountPath
  }
}

public struct BriefPodMetadata: Sendable, Hashable {
  public var contract: SpecContractResponse?
  public var briefTitle: String?
  public var touches: [String]?
  public var doesNotTouch: [String]?

  public init(
    contract: SpecContractResponse? = nil,
    briefTitle: String? = nil,
    touches: [String]? = nil,
    doesNotTouch: [String]? = nil
  ) {
    self.contract = contract
    self.briefTitle = briefTitle
    self.touches = touches
    self.doesNotTouch = doesNotTouch
  }
}

// MARK: - Create pod request

public struct CreateSessionRequest: Codable, Sendable {
  public var profileName: String
  public var task: String
  public var model: String?
  public var runtime: String?
  public var executionTarget: String?
  public var branch: String?
  public var skipValidation: Bool?
  public var contract: SpecContractResponse?
  public var briefTitle: String?
  public var touches: [String]?
  public var doesNotTouch: [String]?
  public var outputMode: String?
  public var pod: PodConfigRequest?
  public var baseBranch: String?
  public var branchPrefix: String?
  public var linkedSessionId: String?
  public var pimGroups: [PimGroupRequest]?
  // Series fields — populated when spawning a follow-up pod or launching a series.
  public var dependsOnPodIds: [String]?
  public var seriesId: String?
  public var seriesName: String?
  // Companion sidecars to spawn alongside the pod (e.g. ["dagger"]). Each
  // entry must correspond to an enabled entry in `profile.sidecars`;
  // privileged sidecars additionally require `profile.trustedSource: true`.
  public var requireSidecars: [String]?
  public var referenceRepos: [ReferenceRepoRequest]?

  public init(
    profileName: String,
    task: String,
    model: String? = nil,
    runtime: String? = nil,
    executionTarget: String? = nil,
    branch: String? = nil,
    skipValidation: Bool? = nil,
    contract: SpecContractResponse? = nil,
    briefTitle: String? = nil,
    touches: [String]? = nil,
    doesNotTouch: [String]? = nil,
    outputMode: String? = nil,
    pod: PodConfigRequest? = nil,
    baseBranch: String? = nil,
    branchPrefix: String? = nil,
    linkedSessionId: String? = nil,
    pimGroups: [PimGroupRequest]? = nil,
    dependsOnPodIds: [String]? = nil,
    seriesId: String? = nil,
    seriesName: String? = nil,
    requireSidecars: [String]? = nil,
    referenceRepos: [ReferenceRepoRequest]? = nil
  ) {
    self.profileName = profileName
    self.task = task
    self.model = model
    self.runtime = runtime
    self.executionTarget = executionTarget
    self.branch = branch
    self.skipValidation = skipValidation
    self.contract = contract
    self.briefTitle = briefTitle
    self.touches = touches
    self.doesNotTouch = doesNotTouch
    self.outputMode = outputMode
    self.pod = pod
    self.baseBranch = baseBranch
    self.branchPrefix = branchPrefix
    self.linkedSessionId = linkedSessionId
    self.pimGroups = pimGroups
    self.dependsOnPodIds = dependsOnPodIds
    self.seriesId = seriesId
    self.seriesName = seriesName
    self.requireSidecars = requireSidecars
    self.referenceRepos = referenceRepos
  }

  // Backend zod schema names the pod-config field `options`; the Swift
  // struct keeps the local name `pod` for readability. Remap on the wire.
  private enum CodingKeys: String, CodingKey {
    case profileName, task, model, runtime, executionTarget, branch
    case skipValidation, contract, briefTitle, touches, doesNotTouch, outputMode
    case pod = "options"
    case baseBranch, branchPrefix, linkedSessionId, pimGroups
    case dependsOnPodIds, seriesId, seriesName, requireSidecars
    case referenceRepos
  }
}

// MARK: - Series types

public struct TokenUsageSummary: Codable, Sendable {
  public let inputTokens: Int
  public let outputTokens: Int
  public let costUsd: Double
}

public struct SeriesResponse: Codable, Sendable {
  public let seriesId: String
  public let seriesName: String
  public let pods: [SessionResponse]
  public let tokenUsageSummary: TokenUsageSummary?
  public let statusCounts: [String: Int]
}

/// A single parsed brief returned from `POST /pods/series/preview`. Titles are
/// used as node identifiers in the DAG; `dependsOn` references other brief titles.
public struct ParsedBriefResponse: Codable, Sendable {
  public let title: String
  public let task: String
  public let dependsOn: [String]
  public let contract: SpecContractResponse?
  public let touches: [String]?
  public let doesNotTouch: [String]?
  /// Per-brief sidecar requests (e.g. `["dagger"]`). Surfaced on the DAG
  /// preview so reviewers can see which pods will spawn privileged sidecars
  /// before submitting. Nil/empty = no sidecars.
  public let requireSidecars: [String]?

  public init(
    title: String,
    task: String,
    dependsOn: [String],
    contract: SpecContractResponse? = nil,
    touches: [String]? = nil,
    doesNotTouch: [String]? = nil,
    requireSidecars: [String]? = nil
  ) {
    self.title = title
    self.task = task
    self.dependsOn = dependsOn
    self.contract = contract
    self.touches = touches
    self.doesNotTouch = doesNotTouch
    self.requireSidecars = requireSidecars
  }
}

public struct SeriesPreviewResponse: Codable, Sendable {
  public let seriesName: String
  public let briefs: [ParsedBriefResponse]
  /// Series purpose (from `purpose.md`). Rendered in the Series tab and used
  /// as the PR "Why" section when the series merges as a single PR.
  public let seriesDescription: String?
  /// Series design (from `design.md`). Rendered in the Series tab.
  public let seriesDesign: String?
}

public struct CreateSeriesRequest: Codable, Sendable {
  public var seriesName: String
  public var briefs: [ParsedBriefResponse]
  public var profile: String
  public var baseBranch: String?
  public var prMode: String?   // "single" | "stacked" | "none"
  public var autoApprove: Bool?
  public var disableAskHuman: Bool?
  public var seriesDescription: String?
  public var seriesDesign: String?

  public init(
    seriesName: String,
    briefs: [ParsedBriefResponse],
    profile: String,
    baseBranch: String? = nil,
    prMode: String? = nil,
    autoApprove: Bool? = nil,
    disableAskHuman: Bool? = nil,
    seriesDescription: String? = nil,
    seriesDesign: String? = nil
  ) {
    self.seriesName = seriesName
    self.briefs = briefs
    self.profile = profile
    self.baseBranch = baseBranch
    self.prMode = prMode
    self.autoApprove = autoApprove
    self.disableAskHuman = disableAskHuman
    self.seriesDescription = seriesDescription
    self.seriesDesign = seriesDesign
  }
}

/// Body for the promotion endpoint — promotes an interactive pod to agent-driven.
public struct PromoteSessionRequest: Codable, Sendable {
  public var output: String?   // "pr" | "branch" | "artifact" | "none"

  public init(output: String? = nil) {
    self.output = output
  }
}

public struct PimGroupRequest: Codable, Sendable, Identifiable {
  public var id: UUID = UUID()
  public var groupId: String
  public var displayName: String?
  public var duration: String?
  public var justification: String?

  public init(groupId: String = "", displayName: String? = nil, duration: String? = nil, justification: String? = nil) {
    self.groupId = groupId
    self.displayName = displayName
    self.duration = duration
    self.justification = justification
  }

  private enum CodingKeys: String, CodingKey {
    case groupId, displayName, duration, justification
  }
}

// MARK: - Stats response

public struct SessionStatsResponse: Codable, Sendable {
  // Daemon returns a dynamic object like { "running": 3, "queued": 1 }
  // Decode as dictionary
  public let counts: [String: Int]

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    counts = try container.decode([String: Int].self)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(counts)
  }
}
