import Foundation

public struct TaskRetryState: Codable, Sendable {
  public let taskId: String
  public let stage: String
  public let backoffsMs: [Int]?
  public let admissionCount: Int
  public let executedCount: Int
  public let transientRetryCount: Int
  public let measuredDurationMs: Int
  public let interruptedCount: Int
  public let latest: TaskRetryAttempt?
  public let authorizations: [TaskRetryAuthorization]
  public let telemetry: String
}
public struct TaskRetryAttempt: Codable, Sendable {
  public let id: String
  public let outcome: String?
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
