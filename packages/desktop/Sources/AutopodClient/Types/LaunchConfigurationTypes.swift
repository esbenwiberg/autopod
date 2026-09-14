import Foundation

/// Lossless JSON fields for the daemon-owned preset schemas. Null and omitted keys stay distinct.
public enum ConfigurationJSON: Codable, Hashable, Sendable {
  case null, bool(Bool), number(Double), string(String), array([ConfigurationJSON]), object([String: ConfigurationJSON])
  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() { self = .null }
    else if let decoded = try? value.decode(Bool.self) { self = .bool(decoded) }
    else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
    else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
    else if let decoded = try? value.decode([ConfigurationJSON].self) { self = .array(decoded) }
    else { self = .object(try value.decode([String: ConfigurationJSON].self)) }
  }
  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .null: try value.encodeNil()
    case .bool(let item): try value.encode(item)
    case .number(let item): try value.encode(item)
    case .string(let item): try value.encode(item)
    case .array(let item): try value.encode(item)
    case .object(let item): try value.encode(item)
    }
  }
  public var string: String? { if case .string(let value) = self { return value }; return nil }
  public var object: [String: ConfigurationJSON]? { if case .object(let value) = self { return value }; return nil }
  public var array: [ConfigurationJSON]? { if case .array(let value) = self { return value }; return nil }
  public var bool: Bool? { if case .bool(let value) = self { return value }; return nil }
  public var number: Double? { if case .number(let value) = self { return value }; return nil }
  public subscript(_ key: String) -> ConfigurationJSON? { object?[key] }
  public func formatted() -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return (try? String(decoding: encoder.encode(self), as: UTF8.self)) ?? "null"
  }
}

public enum ConfigurationKind: String, Codable, CaseIterable, Sendable, Identifiable {
  case repository, environment, ai, workflow, githubAccess, toolPack, profile
  public var id: String { rawValue }
  public var label: String {
    switch self {
    case .repository: "Repositories"
    case .environment: "Environments"
    case .ai: "AI setups"
    case .workflow: "Workflows"
    case .githubAccess: "GitHub access"
    case .toolPack: "Tool packs"
    case .profile: "Profiles"
    }
  }
  public var endpoint: String {
    switch self {
    case .repository: "/repositories"
    case .profile: "/profiles"
    default: "/presets/\(rawValue)"
    }
  }
}
public struct ConfigurationDocument: Codable, Identifiable, Equatable, Sendable {
  public var id: String
  public var kind: ConfigurationKind
  public var name: String
  public var revision: Int
  public var createdAt: String
  public var updatedAt: String
  public var archived: Bool
  public var payload: [String: ConfigurationJSON]
}
public struct ConfigurationWriteRequest: Encodable, Sendable {
  public var id: String?
  public var name: String
  public var payload: [String: ConfigurationJSON]
  public var expectedRevision: Int?
  public init(id: String? = nil, name: String, payload: [String: ConfigurationJSON], expectedRevision: Int? = nil) {
    self.id = id; self.name = name; self.payload = payload; self.expectedRevision = expectedRevision
  }
}
public enum LaunchAccessSelection: Equatable, Sendable {
  case profileDefault, noAccess, preset(String)
}
public struct LaunchSelections: Codable, Equatable, Sendable {
  public var environmentId: String?
  public var aiId: String?
  public var workflowId: String?
  public var githubAccess: LaunchAccessSelection = .profileDefault
  public var toolPackIds: [String]?
  public init() {}
  enum CodingKeys: String, CodingKey { case environmentId, aiId, workflowId, githubAccessId, toolPackIds }
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    environmentId = try container.decodeIfPresent(String.self, forKey: .environmentId)
    aiId = try container.decodeIfPresent(String.self, forKey: .aiId)
    workflowId = try container.decodeIfPresent(String.self, forKey: .workflowId)
    toolPackIds = try container.decodeIfPresent([String].self, forKey: .toolPackIds)
    if !container.contains(.githubAccessId) { githubAccess = .profileDefault }
    else if try container.decodeNil(forKey: .githubAccessId) { githubAccess = .noAccess }
    else { githubAccess = .preset(try container.decode(String.self, forKey: .githubAccessId)) }
  }
  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(environmentId, forKey: .environmentId)
    try container.encodeIfPresent(aiId, forKey: .aiId)
    try container.encodeIfPresent(workflowId, forKey: .workflowId)
    try container.encodeIfPresent(toolPackIds, forKey: .toolPackIds)
    switch githubAccess {
    case .profileDefault: break
    case .noAccess: try container.encodeNil(forKey: .githubAccessId)
    case .preset(let id): try container.encode(id, forKey: .githubAccessId)
    }
  }
}
public struct LaunchOverrides: Codable, Equatable, Sendable {
  public var repositorySetup: [String: ConfigurationJSON]?
  public var environment: [String: ConfigurationJSON]?
  public var ai: [String: ConfigurationJSON]?
  public var workflow: [String: ConfigurationJSON]?
  public var githubAccess: [String: ConfigurationJSON]?
  public var execution: [String: ConfigurationJSON]?
  public var pim: [[String: ConfigurationJSON]]?
  public var toolPacks: [[String: ConfigurationJSON]]?
  public init() {}
  public mutating func reset(_ category: ConfigurationKind) {
    switch category {
    case .repository: repositorySetup = nil
    case .environment: environment = nil
    case .ai: ai = nil
    case .workflow: workflow = nil
    case .githubAccess: githubAccess = nil
    case .toolPack: toolPacks = nil
    case .profile: break
    }
  }
}
public struct LaunchReferenceRepository: Codable, Equatable, Sendable {
  public var repositoryId: String
  public var ref: String
  public var access: String = "read"
  public init(repositoryId: String, ref: String) { self.repositoryId = repositoryId; self.ref = ref }
}
public struct LaunchSource: Codable, Equatable, Sendable {
  public var podId: String
  public var digest: String
  public var configuration: String
  public init(podId: String, digest: String, configuration: String) {
    self.podId = podId; self.digest = digest; self.configuration = configuration
  }
}
public struct ComposableLaunchRequest: Codable, Equatable, Sendable {
  public var source: LaunchSource?
  public var repositoryId: String?
  public var repositorySetupId: String?
  public var emptyWorkspace: Bool?
  public var profileId: String?
  public var task: String
  public var work: [String: ConfigurationJSON]?
  public var intent: String?
  public var selections: LaunchSelections?
  public var overrides: LaunchOverrides?
  public var requiredSidecarIds: [String]?
  public var referenceRepositories: [LaunchReferenceRepository]?
  public var expectedDigest: String?
  public var requestId: String?
  public init(repositoryId: String? = nil, profileId: String? = nil, task: String = "") {
    self.repositoryId = repositoryId; self.profileId = profileId; self.task = task
  }
  public mutating func select(_ kind: ConfigurationKind, id: String?) {
    expectedDigest = nil; requestId = nil
    if selections == nil { selections = LaunchSelections() }
    switch kind {
    case .repository: repositoryId = id; repositorySetupId = nil; emptyWorkspace = nil
    case .profile: profileId = id
    case .environment: selections?.environmentId = id; requiredSidecarIds = nil
    case .ai: selections?.aiId = id
    case .workflow: selections?.workflowId = id
    case .githubAccess: selections?.githubAccess = id.map(LaunchAccessSelection.preset) ?? .noAccess
    case .toolPack: break
    }
    overrides?.reset(kind)
  }
}

