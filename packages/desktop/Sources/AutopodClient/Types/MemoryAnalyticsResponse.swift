import Foundation

public struct MemoryAnalyticsResponse: Codable, Equatable, Sendable {
  public let days: Int
  public let summary: MemoryAnalyticsSummary
  public let impact: MemoryAnalyticsImpact
  public let topMemories: [MemoryAnalyticsTopMemory]
}

public struct MemoryAnalyticsSummary: Codable, Equatable, Sendable {
  public let selectedCount: Int
  public let injectedCount: Int
  public let readCount: Int
  public let searchedCount: Int
  public let appliedCount: Int
  public let notApplicableCount: Int
  public let harmfulStaleCount: Int
  public let notReportedCount: Int
  public let candidateCount: Int
  public let approvedCandidateCount: Int
}

public struct MemoryAnalyticsImpact: Codable, Equatable, Sendable {
  public let cohortSize: Int
  public let comparisonCohortSize: Int
  public let qualityDelta: Double?
  public let validationFailureDelta: Double?
  public let fixAttemptDelta: Double?
  public let escalationDelta: Double?
  public let costDeltaUsd: Double?
  public let reworkDelta: Double?
  public let firstPassRateDelta: Double?
  public let throughputDelta: Double?
}

public struct MemoryAnalyticsTopMemory: Codable, Equatable, Sendable {
  public let memoryId: String
  public let path: String
  public let impactSummary: String?
  public let selectedCount: Int
  public let injectedCount: Int
  public let appliedCount: Int
  public let harmfulStaleCount: Int
}
