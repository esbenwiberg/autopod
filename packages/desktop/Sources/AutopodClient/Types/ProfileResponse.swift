import Foundation

// MARK: - Profile response (mirrors packages/shared/src/types/profile.ts)

public struct ProfileResponse: Codable, Sendable {
  public var name: String
  public var repoUrl: String
  public var defaultBranch: String
  public var template: String
  public var buildCommand: String
  public var startCommand: String
  public var healthPath: String
  public var healthTimeout: Int
  public var smokePages: [SmokePageResponse]
  public var maxValidationAttempts: Int
  public var defaultModel: String
  public var defaultRuntime: String
  public var executionTarget: String
  public var customInstructions: String?
  public var escalation: EscalationConfigResponse
  public var extends: String?
  public var workerProfile: String?
  public var warmImageTag: String?
  public var warmImageBuiltAt: String?
  public var mcpServers: [InjectedMcpServerResponse]
  public var claudeMdSections: [InjectedClaudeMdSectionResponse]
  public var skills: [InjectedSkillResponse]
  public var networkPolicy: NetworkPolicyResponse?
  public var actionPolicy: ActionPolicyResponse?
  public var outputMode: String
  public var modelProvider: String
  public var providerCredentials: ProviderCredentialsResponse?
  public var testCommand: String?
  public var buildTimeout: Int
  public var testTimeout: Int
  public var prProvider: String
  public var adoPat: String?
  public var githubPat: String?
  public var privateRegistries: [PrivateRegistryResponse]
  public var registryPat: String?
  public var containerMemoryGb: Double?
  public var issueWatcherEnabled: Bool?
  public var issueWatcherLabelPrefix: String?
  public var branchPrefix: String?
  public var hasWebUi: Bool?
  public var tokenBudget: Int?
  public var tokenBudgetPolicy: String?
  public var tokenBudgetWarnAt: Double?
  public var maxBudgetExtensions: Int?
  public var version: Int
  public var createdAt: String
  public var updatedAt: String

  /// Empty init for building responses programmatically (reverse mapping).
  public init() {
    name = ""; repoUrl = ""; defaultBranch = "main"; template = "node22"
    buildCommand = ""; startCommand = ""; healthPath = "/"; healthTimeout = 120
    smokePages = []; maxValidationAttempts = 3; defaultModel = "opus"
    defaultRuntime = "claude"; executionTarget = "local"
    escalation = .init(); mcpServers = []; claudeMdSections = []; skills = []
    outputMode = "pr"; modelProvider = "anthropic"; buildTimeout = 300
    testTimeout = 600; prProvider = "github"; privateRegistries = []
    version = 1; createdAt = ""; updatedAt = ""
  }
}

// MARK: - Nested types

public struct SmokePageResponse: Codable, Sendable {
  public var path: String
  public var assertions: [PageAssertionResponse]?
  public init(path: String, assertions: [PageAssertionResponse]? = nil) {
    self.path = path; self.assertions = assertions
  }
}

public struct PageAssertionResponse: Codable, Sendable {
  public let selector: String
  public let type: String
  public let value: String?
}

public struct EscalationConfigResponse: Codable, Sendable {
  public var askHuman: Bool
  public var askAi: AskAiConfigResponse
  public var advisor: AdvisorConfigResponse?
  public var autoPauseAfter: Int
  public var humanResponseTimeout: Int

  public init() {
    askHuman = true; askAi = .init(); autoPauseAfter = 1; humanResponseTimeout = 3600
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    askHuman = try decodeBoolOrInt(c, key: .askHuman)
    askAi = try c.decode(AskAiConfigResponse.self, forKey: .askAi)
    advisor = try c.decodeIfPresent(AdvisorConfigResponse.self, forKey: .advisor)
    autoPauseAfter = try c.decode(Int.self, forKey: .autoPauseAfter)
    humanResponseTimeout = try c.decode(Int.self, forKey: .humanResponseTimeout)
  }
}

public struct AdvisorConfigResponse: Codable, Sendable {
  public var enabled: Bool

  public init() { enabled = false }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = try decodeBoolOrInt(c, key: .enabled)
  }
}

public struct AskAiConfigResponse: Codable, Sendable {
  public var enabled: Bool
  public var model: String
  public var maxCalls: Int

  public init() { enabled = true; model = "sonnet"; maxCalls = 3 }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = try decodeBoolOrInt(c, key: .enabled)
    model = try c.decode(String.self, forKey: .model)
    maxCalls = try c.decode(Int.self, forKey: .maxCalls)
  }
}

public struct NetworkPolicyResponse: Codable, Sendable {
  public var enabled: Bool
  public var mode: String?
  public var allowedHosts: [String]
  public var replaceDefaults: Bool?
  public var allowPackageManagers: Bool?

  public init(enabled: Bool, mode: String?, allowedHosts: [String], replaceDefaults: Bool?, allowPackageManagers: Bool? = nil) {
    self.enabled = enabled; self.mode = mode; self.allowedHosts = allowedHosts
    self.replaceDefaults = replaceDefaults; self.allowPackageManagers = allowPackageManagers
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = try decodeBoolOrInt(c, key: .enabled)
    mode = try c.decodeIfPresent(String.self, forKey: .mode)
    allowedHosts = try c.decode([String].self, forKey: .allowedHosts)
    replaceDefaults = try decodeBoolOrIntIfPresent(c, key: .replaceDefaults)
    allowPackageManagers = try decodeBoolOrIntIfPresent(c, key: .allowPackageManagers)
  }
}


