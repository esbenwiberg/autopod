import Foundation

// MARK: - Profile response (mirrors packages/shared/src/types/profile.ts)

public struct ProfileResponse: Codable, Sendable {
  public var name: String
  /// Nullable on the `raw` shape from /editor — null means "inherit from parent".
  /// Resolved responses (from list / get) always have a concrete value.
  public var repoUrl: String?
  public var defaultBranch: String?
  public var template: String?
  public var buildCommand: String?
  public var startCommand: String?
  public var healthPath: String?
  public var healthTimeout: Int?
  public var smokePages: [SmokePageResponse]
  public var maxValidationAttempts: Int?
  public var defaultModel: String?
  public var defaultRuntime: String?
  public var executionTarget: String?
  public var customInstructions: String?
  public var escalation: EscalationConfigResponse?
  public var extends: String?
  public var workerProfile: String?
  public var warmImageTag: String?
  public var warmImageBuiltAt: String?
  public var mcpServers: [InjectedMcpServerResponse]
  public var claudeMdSections: [InjectedClaudeMdSectionResponse]
  public var skills: [InjectedSkillResponse]
  public var networkPolicy: NetworkPolicyResponse?
  public var actionPolicy: ActionPolicyResponse?
  public var outputMode: String?
  public var pod: PodConfigResponse?
  public var modelProvider: String?
  public var providerCredentials: ProviderCredentialsResponse?
  public var testCommand: String?
  public var buildTimeout: Int?
  public var testTimeout: Int?
  public var prProvider: String?
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
  public var pimActivations: [PimActivationResponse]?
  /// Per-field override of merge vs replace behavior for inheritance merge-special fields.
  /// Keys: smokePages, customInstructions, escalation, mcpServers, claudeMdSections,
  /// skills, privateRegistries. Values: "merge" (default) or "replace".
  public var mergeStrategy: [String: String]?
  /// Per-type sidecar configs (e.g. `sidecars.dagger`). Null = inherit.
  public var sidecars: SidecarsResponse?
  /// Gate for privileged sidecars. Null = inherit.
  public var trustedSource: Bool?
  /// Pre-configured ADO test pipeline for the `ado_run_test_pipeline` action.
  public var testPipeline: TestPipelineResponse?
  public var version: Int
  public var createdAt: String
  public var updatedAt: String

