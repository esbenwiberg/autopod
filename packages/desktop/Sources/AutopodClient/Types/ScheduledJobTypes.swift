import Foundation

// MARK: - ScheduledJob (mirrors packages/shared/src/types/scheduled-job.ts)

public struct ScheduledJobTemplate: Codable, Identifiable, Sendable, Hashable {
  public let id: String
  public let name: String
  public let prompt: String
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    name: String,
    prompt: String,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.name = name
    self.prompt = prompt
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public struct CreateScheduledJobTemplateRequest: Codable, Sendable {
  public let name: String
  public let prompt: String

  public init(name: String, prompt: String) {
    self.name = name
    self.prompt = prompt
  }
}

public struct UpdateScheduledJobTemplateRequest: Codable, Sendable {
  public let name: String?
  public let prompt: String?

  public init(name: String? = nil, prompt: String? = nil) {
    self.name = name
    self.prompt = prompt
  }
}

public struct CreateScheduledJobRequest: Codable, Sendable {
  public let templateId: String?
  public let name: String?
  public let profileName: String
  public let task: String?
  public let cronExpression: String
  public let enabled: Bool

  public init(
    templateId: String? = nil,
    name: String? = nil,
    profileName: String,
    task: String? = nil,
    cronExpression: String,
    enabled: Bool = true
  ) {
    self.templateId = templateId
    self.name = name
    self.profileName = profileName
    self.task = task
    self.cronExpression = cronExpression
    self.enabled = enabled
  }
}

// MARK: - UpdateScheduledJobRequest

public struct UpdateScheduledJobRequest: Codable, Sendable {
  public let templateId: String?
  public let name: String?
  public let task: String?
  public let profileName: String?
  public let cronExpression: String?
  public let enabled: Bool?

  public init(
    templateId: String? = nil,
    name: String? = nil,
    task: String? = nil,
    profileName: String? = nil,
    cronExpression: String? = nil,
    enabled: Bool? = nil
  ) {
    self.templateId = templateId
    self.name = name
    self.task = task
    self.profileName = profileName
    self.cronExpression = cronExpression
    self.enabled = enabled
  }
}

// MARK: - ScheduledJob

public struct ScheduledJob: Codable, Identifiable, Sendable, Hashable {
  public let id: String
  public let name: String
  public let templateId: String
  public let templateName: String
  public let profileName: String
  public let task: String
  public let cronExpression: String
  public let enabled: Bool
  public let nextRunAt: String
  public let lastRunAt: String?
  public let lastPodId: String?
  public let catchupPending: Bool
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    name: String,
    templateId: String,
    templateName: String,
    profileName: String,
    task: String,
    cronExpression: String,
    enabled: Bool,
    nextRunAt: String,
    lastRunAt: String?,
    lastPodId: String?,
    catchupPending: Bool,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.name = name
    self.templateId = templateId
    self.templateName = templateName
    self.profileName = profileName
    self.task = task
    self.cronExpression = cronExpression
    self.enabled = enabled
    self.nextRunAt = nextRunAt
    self.lastRunAt = lastRunAt
    self.lastPodId = lastPodId
    self.catchupPending = catchupPending
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}