public struct PrivateRegistryResponse: Codable, Sendable {
  public var type: String
  public var url: String
  public var scope: String?
  public init(type: String, url: String, scope: String? = nil) {
    self.type = type; self.url = url; self.scope = scope
  }
}

public struct InjectedMcpServerResponse: Codable, Sendable {
  public var name: String
  public var url: String?
  public var description: String?
  public init(name: String, url: String?, description: String?) {
    self.name = name; self.url = url; self.description = description
  }
}

public struct InjectedClaudeMdSectionResponse: Codable, Sendable {
  public var heading: String?
  public var content: String?
  public var priority: Int?
  public init(heading: String?, content: String?, priority: Int?) {
    self.heading = heading; self.content = content; self.priority = priority
  }
}

public struct InjectedSkillResponse: Codable, Sendable {
  public var name: String?
  public var description: String?
  public init(name: String?, description: String?) {
    self.name = name; self.description = description
  }
}

// MARK: - Warm result

public struct WarmResult: Codable, Sendable {
  public let tag: String
  public let digest: String?
  public let sizeMb: Int
  public let buildDuration: Int?
}

// MARK: - Action Policy response types

public struct ActionPolicyResponse: Codable, Sendable {
  public var enabledGroups: [String]
  public var enabledActions: [String]?
  public var actionOverrides: [ActionOverrideResponse]?
  public var customActions: AnyCodable?  // Complex type — pass through
  public var sanitization: DataSanitizationResponse
  public var quarantine: QuarantineResponse?

  public init() {
    enabledGroups = []
    sanitization = .init()
  }
}

public struct ActionOverrideResponse: Codable, Sendable {
  public var action: String
  public var allowedResources: [String]?
  public var requiresApproval: Bool?
  public var disabled: Bool?

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    action = try c.decode(String.self, forKey: .action)
    allowedResources = try c.decodeIfPresent([String].self, forKey: .allowedResources)
    requiresApproval = try decodeBoolOrIntIfPresent(c, key: .requiresApproval)
    disabled = try decodeBoolOrIntIfPresent(c, key: .disabled)
  }
}

public struct DataSanitizationResponse: Codable, Sendable {
  public var preset: String
  public var allowedDomains: [String]?

  public init() { preset = "standard" }
}

public struct QuarantineResponse: Codable, Sendable {
  public var enabled: Bool
  public var threshold: Double
  public var blockThreshold: Double
  public var onBlock: String

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = try decodeBoolOrInt(c, key: .enabled)
    threshold = try c.decode(Double.self, forKey: .threshold)
    blockThreshold = try c.decode(Double.self, forKey: .blockThreshold)
    onBlock = try c.decode(String.self, forKey: .onBlock)
  }
}

// MARK: - Provider Credentials response

public struct ProviderCredentialsResponse: Codable, Sendable {
  public var provider: String

  // Only decode the provider field — actual credentials are sensitive
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    provider = try c.decode(String.self, forKey: .provider)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(provider, forKey: .provider)
  }

  private enum CodingKeys: String, CodingKey { case provider }
}

// MARK: - AnyCodable (pass-through for complex/unknown JSON shapes)

public struct AnyCodable: Codable, Sendable {
  private let storage: Storage

  private enum Storage: Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([AnyCodable])
    case dict([String: AnyCodable])
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      storage = .null
    } else if let v = try? container.decode(Bool.self) {
      storage = .bool(v)
    } else if let v = try? container.decode(Int.self) {
      storage = .int(v)
    } else if let v = try? container.decode(Double.self) {
      storage = .double(v)
    } else if let v = try? container.decode(String.self) {
      storage = .string(v)
    } else if let v = try? container.decode([AnyCodable].self) {
      storage = .array(v)
    } else if let v = try? container.decode([String: AnyCodable].self) {
      storage = .dict(v)
    } else {
      storage = .null
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch storage {
    case .null: try container.encodeNil()
    case .bool(let v): try container.encode(v)
    case .int(let v): try container.encode(v)
    case .double(let v): try container.encode(v)
    case .string(let v): try container.encode(v)
    case .array(let v): try container.encode(v)
    case .dict(let v): try container.encode(v)
    }
  }

  // MARK: - Accessors

  public subscript(key: String) -> AnyCodable? {
    if case .dict(let d) = storage { return d[key] }
    return nil
  }

  public var stringValue: String? {
    if case .string(let s) = storage { return s }
    return nil
  }

  /// Human-readable display value for any storage type.
  public var displayValue: String {
    switch storage {
    case .null: return "null"
    case .bool(let v): return String(v)
    case .int(let v): return String(v)
    case .double(let v): return String(v)
    case .string(let v): return v
    case .array(let v): return v.map(\.displayValue).joined(separator: ", ")
    case .dict(let v): return v.sorted(by: { $0.key < $1.key }).map { "\($0.key): \($0.value.displayValue)" }.joined(separator: ", ")
    }
  }
}
