import AutopodClient
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

public enum PodStatus: String, Sendable {
    case queued, provisioning, running
    case awaitingInput = "awaiting_input"
    case validating, validated, failed
    case reviewRequired = "review_required"
    case approved, merging, mergePending = "merge_pending", complete
    case paused
    case handoff
    case killing, killed

    public var label: String {
        switch self {
        case .awaitingInput: "awaiting input"
        case .reviewRequired: "needs review"
        case .mergePending: "merge pending"
        case .handoff: "handing off"
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
        case .complete:      .green
        case .paused:        .gray
        case .handoff:       .blue
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
        case .provisioning, .running, .validating, .merging, .mergePending, .killing, .handoff: true
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
    public let responseBody: String?
    public init(status: String, url: String, responseCode: Int?, duration: Int, responseBody: String? = nil) {
        self.status = status; self.url = url
        self.responseCode = responseCode; self.duration = duration
        self.responseBody = responseBody
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

/// A page screenshot surfaced on the Summary tab as proof-of-work.
/// Populated from smoke.pages regardless of pass/fail so reviewers can eyeball the result.
public struct PageScreenshot: Sendable, Identifiable {
    public let id = UUID()
    public let path: String
    public let base64: String
    public init(path: String, base64: String) {
        self.path = path; self.base64 = base64
    }
}

public struct AcCheckDetail: Sendable {
    public let criterion: String
    public let passed: Bool
    public let reasoning: String
    public let screenshot: String?
    public let validationType: String?  // "web-ui" | "api" | "none"
    public init(criterion: String, passed: Bool, reasoning: String, screenshot: String? = nil, validationType: String? = nil) {
        self.criterion = criterion; self.passed = passed; self.reasoning = reasoning
        self.screenshot = screenshot; self.validationType = validationType
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
    public let lint: Bool?
    public let sast: Bool?
    public let review: Bool?
    public let buildOutput: String?
    public let testOutput: String?
    public let lintOutput: String?
    public let sastOutput: String?
    public let reviewIssues: [String]?
    public let reviewFindings: [ValidationFindingResponse]?
    public let dismissedFindingIds: Set<String>
    public let reviewReasoning: String?
    public let reviewSkipReason: String?
    public let healthCheck: HealthCheckDetail?
    public let pages: [PageDetail]?
    public let acValidation: Bool?
    public let acChecks: [AcCheckDetail]?
    public let requirementsCheck: [RequirementCheckDetail]?
    public let taskReviewScreenshots: [String]?
    /// Smoke-page screenshots surfaced on the Summary tab as proof-of-work (independent of pass/fail).
    public let proofOfWorkScreenshots: [PageScreenshot]?
    /// The formatted markdown feedback that was sent back to the agent after a failed validation attempt.
    public let correctionMessage: String?
    public init(
        smoke: Bool, tests: Bool? = nil, lint: Bool? = nil, sast: Bool? = nil, review: Bool? = nil,
        buildOutput: String? = nil, testOutput: String? = nil,
        lintOutput: String? = nil, sastOutput: String? = nil,
        reviewIssues: [String]? = nil, reviewFindings: [ValidationFindingResponse]? = nil,
        dismissedFindingIds: Set<String> = [],
        reviewReasoning: String? = nil,
        reviewSkipReason: String? = nil,
        healthCheck: HealthCheckDetail? = nil,
        pages: [PageDetail]? = nil,
        acValidation: Bool? = nil,
        acChecks: [AcCheckDetail]? = nil,
        requirementsCheck: [RequirementCheckDetail]? = nil,
        taskReviewScreenshots: [String]? = nil,
        proofOfWorkScreenshots: [PageScreenshot]? = nil,
        correctionMessage: String? = nil
    ) {
        self.smoke = smoke; self.tests = tests; self.lint = lint; self.sast = sast
        self.review = review
        self.buildOutput = buildOutput; self.testOutput = testOutput
        self.lintOutput = lintOutput; self.sastOutput = sastOutput
        self.reviewIssues = reviewIssues; self.reviewFindings = reviewFindings
        self.dismissedFindingIds = dismissedFindingIds
        self.reviewReasoning = reviewReasoning
        self.reviewSkipReason = reviewSkipReason
        self.healthCheck = healthCheck; self.pages = pages
        self.acValidation = acValidation; self.acChecks = acChecks
        self.requirementsCheck = requirementsCheck
        self.taskReviewScreenshots = taskReviewScreenshots
        self.proofOfWorkScreenshots = proofOfWorkScreenshots
        self.correctionMessage = correctionMessage
    }

    public var allPassed: Bool {
        smoke && (tests ?? true) && (lint ?? true) && (sast ?? true)
        && (review ?? true) && (acValidation ?? true)
    }
}

// MARK: - Live validation progress (streams as phases complete)

public enum PhaseStatus: Sendable, Equatable {
    case notStarted, running, passed, failed, skipped

    public var icon: String {
        switch self {
        case .notStarted: return "circle"
        case .running:    return "arrow.triangle.2.circlepath"
        case .passed:     return "checkmark.circle.fill"
        case .failed:     return "xmark.circle.fill"
        case .skipped:    return "minus.circle"
        }
    }

    public var color: Color {
        switch self {
        case .notStarted: return .secondary
        case .running:    return .accentColor
        case .passed:     return .green
        case .failed:     return .red
        case .skipped:    return .secondary
        }
    }

    public var isTerminal: Bool { self != .notStarted && self != .running }
}

public struct ValidationPhaseState: Sendable {
    public let status: PhaseStatus
    /// Duration in milliseconds (only set for phases that report it: build, test, health).
    public let duration: Int?
    public init(status: PhaseStatus, duration: Int? = nil) {
        self.status = status; self.duration = duration
    }
    public static let notStarted = ValidationPhaseState(status: .notStarted)
}

/// Detail data for the Review phase chip.
public struct ReviewPhaseDetail: Sendable {
    public let status: String   // "pass" | "fail" | "uncertain"
    public let reasoning: String
    public let issues: [String]
    public let requirementsCheck: [RequirementCheckDetail]?
    public let screenshots: [String]
    public init(
        status: String, reasoning: String, issues: [String],
        requirementsCheck: [RequirementCheckDetail]?, screenshots: [String]
    ) {
        self.status = status; self.reasoning = reasoning; self.issues = issues
        self.requirementsCheck = requirementsCheck; self.screenshots = screenshots
    }
}

/// Live per-phase state built up as `pod.validation_phase_*` events arrive.
public struct ValidationProgress: Sendable {
    public var attempt: Int

    // Phase status (updated by events)
    public var build: ValidationPhaseState
    public var test: ValidationPhaseState
    public var lint: ValidationPhaseState
    public var sast: ValidationPhaseState
    public var health: ValidationPhaseState
    public var pages: ValidationPhaseState
    public var ac: ValidationPhaseState
    public var review: ValidationPhaseState

    // Phase result data (populated on completion, used by detail panel)
    public var buildOutput: String?          // build logs
    public var testOutput: String?           // combined stdout/stderr
    public var lintOutput: String?           // lint stdout/stderr
    public var sastOutput: String?           // SAST stdout/stderr
    public var healthDetail: HealthCheckDetail?
    public var pageDetails: [PageDetail]?
    public var acChecks: [AcCheckDetail]?
    public var reviewDetail: ReviewPhaseDetail?

    // Counts for chip sub-labels
    public var pageCount: Int
    public var acTotalCount: Int

    // The currently running phase (drives auto-selection in the chip row)
    public var activePhase: ValidationPhase?

    public static func initial(attempt: Int) -> ValidationProgress {
        let idle = ValidationPhaseState.notStarted
        return ValidationProgress(
            attempt: attempt,
            build: idle, test: idle, lint: idle, sast: idle,
            health: idle, pages: idle, ac: idle, review: idle,
            pageCount: 0, acTotalCount: 0
        )
    }

    public func state(for phase: ValidationPhase) -> ValidationPhaseState {
        switch phase {
        case .build:   return build
        case .test:    return test
        case .lint:    return lint
        case .sast:    return sast
        case .health:  return health
        case .pages:   return pages
        case .ac:      return ac
        case .review:  return review
        }
    }

    public mutating func markStarted(_ phase: ValidationPhase) {
        activePhase = phase
        let s = ValidationPhaseState(status: .running)
        switch phase {
        case .build:   build   = s
        case .test:    test    = s
        case .lint:    lint    = s
        case .sast:    sast    = s
        case .health:  health  = s
        case .pages:   pages   = s
        case .ac:      ac      = s
        case .review:  review  = s
        }
    }

    public mutating func markCompleted(_ phase: ValidationPhase, result: ValidationPhaseResult) {
        let ps: PhaseStatus = result.phaseStatus == "pass" ? .passed
            : result.phaseStatus == "fail" ? .failed
            : .skipped
        switch phase {
        case .build:
            build = ValidationPhaseState(status: ps, duration: result.buildResult?.duration)
            buildOutput = result.buildResult.map { $0.output.isEmpty ? nil : $0.output } ?? nil
        case .test:
            test = ValidationPhaseState(status: ps, duration: result.testResult?.duration)
            let stdout = result.testResult?.stdout ?? ""
            let stderr = result.testResult?.stderr ?? ""
            testOutput = [stdout, stderr].filter { !$0.isEmpty }.joined(separator: "\n")
            if testOutput?.isEmpty == true { testOutput = nil }
        case .lint:
            lint = ValidationPhaseState(status: ps, duration: result.lintResult?.duration)
            lintOutput = result.lintResult.flatMap { $0.output.isEmpty ? nil : $0.output }
        case .sast:
            sast = ValidationPhaseState(status: ps, duration: result.sastResult?.duration)
            sastOutput = result.sastResult.flatMap { $0.output.isEmpty ? nil : $0.output }
        case .health:
            health = ValidationPhaseState(status: ps, duration: result.healthResult?.duration)
            if let h = result.healthResult {
                healthDetail = HealthCheckDetail(
                    status: h.status, url: h.url,
                    responseCode: h.responseCode, duration: h.duration,
                    responseBody: h.responseBody
                )
            }
        case .pages:
            pages = ValidationPhaseState(status: ps)
            pageCount = result.pageResults?.count ?? 0
            pageDetails = result.pageResults?.map { page in
                PageDetail(
                    path: page.path,
                    status: page.status,
                    consoleErrors: page.consoleErrors,
                    assertions: page.assertions.map { a in
                        AssertionDetail(
                            selector: a.selector, type: a.type,
                            expected: a.expected, actual: a.actual, passed: a.passed
                        )
                    },
                    loadTime: page.loadTime,
                    screenshotBase64: page.screenshotBase64
                )
            }
        case .ac:
            ac = ValidationPhaseState(status: ps)
            acTotalCount = result.acResult?.results.count ?? 0
            acChecks = result.acResult?.results.map { check in
                AcCheckDetail(
                    criterion: check.criterion, passed: check.passed,
                    reasoning: check.reasoning, screenshot: check.screenshot,
                    validationType: check.validationType
                )
            }
        case .review:
            review = ValidationPhaseState(status: ps)
            if let r = result.reviewResult {
                reviewDetail = ReviewPhaseDetail(
                    status: r.status, reasoning: r.reasoning, issues: r.issues,
                    requirementsCheck: r.requirementsCheck?.map { rc in
                        RequirementCheckDetail(criterion: rc.criterion, met: rc.met, note: rc.note)
                    },
                    screenshots: r.screenshots
                )
            }
        }
        if activePhase == phase { activePhase = nil }
    }
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

// MARK: - Pod

public struct Pod: Identifiable, Sendable {
    public let id: String
    public var status: PodStatus
    public var pod: PodConfig
    public var hasWorktree: Bool
    public var branch: String
    public var profileName: String
    public var task: String
    public var model: String
    public var startedAt: Date
    public var updatedAt: Date

    /// Base branch this pod was forked from (workspace handoff)
    public var baseBranch: String?
    /// Path to AC file loaded from repo (workspace handoff)
    public var acFrom: String?
    /// Acceptance criteria (loaded from acFrom or manual input)
    public var acceptanceCriteria: [AcDefinition]?

    public var diffStats: DiffStats?
    public var escalationQuestion: String?
    public var escalationOptions: [String]?
    public var escalationType: String?
    public var validationChecks: ValidationChecks?
    /// Live per-phase validation state streamed from the daemon as each phase completes.
    public var validationProgress: ValidationProgress?
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

    /// Linked pod ID for pod chaining (workspace ↔ worker handoff)
    public var linkedSessionId: String?

    /// Snapshot of the resolved profile config at pod creation time
    public var profileSnapshot: Profile?

    /// Host-filesystem path where artifacts were extracted — only set after
    /// an artifact-output pod completes. Used by the Overview tab to offer
    /// "Reveal in Finder".
    public var artifactsPath: String?

    /// Names of sidecars this pod requested at creation (e.g. `["dagger"]`).
    public var requireSidecars: [String]
    /// Map of sidecar name → container id for currently-running sidecars.
    public var sidecarContainerIds: [String: String]
    /// Branches this pod pushed to the configured test repo (cleared on pod end).
    public var testRunBranches: [String]

    /// Set by the daemon when the auto-commit deletion guard aborted a commit —
    /// the host worktree is out of sync with the container. When true, the desktop
    /// must block retry / merge actions and show a recovery banner: the agent's
    /// real work may still live in the container.
    public var worktreeCompromised: Bool

    /// Whether validation is toggled off at runtime — the next validation result will be bypassed.
    public var skipValidation: Bool

    /// Human-readable title from the brief's YAML frontmatter. Nil for standalone pods.
    public var briefTitle: String?

    // MARK: - Series (pod dependency DAG)

    /// Series this pod belongs to, or nil for standalone pods.
    public var seriesId: String?
    /// Human-readable series name (shared across all pods in a series).
    public var seriesName: String?
    /// Overall spec description (from context.md), shared across all pods in a series.
    public var seriesDescription: String?
    /// Series design notes (from design.md), shared across all pods in a series.
    public var seriesDesign: String?
    /// Pod IDs this pod depends on. Fan-in supported: a pod is only enqueued
    /// when *all* listed parents reach `validated`.
    public var dependsOnPodIds: [String]
    /// When the dependency gate opened and this pod moved from queued to enqueued.
    public var dependencyStartedAt: Date?

    /// Backward-compat convenience derived from `pod`.
    public var outputMode: OutputMode { pod.legacyOutputMode }

    public var isWorkspace: Bool { pod.agentMode == .interactive }

    /// Can this pod be promoted to agent-driven mode (interactive → auto)?
    public var isPromotable: Bool {
        guard pod.isPromotable else { return false }
        switch status {
        case .running, .awaitingInput, .paused: return true
        default: return false
        }
    }

    /// Whether this pod is in a terminal state and can be deleted.
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
        status: PodStatus,
        pod: PodConfig = PodConfig(),
        hasWorktree: Bool = false,
        branch: String,
        profileName: String,
        task: String = "",
        model: String,
        startedAt: Date,
        updatedAt: Date = Date(),
        baseBranch: String? = nil,
        acFrom: String? = nil,
        acceptanceCriteria: [AcDefinition]? = nil,
        diffStats: DiffStats? = nil,
        escalationQuestion: String? = nil,
        escalationOptions: [String]? = nil,
        escalationType: String? = nil,
        validationChecks: ValidationChecks? = nil,
        validationProgress: ValidationProgress? = nil,
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
        profileSnapshot: Profile? = nil,
        briefTitle: String? = nil,
        seriesId: String? = nil,
        seriesName: String? = nil,
        seriesDescription: String? = nil,
        seriesDesign: String? = nil,
        dependsOnPodIds: [String] = [],
        dependencyStartedAt: Date? = nil,
        artifactsPath: String? = nil,
        requireSidecars: [String] = [],
        sidecarContainerIds: [String: String] = [:],
        testRunBranches: [String] = [],
        worktreeCompromised: Bool = false,
        skipValidation: Bool = false
    ) {
        self.id = id; self.status = status; self.pod = pod
        self.hasWorktree = hasWorktree
        self.branch = branch; self.profileName = profileName; self.task = task
        self.model = model; self.startedAt = startedAt; self.updatedAt = updatedAt
        self.baseBranch = baseBranch
        self.acFrom = acFrom; self.acceptanceCriteria = acceptanceCriteria
        self.diffStats = diffStats; self.escalationQuestion = escalationQuestion
        self.escalationOptions = escalationOptions; self.escalationType = escalationType
        self.validationChecks = validationChecks; self.validationProgress = validationProgress; self.prUrl = prUrl
        self.containerUrl = containerUrl; self.plan = plan; self.phase = phase
        self.latestActivity = latestActivity; self.errorSummary = errorSummary
        self.attempts = attempts; self.queuePosition = queuePosition
        self.inputTokens = inputTokens; self.outputTokens = outputTokens
        self.costUsd = costUsd; self.commitCount = commitCount
        self.taskSummary = taskSummary; self.linkedSessionId = linkedSessionId
        self.profileSnapshot = profileSnapshot
        self.briefTitle = briefTitle
        self.seriesId = seriesId; self.seriesName = seriesName; self.seriesDescription = seriesDescription
        self.seriesDesign = seriesDesign
        self.dependsOnPodIds = dependsOnPodIds
        self.dependencyStartedAt = dependencyStartedAt
        self.artifactsPath = artifactsPath
        self.requireSidecars = requireSidecars
        self.sidecarContainerIds = sidecarContainerIds
        self.testRunBranches = testRunBranches
        self.worktreeCompromised = worktreeCompromised
        self.skipValidation = skipValidation
    }

    /// Back-compat init that takes a legacy `OutputMode` and derives a `PodConfig`.
    public init(
        id: String = UUID().uuidString,
        status: PodStatus,
        outputMode: OutputMode,
        branch: String,
        profileName: String,
        task: String = "",
        model: String,
        startedAt: Date,
        updatedAt: Date = Date(),
        baseBranch: String? = nil,
        acFrom: String? = nil,
        acceptanceCriteria: [AcDefinition]? = nil,
        diffStats: DiffStats? = nil,
        escalationQuestion: String? = nil,
        escalationOptions: [String]? = nil,
        escalationType: String? = nil,
        validationChecks: ValidationChecks? = nil,
        validationProgress: ValidationProgress? = nil,
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
        profileSnapshot: Profile? = nil,
        seriesId: String? = nil,
        seriesName: String? = nil,
        seriesDescription: String? = nil,
        dependsOnPodIds: [String] = [],
        dependencyStartedAt: Date? = nil
    ) {
        self.init(
            id: id, status: status,
            pod: PodConfig.fromLegacy(outputMode.rawValue),
            branch: branch, profileName: profileName, task: task, model: model,
            startedAt: startedAt, updatedAt: updatedAt,
            baseBranch: baseBranch, acFrom: acFrom, acceptanceCriteria: acceptanceCriteria,
            diffStats: diffStats,
            escalationQuestion: escalationQuestion, escalationOptions: escalationOptions,
            escalationType: escalationType,
            validationChecks: validationChecks, validationProgress: validationProgress,
            prUrl: prUrl, containerUrl: containerUrl,
            plan: plan, phase: phase,
            latestActivity: latestActivity, errorSummary: errorSummary,
            attempts: attempts, queuePosition: queuePosition,
            inputTokens: inputTokens, outputTokens: outputTokens,
            costUsd: costUsd, commitCount: commitCount,
            taskSummary: taskSummary, linkedSessionId: linkedSessionId,
            profileSnapshot: profileSnapshot,
            seriesId: seriesId, seriesName: seriesName, seriesDescription: seriesDescription,
            dependsOnPodIds: dependsOnPodIds,
            dependencyStartedAt: dependencyStartedAt
        )
    }
}
