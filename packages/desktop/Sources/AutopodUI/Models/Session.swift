import SwiftUI

// MARK: - Output mode (mirrors daemon outputMode)

public enum OutputMode: String, Sendable {
    case pr          // Worker pod — agent-driven, creates PR
    case workspace   // Workspace pod — interactive, human-driven, pushes branch
    case artifact    // Research/output — agent-driven, no PR
}

// MARK: - Status

public enum SessionStatus: String, Sendable {
    case queued, provisioning, running
    case awaitingInput = "awaiting_input"
    case validating, validated, failed
    case approved, merging, complete
    case paused
    case killing, killed

    public var label: String {
        switch self {
        case .awaitingInput: "awaiting input"
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
        case .failed:        .red
        case .approved:      .secondary
        case .merging:       .blue
        case .complete:      .secondary
        case .paused:        .gray
        case .killing:       .red
        case .killed:        .gray
        }
    }

    public var needsAttention: Bool {
        switch self {
        case .awaitingInput, .validated, .failed: true
        default: false
        }
    }

    public var isActive: Bool {
        switch self {
        case .provisioning, .running, .validating, .merging, .killing: true
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
    public init(path: String, status: String, consoleErrors: [String], assertions: [AssertionDetail], loadTime: Int) {
        self.path = path; self.status = status
        self.consoleErrors = consoleErrors; self.assertions = assertions; self.loadTime = loadTime
    }
}

public struct AcCheckDetail: Sendable {
    public let criterion: String
    public let passed: Bool
    public let reasoning: String
    public init(criterion: String, passed: Bool, reasoning: String) {
        self.criterion = criterion; self.passed = passed; self.reasoning = reasoning
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
    public let tests: Bool
    public let review: Bool
    public let buildOutput: String?
    public let testOutput: String?
    public let reviewIssues: [String]?
    public let reviewReasoning: String?
    public let healthCheck: HealthCheckDetail?
    public let pages: [PageDetail]?
    public let acValidation: Bool?
    public let acChecks: [AcCheckDetail]?
    public let requirementsCheck: [RequirementCheckDetail]?
    public init(
        smoke: Bool, tests: Bool, review: Bool,
        buildOutput: String? = nil, testOutput: String? = nil,
        reviewIssues: [String]? = nil, reviewReasoning: String? = nil,
        healthCheck: HealthCheckDetail? = nil,
        pages: [PageDetail]? = nil,
        acValidation: Bool? = nil,
        acChecks: [AcCheckDetail]? = nil,
        requirementsCheck: [RequirementCheckDetail]? = nil
    ) {
        self.smoke = smoke; self.tests = tests; self.review = review
        self.buildOutput = buildOutput; self.testOutput = testOutput
        self.reviewIssues = reviewIssues; self.reviewReasoning = reviewReasoning
        self.healthCheck = healthCheck; self.pages = pages
        self.acValidation = acValidation; self.acChecks = acChecks
        self.requirementsCheck = requirementsCheck
    }

    public var allPassed: Bool { smoke && tests && review && (acValidation ?? true) }
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

    /// Base branch this session was forked from (workspace handoff)
    public var baseBranch: String?
    /// Path to AC file loaded from repo (workspace handoff)
    public var acFrom: String?
    /// Acceptance criteria (loaded from acFrom or manual input)
    public var acceptanceCriteria: [String]?

    public var diffStats: DiffStats?
    public var escalationQuestion: String?
    public var escalationType: String?
    public var validationChecks: ValidationChecks?
    public var prUrl: URL?
    public var containerUrl: URL?
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

    /// Linked session ID for session chaining (workspace ↔ worker handoff)
    public var linkedSessionId: String?

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
        baseBranch: String? = nil,
        acFrom: String? = nil,
        acceptanceCriteria: [String]? = nil,
        diffStats: DiffStats? = nil,
        escalationQuestion: String? = nil,
        escalationType: String? = nil,
        validationChecks: ValidationChecks? = nil,
        prUrl: URL? = nil,
        containerUrl: URL? = nil,
        phase: PhaseProgress? = nil,
        latestActivity: String? = nil,
        errorSummary: String? = nil,
        attempts: AttemptInfo? = nil,
        queuePosition: Int? = nil,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        costUsd: Double = 0,
        commitCount: Int = 0,
        linkedSessionId: String? = nil
    ) {
        self.id = id; self.status = status; self.outputMode = outputMode
        self.branch = branch; self.profileName = profileName; self.task = task
        self.model = model; self.startedAt = startedAt; self.baseBranch = baseBranch
        self.acFrom = acFrom; self.acceptanceCriteria = acceptanceCriteria
        self.diffStats = diffStats; self.escalationQuestion = escalationQuestion
        self.escalationType = escalationType
        self.validationChecks = validationChecks; self.prUrl = prUrl
        self.containerUrl = containerUrl; self.phase = phase
        self.latestActivity = latestActivity; self.errorSummary = errorSummary
        self.attempts = attempts; self.queuePosition = queuePosition
        self.inputTokens = inputTokens; self.outputTokens = outputTokens
        self.costUsd = costUsd; self.commitCount = commitCount
        self.linkedSessionId = linkedSessionId
    }
}