  /// Decode array fields defensively — the raw shape from /editor may serialize
  /// missing arrays as null in some edge cases, even though resolved responses
  /// always return `[]`. Treat null/missing as an empty array.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    repoUrl = try c.decodeIfPresent(String.self, forKey: .repoUrl)
    defaultBranch = try c.decodeIfPresent(String.self, forKey: .defaultBranch)
    template = try c.decodeIfPresent(String.self, forKey: .template)
    buildCommand = try c.decodeIfPresent(String.self, forKey: .buildCommand)
    startCommand = try c.decodeIfPresent(String.self, forKey: .startCommand)
    healthPath = try c.decodeIfPresent(String.self, forKey: .healthPath)
    healthTimeout = try c.decodeIfPresent(Int.self, forKey: .healthTimeout)
    smokePages = (try c.decodeIfPresent([SmokePageResponse].self, forKey: .smokePages)) ?? []
    maxValidationAttempts = try c.decodeIfPresent(Int.self, forKey: .maxValidationAttempts)
    defaultModel = try c.decodeIfPresent(String.self, forKey: .defaultModel)
    defaultRuntime = try c.decodeIfPresent(String.self, forKey: .defaultRuntime)
    executionTarget = try c.decodeIfPresent(String.self, forKey: .executionTarget)
    customInstructions = try c.decodeIfPresent(String.self, forKey: .customInstructions)
    escalation = try c.decodeIfPresent(EscalationConfigResponse.self, forKey: .escalation)
    extends = try c.decodeIfPresent(String.self, forKey: .extends)
    workerProfile = try c.decodeIfPresent(String.self, forKey: .workerProfile)
    warmImageTag = try c.decodeIfPresent(String.self, forKey: .warmImageTag)
    warmImageBuiltAt = try c.decodeIfPresent(String.self, forKey: .warmImageBuiltAt)
    mcpServers = (try c.decodeIfPresent([InjectedMcpServerResponse].self, forKey: .mcpServers)) ?? []
    claudeMdSections = (try c.decodeIfPresent([InjectedClaudeMdSectionResponse].self, forKey: .claudeMdSections)) ?? []
    skills = (try c.decodeIfPresent([InjectedSkillResponse].self, forKey: .skills)) ?? []
    networkPolicy = try c.decodeIfPresent(NetworkPolicyResponse.self, forKey: .networkPolicy)
    actionPolicy = try c.decodeIfPresent(ActionPolicyResponse.self, forKey: .actionPolicy)
    outputMode = try c.decodeIfPresent(String.self, forKey: .outputMode)
    pod = try c.decodeIfPresent(PodConfigResponse.self, forKey: .pod)
    modelProvider = try c.decodeIfPresent(String.self, forKey: .modelProvider)
    providerCredentials = try c.decodeIfPresent(ProviderCredentialsResponse.self, forKey: .providerCredentials)
    testCommand = try c.decodeIfPresent(String.self, forKey: .testCommand)
    buildTimeout = try c.decodeIfPresent(Int.self, forKey: .buildTimeout)
    testTimeout = try c.decodeIfPresent(Int.self, forKey: .testTimeout)
    prProvider = try c.decodeIfPresent(String.self, forKey: .prProvider)
    adoPat = try c.decodeIfPresent(String.self, forKey: .adoPat)
    githubPat = try c.decodeIfPresent(String.self, forKey: .githubPat)
    privateRegistries = (try c.decodeIfPresent([PrivateRegistryResponse].self, forKey: .privateRegistries)) ?? []
    registryPat = try c.decodeIfPresent(String.self, forKey: .registryPat)
    containerMemoryGb = try c.decodeIfPresent(Double.self, forKey: .containerMemoryGb)
    issueWatcherEnabled = try c.decodeIfPresent(Bool.self, forKey: .issueWatcherEnabled)
    issueWatcherLabelPrefix = try c.decodeIfPresent(String.self, forKey: .issueWatcherLabelPrefix)
    branchPrefix = try c.decodeIfPresent(String.self, forKey: .branchPrefix)
    hasWebUi = try c.decodeIfPresent(Bool.self, forKey: .hasWebUi)
    tokenBudget = try c.decodeIfPresent(Int.self, forKey: .tokenBudget)
    tokenBudgetPolicy = try c.decodeIfPresent(String.self, forKey: .tokenBudgetPolicy)
    tokenBudgetWarnAt = try c.decodeIfPresent(Double.self, forKey: .tokenBudgetWarnAt)
    maxBudgetExtensions = try c.decodeIfPresent(Int.self, forKey: .maxBudgetExtensions)
    pimActivations = try c.decodeIfPresent([PimActivationResponse].self, forKey: .pimActivations)
    mergeStrategy = try c.decodeIfPresent([String: String].self, forKey: .mergeStrategy)
    sidecars = try c.decodeIfPresent(SidecarsResponse.self, forKey: .sidecars)
    trustedSource = try decodeBoolOrIntIfPresent(c, key: .trustedSource)
    testPipeline = try c.decodeIfPresent(TestPipelineResponse.self, forKey: .testPipeline)
    version = try c.decode(Int.self, forKey: .version)
    createdAt = try c.decode(String.self, forKey: .createdAt)
    updatedAt = try c.decode(String.self, forKey: .updatedAt)
  }

  /// Empty init for building responses programmatically (reverse mapping).
  public init() {
    name = ""; repoUrl = ""; defaultBranch = "main"; template = "node22"
    buildCommand = nil; startCommand = nil; healthPath = "/"; healthTimeout = 120
    smokePages = []; maxValidationAttempts = 3; defaultModel = "opus"
    defaultRuntime = "claude"; executionTarget = "local"
    escalation = .init(); mcpServers = []; claudeMdSections = []; skills = []
    outputMode = "pr"; modelProvider = "anthropic"; buildTimeout = 300
    testTimeout = 600; prProvider = "github"; privateRegistries = []
    version = 1; createdAt = ""; updatedAt = ""
  }
}

// MARK: - Editor payload (GET /profiles/:name/editor)

public enum FieldSource: String, Codable, Sendable {
  case own
  case inherited
  case merged
}

public enum MergeMode: String, Codable, Sendable {
  case merge
  case replace
}

