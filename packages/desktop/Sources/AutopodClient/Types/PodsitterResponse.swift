import Foundation

public enum PodsitterRuntime: String, Codable, CaseIterable, Sendable {
  case claude
  case codex
  case copilot
  case pi
}

public struct PodsitterDecisionTargetResponse: Codable, Equatable, Sendable {
  public var providerAccountId: String
  public var runtime: PodsitterRuntime
  public var model: String
  public var reasoningEffort: String?

  public init(
    providerAccountId: String,
    runtime: PodsitterRuntime,
    model: String,
    reasoningEffort: String? = nil
  ) {
    self.providerAccountId = providerAccountId
    self.runtime = runtime
    self.model = model
    self.reasoningEffort = reasoningEffort
  }
}

public enum PodsitterActivationResponse: Codable, Equatable, Sendable {
  case always
  case recurring(cronExpression: String, durationMinutes: Int, timeZone: String)

  private enum CodingKeys: String, CodingKey {
    case mode, cronExpression, durationMinutes, timeZone
  }

  private enum Mode: String, Codable {
    case always, recurring
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Mode.self, forKey: .mode) {
    case .always:
      self = .always
    case .recurring:
      self = try .recurring(
        cronExpression: container.decode(String.self, forKey: .cronExpression),
        durationMinutes: container.decode(Int.self, forKey: .durationMinutes),
        timeZone: container.decode(String.self, forKey: .timeZone)
      )
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .always:
      try container.encode(Mode.always, forKey: .mode)
    case let .recurring(cronExpression, durationMinutes, timeZone):
      try container.encode(Mode.recurring, forKey: .mode)
      try container.encode(cronExpression, forKey: .cronExpression)
      try container.encode(durationMinutes, forKey: .durationMinutes)
      try container.encode(timeZone, forKey: .timeZone)
    }
  }
}

public struct PodsitterBudgetsResponse: Codable, Equatable, Sendable {
  public var maxDecisionsPerWindow: Int
  public var maxActionsPerWindow: Int

  public init(maxDecisionsPerWindow: Int, maxActionsPerWindow: Int) {
    self.maxDecisionsPerWindow = maxDecisionsPerWindow
    self.maxActionsPerWindow = maxActionsPerWindow
  }
}

public struct PodsitterConfigurationResponse: Codable, Equatable, Sendable {
  public var enabled: Bool
  public var activation: PodsitterActivationResponse
  public var authorizedUntil: String?
  public var generation: Int
  public var profileScope: [String]?
  public var decisionTarget: PodsitterDecisionTargetResponse?
  public var budgets: PodsitterBudgetsResponse
  public var createdAt: String
  public var updatedAt: String
}

public struct PodsitterConfigurationRequest: Codable, Equatable, Sendable {
  public var enabled: Bool
  public var activation: PodsitterActivationResponse
  public var authorizedUntil: String?
  public var profileScope: [String]?
  public var decisionTarget: PodsitterDecisionTargetResponse?
  public var budgets: PodsitterBudgetsResponse

  public init(
    enabled: Bool,
    activation: PodsitterActivationResponse,
    authorizedUntil: String?,
    profileScope: [String]?,
    decisionTarget: PodsitterDecisionTargetResponse?,
    budgets: PodsitterBudgetsResponse
  ) {
    self.enabled = enabled
    self.activation = activation
    self.authorizedUntil = authorizedUntil
    self.profileScope = profileScope
    self.decisionTarget = decisionTarget
    self.budgets = budgets
  }

  private enum CodingKeys: String, CodingKey {
    case enabled, activation, authorizedUntil, profileScope, decisionTarget, budgets
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(enabled, forKey: .enabled)
    try container.encode(activation, forKey: .activation)
    if let authorizedUntil {
      try container.encode(authorizedUntil, forKey: .authorizedUntil)
    } else {
      try container.encodeNil(forKey: .authorizedUntil)
    }
    if let profileScope {
      try container.encode(profileScope, forKey: .profileScope)
    } else {
      try container.encodeNil(forKey: .profileScope)
    }
    if let decisionTarget {
      try container.encode(decisionTarget, forKey: .decisionTarget)
    } else {
      try container.encodeNil(forKey: .decisionTarget)
    }
    try container.encode(budgets, forKey: .budgets)
  }
}

public struct PodsitterActivationEvaluationResponse: Codable, Equatable, Sendable {
  public var active: Bool
  public var windowId: String?
  public var windowStartedAt: String?
  public var windowEndsAt: String?
  public var reason: String
}

public enum PodsitterProviderCircuitStatus: Equatable, Sendable {
  case available
  case rateLimited
  case quotaExhausted
  case authFailed
  case unavailable
  case unknown(String)
}

extension PodsitterProviderCircuitStatus: Codable {
  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    self = switch value {
    case "available": .available
    case "rate_limited": .rateLimited
    case "quota_exhausted": .quotaExhausted
    case "auth_failed": .authFailed
    case "unavailable": .unavailable
    default: .unknown(value)
    }
  }

  public func encode(to encoder: Encoder) throws {
    let value = switch self {
    case .available: "available"
    case .rateLimited: "rate_limited"
    case .quotaExhausted: "quota_exhausted"
    case .authFailed: "auth_failed"
    case .unavailable: "unavailable"
    case let .unknown(value): value
    }
    var container = encoder.singleValueContainer()
    try container.encode(value)
  }
}

public struct PodsitterProviderStateResponse: Codable, Equatable, Sendable {
  public var providerAccountId: String
  public var status: PodsitterProviderCircuitStatus
  public var consecutiveFailures: Int
  public var retryAt: String?
  public var resetAt: String?
  public var sanitizedReason: String?
  public var recoveredAt: String?
  public var updatedAt: String
}

public struct PodsitterStatusResponse: Codable, Equatable, Sendable {
  public var configuration: PodsitterConfigurationResponse?
  public var activation: PodsitterActivationEvaluationResponse?
  public var provider: PodsitterProviderStateResponse?
  public var queueCount: Int

  public init(
    configuration: PodsitterConfigurationResponse?,
    activation: PodsitterActivationEvaluationResponse?,
    provider: PodsitterProviderStateResponse?,
    queueCount: Int
  ) {
    self.configuration = configuration
    self.activation = activation
    self.provider = provider
    self.queueCount = queueCount
  }
}

public struct PodsitterRedactedDecision: Codable, Equatable, Sendable {
  public var action: String
  public var reason: String
  public var evidenceRefs: [String]
  public var confidence: String
  public var remainingRisk: String
  public var stopCondition: String
}

public struct PodsitterDecisionRecordResponse: Codable, Equatable, Identifiable, Sendable {
  public var id: String
  public var podId: String
  public var decision: PodsitterRedactedDecision?
  public var outcome: String
  public var failureCode: String?
  public var createdAt: String
  public var completedAt: String?
  public var executedAt: String?
}

public struct PodsitterDecisionListResponse: Codable, Equatable, Sendable {
  public var items: [PodsitterDecisionRecordResponse]
  public var total: Int
}

public struct PodsitterCheckResponse: Codable, Equatable, Sendable {
  public var queued: Int
  public var processed: Int

  public init(queued: Int, processed: Int) {
    self.queued = queued
    self.processed = processed
  }
}

public struct PodsitterProbeResponse: Codable, Equatable, Sendable {
  public var recovered: Bool

  public init(recovered: Bool) {
    self.recovered = recovered
  }
}
