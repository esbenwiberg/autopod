import Foundation

// MARK: - System events (mirrors packages/shared/src/types/events.ts)

/// Raw WebSocket event — decoded by type field, then dispatched.
public struct RawSystemEvent: Codable, Sendable {
  public let type: String
  public let timestamp: String
  // Event ID added by server for replay tracking
  // swiftlint:disable:next identifier_name
  public let _eventId: Int?

  // pod.created
  public let pod: SessionSummaryResponse?

  // pod.status_changed
  public let podId: String?
  public let previousStatus: String?
  public let newStatus: String?

  // pod.agent_activity
  public let event: AgentEventResponse?

  // pod.validation_started / completed
  public let attempt: Int?
  public let result: ValidationResponse?

  // pod.validation_phase_started / pod.validation_phase_completed
  public let phase: String?
  public let phaseStatus: String?
  // Phase-specific results (only one is set per validation_phase_completed event):
  public let buildResult: BuildResultResponse?
  public let testResult: TestResultResponse?
  public let lintResult: LintResultResponse?
  public let sastResult: SastResultResponse?
  public let healthResult: HealthResultResponse?
  public let pageResults: [PageResultResponse]?
  public let acResult: AcValidationResponse?
  public let reviewResult: TaskReviewResponse?

  // pod.escalation_created
  public let escalation: EscalationResponse?

  // pod.escalation_resolved
  public let escalationId: String?
  public let response: EscalationReply?

  // pod.completed
  public let finalStatus: String?
  public let summary: SessionSummaryResponse?

  // memory.suggestion_created
  public let memoryEntry: MemoryEntry?

  // validation.override_queued
  public let override: ValidationOverrideEntry?

  // scheduled_job.catchup_requested / scheduled_job.fired
  public let jobId: String?
  public let jobName: String?
  public let lastRunAt: String?
}

// MARK: - ValidationPhase

public enum ValidationPhase: String, Sendable, CaseIterable {
  case lint
  case sast
  case build
  case test
  case health
  case pages
  case ac
  case review

  public var displayName: String {
    switch self {
    case .build: return "Build"
    case .test: return "Tests"
    case .lint: return "Lint"
    case .sast: return "SAST"
    case .health: return "Health"
    case .pages: return "Pages"
    case .ac: return "AC"
    case .review: return "Review"
    }
  }
}

// MARK: - ValidationPhaseResult

/// Carries the per-phase result data from a pod.validation_phase_completed event.
/// Exactly one result field is populated, matching the phase.
public struct ValidationPhaseResult: Sendable {
  public let phaseStatus: String  // "pass" | "fail" | "skip"
  public let buildResult: BuildResultResponse?
  public let testResult: TestResultResponse?
  public let lintResult: LintResultResponse?
  public let sastResult: SastResultResponse?
  public let healthResult: HealthResultResponse?
  public let pageResults: [PageResultResponse]?
  public let acResult: AcValidationResponse?
  public let reviewResult: TaskReviewResponse?

  init(from raw: RawSystemEvent) {
    phaseStatus = raw.phaseStatus ?? "skip"
    buildResult = raw.buildResult
    testResult = raw.testResult
    lintResult = raw.lintResult
    sastResult = raw.sastResult
    healthResult = raw.healthResult
    pageResults = raw.pageResults
    acResult = raw.acResult
    reviewResult = raw.reviewResult
  }
}

// MARK: - Typed event enum (parsed from RawSystemEvent)

public enum SystemEvent: Sendable {
  case sessionCreated(SessionSummaryResponse)
  case statusChanged(podId: String, from: String, to: String)
  case agentActivity(podId: String, event: AgentEventResponse)
  case validationStarted(podId: String, attempt: Int)
  case validationCompleted(podId: String, result: ValidationResponse)
  case validationPhaseStarted(podId: String, phase: ValidationPhase)
  case validationPhaseCompleted(podId: String, phase: ValidationPhase, result: ValidationPhaseResult)
  case escalationCreated(podId: String, escalation: EscalationResponse)
  case escalationResolved(podId: String, escalationId: String)
  case sessionCompleted(podId: String, finalStatus: String, summary: SessionSummaryResponse)
  case memorySuggestionCreated(podId: String, entry: MemoryEntry)
  case validationOverrideQueued(podId: String, override: ValidationOverrideEntry)
  case scheduledJobCatchupRequested(jobId: String, jobName: String, lastRunAt: String?)
  case scheduledJobFired(jobId: String, jobName: String, podId: String)

  public var eventId: Int? { nil }  // Set externally from _eventId

