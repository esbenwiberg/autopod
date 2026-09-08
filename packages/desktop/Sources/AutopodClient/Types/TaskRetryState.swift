import Foundation

public struct TaskRetryState: Codable, Sendable {
  public let taskId: String
  public let stage: String
  public let backoffsMs: [Int]?
  public let admissionCount: Int
  public let executedCount: Int
  public let transientRetryCount: Int
  public let measuredDurationMs: Int?
  public let durationEvidence: TaskRetryDurationEvidence?
  public var measuredDurationDescription: String {
    measuredDurationMs.map { "\($0) ms measured" } ?? "Measured duration unavailable"
  }
  public var durationEvidenceDescription: String {
    let counts = durationEvidence.map {
      "\($0.measuredRecordCount) measured records; \($0.unavailableRecordCount) records without duration; \($0.pendingRecordCount) pending."
    } ?? "Duration coverage unavailable from this daemon."
    return counts + " Stage durations can overlap; do not add them."
  }
  public let interruptedCount: Int
  public let latest: TaskRetryAttempt?
  public let authorizations: [TaskRetryAuthorization]
  public let authorizationRequired: Bool?
  public let retryFailure: String?
  public let telemetry: String
}
public struct TaskRetryDurationEvidence: Codable, Sendable {
  public let measuredRecordCount: Int
  public let unavailableRecordCount: Int
  public let pendingRecordCount: Int
  public let basis: String
  public let additiveAcrossStages: Bool
}
public struct TaskRetryAttempt: Codable, Sendable {
  public let id: String
  public let outcome: String?
  public let providerRetryNotBefore: String?
  public let startedAt: String?
  public let endedAt: String?
  public let measuredDurationMs: Int?
}
public struct TaskRetryAuthorization: Codable, Sendable, Identifiable {
  public let id: String
  public let requestKey: String
  public let failureId: String
  public let reason: String
  public let createdAt: String
  public let usedByAttemptId: String?
}
public struct TaskRetryAuthorizationRequest: Codable, Sendable {
  public let requestKey: String
  public let reason: String
  public let stage: String?
  public init(requestKey: String, reason: String, stage: String? = nil) {
    self.requestKey = requestKey; self.reason = reason; self.stage = stage
  }
}
