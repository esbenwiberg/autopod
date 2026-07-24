import Foundation

public struct ProviderCatalogResponse: Codable, Sendable, Equatable {
  public let manifestVersion: Int
  public let piCompatibility: PiCatalogCompatibilityResponse
  public let providers: [ProviderCatalogProvider]
  public let models: [ProviderCatalogModel]

  public func provider(id: String) -> ProviderCatalogProvider? {
    providers.first { $0.id == id }
  }

  public func models(providerId: String) -> [ProviderCatalogModel] {
    models.filter { $0.providerId == providerId }
  }
}

public struct PiCatalogCompatibilityResponse: Codable, Sendable, Equatable {
  public let packageName: String
  public let packageVersion: String
  public let source: String
}

public struct ProviderCatalogProvider: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let displayName: String
  public let description: String
  public let icon: String?
  public let implementation: ProviderImplementationResponse
  public let credentialOptions: [ProviderCredentialOptionResponse]
  public let modelIds: [String]
  public let requiredHosts: [String]
  public let policy: ProviderPolicyResponse

  public var canAcceptGenericAPIKey: Bool {
    implementation.kind == "generic-pi-api"
      && policy.authorization == "supported"
      && policy.runnable
      && credentialOptions.contains { $0.kind == "api-key" }
  }

  public var isSelectableAsProfileProvider: Bool {
    implementation.kind == "legacy" && policy.runnable
  }

  public var systemImage: String {
    guard let icon, Self.knownSystemImages.contains(icon) else {
      return "person.badge.key"
    }
    return icon
  }

  private static let knownSystemImages: Set<String> = [
    "sparkles", "cpu", "building.2", "keyboard", "sparkle.magnifyingglass",
    "person.badge.key",
  ]
}

public struct ProviderImplementationResponse: Codable, Sendable, Equatable {
  public let kind: String
  public let adapterId: String?
  public let piProviderId: String?
}

public struct ProviderCredentialOptionResponse: Codable, Sendable, Equatable {
  public let kind: String
  public let label: String
  public let acquisition: String
}

public struct ProviderPolicyResponse: Codable, Sendable, Equatable {
  public let lifecycle: String
  public let authorization: String
  public let runnable: Bool
  public let caveats: [ProviderCaveatResponse]
}

public struct ProviderCaveatResponse: Codable, Sendable, Equatable {
  public let kind: String
  public let severity: String
  public let message: String
}

public struct ProviderCatalogModel: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let providerId: String
  public let displayName: String
  public let lifecycle: String
}