/// Retains the full preview, including provenance, pinned references and future schema fields.
public struct EffectiveLaunchPreview: Codable, Equatable, Sendable {
  public var fields: [String: ConfigurationJSON]
  public init(from decoder: Decoder) throws { fields = try decoder.singleValueContainer().decode([String: ConfigurationJSON].self) }
  public func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(fields) }
  public var digest: String { fields["digest"]?.string ?? "" }
  public var intent: String { fields["intent"]?.string ?? "task" }
  public var repositoryName: String { fields["repository"]?["config"]?["remote"]?.string ?? "Empty workspace" }
  public var mainModel: String { fields["ai"]?["main"]?["model"]?.string ?? "" }
  public var executionTarget: String { fields["resolvedExecution"]?["target"]?.string ?? "" }
  public var memoryGb: Double? { fields["resolvedExecution"]?["main"]?["memoryGb"]?.number }
}

public extension ComposableLaunchRequest {
  static func decodeJSON(_ data: Data) throws -> Self {
    let value = try JSONDecoder().decode(ConfigurationJSON.self, from: data)
    guard let fields = value.object else { throw LaunchJSONError.invalid("Launch configuration must be an object") }
    let allowed: Set<String> = ["source", "repositoryId", "repositorySetupId", "emptyWorkspace", "profileId", "task", "work", "intent", "selections", "overrides", "requiredSidecarIds", "referenceRepositories", "expectedDigest", "requestId"]
    guard Set(fields.keys).isSubset(of: allowed) else { throw LaunchJSONError.invalid("Unknown launch fields: \(Set(fields.keys).subtracting(allowed).sorted().joined(separator: ", "))") }
    for (key, field) in fields where field == .null { throw LaunchJSONError.invalid("\(key) cannot be null; omit it to use its default") }
    if let source = fields["source"] {
      guard let value = source.object, Set(value.keys) == ["podId", "digest", "configuration"],
        let podId = value["podId"]?.string, !podId.isEmpty,
        let digest = value["digest"]?.string, digest.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
        ["original", "current", "worker"].contains(value["configuration"]?.string ?? "") else {
        throw LaunchJSONError.invalid("Source requires a pod, snapshot digest and original/current configuration choice")
      }
    }
    if let overrides = fields["overrides"]?.object {
      let categories: Set<String> = ["repositorySetup", "environment", "ai", "workflow", "githubAccess", "execution", "pim", "toolPacks"]
      guard Set(overrides.keys).isSubset(of: categories), !overrides.values.contains(.null) else { throw LaunchJSONError.invalid("Unknown or null override category") }
    }
    if let selections = fields["selections"]?.object {
      let keys: Set<String> = ["environmentId", "aiId", "workflowId", "githubAccessId", "toolPackIds"]
      guard Set(selections.keys).isSubset(of: keys) else { throw LaunchJSONError.invalid("Unknown preset selection") }
      for (key, field) in selections where field == .null && key != "githubAccessId" { throw LaunchJSONError.invalid("\(key) cannot be null") }
    }
    return try JSONDecoder().decode(Self.self, from: data)
  }
}
public enum LaunchJSONError: LocalizedError {
  case invalid(String)
  public var errorDescription: String? { switch self { case .invalid(let message): message } }
}
