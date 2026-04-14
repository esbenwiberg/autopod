import SwiftUI

// MARK: - Output mode (mirrors daemon outputMode)

public enum OutputMode: String, CaseIterable, Sendable {
    case pr          // Worker pod — agent-driven, creates PR
    case workspace   // Workspace pod — interactive, human-driven, pushes branch
    case artifact    // Research/output — agent-driven, no PR

    public var label: String {
        switch self {
        case .pr:        "Pull Request"
        case .artifact:  "Artifact"
        case .workspace: "Workspace"
        }
    }
}

// MARK: - Status

public enum SessionStatus: String, Sendable {
    case queued, provisioning, running
    case awaitingInput = "awaiting_input"
    case validating, validated, failed
    case reviewRequired = "review_required"
    case approved, merging, mergePending = "merge_pending", complete
    case paused
    case killing, killed

    public var label: String {
        switch self {
        case .awaitingInput: "awaiting input"
        case .reviewRequired: "needs review"
        case .mergePending: "merge pending"
        default: rawValue
        }
    }

    public var color: Color {
        switch self {
        case .queued:        .gray
        case .provisioning:  .blue
        case .running:       .blue
        case .awaitingInput: .orange
        case .validating:    .blue
        case .validated:     .secondary
        case .failed:          .red
        case .reviewRequired:  .orange
        case .approved:        .secondary
        case .merging:       .blue
        case .mergePending:  .orange
        case .complete:      .secondary
        case .paused:        .gray
        case .killing:       .red
        case .killed:        .gray
        }
    }

    public var needsAttention: Bool {
        switch self {
        case .awaitingInput, .validated, .failed, .reviewRequired: true
        default: false
        }
    }

    public var isActive: Bool {
        switch self {
        case .provisioning, .running, .validating, .merging, .mergePending, .killing: true
        default: false
        }
    }
}

// MARK: - Supporting types

public struct DiffStats: Sendable {
    public let added: Int
    public let removed: Int
    public let files: Int
    public init(added: Int, removed: Int, files: Int) {
        self.added = added; self.removed = removed; self.files = files
    }
}

// MARK: - Validation detail types

public struct HealthCheckDetail: Sendable {
    public let status: String
    public let url: String
    public let responseCode: Int?
    public let duration: Int
    public init(status: String, url: String, responseCode: Int?, duration: Int) {
        self.status = status; self.url = url
        self.responseCode = responseCode; self.duration = duration
    }
}

public struct AssertionDetail: Sendable {
    public let selector: String
    public let type: String
    public let expected: String?
    public let actual: String?
    public let passed: Bool
    public init(selector: String, type: String, expected: String?, actual: String?, passed: Bool) {
        self.selector = selector; self.type = type
        self.expected = expected; self.actual = actual; self.passed = passed
    }
}

public struct PageDetail: Sendable {
    public let path: String
    public let status: String
    public let consoleErrors: [String]
    public let assertions: [AssertionDetail]
    public let loadTime: Int
    public let screenshotBase64: String?
    public init(path: String, status: String, consoleErrors: [String], assertions: [AssertionDetail], loadTime: Int, screenshotBase64: String? = nil) {
        self.path = path; self.status = status
        self.consoleErrors = consoleErrors; self.assertions = assertions; self.loadTime = loadTime
        self.screenshotBase64 = screenshotBase64
    }
}

public struct AcCheckDetail: Sendable {
    public let criterion: String
    public let passed: Bool
    public let reasoning: String
    public let screenshot: String?
    public init(criterion: String, passed: Bool, reasoning: String, screenshot: String? = nil) {
        self.criterion = criterion; self.passed = passed; self.reasoning = reasoning
        self.screenshot = screenshot
    }
}

public struct RequirementCheckDetail: Sendable {
    public let criterion: String
    public let met: Bool
    public let note: String?
    public init(criterion: String, met: Bool, note: String?) {
        self.criterion = criterion; self.met = met; self.note = note
    }
}

// MARK: - Validation checks

public struct ValidationChecks: Sendable {
    public let smoke: Bool
    public let tests: Bool?
    public let review: Bool?
    public let buildOutput: String?
    public let testOutput: String?
    public let reviewIssues: [String]?
    public let reviewReasoning: String?
    public let reviewSkipReason: String?
    public let healthCheck: HealthCheckDetail?
    public let pages: [PageDetail]?
    public let acValidation: Bool?
    public let acChecks: [AcCheckDetail]?
    public let requirementsCheck: [RequirementCheckDetail]?
    public let taskReviewScreenshots: [String]?
    /// The formatted markdown feedback that was sent back to the agent after a failed validation attempt.
    public let correctionMessage: String?
    public init(
        smoke: Bool, tests: Bool? = nil, review: Bool? = nil,
        buildOutput: String? = nil, testOutput: String? = nil,
        reviewIssues: [String]? = nil, reviewReasoning: String? = nil,
        reviewSkipReason: String? = nil,
        healthCheck: HealthCheckDetail? = nil,
        pages: [PageDetail]? = nil,
        acValidation: Bool? = nil,
        acChecks: [AcCheckDetail]? = nil,
        requirementsCheck: [RequirementCheckDetail]? = nil,
        taskReviewScreenshots: [String]? = nil,
        correctionMessage: String? = nil
    ) {
        self.smoke = smoke; self.tests = tests; self.review = review
        self.buildOutput = buildOutput; self.testOutput = testOutput
        self.reviewIssues = reviewIssues; self.reviewReasoning = reviewReasoning
        self.reviewSkipReason = reviewSkipReason
        self.healthCheck = healthCheck; self.pages = pages
        self.acValidation = acValidation; self.acChecks = acChecks
        self.requirementsCheck = requirementsCheck
        self.taskReviewScreenshots = taskReviewScreenshots
        self.correctionMessage = correctionMessage
    }

