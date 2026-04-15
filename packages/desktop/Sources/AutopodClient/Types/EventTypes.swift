import Foundation

// MARK: - System events (mirrors packages/shared/src/types/events.ts)

/// Raw WebSocket event — decoded by type field, then dispatched.
public struct RawSystemEvent: Codable, Sendable {
  public let type: String
  public let timestamp: String
  // Event ID added by server for replay tracking
  // swiftlint:disable:next identifier_name
  public let _eventId: Int?

  // session.created
  public let session: SessionSummaryResponse?

  // session.status_changed
  public let sessionId: String?
  public let previousStatus: String?
  public let newStatus: String?

  // session.agent_activity
  public let event: AgentEventResponse?

  // session.validation_started / completed
  public let attempt: Int?
  public let result: ValidationResponse?

  // session.escalation_created
  public let escalation: EscalationResponse?

  // session.escalation_resolved
  public let escalationId: String?
  public let response: EscalationReply?

  // session.completed
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

// MARK: - Typed event enum (parsed from RawSystemEvent)

public enum SystemEvent: Sendable {
  case sessionCreated(SessionSummaryResponse)
  case statusChanged(sessionId: String, from: String, to: String)
  case agentActivity(sessionId: String, event: AgentEventResponse)
  case validationStarted(sessionId: String, attempt: Int)
  case validationCompleted(sessionId: String, result: ValidationResponse)
  case escalationCreated(sessionId: String, escalation: EscalationResponse)
  case escalationResolved(sessionId: String, escalationId: String)
  case sessionCompleted(sessionId: String, finalStatus: String, summary: SessionSummaryResponse)
  case memorySuggestionCreated(sessionId: String, entry: MemoryEntry)
  case validationOverrideQueued(sessionId: String, override: ValidationOverrideEntry)
  case scheduledJobCatchupRequested(jobId: String, jobName: String, lastRunAt: String?)
  case scheduledJobFired(jobId: String, jobName: String, sessionId: String)

  public var eventId: Int? { nil }  // Set externally from _eventId

  public static func parse(_ raw: RawSystemEvent) -> SystemEvent? {
    switch raw.type {
    case "session.created":
      guard let session = raw.session else { return nil }
      return .sessionCreated(session)

    case "session.status_changed":
      guard let id = raw.sessionId, let from = raw.previousStatus, let to = raw.newStatus
      else { return nil }
      return .statusChanged(sessionId: id, from: from, to: to)

    case "session.agent_activity":
      guard let id = raw.sessionId, let event = raw.event else { return nil }
      return .agentActivity(sessionId: id, event: event)

    case "session.validation_started":
      guard let id = raw.sessionId, let attempt = raw.attempt else { return nil }
      return .validationStarted(sessionId: id, attempt: attempt)

    case "session.validation_completed":
      guard let id = raw.sessionId, let result = raw.result else { return nil }
      return .validationCompleted(sessionId: id, result: result)

    case "session.escalation_created":
      guard let id = raw.sessionId, let escalation = raw.escalation else { return nil }
      return .escalationCreated(sessionId: id, escalation: escalation)

    case "session.escalation_resolved":
      guard let id = raw.sessionId, let escId = raw.escalationId else { return nil }
      return .escalationResolved(sessionId: id, escalationId: escId)

    case "session.completed":
      guard let id = raw.sessionId, let status = raw.finalStatus, let summary = raw.summary
      else { return nil }
      return .sessionCompleted(sessionId: id, finalStatus: status, summary: summary)

    case "memory.suggestion_created":
      guard let id = raw.sessionId, let entry = raw.memoryEntry else { return nil }
      return .memorySuggestionCreated(sessionId: id, entry: entry)

    case "validation.override_queued":
      guard let id = raw.sessionId, let ov = raw.override else { return nil }
      return .validationOverrideQueued(sessionId: id, override: ov)

    case "scheduled_job.catchup_requested":
      guard let jobId = raw.jobId else { return nil }
      return .scheduledJobCatchupRequested(
        jobId: jobId,
        jobName: raw.jobName ?? jobId,
        lastRunAt: raw.lastRunAt
      )

    case "scheduled_job.fired":
      guard let jobId = raw.jobId, let sessionId = raw.sessionId else { return nil }
      return .scheduledJobFired(
        jobId: jobId,
        jobName: raw.jobName ?? jobId,
        sessionId: sessionId
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
