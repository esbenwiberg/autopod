import Foundation

// MARK: - ScheduledJob (mirrors packages/shared/src/types/scheduled-job.ts)

public struct ScheduledJobTemplateField: Codable, Sendable, Hashable {
  public let key: String
  public let label: String
  public let required: Bool
  public let defaultValue: String?

  public init(
    key: String,
    label: String,
    required: Bool,
    defaultValue: String? = nil
  ) {
    self.key = key
    self.label = label
    self.required = required
    self.defaultValue = defaultValue
  }
}

public struct ScheduledJobTemplate: Codable, Identifiable, Sendable, Hashable {
  public let id: String
  public let name: String
  public let prompt: String
  public let fields: [ScheduledJobTemplateField]
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    name: String,
    prompt: String,
    fields: [ScheduledJobTemplateField] = [],
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.name = name
    self.prompt = prompt
    self.fields = fields
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, prompt, fields, createdAt, updatedAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    prompt = try c.decode(String.self, forKey: .prompt)
    fields = try c.decodeIfPresent([ScheduledJobTemplateField].self, forKey: .fields) ?? []
    createdAt = try c.decode(String.self, forKey: .createdAt)
    updatedAt = try c.decode(String.self, forKey: .updatedAt)
  }
}

public struct CreateScheduledJobTemplateRequest: Codable, Sendable {
  public let name: String
  public let prompt: String
  public let fields: [ScheduledJobTemplateField]?

  public init(name: String, prompt: String, fields: [ScheduledJobTemplateField]? = nil) {
    self.name = name
    self.prompt = prompt
    self.fields = fields
  }
}

public struct UpdateScheduledJobTemplateRequest: Codable, Sendable {
  public let name: String?
  public let prompt: String?
  public let fields: [ScheduledJobTemplateField]?

  public init(
    name: String? = nil,
    prompt: String? = nil,
    fields: [ScheduledJobTemplateField]? = nil
  ) {
    self.name = name
    self.prompt = prompt
    self.fields = fields
  }
}

public struct CreateScheduledJobRequest: Codable, Sendable {
  public let templateId: String?
  public let name: String?
  public let profileName: String
  public let task: String?
  public let fieldValues: [String: String]?
  public let cronExpression: String
  public let enabled: Bool

  public init(
    templateId: String? = nil,
    name: String? = nil,
    profileName: String,
    task: String? = nil,
    fieldValues: [String: String]? = nil,
    cronExpression: String,
    enabled: Bool = true
  ) {
    self.templateId = templateId
    self.name = name
    self.profileName = profileName
    self.task = task
    self.fieldValues = fieldValues
    self.cronExpression = cronExpression
    self.enabled = enabled
  }
}

// MARK: - UpdateScheduledJobRequest

public struct UpdateScheduledJobRequest: Codable, Sendable {
  public let templateId: String?
  public let name: String?
  public let task: String?
  public let fieldValues: [String: String]?
  public let profileName: String?
  public let cronExpression: String?
  public let enabled: Bool?

  public init(
    templateId: String? = nil,
    name: String? = nil,
    task: String? = nil,
    fieldValues: [String: String]? = nil,
    profileName: String? = nil,
    cronExpression: String? = nil,
    enabled: Bool? = nil
  ) {
    self.templateId = templateId
    self.name = name
    self.task = task
    self.fieldValues = fieldValues
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
  public let fieldValues: [String: String]
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
    fieldValues: [String: String] = [:],
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
    self.fieldValues = fieldValues
    self.cronExpression = cronExpression
    self.enabled = enabled
    self.nextRunAt = nextRunAt
    self.lastRunAt = lastRunAt
    self.lastPodId = lastPodId
    self.catchupPending = catchupPending
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, templateId, templateName, profileName, task, fieldValues, cronExpression
    case enabled, nextRunAt, lastRunAt, lastPodId, catchupPending, createdAt, updatedAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    templateId = try c.decode(String.self, forKey: .templateId)
    templateName = try c.decode(String.self, forKey: .templateName)
    profileName = try c.decode(String.self, forKey: .profileName)
    task = try c.decode(String.self, forKey: .task)
    fieldValues = try c.decodeIfPresent([String: String].self, forKey: .fieldValues) ?? [:]
    cronExpression = try c.decode(String.self, forKey: .cronExpression)
    enabled = try c.decode(Bool.self, forKey: .enabled)
    nextRunAt = try c.decode(String.self, forKey: .nextRunAt)
    lastRunAt = try c.decodeIfPresent(String.self, forKey: .lastRunAt)
    lastPodId = try c.decodeIfPresent(String.self, forKey: .lastPodId)
    catchupPending = try c.decode(Bool.self, forKey: .catchupPending)
    createdAt = try c.decode(String.self, forKey: .createdAt)
    updatedAt = try c.decode(String.self, forKey: .updatedAt)
  }
}
