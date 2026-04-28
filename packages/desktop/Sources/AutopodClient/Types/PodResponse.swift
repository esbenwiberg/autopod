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
  public let lastValidationFindings: [ValidationFindingResponse]?
  public let pendingEscalation: EscalationResponse?
  public let escalationCount: Int
  public let skipValidation: Bool
  public let createdAt: String
  public let startedAt: String?
  public let completedAt: String?
  public let updatedAt: String
  public let userId: String
  public let filesChanged: Int
  public let linesAdded: Int
  public let linesRemoved: Int
  public let previewUrl: String?
  public let prUrl: String?
  public let mergeBlockReason: String?
  public let plan: PlanResponse?
  public let progress: ProgressResponse?
  public let acceptanceCriteria: [AcDefinition]?
  public let claudeSessionId: String?
  public let outputMode: String
  public let pod: PodConfigResponse?
  public let baseBranch: String?
  public let acFrom: String?
  public let recoveryWorktreePath: String?
  public let lastHeartbeatAt: String?
  public let inputTokens: Int
  public let outputTokens: Int
  public let costUsd: Double
  public let commitCount: Int
  public let lastCommitAt: String?
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

  // Backend serializes PodOptions under the key `options`; the Swift field is
  // named `pod` for readability (matches the domain model). Remap on the wire.
  private enum CodingKeys: String, CodingKey {
    case id, profileName, task, status, model, runtime, executionTarget, branch
    case containerId, worktreePath, validationAttempts, maxValidationAttempts
    case lastValidationResult, lastValidationFindings, pendingEscalation, escalationCount, skipValidation
    case createdAt, startedAt, completedAt, updatedAt, userId
    case filesChanged, linesAdded, linesRemoved, previewUrl, prUrl
    case mergeBlockReason, plan, progress, acceptanceCriteria, claudeSessionId
    case outputMode
    case pod = "options"
    case baseBranch, acFrom, recoveryWorktreePath, lastHeartbeatAt
    case inputTokens, outputTokens, costUsd, commitCount, lastCommitAt
    case linkedSessionId, taskSummary, lastCorrectionMessage, profileSnapshot
    case dependsOnPodId, dependsOnPodIds, seriesId, seriesName, seriesDescription, seriesDesign, dependencyStartedAt
    case artifactsPath
    case requireSidecars, sidecarContainerIds, testRunBranches
    case worktreeCompromised
    case validationOverrides
    case briefTitle
    case referenceRepos
  }
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
  public let attempted: [String]?
  public let needs: String?
  // Action approval fields
  public let actionName: String?
  public let params: [String: AnyCodable]?
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
  public init(url: String) { self.url = url }
}

public struct ReferenceRepoSummary: Codable, Sendable, Hashable {
  public let url: String
  public let mountPath: String
  public init(url: String, mountPath: String) {
    self.url = url
    self.mountPath = mountPath
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
  public var acceptanceCriteria: [AcDefinition]?
  public var outputMode: String?
  public var pod: PodConfigRequest?
  public var baseBranch: String?
  public var acFrom: String?
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
  public var referenceRepoPat: String?

  public init(
    profileName: String,
    task: String,
    model: String? = nil,
    runtime: String? = nil,
    executionTarget: String? = nil,
    branch: String? = nil,
    skipValidation: Bool? = nil,
    acceptanceCriteria: [AcDefinition]? = nil,
    outputMode: String? = nil,
    pod: PodConfigRequest? = nil,
    baseBranch: String? = nil,
    acFrom: String? = nil,
    linkedSessionId: String? = nil,
    pimGroups: [PimGroupRequest]? = nil,
    dependsOnPodIds: [String]? = nil,
    seriesId: String? = nil,
    seriesName: String? = nil,
    requireSidecars: [String]? = nil,
    referenceRepos: [ReferenceRepoRequest]? = nil,
    referenceRepoPat: String? = nil
  ) {
    self.profileName = profileName
    self.task = task
    self.model = model
    self.runtime = runtime
    self.executionTarget = executionTarget
    self.branch = branch
    self.skipValidation = skipValidation
    self.acceptanceCriteria = acceptanceCriteria
    self.outputMode = outputMode
    self.pod = pod
    self.baseBranch = baseBranch
    self.acFrom = acFrom
    self.linkedSessionId = linkedSessionId
    self.pimGroups = pimGroups
    self.dependsOnPodIds = dependsOnPodIds
    self.seriesId = seriesId
    self.seriesName = seriesName
    self.requireSidecars = requireSidecars
    self.referenceRepos = referenceRepos
    self.referenceRepoPat = referenceRepoPat
  }

  // Backend zod schema names the pod-config field `options`; the Swift
  // struct keeps the local name `pod` for readability. Remap on the wire.
  private enum CodingKeys: String, CodingKey {
    case profileName, task, model, runtime, executionTarget, branch
    case skipValidation, acceptanceCriteria, outputMode
    case pod = "options"
    case baseBranch, acFrom, linkedSessionId, pimGroups
    case dependsOnPodIds, seriesId, seriesName, requireSidecars
    case referenceRepos, referenceRepoPat
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
  public let acceptanceCriteria: [AcDefinition]?
  /// Per-brief sidecar requests (e.g. `["dagger"]`). Surfaced on the DAG
  /// preview so reviewers can see which pods will spawn privileged sidecars
  /// before submitting. Nil/empty = no sidecars.
  public let requireSidecars: [String]?

  public init(
    title: String,
    task: String,
    dependsOn: [String],
    acceptanceCriteria: [AcDefinition]? = nil,
    requireSidecars: [String]? = nil
  ) {
    self.title = title
    self.task = task
    self.dependsOn = dependsOn
    self.acceptanceCriteria = acceptanceCriteria
    self.requireSidecars = requireSidecars
  }
}

public struct SeriesPreviewResponse: Codable, Sendable {
  public let seriesName: String
  public let briefs: [ParsedBriefResponse]
}

public struct CreateSeriesRequest: Codable, Sendable {
  public var seriesName: String
  public var briefs: [ParsedBriefResponse]
  public var profile: String
  public var baseBranch: String?
  public var prMode: String?   // "single" | "stacked" | "none"
  public var autoApprove: Bool?
  public var disableAskHuman: Bool?

  public init(
    seriesName: String,
    briefs: [ParsedBriefResponse],
    profile: String,
    baseBranch: String? = nil,
    prMode: String? = nil,
    autoApprove: Bool? = nil,
    disableAskHuman: Bool? = nil
  ) {
    self.seriesName = seriesName
    self.briefs = briefs
    self.profile = profile
    self.baseBranch = baseBranch
    self.prMode = prMode
    self.autoApprove = autoApprove
    self.disableAskHuman = disableAskHuman
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