/// Returned by `GET /profiles/:name/editor`. Gives the desktop everything it
/// needs to show Inherited / Overridden chips without re-implementing the
/// inheritance merge on the client.
public struct ProfileEditorResponse: Codable, Sendable {
  /// The partial profile as stored — nulls preserved (signals "inherit").
  public let raw: ProfileResponse
  /// The fully resolved profile (parent + child merged per mergeStrategy).
  public let resolved: ProfileResponse
  /// The fully resolved parent. Null for base profiles.
  public let parent: ProfileResponse?
  /// Per-field classification: "own" / "inherited" / "merged".
  public let sourceMap: [String: FieldSource]
  /// Name of the profile in the extends chain that actually holds the
  /// provider credentials. Null when no profile in the chain has auth yet.
  /// Used to render "Authenticated via <owner>" when the current profile
  /// inherits its auth from an ancestor.
  public let credentialOwner: String?

  public init(
    raw: ProfileResponse,
    resolved: ProfileResponse,
    parent: ProfileResponse?,
    sourceMap: [String: FieldSource],
    credentialOwner: String?
  ) {
    self.raw = raw
    self.resolved = resolved
    self.parent = parent
    self.sourceMap = sourceMap
    self.credentialOwner = credentialOwner
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

public struct PimActivationResponse: Codable, Sendable {
  public var type: String
  public var groupId: String?
  public var scope: String?
  public var roleDefinitionId: String?
  public var displayName: String?
  public var duration: String?
  public var justification: String?
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
  /// Source discriminator preserved as a plain `[String: String]` so we can
  /// round-trip the daemon's required `source` field without authoring UI
  /// yet. Both local (`{type, path}`) and github (`{type, repo, path?, ref?,
  /// token?}`) shapes are string-valued, which is why this coerces.
  public var source: [String: String]?
  public init(name: String?, description: String?, source: [String: String]? = nil) {
    self.name = name; self.description = description; self.source = source
  }
}

// MARK: - Sidecars + test pipeline

public struct SidecarsResponse: Codable, Sendable {
  public var dagger: DaggerSidecarResponse?
  public init(dagger: DaggerSidecarResponse? = nil) { self.dagger = dagger }
}

public struct DaggerSidecarResponse: Codable, Sendable {
  public var enabled: Bool
  public var engineImageDigest: String
  public var engineVersion: String
  public var enginePort: Int?
  public var memoryGb: Double?
  public var cpus: Double?
  public var storageGb: Double?

  public init(
    enabled: Bool,
    engineImageDigest: String,
    engineVersion: String,
    enginePort: Int? = nil,
    memoryGb: Double? = nil,
    cpus: Double? = nil,
    storageGb: Double? = nil
  ) {
    self.enabled = enabled
    self.engineImageDigest = engineImageDigest
    self.engineVersion = engineVersion
    self.enginePort = enginePort
    self.memoryGb = memoryGb
    self.cpus = cpus
    self.storageGb = storageGb
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = try decodeBoolOrInt(c, key: .enabled)
    engineImageDigest = try c.decode(String.self, forKey: .engineImageDigest)
    engineVersion = try c.decode(String.self, forKey: .engineVersion)
    enginePort = try c.decodeIfPresent(Int.self, forKey: .enginePort)
    memoryGb = try c.decodeIfPresent(Double.self, forKey: .memoryGb)
    cpus = try c.decodeIfPresent(Double.self, forKey: .cpus)
    storageGb = try c.decodeIfPresent(Double.self, forKey: .storageGb)
  }
}

public struct TestPipelineResponse: Codable, Sendable {
  public var enabled: Bool
  public var testRepo: String
  public var testPipelineId: Int
  public var rateLimitPerHour: Int?
  public var branchPrefix: String?

  public init(
    enabled: Bool,
    testRepo: String,
    testPipelineId: Int,
    rateLimitPerHour: Int? = nil,
    branchPrefix: String? = nil
  ) {
    self.enabled = enabled
    self.testRepo = testRepo
    self.testPipelineId = testPipelineId
    self.rateLimitPerHour = rateLimitPerHour
    self.branchPrefix = branchPrefix
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    enabled = try decodeBoolOrInt(c, key: .enabled)
    testRepo = try c.decode(String.self, forKey: .testRepo)
    testPipelineId = try c.decode(Int.self, forKey: .testPipelineId)
    rateLimitPerHour = try c.decodeIfPresent(Int.self, forKey: .rateLimitPerHour)
    branchPrefix = try c.decodeIfPresent(String.self, forKey: .branchPrefix)
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
