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
  public let costEvidence: CostEvidence?
  public let resourceCost: PodResourceCost?

  public var combinedCostUsd: Double { totalCostUsd + (resourceCost?.usableEstimate ?? 0) }
  public var totalLabel: String {
    let modelUsable = costEvidence.map {
      $0.unavailablePhaseCount == 0 && $0.conflictingPodCount == 0 &&
        !$0.diagnostics.contains { ["AGENT_COST_UNAVAILABLE", "PHASE_PAYLOAD_LIMIT", "PHASE_PAYLOAD_INVALID", "UNKNOWN_COST_PHASE"].contains($0.code) }
    } ??
      !segments.contains { $0.attribution == "unavailable" && ($0.inputTokens + $0.outputTokens > 0 || ($0.storedCostUsd ?? 0) > 0) }
    return resourceCost?.state == "estimated" && resourceCost?.usableEstimate != nil && modelUsable
      ? "Estimated total" : "Known total"
  }

  public init(
    podId: String,
    model: String?,
    totalCostUsd: Double,
    inputTokens: Int,
    outputTokens: Int,
    segments: [PodCostSegment],
    taskExecution: TaskExecutionSummary? = nil,
    costEvidence: CostEvidence? = nil,
    resourceCost: PodResourceCost? = nil
  ) {
    self.podId = podId
    self.model = model
    self.totalCostUsd = totalCostUsd
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.segments = segments
    self.taskExecution = taskExecution
    self.costEvidence = costEvidence
    self.resourceCost = resourceCost
  }
}

public struct PodResourceCost: Codable, Equatable, Sendable {
  public let state: String
  public let estimateUsd: Double?
  public let observationCutoff: String?
  public var usableEstimate: Double? {
    guard state == "estimated" || state == "partial", let estimateUsd,
      estimateUsd.isFinite, estimateUsd >= 0 else { return nil }
    return estimateUsd
  }
  public var qualifier: String { state == "partial" ? "partial est." : "est." }
  public init(state: String, estimateUsd: Double?, observationCutoff: String?) {
    self.state = state; self.estimateUsd = estimateUsd; self.observationCutoff = observationCutoff
  }
}

public struct PodCostSegment: Codable, Equatable, Sendable, Identifiable {
  public var id: String { bucket }

  /// "work" | "rework" | "validation" | "advisory" | "unattributed"
  public let bucket: String
  public let label: String
  public let costUsd: Double
  public let storedCostUsd: Double?
  public let attribution: String?
  public let inputTokens: Int
  public let outputTokens: Int
  public let sourcePhases: [String]

  public init(
    bucket: String,
    label: String,
    costUsd: Double,
    inputTokens: Int,
    outputTokens: Int,
    sourcePhases: [String],
    storedCostUsd: Double? = nil,
    attribution: String? = nil
  ) {
    self.bucket = bucket
    self.label = label
    self.costUsd = costUsd
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.sourcePhases = sourcePhases
    self.storedCostUsd = storedCostUsd
    self.attribution = attribution
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
  public let delivery: TaskDeliverySummaryResponse?
  public let merge: TaskMergeSummaryResponse?
  public let tokenBudget: Int?
  public let budgetCheck: TaskBudgetCheckResponse?
  public let recordedInputTokens: Int
  public let recordedOutputTokens: Int
  public let recordedUnclassifiedTokens: Int?
  public let recordedTotalTokens: Int?
  public let budgetCountedTokens: Int?
  public var tokensCountedForBudget: Int { budgetCountedTokens ?? totalRecordedTokens }
  public var totalRecordedTokens: Int {
    recordedTotalTokens ?? (recordedInputTokens + recordedOutputTokens + (recordedUnclassifiedTokens ?? 0))
  }
  public let recordedCostUsd: Double
  public let costEvidence: CostEvidence?
  public let infrastructureCostUsd: Double?
  public let telemetry: String
  public let diagnostics: [String]
}

public struct TaskDeliverySummaryResponse: Codable, Equatable, Sendable {
  public let intentCount: Int
  public let receiptCount: Int
  public let unresolvedCount: Int
  public let scope: String
  public let disposition: TaskDeliveryDispositionResponse?
}

public struct TaskDeliveryDispositionResponse: Codable, Equatable, Sendable {
  public let openCount: Int
  public let mergedCount: Int
  public let closedCount: Int
  public let unavailableCount: Int
  public let basis: String
  public let liveVerified: Bool
}

public struct TaskBudgetCheckResponse: Codable, Equatable, Sendable {
  public let status: String
  public let reason: String
}

public struct CostEvidence: Codable, Equatable, Sendable {
  public let basis: String
  public let billingVerified: Bool
  public let knownEstimatedCostUsd: Double
  public let unavailablePhaseCount: Int
  public let conflictingPodCount: Int
  public let diagnostics: [CostEvidenceDiagnostic]
  public let omittedDiagnosticCount: Int
}
public struct CostEvidenceDiagnostic: Codable, Equatable, Sendable {
  public let podId: String
  public let code: String
  public let message: String
}

public struct TaskMergeSummaryResponse: Codable, Equatable, Sendable {
  public let prCount: Int
  public let requestCount: Int
  public let mergedPrCount: Int
  public let closedPrCount: Int?
  public let mergedWithoutRecordedRequestCount: Int
  public let unresolvedPrCount: Int
  public let scope: String
  public let basis: String
  public let liveVerified: Bool
}