  public static func parse(_ raw: RawSystemEvent) -> SystemEvent? {
    switch raw.type {
    case "pod.created":
      guard let pod = raw.pod else { return nil }
      return .sessionCreated(pod)

    case "pod.status_changed":
      guard let id = raw.podId, let from = raw.previousStatus, let to = raw.newStatus
      else { return nil }
      return .statusChanged(podId: id, from: from, to: to)

    case "pod.agent_activity":
      guard let id = raw.podId, let event = raw.event else { return nil }
      return .agentActivity(podId: id, event: event)

    case "pod.validation_started":
      guard let id = raw.podId, let attempt = raw.attempt else { return nil }
      return .validationStarted(podId: id, attempt: attempt)

    case "pod.validation_completed":
      guard let id = raw.podId, let result = raw.result else { return nil }
      return .validationCompleted(podId: id, result: result)

    case "pod.validation_phase_started":
      guard let id = raw.podId, let phaseStr = raw.phase,
            let phase = ValidationPhase(rawValue: phaseStr) else { return nil }
      return .validationPhaseStarted(podId: id, phase: phase)

    case "pod.validation_phase_completed":
      guard let id = raw.podId, let phaseStr = raw.phase,
            let phase = ValidationPhase(rawValue: phaseStr) else { return nil }
      return .validationPhaseCompleted(podId: id, phase: phase, result: ValidationPhaseResult(from: raw))

    case "pod.escalation_created":
      guard let id = raw.podId, let escalation = raw.escalation else { return nil }
      return .escalationCreated(podId: id, escalation: escalation)

    case "pod.escalation_resolved":
      guard let id = raw.podId, let escId = raw.escalationId else { return nil }
      return .escalationResolved(podId: id, escalationId: escId)

    case "pod.completed":
      guard let id = raw.podId, let status = raw.finalStatus, let summary = raw.summary
      else { return nil }
      return .sessionCompleted(podId: id, finalStatus: status, summary: summary)

    case "memory.suggestion_created":
      guard let id = raw.podId, let entry = raw.memoryEntry else { return nil }
      return .memorySuggestionCreated(podId: id, entry: entry)

    case "validation.override_queued":
      guard let id = raw.podId, let ov = raw.override else { return nil }
      return .validationOverrideQueued(podId: id, override: ov)

    case "scheduled_job.catchup_requested":
      guard let jobId = raw.jobId else { return nil }
      return .scheduledJobCatchupRequested(
        jobId: jobId,
        jobName: raw.jobName ?? jobId,
        lastRunAt: raw.lastRunAt
      )

    case "scheduled_job.fired":
      guard let jobId = raw.jobId, let podId = raw.podId else { return nil }
      return .scheduledJobFired(
        jobId: jobId,
        jobName: raw.jobName ?? jobId,
        podId: podId
      )

    default:
      return nil
    }
  }
}

// MARK: - ValidationOverrideEntry

public struct ValidationOverrideEntry: Codable, Sendable {
  public let findingId: String
  public let description: String
  public let action: String
  public let reason: String?
  public let guidance: String?
  public let createdAt: String
}

// MARK: - Agent event (mirrors packages/shared/src/types/runtime.ts AgentEvent)

public struct AgentEventResponse: Codable, Sendable {
  public let type: String
  public let timestamp: String

  // status
  public let message: String?

  // tool_use
  public let tool: String?
  public let input: AnyCodable?
  /// `output` is normally a plain string, but legacy events (pre-c97af9a) stored it as a
  /// content-block array. The custom decoder below handles both shapes.
  public let output: String?

  // file_change
  public let path: String?
  public let action: String?
  public let diff: String?

  // complete
  // Note: `result` conflicts with validation result, use different decode path
  public let totalInputTokens: Int?
  public let totalOutputTokens: Int?
  public let costUsd: Double?

  // error
  public let fatal: Bool?

  // escalation
  public let escalationType: String?
  public let payload: EscalationPayload?

  // plan
  public let summary: String?
  public let steps: [String]?

  // progress
  public let phase: String?
  public let description: String?
  public let currentPhase: Int?
  public let totalPhases: Int?

  // task_summary
  public let actualSummary: String?
  public let deviations: [DeviationResponse]?

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    type = try c.decode(String.self, forKey: .type)
    timestamp = try c.decode(String.self, forKey: .timestamp)
    message = try c.decodeIfPresent(String.self, forKey: .message)
    tool = try c.decodeIfPresent(String.self, forKey: .tool)
    input = try c.decodeIfPresent(AnyCodable.self, forKey: .input)
    // `output` can be a String or a legacy array of content blocks — normalize to String.
    output = try decodeStringOrArray(c, key: .output)
    path = try c.decodeIfPresent(String.self, forKey: .path)
    action = try c.decodeIfPresent(String.self, forKey: .action)
    diff = try c.decodeIfPresent(String.self, forKey: .diff)
    totalInputTokens = try c.decodeIfPresent(Int.self, forKey: .totalInputTokens)
    totalOutputTokens = try c.decodeIfPresent(Int.self, forKey: .totalOutputTokens)
    costUsd = try c.decodeIfPresent(Double.self, forKey: .costUsd)
    fatal = try c.decodeIfPresent(Bool.self, forKey: .fatal)
    escalationType = try c.decodeIfPresent(String.self, forKey: .escalationType)
    payload = try c.decodeIfPresent(EscalationPayload.self, forKey: .payload)
    summary = try c.decodeIfPresent(String.self, forKey: .summary)
    steps = try c.decodeIfPresent([String].self, forKey: .steps)
    phase = try c.decodeIfPresent(String.self, forKey: .phase)
    description = try c.decodeIfPresent(String.self, forKey: .description)
    currentPhase = try c.decodeIfPresent(Int.self, forKey: .currentPhase)
    totalPhases = try c.decodeIfPresent(Int.self, forKey: .totalPhases)
    actualSummary = try c.decodeIfPresent(String.self, forKey: .actualSummary)
    deviations = try c.decodeIfPresent([DeviationResponse].self, forKey: .deviations)
  }
}
