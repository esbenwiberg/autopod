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
  public var warmImageTag: String?
  public var warmImageBuiltAt: String?
  public var mcpServers: [InjectedMcpServerResponse]
  public var claudeMdSections: [InjectedClaudeMdSectionResponse]
  public var skills: [InjectedSkillResponse]
  public var networkPolicy: NetworkPolicyResponse?
  public var actionPolicy: AnyCodable?  // Complex type, pass through as raw JSON
  public var outputMode: String
  public var modelProvider: String
  public var providerCredentials: AnyCodable?
  public var testCommand: String?
  public var buildTimeout: Int
  public var testTimeout: Int
  public var prProvider: String
  public var adoPat: String?
  public var githubPat: String?
  public var privateRegistries: [PrivateRegistryResponse]
  public var registryPat: String?
  public var containerMemoryGb: Double?
  public var createdAt: String
  public var updatedAt: String
}

// MARK: - Nested types

public struct SmokePageResponse: Codable, Sendable {
  public var path: String
  public var assertions: [PageAssertionResponse]?
}

public struct PageAssertionResponse: Codable, Sendable {
  public let selector: String
  public let type: String
  public let value: String?
}

public struct EscalationConfigResponse: Codable, Sendable {
  public var askHuman: Bool
  public var askAi: AskAiConfigResponse
  public var autoPauseAfter: Int
  public var humanResponseTimeout: Int
}

public struct AskAiConfigResponse: Codable, Sendable {
  public var enabled: Bool
  public var model: String
  public var maxCalls: Int
}

public struct NetworkPolicyResponse: Codable, Sendable {
  public var enabled: Bool
  public var mode: String?
  public var allowedHosts: [String]
  public var replaceDefaults: Bool?
}

public struct PrivateRegistryResponse: Codable, Sendable {
  public var type: String
  public var url: String
  public var scope: String?
}

public struct InjectedMcpServerResponse: Codable, Sendable {
  public let name: String
  // Other fields vary — keep minimal for now
}

public struct InjectedClaudeMdSectionResponse: Codable, Sendable {
  public let name: String?
  public let content: String?
}

public struct InjectedSkillResponse: Codable, Sendable {
  public let name: String?
}

// MARK: - Warm result

public struct WarmResult: Codable, Sendable {
  public let tag: String
  public let digest: String?
  public let sizeMb: Int
  public let buildDuration: Int?
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
}
