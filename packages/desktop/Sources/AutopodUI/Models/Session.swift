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

public struct ValidationChecks: Sendable {
    public let smoke: Bool
    public let tests: Bool
    public let review: Bool
    public let buildOutput: String?
    public let testOutput: String?
    public let reviewIssues: [String]?
    public let reviewReasoning: String?
    public init(
        smoke: Bool, tests: Bool, review: Bool,
        buildOutput: String? = nil, testOutput: String? = nil,
        reviewIssues: [String]? = nil, reviewReasoning: String? = nil
    ) {
        self.smoke = smoke; self.tests = tests; self.review = review
        self.buildOutput = buildOutput; self.testOutput = testOutput
        self.reviewIssues = reviewIssues; self.reviewReasoning = reviewReasoning
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
