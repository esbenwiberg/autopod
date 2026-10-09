import Foundation

/// Editable Azure AI Foundry credentials for a provider account. Mirrors the
/// daemon's provider-account schema so obvious mistakes fail before a request.
public struct FoundryCredentialsDraft: Equatable, Sendable {
  public enum Surface: String, CaseIterable, Identifiable, Sendable {
    case anthropic
    case openai

    public var id: String { rawValue }

    public var label: String {
      switch self {
      case .anthropic: "Claude (Anthropic API)"
      case .openai: "OpenAI / Codex"
      }
    }
  }

  public var endpoint: String
  public var apiKey: String
  public var surface: Surface
  public var apiVersion: String

  public init(
    endpoint: String = "",
    apiKey: String = "",
    surface: Surface = .anthropic,
    apiVersion: String = ""
  ) {
    self.endpoint = endpoint
    self.apiKey = apiKey
    self.surface = surface
    self.apiVersion = apiVersion
  }

  public var isComplete: Bool { (try? payload()) != nil }

  /// The daemon `credentials` object. Throws `DaemonError.badRequest` for input
  /// the daemon would reject — the API key is sent to this endpoint, so plaintext
  /// http is never allowed.
  public func payload() throws -> [String: String] {
    let endpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: endpoint),
          url.scheme?.lowercased() == "https",
          let host = url.host, !host.isEmpty else {
      throw DaemonError.badRequest("Foundry endpoint must be an https:// URL.")
    }
    let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else {
      throw DaemonError.badRequest("Foundry API key is required.")
    }
    var payload = [
      "provider": "foundry",
      "endpoint": endpoint,
      "apiKey": key,
      "apiSurface": surface.rawValue,
    ]
    let version = apiVersion.trimmingCharacters(in: .whitespacesAndNewlines)
    if surface == .openai, !version.isEmpty {
      payload["apiVersion"] = version
    }
    return payload
  }
}