    public var allPassed: Bool { smoke && (tests ?? true) && (review ?? true) && (acValidation ?? true) }
}

public struct SessionPlan: Sendable {
    public let summary: String
    public let steps: [String]
    public init(summary: String, steps: [String]) {
        self.summary = summary; self.steps = steps
    }
}

public struct PhaseProgress: Sendable {
    public let current: Int
    public let total: Int
    public let description: String
    public init(current: Int, total: Int, description: String) {
        self.current = current; self.total = total; self.description = description
    }
}

public struct AttemptInfo: Sendable {
    public let current: Int
    public let max: Int
    public init(current: Int, max: Int) {
        self.current = current; self.max = max
    }
}

public struct DeviationItem: Sendable {
    public let step: String
    public let planned: String
    public let actual: String
    public let reason: String
    public init(step: String, planned: String, actual: String, reason: String) {
        self.step = step; self.planned = planned; self.actual = actual; self.reason = reason
    }
}

public struct TaskSummary: Sendable {
    public let actualSummary: String
    public let deviations: [DeviationItem]
    public init(actualSummary: String, deviations: [DeviationItem]) {
        self.actualSummary = actualSummary; self.deviations = deviations
    }
}

// MARK: - Session

public struct Session: Identifiable, Sendable {
    public let id: String
    public var status: SessionStatus
    public var outputMode: OutputMode
    public var branch: String
    public var profileName: String
    public var task: String
    public var model: String
    public var startedAt: Date
    public var updatedAt: Date

    /// Base branch this session was forked from (workspace handoff)
    public var baseBranch: String?
    /// Path to AC file loaded from repo (workspace handoff)
    public var acFrom: String?
    /// Acceptance criteria (loaded from acFrom or manual input)
    public var acceptanceCriteria: [String]?

    public var diffStats: DiffStats?
    public var escalationQuestion: String?
    public var escalationOptions: [String]?
    public var escalationType: String?
    public var validationChecks: ValidationChecks?
    public var prUrl: URL?
    public var containerUrl: URL?
    public var plan: SessionPlan?
    public var phase: PhaseProgress?
    public var latestActivity: String?
    public var errorSummary: String?
    public var attempts: AttemptInfo?
    public var queuePosition: Int?

    // Token / cost tracking
    public var inputTokens: Int
    public var outputTokens: Int
    public var costUsd: Double
    public var commitCount: Int

    /// Task summary reported by the agent at completion
    public var taskSummary: TaskSummary?

    /// Linked session ID for session chaining (workspace ↔ worker handoff)
    public var linkedSessionId: String?

    /// Snapshot of the resolved profile config at session creation time
    public var profileSnapshot: Profile?

    public var isWorkspace: Bool { outputMode == .workspace }

    /// Whether this session is in a terminal state and can be deleted.
    public var isTerminal: Bool {
        switch status {
        case .complete, .killed, .failed: true
        default: false
        }
    }

    public var duration: String {
        let minutes = Int(Date().timeIntervalSince(startedAt) / 60)
        guard minutes > 0 else { return "<1m" }
        guard minutes >= 60 else { return "\(minutes)m" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    public init(
        id: String = UUID().uuidString,
        status: SessionStatus,
        outputMode: OutputMode = .pr,
        branch: String,
        profileName: String,
        task: String = "",
        model: String,
        startedAt: Date,
        updatedAt: Date = Date(),
        baseBranch: String? = nil,
        acFrom: String? = nil,
        acceptanceCriteria: [String]? = nil,
        diffStats: DiffStats? = nil,
        escalationQuestion: String? = nil,
        escalationOptions: [String]? = nil,
        escalationType: String? = nil,
        validationChecks: ValidationChecks? = nil,
        prUrl: URL? = nil,
        containerUrl: URL? = nil,
        plan: SessionPlan? = nil,
        phase: PhaseProgress? = nil,
        latestActivity: String? = nil,
        errorSummary: String? = nil,
        attempts: AttemptInfo? = nil,
        queuePosition: Int? = nil,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        costUsd: Double = 0,
        commitCount: Int = 0,
        taskSummary: TaskSummary? = nil,
        linkedSessionId: String? = nil,
        profileSnapshot: Profile? = nil
    ) {
        self.id = id; self.status = status; self.outputMode = outputMode
        self.branch = branch; self.profileName = profileName; self.task = task
        self.model = model; self.startedAt = startedAt; self.updatedAt = updatedAt
        self.baseBranch = baseBranch
        self.acFrom = acFrom; self.acceptanceCriteria = acceptanceCriteria
        self.diffStats = diffStats; self.escalationQuestion = escalationQuestion
        self.escalationOptions = escalationOptions; self.escalationType = escalationType
        self.validationChecks = validationChecks; self.prUrl = prUrl
        self.containerUrl = containerUrl; self.plan = plan; self.phase = phase
        self.latestActivity = latestActivity; self.errorSummary = errorSummary
        self.attempts = attempts; self.queuePosition = queuePosition
        self.inputTokens = inputTokens; self.outputTokens = outputTokens
        self.costUsd = costUsd; self.commitCount = commitCount
        self.taskSummary = taskSummary; self.linkedSessionId = linkedSessionId
        self.profileSnapshot = profileSnapshot
    }
}
