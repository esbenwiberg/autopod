import Foundation

/// Response from GET /pods/:id/cost — per-pod cost grouped into operator-facing buckets.
public struct PodCostBreakdownResponse: Codable, Equatable, Sendable {
  public let podId: String
  public let model: String?
  public let totalCostUsd: Double
  public let inputTokens: Int
  public let outputTokens: Int
  public let segments: [PodCostSegment]
  public let taskExecution: TaskExecutionSummary?

  public init(
    podId: String,
    model: String?,
    totalCostUsd: Double,
    inputTokens: Int,
    outputTokens: Int,
    segments: [PodCostSegment],
    taskExecution: TaskExecutionSummary? = nil
  ) {
    self.podId = podId
    self.model = model
    self.totalCostUsd = totalCostUsd
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.segments = segments
    self.taskExecution = taskExecution
  }
}

public struct PodCostSegment: Codable, Equatable, Sendable, Identifiable {
  public var id: String { bucket }

  /// "work" | "rework" | "validation" | "advisory" | "unattributed"
  public let bucket: String
  public let label: String
  public let costUsd: Double
  public let inputTokens: Int
  public let outputTokens: Int
  public let sourcePhases: [String]

  public init(
    bucket: String,
    label: String,
    costUsd: Double,
    inputTokens: Int,
    outputTokens: Int,
    sourcePhases: [String]
  ) {
    self.bucket = bucket
    self.label = label
    self.costUsd = costUsd
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.sourcePhases = sourcePhases
  }
}

public struct TaskExecutionSummary: Codable, Equatable, Sendable {
  public let taskId: String
  public let executionId: String
  public let rootPodId: String
  public let podCount: Int
  public let agentRunCount: Int
  public let failedRunCount: Int
  public let transientFailureCount: Int
  public let providerAttemptCount: Int
  public let validationExecutionCount: Int
  public let tokenBudget: Int?
  public let recordedInputTokens: Int
  public let recordedOutputTokens: Int
  public let recordedCostUsd: Double
  public let infrastructureCostUsd: Double?
  public let telemetry: String
  public let diagnostics: [String]
}
