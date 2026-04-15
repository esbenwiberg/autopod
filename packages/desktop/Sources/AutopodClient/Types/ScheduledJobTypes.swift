import Foundation

// MARK: - ScheduledJob (mirrors packages/shared/src/types/scheduled-job.ts)

public struct CreateScheduledJobRequest: Codable, Sendable {
  public let name: String
  public let profileName: String
  public let task: String
  public let cronExpression: String
  public let enabled: Bool

  public init(
    name: String,
    profileName: String,
    task: String,
    cronExpression: String,
    enabled: Bool = true
  ) {
    self.name = name
    self.profileName = profileName
    self.task = task
    self.cronExpression = cronExpression
    self.enabled = enabled
  }
}

// MARK: - ScheduledJob

public struct ScheduledJob: Codable, Identifiable, Sendable, Hashable {
  public let id: String
  public let name: String
  public let profileName: String
  public let task: String
  public let cronExpression: String
  public let enabled: Bool
  public let nextRunAt: String
  public let lastRunAt: String?
  public let lastSessionId: String?
  public let catchupPending: Bool
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    name: String,
    profileName: String,
    task: String,
    cronExpression: String,
    enabled: Bool,
    nextRunAt: String,
    lastRunAt: String?,
    lastSessionId: String?,
    catchupPending: Bool,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.name = name
    self.profileName = profileName
    self.task = task
    self.cronExpression = cronExpression
    self.enabled = enabled
    self.nextRunAt = nextRunAt
    self.lastRunAt = lastRunAt
    self.lastSessionId = lastSessionId
    self.catchupPending = catchupPending
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}
